import { appResourcesRoot } from './app-resources'
import { appCommand, resolveAppShortcuts } from '@shared/app-commands'
import { app, shell, type BrowserWindow } from 'electron'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AppSettings } from '@shared/types'
import type { NativeTerminalRequest, NativeTerminalResult, NativeTerminalAvailability, GhosttyTheme } from '@shared/native-terminal'
import type { HerdrTerminalSource } from '@shared/herdr-session'
import type { DaemonClient } from './daemon-client'
import { TerminalBus, type TerminalSubscription } from '@shared/terminal-stream'
import { HerdrTerminalBridge, sessionErrorMessage } from './herdr-session'
import { ghosttyKeybindCommands } from './ghostty-keybinds'
import { mergeGhosttyConfig, nativeTerminalConfiguration } from './native-terminal-config'
import { resolveTerminalPalette } from '../renderer/src/terminal-themes'
import { logger } from '@shared/logger'

type Entry = { id: string; instance: string; sessionId: string; source?: HerdrTerminalSource; connected: boolean; stream: TerminalSubscription; generation: number; cols: number; rows: number; measured?: boolean; boundsReady?: boolean; snapshot?: Awaited<ReturnType<DaemonClient['attach']>> }
type Binding = { request(json: string, handle?: Buffer): string; listen(callback: (json: string) => void): void }
let binding: Binding | undefined
let receive: ((json: string) => void) | undefined
let themes: GhosttyTheme[] | undefined

function native(): Binding {
  if (process.platform !== 'darwin') throw new Error('Native Ghostty is available only on macOS.')
  if (!binding) {
    const path = join(appResourcesRoot(), app.isPackaged ? 'native/ghostty.node' : 'resources/native/ghostty.node')
    process.env.GHOSTTY_RESOURCE_BUNDLE = join(dirname(path), 'GhosttyKit_GhosttyTerminal.bundle')
    binding = createRequire(__filename)(path) as Binding
    binding.listen(json => receive?.(json))
  }
  return binding
}

/**
 * Report whether the native Ghostty surface can render here, without throwing.
 *
 * The renderer uses this to fall back to xterm instead of presenting a pane it
 * cannot draw. Loading is idempotent, so a successful probe is what the first
 * terminal would do anyway.
 */
export function nativeTerminalAvailability(): NativeTerminalAvailability {
  try {
    native()
    return { available: true }
  } catch (cause) {
    return { available: false, reason: cause instanceof Error ? cause.message : String(cause) }
  }
}

/**
 * The user's own Ghostty configuration, if they keep one. Read per surface so
 * edits show up in the next terminal rather than after a restart.
 */
function ghosttyUserConfig(): string {
  try {
    const base = process.env['XDG_CONFIG_HOME']?.trim() || join(homedir(), '.config')
    return readFileSync(join(base, 'ghostty', 'config'), 'utf8')
  } catch {
    return ''
  }
}

/**
 * Ghostty's bundled theme collection, read once from the native module.
 *
 * This is the same catalog `ghostty +list-themes` reports, so a theme chosen
 * here behaves like the upstream one rather than an app-specific imitation.
 */
export function nativeTerminalThemes(): GhosttyTheme[] {
  if (themes) return themes
  const response = JSON.parse(native().request(JSON.stringify({ id: 'catalog', op: 'themes' }))) as { error?: string; themes?: GhosttyTheme[] }
  if (response.error) throw new Error(String(response.error))
  themes = response.themes ?? []
  return themes
}

/** Native surfaces are presentation only; the existing daemon owns every PTY. */
export class NativeTerminals {
  private entries = new Map<string, Entry>()
  private stream = new TerminalBus()
  private herdrStream = new TerminalBus()
  private herdr = new HerdrTerminalBridge()
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
    if (this.entries.get(entry.sessionId) !== entry) return
    entry.connected = false; entry.generation++
    try { this.call(entry, 'connected', { value: false }) }
    catch (cause) { error += ` Native surface: ${String(cause)}` }
    this.publish(entry, { error })
  }
  data(sessionId: string, data: string, sequence?: number) { this.stream.emitData(sessionId, data, sequence) }
  disconnect() { this.stream.disconnect() }
  exited(sessionId: string) {
    const entry = this.entries.get(sessionId)
    if (entry) { entry.connected = false; entry.generation++; this.call(entry, 'connected', { value: false }) }
  }
  private shortcuts() { return Object.fromEntries(resolveAppShortcuts(this.settings().keyboardShortcutOverrides, 'mac').shortcuts.map(item => [item.normalized, item.command.id])) }
  /**
   * Chords the user's own Ghostty keybinds ask for that map onto an app command.
   * Terminal-level actions are handled by the embedded surface instead.
   */
  private keybinds() {
    if (!this.settings().terminalUseGhosttyConfig) return {}
    return ghosttyKeybindCommands(ghosttyUserConfig(), 'mac')
  }
  /**
   * The palette a surface renders with. Shares the renderer's resolver so the
   * native surface and the xterm fallback cannot drift apart.
   */
  private palette(): Record<string, string> {
    let catalog: GhosttyTheme[] = []
    try { catalog = nativeTerminalThemes() } catch { catalog = [] }
    return resolveTerminalPalette(this.settings(), catalog)
  }
  /**
   * Settings first, then the user's own Ghostty configuration for anything the
   * app does not manage (see mergeGhosttyConfig for the precedence rule).
   */
  private configuration(): string {
    const generated = nativeTerminalConfiguration(this.settings(), this.palette())
    if (!this.settings().terminalUseGhosttyConfig) return generated
    return mergeGhosttyConfig(ghosttyUserConfig(), generated)
  }
  configure() { for (const entry of this.entries.values()) this.call(entry, 'configuration', { configuration: this.configuration(), shortcuts: this.shortcuts(), keybinds: this.keybinds() }) }
  private dispose(entry: Entry) {
    entry.generation++; entry.connected = false; entry.stream.dispose()
    if (entry.source) this.herdr.stop(entry.sessionId)
    this.entries.delete(entry.sessionId)
    try { this.call(entry, 'destroy') }
    catch (error) { logger.error({ err: error }, 'Native terminal surface cleanup failed') }
  }
  private clear() { for (const entry of this.entries.values()) this.dispose(entry) }
  private replay(entry: Entry) {
    const snapshot = entry.snapshot
    if (!snapshot || !entry.measured) return
    this.call(entry, 'snapshot', { chunks: snapshot.replay ?? [{ data: snapshot.scrollback, cols: 100, rows: 30 }], cols: entry.cols, rows: entry.rows })
    entry.snapshot = undefined
    entry.stream.acceptSnapshot('', snapshot.sequence)
    entry.connected = snapshot.session.exited !== true
    this.call(entry, 'connected', { value: entry.connected })
  }
  private sameSource(left?: HerdrTerminalSource, right?: HerdrTerminalSource): boolean {
    return left?.kind === right?.kind && left?.paneId === right?.paneId && left?.mode === right?.mode && left?.takeover === right?.takeover
  }
  private validSource(source: unknown): source is HerdrTerminalSource | undefined {
    if (source === undefined) return true
    if (source === null || typeof source !== 'object' || Array.isArray(source)) return false
    const candidate = source as Partial<HerdrTerminalSource>
    return candidate.kind === 'herdr' && typeof candidate.paneId === 'string' && /^[\w.:-]{1,128}$/.test(candidate.paneId) && ['observe', 'control'].includes(candidate.mode ?? '') && (candidate.takeover === undefined || typeof candidate.takeover === 'boolean') && (candidate.mode === 'control' || candidate.takeover !== true)
  }
  private async startHerdr(entry: Entry): Promise<void> {
    const source = entry.source
    if (!source || !entry.boundsReady || this.herdr.isActive(entry.sessionId)) return
    const generation = entry.generation
    try {
      await this.herdr.start(entry.sessionId, source, entry.cols, entry.rows,
        (data, sequence) => this.herdrStream.emitData(entry.sessionId, data, sequence),
        error => this.disconnected(entry, error))
      if (this.entries.get(entry.sessionId) !== entry || entry.generation !== generation) return
      entry.connected = true
      this.call(entry, 'connected', { value: true })
    } catch (error) {
      if (this.entries.get(entry.sessionId) === entry && entry.generation === generation) this.disconnected(entry, sessionErrorMessage(error))
    }
  }
  private event(json: string) {
    try {
      const event = JSON.parse(json)
      const entry = [...this.entries.values()].find(item => item.id === event.id)
      if (!entry || this.closed) return
      if (event.type === 'input' && entry.connected && typeof event.data === 'string') {
        const data = Buffer.from(event.data, 'base64').toString('utf8')
        if (entry.source?.mode === 'control') this.herdr.input(entry.sessionId, data)
        else if (!entry.source) this.daemon.write(entry.sessionId, data)
      }
      if (event.type === 'resize' && entry.boundsReady && Number.isInteger(event.cols) && Number.isInteger(event.rows) && event.cols > 0 && event.rows > 0) {
        const current = this.call(entry, 'geometry')
        if (current.cols !== event.cols || current.rows !== event.rows) return
        entry.cols = event.cols; entry.rows = event.rows; entry.measured = true
        try { this.replay(entry) } catch (error) { this.disconnected(entry, String(error)); return }
        if (entry.source) {
          if (this.herdr.isActive(entry.sessionId)) this.herdr.resize(entry.sessionId, event.cols, event.rows)
          else void this.startHerdr(entry)
        } else if (entry.connected) void this.daemon.resize(entry.sessionId, event.cols, event.rows).catch(error => this.disconnected(entry, String(error)))
      }
      // The surface may resolve either an app shortcut or a user's Ghostty
      // keybind, so validate against the command catalog rather than the current
      // shortcut table.
      if (event.type === 'shortcut' && typeof event.command === 'string' && appCommand(event.command)) {
        this.window.webContents.focus()
        this.window.webContents.send('menu:action', { action: event.command })
      }
      if (event.type === 'focus') this.publish(entry, { focused: event.focused === true && this.window.isFocused() && this.window.isVisible() })
      if (event.type === 'url' && typeof event.url === 'string' && /^https?:\/\//i.test(event.url)) void shell.openExternal(event.url)
    } catch (error) { logger.error({ err: error }, 'Native terminal event failed') }
  }
  async request(request: NativeTerminalRequest): Promise<NativeTerminalResult> {
    if (this.closed || this.window.isDestroyed()) throw new Error('Native terminal window closed')
    if (!request || typeof request.sessionId !== 'string' || request.sessionId.length > 256 || typeof request.instance !== 'string' || !request.instance || request.instance.length > 128 || !this.validSource(request.source) || (request.source && request.sessionId !== `herdr:${request.source.paneId}`)) throw new Error('Invalid native terminal owner')
    let entry = this.entries.get(request.sessionId)
    if (request.op === 'create') {
      if (entry?.instance !== request.instance || !this.sameSource(entry?.source, request.source)) {
        if (entry) this.dispose(entry)
        const next: Entry = { id: request.sessionId + "/" + request.instance, instance: request.instance, sessionId: request.sessionId, source: request.source, connected: false, generation: 0, cols: 100, rows: 30, stream: null! }
        this.call(next, 'create', { configuration: this.configuration(), shortcuts: this.shortcuts(), keybinds: this.keybinds() })
        const bus = request.source ? this.herdrStream : this.stream
        next.stream = bus.subscribe(request.sessionId, data => this.call(next, 'write', { data }), () => this.disconnected(next, 'Connection to the terminal service was lost. Reattach to check this session.'))
        this.entries.set(request.sessionId, next); entry = next
      }
    }
    if (!entry || entry.instance !== request.instance || !this.sameSource(entry.source, request.source)) {
      if (request.op === 'dispose') return {}
      throw new Error('Native terminal ownership changed')
    }
    if (request.op === 'create' || request.op === 'reattach') {
      const generation = ++entry.generation
      entry.connected = false; this.call(entry, 'connected', { value: false }); entry.stream.prepareSnapshot()
      if (entry.source) {
        entry.stream.acceptSnapshot('', 0)
        if (entry.boundsReady) await this.startHerdr(entry)
        return { connected: entry.connected, truncated: false }
      }
      const result = await this.daemon.attach(entry.sessionId)
      if (this.entries.get(entry.sessionId) !== entry || entry.generation !== generation) throw new Error('Native terminal attachment changed')
      if (!result) throw new Error('The terminal service no longer retains this session')
      entry.snapshot = result
      this.replay(entry)
      return { connected: result.session.exited !== true, truncated: result.truncated !== false }
    }
    if (request.op === 'dispose') { this.dispose(entry); return {} }
    if (request.op === 'bounds') {
      const rect = request.rect
      if (rect !== null && (!rect || ![rect.x,rect.y,rect.width,rect.height].every(Number.isFinite) || rect.width < 0 || rect.height < 0)) throw new Error('Invalid native terminal bounds')
      const [width,height] = this.window.getContentSize(), zoom = this.window.webContents.getZoomFactor()
      const x = rect ? Math.max(0,Math.round(rect.x*zoom)) : 0, y = rect ? Math.max(0,Math.round(rect.y*zoom)) : 0
      if (rect && rect.width > 0 && rect.height > 0) entry.boundsReady = true
      const result = this.call(entry, 'bounds', rect ? { x,y,width:Math.max(0,Math.min(rect.width*zoom,width-x)),height:Math.max(0,Math.min(rect.height*zoom,height-y)) } : {})
      if (rect && entry.source && !this.herdr.isActive(entry.sessionId)) void this.startHerdr(entry)
      if (result.focused) this.window.webContents.focus()
      return {}
    }
    if (request.op === 'redraw') {
      if (entry.source) throw new Error('The original session manages its own screen redraw.')
      if (!entry.connected) throw new Error('Reattach this session before requesting a redraw')
      await this.daemon.resize(entry.sessionId, Math.max(2,entry.cols-1), entry.rows)
      await this.daemon.resize(entry.sessionId, entry.cols, entry.rows)
      return {}
    }
    if (request.op === 'find' || request.op === 'focus') { this.call(entry, request.op); return {} }
    throw new Error('Unknown native terminal operation')
  }
}
