import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { useAppStore } from '../store'
import { terminalBus } from '../terminal-bus'
import { Icon } from './Icon'

type Props = {
  sessionId: string
  cols: number
  rows: number
  /** false = pane stays mounted but hidden (xterm keeps no DOM cost when display:none) */
  isActive: boolean
}

/**
 * Owns one xterm instance for one PTY session.
 * Data flows main → terminalBus → xterm directly; React never sees terminal output.
 * The instance mounts once and is NEVER unmounted while the session lives — switching
 * tabs hides the pane (display:none), it does not destroy it. This is the
 * "permanently-mounted workbench" rule that keeps scrollback coherent.
 */
export function TerminalPane({ sessionId, cols, rows, isActive }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const resizeCols = useRef(cols)
  const resizeRows = useRef(rows)
  const [searchOpen, setSearchOpen] = useState(false)

  // Mount once per sessionId; deliberately never re-runs for the session's life.
  useEffect(() => {
    const host = hostRef.current
    if (!host || termRef.current) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace",
      theme: {
        background: '#0f1115',
        foreground: '#e6e9ef',
        cursor: '#4f8cff',
        selectionBackground: '#1c4a8a'
      },
      scrollback: 10000
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    fitRef.current = fit

    // WebGL renderer (upstream-default perf path; atuin/Pane/vscode all run it).
    // Fall back to the DOM renderer on context loss — gpu context death must not
    // blank the pane (xterm#6068: dispose leaks contexts, so we REPLACE, not toggle).
    let webgl: WebglAddon | null = null
    const loadWebgl = (): void => {
      try {
        webgl = new WebglAddon()
        webgl.onContextLoss(() => {
          try { webgl?.dispose() } catch { /* already gone */ }
          webgl = null
          // DOM renderer takes over automatically once the addon unloads.
        })
        term.loadAddon(webgl)
      } catch {
        webgl = null // no webgl (headless CI, driver blocks) — DOM renderer is fine
      }
    }
    loadWebgl()

    // macOS space switches / display sleep leave the GPU canvas stale
    // (vscode#328542): force a redraw when the window becomes visible again.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible' && webgl) {
        try { term.refresh(0, term.rows - 1) } catch { /* mid-dispose */ }
      }
    }
    document.addEventListener('visibilitychange', onVisible)

    const search = new SearchAddon()
    term.loadAddon(search)
    searchRef.current = search

    const unsubscribe = terminalBus.subscribe(sessionId, (data) => term.write(data))
    // reattach replay: daemon-held scrollback written before any live data
    void window.orca.attachTerminal(sessionId).then((r) => {
      if (r?.scrollback) term.write(r.scrollback)
    })
    term.onData((input) => {
      useAppStore.getState().writeTerminal(sessionId, input)
    })

    const ro = new ResizeObserver(() => {
      // Only fit when visible; hidden panes keep stale dims until shown.
      if (!host.isConnected || host.offsetParent === null) return
      try {
        fit.fit()
        const c = term.cols
        const r = term.rows
        if (c !== resizeCols.current || r !== resizeRows.current) {
          resizeCols.current = c
          resizeRows.current = r
          useAppStore.getState().resizeTerminal(sessionId, c, r)
        }
      } catch {
        /* terminal mid-dispose */
      }
    })
    ro.observe(host)

    return () => {
      ro.disconnect()
      unsubscribe()
      document.removeEventListener('visibilitychange', onVisible)
      term.dispose()
      webgl = null
      termRef.current = null
    }
  }, [sessionId])

  // Fit once the pane becomes visible (tab switched, card remounted).
  useEffect(() => {
    if (!isActive) return
    const host = hostRef.current
    const term = termRef.current
    const fit = fitRef.current
    if (!host || !term || !fit) return
    // Defer one frame so display:none -> block has taken effect.
    requestAnimationFrame(() => {
      if (!host.isConnected || host.offsetParent === null) return
      try {
        fit.fit()
        resizeCols.current = term.cols
        resizeRows.current = term.rows
        useAppStore.getState().resizeTerminal(sessionId, term.cols, term.rows)
      } catch {
        /* ignore */
      }
    })
  }, [isActive, sessionId])

  // Programmatic resize requests from the store that did not originate in a fit round-trip.
  useEffect(() => {
    const term = termRef.current
    if (!term || !isActive) return
    if (cols !== resizeCols.current || rows !== resizeRows.current) {
      try {
        term.resize(cols, rows)
        resizeCols.current = cols
        resizeRows.current = rows
      } catch {
        /* ignore */
      }
    }
  }, [cols, rows, isActive])
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

  return (
    <div className={`terminal-host-wrap ${isActive ? '' : 'terminal-hidden'}`}>
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
      if (backwards) addon.findPrevious(q, { caseSensitive })
      else addon.findNext(q, { caseSensitive })
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
