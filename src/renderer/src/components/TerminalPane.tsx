import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { useAppStore } from '../store'
import { terminalThemeOf } from '../terminal-themes'
import { terminalBus } from '../terminal-bus'
import { Icon } from './Icon'

type Props = {
  sessionId: string
  cols: number
  rows: number
  isActive: boolean
}


/** Diagnostics ring-buffer for the terminal mount/fit lifecycle (window.__paneLog). */
const paneLog: string[] = []
function plog(msg: string): void {
  paneLog.push(`${new Date().toISOString().slice(11, 23)} ${msg}`)
  if (paneLog.length > 200) paneLog.shift()
}
declare global {
  interface Window {
    __paneLog?: string[]
  }
}

export function TerminalPane({ sessionId, cols, rows, isActive }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const fontSize = useAppStore((s) => s.settings.fontSize)
  const fontFamily = useAppStore((s) => s.settings.fontFamily)
  const cursorStyle = useAppStore((s) => s.settings.cursorStyle)
  const cursorBlink = useAppStore((s) => s.settings.cursorBlink)
  const terminalTheme = useAppStore((s) => s.settings.terminalTheme)
  const termRef = useRef<Terminal | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const fittedRef = useRef(false)
  const resizeCols = useRef(cols)
  const resizeRows = useRef(rows)
  const [searchOpen, setSearchOpen] = useState(false)
  const [initError, setInitError] = useState<string | null>(null)

  // Mount once per sessionId; deliberately never re-runs for the session's life.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    if (termRef.current) return

    plog(`mount ${sessionId.slice(0, 8)} hostW=${Math.round(host.getBoundingClientRect().width)}`)
    let term: Terminal | null = null
    try {
      const settings = useAppStore.getState().settings
      term = new Terminal({
        allowProposedApi: true,
        cursorBlink: settings.cursorBlink ?? true,
        cursorStyle: settings.cursorStyle === 'bar' || settings.cursorStyle === 'underline' ? settings.cursorStyle : 'block',
        fontSize: settings.fontSize || 13,
        fontFamily: settings.fontFamily || "'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace",
        theme: terminalThemeOf(settings.terminalTheme),
        scrollback: settings.scrollback ?? 10000,
        scrollOnUserInput: true,
        rightClickSelectsWord: false
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(host)
      termRef.current = term
      fitRef.current = fit
      plog('opened')
    } catch (e) {
      plog(`INIT THREW: ${e instanceof Error ? e.message : String(e)}`)
      setInitError(String(e))
      return
    }
    const t = term

    // GPU renderer with DOM fallback. Context loss REPLACES the addon
    // (WebglAddon.dispose leaks contexts — xterm#6068), it never toggles.
    let webgl: WebglAddon | null = null
    const loadWebgl = (): void => {
      try {
        webgl = new WebglAddon()
        webgl.onContextLoss(() => {
          plog('webgl context loss — falling back to DOM renderer')
          try { webgl?.dispose() } catch { /* already gone */ }
          webgl = null
          try { t.refresh(0, t.rows - 1) } catch { /* mid-dispose */ }
        })
        t.loadAddon(webgl)
        plog('webgl loaded')
      } catch (e) {
        plog(`webgl unavailable: ${e instanceof Error ? e.message : String(e)}`)
        webgl = null
      }
    }
    loadWebgl()

    // macOS space switches / display sleep leave the GPU canvas stale
    // (vscode#328542): force a redraw when the window becomes visible again.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible' && webgl) {
        try { t.refresh(0, t.rows - 1) } catch { /* mid-dispose */ }
      }
    }
    document.addEventListener('visibilitychange', onVisible)

    const search = new SearchAddon()
    t.loadAddon(search)
    searchRef.current = search
    t.loadAddon(new WebLinksAddon((_e, uri) => void window.orca.openExternal(uri)))
    // Copy-on-select reads the setting live so toggling applies without remount.
    t.onSelectionChange(() => {
      if (useAppStore.getState().settings.copyOnSelect && t.hasSelection()) {
        void navigator.clipboard.writeText(t.getSelection()).catch(() => { /* clipboard denied */ })
      }
    })

    const unsubscribe = terminalBus.subscribe(sessionId, (data) => t.write(data))
    // reattach replay: daemon-held scrollback written before any live data
    void window.orca
      .attachTerminal(sessionId)
      .then((r) => {
        if (r?.scrollback) t.write(r.scrollback)
      })
      .catch(() => { /* session gone — exit event will clean up */ })
    t.onData((input) => {
      useAppStore.getState().writeTerminal(sessionId, input)
    })

    // Right-click to paste (Orca terminalRightClickToPaste).
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault()
      void navigator.clipboard
        .readText()
        .then((text) => {
          if (text) useAppStore.getState().writeTerminal(sessionId, text)
        })
        .catch(() => { /* clipboard permission denied — ignore */ })
    }
    host.addEventListener('contextmenu', onContextMenu)

    /**
     * Fit with redundancy. The original bug: fit ran only from RO/activation
     * callbacks, so a pane whose RO delivery was missed stayed at the open
     * default (100×30) — canvas smaller than the host, dead black area.
     * Now: fit immediately, next frame, on font load, on RO, on activation,
     * and on window resize — every path idempotent.
     */
    const applyFit = (origin: string): void => {
      if (!host.isConnected) return
      // display:none panes have no geometry; their show path re-fits.
      if (host.getBoundingClientRect().width === 0) return
      try {
        fitRef.current?.fit()
        const c = t.cols
        const r = t.rows
        if (c !== resizeCols.current || r !== resizeRows.current) {
          resizeCols.current = c
          resizeRows.current = r
          useAppStore.getState().resizeTerminal(sessionId, c, r)
          plog(`fit(${origin}) ${c}x${r}`)
        }
        fittedRef.current = true
      } catch (e) {
        plog(`fit(${origin}) THREW: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    applyFit('mount')

    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      applyFit('raf')
      raf2 = requestAnimationFrame(() => applyFit('raf2'))
    })
    // web font load changes metrics — refit once fonts settle
    void document.fonts?.ready.then(() => applyFit('fonts'))

    const ro = new ResizeObserver(() => applyFit('ro'))
    ro.observe(host)
    const onWinResize = (): void => applyFit('winresize')
    window.addEventListener('resize', onWinResize)

    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onWinResize)
      unsubscribe()
      host.removeEventListener('contextmenu', onContextMenu)
      document.removeEventListener('visibilitychange', onVisible)
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
      t.dispose()
      webgl = null
      termRef.current = null
      plog(`unmount ${sessionId.slice(0, 8)}`)
    }
  }, [sessionId])

  // ⌘F opens the search bar scoped to the ACTIVE pane only.
  useEffect(() => {
    if (!isActive) return
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setSearchOpen(true)
      }
      if (e.key === 'Escape') setSearchOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isActive])

  // Re-fit when the pane becomes visible (tab switch, split toggle).
  useEffect(() => {
    if (!isActive) return
    const raf = requestAnimationFrame(() => {
      const host = hostRef.current
      const fit = fitRef.current
      const term = termRef.current
      if (!host || !fit || !term) return
      if (host.getBoundingClientRect().width === 0) return
      try {
        fit.fit()
        if (term.cols !== resizeCols.current || term.rows !== resizeRows.current) {
          resizeCols.current = term.cols
          resizeRows.current = term.rows
          useAppStore.getState().resizeTerminal(sessionId, term.cols, term.rows)
        }
      } catch { /* mid-dispose */ }
    })
    return () => cancelAnimationFrame(raf)
  }, [isActive, sessionId])

  // Live appearance: every visual setting mutates the running terminal in place.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    try {
      if (fontSize && term.options.fontSize !== fontSize) {
        term.options.fontSize = fontSize
        fitRef.current?.fit()
      }
      term.options.fontFamily = fontFamily || "'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace"
      term.options.cursorStyle = cursorStyle === 'bar' || cursorStyle === 'underline' ? cursorStyle : 'block'
      term.options.cursorBlink = cursorBlink ?? true
      const theme = terminalThemeOf(terminalTheme)
      term.options.theme = theme
      // xterm paints the overscroll viewport once at open and never refreshes it
      // on live theme swaps — keep it in sync ourselves.
      const viewport = hostRef.current?.querySelector<HTMLElement>('.xterm-viewport')
      if (viewport) viewport.style.backgroundColor = theme.background
    } catch { /* mid-dispose */ }
  }, [fontSize, fontFamily, cursorStyle, cursorBlink, terminalTheme])

  // Programmatic resize requests from the store that did not originate in a fit round-trip.
  useEffect(() => {
    const term = termRef.current
    if (!term || !isActive) return
    if (cols !== resizeCols.current || rows !== resizeRows.current) {
      try {
        term.resize(cols, rows)
        resizeCols.current = cols
        resizeRows.current = rows
      } catch { /* mid-dispose */ }
    }
  }, [cols, rows, isActive])

  const wrapStyle = { backgroundColor: terminalThemeOf(terminalTheme).background }
  if (initError) {
    return (
      <div className="terminal-host-wrap" style={wrapStyle}>
        <div className="terminal-init-error" role="alert">
          <Icon name="alert" size={14} />
          <div>
            <strong>Terminal failed to initialize</strong>
            <p>{initError}</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={`terminal-host-wrap ${isActive ? '' : 'terminal-hidden'}`} style={wrapStyle}>
      {searchOpen && isActive && (
        <TerminalSearch search={searchRef} onClose={() => setSearchOpen(false)} />
      )}
      <div className="terminal-host" ref={hostRef} />
    </div>
  )
}

/** ⌘F overlay: incremental search over the terminal buffer (official SearchAddon). */
function TerminalSearch({ search, onClose }: { search: React.RefObject<SearchAddon | null>; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const run = (backwards = false): void => {
    const addon = search.current
    if (!addon || !q) return
    try {
      if (backwards) addon.findPrevious(q, { caseSensitive, decorations: { matchOverviewRuler: '#81a2be', activeMatchColorOverviewRuler: '#e7c547' } })
      else addon.findNext(q, { caseSensitive, decorations: { matchOverviewRuler: '#81a2be', activeMatchColorOverviewRuler: '#e7c547' } })
    } catch { /* buffer mid-write */ }
  }

  return (
    <div className="terminal-search" onKeyDown={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        className="input terminal-search-input"
        placeholder="Search terminal…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) run(false)
          else if (e.key === 'Enter' && e.shiftKey) run(true)
          else if (e.key === 'Escape') onClose()
        }}
      />
      <button
        className={`icon-btn ${caseSensitive ? 'search-case-on' : ''}`}
        title="Match case"
        onClick={() => setCaseSensitive(!caseSensitive)}
      >
        Aa
      </button>
      <button className="icon-btn" title="Previous (Shift+Enter)" onClick={() => run(true)}>
        ↑
      </button>
      <button className="icon-btn" title="Next (Enter)" onClick={() => run(false)}>
        ↓
      </button>
      <button className="icon-btn" title="Close (Esc)" onClick={onClose}>
        <Icon name="x" size={11} />
      </button>
    </div>
  )
}

// expose diagnostics once per module load
if (typeof window !== 'undefined') {
  window.__paneLog = paneLog
}
