import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useAppStore } from '../store'
import { terminalBus } from '../terminal-bus'

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
  const fitRef = useRef<FitAddon | null>(null)
  const resizeCols = useRef(cols)
  const resizeRows = useRef(rows)

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

    const unsubscribe = terminalBus.subscribe(sessionId, (data) => term.write(data))
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
      term.dispose()
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

  return <div className={`terminal-host ${isActive ? '' : 'terminal-hidden'}`} ref={hostRef} />
}