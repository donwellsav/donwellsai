import { describe, expect, it } from 'vitest'
import type { BrowserSnapshot } from '../src/shared/types'
import {
  BrowserCommandRouter,
  WebviewBrowserHost,
  type BrowserHost,
  type WebviewEvent,
  type WebviewPort
} from '../src/renderer/src/browser-routing'

type PendingLoad = {
  url: string
  finalUrl: string
  deferred: PromiseWithResolvers<void>
}

class FakeWebview implements WebviewPort {
  readonly loads: PendingLoad[] = []
  readonly listeners = new Map<string, Set<(event: WebviewEvent) => void>>()
  currentUrl = ''
  loading = true
  stopCount = 0
  executeCount = 0
  canBack = false
  canForward = false
  contentsId = 17
  loadURL(url: string): Promise<void> {
    const load: PendingLoad = { url, finalUrl: url, deferred: Promise.withResolvers<void>() }
    this.loads.push(load)
    this.loading = true
    this.emit('did-start-loading')
    return load.deferred.promise.then(() => {
      this.currentUrl = load.finalUrl
      this.loading = false
      this.emit('did-navigate')
      this.emit('did-stop-loading')
    })
  }

  finishLoad(index: number, finalUrl?: string): void {
    const load = this.loads[index]
    if (!load) throw new Error(`no load ${index}`)
    load.finalUrl = finalUrl ?? load.url
    load.deferred.resolve()
  }

  failLoad(index: number, message: string): void {
    const load = this.loads[index]
    if (!load) throw new Error(`no load ${index}`)
    this.loading = false
    this.emit('did-fail-load', {
      errorCode: -105,
      errorDescription: message,
      validatedURL: load.url,
      isMainFrame: true
    })
    load.deferred.reject(new Error(message))
  }

  reload(): void {}
  stop(): void {
    this.stopCount += 1
  }
  goBack(): void {}
  goForward(): void {}
  canGoBack(): boolean {
    return this.canBack
  }
  canGoForward(): boolean {
    return this.canForward
  }
  executeJavaScript(): Promise<unknown> {
    this.executeCount += 1
    return Promise.resolve({ url: this.currentUrl, title: `Title ${this.currentUrl}`, text: `Body ${this.currentUrl}` })
  }
  getURL(): string {
    return this.currentUrl
  }
  getWebContentsId(): number {
    return this.contentsId
  }
  isLoading(): boolean {
    return this.loading
  }
  addEventListener(type: string, listener: (event: WebviewEvent) => void): void {
    const listeners = this.listeners.get(type) ?? new Set<(event: WebviewEvent) => void>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }
  removeEventListener(type: string, listener: (event: WebviewEvent) => void): void {
    this.listeners.get(type)?.delete(listener)
  }
  emit(type: string, event: WebviewEvent = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

class RecordingHost implements BrowserHost {
  readonly calls: string[] = []

  constructor(readonly key: string) {}

  navigate(url: string): Promise<BrowserSnapshot> {
    this.calls.push(`navigate:${url}`)
    return Promise.resolve(this.result(url))
  }
  back(): Promise<BrowserSnapshot> {
    this.calls.push('back')
    return Promise.resolve(this.result())
  }
  forward(): Promise<BrowserSnapshot> {
    this.calls.push('forward')
    return Promise.resolve(this.result())
  }
  reload(): Promise<BrowserSnapshot> {
    this.calls.push('reload')
    return Promise.resolve(this.result())
  }
  snapshot(): Promise<BrowserSnapshot> {
    this.calls.push('snapshot')
    return Promise.resolve(this.result())
  }
  evaluate(js: string): Promise<unknown> {
    this.calls.push(`eval:${js}`)
    return Promise.resolve({ key: this.key })
  }
  dispose(): void {}

  private result(url = `https://${this.key}.test`): BrowserSnapshot {
    return { key: this.key, url, title: this.key, text: this.key }
  }
}

async function advanceOperations(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function callbacks() {
  const urls: string[] = []
  const errors: Array<string | null> = []
  const loading: boolean[] = []
  const ready: boolean[] = []
  return {
    urls,
    errors,
    loading,
    ready,
    handlers: {
      onUrl: (url: string) => urls.push(url),
      onError: (error: string | null) => errors.push(error),
      onLoading: (value: boolean) => loading.push(value),
      onReady: () => ready.push(true)
    }
  }
}

describe('WebviewBrowserHost', () => {
  it('adopts the immutable initial src and holds commands until its load finishes', async () => {
    const webview = new FakeWebview()
    const events = callbacks()
    const host = new WebviewBrowserHost('/worktrees/one', webview, events.handlers)
    const initial = host.adoptInitialNavigation('https://one.test/initial')
    const snapshot = host.snapshot()
    await advanceOperations()

    expect(webview.loads).toEqual([])
    expect(webview.executeCount).toBe(0)

    webview.currentUrl = 'https://one.test/initial'
    webview.emit('dom-ready')
    webview.emit('did-finish-load')
    await expect(initial).resolves.toMatchObject({ url: 'https://one.test/initial' })
    await expect(snapshot).resolves.toMatchObject({ url: 'https://one.test/initial' })
    expect(events.ready).toEqual([true])
  })

  it('adopts a document that finished before a remounted host attached its listeners', async () => {
    const webview = new FakeWebview()
    const events = callbacks()
    webview.currentUrl = 'https://one.test/ready'
    webview.loading = false
    const host = new WebviewBrowserHost('/worktrees/one', webview, events.handlers)
    expect(host.getWebContentsId()).toBe(webview.contentsId)

    await expect(host.adoptInitialNavigation('https://one.test/ready')).resolves.toMatchObject({
      url: 'https://one.test/ready'
    })
    expect(webview.loads).toEqual([])
    expect(webview.executeCount).toBe(1)
    expect(events.ready).toEqual([true])
  })

  it('settles a cancelled initial navigation without publishing an error state', async () => {
    const webview = new FakeWebview()
    const events = callbacks()
    const host = new WebviewBrowserHost('/worktrees/one', webview, events.handlers)
    const initial = host.adoptInitialNavigation('https://one.test/slow')
    await advanceOperations()

    webview.emit('did-fail-load', {
      isMainFrame: true,
      errorCode: -3,
      errorDescription: 'ERR_ABORTED',
      validatedURL: 'https://one.test/slow'
    })

    await expect(initial).rejects.toThrow('ERR_ABORTED')
    expect(events.errors).not.toContain('ERR_ABORTED')
  })

  it('finishes in-page navigation and publishes the resulting document', () => {
    const webview = new FakeWebview()
    const events = callbacks()
    const pages: string[] = []
    new WebviewBrowserHost('/worktrees/one', webview, {
      ...events.handlers,
      onPage: (page) => pages.push(page.url)
    })
    webview.currentUrl = 'https://one.test/page#details'

    webview.emit('did-start-navigation', {
      isMainFrame: true,
      url: webview.currentUrl
    })
    webview.emit('did-navigate-in-page', { isMainFrame: true, url: webview.currentUrl })

    expect(events.loading.at(-1)).toBe(false)
    expect(pages).toEqual(['https://one.test/page#details'])
  })

  it('ignores a late failure from a superseded navigation generation', async () => {
    const webview = new FakeWebview()
    const events = callbacks()
    const host = new WebviewBrowserHost('/worktrees/one', webview, events.handlers)
    const navigation = host.navigate('https://one.test/current')
    await advanceOperations()

    webview.emit('did-fail-load', {
      isMainFrame: true,
      errorCode: -105,
      errorDescription: 'stale navigation failed',
      validatedURL: 'https://one.test/previous'
    })
    webview.finishLoad(0)

    await expect(navigation).resolves.toMatchObject({ url: 'https://one.test/current' })
    expect(events.errors.filter((error) => error !== null)).toEqual([])
  })

  it('queues snapshots behind navigation completion and returns that navigation document', async () => {
    const webview = new FakeWebview()
    const events = callbacks()
    const host = new WebviewBrowserHost('/worktrees/one', webview, events.handlers)

    const navigation = host.navigate('one.test')
    const snapshot = host.snapshot()
    await advanceOperations()

    expect(webview.loads.map((load) => load.url)).toEqual(['https://one.test'])
    expect(webview.executeCount).toBe(0)

    webview.finishLoad(0, 'https://one.test/ready')
    await expect(navigation).resolves.toMatchObject({ key: '/worktrees/one', url: 'https://one.test/ready' })
    await expect(snapshot).resolves.toMatchObject({ url: 'https://one.test/ready' })
    expect(events.urls).toContain('https://one.test/ready')
  })

  it('loads a replacement URL in an already-mounted host instead of keeping the initial page', async () => {
    const webview = new FakeWebview()
    const host = new WebviewBrowserHost('/worktrees/one', webview, callbacks().handlers)

    const first = host.navigate('https://one.test/first')
    await advanceOperations()
    webview.finishLoad(0)
    await first

    const second = host.navigate('https://one.test/second')
    await advanceOperations()
    expect(webview.loads.map((load) => load.url)).toEqual([
      'https://one.test/first',
      'https://one.test/second'
    ])
    webview.finishLoad(1)
    await expect(second).resolves.toMatchObject({ url: 'https://one.test/second' })
  })

  it('propagates a main-frame load failure without poisoning the next navigation', async () => {
    const webview = new FakeWebview()
    const events = callbacks()
    const host = new WebviewBrowserHost('/worktrees/one', webview, events.handlers)

    await expect(host.navigate('   ')).rejects.toThrow('browser URL is required')
    expect(webview.loads).toEqual([])

    const failed = host.navigate('missing.test')
    await advanceOperations()
    webview.failLoad(0, 'ERR_NAME_NOT_RESOLVED')
    await expect(failed).rejects.toThrow('ERR_NAME_NOT_RESOLVED')

    const recovered = host.navigate('working.test')
    await advanceOperations()
    webview.finishLoad(1)
    await expect(recovered).resolves.toMatchObject({ url: 'https://working.test' })
    expect(events.errors).toContain('ERR_NAME_NOT_RESOLVED')
  })

  it('does not treat a failed document URL as a successful repeated navigation', async () => {
    const webview = new FakeWebview()
    webview.loadURL = async (url) => {
      webview.currentUrl = url
      webview.emit('did-fail-load', { isMainFrame: true, validatedURL: url, errorDescription: 'ERR_CONNECTION_REFUSED' })
      throw new Error('ERR_CONNECTION_REFUSED')
    }
    const host = new WebviewBrowserHost('/worktrees/one', webview, callbacks().handlers)

    await expect(host.navigate('https://offline.test')).rejects.toThrow('ERR_CONNECTION_REFUSED')
    await expect(host.navigate('https://offline.test')).rejects.toThrow('ERR_CONNECTION_REFUSED')
    host.dispose()
  })

  it('rejects in-flight and queued work when its mounted guest disappears', async () => {
    const webview = new FakeWebview()
    const events = callbacks()
    const host = new WebviewBrowserHost('/worktrees/one', webview, events.handlers)
    const navigation = host.navigate('slow.test')
    const snapshot = host.snapshot()
    await advanceOperations()

    host.dispose()

    await expect(navigation).rejects.toThrow('browser host /worktrees/one unmounted')
    await expect(snapshot).rejects.toThrow('browser host /worktrees/one unmounted')
    expect(webview.stopCount).toBe(1)
    expect(events.errors).not.toContain('browser host /worktrees/one unmounted')
  })

  it('ignores aborted and subframe failures while the main navigation completes', async () => {
    const webview = new FakeWebview()
    const events = callbacks()
    const host = new WebviewBrowserHost('/worktrees/one', webview, events.handlers)
    const navigation = host.navigate('https://working.test')
    await advanceOperations()

    webview.emit('did-fail-load', {
      isMainFrame: false,
      errorCode: -105,
      errorDescription: 'subframe failed',
      validatedURL: 'https://frame.test'
    })
    webview.emit('did-fail-load', {
      isMainFrame: true,
      errorCode: -3,
      errorDescription: 'ERR_ABORTED',
      validatedURL: 'https://working.test'
    })
    webview.finishLoad(0)

    await expect(navigation).resolves.toMatchObject({ url: 'https://working.test' })
    expect(events.errors).not.toContain('subframe failed')
    expect(events.errors).not.toContain('ERR_ABORTED')
  })
})

describe('BrowserCommandRouter', () => {
  it('routes a nonactive command only to its exact worktree host', async () => {
    const one = new RecordingHost('/worktrees/one')
    const two = new RecordingHost('/worktrees/two')
    const router = new BrowserCommandRouter({
      activeKey: () => '/worktrees/one',
      hasPane: () => true,
      openPane: () => {}
    })
    router.register(one)
    router.register(two)

    await expect(router.route({ op: 'navigate', key: '/worktrees/two', url: 'two.test/next' }))
      .resolves.toMatchObject({ key: '/worktrees/two' })
    expect(one.calls).toEqual([])
    expect(two.calls).toEqual(['navigate:two.test/next'])
  })

  it('waits for a cold host to mount and for its exact open target to finish', async () => {
    const opened: Array<{ key: string; url: string }> = []
    const router = new BrowserCommandRouter({
      activeKey: () => '/worktrees/one',
      hasPane: () => false,
      openPane: (key, url) => opened.push({ key, url })
    })
    await expect(router.route({ op: 'open', key: '/worktrees/two', url: '   ' })).rejects.toThrow(
      'browser URL is required'
    )
    expect(opened).toEqual([])
    const result = router.route({ op: 'open', key: '/worktrees/two', url: 'HTTP://two.test/target' })
    let settled = false
    void result.then(() => {
      settled = true
    })
    await advanceOperations()

    expect(opened).toEqual([{ key: '/worktrees/two', url: 'http://two.test/target' }])
    expect(settled).toBe(false)

    const two = new RecordingHost('/worktrees/two')
    router.register(two)
    await expect(result).resolves.toMatchObject({ key: '/worktrees/two', url: 'http://two.test/target' })
    expect(two.calls).toEqual(['navigate:http://two.test/target'])
  })

  it('serializes concurrent open requests for the same cold worktree in call order', async () => {
    const opened: Array<{ key: string; url: string }> = []
    const router = new BrowserCommandRouter({
      activeKey: () => null,
      hasPane: () => false,
      openPane: (key, url) => opened.push({ key, url })
    })
    const first = router.route({ op: 'open', key: '/worktrees/one', url: 'first.test' })
    const second = router.route({ op: 'open', key: '/worktrees/one', url: 'second.test' })
    await advanceOperations()

    expect(opened).toEqual([{ key: '/worktrees/one', url: 'https://first.test' }])

    const host = new RecordingHost('/worktrees/one')
    router.register(host)
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { url: 'https://first.test' },
      { url: 'https://second.test' }
    ])
    expect(opened).toEqual([
      { key: '/worktrees/one', url: 'https://first.test' },
      { key: '/worktrees/one', url: 'https://second.test' }
    ])
    expect(host.calls).toEqual([
      'navigate:https://first.test',
      'navigate:https://second.test'
    ])
  })

  it('lists registered live hosts and rejects nonexistent targets without a ghost reply', async () => {
    const router = new BrowserCommandRouter({
      activeKey: () => null,
      hasPane: () => false,
      openPane: () => {}
    })
    const one = new RecordingHost('/worktrees/one')
    const unregister = router.register(one)

    await expect(router.route({ op: 'list' })).resolves.toEqual(['/worktrees/one'])
    await expect(router.route({ op: 'snapshot', key: '/worktrees/missing' })).rejects.toThrow(
      'no browser host for /worktrees/missing'
    )

    unregister()
    await expect(router.route({ op: 'list' })).resolves.toEqual([])
  })

  it('cancels queued work without late pane mutations and remains reusable', async () => {
    const opened: string[] = []
    const router = new BrowserCommandRouter({
      activeKey: () => null,
      hasPane: () => false,
      openPane: (_key, url) => opened.push(url)
    })
    const first = router.route({ op: 'open', key: '/worktrees/one', url: 'one.test' })
    const queued = router.route({ op: 'open', key: '/worktrees/one', url: 'two.test' })
    router.cancelPending()

    await Promise.all([
      expect(first).rejects.toThrow('browser router unmounted'),
      expect(queued).rejects.toThrow('browser router unmounted')
    ])
    expect(opened).toEqual([])

    const host = new RecordingHost('/worktrees/one')
    router.register(host)
    await expect(router.route({ op: 'snapshot', key: '/worktrees/one' })).resolves.toMatchObject({
      key: '/worktrees/one'
    })
  })
})
