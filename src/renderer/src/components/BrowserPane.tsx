import { PopupMenu } from 'flexlayout-react'
import { BrowserTestingPanel } from './BrowserTestingPanel'
import { BrowserViewPort } from '../browser-view-port'
import type { BrowserHistoryEntry } from '@shared/browser-history'
import type { BrowserShortcutAction } from '@shared/types'
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState
} from 'react'
import {
  buildBrowserAddressSuggestions,
  createBrowserAddressState,
  normalizeBrowserCommandUrl,
  reduceBrowserAddress,
  resolveBrowserAddress
} from '../browser-address'
import {
  BrowserCommandRouter,
  WebviewBrowserHost,
  isBrowserNavigationAbort
} from '../browser-routing'
import { BrowserFindController, type BrowserFindState } from '../browser-runtime'
import { useAppStore } from '../store'
import { useDesignCapture } from '../use-design-capture'
import { Icon } from './Icon'
import { AgentDeliveryDialog } from './AgentDeliveryDialog'
import { DesignCapturePanel } from './DesignCapturePanel'

type BrowserPaneProps = {
  worktreePath: string
  url: string
  router: BrowserCommandRouter
  active: boolean
}

const INITIAL_FIND_STATE: BrowserFindState = {
  query: '',
  matchCase: false,
  activeMatch: 0,
  totalMatches: 0
}

/** One persistent Electron guest. BrowserHosts owns its lifetime and routing. */
export function BrowserPane({ worktreePath, url, router, active }: BrowserPaneProps) {
  const browserHomeUrl = useAppStore((state) => state.settings.browserHomeUrl) ?? 'http://localhost:3000'
  const searchEngine = useAppStore((state) => state.settings.browserSearchEngine) ?? 'duckduckgo'
  const webviewRef = useRef<BrowserViewPort | null>(null)
  const viewSlotRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<WebviewBrowserHost | null>(null)
  const findControllerRef = useRef<BrowserFindController | null>(null)
  const addressInputRef = useRef<HTMLInputElement>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const findTimerRef = useRef<number | null>(null)
  const [initialUrl] = useState(() => {
    try {
      return normalizeBrowserCommandUrl(url || browserHomeUrl)
    } catch {
      try {
        return normalizeBrowserCommandUrl(browserHomeUrl)
      } catch {
        return 'http://localhost:3000'
      }
    }
  })
  const publishedUrlRef = useRef(url)
  const historyRequestRef = useRef(0)
  const [address, dispatchAddress] = useReducer(reduceBrowserAddress, initialUrl, createBrowserAddressState)
  const [history, setHistory] = useState<BrowserHistoryEntry[]>([])
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [historyClearConfirm, setHistoryClearConfirm] = useState(false)
  const [historyClearing, setHistoryClearing] = useState(false)
  const [testingOpen, setTestingOpen] = useState(false)
  const [toolsAnchor, setToolsAnchor] = useState<HTMLElement | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  const [selectedSuggestion, setSelectedSuggestion] = useState(-1)
  const [loading, setLoading] = useState(false)
  const [ready, setReady] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [addressError, setAddressError] = useState<string | null>(null)
  const [navigationState, setNavigationState] = useState({ canGoBack: false, canGoForward: false })
  const [zoomFactor, setZoomFactor] = useState(1)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findMatchCase, setFindMatchCase] = useState(false)
  const [findState, setFindState] = useState<BrowserFindState>(INITIAL_FIND_STATE)
  const addressListId = useId()
  const addressErrorId = useId()

  const closeFind = useCallback((): void => {
    if (findTimerRef.current !== null) {
      window.clearTimeout(findTimerRef.current)
      findTimerRef.current = null
    }
    findControllerRef.current?.close()
    setFindOpen(false)
  }, [])

  const prepareDesignSelection = useCallback((): void => {
    closeFind()
    setSuggestionsOpen(false)
  }, [closeFind])

  const {
    mode: designMode,
    capture: designCapture,
    screenshot: designScreenshot,
    screenshotPending: designScreenshotPending,
    note: designNote,
    error: designError,
    attachment: attachmentDraft,
    begin: beginDesignCapture,
    cancel: cancelDesignMode,
    clear: clearDesignCapture,
    dispose: disposeDesignMode,
    navigationStarted: noteDesignNavigation,
    attach: attachDesignCapture,
    setNote: setDesignNote,
    dismissError: dismissDesignError,
    closeAttachment
  } = useDesignCapture({
    webviewRef,
    workspacePath: worktreePath,
    active,
    ready,
    loading,
    loadError,
    onBeforeSelect: prepareDesignSelection
  })
  const refreshHistory = useCallback((): void => {
    const generation = ++historyRequestRef.current
    setHistoryError(null)
    void window.donwells.browserHistoryList().then((entries) => {
      if (historyRequestRef.current !== generation) return
      setHistory(entries)
      setHistoryError(null)
    }).catch((error: unknown) => {
      if (historyRequestRef.current === generation) setHistoryError('Browsing history is unavailable: ' + String(error))
    })
  }, [])

  const recordHistory = useCallback((entry: { url: string; title: string }): void => {
    const generation = ++historyRequestRef.current
    void window.donwells.browserHistoryRecord(entry).then((entries) => {
      if (historyRequestRef.current !== generation) return
      setHistory(entries)
      setHistoryError(null)
    }).catch((error: unknown) => {
      if (historyRequestRef.current === generation) setHistoryError('This page loaded, but local history could not be saved: ' + String(error))
    })
  }, [])

  useEffect(() => {
    refreshHistory()
    return () => {
      historyRequestRef.current += 1
    }
  }, [refreshHistory])

  useLayoutEffect(() => {
    const webview = new BrowserViewPort(worktreePath)
    webviewRef.current = webview
    webview.addEventListener('focus', () => {
      const state = useAppStore.getState()
      const pane = state.panes[worktreePath]?.find(pane => pane.kind === 'browser')
      if (pane && state.activeWorktreePath === worktreePath) state.setActivePane(worktreePath, pane.key)
    })
    const host = new WebviewBrowserHost(worktreePath, webview, {
      onLoading: setLoading,
      onError: setLoadError,
      onReady: () => {
        setReady(true)
        setZoomFactor(host.getZoomFactor())
      },
      onNavigationStart: () => {
        noteDesignNavigation()
        if (findTimerRef.current !== null) {
          window.clearTimeout(findTimerRef.current)
          findTimerRef.current = null
        }
        findControllerRef.current?.navigationStarted()
        setFindOpen(false)
      },
      onNavigationState: setNavigationState,
      onFindResult: (result) => findControllerRef.current?.acceptResult(result),
      onPage: ({ url: nextUrl, title }) => recordHistory({ url: nextUrl, title }),
      onUrl: (nextUrl) => {
        publishedUrlRef.current = nextUrl
        dispatchAddress({ type: 'live-url', url: nextUrl })
        useAppStore.getState().noteBrowserNavigation(worktreePath, nextUrl)
      }
    })
    const findController = new BrowserFindController(
      {
        findInPage: (text, options) => host.findInPage(text, options),
        stopFindInPage: (action) => host.stopFindInPage(action)
      },
      (state) => {
        if (hostRef.current === host) setFindState(state)
      }
    )
    hostRef.current = host
    findControllerRef.current = findController
    const initialNavigation = host.navigate(initialUrl)
    const unregister = router.register(host)
    void initialNavigation.catch((reason: unknown) => {
      if (hostRef.current === host && !isBrowserNavigationAbort(reason)) {
        setLoadError(reason instanceof Error ? reason.message : String(reason))
      }
    })

    return () => {
      disposeDesignMode()
      unregister()
      if (findTimerRef.current !== null) window.clearTimeout(findTimerRef.current)
      findTimerRef.current = null
      findControllerRef.current = null
      hostRef.current = null
      findController.close()
      host.dispose()
      webview.dispose()
      if (webviewRef.current === webview) webviewRef.current = null
    }
  }, [disposeDesignMode, initialUrl, noteDesignNavigation, recordHistory, router, worktreePath])

  useLayoutEffect(() => {
    let frame = 0, last = ''
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure) }
    const measure = () => {
      const slot = viewSlotRef.current, port = webviewRef.current
      if (slot && port) {
        const r = slot.getBoundingClientRect()
        const overlays = [...document.querySelectorAll<HTMLElement>(':popover-open, dialog[open], [role="dialog"], [role="menu"], .browser-suggestions, .design-capture-panel, .flexlayout__outline_rect, .flexlayout__drag_rect')]
        const blocked = Boolean(document.querySelector('[data-native-resize]')) || overlays.some(node => { const b = node.getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.right > r.left && b.left < r.right && b.bottom > r.top && b.top < r.bottom && getComputedStyle(node).visibility !== 'hidden' })
        const visible = !blocked && slot.getClientRects().length > 0 && getComputedStyle(slot).visibility !== 'hidden' && r.width > 0 && r.height > 0
        const rect = visible ? {x:Math.max(0,r.left),y:Math.max(0,r.top),width:Math.max(0,Math.min(r.right,innerWidth)-Math.max(0,r.left)),height:Math.max(0,Math.min(r.bottom,innerHeight)-Math.max(0,r.top))} : null
        const value = JSON.stringify(rect)
        if (value !== last) { last = value; port.bounds(rect) }
      }
    }
    const resize = new ResizeObserver(schedule)
    if (viewSlotRef.current) resize.observe(viewSlotRef.current)
    const mutations = new MutationObserver(measure)
    mutations.observe(document.body, {subtree:true, childList:true, attributes:true, attributeFilter:['style','class','open','aria-hidden','data-native-resize']})
    window.addEventListener('resize',schedule); window.addEventListener('scroll',schedule,true)
    schedule()
    return () => { resize.disconnect(); mutations.disconnect(); window.removeEventListener('resize',schedule); window.removeEventListener('scroll',schedule,true); cancelAnimationFrame(frame); webviewRef.current?.bounds(null) }
  }, [worktreePath])

  // openBrowser retargets an existing pane; the stable guest follows the new target.
  useEffect(() => {
    const host = hostRef.current
    // A published location is an observation, not a new navigation request.
    if (!host || url === publishedUrlRef.current) return
    void host.navigate(url).catch((reason: unknown) => {
      if (hostRef.current === host && !isBrowserNavigationAbort(reason)) {
        setLoadError(reason instanceof Error ? reason.message : String(reason))
      }
    })
  }, [url])

  useEffect(() => {
    if (!findOpen) return
    findInputRef.current?.focus()
    findInputRef.current?.select()
  }, [findOpen])

  useEffect(() => {
    if (!findOpen) return
    const controller = findControllerRef.current
    if (!controller) return
    if (!findQuery) {
      controller.search('', findMatchCase)
      return
    }
    const timer = window.setTimeout(() => {
      if (findTimerRef.current === timer) findTimerRef.current = null
      controller.search(findQuery, findMatchCase)
    }, 160)
    findTimerRef.current = timer
    return () => {
      window.clearTimeout(timer)
      if (findTimerRef.current === timer) findTimerRef.current = null
    }
  }, [findMatchCase, findOpen, findQuery])


  const suggestions = useMemo(
    () => buildBrowserAddressSuggestions(address.draft, history, searchEngine),
    [address.draft, history, searchEngine]
  )

  useEffect(() => {
    setSelectedSuggestion((current) => current >= suggestions.length ? suggestions.length - 1 : current)
  }, [suggestions.length])

  const runHostAction = (action: (host: WebviewBrowserHost) => Promise<unknown>): void => {
    const host = hostRef.current
    if (!host) {
      setLoadError(`browser host ${worktreePath} is not ready`)
      return
    }
    void action(host).catch((reason: unknown) => {
      if (hostRef.current === host && !isBrowserNavigationAbort(reason)) {
        setLoadError(reason instanceof Error ? reason.message : String(reason))
      }
    })
  }

  const navigate = (rawAddress = address.draft): void => {
    let resolved: ReturnType<typeof resolveBrowserAddress>
    try {
      resolved = resolveBrowserAddress(rawAddress, searchEngine)
    } catch (reason) {
      setAddressError(reason instanceof Error ? reason.message : String(reason))
      return
    }
    const host = hostRef.current
    if (!host) {
      setLoadError(`browser host ${worktreePath} is not ready`)
      return
    }
    setAddressError(null)
    setSuggestionsOpen(false)
    setSelectedSuggestion(-1)
    dispatchAddress({ type: 'commit', url: resolved.url })
    void host.navigate(resolved.url).catch((reason: unknown) => {
      if (hostRef.current === host && !isBrowserNavigationAbort(reason)) {
        setLoadError(reason instanceof Error ? reason.message : String(reason))
      }
    })
  }

  const cancelAddressEdit = (): void => {
    setSuggestionsOpen(false)
    setSelectedSuggestion(-1)
    setAddressError(null)
    dispatchAddress({ type: 'cancel' })
    addressInputRef.current?.blur()
  }


  const stepFind = (forward: boolean): void => {
    const controller = findControllerRef.current
    if (!controller || !findQuery) return
    if (findTimerRef.current !== null) {
      window.clearTimeout(findTimerRef.current)
      findTimerRef.current = null
    }
    const current = controller.snapshot()
    if (current.query !== findQuery || current.matchCase !== findMatchCase) {
      controller.search(findQuery, findMatchCase)
      return
    }
    if (forward) controller.next()
    else controller.previous()
  }

  const clearHistory = async (): Promise<void> => {
    if (historyClearing) return
    const generation = ++historyRequestRef.current
    setHistoryClearing(true)
    setHistoryError(null)
    try {
      await window.donwells.browserHistoryClear()
      setHistoryClearConfirm(false)
      if (historyRequestRef.current === generation) setHistory([])
    } catch (error: unknown) {
      if (historyRequestRef.current === generation) setHistoryError('Could not clear browsing history: ' + String(error))
    } finally {
      setHistoryClearing(false)
    }
  }

  const openInSystemBrowser = async (): Promise<void> => {
    if (!address.liveUrl) return
    setActionError(null)
    try {
      await window.donwells.openExternal(address.liveUrl)
    } catch (error: unknown) {
      setActionError('Could not open the system browser: ' + String(error))
    }
  }

  const changeZoom = useCallback((delta: number): void => {
    const host = hostRef.current
    if (!host) return
    setZoomFactor(host.setZoomFactor(host.getZoomFactor() + delta))
  }, [])

  const resetZoom = useCallback((): void => {
    const host = hostRef.current
    if (!host) return
    setZoomFactor(host.setZoomFactor(1))
  }, [])

  const applyBrowserShortcut = useCallback((action: BrowserShortcutAction): void => {
    if (designMode) cancelDesignMode()
    switch (action) {
      case 'focusAddress':
        setAddressError(null)
        setSuggestionsOpen(true)
        setSelectedSuggestion(-1)
        dispatchAddress({ type: 'focus' })
        addressInputRef.current?.focus()
        addressInputRef.current?.select()
        break
      case 'find':
        setFindOpen(true)
        findInputRef.current?.focus()
        findInputRef.current?.select()
        break
      case 'zoomIn':
        changeZoom(0.1)
        break
      case 'zoomOut':
        changeZoom(-0.1)
        break
      case 'zoomReset':
        resetZoom()
        break
    }
  }, [cancelDesignMode, changeZoom, designMode, resetZoom])

  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (designMode && event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        cancelDesignMode()
        return
      }
      if ((!event.metaKey && !event.ctrlKey) || event.altKey) return
      const key = event.key.toLowerCase()
      let action: BrowserShortcutAction | null = null
      if (key === 'f' && !event.shiftKey) action = 'find'
      else if (key === 'l' && !event.shiftKey) action = 'focusAddress'
      else if (key === '+' || key === '=') action = 'zoomIn'
      else if (key === '-' || key === '_') action = 'zoomOut'
      else if (key === '0' && !event.shiftKey) action = 'zoomReset'
      if (!action) return
      event.preventDefault()
      applyBrowserShortcut(action)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, applyBrowserShortcut, cancelDesignMode, designMode])

  useEffect(() => {
    return window.donwells.on('browser:shortcut', ({ action, guestId }) => {
      if (hostRef.current?.getWebContentsId() !== guestId) return
      applyBrowserShortcut(action)
    })
  }, [applyBrowserShortcut])

  const empty = ready && !address.liveUrl && !loading && !loadError
  const activeSuggestionId = selectedSuggestion >= 0 ? `${addressListId}-${selectedSuggestion}` : undefined

  return (
    <div className="browser-pane">
      <div className="browser-bar" role="toolbar" aria-label="Browser controls">
        <div className="browser-nav-controls">
          <button
            className="icon-btn browser-control"
            type="button"
            aria-label="Back"
            title="Back"
            disabled={!navigationState.canGoBack}
            onClick={() => runHostAction((host) => host.back())}
          >
            <Icon name="left" />
          </button>
          <button
            className="icon-btn browser-control"
            type="button"
            aria-label="Forward"
            title="Forward"
            disabled={!navigationState.canGoForward}
            onClick={() => runHostAction((host) => host.forward())}
          >
            <Icon name="right" />
          </button>
          <button
            className="icon-btn browser-control"
            type="button"
            aria-label="Home"
            title="Home"
            onClick={() => navigate(browserHomeUrl)}
          >
            <Icon name="home" />
          </button>
        </div>

        <div className="browser-address-wrap" onBlur={event => {
          if (event.currentTarget.contains(event.relatedTarget)) return
          setSuggestionsOpen(false)
          setSelectedSuggestion(-1)
          dispatchAddress({ type: 'blur' })
        }}>
          <Icon name="globe" size={14} className="browser-address-icon" />
          <input
            ref={addressInputRef}
            className="browser-address-input"
            value={address.draft}
            title={addressError ?? address.liveUrl}
            aria-label="Address and search"
            aria-autocomplete="list"
            aria-controls={addressListId}
            aria-expanded={address.focused && suggestionsOpen}
            aria-activedescendant={activeSuggestionId}
            aria-describedby={addressError ? addressErrorId : undefined}
            aria-invalid={addressError ? true : undefined}
            role="combobox"
            spellCheck={false}
            onFocus={(event) => {
              dispatchAddress({ type: 'focus' })
              setSuggestionsOpen(true)
              setSelectedSuggestion(-1)
              setAddressError(null)
              refreshHistory()
              event.currentTarget.select()
            }}
            onChange={(event) => {
              setAddressError(null)
              setSuggestionsOpen(true)
              setSelectedSuggestion(-1)
              dispatchAddress({ type: 'change', value: event.target.value })
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                cancelAddressEdit()
                return
              }
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                setSuggestionsOpen(true)
                setSelectedSuggestion((current) => {
                  if (suggestions.length === 0) return -1
                  if (event.key === 'ArrowDown') return current < suggestions.length - 1 ? current + 1 : 0
                  return current > 0 ? current - 1 : suggestions.length - 1
                })
                return
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                const selected = selectedSuggestion >= 0 ? suggestions[selectedSuggestion] : undefined
                navigate(selected?.url ?? address.draft)
              }
            }}
          />
          {loading ? <span className="browser-loading" role="status" aria-label="Loading page" /> : null}

          {address.focused && suggestionsOpen ? (
            <div className="browser-suggestions">
              <div id={addressListId} role="listbox" aria-label="Address suggestions">
                {suggestions.map((suggestion, index) => (
                  <button
                    key={suggestion.id}
                    id={`${addressListId}-${index}`}
                    className={`browser-suggestion${selectedSuggestion === index ? ' selected' : ''}`}
                    type="button"
                    role="option"
                    aria-selected={selectedSuggestion === index}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => navigate(suggestion.url)}
                  >
                    <Icon name={suggestion.kind === 'search' ? 'search' : 'globe'} size={14} />
                    <span className="browser-suggestion-copy">
                      <span className="browser-suggestion-title">{suggestion.label}</span>
                      <span className="browser-suggestion-detail">{suggestion.detail}</span>
                    </span>
                    {suggestion.kind === 'history' ? <span className="browser-suggestion-kind">History</span> : null}
                  </button>
                ))}
              </div>
              {suggestions.length === 0 && !addressError && !historyError ? (
                <div className="browser-suggestion-empty">No local history matches</div>
              ) : null}
              {addressError ? <div className="browser-address-error" id={addressErrorId} role="alert">{addressError}</div> : null}
              {historyError ? (
                <div className="browser-address-error browser-history-error" role="alert">
                  <span>{historyError}</span>
                  <button type="button" className="browser-history-clear" onMouseDown={(event) => event.preventDefault()} onClick={refreshHistory}>Retry history</button>
                </div>
              ) : null}
              {history.length > 0 && !historyClearConfirm ? (
                <button
                  className="browser-history-clear"
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setHistoryClearConfirm(true)}
                >
                  Clear browsing history…
                </button>
              ) : null}
              {historyClearConfirm ? (
                <div className="browser-history-confirm" role="group" aria-label="Confirm browsing history deletion">
                  <span>Delete all local browsing history?</span>
                  <button type="button" className="browser-history-clear" disabled={historyClearing} onMouseDown={(event) => event.preventDefault()} onClick={() => setHistoryClearConfirm(false)}>Cancel</button>
                  <button type="button" className="browser-history-clear danger" disabled={historyClearing} onMouseDown={(event) => event.preventDefault()} onClick={() => void clearHistory()}>{historyClearing ? 'Clearing…' : 'Clear permanently'}</button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <button
          className="icon-btn browser-control"
          type="button"
          aria-label={loading ? 'Stop loading' : 'Reload'}
          title={loading ? 'Stop loading' : 'Reload'}
          onClick={() => loading ? hostRef.current?.stopLoading() : runHostAction((host) => host.reload())}
        >
          <Icon name={loading ? 'stop' : 'refresh'} size={14} />
        </button>
        {designMode && <button className="icon-btn browser-control active" type="button" aria-label="Cancel Design Mode" title="Cancel Design Mode (Escape)" onClick={cancelDesignMode}><Icon name="x" /></button>}
        <button className="icon-btn browser-control" type="button" aria-label="Browser tools" title="Find, inspect, test, zoom, or open in your default browser" aria-haspopup="menu" aria-expanded={Boolean(toolsAnchor)} onClick={event => setToolsAnchor(event.currentTarget)}><Icon name="more" /></button>
        {toolsAnchor && <PopupMenu anchor={toolsAnchor} title="Browser tools" onClose={() => setToolsAnchor(null)} items={[
          { key: 'find', label: findOpen ? 'Close find in page' : 'Find in page…', onSelect: () => findOpen ? closeFind() : setFindOpen(true) },
          { key: 'design', label: designMode ? 'Cancel Design Mode' : 'Inspect page design', disabled: !ready || loading || Boolean(loadError), onSelect: () => requestAnimationFrame(() => designMode ? cancelDesignMode() : beginDesignCapture()) },
          { key: 'test', label: 'Browser testing…', onSelect: () => setTestingOpen(true) },
          { type: 'divider', key: 'zoom-divider' },
          { key: 'zoom-out', label: 'Zoom out', onSelect: () => changeZoom(-0.1) },
          { key: 'zoom-reset', label: `Reset zoom (${Math.round(zoomFactor * 100)}%)`, onSelect: resetZoom },
          { key: 'zoom-in', label: 'Zoom in', onSelect: () => changeZoom(0.1) },
          { type: 'divider', key: 'external-divider' },
          { key: 'external', label: 'Open in default browser', disabled: !address.liveUrl, onSelect: () => void openInSystemBrowser() }
        ]} />}
      </div>

      <div className="browser-page">
        {loading ? <div className="browser-progress" aria-hidden="true"><span /></div> : null}
        <div
          ref={viewSlotRef}
          tabIndex={0}
          onFocus={() => webviewRef.current?.focus()}
          aria-label="Browser preview"
          className="browser-view"
          aria-hidden={loadError || empty ? true : undefined}
        />
        {designMode ? (
          <div className="browser-design-status" role="status" aria-live="polite">
            <Icon name="edit" size={14} />
            <span>Move over the page and select a component</span>
            <kbd>Esc</kbd>
          </div>
        ) : null}

        {designError ? (
          <div className="browser-design-error" role="alert">
            <Icon name="alert" size={13} />
            <span>{designError}</span>
            <button className="icon-btn" type="button" aria-label="Dismiss Design Mode error" title="Dismiss this design-mode error message" onClick={dismissDesignError}>
              <Icon name="x" size={14} />
            </button>
          </div>
        ) : null}
        {actionError ? (
          <div className="browser-design-error" role="alert">
            <Icon name="alert" size={13} />
            <span>{actionError}</span>
            <button className="icon-btn" type="button" aria-label="Dismiss browser action error" title="Dismiss this browser error message" onClick={() => setActionError(null)}>
              <Icon name="x" size={14} />
            </button>
          </div>
        ) : null}

        {designCapture ? (
          <DesignCapturePanel
            capture={designCapture}
            screenshot={designScreenshot}
            screenshotPending={designScreenshotPending}
            note={designNote}
            onNoteChange={setDesignNote}
            onClear={clearDesignCapture}
            onReselect={beginDesignCapture}
            onAttach={attachDesignCapture}
          />
        ) : null}

        {findOpen ? (
          <div className="browser-find" role="search" aria-label="Find in page" onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Escape') {
              event.preventDefault()
              closeFind()
            } else if (event.key === 'Enter') {
              event.preventDefault()
              stepFind(!event.shiftKey)
            }
          }}>
            <Icon name="search" size={14} />
            <input
              ref={findInputRef}
              value={findQuery}
              aria-label="Find text"
              placeholder="Find in page"
              onChange={(event) => setFindQuery(event.target.value)}
            />
            <span className="browser-find-count" aria-live="polite">
              {findQuery ? (findState.totalMatches > 0 ? `${findState.activeMatch} of ${findState.totalMatches}` : 'No matches') : ''}
            </span>
            <button
              type="button"
              className={findMatchCase ? 'active' : ''}
              aria-label="Match case"
              title="Match case"
              aria-pressed={findMatchCase}
              onClick={() => setFindMatchCase((matchCase) => !matchCase)}
            >
              Aa
            </button>
            <button type="button" aria-label="Previous match" title="Previous match" disabled={!findQuery} onClick={() => stepFind(false)}>
              <Icon name="up" size={14} />
            </button>
            <button type="button" aria-label="Next match" title="Next match" disabled={!findQuery} onClick={() => stepFind(true)}>
              <Icon name="down" size={14} />
            </button>
            <button type="button" aria-label="Close find" title="Close find" onClick={closeFind}>
              <Icon name="x" size={14} />
            </button>
          </div>
        ) : null}

        {!ready && !loading && !loadError ? (
          <div className="browser-empty" role="status">
            <Icon name="globe" size={18} />
            <strong>Preparing browser</strong>
            <span>The persistent page host is getting ready.</span>
          </div>
        ) : null}
        {empty ? (
          <div className="browser-empty">
            <Icon name="globe" size={18} />
            <strong>No page loaded</strong>
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => navigate(browserHomeUrl)}>Open home page</button>
          </div>
        ) : null}
        {loadError ? (
          <div className="browser-error" role="alert">
            <Icon name="alert" size={18} />
            <strong>Could not load this page</strong>
            <span>{loadError}</span>
            <div className="browser-error-actions">
              <button className="btn btn-secondary btn-sm" type="button" onClick={() => runHostAction((host) => host.retry())}>Retry</button>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => navigate(browserHomeUrl)}>Open home page</button>
            </div>
          </div>
        ) : null}
      </div>
      {testingOpen && <BrowserTestingPanel workspacePath={worktreePath} onClose={()=>setTestingOpen(false)} />}
      {attachmentDraft ? (
        <AgentDeliveryDialog attachment={attachmentDraft} onClose={closeAttachment} />
      ) : null}
    </div>
  )
}
