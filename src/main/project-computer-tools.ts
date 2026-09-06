import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { isObject } from '@shared/command-catalog'
import type { ProjectToolDefinition } from './project-tools'
import type { ProjectToolScope } from '@shared/project-tools'

type Request = (tool?: string, parameters?: Record<string, unknown>) => Promise<unknown>
type Attachment = { app: string; title: string; owner: string; pid: number; window: number; foreground: boolean; generation: number; revision: number; refs: Set<string>; bounds: string; screenshot: {width:number;height:number} | null; busy: boolean; uncertain: boolean }
const positive = (value: unknown): number => { if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error('Expected a positive integer'); return Number(value) }
const text = (value: unknown): string => { if (typeof value !== 'string' || !value || value.length > 4096) throw new Error('Expected bounded text'); return value }
const boolean = (value: unknown): boolean => { if (typeof value !== 'boolean') throw new Error('Expected a boolean'); return value }
const coordinate = (value: unknown): number => { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 32768) throw new Error('Invalid screenshot coordinate'); return value }
const data = (result: unknown): Record<string, unknown> => {
  if (!isObject(result) || result.isError || !isObject(result.structuredContent)) throw new Error('Native control refused the operation: ' + JSON.stringify(result).slice(0, 2048))
  return result.structuredContent
}

// Shared across project configurations: a new definition must not grant a second desktop lease.
const targets = new Map<string, string>(), starting = new Set<string>()
let generation = 0, desktop: Attachment | null = null

/** Each definition retains its attachments; window and input ownership span all definitions. */
export function createComputerToolDefinition(binary: string): ProjectToolDefinition {
  const attached = new Map<string, Attachment>()
  const key = (item: Attachment) => `${item.pid}:${item.window}`
  const detach = (scope: ProjectToolScope) => {
    const item = attached.get(scope.indexKey)
    if (item) { targets.delete(key(item)); attached.delete(scope.indexKey); if (desktop === item) desktop = null }
  }
  const windows = async (request: Request, pid?: number) => {
    const result = await request('list_windows', pid ? { pid } : {})
    const state = data(result)
    if (!Array.isArray(state.windows)) throw new Error('Native window inventory unavailable')
    return { result, entries: state.windows.filter(isObject) }
  }
  const liveWindow = async (request: Request, item: Attachment) => {
    const { entries } = await windows(request, item.pid)
    const window = entries.find(window => window.pid === item.pid && window.window_id === item.window)
    if (!window || !isObject(window.bounds)) throw new Error('Attached window closed or changed owner')
    return window
  }
  const snapshot = async (request: Request, item: Attachment, screenshot: boolean) => {
    item.refs.clear(); item.revision++; item.screenshot = null
    const window = await liveWindow(request, item)
    const result = await request('get_window_state', { pid: item.pid, window_id: item.window, include_screenshot: screenshot, max_elements: 250, max_depth: 15 })
    const state = data(result)
    if (state.pid !== item.pid || state.window_id !== item.window) throw new Error('Native snapshot target mismatch')
    if (Array.isArray(state.elements)) for (const element of state.elements) if (isObject(element) && typeof element.element_token === 'string') item.refs.add(element.element_token)
    item.app=String(window.app_name??'App');item.title=String(window.title??'Untitled window')
    item.bounds = JSON.stringify(window.bounds)
    if (isObject(result) && Array.isArray(result.content)) {
      const image = result.content.find(part => isObject(part) && part.type === 'image' && part.mimeType === 'image/png')
      if (isObject(image) && typeof image.data === 'string') {
        const png = Buffer.from(image.data, 'base64')
        if (png.length > 24 && png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) item.screenshot = {width:png.readUInt32BE(16),height:png.readUInt32BE(20)}
      }
    }
    return result
  }
  const resultWithTarget = (result: unknown, item: Attachment) => {
    const native=isObject(result)?result:{}, attachment={app:item.app,title:item.title,pid:item.pid,window:item.window,generation:item.generation,revision:item.revision,foregroundAllowed:item.foreground,untrusted:true}
    return {...native,structuredContent:{...(isObject(native.structuredContent)?native.structuredContent:{}),attachment},content:[{type:'text',text:JSON.stringify(attachment)},...(Array.isArray(native.content)?native.content:[])]}
  }
  const run = (operation: string) => async (scope: ProjectToolScope, request: Request, args: Record<string, unknown>) => {
    if (operation === 'status') { const item=attached.get(scope.indexKey); return {content:[{type:'text',text:item?`Attached to ${item.app} · ${item.title} (PID ${item.pid}, window ${item.window})${item.uncertain?' — uncertain action; stop required':''}`:'No window attached'}],structuredContent:item?{app:item.app,title:item.title,pid:item.pid,window:item.window,generation:item.generation,uncertain:item.uncertain,foregroundAllowed:item.foreground}:null} }
    if (operation === 'permissions') return request('check_permissions', {})
    if (operation === 'windows') return (await windows(request)).result
    if (operation === 'attach') {
      if (attached.has(scope.indexKey) || starting.has(scope.indexKey)) throw new Error('Release this checkout controller before attaching again')
      const item: Attachment = { app:'', title:'', owner: String(args.owner), pid: Number(args.pid), window: Number(args.window), foreground: !!args.foreground, generation: ++generation, revision: 0, refs: new Set(), bounds: '', screenshot: null, busy: true, uncertain: false }
      if (targets.has(key(item))) throw new Error('This target already has a controller')
      targets.set(key(item), scope.indexKey); starting.add(scope.indexKey)
      try {
        const permissions = data(await request('check_permissions', {}))
        if (permissions.accessibility !== true || permissions.screen_recording !== true) throw new Error('Accessibility and Screen Recording permissions are required; grant them in macOS Privacy settings, then retry')
        const result = await snapshot(request, item, false)
        attached.set(scope.indexKey, item)
        return resultWithTarget(result, item)
      } catch (error) { targets.delete(key(item)); throw error }
      finally { starting.delete(scope.indexKey); item.busy = false }
    }
    const item = attached.get(scope.indexKey)
    if (!item) throw new Error('Select and attach an app window first')
    if (item.busy) throw new Error('This target already has an operation in progress')
    const observe = operation === 'observe' || operation === 'screenshot'
    if (!observe && item.uncertain) throw new Error('Previous input outcome is uncertain; stop this controller before reassignment')
    if (!observe && (args.owner !== item.owner || args.generation !== item.generation)) throw new Error('This controller does not own the attached target')
    if (!observe && args.revision !== item.revision) throw new Error('Stale observation; inspect the window again')
    const pixel = operation === 'pixelClick' || operation === 'pixelType'
    if (!observe && (pixel ? !item.screenshot : !item.refs.has(String(args.element)))) throw new Error('A fresh matching element or screenshot is required')
    if (pixel && item.screenshot && (Number(args.x) >= item.screenshot.width || Number(args.y) >= item.screenshot.height)) throw new Error('Coordinates are outside the observed window image')
    // Keyboard synthesis can fall back from AX. Reserve the desktop for it even in background mode.
    const needsDesktop = !observe && (item.foreground || operation === 'type' || operation === 'pixelType' || operation === 'hotkey')
    if (needsDesktop && desktop && desktop !== item) throw new Error('Desktop input is owned by another action')
    item.busy = true
    if (needsDesktop) desktop = item
    if (!observe) { item.refs.clear(); item.revision++ }
    let dispatched = false
    try {
      if (observe) return resultWithTarget(await snapshot(request, item, operation === 'screenshot'), item)
      const window = await liveWindow(request, item)
      if (JSON.stringify(window.bounds) !== item.bounds) throw new Error('Window moved or resized; take a fresh observation')
      const parameters: Record<string, unknown> = { pid: item.pid, window_id: item.window, delivery_mode: item.foreground ? 'foreground' : 'background' }
      if (pixel) { parameters.x = args.x; parameters.y = args.y } else parameters.element_token = args.element
      if (operation === 'type' || operation === 'pixelType') parameters.text = args.text
      if (operation === 'hotkey') parameters.keys = args.keys
      dispatched = true
      const result = await request(operation === 'type' || operation === 'pixelType' ? 'type_text' : operation === 'hotkey' ? 'hotkey' : 'click', parameters)
      if (!isObject(result) || result.isError) throw new Error('Native input outcome is uncertain; inspect and stop before retrying. ' + (isObject(result)&&Array.isArray(result.content)?result.content.filter(part=>isObject(part)&&part.type==='text').map(part=>part.text).join('\n').slice(0,2048):'Invalid native result'))
      dispatched = false
      return resultWithTarget(result, item)
    } finally {
      item.busy = false
      if (dispatched) item.uncertain = true
      // Keep an uncertain desktop lease until ProjectTools confirms process termination via stopped().
      if (!dispatched && desktop === item && attached.get(scope.indexKey) === item) desktop = null
    }
  }
  const action = { owner: text, generation: positive, revision: positive }
  const operation = (name: string, parameters: ProjectToolDefinition['operations'][string]['parameters'], readOnly: boolean) => ({ tool: ({status:'check_permissions',permissions:'check_permissions',windows:'list_windows',attach:'get_window_state',observe:'get_window_state',screenshot:'get_window_state',click:'click',pixelClick:'click',type:'type_text',pixelType:'type_text',hotkey:'hotkey'} as Record<string,string>)[name]!, parameters, targets: () => ({}), readOnly, run: run(name) })
  return {
    id: 'computer-control', version: '0.23.2', protocolVersion: '2025-06-18', scope: 'checkout',
    prepare: async (_scope, signal) => { if (!isAbsolute(binary) || createHash('sha256').update(await readFile(binary)).digest('hex') !== '2cb9be8da6c91bfa6b535a0d777ca61e463996aff9cd769dace2eb840ddd0700') throw new Error('Cua Driver artifact does not match the admitted external executable'); signal.throwIfAborted() },
    launch: () => ({ program: binary, args: ['mcp', '--direct', '--embedded', '--host-bundle-id', 'ai.donwells.desktop'], env: { CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false' } }),
    stopped: detach,
    operations: {
      status: operation('status', {}, true),
      permissions: operation('permissions', {}, true), windows: operation('windows', {}, true),
      attach: operation('attach', { owner: text, pid: positive, window: positive, foreground: boolean }, false),
      observe: operation('observe', {}, true), screenshot: operation('screenshot', {}, true),
      click: operation('click', { ...action, element: text }, false),
      type: operation('type', { ...action, element: text, text }, false),
      pixelClick: operation('pixelClick', { ...action, x: coordinate, y: coordinate }, false),
      pixelType: operation('pixelType', { ...action, x: coordinate, y: coordinate, text }, false),
      hotkey: operation('hotkey', { ...action, element: text, keys: value => { if (!Array.isArray(value) || !value.length || value.length > 5) throw new Error('Expected a bounded key chord'); return value.map(text) } }, false)
    }
  }
}
