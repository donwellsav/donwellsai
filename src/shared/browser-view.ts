type BrowserFindOptions = { forward?: boolean; findNext?: boolean; matchCase?: boolean }
type WebviewEvent = { errorCode?: number; errorDescription?: string; validatedURL?: string; isMainFrame?: boolean; url?: string; result?: {requestId:number;activeMatchOrdinal:number;matches:number;finalUpdate?:boolean} }
export type BrowserViewRect = { x: number; y: number; width: number; height: number }
export type BrowserViewRequest = { key: string; instance: string } & (
  | { op: 'create' | 'dispose' | 'reload' | 'stop' | 'back' | 'forward' | 'focus' | 'snapshot' | 'designBegin' | 'designCancel' }
  | { op: 'navigate'; url: string }
  | { op: 'bounds'; rect: BrowserViewRect | null }
  | { op: 'zoom'; factor: number }
  | { op: 'find'; text: string; requestId: number; options?: BrowserFindOptions }
  | { op: 'stopFind'; action: 'clearSelection' | 'keepSelection' | 'activateSelection' }
  | { op: 'capture'; rect: BrowserViewRect }
)
export type BrowserViewIntent = BrowserViewRequest extends infer T ? T extends BrowserViewRequest ? Omit<T, 'key' | 'instance'> : never : never
export type BrowserViewState = { id: number; url: string; title: string; loading: boolean; back: boolean; forward: boolean; zoom: number }
export type BrowserViewEvent = { key: string; instance: string; type: string; event: WebviewEvent; state: BrowserViewState }
export type BrowserViewApi = {
  browserView(request: BrowserViewRequest): Promise<unknown>
  onBrowserView(callback: (event: BrowserViewEvent) => void): () => void
}
