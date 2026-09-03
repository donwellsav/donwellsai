import type { MainEvents } from '@shared/types'

type PayloadOf<K extends keyof MainEvents> = MainEvents[K]

type Listener<T> = (payload: T) => void

const MAX_BUFFER = 512 * 1024 // tail of output kept per session when no pane is mounted

/**
 * Out-of-React data bus for high-frequency terminal output.
 * PTY data must never flow through React state — that is the freezer of terminal UIs.
 * Each TerminalPane subscribes to its sessionId and writes straight to xterm.
 *
 * Buffering: output sent while no pane is mounted (tab hidden, worktree card
 * unmounted) is replayed on subscribe. This is what keeps a session's scrollback
 * coherent across UI navigation — Orca calls this the permanently-mounted workbench.
 */
class TerminalBus {
  private dataListeners = new Map<string, Set<Listener<string>>>()
  private buffers = new Map<string, string[]>()

  subscribe(sessionId: string, cb: Listener<string>): () => void {
    let set = this.dataListeners.get(sessionId)
    if (!set) {
      set = new Set()
      this.dataListeners.set(sessionId, set)
    }
    set.add(cb)
    // replay buffered output so a freshly mounted pane shows prior output
    const buf = this.buffers.get(sessionId)
    if (buf) for (const chunk of buf) cb(chunk)
    return () => {
      set!.delete(cb)
      if (set!.size === 0) this.dataListeners.delete(sessionId)
    }
  }

  emitData(sessionId: string, data: string): void {
    const listeners = this.dataListeners.get(sessionId)
    // keep a listener-side buffer, GC session buffers once listeners are gone
    let buf = this.buffers.get(sessionId)
    if (!buf) {
      buf = []
      this.buffers.set(sessionId, buf)
    }
    buf.push(data)
    let len = 0
    for (const c of buf) len += c.length
    while (len > MAX_BUFFER && buf.length > 1) {
      const removed = buf.shift()!
      len -= removed.length
    }
    listeners?.forEach((cb) => cb(data))
  }

  dropSession(sessionId: string): void {
    this.dataListeners.delete(sessionId)
    this.buffers.delete(sessionId)
  }
}

export const terminalBus = new TerminalBus()

/** Wire main-process events once at app start. */
export function initTerminalEvents(
  onExit: (sessionId: string, exitCode: number) => void,
  onTitle: (sessionId: string, title: string) => void,
  onHook: (sessionId: string, state: string, detail: string) => void
): void {
  window.orca.on('terminal:data', ({ sessionId, data }) => terminalBus.emitData(sessionId, data))
  window.orca.on('terminal:exit', ({ sessionId, exitCode }) => onExit(sessionId, exitCode))
  window.orca.on('terminal:title', ({ sessionId, title }) => onTitle(sessionId, title))
  window.orca.on('terminal:hook', ({ sessionId, state, detail }) => onHook(sessionId, state, detail))
}

export type { MainEvents }