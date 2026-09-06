import { parseAgentExecutable } from '@shared/agent-runtime'
import { createConnection, type Socket } from 'node:net'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type {
  AgentProviderId,
  AgentExecutable,
  AgentStartResult,
  RunningAgent
} from '@shared/agent-runtime'
import {
  ATTENTION_INBOX_CAPABILITY,
  parseAttentionAcknowledgeRequest,
  parseAttentionInboxSnapshot,
  type AttentionAcknowledgeRequest,
  type AttentionAcknowledgeResult,
  type AttentionInboxListResult
} from '@shared/attention-inbox'
import type { TerminalSession } from '@shared/types'
import { probeLocalProcessLiveness } from '@shared/child-process/execution-host'
import { sanitizedProcessEnv } from '@shared/child-process/process-environment'
import { spawnProcess } from '@shared/child-process/run-process'
import { readTerminalRuntime, localRuntimePaths } from './local-runtime'

/** App-side transport for the detached terminal daemon. */

export type DaemonEvents = {
  data: (sessionId: string, data: string, sequence?: number) => void
  exit: (sessionId: string, exitCode: number) => void
  title: (sessionId: string, title: string) => void
  agent: (run: RunningAgent) => void
  agentDismissed: (sessionId: string) => void
}

export type DaemonClientOptions = {
  requestTimeoutMs?: number
  handshakeTimeoutMs?: number
}

export type DaemonJobResult = {
  exited: boolean
  exitCode?: number
  output: string
  sequence: number
}

export type DaemonStatus = {
  pid: number
  idle: boolean
  sessionCount: number
  liveSessionCount: number
}

type Pending = {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

type Handshake = {
  ok?: boolean
  id?: unknown
  capabilities?: unknown
}


const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 1_000
const SEQUENCED_OUTPUT = 'sequenced-output'
const ONESHOT_JOBS = 'oneshot-jobs'
const AGENT_RUNS = 'agent-runs-v1'
const AGENT_INPUT = 'agent-input-v1'
const MAX_TRANSPORT_BUFFER_BYTES = 2 * 1024 * 1024

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
} {
  return Promise.withResolvers<T>()
}

function delay(ms: number): Promise<void> {
  const result = Promise.withResolvers<void>()
  setTimeout(result.resolve, ms)
  return result.promise
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRunningAgent(value: unknown): value is RunningAgent {
  if (!isRecord(value) || !isRecord(value['hook']) || !Array.isArray(value['hook']['events'])) return false
  const activity = value['activity']
  const liveness = value['liveness']
  const support = value['hook']['support']
  return typeof value['id'] === 'string'
    && typeof value['sessionId'] === 'string'
    && typeof value['workspacePath'] === 'string'
    && typeof value['command'] === 'string'
    && typeof value['startedAt'] === 'string'
    && typeof value['updatedAt'] === 'string'
    && (liveness === 'live' || liveness === 'unverifiable' || liveness === 'exited')
    && (activity === 'starting' || activity === 'working' || activity === 'waiting'
      || activity === 'permission' || activity === 'stopping' || activity === 'completed' || activity === 'failed')
    && (support === 'native' || support === 'unavailable')
    && typeof value['hook']['connected'] === 'boolean'
    && value['hook']['events'].every((event) => (
      event === 'working' || event === 'waiting' || event === 'permission'
      || event === 'completed' || event === 'failed'
    ))
}

function requireRunningAgent(value: unknown): RunningAgent {
  if (!isRunningAgent(value)) throw new Error('terminal daemon returned an invalid agent record')
  return { ...structuredClone(value), ...(value.launch === undefined ? {} : { launch: parseAgentExecutable(value.launch) }) }
}

export class DaemonClient {
  private socket: Socket | null = null
  private pending = new Map<string, Pending>()
  private buffer = ''
  private connecting: Promise<void> | null = null
  private capabilities = new Set<string>()
  private readonly requestTimeoutMs: number
  private readonly handshakeTimeoutMs: number

  constructor(
    private userDataDir: string,
    private events: DaemonEvents,
    private daemonEntryPath: string,
    options: DaemonClientOptions = {}
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
  }

  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return
    if (this.connecting) return this.connecting
    this.connecting = this.connectInner().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private async connectInner(): Promise<void> {
    // Authenticate the recorded daemon before considering a launch. A missing
    // socket is only transport loss while its owner is live or unverifiable.
    const runtime = readTerminalRuntime(this.userDataDir)
    if (runtime) {
      const connected = await this.tryConnect(runtime.socketPath, runtime.authToken).catch(() => false)
      if (connected) return
      const liveness = runtime.pid === undefined
        ? 'unverifiable'
        : probeLocalProcessLiveness(runtime.pid)
      if (liveness !== 'exited') {
        throw new Error(
          'existing terminal daemon is ' + liveness + ' after contact was lost; it was not replaced'
        )
      }
    } else {
      const paths = localRuntimePaths(this.userDataDir, 'terminal')
      if (process.platform !== 'win32' && existsSync(paths.socketPath)) {
        throw new Error('terminal daemon socket ownership is unverifiable; it was not replaced')
      }
    }

    const token = randomUUID() + randomUUID().slice(0, 8)
    const child = spawnProcess({
      program: process.execPath,
      args: [this.daemonEntryPath, this.userDataDir],
      detached: true,
      stdio: 'ignore',
      env: sanitizedProcessEnv(process.env, {
        DONWELLS_DAEMON_TOKEN: token,
        ELECTRON_RUN_AS_NODE: '1'
      })
    })
    const spawned = Promise.withResolvers<void>()
    const onSpawn = (): void => {
      child.removeListener('error', onError)
      spawned.resolve()
    }
    const onError = (error: Error): void => {
      child.removeListener('spawn', onSpawn)
      spawned.reject(new Error('terminal daemon spawn failed: ' + error.message, { cause: error }))
    }
    child.once('spawn', onSpawn)
    child.once('error', onError)
    await spawned.promise
    child.unref()

    const { socketPath } = localRuntimePaths(this.userDataDir, 'terminal')
    const deadline = Date.now() + 10_000
    while (Date.now() <= deadline) {
      if (await this.tryConnect(socketPath, token).catch(() => false)) return
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          'terminal daemon exited during startup (code=' + (child.exitCode ?? 'null') +
          ', signal=' + (child.signalCode ?? 'null') + ')'
        )
      }
      await delay(100)
    }
    throw new Error('terminal daemon connection timed out after 10000ms')
  }

  private tryConnect(socketPath: string, authToken: string): Promise<boolean> {
    const completion = deferred<boolean>()
    const socket = createConnection(socketPath)
    const helloId = randomUUID()
    const decoder = new StringDecoder('utf8')
    let buffer = ''
    let settled = false

    const finish = (connected: boolean, handshake?: Handshake): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeListener('connect', onConnect)
      socket.removeListener('data', onData)
      socket.removeListener('error', onFailure)
      socket.removeListener('close', onFailure)

      if (!connected) {
        socket.destroy()
        completion.resolve(false)
        return
      }

      const capabilities = Array.isArray(handshake?.capabilities)
        ? handshake.capabilities.filter((value): value is string => typeof value === 'string')
        : []
      this.capabilities = new Set(capabilities)
      this.socket = socket
      this.wireSocket(socket, buffer, decoder)
      completion.resolve(true)
    }
    const onConnect = (): void => {
      this.rawSend(socket, { id: helloId, op: 'hello', authToken })
    }
    const onFailure = (): void => finish(false)
    const onData = (chunk: Buffer): void => {
      buffer += decoder.write(chunk)
      if (Buffer.byteLength(buffer) > MAX_TRANSPORT_BUFFER_BYTES) {
        finish(false)
        return
      }
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue

        let message: Handshake
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (String(message.id ?? '') !== helloId) continue
        finish(message.ok === true, message)
        return
      }
    }
    const timer = setTimeout(() => finish(false), this.handshakeTimeoutMs)

    socket.once('connect', onConnect)
    socket.on('data', onData)
    socket.once('error', onFailure)
    socket.once('close', onFailure)
    return completion.promise
  }

  private wireSocket(socket: Socket, initialBuffer: string, decoder: StringDecoder): void {
    this.buffer = initialBuffer
    const onData = (chunk: Buffer): void => {
      this.buffer += decoder.write(chunk)
      if (Buffer.byteLength(this.buffer) > MAX_TRANSPORT_BUFFER_BYTES) {
        this.resetTransport(socket, new Error('terminal daemon transport frame exceeded limit'))
        socket.destroy()
        return
      }
      this.drainFrames()
    }
    const onError = (error: Error): void => {
      this.resetTransport(socket, new Error(`terminal daemon transport error: ${error.message}`))
    }
    const onClose = (): void => {
      decoder.end()
      this.resetTransport(socket, new Error('terminal daemon transport closed'))
    }
    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
    this.drainFrames()
  }

  private drainFrames(): void {
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (!line.trim()) continue

      let message: Record<string, unknown>
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message['event']) {
        this.dispatchEvent(message)
        continue
      }
      const id = String(message['id'] ?? '')
      const pending = this.pending.get(id)
      if (!pending) continue
      clearTimeout(pending.timer)
      this.pending.delete(id)
      if (message['ok'] === true) pending.resolve(message)
      else pending.reject(new Error(String(message['error'] ?? 'daemon error')))
    }
  }

  private resetTransport(socket: Socket, error: Error): void {
    if (this.socket !== socket) return
    this.socket = null
    this.buffer = ''
    this.capabilities.clear()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private dispatchEvent(message: Record<string, unknown>): void {
    const sessionId = String(message['sessionId'] ?? '')
    const event = String(message['event'])
    if (event === 'data') {
      const rawSequence = message['sequence']
      const sequence = typeof rawSequence === 'number' && Number.isSafeInteger(rawSequence) ? rawSequence : undefined
      this.events.data(sessionId, String(message['data'] ?? ''), sequence)
    } else if (event === 'exit') {
      this.events.exit(sessionId, Number(message['exitCode'] ?? 0))
    } else if (event === 'title') {
      this.events.title(sessionId, String(message['title'] ?? ''))
    } else if (event === 'agent' && isRunningAgent(message['run'])) {
      this.events.agent(structuredClone(message['run']))
    } else if (event === 'agent-dismissed') {
      this.events.agentDismissed(sessionId)
    }
  }

  private rawSend(socket: Socket, message: Record<string, unknown>): void {
    socket.write(`${JSON.stringify(message)}\n`)
  }

  private async requireCapability(capability: string, operation: string): Promise<void> {
    await this.connect()
    if (this.capabilities.has(capability)) return
    throw new Error(
      `terminal daemon upgrade required for ${operation}; existing daemon and its sessions were left running`
    )
  }

  private async request<T = Record<string, unknown>>(
    operation: string,
    params: Record<string, unknown> = {}
  ): Promise<T> {
    await this.connect()
    const socket = this.socket
    if (!socket || socket.destroyed) throw new Error('terminal daemon not connected')
    const id = randomUUID()
    const completion = deferred<T>()
    const timer = setTimeout(() => {
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      pending.reject(new Error(`terminal daemon request timed out: ${operation}`))
    }, this.requestTimeoutMs)
    this.pending.set(id, {
      resolve: completion.resolve,
      reject: completion.reject,
      timer
    })
    try {
      this.rawSend(socket, { id, op: operation, ...params })
    } catch (error) {
      clearTimeout(timer)
      this.pending.delete(id)
      completion.reject(error instanceof Error ? error : new Error(String(error)))
    }
    return completion.promise
  }

  async open(cwd: string, cols = 100, rows = 30): Promise<TerminalSession> {
    await this.requireCapability(SEQUENCED_OUTPUT, 'opening a terminal')
    const response = await this.request<{ session: TerminalSession }>('session.open', { cwd, cols, rows })
    return response.session
  }

  /** Start a finite shell command owned by the daemon, not by the app process. */
  async openJob(cwd: string, command: string, cols = 100, rows = 30): Promise<TerminalSession> {
    await this.requireCapability(ONESHOT_JOBS, 'running a command job')
    await this.requireCapability(SEQUENCED_OUTPUT, 'running a command job')
    const response = await this.request<{ session: TerminalSession }>('job.open', { cwd, command, cols, rows })
    return response.session
  }

  async startAgent(
    cwd: string,
    command: string,
    providerId?: AgentProviderId,
    launch?: AgentExecutable,
    cols = 100,
    rows = 30
  ): Promise<AgentStartResult> {
    if (launch) await this.requireCapability('agent-argv-v1', 'starting an agent with explicit arguments')
    await this.requireCapability(AGENT_RUNS, 'starting an agent run')
    await this.requireCapability(SEQUENCED_OUTPUT, 'starting an agent run')
    const response = await this.request<{ run: unknown; session: TerminalSession }>('agent.open', {
      cwd,
      command,
      ...(providerId ? { providerId } : {}),
      ...(launch ? { launch } : {}),
      cols,
      rows
    })
    return { run: requireRunningAgent(response.run), session: response.session }
  }

  async listAgents(): Promise<RunningAgent[]> {
    await this.requireCapability(AGENT_RUNS, 'listing agent runs')
    const response = await this.request<{ runs: unknown }>('agent.list')
    if (!Array.isArray(response.runs)) throw new Error('terminal daemon returned an invalid agent list')
    return response.runs.map(requireRunningAgent)
  }
  /** Optional capability: an older detached daemon remains authoritative and untouched. */
  async attentionInboxList(): Promise<AttentionInboxListResult> {
    await this.connect()
    if (!this.capabilities.has(ATTENTION_INBOX_CAPABILITY)) {
      return { available: false, reason: 'daemon-upgrade-required' }
    }
    const response = await this.request<{ snapshot: unknown }>('attention.list')
    return { available: true, snapshot: parseAttentionInboxSnapshot(response.snapshot) }
  }

  /** Acknowledges one immutable event/version; it never clears a whole session implicitly. */
  async attentionInboxAcknowledge(value: AttentionAcknowledgeRequest): Promise<AttentionAcknowledgeResult> {
    const request = parseAttentionAcknowledgeRequest(value)
    await this.connect()
    if (!this.capabilities.has(ATTENTION_INBOX_CAPABILITY)) {
      return { available: false, reason: 'daemon-upgrade-required' }
    }
    const response = await this.request<{ outcome: unknown; snapshot: unknown }>('attention.ack', request)
    const outcome = response.outcome
    if (outcome !== 'acknowledged' && outcome !== 'already-acknowledged'
      && outcome !== 'not-found' && outcome !== 'version-mismatch') {
      throw new Error('terminal daemon returned an invalid attention acknowledgement outcome')
    }
    return {
      available: true,
      outcome,
      snapshot: parseAttentionInboxSnapshot(response.snapshot)
    }
  }

  async agentStatus(sessionId: string): Promise<RunningAgent> {
    await this.requireCapability(AGENT_RUNS, 'inspecting an agent run')
    const response = await this.request<{ run: unknown }>('agent.get', { sessionId })
    return requireRunningAgent(response.run)
  }

  /** Write exact caller-supplied bytes to one admitted daemon-owned agent PTY. */
  async writeAgent(sessionId: string, data: string): Promise<void> {
    await this.requireCapability(AGENT_INPUT, 'writing to an agent run')
    await this.request('agent.write', { sessionId, data })
  }

  async interruptAgent(sessionId: string): Promise<RunningAgent> {
    await this.requireCapability(AGENT_RUNS, 'interrupting an agent run')
    const response = await this.request<{ run: unknown }>('agent.interrupt', { sessionId })
    return requireRunningAgent(response.run)
  }

  async stopAgent(sessionId: string): Promise<RunningAgent> {
    await this.requireCapability('agent-stop-v1', 'stopping an agent process')
    const response = await this.request<{ run: unknown }>('agent.stop', { sessionId })
    return requireRunningAgent(response.run)
  }

  async dismissAgent(sessionId: string): Promise<void> {
    await this.requireCapability(AGENT_RUNS, 'dismissing an agent run')
    await this.request('agent.dismiss', { sessionId })
  }

  /** Inspect a retained job without inferring state from transport lifecycle. */
  async jobResult(sessionId: string): Promise<DaemonJobResult> {
    await this.requireCapability(ONESHOT_JOBS, 'inspecting a command job')
    return this.request<DaemonJobResult>('job.result', { sessionId })
  }

  async attach(sessionId: string): Promise<{ session: TerminalSession; scrollback: string; sequence: number }> {
    await this.requireCapability(SEQUENCED_OUTPUT, 'reattaching a terminal')
    const response = await this.request<{
      session: TerminalSession
      scrollback: string
      sequence: number
    }>('session.attach', { sessionId })
    if (!Number.isSafeInteger(response.sequence) || response.sequence < 0) {
      throw new Error('terminal daemon returned an invalid sequenced snapshot')
    }
    return {
      session: response.session,
      scrollback: response.scrollback ?? '',
      sequence: response.sequence
    }
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

  /** Resolve only after the daemon confirms the owned PTY has exited. */
  async close(sessionId: string): Promise<void> {
    await this.request('session.close', { sessionId })
  }

  async list(): Promise<TerminalSession[]> {
    const response = await this.request<{ sessions: TerminalSession[] }>('session.list')
    return response.sessions
  }

  /** Check only transport reachability; never equate disconnect with process exit. */
  async ping(): Promise<boolean> {
    try {
      await this.request('ping')
      return true
    } catch {
      return false
    }
  }

  async status(): Promise<DaemonStatus> {
    await this.requireCapability('daemon-status', 'inspecting daemon ownership')
    return this.request<DaemonStatus>('daemon.status')
  }

  /** Stops only this authenticated daemon and only after it proves it owns no sessions. */
  async shutdownIfIdle(): Promise<boolean> {
    await this.requireCapability('idle-shutdown', 'isolated daemon cleanup')
    const status = await this.status()
    if (!status.idle || status.sessionCount !== 0 || status.liveSessionCount !== 0) return false
    const response = await this.request<{ stopped: boolean }>('daemon.shutdown')
    return response.stopped === true
  }

  disconnect(): void {
    const socket = this.socket
    if (!socket) return
    this.socket = null
    socket.destroy()
  }
}
