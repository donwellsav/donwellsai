import { resolveAppShortcuts } from '@shared/app-commands'
import { app, shell, type BrowserWindow } from 'electron'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { AppSettings } from '@shared/types'
import type { NativeTerminalRequest, NativeTerminalResult } from '@shared/native-terminal'
import type { DaemonClient } from './daemon-client'
import { TerminalBus, type TerminalSubscription } from '@shared/terminal-stream'
import { terminalThemeOf } from '../renderer/src/terminal-themes'

type Entry = { id: string; instance: string; sessionId: string; connected: boolean; stream: TerminalSubscription; generation: number; cols: number; rows: number }
type Binding = { request(json: string, handle?: Buffer): string; listen(callback: (json: string) => void): void }
let binding: Binding | undefined
let receive: ((json: string) => void) | undefined

function native(): Binding {
  if (process.platform !== 'darwin') throw new Error('Native Ghostty is available on macOS. Choose xterm in Terminal settings on this platform.')
  if (!binding) {
    const path = app.isPackaged ? join(process.resourcesPath, 'native/ghostty.node') : join(app.getAppPath(), 'resources/native/ghostty.node')
    process.env.GHOSTTY_RESOURCE_BUNDLE = join(dirname(path), 'GhosttyKit_GhosttyTerminal.bundle')
    binding = createRequire(__filename)(path) as Binding
    binding.listen(json => receive?.(json))
  }
  return binding
}

export function nativeTerminalConfiguration(settings: AppSettings): string {
  const theme = terminalThemeOf(settings.terminalTheme)
  const colors = ['black','red','green','yellow','blue','magenta','cyan','white','brightBlack','brightRed','brightGreen','brightYellow','brightBlue','brightMagenta','brightCyan','brightWhite']
  const font = settings.terminalFontFamily.split(',')[0].trim().replace(/^['"]|['"]$/g, '').replace(/[\r\n\0]/g, '') || 'Menlo'
  return [
    `font-family = ${JSON.stringify(font)}`, `font-size = ${settings.terminalFontSize}`,
    `cursor-style = ${settings.cursorStyle}`, `cursor-style-blink = ${settings.cursorBlink}`,
    `background = ${theme.background}`, `foreground = ${theme.foreground}`,
    `cursor-color = ${theme.cursor}`, `cursor-text = ${theme.cursorAccent}`,
    `selection-background = ${theme.selectionBackground}`,
    ...colors.map((color, index) => `palette = ${index}=${theme[color]}`),
    'clipboard-read = deny', 'clipboard-write = ask', 'window-padding-x = 0', 'window-padding-y = 0'
  ].join('\n') + '\n'
}

/** Native surfaces are presentation only; the existing daemon owns every PTY. */
export class NativeTerminals {
  private entries = new Map<string, Entry>()
  private stream = new TerminalBus()
  private closed = false
  constructor(private window: BrowserWindow, private daemon: DaemonClient, private settings: () => AppSettings) {
    receive = json => this.event(json)
    window.on('closed', () => { this.closed = true; this.clear() })
    window.webContents.on('render-process-gone', () => this.clear())
    window.webContents.on('did-start-navigation', (_event, _url, inPlace, main) => { if (main && !inPlace) this.clear() })
  }
  private call(entry: Entry, op: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
    const result = JSON.parse(native().request(JSON.stringify({ id: entry.id, op, ...fields }), ...(op === 'create' ? [this.window.getNativeWindowHandle()] : [])))
    if (result.error) throw new Error(String(result.error))
    return result
  }
  private publish(entry: Entry, extra: { error?: string; focused?: boolean }) {
    if (!this.window.isDestroyed()) this.window.webContents.send('native-terminal:event', { sessionId: entry.sessionId, instance: entry.instance, ...extra })
  }
  private disconnected(entry: Entry, error: string) {
    entry.connected = false; entry.generation++
    this.call(entry, 'connected', { value: false })
    this.publish(entry, { error })
  }
  data(sessionId: string, data: string, sequence?: number) { this.stream.emitData(sessionId, data, sequence) }
  disconnect() { this.stream.disconnect() }
  exited(sessionId: string) {
    const entry = this.entries.get(sessionId)
    if (entry) { entry.connected = false; entry.generation++; this.call(entry, 'connected', { value: false }) }
  }
  private shortcuts() { return Object.fromEntries(resolveAppShortcuts(this.settings().keyboardShortcutOverrides, 'mac').shortcuts.map(item => [item.normalized, item.command.id])) }
  configure() { for (const entry of this.entries.values()) this.call(entry, 'configuration', { configuration: nativeTerminalConfiguration(this.settings()), shortcuts: this.shortcuts() }) }
  private dispose(entry: Entry) {
    entry.generation++; entry.connected = false; entry.stream.dispose()
    this.call(entry, 'destroy'); this.entries.delete(entry.sessionId)
  }
  private clear() { for (const entry of this.entries.values()) this.dispose(entry) }
  private event(json: string) {
    try {
      const event = JSON.parse(json)
      const entry = [...this.entries.values()].find(item => item.id === event.id)
      if (!entry || this.closed) return
      if (event.type === 'input' && entry.connected && typeof event.data === 'string') this.daemon.write(entry.sessionId, Buffer.from(event.data, 'base64').toString('utf8'))
      if (event.type === 'resize' && Number.isInteger(event.cols) && Number.isInteger(event.rows) && event.cols > 0 && event.rows > 0) {
        entry.cols = event.cols; entry.rows = event.rows
        void this.daemon.resize(entry.sessionId, event.cols, event.rows).catch(error => this.disconnected(entry, String(error)))
      }
      if (event.type === 'shortcut' && Object.values(this.shortcuts()).includes(event.command)) {
        this.window.webContents.focus()
        this.window.webContents.send('menu:action', { action: event.command })
      }
      if (event.type === 'focus') this.publish(entry, { focused: event.focused === true && this.window.isFocused() && this.window.isVisible() })
      if (event.type === 'url' && typeof event.url === 'string' && /^https?:\/\//i.test(event.url)) void shell.openExternal(event.url)
    } catch (error) { console.error('Native terminal event failed:', error) }
  }
  async request(request: NativeTerminalRequest): Promise<NativeTerminalResult> {
    if (this.closed || this.window.isDestroyed()) throw new Error('Native terminal window closed')
    if (!request || typeof request.sessionId !== 'string' || request.sessionId.length > 128 || typeof request.instance !== 'string' || !request.instance || request.instance.length > 128) throw new Error('Invalid native terminal owner')
    let entry = this.entries.get(request.sessionId)
    if (request.op === 'create') {
      if (entry?.instance !== request.instance) {
        if (entry) this.dispose(entry)
        const next: Entry = { id: request.sessionId + "/" + request.instance, instance: request.instance, sessionId: request.sessionId, connected: false, generation: 0, cols: 100, rows: 30, stream: null! }
        this.call(next, 'create', { configuration: nativeTerminalConfiguration(this.settings()), shortcuts: this.shortcuts() })
        next.stream = this.stream.subscribe(request.sessionId, data => this.call(next, 'write', { data }), () => this.disconnected(next, 'Connection to the terminal service was lost. Reattach to check this session.'))
        this.entries.set(request.sessionId, next); entry = next
      }
    }
    if (!entry || entry.instance !== request.instance) {
      if (request.op === 'dispose') return {}
      throw new Error('Native terminal ownership changed')
    }
    if (request.op === 'create' || request.op === 'reattach') {
      const generation = ++entry.generation
      entry.connected = false; this.call(entry, 'connected', { value: false }); entry.stream.prepareSnapshot()
      const result = await this.daemon.attach(entry.sessionId)
      if (this.entries.get(entry.sessionId) !== entry || entry.generation !== generation) throw new Error('Native terminal attachment changed')
      if (!result) throw new Error('The terminal service no longer retains this session')
      this.call(entry, 'reset'); entry.stream.acceptSnapshot(result.scrollback, result.sequence)
      entry.connected = result.session.exited !== true
      this.call(entry, 'connected', { value: entry.connected })
      return { connected: entry.connected, truncated: result.truncated !== false }
    }
    if (request.op === 'dispose') { this.dispose(entry); return {} }
    if (request.op === 'bounds') {
      const rect = request.rect
      if (rect !== null && (!rect || ![rect.x,rect.y,rect.width,rect.height].every(Number.isFinite) || rect.width < 0 || rect.height < 0)) throw new Error('Invalid native terminal bounds')
      const [width,height] = this.window.getContentSize(), zoom = this.window.webContents.getZoomFactor()
      const x = rect ? Math.max(0,Math.round(rect.x*zoom)) : 0, y = rect ? Math.max(0,Math.round(rect.y*zoom)) : 0
      const result = this.call(entry, 'bounds', rect ? { x,y,width:Math.max(0,Math.min(rect.width*zoom,width-x)),height:Math.max(0,Math.min(rect.height*zoom,height-y)) } : {})
      if (result.focused) this.window.webContents.focus()
      return {}
    }
    if (request.op === 'redraw') {
      if (!entry.connected) throw new Error('Reattach this session before requesting a redraw')
      await this.daemon.resize(entry.sessionId, Math.max(2,entry.cols-1), entry.rows)
      await this.daemon.resize(entry.sessionId, entry.cols, entry.rows)
      return {}
    }
    if (request.op === 'find' || request.op === 'focus') { this.call(entry, request.op); return {} }
    throw new Error('Unknown native terminal operation')
  }
}
