import { WebContentsView, type BrowserWindow } from 'electron'
import { registerBrowserShortcuts } from './browser-shortcuts'
import { BROWSER_PARTITION, allowedNavigation } from './browser-permissions'
import type { BrowserViewRequest, BrowserViewState } from '@shared/browser-view'
import { SNAPSHOT_JS } from '../renderer/src/browser-routing'
import { DESIGN_CAPTURE_BEGIN_SCRIPT, DESIGN_CAPTURE_CANCEL_SCRIPT } from '../renderer/src/design-capture'
import type { WebviewEvent } from '../renderer/src/browser-routing'

/** Owns guest lifetime; the renderer supplies bounded UI intents, never executable page code. */
export class BrowserViews {
  private views = new Map<string, { view: WebContentsView; instance: string; find: Map<number, number> }>()
  private closed = false
  private epoch = 0
  private creates = new Map<string, number>()
  constructor(private window: BrowserWindow, private verify: (key: string) => Promise<string>) {
    window.on('closed', () => this.close())
    window.webContents.on('render-process-gone', () => this.clear())
    window.webContents.on('did-start-navigation', (_event, _url, inPlace, main) => { if (main && !inPlace) this.clear() })
  }
  private clear() {
    this.epoch++; this.creates.clear()
    for (const item of this.views.values()) {
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(item.view)
      if (!item.view.webContents.isDestroyed()) item.view.webContents.close({ waitForBeforeUnload: false })
    }
    this.views.clear()
  }
  close() { this.closed = true; this.clear() }
  private state(view: WebContentsView): BrowserViewState {
    const wc = view.webContents
    return { id: wc.id, url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading(), back: wc.navigationHistory.canGoBack(), forward: wc.navigationHistory.canGoForward(), zoom: wc.getZoomFactor() }
  }
  async evaluate(key: string, js: string) {
    await this.verify(key)
    const item = this.views.get(key)
    if (!item || item.view.webContents.isDestroyed()) throw new Error('Browser view is unavailable')
    return item.view.webContents.executeJavaScript(js)
  }
  async request(request: BrowserViewRequest): Promise<unknown> {
    if (!request || typeof request !== 'object' || typeof request.key !== 'string' || !request.key || request.key.length > 4096 || typeof request.instance !== 'string' || request.instance.length > 100) throw new Error('Invalid browser view request')
    if (this.closed || this.window.isDestroyed()) throw new Error('Browser owner closed')
    const { key, instance } = request
    const epoch = this.epoch
    const generation = request.op === 'create' ? (this.creates.get(key) ?? 0) + 1 : this.creates.get(key)
    if (request.op === 'create') this.creates.set(key, generation!)
    await this.verify(key)
    if (epoch !== this.epoch || generation !== this.creates.get(key)) throw new Error('Browser ownership changed')
    if (this.closed || this.window.isDestroyed()) throw new Error('Browser owner closed')
    let item = this.views.get(key)
    if (request.op === 'create') {
      if (item && item.instance === instance) return this.state(item.view)
      if (item) { this.window.contentView.removeChildView(item.view); item.view.webContents.close({ waitForBeforeUnload: false }) }
      const view = new WebContentsView({ webPreferences: { partition: BROWSER_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false } })
      item = { view, instance, find: new Map() }; this.views.set(key, item)
      const current = item, wc = view.webContents
      view.setVisible(false); view.setBackgroundColor('#ffffff'); this.window.contentView.addChildView(view)
      const emit = (type: string, event: WebviewEvent = {}) => {
        if (this.views.get(key) !== current || this.window.isDestroyed() || wc.isDestroyed()) return
        this.window.webContents.send('browser:view', { key, instance, type, event, state: this.state(view) })
      }
      wc.setWindowOpenHandler(() => ({ action: 'deny' }))
      wc.on('will-navigate', (event, url) => { if (!allowedNavigation(url)) event.preventDefault() })
      wc.on('will-redirect', (event, url) => { if (!allowedNavigation(url)) event.preventDefault() })
      wc.on('did-start-loading', () => emit('did-start-loading'))
      wc.on('did-stop-loading', () => emit('did-stop-loading'))
      wc.on('dom-ready', () => emit('dom-ready'))
      wc.on('did-finish-load', () => emit('did-finish-load'))
      wc.on('did-navigate', () => emit('did-navigate'))
      wc.on('did-navigate-in-page', () => emit('did-navigate-in-page'))
      wc.on('did-start-navigation', (_event, url, _inPlace, isMainFrame) => emit('did-start-navigation', { url, isMainFrame }))
      wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => emit('did-fail-load', { errorCode, errorDescription, validatedURL, isMainFrame }))
      wc.on('render-process-gone', (_event, details) => emit('did-fail-load', { errorDescription: 'Browser process exited: ' + details.reason, isMainFrame: true }))
      wc.on('found-in-page', (_event, result) => { const id = current.find.get(result.requestId); if (id !== undefined) emit('found-in-page', { result: { ...result, requestId: id } }) })
      wc.on('focus', () => emit('focus'))
      registerBrowserShortcuts(wc, this.window.webContents)
      return this.state(view)
    }
    if (!item || item.instance !== instance || item.view.webContents.isDestroyed()) throw new Error('Stale browser view')
    const { view } = item, wc = view.webContents
    switch (request.op) {
      case 'dispose': this.views.delete(key); this.window.contentView.removeChildView(view); wc.close({ waitForBeforeUnload: false }); return
      case 'navigate': if (!allowedNavigation(request.url)) throw new Error('Browser requires HTTP(S)'); return wc.loadURL(request.url)
      case 'reload': wc.reload(); return
      case 'stop': wc.stop(); return
      case 'back': if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); return
      case 'forward': if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); return
      case 'focus': if (view.getVisible()) wc.focus(); return
      case 'bounds': {
        const r = request.rect
        if (r === null) { view.setVisible(false); return }
        if (!r || ![r.x,r.y,r.width,r.height].every(Number.isFinite) || r.width < 0 || r.height < 0) throw new Error('Invalid browser bounds')
        const [width,height] = this.window.getContentSize(), zoom = this.window.webContents.getZoomFactor()
        const x = Math.max(0,Math.round(r.x * zoom)), y = Math.max(0,Math.round(r.y * zoom))
        const w = Math.max(0, Math.min(Math.round(r.width * zoom),width-x)), h = Math.max(0,Math.min(Math.round(r.height * zoom),height-y))
        view.setBounds({ x,y,width:w,height:h }); view.setVisible(w > 0 && h > 0); return
      }
      case 'zoom': if (!Number.isFinite(request.factor)) throw new Error('Invalid zoom'); wc.setZoomFactor(Math.max(.5,Math.min(2,request.factor))); return
      case 'find': {
        if (typeof request.text !== 'string' || !request.text || request.text.length > 4096 || !Number.isSafeInteger(request.requestId)) throw new Error('Invalid find request')
        const id = wc.findInPage(request.text, { forward: request.options?.forward !== false, findNext: request.options?.findNext !== false, matchCase: request.options?.matchCase === true })
        item.find.clear(); item.find.set(id,request.requestId); return
      }
      case 'stopFind': if (!['clearSelection','keepSelection','activateSelection'].includes(request.action)) throw new Error('Invalid find action'); wc.stopFindInPage(request.action); item.find.clear(); return
      case 'snapshot': return wc.executeJavaScript(SNAPSHOT_JS)
      case 'designBegin': return wc.executeJavaScript(DESIGN_CAPTURE_BEGIN_SCRIPT, true)
      case 'designCancel': return wc.executeJavaScript(DESIGN_CAPTURE_CANCEL_SCRIPT)
      case 'capture': {
        const r = request.rect
        if (!r || ![r.x,r.y,r.width,r.height].every(Number.isSafeInteger) || r.x < 0 || r.y < 0 || r.width < 1 || r.height < 1 || r.width > 1600 || r.height > 1200) throw new Error('Invalid capture bounds')
        const image = await wc.capturePage(r), size = image.getSize()
        return { ...size, dataUrl: image.toDataURL(), empty: image.isEmpty() }
      }
      default: throw new Error('Unsupported browser intent')
    }
  }
}
