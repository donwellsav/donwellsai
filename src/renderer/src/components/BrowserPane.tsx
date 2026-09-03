import { useRef, useState } from 'react'
import { Icon } from './Icon'

/** The webview tag's JS surface (Electron types don't expose these methods). */
type WebviewApi = {
  loadURL(u: string): void
  reload(): void
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
}

/** Embedded browser pane: persistent <webview> with a URL bar; stays mounted across tab switches. */
export function BrowserPane({ url, onClose }: { url: string; onClose: () => void }) {
  const webviewRef = useRef<HTMLWebViewElement>(null)
  const [address, setAddress] = useState(url)
  const [live, setLive] = useState(url)

  const wv = (): WebviewApi | null => webviewRef.current as unknown as WebviewApi | null

  const navigate = (target: string): void => {
    const normalized = /^https?:\/\//.test(target) ? target : `https://${target}`
    setAddress(normalized)
    setLive(normalized)
    wv()?.loadURL(normalized)
  }

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
        <button className="icon-btn" title="Reload" onClick={() => wv()?.reload()}>
          <Icon name="refresh" size={11} />
        </button>
        <button className="icon-btn danger" title="Close browser tab" onClick={onClose}>
          <Icon name="x" size={11} />
        </button>
      </div>
      <webview ref={webviewRef} src={live} className="browser-view" />
    </div>
  )
}
