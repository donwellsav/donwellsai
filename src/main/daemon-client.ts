import { spawn } from 'node:child_process'
import { createConnection, type Socket } from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { TerminalSession } from '@shared/types'

/**
 * App-side client for the terminal daemon. Owns the transport; the renderer
 * never knows a daemon exists (same IPC surface as before).
 *
 * Lifecycle:
 * - connect() → read terminal-runtime.json → try socket; on failure spawn a
 *   detached daemon (survives app exit) and retry.
 * - attach(sessionId) → replay scrollback snapshot before live data flows.
 * - The daemon is NEVER killed by the app (orcad rule: DisconnectDaemon, never
 *   ShutdownDaemon). Sessions survive app restarts by design.
 */

export type DaemonEvents = {
  data: (sessionId: string, data: string) => void
  exit: (sessionId: string, exitCode: number) => void
  title: (sessionId: string, title: string) => void
  /** Agent hook envelope: ESC]777;donwells:<state>=<detail> stripped from the stream. */
  hook: (sessionId: string, state: string, detail: string) => void
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }
export class DaemonClient {
  private socket: Socket | null = null
  private pending = new Map<string, Pending>()
  private buf = ''
  private connecting: Promise<void> | null = null
  /** scrollback not yet delivered to the renderer (pre-attach replay) */
  private replayQueue: Array<{ sessionId: string; data: string }> = []

  constructor(
    private userDataDir: string,
    private events: DaemonEvents,
    private daemonEntryPath: string
  ) {}

  async connect(): Promise<void> {
    if (this.socket) return
    if (this.connecting) return this.connecting
    this.connecting = this.connectInner().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private async connectInner(): Promise<void> {
    // 1. try existing daemon via discovery file
    const rt = this.readRuntime()
    if (rt && existsSync(rt.socketPath)) {
      const ok = await this.tryConnect(rt.socketPath, rt.authToken).catch(() => false)
      if (ok) return
    }
    // 2. spawn detached daemon and connect
    const token = randomUUID() + randomUUID().slice(0, 8)
    const child = spawn(process.execPath, [this.daemonEntryPath, this.userDataDir], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ORCA_LITE_DAEMON_TOKEN: token, ELECTRON_RUN_AS_NODE: '1' }
    })
    child.unref()
    // Wait for OUR daemon: the old socket file may still exist (stale), so poll
    // tryConnect with the fresh token until the new daemon binds, not existsSync.
    const socketPath = join(this.userDataDir, 'terminal.sock')
    const deadline = Date.now() + 10_000
    let ok = false
    while (Date.now() <= deadline) {
      ok = await this.tryConnect(socketPath, token).catch(() => false)
      if (ok) break
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!ok) throw new Error('terminal daemon connection failed')
  }

  private readRuntime(): { socketPath: string; authToken: string; pid: number } | null {
    try {
      const parsed = JSON.parse(readFileSync(join(this.userDataDir, 'terminal-runtime.json'), 'utf8'))
      if (typeof parsed?.socketPath === 'string' && typeof parsed?.authToken === 'string') return parsed
      return null
    } catch {
      return null
    }
  }

  private tryConnect(socketPath: string, authToken: string): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = createConnection(socketPath, () => {
        this.rawSend(socket, { id: randomUUID(), op: 'hello', authToken })
        // hello reply handled in onData
        socket.once('data', (chunk: Buffer) => {
          if (chunk.toString('utf8').includes('"ok":true')) {
            this.socket = socket
            this.wireSocket(socket)
            resolve(true)
          } else {
            socket.destroy()
            resolve(false)
          }
        })
      })
      socket.on('error', () => resolve(false))
    })
  }

  private wireSocket(socket: Socket): void {
    socket.on('data', (chunk) => {
      this.buf += chunk.toString('utf8')
      let nl: number
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, nl)
        this.buf = this.buf.slice(nl + 1)
        if (!line.trim()) continue
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg['event']) {
          this.dispatchEvent(msg)
          continue
        }
        const p = this.pending.get(String(msg['id']))
        if (p) {
          this.pending.delete(String(msg['id']))
          if (msg['ok'] === true) p.resolve(msg)
          else p.reject(new Error(String(msg['error'] ?? 'daemon error')))
        }
      }
    })
    socket.on('error', () => {
      this.socket = null
    })
    socket.on('close', () => {
      this.socket = null
    })
  }

  private dispatchEvent(msg: Record<string, unknown>): void {
    const sessionId = String(msg['sessionId'] ?? '')
    const ev = String(msg['event'])
    if (ev === 'data') {
      this.events.data(sessionId, String(msg['data'] ?? ''))
    } else if (ev === 'exit') {
      this.events.exit(sessionId, Number(msg['exitCode'] ?? 0))
    } else if (ev === 'title') {
      this.events.title(sessionId, String(msg['title'] ?? ''))
    } else if (ev === 'hook') {
      this.events.hook(sessionId, String(msg['state'] ?? ''), String(msg['detail'] ?? ''))
    }
  }

  private rawSend(socket: Socket, msg: Record<string, unknown>): void {
    socket.write(JSON.stringify(msg) + '\n')
  }

  private async request<T = Record<string, unknown>>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.connect()
    const socket = this.socket
    if (!socket) throw new Error('daemon not connected')
    const id = randomUUID()
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.rawSend(socket, { id, op, ...params })
    })
  }

  async open(cwd: string, cols = 100, rows = 30): Promise<TerminalSession> {
    const r = await this.request<{ session: TerminalSession }>('session.open', { cwd, cols, rows })
    return r.session
  }

  async attach(sessionId: string): Promise<{ session: TerminalSession; scrollback: string }> {
    const r = await this.request<{ session: TerminalSession; scrollback: string }>('session.attach', { sessionId })
    return { session: r.session, scrollback: r.scrollback ?? '' }
  }

  write(sessionId: string, data: string): void {
    void this.request('session.write', { sessionId, data }).catch(() => {})
  }

  resize(sessionId: string, cols: number, rows: number): void {
    void this.request('session.resize', { sessionId, cols, rows }).catch(() => {})
  }

  interrupt(sessionId: string): void {
    void this.request('session.interrupt', { sessionId }).catch(() => {})
  }

  async close(sessionId: string): Promise<void> {
    await this.request('session.close', { sessionId }).catch(() => {})
  }

  async list(): Promise<TerminalSession[]> {
    const r = await this.request<{ sessions: TerminalSession[] }>('session.list')
    return r.sessions
  }

  /** Check the daemon is reachable (used on startup to reattach sessions). */
  async ping(): Promise<boolean> {
    try {
      await this.request('ping')
      return true
    } catch {
      return false
    }
  }
}