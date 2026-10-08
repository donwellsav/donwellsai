import { contextMenuKey, focusContextMenu } from '../context-menu'
import { resolveTerminalRenderer } from '../terminal-renderer'
import { NativeTerminalPane } from './NativeTerminalPane'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon, type ISearchOptions, type ISearchResultChangeEvent } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { useAppStore } from '../store'
import { resolveTerminalPalette } from '../terminal-themes'
import { terminalBus } from '../terminal-bus'
import { Icon } from './Icon'
import { TERMINAL_FIND_EVENT, type TerminalFindEvent } from '../terminal-ui'
import {
  acknowledgeVisibleAttention,
  useAttentionInboxState
} from '../attention-inbox'

type Props = {
  sessionId: string
  cols: number
  rows: number
  isActive: boolean
}

type TerminalContextMenuState = { x: number; y: number; error?: string }


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

export function TerminalPane(props: Props) {
  const requested = useAppStore((s) => s.settings.terminalRenderer)
  const nativeTerminal = useAppStore((s) => s.nativeTerminal)
  const { renderer } = resolveTerminalRenderer({
    requested,
    nativeAvailable: nativeTerminal.available,
    ...(nativeTerminal.reason === undefined ? {} : { nativeReason: nativeTerminal.reason })
  })
  return renderer === 'ghostty' ? <NativeTerminalPane {...props} /> : <XtermPane {...props} />
}

function XtermPane({ sessionId, cols, rows, isActive }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const replaying = useRef(false)
  const fontSize = useAppStore((s) => s.settings.terminalFontSize)
  const fontFamily = useAppStore((s) => s.settings.terminalFontFamily)
  const fontWeight = useAppStore((s) => s.settings.terminalFontWeight)
  const lineHeight = useAppStore((s) => s.settings.terminalLineHeight)
  const cursorStyle = useAppStore((s) => s.settings.cursorStyle)
  const cursorBlink = useAppStore((s) => s.settings.cursorBlink)
  const terminalTheme = useAppStore((s) => s.settings.terminalTheme)
  const terminalGhosttyTheme = useAppStore((s) => s.settings.terminalGhosttyTheme)
  const ghosttyThemes = useAppStore((s) => s.ghosttyThemes)
  // A chosen Ghostty theme wins over the app palette, and the native surface uses
  // the same resolver, so both renderers agree on what a terminal looks like.
  const palette = useMemo(
    () => resolveTerminalPalette({ terminalTheme, terminalGhosttyTheme }, ghosttyThemes),
    [terminalTheme, terminalGhosttyTheme, ghosttyThemes]
  )
  const runsOpen = useAppStore((s) => s.runsOpen)
  const exited = useAppStore((s) => s.terminals[sessionId]?.session.exited ?? false)
  const attentionInbox = useAttentionInboxState()
  const attentionReveal = attentionInbox.reveals[sessionId]
  const termRef = useRef<Terminal | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const fittedRef = useRef(false)
  const resizeCols = useRef(cols)
  const resizeRows = useRef(rows)
  const [searchOpen, setSearchOpen] = useState(false)
  const [initError, setInitError] = useState<string | null>(null)
  const reconnectRef = useRef<(() => Promise<void>) | null>(null)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [replayWarning, setReplayWarning] = useState(false)
  const [redrawing, setRedrawing] = useState(false)
  const [redrawMessage, setRedrawMessage] = useState('')
  const [contextMenu, setContextMenu] = useState<TerminalContextMenuState | null>(null)

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
        disableStdin: true,
        cursorBlink: settings.cursorBlink ?? true,
        cursorStyle: settings.cursorStyle === 'bar' || settings.cursorStyle === 'underline' ? settings.cursorStyle : 'block',
        fontSize: settings.terminalFontSize || 13,
        fontWeight: settings.terminalFontWeight,
        lineHeight: settings.terminalLineHeight,
        fontFamily: settings.terminalFontFamily || "'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace",
        theme: resolveTerminalPalette(settings, useAppStore.getState().ghosttyThemes),
        scrollback: settings.scrollback ?? 10000,
        scrollOnUserInput: true,
        rightClickSelectsWord: false,
        screenReaderMode: true
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
    t.loadAddon(new WebLinksAddon((_e, uri) => void window.donwells.openExternal(uri)))
    // Copy-on-select reads the setting live so toggling applies without remount.
    t.onSelectionChange(() => {
      if (useAppStore.getState().settings.copyOnSelect && t.hasSelection()) {
        void navigator.clipboard.writeText(t.getSelection()).catch(error => useAppStore.getState().setError(`Could not copy terminal selection: ${String(error)}`))
      }
    })

    let mounted = true
    let generation = 0
    const subscription = terminalBus.subscribe(sessionId, (data) => t.write(data), () => {
      generation++
      t.options.disableStdin = true
      setConnecting(false)
      setConnectionError('Connection to the terminal service was lost. Reattach to check this session.')
    })
    const attach = async (): Promise<void> => {
      const attempt = ++generation
      setConnecting(true)
      t.options.disableStdin = true
      subscription.prepareSnapshot()
      try {
        const result = await window.donwells.attachTerminal(sessionId)
        if (!mounted || generation !== attempt) return
        if (!result) throw new Error('Terminal session is no longer available.')
        replaying.current = true
        t.reset()
        for (const chunk of result.replay ?? [{ data: result.scrollback, cols, rows }]) {
          if (!mounted || generation !== attempt) return
          t.resize(chunk.cols, chunk.rows)
          await new Promise<void>(resolve => t.write(chunk.data, resolve))
        }
        if (!mounted || generation !== attempt) return
        replaying.current = false
        applyFit('replay')
        subscription.acceptSnapshot('', result.sequence)
        setReplayWarning(result.truncated !== false)
        setRedrawMessage('')
        setConnectionError(null)
        t.options.disableStdin = result.session.exited === true
      } catch (error) {
        if (mounted && generation === attempt) setConnectionError(/unknown session|no longer available/.test(String(error))
          ? 'This session is no longer retained by the terminal service. Its previous screen is preserved here.'
          : error instanceof Error ? error.message : String(error))
      } finally {
        replaying.current = false
        if (mounted && generation === attempt) setConnecting(false)
      }
    }
    const disposeExit = window.donwells.on('terminal:exit', ({ sessionId: endedSession }) => {
      if (endedSession !== sessionId) return
      generation++
      t.options.disableStdin = true
      setConnecting(false)
    })
    reconnectRef.current = attach
    void attach()
    t.onData((input) => {
      if (!t.options.disableStdin) useAppStore.getState().writeTerminal(sessionId, input)
    })

    // Right-click opens an explicit action menu. Clipboard access only occurs
    // after the user chooses Copy or Paste; opening the menu never mutates input.
    const onContextMenu = (event: MouseEvent): void => {
      event.preventDefault()
      const rect = host.getBoundingClientRect()
      setContextMenu({ x: event.clientX - rect.left, y: event.clientY - rect.top })
    }
    host.addEventListener('contextmenu', onContextMenu)
    const onMenuKey = (event: KeyboardEvent): void => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
      event.preventDefault(); event.stopPropagation(); setContextMenu({ x: 8, y: 8 })
    }
    host.addEventListener('keydown', onMenuKey, true)

    /**
     * Fit with redundancy. The original bug: fit ran only from RO/activation
     * callbacks, so a pane whose RO delivery was missed stayed at the open
     * default (100×30) — canvas smaller than the host, dead black area.
     * Now: fit immediately, next frame, on font load, on RO, and on activation
     * — every path idempotent.
     */
    const applyFit = (origin: string): void => {
      if (!host.isConnected || replaying.current) return
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

    return () => {
      mounted = false
      generation++
      reconnectRef.current = null
      disposeExit()
      ro.disconnect()
      subscription.dispose()
      host.removeEventListener('contextmenu', onContextMenu)
      host.removeEventListener('keydown', onMenuKey, true)
      document.removeEventListener('visibilitychange', onVisible)
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
      t.dispose()
      webgl = null
      termRef.current = null
      plog('unmount ' + sessionId.slice(0, 8))
    }
  }, [sessionId])

  // The command catalog owns Find shortcuts; Escape dismisses this terminal's overlays.
  useEffect(() => {
    if (!isActive) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        searchRef.current?.clearDecorations()
        setSearchOpen(false)
        setContextMenu(null)
      }
    }
    const onFind = (event: Event): void => {
      if ((event as TerminalFindEvent).detail.sessionId === sessionId) setSearchOpen(true)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener(TERMINAL_FIND_EVENT, onFind)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener(TERMINAL_FIND_EVENT, onFind)
    }
  }, [isActive, sessionId])

  // Re-fit when the pane becomes visible (tab switch, split toggle).
  useEffect(() => {
    if (!isActive) return
    const raf = requestAnimationFrame(() => {
      const host = hostRef.current
      const fit = fitRef.current
      const term = termRef.current
      if (!host || !fit || !term || replaying.current) return
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
  // Durable attention is acknowledged only by the exact visible xterm after it
  // owns focus. Opening the app, Runs, or the inbox never clears an event.
  useEffect(() => {
    const host = hostRef.current
    if (!host || !isActive) return
    let frame = 0
    const attempt = (focusRequested: boolean, allowCapture: boolean): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const terminal = termRef.current
        if (!terminal || runsOpen || attentionInbox.overlayOpen) return
        if (document.visibilityState !== 'visible' || !document.hasFocus()) return
        const bounds = host.getBoundingClientRect()
        if (!host.isConnected || bounds.width <= 0 || bounds.height <= 0) return
        if (focusRequested && attentionReveal) terminal.focus()
        void acknowledgeVisibleAttention({
          sessionId,
          isActive,
          runsOverlayOpen: runsOpen,
          host,
          allowCapture
        })
      })
    }
    const onFocusIn = (): void => attempt(false, true)
    const onWindowFocus = (): void => attempt(attentionReveal !== undefined, false)
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') attempt(attentionReveal !== undefined, false)
    }
    host.addEventListener('focusin', onFocusIn)
    window.addEventListener('focus', onWindowFocus)
    document.addEventListener('visibilitychange', onVisibility)
    attempt(attentionReveal !== undefined, false)
    return () => {
      cancelAnimationFrame(frame)
      host.removeEventListener('focusin', onFocusIn)
      window.removeEventListener('focus', onWindowFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [
    attentionInbox.overlayOpen,
    attentionInbox.snapshot?.revision,
    attentionReveal,
    isActive,
    runsOpen,
    sessionId
  ])

  // Live appearance: every visual setting mutates the running terminal in place.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    try {
      if (fontSize && term.options.fontSize !== fontSize) {
        term.options.fontSize = fontSize
      }
      term.options.fontFamily = fontFamily || "'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace"
      term.options.fontWeight = fontWeight
      term.options.lineHeight = lineHeight
      if (!replaying.current) fitRef.current?.fit()
      term.options.cursorStyle = cursorStyle === 'bar' || cursorStyle === 'underline' ? cursorStyle : 'block'
      term.options.cursorBlink = cursorBlink ?? true
      const theme = palette
      term.options.theme = theme
      // xterm paints the overscroll viewport once at open and never refreshes it
      // on live theme swaps — keep it in sync ourselves.
      const viewport = hostRef.current?.querySelector<HTMLElement>('.xterm-viewport')
      if (viewport) viewport.style.backgroundColor = theme.background
    } catch { /* mid-dispose */ }
  }, [fontSize, fontFamily, fontWeight, lineHeight, cursorStyle, cursorBlink, palette])

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

  const wrapStyle = { backgroundColor: palette['background'] }

  const closeSearch = (): void => {
    searchRef.current?.clearDecorations()
    setSearchOpen(false)
  }

  const requestRedraw = async (): Promise<void> => {
    const terminal = termRef.current
    if (!terminal || exited || redrawing) return
    setRedrawing(true)
    try {
      terminal.reset()
      await window.donwells.terminalResize(sessionId, Math.max(2, terminal.cols - 1), terminal.rows)
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      await window.donwells.terminalResize(sessionId, terminal.cols, terminal.rows)
      setRedrawMessage('Redraw requested. Check the screen before continuing.')
    } catch (error) { setRedrawMessage(String(error)) }
    finally { setRedrawing(false) }
  }

  const runContextAction = async (action: 'copy' | 'paste' | 'select-all' | 'clear' | 'find'): Promise<void> => {
    const terminal = termRef.current
    if (!terminal) return
    try {
      if (action === 'copy') {
        if (!terminal.hasSelection()) throw new Error('Select terminal text before copying.')
        await navigator.clipboard.writeText(terminal.getSelection())
      } else if (action === 'paste') {
        if (terminal.options.disableStdin) throw new Error('Reattach the terminal before pasting.')
        const text = await navigator.clipboard.readText()
        if (text) terminal.paste(text)
      } else if (action === 'select-all') {
        terminal.selectAll()
      } else if (action === 'clear') {
        terminal.clear()
      } else {
        setSearchOpen(true)
      }
      setContextMenu(null)
      terminal.focus()
    } catch (error) {
      setContextMenu((current) => current ? { ...current, error: String(error) } : current)
    }
  }
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
    <div className={'terminal-host-wrap ' + (isActive ? '' : 'terminal-hidden')} style={wrapStyle}>
      {connectionError && <div className="terminal-replay-warning" role="alert">
        <strong>Terminal disconnected</strong>
        <p>{connectionError}</p>
        {!exited && <button className="btn btn-secondary btn-sm" disabled={connecting} onClick={() => void reconnectRef.current?.()}>{connecting ? 'Reattaching…' : 'Reattach terminal'}</button>}
      </div>}
      {!connectionError && replayWarning && <div className="terminal-history-notice" role="status">
        <details><summary title="Retained terminal history is incomplete. Expand for details.">History incomplete</summary><p>{redrawMessage || 'The retained output was shortened or could not be verified. The screen may need a native redraw.'}</p></details>
        {!exited && <button className="btn btn-ghost btn-sm" aria-label="Request redraw" title="Ask the running process to redraw its screen; earlier output remains incomplete" disabled={redrawing} onClick={() => void requestRedraw()}>{redrawing ? 'Requesting…' : 'Redraw'}</button>}
        <button className="icon-btn" aria-label="Dismiss notice" title="Dismiss this history notice" disabled={redrawing} onClick={() => { setReplayWarning(false); termRef.current?.focus() }}><Icon name="x" size={14} /></button>
      </div>}
      {searchOpen && isActive && <TerminalSearch search={searchRef} onClose={closeSearch} />}
      {contextMenu && isActive && (
        <>
          <button className="terminal-context-scrim" aria-label="Close terminal menu" onClick={() => setContextMenu(null)} />
          <div
            ref={focusContextMenu}
            onKeyDown={event => contextMenuKey(event, () => { setContextMenu(null); termRef.current?.focus() })}
            className="terminal-context-menu"
            role="menu"
            aria-label="Terminal actions"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button role="menuitem" onClick={() => void runContextAction('copy')}>Copy <span>⌘C</span></button>
            <button role="menuitem" title="Paste clipboard text into the active terminal" onClick={() => void runContextAction('paste')}>Paste <span>⌘V</span></button>
            <button role="menuitem" onClick={() => void runContextAction('select-all')}>Select all</button>
            <span className="terminal-context-rule" />
            <button role="menuitem" title="Clear the displayed terminal buffer; the running process continues" onClick={() => void runContextAction('clear')}>Clear buffer</button>
            <button role="menuitem" onClick={() => void runContextAction('find')}>Find… <span>⌘F</span></button>
            {contextMenu.error && <p role="alert">{contextMenu.error}</p>}
          </div>
        </>
      )}
      <div className="terminal-host" ref={hostRef} />
    </div>
  )
}

/** Full-buffer search powered by the official SearchAddon. */
function TerminalSearch({ search, onClose }: { search: React.RefObject<SearchAddon | null>; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [regex, setRegex] = useState(false)
  const [results, setResults] = useState<ISearchResultChangeEvent>({ resultIndex: 0, resultCount: 0 })
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const settingsRevision = useAppStore((state) => state.settingsRevision)

  const options = useMemo<ISearchOptions>(() => {
    const css = getComputedStyle(document.documentElement)
    const color = (token: string, fallback: string): string => css.getPropertyValue(token).trim() || fallback
    return {
      caseSensitive,
      wholeWord,
      regex,
      decorations: {
        matchBackground: color('--accent', '#31445c'),
        activeMatchBackground: color('--status-progress', '#7a5f00'),
        matchOverviewRuler: color('--chart-1', '#81a2be'),
        activeMatchColorOverviewRuler: color('--agent-question', '#e7c547')
      }
    }
  }, [caseSensitive, regex, settingsRevision, wholeWord])

  useEffect(() => {
    inputRef.current?.focus()
    const disposable = search.current?.onDidChangeResults(setResults)
    return () => disposable?.dispose()
  }, [search])

  useEffect(() => {
    const addon = search.current
    if (!addon) return
    if (!query) {
      addon.clearDecorations()
      setResults({ resultIndex: 0, resultCount: 0 })
      setError(null)
      return
    }
    if (regex) {
      try {
        new RegExp(query, caseSensitive ? '' : 'i')
      } catch (regexError) {
        addon.clearDecorations()
        setError(regexError instanceof Error ? regexError.message : String(regexError))
        return
      }
    }
    try {
      setError(null)
      addon.findNext(query, { ...options, incremental: true })
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : String(searchError))
    }
  }, [query, caseSensitive, wholeWord, regex, search])

  const run = (backwards: boolean): void => {
    const addon = search.current
    if (!addon || !query || error) return
    try {
      if (backwards) addon.findPrevious(query, options)
      else addon.findNext(query, options)
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : String(searchError))
    }
  }

  const clear = (): void => {
    setQuery('')
    setError(null)
    setResults({ resultIndex: 0, resultCount: 0 })
    search.current?.clearDecorations()
    inputRef.current?.focus()
  }

  const resultLabel = error
    ? 'Invalid expression'
    : query && results.resultCount === 0
      ? 'No results'
      : results.resultCount > 0
        ? (results.resultIndex + 1) + ' of ' + results.resultCount
        : ''

  return (
    <div className="terminal-search" role="search" onKeyDown={(event) => event.stopPropagation()}>
      <div className="terminal-search-query">
        <input
          ref={inputRef}
          className={'input terminal-search-input' + (error ? ' invalid' : '')}
          aria-label="Find in terminal"
          aria-invalid={!!error}
          placeholder="Find in terminal"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') run(event.shiftKey)
            else if (event.key === 'Escape') onClose()
          }}
        />
        <span className="terminal-search-results" aria-live="polite">{resultLabel}</span>
      </div>
      <button className={'icon-btn search-option' + (caseSensitive ? ' active' : '')} aria-pressed={caseSensitive} aria-label="Match case" title="Match uppercase and lowercase letters exactly" onClick={() => setCaseSensitive(!caseSensitive)}>Aa</button>
      <button className={'icon-btn search-option' + (wholeWord ? ' active' : '')} aria-pressed={wholeWord} aria-label="Match whole word" title="Find whole words instead of parts of words" onClick={() => setWholeWord(!wholeWord)}>ab</button>
      <button className={'icon-btn search-option regex' + (regex ? ' active' : '')} aria-pressed={regex} aria-label="Use regular expression" title="Interpret the search as a regular expression pattern" onClick={() => setRegex(!regex)}>.*</button>
      <button className="icon-btn" title="Previous result (Shift+Enter)" disabled={!query || !!error} onClick={() => run(true)}><Icon name="up" /></button>
      <button className="icon-btn" title="Next result (Enter)" disabled={!query || !!error} onClick={() => run(false)}><Icon name="down" /></button>
      <button className="icon-btn terminal-search-clear" title="Clear search" disabled={!query && !error} onClick={clear}>Clear</button>
      <button className="icon-btn" title="Close search (Esc)" onClick={onClose}><Icon name="x" size={11} /></button>
      {error && <p className="terminal-search-error" role="alert">{error}</p>}
    </div>
  )
}

// expose diagnostics once per module load (dev builds only, like window.__store)
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  window.__paneLog = paneLog
}
