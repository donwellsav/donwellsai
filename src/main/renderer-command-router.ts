import type { WebContents } from 'electron'
import type { BrowserCommandResult } from '@shared/types'

type Channel = 'browser:command' | 'ui:command'
type RendererTarget = Pick<WebContents, 'send' | 'isDestroyed'>
type Pending = { channel: Channel; command: unknown; sent: boolean; resolve(value: unknown): void; reject(error: Error): void }

export class RendererCommandRouter {
  private contents: RendererTarget | null = null
  private readyChannels = new Set<Channel>()
  private pending = new Map<string, Pending>()
  private sequence = 0

  constructor(private requestContents: () => RendererTarget) {}

  bind(contents: RendererTarget): void {
    this.reset(new Error('Renderer changed before the command finished'))
    this.contents = contents
  }

  reset(error: Error, preserveUnsent = false): void {
    this.readyChannels.clear()
    for (const [id, pending] of this.pending) {
      if (preserveUnsent && !pending.sent) continue
      pending.reject(error)
      this.pending.delete(id)
    }
  }

  isReady(channel: Channel): boolean { return this.readyChannels.has(channel) }

  ready(channel: Channel, sender: RendererTarget): void {
    if (sender !== this.contents) return
    this.readyChannels.add(channel)
    for (const [id, pending] of this.pending) {
      if (pending.channel === channel && !pending.sent) this.dispatch(id, pending)
    }
  }

  call(channel: Channel, command: unknown, timeoutMs = 30000): Promise<unknown> {
    const contents = this.requestContents()
    if (contents !== this.contents) this.bind(contents)
    return new Promise((resolve, reject) => {
      const id = `${channel}-${++this.sequence}`
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${channel} timed out waiting for a ready renderer or command result`))
      }, timeoutMs)
      const pending: Pending = {
        channel, command, sent: false,
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) }
      }
      this.pending.set(id, pending)
      if (this.readyChannels.has(channel)) this.dispatch(id, pending)
    })
  }

  resolve(channel: Channel, id: string, result: BrowserCommandResult, sender: RendererTarget): void {
    if (sender !== this.contents) return
    const pending = this.pending.get(id)
    if (!pending || pending.channel !== channel || !pending.sent) return
    this.pending.delete(id)
    if (result.ok) pending.resolve(result.result)
    else pending.reject(new Error(result.error))
  }

  private dispatch(id: string, pending: Pending): void {
    try {
      if (!this.contents || this.contents.isDestroyed()) throw new Error('Renderer is unavailable')
      pending.sent = true
      this.contents.send(pending.channel, { id, cmd: pending.command })
    } catch (error) {
      this.pending.delete(id)
      pending.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }
}
