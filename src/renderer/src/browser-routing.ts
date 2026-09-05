import type { BrowserCommand, BrowserSnapshot } from '@shared/types'
import { normalizeBrowserCommandUrl } from './browser-address'
import type { BrowserFindOptions, BrowserFindResult } from './browser-runtime'

export type WebviewEvent = {
  errorCode?: number
  errorDescription?: string
  validatedURL?: string
  isMainFrame?: boolean
  url?: string
  result?: BrowserFindResult
}

export type WebviewPort = {
  loadURL(url: string): Promise<void>
  reload(): void
  stop(): void
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
  executeJavaScript(js: string, userGesture?: boolean): Promise<unknown>
  getURL(): string
  getWebContentsId(): number
  getTitle?(): string
  isLoading?(): boolean
  findInPage?(text: string, options?: BrowserFindOptions): number
  stopFindInPage?(action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void
  getZoomFactor?(): number
  setZoomFactor?(factor: number): void
  addEventListener(type: string, listener: (event: WebviewEvent) => void): void
  removeEventListener(type: string, listener: (event: WebviewEvent) => void): void
}

export type BrowserHost = {
  readonly key: string
  navigate(url: string): Promise<BrowserSnapshot>
  back(): Promise<BrowserSnapshot>
  forward(): Promise<BrowserSnapshot>
  reload(): Promise<BrowserSnapshot>
  snapshot(): Promise<BrowserSnapshot>
  evaluate(js: string): Promise<unknown>
  dispose(): void
}

export type BrowserNavigationState = {
  canGoBack: boolean
  canGoForward: boolean
}

export type BrowserPageInfo = {
  url: string
  title: string
  navigationGeneration: number
}

export type BrowserHostCallbacks = {
  onLoading(loading: boolean): void
  onUrl(url: string): void
  onError(error: string | null): void
  onReady?(): void
  onNavigationStart?(generation: number): void
  onNavigationState?(state: BrowserNavigationState): void
  onPage?(page: BrowserPageInfo): void
  onFindResult?(result: BrowserFindResult): void
}

const SNAPSHOT_JS = `(() => ({
  url: location.href,
  title: document.title,
  text: (document.body?.innerText ?? '').slice(0, 20000)
}))()`
const ABORTED_ERROR_CODE = -3
const MIN_ZOOM_FACTOR = 0.5
const MAX_ZOOM_FACTOR = 2

/** Strict HTTP(S)-only normalization retained for pane state and browser RPC callers. */
export function normalizeBrowserUrl(input: string): string {
  return normalizeBrowserCommandUrl(input)
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function unmountedError(key: string): Error {
  return new Error(`browser host ${key} unmounted`)
}

function isAbortedFailure(event: WebviewEvent): boolean {
  return event.errorCode === ABORTED_ERROR_CODE || event.errorDescription?.includes('ERR_ABORTED') === true
}

export function isBrowserNavigationAbort(value: unknown): boolean {
  const error = asError(value)
  return error.message.includes('ERR_ABORTED') || ('code' in error && error.code === ABORTED_ERROR_CODE)
}

/**
 * One live Electron guest. Operations are serialized so overlapping RPCs cannot
 * steal one another's navigation event or return a snapshot from the wrong URL.
 */
export class WebviewBrowserHost implements BrowserHost {
  private readonly abort = new AbortController()
  private tail: Promise<void> = Promise.resolve()
  private pendingNavigation: { url: string; promise: Promise<BrowserSnapshot> } | null = null
  private failedUrl: string | null = null
  private activeNavigationUrl: string | null = null
  private navigationGeneration = 0
  private navigationInProgress = false
  private publishedPageGeneration = -1
  private ready = false

  private readonly onStartNavigation = (event: WebviewEvent): void => {
    if (event.isMainFrame === false) return
    this.beginNavigation(event.url)
  }

  private readonly onStart = (): void => {
    if (!this.navigationInProgress) this.beginNavigation()
    else this.callbacks.onLoading(true)
  }

  private readonly onStop = (): void => {
    this.navigationInProgress = false
    this.activeNavigationUrl = this.safeUrl()
    this.callbacks.onLoading(false)
    this.publishUrl()
    this.publishNavigationState()
    this.publishPage()
  }

  private readonly onReady = (): void => {
    this.publishReady()
  }

  private readonly onFinish = (): void => {
    this.navigationInProgress = false
    this.activeNavigationUrl = this.safeUrl()
    this.publishReady()
    this.callbacks.onLoading(false)
    this.failedUrl = null
    this.publishUrl()
    this.publishNavigationState()
    this.publishPage()
  }

  private readonly onNavigate = (): void => {
    this.callbacks.onError(null)
    this.activeNavigationUrl = this.safeUrl()
    this.publishUrl()
    this.publishNavigationState()
  }

  private readonly onNavigateInPage = (): void => {
    this.navigationInProgress = false
    this.callbacks.onError(null)
    this.callbacks.onLoading(false)
    this.activeNavigationUrl = this.safeUrl()
    this.publishUrl()
    this.publishNavigationState()
    this.publishPage()
  }

  private readonly onFail = (event: WebviewEvent): void => {
    if (event.isMainFrame === false || isAbortedFailure(event)) return
    if (event.validatedURL && this.activeNavigationUrl && event.validatedURL !== this.activeNavigationUrl) return
    this.navigationInProgress = false
    this.activeNavigationUrl = event.validatedURL ?? this.activeNavigationUrl
    this.failedUrl = event.validatedURL ?? this.safeUrl()
    this.callbacks.onLoading(false)
    this.publishNavigationState()
    const description = event.errorDescription ?? 'navigation failed'
    const code = event.errorCode === undefined ? '' : ` (${event.errorCode})`
    const url = event.validatedURL ? ` loading '${event.validatedURL}'` : ''
    this.callbacks.onError(`${description}${code}${url}`)
  }

  private readonly onFound = (event: WebviewEvent): void => {
    if (event.result) this.callbacks.onFindResult?.(event.result)
  }

  constructor(
    readonly key: string,
    private readonly webview: WebviewPort,
    private readonly callbacks: BrowserHostCallbacks
  ) {
    webview.addEventListener('did-start-navigation', this.onStartNavigation)
    webview.addEventListener('did-start-loading', this.onStart)
    webview.addEventListener('did-stop-loading', this.onStop)
    webview.addEventListener('dom-ready', this.onReady)
    webview.addEventListener('did-finish-load', this.onFinish)
    webview.addEventListener('did-navigate', this.onNavigate)
    webview.addEventListener('did-navigate-in-page', this.onNavigateInPage)
    webview.addEventListener('did-fail-load', this.onFail)
    webview.addEventListener('found-in-page', this.onFound)
  }

  /** Adopt the first navigation started by the webview's immutable src attribute. */
  adoptInitialNavigation(input: string): Promise<BrowserSnapshot> {
    let url: string
    try {
      url = normalizeBrowserUrl(input)
    } catch (error) {
      return Promise.reject(asError(error))
    }
    if (this.pendingNavigation?.url === url) return this.pendingNavigation.promise

    const alreadyLoaded = this.safeUrl() === url && this.webview.isLoading?.() === false
    this.activeNavigationUrl = url
    const promise = this.enqueue(async () => {
      if (!alreadyLoaded) await this.waitForInitialNavigation()
      this.failedUrl = null
      this.publishReady()
      this.publishUrl()
      this.publishNavigationState()
      this.publishPage()
      return this.snapshotNow()
    })
    return this.trackNavigation(url, promise)
  }

  navigate(input: string): Promise<BrowserSnapshot> {
    let url: string
    try {
      url = normalizeBrowserUrl(input)
    } catch (error) {
      return Promise.reject(asError(error))
    }
    if (this.pendingNavigation?.url === url) return this.pendingNavigation.promise

    this.activeNavigationUrl = url
    const promise = this.enqueue(async () => {
      this.callbacks.onError(null)
      if (this.safeUrl() !== url || this.failedUrl === url) await this.webview.loadURL(url)
      this.failedUrl = null
      this.publishUrl()
      this.publishNavigationState()
      this.publishPage()
      return this.snapshotNow()
    })
    return this.trackNavigation(url, promise)
  }

  back(): Promise<BrowserSnapshot> {
    return this.enqueue(async () => {
      if (this.webview.canGoBack()) await this.waitForTraversal(() => this.webview.goBack())
      this.publishNavigationState()
      return this.snapshotNow()
    })
  }

  forward(): Promise<BrowserSnapshot> {
    return this.enqueue(async () => {
      if (this.webview.canGoForward()) await this.waitForTraversal(() => this.webview.goForward())
      this.publishNavigationState()
      return this.snapshotNow()
    })
  }

  reload(): Promise<BrowserSnapshot> {
    return this.enqueue(async () => {
      await this.waitForTraversal(() => this.webview.reload())
      this.publishNavigationState()
      return this.snapshotNow()
    })
  }

  retry(): Promise<BrowserSnapshot> {
    const failedUrl = this.failedUrl
    if (!failedUrl) return this.reload()
    return this.navigate(failedUrl)
  }

  stopLoading(): void {
    try {
      this.webview.stop()
    } finally {
      this.navigationInProgress = false
      this.callbacks.onLoading(false)
    }
  }

  findInPage(text: string, options?: BrowserFindOptions): number {
    if (!this.webview.findInPage) throw new Error('find in page is unavailable')
    return this.webview.findInPage(text, options)
  }

  stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void {
    this.webview.stopFindInPage?.(action)
  }

  getWebContentsId(): number | null {
    try {
      const id = this.webview.getWebContentsId()
      return Number.isSafeInteger(id) && id > 0 ? id : null
    } catch {
      return null
    }
  }

  getZoomFactor(): number {
    return this.webview.getZoomFactor?.() ?? 1
  }

  setZoomFactor(factor: number): number {
    const next = Math.min(MAX_ZOOM_FACTOR, Math.max(MIN_ZOOM_FACTOR, Math.round(factor * 10) / 10))
    this.webview.setZoomFactor?.(next)
    return next
  }

  snapshot(): Promise<BrowserSnapshot> {
    return this.enqueue(() => this.snapshotNow())
  }

  evaluate(js: string): Promise<unknown> {
    return this.enqueue(() => this.webview.executeJavaScript(js))
  }

  dispose(): void {
    if (this.abort.signal.aborted) return
    this.webview.removeEventListener('did-start-navigation', this.onStartNavigation)
    this.webview.removeEventListener('did-start-loading', this.onStart)
    this.webview.removeEventListener('did-stop-loading', this.onStop)
    this.webview.removeEventListener('dom-ready', this.onReady)
    this.webview.removeEventListener('did-finish-load', this.onFinish)
    this.webview.removeEventListener('did-navigate', this.onNavigate)
    this.webview.removeEventListener('did-navigate-in-page', this.onNavigateInPage)
    this.webview.removeEventListener('did-fail-load', this.onFail)
    this.webview.removeEventListener('found-in-page', this.onFound)
    this.abort.abort()
    try {
      this.webview.stopFindInPage?.('clearSelection')
      this.webview.stop()
    } catch {
      // The custom element may already be detached; aborting above is sufficient.
    }
  }

  private beginNavigation(url?: string): void {
    this.navigationInProgress = true
    this.ready = false
    if (url) this.activeNavigationUrl = url
    this.navigationGeneration += 1
    this.publishedPageGeneration = -1
    this.callbacks.onError(null)
    this.callbacks.onLoading(true)
    this.callbacks.onNavigationStart?.(this.navigationGeneration)
  }

  private trackNavigation(url: string, promise: Promise<BrowserSnapshot>): Promise<BrowserSnapshot> {
    const pending = { url, promise }
    this.pendingNavigation = pending
    void promise.then(
      () => {
        if (this.pendingNavigation === pending) this.pendingNavigation = null
      },
      (error: unknown) => {
        if (this.pendingNavigation === pending) this.pendingNavigation = null
        if (!this.abort.signal.aborted && !isBrowserNavigationAbort(error)) {
          this.failedUrl = url
          this.callbacks.onError(asError(error).message)
        }
      }
    )
    return promise
  }

  private safeUrl(): string {
    try {
      return this.webview.getURL()
    } catch {
      return ''
    }
  }

  private safeTitle(): string {
    try {
      return this.webview.getTitle?.() ?? ''
    } catch {
      return ''
    }
  }

  private publishReady(): void {
    if (this.ready) return
    this.ready = true
    this.callbacks.onReady?.()
  }

  private publishUrl(): void {
    const url = this.safeUrl()
    if (url && url !== 'about:blank') this.callbacks.onUrl(url)
  }

  private publishPage(): void {
    if (this.failedUrl || this.publishedPageGeneration === this.navigationGeneration) return
    const url = this.safeUrl()
    if (!/^https?:\/\//i.test(url)) return
    this.publishedPageGeneration = this.navigationGeneration
    this.callbacks.onPage?.({
      url,
      title: this.safeTitle(),
      navigationGeneration: this.navigationGeneration
    })
  }

  private publishNavigationState(): void {
    let canGoBack = false
    let canGoForward = false
    try {
      canGoBack = this.webview.canGoBack()
      canGoForward = this.webview.canGoForward()
    } catch {
      // Detached guests have no usable traversal state.
    }
    this.callbacks.onNavigationState?.({ canGoBack, canGoForward })
  }

  private async snapshotNow(): Promise<BrowserSnapshot> {
    const raw = await this.webview.executeJavaScript(SNAPSHOT_JS)
    if (!raw || typeof raw !== 'object') throw new Error(`browser host ${this.key} returned an invalid snapshot`)
    const snapshot = raw as Partial<Omit<BrowserSnapshot, 'key'>>
    return {
      key: this.key,
      url: typeof snapshot.url === 'string' ? snapshot.url : this.safeUrl(),
      title: typeof snapshot.title === 'string' ? snapshot.title : '',
      text: typeof snapshot.text === 'string' ? snapshot.text : ''
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(() => this.abortable(operation))
    this.tail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private abortable<T>(operation: () => Promise<T>): Promise<T> {
    const signal = this.abort.signal
    if (signal.aborted) return Promise.reject(unmountedError(this.key))
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(unmountedError(this.key))
      signal.addEventListener('abort', onAbort, { once: true })
      void Promise.resolve()
        .then(operation)
        .then(resolve, (error: unknown) => reject(asError(error)))
        .finally(() => signal.removeEventListener('abort', onAbort))
    })
  }

  private waitForInitialNavigation(): Promise<void> {
    const signal = this.abort.signal
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const cleanup = (): void => {
        this.webview.removeEventListener('did-finish-load', onFinish)
        this.webview.removeEventListener('did-fail-load', onFail)
        signal.removeEventListener('abort', onAbort)
      }
      const onFinish = (): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve()
      }
      const onFail = (event: WebviewEvent): void => {
        if (settled || event.isMainFrame === false) return
        settled = true
        cleanup()
        if (isAbortedFailure(event)) {
          reject(new Error('ERR_ABORTED'))
          return
        }
        const description = event.errorDescription ?? 'navigation failed'
        const code = event.errorCode === undefined ? '' : ' (' + String(event.errorCode) + ')'
        reject(new Error(description + code))
      }
      const onAbort = (): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(unmountedError(this.key))
      }
      this.webview.addEventListener('did-finish-load', onFinish)
      this.webview.addEventListener('did-fail-load', onFail)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private waitForTraversal(start: () => void): Promise<void> {
    const signal = this.abort.signal
    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        this.webview.removeEventListener('did-finish-load', onFinish)
        this.webview.removeEventListener('did-navigate-in-page', onFinish)
        this.webview.removeEventListener('did-fail-load', onFail)
        signal.removeEventListener('abort', onAbort)
      }
      const onFinish = (): void => {
        cleanup()
        this.failedUrl = null
        this.publishUrl()
        this.publishNavigationState()
        this.publishPage()
        resolve()
      }
      const onFail = (event: WebviewEvent): void => {
        if (event.isMainFrame === false) return
        cleanup()
        if (isAbortedFailure(event)) {
          reject(new Error('ERR_ABORTED'))
          return
        }
        const description = event.errorDescription ?? 'navigation failed'
        reject(new Error(`${description}${event.errorCode === undefined ? '' : ` (${event.errorCode})`}`))
      }
      const onAbort = (): void => {
        cleanup()
        reject(unmountedError(this.key))
      }
      this.webview.addEventListener('did-finish-load', onFinish)
      this.webview.addEventListener('did-navigate-in-page', onFinish)
      this.webview.addEventListener('did-fail-load', onFail)
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        start()
      } catch (error) {
        cleanup()
        reject(asError(error))
      }
    })
  }
}

type HostWaiter = {
  resolve(host: BrowserHost): void
  reject(error: Error): void
  timer: Parameters<typeof clearTimeout>[0]
}

type TargetedBrowserCommand = Exclude<BrowserCommand, { op: 'list' }>

export type BrowserRouterOptions = {
  activeKey(): string | null
  hasPane(key: string): boolean
  openPane(key: string, url: string): void
  hostWaitMs?: number
}

/** Sole command router: one correlated request reaches one exact worktree host. */
export class BrowserCommandRouter {
  private readonly hosts = new Map<string, BrowserHost>()
  private readonly waiters = new Map<string, Set<HostWaiter>>()
  private readonly hostWaitMs: number
  private readonly routeTails = new Map<string, Promise<void>>()
  private routeGeneration = 0
  private cancellationReason = 'browser router unmounted'

  constructor(private readonly options: BrowserRouterOptions) {
    this.hostWaitMs = options.hostWaitMs ?? 10_000
  }

  register(host: BrowserHost): () => void {
    const current = this.hosts.get(host.key)
    if (current && current !== host) throw new Error(`duplicate browser host for ${host.key}`)
    this.hosts.set(host.key, host)
    const waiters = this.waiters.get(host.key)
    if (waiters) {
      this.waiters.delete(host.key)
      for (const waiter of waiters) {
        clearTimeout(waiter.timer)
        waiter.resolve(host)
      }
    }
    return () => {
      if (this.hosts.get(host.key) === host) this.hosts.delete(host.key)
    }
  }

  list(): string[] {
    return [...this.hosts.keys()].sort()
  }

  async route(command: BrowserCommand): Promise<unknown> {
    if (command.op === 'list') return this.list()
    const key = this.resolveKey(command.key)
    return this.enqueueRoute(key, () => this.routeToHost(command, key))
  }

  private async routeToHost(command: TargetedBrowserCommand, key: string): Promise<unknown> {
    if (command.op === 'open') {
      const url = normalizeBrowserUrl(command.url)
      this.options.openPane(key, url)
      return (await this.waitForHost(key)).navigate(url)
    }

    const host = await this.hostForCommand(key)
    switch (command.op) {
      case 'navigate':
        return host.navigate(command.url)
      case 'back':
        return host.back()
      case 'forward':
        return host.forward()
      case 'reload':
        return host.reload()
      case 'snapshot':
        return host.snapshot()
      case 'eval':
        return host.evaluate(command.js)
    }
  }

  private enqueueRoute<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const generation = this.routeGeneration
    const previous = this.routeTails.get(key) ?? Promise.resolve()
    const run = previous.then(async () => {
      if (generation !== this.routeGeneration) throw new Error(this.cancellationReason)
      const result = await operation()
      if (generation !== this.routeGeneration) throw new Error(this.cancellationReason)
      return result
    })
    const tail = run.then(
      () => undefined,
      () => undefined
    )
    this.routeTails.set(key, tail)
    void tail.then(() => {
      if (this.routeTails.get(key) === tail) this.routeTails.delete(key)
    })
    return run
  }

  cancelPending(reason = 'browser router unmounted'): void {
    this.routeGeneration += 1
    this.cancellationReason = reason
    this.routeTails.clear()
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error(reason))
      }
    }
    this.waiters.clear()
  }

  private resolveKey(key: string): string {
    if (key !== 'active') return key
    const active = this.options.activeKey()
    if (!active) throw new Error('no active worktree')
    return active
  }

  private hostForCommand(key: string): Promise<BrowserHost> {
    const host = this.hosts.get(key)
    if (host) return Promise.resolve(host)
    if (!this.options.hasPane(key)) return Promise.reject(new Error(`no browser host for ${key}`))
    return this.waitForHost(key)
  }

  private waitForHost(key: string): Promise<BrowserHost> {
    const host = this.hosts.get(key)
    if (host) return Promise.resolve(host)
    return new Promise<BrowserHost>((resolve, reject) => {
      const waiter: HostWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const pending = this.waiters.get(key)
          pending?.delete(waiter)
          if (pending?.size === 0) this.waiters.delete(key)
          reject(new Error(`browser host ${key} did not mount`))
        }, this.hostWaitMs)
      }
      const pending = this.waiters.get(key) ?? new Set<HostWaiter>()
      pending.add(waiter)
      this.waiters.set(key, pending)
    })
  }
}
