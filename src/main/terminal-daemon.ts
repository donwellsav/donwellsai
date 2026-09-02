import { createServer, createConnection, type Server, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PtyManager } from './pty'
import type { TerminalSession } from '@shared/types'

/**
 * Terminal daemon (upstream orcad terminal-daemon model): a detached process
 * that OWNS the PTYs. The UI app is a client — quitting or crashing the app
 * never kills a running agent; a relaunch reattaches and replays scrollback.
 *
 * Wire: NDJSON over a unix socket (macOS/Linux).
 *   requests:  {id, authToken, op, ...params}
 *   responses: {id, ok:true, ...result} | {id, ok:false, error}
 *   events:    {event:'data'|'exit'|'title', sessionId, ...payload}
 * Handshake: first frame must be {op:'hello', authToken}; wrong token → close.
 *
 * Discovery: <userData>/terminal-runtime.json = {socketPath, authToken, pid}
 * written after bind; stale entries (dead pid) are replaced on next start.
 */

export const SCROLLBACK_MAX = 512 * 1024 // code-unit cap, matches upstream REPLAY_BUFFER_MAX scale

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

export class TerminalDaemon {
  private server: Server | null = null
  private pty: PtyManager
  private authToken: string
  private socketPath: string
  private runtimeFile: string
  /** per-session bounded scrollback for replay on reattach */
  private scrollback = new Map<string, string>()
  /** clients that completed the hello handshake and receive events */
  private clients = new Set<Socket>()

  constructor(opts: { socketPath: string; authToken: string; runtimeFile: string; shell?: string }) {
    this.socketPath = opts.socketPath
    this.authToken = opts.authToken
    this.runtimeFile = opts.runtimeFile
    this.pty = new PtyManager({
      data: (sessionId, data) => {
        this.appendScrollback(sessionId, data)
        this.broadcast({ event: 'data', sessionId, data })
      },
      exit: (sessionId, exitCode) => {
        // keep scrollback for a while (reattach shows the dead session's tail);
        // cleared when the session is closed explicitly
        this.broadcast({ event: 'exit', sessionId, exitCode })
      },
      title: (sessionId, title) => this.broadcast({ event: 'title', sessionId, title })
    }, opts.shell)
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (existsSync(this.socketPath)) rmSync(this.socketPath) // stale socket from a dead daemon
      this.server = createServer((socket) => this.handleClient(socket))
      this.server.on('error', reject)
      mkdirSync(dirname(this.socketPath), { recursive: true })
      this.server.listen(this.socketPath, () => {
        writeFileSync(
          this.runtimeFile,
          JSON.stringify({ socketPath: this.socketPath, authToken: this.authToken, pid: process.pid }, null, 2),
          'utf8'
        )
        resolve()
      })
    })
  }

  /** Stop accepting connections; PTYs are left alive (sessions owned by daemon). */
  stop(): void {
    for (const c of this.clients) c.destroy()
    this.clients.clear()
    this.server?.close()
    if (existsSync(this.runtimeFile)) rmSync(this.runtimeFile)
  }

  private broadcast(frame: Record<string, unknown>): void {
    const line = JSON.stringify(frame) + '\n'
    for (const c of this.clients) {
      if (!c.destroyed) c.write(line)
    }
  }

  private appendScrollback(sessionId: string, data: string): void {
    const cur = (this.scrollback.get(sessionId) ?? '') + data
    this.scrollback.set(sessionId, cur.length > SCROLLBACK_MAX ? cur.slice(cur.length - SCROLLBACK_MAX) : cur)
  }

  private handleClient(socket: Socket): void {
    let authed = false
    let buf = ''
    const pending = new Map<string, Pending>()

    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (!authed) {
          if (msg['op'] === 'hello' && msg['authToken'] === this.authToken) {
            authed = true
            this.clients.add(socket)
            socket.write(JSON.stringify({ id: msg['id'], ok: true }) + '\n')
          } else {
            socket.destroy()
          }
          continue
        }
        void this.handleOp(socket, msg, pending)
      }
    })

    socket.on('close', () => {
      this.clients.delete(socket)
      for (const [, p] of pending) p.reject(new Error('daemon client detached'))
      pending.clear()
    })
    socket.on('error', () => socket.destroy())
  }

  private async handleOp(socket: Socket, msg: Record<string, unknown>, pending: Map<string, Pending>): Promise<void> {
    const id = String(msg['id'] ?? '')
    const op = String(msg['op'] ?? '')
    const reply = (ok: boolean, result: Record<string, unknown>): void => {
      if (id) socket.write(JSON.stringify({ id, ok, ...result }) + '\n')
    }
    try {
      switch (op) {
        case 'session.open': {
          const session = this.pty.open(String(msg['cwd']), Number(msg['cols'] ?? 100), Number(msg['rows'] ?? 30))
          reply(true, { session })
          break
        }
        case 'session.write': {
          this.pty.write(String(msg['sessionId']), String(msg['data'] ?? ''))
          reply(true, {})
          break
        }
        case 'session.resize': {
          this.pty.resize(String(msg['sessionId']), Number(msg['cols'] ?? 100), Number(msg['rows'] ?? 30))
          reply(true, {})
          break
        }
        case 'session.interrupt': {
          this.pty.interrupt(String(msg['sessionId']))
          reply(true, {})
          break
        }
        case 'session.close': {
          const sid = String(msg['sessionId'])
          this.pty.close(sid)
          this.scrollback.delete(sid)
          reply(true, {})
          break
        }
        case 'session.list': {
          reply(true, { sessions: this.pty.list() })
          break
        }
        case 'session.attach': {
          const sid = String(msg['sessionId'])
          const sessions = this.pty.list()
          const session = sessions.find((s) => s.id === sid)
          if (!session) {
            reply(false, { error: `unknown session: ${sid}` })
            break
          }
          reply(true, { session, scrollback: this.scrollback.get(sid) ?? '' })
          break
        }
        case 'ping': {
          reply(true, { pong: Date.now() })
          break
        }
        default:
          reply(false, { error: `unknown op: ${op}` })
      }
    } catch (e) {
      reply(false, { error: e instanceof Error ? e.message : String(e) })
    }
    void pending
  }
}

/** Read the runtime discovery file; null when absent/unparseable. */
export function readTerminalRuntime(userDataDir: string): { socketPath: string; authToken: string; pid: number } | null {
  try {
    const parsed = JSON.parse(readFileSync(join(userDataDir, 'terminal-runtime.json'), 'utf8'))
    if (typeof parsed?.socketPath === 'string' && typeof parsed?.authToken === 'string') return parsed
    return null
  } catch {
    return null
  }
}

export function newAuthToken(): string {
  return randomUUID() + randomUUID().slice(0, 8)
}