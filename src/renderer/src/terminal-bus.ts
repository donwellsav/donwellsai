type Listener<T> = (payload: T) => void

type DataListener = {
  callback: Listener<string>
  ready: boolean
  lastSequence: number
  queued: Map<number, string>
}

export type TerminalSubscription = {
  acceptSnapshot: (scrollback: string, sequence?: number) => void
  dispose: () => void
}

/**
 * Out-of-React bus for high-frequency terminal output. Each subscriber holds
 * live chunks until it receives the daemon's atomic snapshot boundary.
 */
export class TerminalBus {
  private dataListeners = new Map<string, Set<DataListener>>()

  subscribe(sessionId: string, callback: Listener<string>): TerminalSubscription {
    let listeners = this.dataListeners.get(sessionId)
    if (!listeners) {
      listeners = new Set()
      this.dataListeners.set(sessionId, listeners)
    }
    const target = listeners
    const listener: DataListener = {
      callback,
      ready: false,
      lastSequence: 0,
      queued: new Map()
    }
    target.add(listener)

    return {
      acceptSnapshot: (scrollback, sequence) => {
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
          if (queuedSequence <= sequence) listener.queued.delete(queuedSequence)
        }
        this.drain(listener)
      },
      dispose: () => {
        target.delete(listener)
        listener.queued.clear()
        if (target.size === 0) this.dataListeners.delete(sessionId)
      }
    }
  }

  emitData(sessionId: string, data: string, sequence?: number): void {
    const listeners = this.dataListeners.get(sessionId)
    if (!listeners || sequence === undefined || !Number.isSafeInteger(sequence) || sequence < 1) return
    for (const listener of listeners) {
      if (sequence <= listener.lastSequence || listener.queued.has(sequence)) continue
      listener.queued.set(sequence, data)
      if (listener.ready) this.drain(listener)
    }
  }

  dropSession(sessionId: string): void {
    const listeners = this.dataListeners.get(sessionId)
    if (listeners) {
      for (const listener of listeners) listener.queued.clear()
    }
    this.dataListeners.delete(sessionId)
  }

  private drain(listener: DataListener): void {
    let next = listener.lastSequence + 1
    let data = listener.queued.get(next)
    while (data !== undefined) {
      listener.queued.delete(next)
      listener.callback(data)
      listener.lastSequence = next
      next++
      data = listener.queued.get(next)
    }
  }
}

export const terminalBus = new TerminalBus()

/** Wire main-process events once at app start and return symmetric cleanup. */
export function initTerminalEvents(
  onExit: (sessionId: string, exitCode: number) => void,
  onTitle: (sessionId: string, title: string) => void
): () => void {
  const disposeData = window.donwells.on('terminal:data', ({ sessionId, data, sequence }) => {
    terminalBus.emitData(sessionId, data, sequence)
  })
  const disposeExit = window.donwells.on('terminal:exit', ({ sessionId, exitCode }) => onExit(sessionId, exitCode))
  const disposeTitle = window.donwells.on('terminal:title', ({ sessionId, title }) => onTitle(sessionId, title))
  return () => {
    disposeData()
    disposeExit()
    disposeTitle()
  }
}
