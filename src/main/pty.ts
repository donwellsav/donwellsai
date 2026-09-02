import { randomUUID } from 'node:crypto'
import * as pty from 'node-pty'
import type { TerminalSession } from '@shared/types'

export type PtyEvents = {
  data: (sessionId: string, data: string) => void
  exit: (sessionId: string, exitCode: number) => void
  title: (sessionId: string, title: string) => void
}

type Session = {
  session: TerminalSession
  proc: pty.IPty
  /** ESC-encoded title updates from OSC 0/2 sequences */
  titleBuffer: string
}

const OSC_TITLE_RE = /\x1b\](?:0|2);([^\x07\x1b]*)(?:\x07|\x1b\\)/g

/**
 * PTY session manager — one node-pty per terminal tab.
 * Sessions are keyed by uuid; the renderer holds no node access, only ids.
 */
export class PtyManager {
  private sessions = new Map<string, Session>()
  private events: PtyEvents
  private shellPath: string

  constructor(events: PtyEvents, shellPath = process.env.SHELL || '/bin/bash') {
    this.events = events
    this.shellPath = shellPath
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  list(): TerminalSession[] {
    return [...this.sessions.values()].map((s) => s.session)
  }

  open(cwd: string, cols: number, rows: number): TerminalSession {
    const id = randomUUID()
    const proc = pty.spawn(this.shellPath, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' }
    })

    const session: TerminalSession = {
      id,
      worktreePath: cwd,
      title: this.shortName(cwd),
      createdAt: new Date().toISOString(),
      exited: false
    }
    this.sessions.set(id, { session, proc, titleBuffer: '' })

    proc.onData((data) => {
      this.scanTitle(id, data)
      this.events.data(id, data)
    })
    proc.onExit(({ exitCode }) => {
      const s = this.sessions.get(id)
      if (!s) return
      s.session.exited = true
      this.events.exit(id, exitCode)
    })

    return session
  }

  write(sessionId: string, data: string): void {
    const s = this.sessions.get(sessionId)
    if (!s || s.session.exited) return
    s.proc.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const s = this.sessions.get(sessionId)
    if (!s || s.session.exited) return
    try {
      s.proc.resize(Math.max(cols, 2), Math.max(rows, 2))
    } catch {
      /* process may be mid-exit */
    }
  }

  close(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    try {
      s.proc.kill()
    } catch {
      /* already dead */
    }
    this.sessions.delete(sessionId)
  }

  writeCommand(sessionId: string, command: string): void {
    this.write(sessionId, command.endsWith('\n') ? command : `${command}\n`)
  }

  private shortName(cwd: string): string {
    const parts = cwd.split(/[\\/]/).filter(Boolean)
    return parts[parts.length - 1] || cwd
  }

  /** Strip OSC title sequences from a data chunk and surface the freshest title. */
  private scanTitle(id: string, data: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    s.titleBuffer += data
    // keep buffer bounded; titles arrive as small escape-encoded bursts
    if (s.titleBuffer.length > 4096) s.titleBuffer = s.titleBuffer.slice(-2048)
    OSC_TITLE_RE.lastIndex = 0
    let m: RegExpExecArray | null
    let last: string | null = null
    while ((m = OSC_TITLE_RE.exec(s.titleBuffer)) !== null) {
      last = m[1]
      if (OSC_TITLE_RE.lastIndex === m.index) OSC_TITLE_RE.lastIndex++
    }
    if (last && last.trim()) {
      s.session.title = last.trim()
      this.events.title(id, s.session.title)
    }
    // drop fully-consumed title sequences from the buffer to bound growth
    const clean = s.titleBuffer.replace(OSC_TITLE_RE, '')
    if (clean.length < s.titleBuffer.length) s.titleBuffer = clean
  }
}