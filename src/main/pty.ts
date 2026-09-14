import { randomUUID } from 'node:crypto'
import * as pty from 'node-pty'
import type { AgentLiveness, AgentExecutable } from '@shared/agent-runtime'
import type { TerminalSession } from '@shared/types'
import type { ProcessIdentity, RuntimeIdentityAuthority } from '@shared/child-process/process-spec'
import { sanitizedProcessEnv } from '@shared/child-process/process-environment'
import { windowsSystem32Binary } from '@shared/child-process/windows-system-binary'
import { forceTerminatePosixProcessGroup } from '@shared/child-process/process-tree-termination'
import { AGENT_HOOK_ENV } from './agents/provider-hooks'

/** Exited interactive terminals are kept briefly for reattach/scrollback. */
export const REAP_EXITED_MS = 5 * 60_000
/** Jobs are never dropped before their persisted owner acknowledges the result. */
export const MAX_RETAINED_JOBS = 128
const PTY_CLOSE_TIMEOUT_MS = 5_000

export type PtyEvents = {
  data: (sessionId: string, data: string) => void
  exit: (sessionId: string, exitCode: number) => void
  title: (sessionId: string, title: string) => void
}

export type AgentPtyOptions = {
  launch?: AgentExecutable
  id: string
  env: NodeJS.ProcessEnv
}

type Session = {
  session: TerminalSession
  proc: pty.IPty
  kind: 'terminal' | 'job' | 'agent'
  /** ESC-encoded title updates from OSC 0/2 sequences */
  titleBuffer: string
  exit: Promise<number>
  resolveExit: (exitCode: number) => void
  exitCode?: number
  settled: boolean
  /** Stage 1 exact identity captured at spawn for finite daemon-owned jobs. */
  processIdentity: ProcessIdentity | null
}

const OSC_TITLE_RE = /\x1b\](?:0|2);([^\x07\x1b]*)(?:\x07|\x1b\\)/g

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  return Promise.withResolvers<T>()
}

/**
 * PTY session manager — one node-pty per terminal tab or finite shell job.
 * Sessions are keyed by uuid; the renderer holds no node access, only ids.
 */
export class PtyManager {
  private sessions = new Map<string, Session>()
  private retainedSessions = 0
  private events: PtyEvents
  private shellPath: string
  private jobShellPath: string
  private maxRetainedJobs: number
  private readonly identity: RuntimeIdentityAuthority | null

  constructor(
    events: PtyEvents,
    shellPath = process.platform === 'win32'
      ? process.env.ComSpec || windowsSystem32Binary('cmd.exe')
      : process.env.SHELL || '/bin/bash',
    maxRetainedJobs = MAX_RETAINED_JOBS,
    identity?: RuntimeIdentityAuthority
  ) {
    this.events = events
    this.shellPath = shellPath
    this.jobShellPath = process.platform === 'win32'
      ? process.env.ComSpec || windowsSystem32Binary('cmd.exe')
      : '/bin/sh'
    this.maxRetainedJobs = Number.isSafeInteger(maxRetainedJobs) && maxRetainedJobs > 0
      ? maxRetainedJobs
      : MAX_RETAINED_JOBS
    this.identity = identity ?? null
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  dimensions(sessionId: string): { cols: number; rows: number } | undefined {
    const proc = this.sessions.get(sessionId)?.proc
    return proc ? { cols: proc.cols, rows: proc.rows } : undefined
  }

  /** Process state known by this execution-host owner; unknown ids remain unverifiable. */
  liveness(sessionId: string): AgentLiveness {
    const session = this.sessions.get(sessionId)
    if (!session) return 'unverifiable'
    return session.session.exited ? 'exited' : 'live'
  }

  isRetained(sessionId: string): boolean {
    const kind = this.sessions.get(sessionId)?.kind
    return kind === 'job' || kind === 'agent'
  }

  list(): TerminalSession[] {
    return [...this.sessions.values()].map((s) => s.session)
  }

  open(cwd: string, cols: number, rows: number): TerminalSession {
    return this.spawn(cwd, cols, rows, [], { kind: 'terminal' })
  }

  /** Run one finite shell command in a daemon-owned PTY. */
  openJob(cwd: string, command: string, cols: number, rows: number): TerminalSession {
    return this.openFinite(cwd, command, cols, rows, 'job')
  }

  /** Run one finite agent command with a pre-bound id and scoped hook environment. */
  openAgent(
    cwd: string,
    command: string,
    cols: number,
    rows: number,
    options: AgentPtyOptions
  ): TerminalSession {
    return this.openFinite(cwd, command, cols, rows, 'agent', options)
  }

  private openFinite(
    cwd: string,
    command: string,
    cols: number,
    rows: number,
    kind: 'job' | 'agent',
    options?: AgentPtyOptions
  ): TerminalSession {
    if (this.retainedSessions >= this.maxRetainedJobs) {
      throw new Error(
        'terminal daemon job capacity reached; reconcile or cancel an existing command job before launching another'
      )
    }
    const args = options?.launch?.args ?? (process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command])
    const session = this.spawn(cwd, cols, rows, args, { kind, id: options?.id, env: options?.env, executable: options?.launch?.executable })
    this.retainedSessions++
    return session
  }

  private spawn(
    cwd: string,
    cols: number,
    rows: number,
    args: string[],
    options: { kind: Session['kind']; id?: string; env?: NodeJS.ProcessEnv; executable?: string }
  ): TerminalSession {
    const id = options.id ?? randomUUID()
    const env = sanitizedProcessEnv(process.env, {
      [AGENT_HOOK_ENV.socket]: undefined,
      [AGENT_HOOK_ENV.runId]: undefined,
      [AGENT_HOOK_ENV.sessionId]: undefined,
      [AGENT_HOOK_ENV.token]: undefined,
      ...(options.env ?? {}),
      TERM: 'xterm-256color',
      TERM_PROGRAM: 'donwells.ai',
      TERM_PROGRAM_VERSION: undefined,
      TERM_SESSION_ID: undefined
    })
    const executable = options.executable ?? (options.kind === 'terminal' ? this.shellPath : this.jobShellPath)
    const proc = pty.spawn(executable, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env
    })

    const session: TerminalSession = {
      id,
      worktreePath: cwd,
      title: this.shortName(cwd),
      createdAt: new Date().toISOString(),
      exited: false
    }
    const completion = deferred<number>()
    let processIdentity: ProcessIdentity | null = null
    if (this.identity !== null && options.kind === 'job') {
      // Finite task jobs bind runtime only as acp-agent today; the Stage 5
      // union expands the accepted families. No executable expectation: PTY
      // shells are commonly symlinked, and the observed path is recorded in
      // the identity itself.
      processIdentity = this.identity.capture(proc.pid, { family: 'acp-agent' })
    }
    this.sessions.set(id, {
      session,
      proc,
      kind: options.kind,
      titleBuffer: '',
      exit: completion.promise,
      resolveExit: completion.resolve,
      settled: false,
      processIdentity
    })

    proc.onData((data) => {
      this.scanTitle(id, data)
      this.events.data(id, data)
    })
    proc.onExit(({ exitCode: code, signal }) => {
      // POSIX signal exits can carry code 0; they are not successful completion.
      const exitCode = signal ? 128 + signal : code
      const current = this.sessions.get(id)
      if (!current || current.session.exited) return
      // node-pty#72: data can arrive after exit fires. Delay settlement so a
      // close acknowledgement and job result include all trailing output.
      current.session.exited = true
      current.exitCode = exitCode
      setTimeout(() => {
        const retained = this.sessions.get(id)
        if (!retained) return
        retained.settled = true
        this.events.exit(id, exitCode)
        retained.resolveExit(exitCode)
        if (retained.kind === 'terminal') {
          setTimeout(() => this.removeSession(id), REAP_EXITED_MS).unref()
        }
      }, 250)
    })

    return session
  }

  write(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.session.exited) return
    session.proc.write(data)
  }

  /** Write only to a currently live daemon-owned agent PTY. */
  writeAgent(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.kind !== 'agent') {
      throw new Error('unknown agent session: ' + sessionId)
    }
    if (session.session.exited || session.settled) {
      throw new Error('agent session has exited: ' + sessionId)
    }
    session.proc.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.session.exited) return
    try {
      session.proc.resize(Math.max(cols, 2), Math.max(rows, 2))
    } catch {
      /* process may be mid-exit */
    }
  }

  /** Stop the owned process, retaining its terminal until explicit dismissal. */
  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error('terminal ' + sessionId + ' exit is unverifiable because the daemon does not own the session')
    }
    if (!session.session.exited) {
      try {
        if (session.kind === 'agent' && process.platform !== 'win32') {
          // forkpty creates a private process group. Stop must include children, not just the TUI root.
          if (!await forceTerminatePosixProcessGroup(session.proc.pid)) {
            throw new Error('agent process group exit is unverifiable after cancellation')
          }
        } else session.proc.kill()
      } catch (error) {
        if (session.kind === 'agent' || !session.session.exited) throw error
      }
    }
    if (!session.settled) {
      const escalation = session.kind === 'agent' ? setTimeout(() => {
        if (this.sessions.get(sessionId) === session && !session.session.exited) {
          try { session.proc.kill('SIGKILL') } catch { /* Exit still requires the bounded node-pty acknowledgment below. */ }
        }
      }, 1000) : undefined
      const timeout = Promise.withResolvers<never>()
      const timer = setTimeout(() => timeout.reject(new Error(
        'terminal ' + sessionId + ' exit is unverifiable after cancellation'
      )), PTY_CLOSE_TIMEOUT_MS)
      try {
        await Promise.race([session.exit, timeout.promise])
      } finally {
        clearTimeout(escalation)
        clearTimeout(timer)
      }
    }
  }

  /** Kill a session and resolve only after node-pty confirms process exit. */
  async close(sessionId: string): Promise<void> {
    await this.stop(sessionId)
    this.removeSession(sessionId)
  }

  private removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || !this.sessions.delete(sessionId)) return
    if (session.kind !== 'terminal') this.retainedSessions--
  }

  jobResult(sessionId: string): { exited: boolean; exitCode?: number } {
    const session = this.sessions.get(sessionId)
    if (!session || session.kind !== 'job') throw new Error('unknown job: ' + sessionId)
    return { exited: session.settled, exitCode: session.settled ? session.exitCode : undefined }
  }

  /** Stage 1 exact identity captured at spawn; null for terminals and legacy callers. */
  processIdentity(sessionId: string): ProcessIdentity | null {
    return this.sessions.get(sessionId)?.processIdentity ?? null
  }

  dismissExited(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.kind !== 'agent') throw new Error('unknown agent session: ' + sessionId)
    if (!session.settled) throw new Error('agent session is still live and cannot be dismissed')
    this.removeSession(sessionId)
  }

  /** Send Ctrl-C (SIGINT in the PTY) to interrupt a foreground process. */
  interrupt(sessionId: string): void {
    this.write(sessionId, '\u0003')
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
    const session = this.sessions.get(id)
    if (!session) return
    session.titleBuffer += data
    // keep buffer bounded; titles arrive as small escape-encoded bursts
    if (session.titleBuffer.length > 4096) session.titleBuffer = session.titleBuffer.slice(-2048)
    OSC_TITLE_RE.lastIndex = 0
    let match: RegExpExecArray | null
    let last: string | null = null
    while ((match = OSC_TITLE_RE.exec(session.titleBuffer)) !== null) {
      last = match[1]
      if (OSC_TITLE_RE.lastIndex === match.index) OSC_TITLE_RE.lastIndex++
    }
    if (last?.trim()) {
      session.session.title = last.trim()
      this.events.title(id, session.session.title)
    }
    // drop fully-consumed title sequences from the buffer to bound growth
    const clean = session.titleBuffer.replace(OSC_TITLE_RE, '')
    if (clean.length < session.titleBuffer.length) session.titleBuffer = clean
  }
}
