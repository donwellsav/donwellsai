import type { BrowserViewIntent, BrowserViewState } from '@shared/browser-view'
import type { WebviewPort, WebviewEvent } from './browser-routing'
import { SNAPSHOT_JS } from './browser-routing'
import { DESIGN_CAPTURE_BEGIN_SCRIPT, DESIGN_CAPTURE_CANCEL_SCRIPT, type DesignCaptureWebview } from './design-capture'
import type { BrowserFindOptions } from './browser-runtime'

/** Keeps synchronous UI observations; all guest work and lifetime belong to main. */
export class BrowserViewPort implements WebviewPort, DesignCaptureWebview {
  private instance = crypto.randomUUID()
  private state: BrowserViewState = { id: 0,url:'',title:'',loading:false,back:false,forward:false,zoom:1 }
  private listeners = new Map<string,Set<(event: WebviewEvent) => void>>()
  private findId = 0
  private unsubscribe: () => void
  private ready: Promise<void>
  constructor(private key: string) {
    this.unsubscribe = window.donwells.onBrowserView(message => {
      if (message.key !== key || message.instance !== this.instance) return
      this.state = message.state
      for (const listener of this.listeners.get(message.type) ?? []) listener(message.event)
    })
    this.ready = window.donwells.browserView({ key,instance:this.instance,op:'create' }).then(state => { this.state = state as BrowserViewState })
  }
  private async call(request: BrowserViewIntent): Promise<unknown> {
    await this.ready
    return window.donwells.browserView({ ...request, key:this.key, instance:this.instance })
  }
  private send(request: BrowserViewIntent) {
    void this.call(request).catch(error => { for (const listener of this.listeners.get('did-fail-load') ?? []) listener({errorDescription:String(error),isMainFrame:true}) })
  }
  async loadURL(url: string) { await this.call({op:'navigate',url}) }
  reload() { this.send({op:'reload'}) }
  stop() { this.send({op:'stop'}) }
  goBack() { this.send({op:'back'}) }
  goForward() { this.send({op:'forward'}) }
  canGoBack() { return this.state.back }
  canGoForward() { return this.state.forward }
  getURL() { return this.state.url }
  getTitle() { return this.state.title }
  getWebContentsId() { return this.state.id }
  isLoading() { return this.state.loading }
  getZoomFactor() { return this.state.zoom }
  setZoomFactor(factor: number) { this.state.zoom=factor; this.send({op:'zoom',factor}) }
  findInPage(text: string, options?: BrowserFindOptions) { const requestId=++this.findId; this.send({op:'find',text,options,requestId}); return requestId }
  stopFindInPage(action: 'clearSelection'|'keepSelection'|'activateSelection') { this.send({op:'stopFind',action}) }
  async executeJavaScript(code: string): Promise<unknown> {
    const op = code === SNAPSHOT_JS ? 'snapshot' : code === DESIGN_CAPTURE_BEGIN_SCRIPT ? 'designBegin' : code === DESIGN_CAPTURE_CANCEL_SCRIPT ? 'designCancel' : null
    if (!op) throw new Error('Page evaluation is available only through the authorized browser RPC')
    return this.call({op})
  }
  async capturePage(rect: {x:number;y:number;width:number;height:number}) {
    const result = await this.call({op:'capture',rect}) as {empty:boolean;width:number;height:number;dataUrl:string}
    return {isEmpty:()=>result.empty,getSize:()=>({width:result.width,height:result.height}),toDataURL:()=>result.dataUrl}
  }
  bounds(rect: {x:number;y:number;width:number;height:number}|null) { this.send({op:'bounds',rect}) }
  focus() { this.send({op:'focus'}) }
  addEventListener(type: string, listener: (event:WebviewEvent)=>void) { const listeners=this.listeners.get(type)??new Set();listeners.add(listener);this.listeners.set(type,listeners) }
  removeEventListener(type: string, listener: (event:WebviewEvent)=>void) { this.listeners.get(type)?.delete(listener) }
  dispose() { this.unsubscribe(); this.listeners.clear(); void this.call({op:'dispose'}).catch(()=>{}) }
}
