import { OPERATIONAL_OUTPUT_LIMIT } from './operational-runs'

type Listener<T> = (payload: T) => void
export type TerminalReplayChunk = { data: string; cols: number; rows: number }

type DataListener = {
  callback: Listener<string>
  suspended: boolean
  disconnected?: () => void
  ready: boolean
  lastSequence: number
  queued: Map<number, string>
  queuedBytes: number
}

export type TerminalSubscription = {
  prepareSnapshot: () => void
  acceptSnapshot: (scrollback: string, sequence?: number) => void
  dispose: () => void
}

/**
 * Out-of-React bus for high-frequency terminal output. Each subscriber holds
 * live chunks until it receives the daemon's atomic snapshot boundary.
 */
export class TerminalBus {
  private dataListeners = new Map<string, Set<DataListener>>()

  subscribe(sessionId: string, callback: Listener<string>, disconnected?: () => void): TerminalSubscription {
    let listeners = this.dataListeners.get(sessionId)
    if (!listeners) {
      listeners = new Set()
      this.dataListeners.set(sessionId, listeners)
    }
    const target = listeners
    const listener: DataListener = {
      callback,
      disconnected,
      suspended: false,
      ready: false,
      lastSequence: 0,
      queued: new Map(),
      queuedBytes: 0
    }
    target.add(listener)
    let disposed = false

    return {
      prepareSnapshot: () => {
        if (disposed) return
        listener.suspended = false
        listener.ready = false
        listener.lastSequence = 0
        listener.queued.clear()
        listener.queuedBytes = 0
      },
      acceptSnapshot: (scrollback, sequence) => {
        if (disposed || listener.suspended) return
        if (sequence === undefined || !Number.isSafeInteger(sequence) || sequence < 0) {
          throw new Error(
            'terminal daemon upgrade required for sequenced reattach; existing sessions were left running'
          )
        }
        if (listener.ready) return
        if (scrollback) listener.callback(scrollback)
        listener.ready = true
        listener.lastSequence = sequence
        for (const queuedSequence of listener.queued.keys()) {
          if (queuedSequence <= sequence) {
            listener.queuedBytes -= listener.queued.get(queuedSequence)!.length
            listener.queued.delete(queuedSequence)
          }
        }
        this.drain(listener)
      },
      dispose: () => {
        disposed = true
        target.delete(listener)
        listener.queued.clear()
        listener.queuedBytes = 0
        if (target.size === 0) this.dataListeners.delete(sessionId)
      }
    }
  }

  emitData(sessionId: string, data: string, sequence?: number): void {
    const listeners = this.dataListeners.get(sessionId)
    if (!listeners || sequence === undefined || !Number.isSafeInteger(sequence) || sequence < 1) return
    for (const listener of listeners) {
      if (listener.suspended || sequence <= listener.lastSequence || listener.queued.has(sequence)) continue
      listener.queued.set(sequence, data)
      listener.queuedBytes += data.length
      if (listener.ready) this.drain(listener)
      if (listener.queuedBytes > 1024 * 1024) {
        listener.suspended = true
        listener.queued.clear()
        listener.queuedBytes = 0
        listener.disconnected?.()
      }
    }
  }

  disconnect(): void {
    for (const listeners of this.dataListeners.values()) {
      for (const listener of listeners) {
        if (listener.suspended) continue
        listener.suspended = true
        listener.queued.clear()
        listener.queuedBytes = 0
        listener.disconnected?.()
      }
    }
  }

  dropSession(sessionId: string): void {
    const listeners = this.dataListeners.get(sessionId)
    if (listeners) {
      for (const listener of listeners) {
        listener.suspended = true
        listener.queued.clear()
        listener.queuedBytes = 0
      }
    }
    this.dataListeners.delete(sessionId)
  }

  private drain(listener: DataListener): void {
    let next = listener.lastSequence + 1
    let data = listener.queued.get(next)
    while (data !== undefined) {
      listener.queued.delete(next)
      listener.queuedBytes -= data.length
      listener.callback(data)
      listener.lastSequence = next
      next++
      data = listener.queued.get(next)
    }
  }
}

/**
 * Daemon-side bounded accumulator for one task child's output sequence. The
 * coordinator pump appends every chunk; the retained tail is what fenced
 * progress writes and the evidence port digest. Bounding matches the daemon
 * scrollback discipline: the freshest output survives, `truncated` records
 * that the head was dropped.
 */
export class SequencedTaskOutputPump {
  private text = ''
  private dropped = false

  constructor(private readonly limitBytes: number = OPERATIONAL_OUTPUT_LIMIT) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 1) throw new Error('task output pump limit must be a positive integer')
  }

  append(data: string): void {
    if (data.length === 0) return
    this.text += data
    if (this.text.length > this.limitBytes) {
      this.text = this.text.slice(this.text.length - this.limitBytes)
      this.dropped = true
    }
  }

  get output(): string {
    return this.text
  }

  get bytes(): number {
    return this.text.length
  }

  get truncated(): boolean {
    return this.dropped
  }
}
