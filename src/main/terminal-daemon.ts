import { randomUUID, timingSafeEqual } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  AGENT_PROVIDER_DEFINITIONS,
  agentProviderForCommand,
  normalizeAgentHookMessage,
  type AgentProviderId,
  type RunningAgent
} from '@shared/agent-runtime'
import {
  ATTENTION_INBOX_CAPABILITY,
  parseAttentionAcknowledgeRequest
} from '@shared/attention-inbox'
import { probeLocalProcessLiveness } from '@shared/child-process/execution-host'
import type { TerminalSession } from '@shared/types'
import { AttentionInboxService } from './attention-inbox-service'
import { AttentionInboxStore } from './attention-inbox-store'
import { PtyManager, REAP_EXITED_MS } from './pty'
import {
  createAgentLaunchPlan,
  type AgentHookBinding,
  type AgentLaunchPlan
} from './agents/provider-hooks'
import { localRuntimePaths, readTerminalRuntime, type LocalRuntimePaths } from './local-runtime'

export const SCROLLBACK_MAX = 512 * 1024
export const DAEMON_PROTOCOL_VERSION = 3
export const DAEMON_CAPABILITIES = [
  'sequenced-output',
  'oneshot-jobs',
  'daemon-status',
  'idle-shutdown',
  'agent-runs-v1',
  'agent-hooks-v1',
  'agent-input-v1',
  ATTENTION_INBOX_CAPABILITY
] as const
const MAX_FRAME_BYTES = 1024 * 1024
const MAX_AGENT_COMMAND_BYTES = 16 * 1024
const MAX_HOOK_EVENTS_PER_MINUTE = 120

type AgentRecord = {
  run: RunningAgent
  hookToken?: string
  hookWindowStartedAt: number
  hookWindowCount: number
  launchPlan: AgentLaunchPlan
}

type HookClientBinding = {
  record: AgentRecord
  token: string
}

export function newAuthToken(): string {
  return randomUUID() + randomUUID().slice(0, 8)
}

function sameToken(actual: string | undefined, supplied: unknown): boolean {
  if (!actual || typeof supplied !== 'string') return false
  const actualBytes = Buffer.from(actual)
  const suppliedBytes = Buffer.from(supplied)
  return actualBytes.byteLength === suppliedBytes.byteLength && timingSafeEqual(actualBytes, suppliedBytes)
}

function cloneRun(run: RunningAgent): RunningAgent {
  return structuredClone(run)
}

/** Detached local execution owner. Client disconnect is never process-exit evidence. */
export class TerminalDaemon {
  private server: Server | null = null
  private readonly pty: PtyManager
  private readonly attention: AttentionInboxService
  private readonly authToken: string
  private readonly paths: LocalRuntimePaths
  private readonly emitterCommand: readonly string[]
  private readonly scrollback = new Map<string, string>()
  private readonly sequence = new Map<string, number>()
  private readonly clients = new Set<Socket>()
  private readonly connections = new Set<Socket>()
  private readonly agentsBySession = new Map<string, AgentRecord>()
  private readonly agentsByRun = new Map<string, AgentRecord>()
  constructor(opts: {
    userDataDir: string
    authToken: string
    shell?: string
    emitterCommand?: readonly string[]
  }) {
    this.authToken = opts.authToken
    this.paths = localRuntimePaths(opts.userDataDir, 'terminal')
    this.emitterCommand = opts.emitterCommand ?? [
      process.execPath,
      process.argv[1] ?? '',
      '--emit-agent-hook'
    ]
    this.pty = new PtyManager(
      {
        data: (sessionId, data) => this.handlePtyData(sessionId, data),
        exit: (sessionId, exitCode) => this.handlePtyExit(sessionId, exitCode),
        title: (sessionId, title) => this.broadcast({ event: 'title', sessionId, title })
      },
      opts.shell
    )
    this.attention = new AttentionInboxService(new AttentionInboxStore(opts.userDataDir), {
      resolveContact: (sessionId) => ({
        currentLiveness: this.agentsBySession.get(sessionId)?.run.liveness ?? 'unknown',
        terminalAvailability: this.pty.has(sessionId) ? 'retained' : 'unavailable'
      })
    })
  }

  hasLiveSessions(): boolean {
    return this.pty.list().some((session) => !session.exited)
  }

  hasOwnedSessions(): boolean {
    return this.pty.list().length > 0
  }

  async stopIfIdle(): Promise<boolean> {
    if (this.hasOwnedSessions()) return false
    const server = this.server
    this.server = null
    for (const client of this.connections) client.destroy()
    this.connections.clear()
    this.clients.clear()
    if (server) {
      const closed = Promise.withResolvers<void>()
      server.close(() => closed.resolve())
      await closed.promise
    }
    this.removeOwnedRuntimeFiles()
    return true
  }

  async start(): Promise<void> {
    this.prepareRuntimeDirectory()
    this.removeProvenStaleRuntime()
    const server = createServer((socket) => this.handleClient(socket))
    this.server = server
    const listening = Promise.withResolvers<void>()
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening)
      listening.reject(error)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      listening.resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(this.paths.socketPath)
    await listening.promise
    if (process.platform !== 'win32') chmodSync(this.paths.socketPath, 0o600)
    this.writeRuntimeFile()
  }

  private prepareRuntimeDirectory(): void {
    mkdirSync(this.paths.runtimeDir, { recursive: true, mode: 0o700 })
    mkdirSync(this.paths.socketDir, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') {
      chmodSync(this.paths.runtimeDir, 0o700)
      chmodSync(this.paths.socketDir, 0o700)
    }
  }

  private removeProvenStaleRuntime(): void {
    const runtimeExists = existsSync(this.paths.runtimeFile)
    const socketExists = process.platform !== 'win32' && existsSync(this.paths.socketPath)
    if (!runtimeExists && !socketExists) return
    const runtime = readTerminalRuntime(dirname(this.paths.runtimeDir))
    if (!runtime || runtime.pid === undefined) {
      throw new Error('existing terminal daemon ownership is unverifiable; runtime files were left untouched')
    }
    const liveness = probeLocalProcessLiveness(runtime.pid)
    if (liveness !== 'exited') {
      throw new Error(`existing terminal daemon is ${liveness}; runtime files were left untouched`)
    }
    if (socketExists) rmSync(this.paths.socketPath)
    if (runtimeExists) rmSync(this.paths.runtimeFile)
  }

  private writeRuntimeFile(): void {
    const temporary = `${this.paths.runtimeFile}.${process.pid}.${randomUUID()}.tmp`
    const payload = JSON.stringify({
      socketPath: this.paths.socketPath,
      authToken: this.authToken,
      pid: process.pid
    }, null, 2)
    writeFileSync(temporary, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(temporary, this.paths.runtimeFile)
    if (process.platform !== 'win32') chmodSync(this.paths.runtimeFile, 0o600)
  }

  private removeOwnedRuntimeFiles(): void {
    const runtime = readTerminalRuntime(dirname(this.paths.runtimeDir))
    if (runtime?.pid !== process.pid || runtime.authToken !== this.authToken) return
    if (existsSync(this.paths.runtimeFile)) rmSync(this.paths.runtimeFile)
    if (process.platform !== 'win32' && existsSync(this.paths.socketPath)) rmSync(this.paths.socketPath)
  }

  private handlePtyData(sessionId: string, data: string): void {
    if (data.length === 0) return
    const sequence = (this.sequence.get(sessionId) ?? 0) + 1
    this.sequence.set(sessionId, sequence)
    const current = (this.scrollback.get(sessionId) ?? '') + data
    this.scrollback.set(
      sessionId,
      current.length > SCROLLBACK_MAX ? current.slice(current.length - SCROLLBACK_MAX) : current
    )
    this.broadcast({ event: 'data', sessionId, data, sequence })
  }

  private handlePtyExit(sessionId: string, exitCode: number): void {
    this.broadcast({ event: 'exit', sessionId, exitCode })
    const record = this.agentsBySession.get(sessionId)
    if (record) {
      delete record.hookToken
      this.agentsByRun.delete(record.run.id)
      record.launchPlan.cleanup()
      const updatedAt = new Date().toISOString()
      const stopped = record.run.stopRequestedAt !== undefined
      record.run = {
        ...record.run,
        liveness: 'exited',
        activity: stopped || exitCode === 0 ? 'completed' : 'failed',
        detail: stopped
          ? 'Stopped by user'
          : exitCode === 0 ? 'Process exited successfully' : `Process exited with code ${exitCode}`,
        exitCode,
        updatedAt
      }
      this.publishAgent(record.run)
      return
    }
    if (this.pty.isRetained(sessionId)) return
    setTimeout(() => {
      this.scrollback.delete(sessionId)
      this.sequence.delete(sessionId)
    }, REAP_EXITED_MS)
  }

  private publishAgent(run: RunningAgent): void {
    this.attention.observe(run)
    this.broadcast({ event: 'agent', run: cloneRun(run) })
  }

  private broadcast(frame: Record<string, unknown>): void {
    const line = `${JSON.stringify(frame)}\n`
    for (const client of this.clients) {
      if (!client.destroyed) client.write(line)
    }
  }

  private authenticateHook(message: Record<string, unknown>): HookClientBinding | undefined {
    const runId = String(message['runId'] ?? '')
    const sessionId = String(message['sessionId'] ?? '')
    const token = typeof message['hookToken'] === 'string' ? message['hookToken'] : ''
    const record = this.agentsByRun.get(runId)
    if (!record || record.run.sessionId !== sessionId || record.run.liveness !== 'live') return undefined
    if (!sameToken(record.hookToken, token)) return undefined
    return { record, token }
  }

  private handleClient(socket: Socket): void {
    let privileged = false
    let hookBinding: HookClientBinding | undefined
    let buffer = ''
    const decoder = new StringDecoder('utf8')
    this.connections.add(socket)
    socket.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk)
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
        socket.destroy(new Error('terminal daemon frame exceeded limit'))
        return
      }
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue
        let message: Record<string, unknown>
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (!privileged && !hookBinding) {
          if (message['op'] === 'hello' && sameToken(this.authToken, message['authToken'])) {
            privileged = true
            this.clients.add(socket)
            this.reply(socket, message['id'], true, {
              protocolVersion: DAEMON_PROTOCOL_VERSION,
              capabilities: DAEMON_CAPABILITIES
            })
            continue
          }
          if (message['op'] === 'hook.hello') {
            hookBinding = this.authenticateHook(message)
            if (hookBinding) {
              this.reply(socket, message['id'], true, { capabilities: ['agent-hook-events-v1'] })
              continue
            }
          }
          socket.destroy()
          return
        }
        if (hookBinding) this.handleHookOp(socket, hookBinding, message)
        else void this.handleOp(socket, message)
      }
    })
    socket.on('close', () => {
      this.connections.delete(socket)
      this.clients.delete(socket)
    })
    socket.on('error', () => socket.destroy())
  }

  private reply(
    socket: Socket,
    idValue: unknown,
    ok: boolean,
    result: Record<string, unknown>
  ): void {
    const id = String(idValue ?? '')
    if (id && !socket.destroyed) socket.write(`${JSON.stringify({ id, ok, ...result })}\n`)
  }

  private handleHookOp(
    socket: Socket,
    binding: HookClientBinding,
    message: Record<string, unknown>
  ): void {
    const id = message['id']
    if (message['op'] !== 'hook.emit') {
      this.reply(socket, id, false, { error: 'hook clients may only emit bounded status events' })
      return
    }
    const record = binding.record
    if (record.run.liveness !== 'live' || !sameToken(record.hookToken, binding.token)) {
      this.reply(socket, id, false, { error: 'agent hook binding expired' })
      return
    }
    const now = Date.now()
    if (now - record.hookWindowStartedAt >= 60_000) {
      record.hookWindowStartedAt = now
      record.hookWindowCount = 0
    }
    if (record.hookWindowCount >= MAX_HOOK_EVENTS_PER_MINUTE) {
      this.reply(socket, id, false, { error: 'agent hook rate limit exceeded' })
      return
    }
    const hook = normalizeAgentHookMessage({ kind: message['kind'], detail: message['detail'] })
    if (!hook) {
      this.reply(socket, id, false, { error: 'invalid agent hook event' })
      return
    }
    record.hookWindowCount++
    const updatedAt = new Date(now).toISOString()
    const activity = record.run.activity === 'stopping' ? 'stopping' : hook.kind
    record.run = {
      ...record.run,
      activity,
      updatedAt,
      hook: {
        ...record.run.hook,
        connected: true,
        lastEventAt: updatedAt
      }
    }
    if (hook.detail) record.run.detail = hook.detail
    else delete record.run.detail
    this.publishAgent(record.run)
    this.reply(socket, id, true, {})
  }

  private createAgent(
    cwd: string,
    command: string,
    requestedProviderId: AgentProviderId | undefined,
    cols: number,
    rows: number
  ): { run: RunningAgent; session: TerminalSession } {
    if (!command.trim() || command.includes('\0') || Buffer.byteLength(command) > MAX_AGENT_COMMAND_BYTES) {
      throw new Error('agent command is empty or invalid')
    }
    const inferredProvider = agentProviderForCommand(command)
    if (requestedProviderId && inferredProvider?.id !== requestedProviderId) {
      throw new Error('agent provider does not match the exact command')
    }
    const provider = requestedProviderId
      ? AGENT_PROVIDER_DEFINITIONS.find((candidate) => candidate.id === requestedProviderId)
      : inferredProvider
    const runId = randomUUID()
    const sessionId = randomUUID()
    const hookToken = newAuthToken()
    const binding: AgentHookBinding = {
      socketPath: this.paths.socketPath,
      runId,
      sessionId,
      token: hookToken
    }
    const launchPlan = createAgentLaunchPlan({
      command,
      provider,
      binding,
      emitterCommand: this.emitterCommand,
      runtimeDir: this.paths.runtimeDir,
      inheritedEnv: process.env
    })
    const now = new Date().toISOString()
    const run: RunningAgent = {
      id: runId,
      sessionId,
      workspacePath: cwd,
      command,
      ...(provider ? { presetId: provider.id } : {}),
      startedAt: now,
      updatedAt: now,
      liveness: 'live',
      activity: 'starting',
      hook: {
        ...launchPlan.hookSupport,
        events: [...launchPlan.hookSupport.events],
        connected: false
      }
    }
    const record: AgentRecord = {
      run,
      hookToken,
      hookWindowStartedAt: Date.now(),
      hookWindowCount: 0,
      launchPlan
    }
    this.agentsBySession.set(sessionId, record)
    this.agentsByRun.set(runId, record)
    try {
      const session = this.pty.openAgent(cwd, launchPlan.command, cols, rows, {
        id: sessionId,
        env: launchPlan.env
      })
      this.sequence.set(session.id, 0)
      record.run = { ...record.run, activity: 'working', updatedAt: new Date().toISOString() }
      this.publishAgent(record.run)
      return { run: cloneRun(record.run), session }
    } catch (error) {
      this.agentsBySession.delete(sessionId)
      this.agentsByRun.delete(runId)
      launchPlan.cleanup()
      throw error
    }
  }

  private interruptAgent(record: AgentRecord): RunningAgent {
    if (record.run.liveness === 'exited') return cloneRun(record.run)
    if (!this.pty.has(record.run.sessionId)) {
      record.run = {
        ...record.run,
        liveness: 'unverifiable',
        updatedAt: new Date().toISOString()
      }
      this.publishAgent(record.run)
      throw new Error('agent process ownership is unverifiable')
    }
    this.pty.interrupt(record.run.sessionId)
    const stopRequestedAt = new Date().toISOString()
    record.run = {
      ...record.run,
      activity: 'stopping',
      stopRequestedAt,
      updatedAt: stopRequestedAt
    }
    this.publishAgent(record.run)
    return cloneRun(record.run)
  }

  private async handleOp(socket: Socket, message: Record<string, unknown>): Promise<void> {
    const id = message['id']
    const op = String(message['op'] ?? '')
    const reply = (ok: boolean, result: Record<string, unknown>): void => this.reply(socket, id, ok, result)
    try {
      switch (op) {
        case 'attention.list':
          reply(true, { snapshot: this.attention.list() })
          break
        case 'attention.ack': {
          const request = parseAttentionAcknowledgeRequest({
            eventId: message['eventId'],
            eventVersion: message['eventVersion']
          })
          const result = this.attention.acknowledge(request)
          reply(true, result)
          break
        }
        case 'session.open': {
          const session = this.pty.open(String(message['cwd']), Number(message['cols'] ?? 100), Number(message['rows'] ?? 30))
          this.sequence.set(session.id, 0)
          reply(true, { session })
          break
        }
        case 'job.open': {
          const session = this.pty.openJob(
            String(message['cwd']),
            String(message['command'] ?? ''),
            Number(message['cols'] ?? 100),
            Number(message['rows'] ?? 30)
          )
          this.sequence.set(session.id, 0)
          reply(true, { session })
          break
        }
        case 'job.result': {
          const sessionId = String(message['sessionId'])
          reply(true, {
            ...this.pty.jobResult(sessionId),
            output: this.scrollback.get(sessionId) ?? '',
            sequence: this.sequence.get(sessionId) ?? 0
          })
          break
        }
        case 'agent.open': {
          const rawProviderId = message['providerId']
          const provider = typeof rawProviderId === 'string'
            ? AGENT_PROVIDER_DEFINITIONS.find((candidate) => candidate.id === rawProviderId)
            : undefined
          if (rawProviderId !== undefined && !provider) throw new Error('unknown agent provider')
          const providerId = provider?.id
          const result = this.createAgent(
            String(message['cwd']),
            String(message['command'] ?? ''),
            providerId,
            Number(message['cols'] ?? 100),
            Number(message['rows'] ?? 30)
          )
          reply(true, result)
          break
        }
        case 'agent.list':
          reply(true, { runs: [...this.agentsBySession.values()].map((record) => cloneRun(record.run)) })
          break
        case 'agent.get': {
          const record = this.agentsBySession.get(String(message['sessionId']))
          if (!record) throw new Error('unknown agent session')
          reply(true, { run: cloneRun(record.run) })
          break
        }
        case 'agent.write': {
          const sessionId = String(message['sessionId'])
          const record = this.agentsBySession.get(sessionId)
          if (!record) throw new Error('unknown agent session')
          const ownerLiveness = this.pty.liveness(sessionId)
          if (record.run.liveness !== 'live' || ownerLiveness !== 'live') {
            throw new Error('agent input rejected because process liveness is ' + ownerLiveness)
          }
          if (record.run.activity !== 'working' && record.run.activity !== 'waiting') {
            throw new Error('agent input rejected while agent activity is ' + record.run.activity)
          }
          const data = message['data']
          if (typeof data !== 'string' || data.length === 0) {
            throw new Error('agent input must be a non-empty string')
          }
          this.pty.writeAgent(sessionId, data)
          reply(true, {})
          break
        }
        case 'agent.interrupt': {
          const record = this.agentsBySession.get(String(message['sessionId']))
          if (!record) throw new Error('unknown agent session')
          reply(true, { run: this.interruptAgent(record) })
          break
        }
        case 'agent.dismiss': {
          const sessionId = String(message['sessionId'])
          const record = this.agentsBySession.get(sessionId)
          if (!record) throw new Error('unknown agent session')
          if (record.run.liveness !== 'exited' || this.pty.liveness(sessionId) !== 'exited') {
            throw new Error('agent session is still live or unverifiable and cannot be dismissed')
          }
          this.pty.dismissExited(sessionId)
          this.agentsBySession.delete(sessionId)
          this.agentsByRun.delete(record.run.id)
          record.launchPlan.cleanup()
          this.scrollback.delete(sessionId)
          this.sequence.delete(sessionId)
          this.broadcast({ event: 'agent-dismissed', sessionId })
          reply(true, {})
          break
        }
        case 'session.write':
          this.pty.write(String(message['sessionId']), String(message['data'] ?? ''))
          reply(true, {})
          break
        case 'session.resize':
          this.pty.resize(String(message['sessionId']), Number(message['cols'] ?? 100), Number(message['rows'] ?? 30))
          reply(true, {})
          break
        case 'session.interrupt': {
          const sessionId = String(message['sessionId'])
          const agent = this.agentsBySession.get(sessionId)
          if (agent) this.interruptAgent(agent)
          else this.pty.interrupt(sessionId)
          reply(true, {})
          break
        }
        case 'session.close': {
          const sessionId = String(message['sessionId'])
          if (this.agentsBySession.has(sessionId)) {
            throw new Error('agent sessions require interrupt followed by dismiss after confirmed exit')
          }
          await this.pty.close(sessionId)
          this.scrollback.delete(sessionId)
          this.sequence.delete(sessionId)
          reply(true, {})
          break
        }
        case 'session.list':
          reply(true, { sessions: this.pty.list() })
          break
        case 'session.attach': {
          const sessionId = String(message['sessionId'])
          const session = this.pty.list().find((candidate) => candidate.id === sessionId)
          if (!session) {
            reply(false, { error: `unknown session: ${sessionId}` })
            break
          }
          reply(true, {
            session,
            scrollback: this.scrollback.get(sessionId) ?? '',
            sequence: this.sequence.get(sessionId) ?? 0
          })
          break
        }
        case 'daemon.status':
          reply(true, {
            pid: process.pid,
            idle: !this.hasOwnedSessions(),
            sessionCount: this.pty.list().length,
            liveSessionCount: this.pty.list().filter((session) => !session.exited).length
          })
          break
        case 'daemon.shutdown':
          if (this.hasOwnedSessions()) {
            reply(false, { error: 'terminal daemon owns sessions and refuses shutdown' })
            break
          }
          reply(true, { stopped: true })
          setImmediate(() => void this.stopIfIdle())
          break
        case 'ping':
          reply(true, { pong: Date.now() })
          break
        default:
          reply(false, { error: `unknown op: ${op}` })
      }
    } catch (error) {
      reply(false, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}
