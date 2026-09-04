import { useEffect, useRef, useState } from 'react'
import type { BrowserCommand } from '@shared/types'
import { useAppStore } from '../store'
import { Icon } from './Icon'

/** The webview tag's JS surface (Electron types don't expose these methods). */
type WebviewApi = {
  loadURL(u: string): void
  reload(): void
  stop(): void
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
  executeJavaScript(js: string, userGesture?: boolean): Promise<unknown>
  getURL(): string
  addEventListener(type: string, cb: () => void): void
  removeEventListener(type: string, cb: () => void): void
}

/** A page snapshot agents read instead of raw HTML. */
type Snapshot = { key: string; url: string; title: string; text: string }

const SNAPSHOT_JS = `(() => ({
  url: location.href,
  title: document.title,
  text: (document.body?.innerText ?? '').slice(0, 20000)
}))()`

/**
 * Embedded browser pane: persistent <webview> with a URL bar; stays mounted
 * across tab switches. Registers itself with main so runtime-RPC clients
 * (agents in terminals, the CLI) can drive and inspect it.
 */
export function BrowserPane({ worktreePath, url, onClose }: { worktreePath: string; url: string; onClose: () => void }) {
  const webviewRef = useRef<HTMLWebViewElement>(null)
  const [address, setAddress] = useState(url)
  const [live, setLive] = useState(url)
  const [loading, setLoading] = useState(false)

  const wv = (): WebviewApi | null => webviewRef.current as unknown as WebviewApi | null

  const navigate = (target: string): void => {
    const normalized = /^https?:\/\//.test(target) ? target : `https://${target}`
    setAddress(normalized)
    setLive(normalized)
    wv()?.loadURL(normalized)
  }

  // Live URL + loading state: the address bar follows real navigation.
  useEffect(() => {
    const w = webviewRef.current
    if (!w) return
    const onDidNavigate = (): void => {
      setAddress((w as unknown as WebviewApi).getURL())
      setLoading(false)
    }
    const onStart = (): void => setLoading(true)
    w.addEventListener('did-navigate', onDidNavigate)
    w.addEventListener('did-navigate-in-page', onDidNavigate)
    w.addEventListener('did-start-loading', onStart)
    w.addEventListener('did-stop-loading', onDidNavigate)
    return () => {
      w.removeEventListener('did-navigate', onDidNavigate)
      w.removeEventListener('did-navigate-in-page', onDidNavigate)
      w.removeEventListener('did-start-loading', onStart)
      w.removeEventListener('did-stop-loading', onDidNavigate)
    }
  }, [])

  // Agent control: execute browser commands forwarded from the runtime RPC.
  useEffect(() => {
    let registered: string[] | null = null
    const run = async (cmd: BrowserCommand): Promise<unknown> => {
      const w = wv()
      if (!w) throw new Error('webview not ready')
      switch (cmd.op) {
        case 'navigate':
          navigate(cmd.url)
          return { navigated: cmd.url }
        case 'back':
          if (w.canGoBack()) w.goBack()
          return {}
        case 'forward':
          if (w.canGoForward()) w.goForward()
          return {}
        case 'reload':
          w.reload()
          return {}
        case 'snapshot': {
          const snap = (await w.executeJavaScript(SNAPSHOT_JS)) as Omit<Snapshot, 'key'>
          return { key: worktreePath, ...snap } satisfies Snapshot
        }
        case 'eval':
          return w.executeJavaScript(cmd.js)
        default:
          throw new Error(`unsupported op: ${(cmd as { op: string }).op}`)
      }
    }
    const unsubscribe = window.orca.onBrowserCommand(async ({ id, cmd }) => {
      try {
        // open/list answered at the app shell (a cold start has no pane mounted)
        if (cmd.op === 'list' || cmd.op === 'open') return
        if (cmd.key !== worktreePath && cmd.key !== 'active') throw new Error(`no browser pane for ${cmd.key}`)
        const result = await run(cmd)
        window.orca.resolveBrowserCommand(id, { ok: true, result })
      } catch (e) {
        window.orca.resolveBrowserCommand(id, { ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    })
    // register this pane once the webview is alive
    const t = window.setTimeout(() => {
      const st = useAppStore.getState()
      registered = Object.keys(st.previews).length >= 0 ? collectBrowserKeys() : []
      window.orca.browserRegisterPanes(registered)
    }, 300)
    return () => {
      window.clearTimeout(t)
      unsubscribe()
    }
  }, [worktreePath])

  return (
    <div className="browser-pane">
      <div className="browser-bar">
        <button className="icon-btn" title="Back" onClick={() => { const w = wv(); if (w?.canGoBack()) w.goBack() }}>
          ‹
        </button>
        <button className="icon-btn" title="Forward" onClick={() => { const w = wv(); if (w?.canGoForward()) w.goForward() }}>
          ›
        </button>
        <input
          className="input browser-url"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') navigate(address)
          }}
        />
        {loading && <span className="browser-loading" title="Loading…" />}
        <button className="icon-btn" title="Reload" onClick={() => wv()?.reload()}>
          <Icon name="refresh" size={11} />
        </button>
        <button
          className="icon-btn"
          title="Open in system browser"
          onClick={() => void window.orca.openExternal(live)}
        >
          <Icon name="globe" size={11} />
        </button>
        <button className="icon-btn danger" title="Close browser tab" onClick={onClose}>
          <Icon name="x" size={11} />
        </button>
      </div>
      <webview ref={webviewRef} src={live} className="browser-view" />
    </div>
  )
}

/** Collect the worktree paths that currently have a browser pane open. */
export function collectBrowserKeys(): string[] {
  const st = useAppStore.getState()
  return Object.entries(st.panes)
    .filter(([, panes]) => panes.some((p) => p.kind === 'browser'))
    .map(([wt]) => wt)
}
