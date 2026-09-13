import { randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { Readable, Transform, Writable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { ClientSideConnection, ndJsonStream, type McpServer, type PromptResponse, type RequestPermissionRequest, type RequestPermissionResponse, type SessionNotification } from '@agentclientprotocol/sdk'
import { parseAgentExecutable, type AgentExecutable, type AcpAgentSnapshot, type AcpObservation } from '@shared/agent-runtime'
import { spawnProcess } from '@shared/child-process/run-process'
import { forceTerminateProcessTree } from '@shared/child-process/process-tree-termination'
import { sanitizedProcessEnv } from '@shared/child-process/process-environment'
import type { ProcessIdentity, RuntimeIdentityAuthority } from '@shared/child-process/process-spec'
import { version } from '../../../package.json'

export type { AcpAgentSnapshot } from '@shared/agent-runtime'

export type AcpAgentStartOptions = {
  id?: string
  signal?: AbortSignal
  /** The owning runtime must authorize this existing directory against its registered projects. */
  workspacePath: string
  launch: AgentExecutable
  env?: NodeJS.ProcessEnv
  mcpServers: McpServer[]
  loadSessionId?: string
  identity: RuntimeIdentityAuthority
  onChange: (snapshot: AcpAgentSnapshot) => void
}

export type AcpAgentOwner = {
  get(): AcpAgentSnapshot
  observe(afterSequence?: number): Omit<AcpObservation, 'requests'>
  prompt(text: string): Promise<PromptResponse>
  cancel(): Promise<void>
  stop(): Promise<void>
  answerPermission(id: string, optionId: string | null): void
}

export type AcpAgentOwnerFactory = (options: AcpAgentStartOptions) => Promise<AcpAgentOwner>

/** One process owner and protocol session; no PTY or implicit native-session attachment. */
export class AcpAgent {
  private readonly child: ChildProcess
  private readonly connection: ClientSideConnection
  private readonly snapshot: AcpAgentSnapshot
  private readonly permissions = new Map<string, { request: RequestPermissionRequest; resolve: (response: RequestPermissionResponse) => void }>()
  private readonly updates: Array<{ sequence: number; notification: SessionNotification; bytes: number }> = []
  private sequence = 0
  private promptStartSequence = 0
  private updateBytes = 0
  private pending?: Promise<PromptResponse>
  private stopping?: Promise<void>
  private stderr = ''

  private constructor(
    private readonly options: AcpAgentStartOptions,
    workspacePath: string,
    child: ChildProcess,
    processIdentity: ProcessIdentity
  ) {
    this.snapshot = { mode: 'acp', id: options.id ?? randomUUID(), workspacePath, protocolSessionId: null, processIdentity, state: 'starting', capabilities: {}, permissions: [] }
    this.child = child
    this.options.onChange(this.get())
    this.child.stderr!.on('data', chunk => { this.stderr = (this.stderr + String(chunk)).slice(-8192) })
    this.child.on('error', error => this.lost(String(error)))
    this.child.on('exit', (code, signal) => this.lost(`ACP process exited (${signal ?? code}). ${this.stderr}`))
    // ponytail: 1 MiB protocol frames and a 2 MiB replay tail; add disk history only with daemon recovery.
    let lineBytes = 0
    const bounded = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      for (const byte of chunk) {
        lineBytes = byte === 10 ? 0 : lineBytes + 1
        if (lineBytes > 1024 * 1024) { callback(new Error('ACP frame exceeds 1 MiB')); return }
      }
      callback(null, chunk)
    } })
    this.child.stdout!.on('error', error => bounded.destroy(error))
    bounded.on('error', error => { this.lost(String(error)); void this.stop().catch(() => {}) })
    this.child.stdout!.pipe(bounded)
    this.connection = new ClientSideConnection(() => ({
      sessionUpdate: notification => this.update(notification),
      requestPermission: request => this.permission(request)
    }), ndJsonStream(Writable.toWeb(this.child.stdin!) as unknown as Parameters<typeof ndJsonStream>[0], Readable.toWeb(bounded) as unknown as Parameters<typeof ndJsonStream>[1]))
    void this.connection.closed.then(() => {
      this.lost('ACP connection closed; in-flight work was not replayed.')
      void this.stop().catch(() => {})
    })
  }

  static async start(options: AcpAgentStartOptions): Promise<AcpAgent> {
    options.signal?.throwIfAborted()
    if (!isAbsolute(options.workspacePath)) throw new Error('ACP workspace must be an absolute directory')
    const path = realpathSync(options.workspacePath)
    if (!statSync(path).isDirectory()) throw new Error('ACP workspace is not a directory')
    const launch = parseAgentExecutable(options.launch)
    const env = sanitizedProcessEnv(options.env ?? process.env)
    for (const key of Object.keys(env)) if (key.startsWith('DONWELLS_AGENT_HOOK_')) delete env[key]
    const child = spawnProcess({ program: launch.executable, args: launch.args, cwd: path, env, detached: true })
    let processIdentity: ProcessIdentity
    try {
      if (!child.pid) throw new Error('ACP process did not report a PID')
      processIdentity = options.identity.capture(child.pid, { family: 'acp-agent' })
    } catch (error) {
      const detail = String(error).slice(0, 2048)
      const terminated = await forceTerminateProcessTree(child).catch(() => false)
      options.onChange({
        mode: 'acp',
        id: options.id ?? randomUUID(),
        workspacePath: path,
        protocolSessionId: null,
        processIdentity: null,
        state: 'uncertain',
        capabilities: {},
        permissions: [],
        detail: terminated ? detail : (detail + ' ACP process termination could not be verified.').slice(0, 2048)
      })
      throw error
    }
    const agent = new AcpAgent(options, path, child, processIdentity)
    const abort = () => { void agent.stop().catch(() => {}) }
    options.signal?.addEventListener('abort', abort, { once: true })
    try {
      options.signal?.throwIfAborted()
      const initialized = await agent.deadline(agent.connection.initialize({ protocolVersion: 1, clientInfo: { name: 'donwells', version }, clientCapabilities: {} }), 15000)
      if (initialized.protocolVersion !== 1) throw new Error('Agent did not negotiate ACP protocol 1')
      agent.snapshot.capabilities = initialized.agentCapabilities ?? {}
      const params = { cwd: path, mcpServers: options.mcpServers }
      if (options.loadSessionId) {
        if (!initialized.agentCapabilities?.loadSession) throw new Error('This agent does not support loading a saved ACP session')
        agent.snapshot.protocolSessionId = options.loadSessionId
        await agent.deadline(agent.connection.loadSession({ ...params, sessionId: options.loadSessionId }), 15000)
      } else {
        const session = await agent.deadline(agent.connection.newSession(params), 15000)
        agent.snapshot.protocolSessionId = session.sessionId
      }
      agent.setState('ready')
      return agent
    } catch (error) {
      await agent.stop()
      throw error
    } finally { options.signal?.removeEventListener('abort', abort) }
  }

  get(): AcpAgentSnapshot { return structuredClone(this.snapshot) }

  observe(afterSequence = 0) {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error('Invalid ACP observation sequence')
    const selected: typeof this.updates = []; let bytes = 0
    for (const update of this.updates) {
      if (update.sequence <= afterSequence) continue
      if (selected.length && bytes + update.bytes > 512 * 1024) break
      selected.push(update); bytes += update.bytes
    }
    return { snapshot: this.get(), sequence: selected.at(-1)?.sequence ?? Math.min(afterSequence, this.sequence), truncated: this.updates.length > 0 && afterSequence < this.updates[0]!.sequence - 1, updates: structuredClone(selected.map(({ sequence, notification }) => ({ sequence, notification }))) }
  }

  private setState(state: AcpAgentSnapshot['state'], detail?: string) {
    this.snapshot.state = state
    this.snapshot.detail = detail?.slice(0, 2048)
    this.snapshot.permissions = [...this.permissions].map(([id, { request }]) => ({ id, request }))
    this.options.onChange(this.get())
  }

  private update(notification: SessionNotification) {
    if (notification.sessionId !== this.snapshot.protocolSessionId) return
    const bytes = Buffer.byteLength(JSON.stringify(notification))
    this.updates.push({ sequence: ++this.sequence, notification, bytes })
    this.updateBytes += bytes
    while (this.updateBytes > 2 * 1024 * 1024 || this.updates.length > 2048) this.updateBytes -= this.updates.shift()!.bytes
    for (const permission of this.permissions.values()) this.reviewPermission(permission.request)
    this.snapshot.permissions = [...this.permissions].map(([id, { request }]) => ({ id, request }))
    this.options.onChange(this.get())
  }

  private reviewPermission(request: RequestPermissionRequest): void {
    // OpenCode permission metadata can be empty while its matching tool update carries the actual input.
    // Reuse the bounded protocol replay, scoped to this prompt and tool identity; options and permission IDs stay untouched.
    for (const { sequence, notification } of this.updates) {
      if (sequence <= this.promptStartSequence || notification.sessionId !== request.sessionId) continue
      const update = notification.update
      if ((update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') || update.toolCallId !== request.toolCall.toolCallId) continue
      const { sessionUpdate: _type, ...fields } = update
      request.toolCall = { ...request.toolCall, ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) }
    }
  }

  private permission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (request.sessionId !== this.snapshot.protocolSessionId || !this.pending || this.stopping || !['working', 'permission'].includes(this.snapshot.state) || this.permissions.size >= 8 || Buffer.byteLength(JSON.stringify(request)) > 64 * 1024) return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    this.reviewPermission(request)
    return new Promise(resolve => {
      this.permissions.set(randomUUID(), { request, resolve })
      this.setState('permission')
    })
  }

  answerPermission(id: string, optionId: string | null): void {
    const permission = this.permissions.get(id)
    if (!permission || this.stopping || this.snapshot.state !== 'permission') throw new Error('ACP permission is no longer pending')
    if (optionId !== null && !permission.request.options.some(option => option.optionId === optionId)) throw new Error('ACP permission option was not offered')
    this.permissions.delete(id)
    permission.resolve(optionId === null ? { outcome: { outcome: 'cancelled' } } : { outcome: { outcome: 'selected', optionId } })
    this.setState(this.permissions.size ? 'permission' : 'working')
  }

  private denyPermissions() {
    for (const permission of this.permissions.values()) permission.resolve({ outcome: { outcome: 'cancelled' } })
    this.permissions.clear()
    this.snapshot.permissions = []
  }

  prompt(text: string): Promise<PromptResponse> {
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 64 * 1024) return Promise.reject(new Error('ACP prompt must contain 1–65536 bytes'))
    if (this.snapshot.state !== 'ready' || this.pending || this.stopping) return Promise.reject(new Error('ACP session is not ready for another prompt'))
    this.promptStartSequence = this.sequence
    this.setState('working')
    const pending = this.connection.prompt({ sessionId: this.snapshot.protocolSessionId!, prompt: [{ type: 'text', text }] })
    this.pending = pending
    return pending.then(result => {
      this.denyPermissions()
      if (!this.stopping && this.snapshot.state !== 'uncertain' && this.snapshot.state !== 'exited') this.setState('ready')
      return result
    }, error => {
      this.lost(`ACP prompt outcome is uncertain: ${String(error)}`)
      throw error
    }).finally(() => { if (this.pending === pending) this.pending = undefined })
  }

  async cancel(): Promise<void> {
    if (!this.pending || this.stopping) return
    const pending = this.pending
    this.denyPermissions()
    this.setState('stopping')
    try {
      await this.deadline(this.connection.cancel({ sessionId: this.snapshot.protocolSessionId! }), 3000)
      await this.deadline(pending, 3000)
    } catch (error) {
      this.lost(`ACP cancellation was not acknowledged: ${String(error)}`)
      await this.stop()
    }
  }

  private lost(detail: string) {
    this.denyPermissions()
    if (this.snapshot.state !== 'exited') this.setState(this.pending || this.snapshot.state === 'uncertain' ? 'uncertain' : 'exited', detail)
  }

  stop(): Promise<void> {
    return this.stopping ??= this.terminate()
  }

  private async terminate(): Promise<void> {
    const uncertain = !!this.pending || this.snapshot.state === 'uncertain'
    this.denyPermissions()
    this.setState('stopping')
    this.child.stdin?.end()
    const ended = new Promise<void>(resolve => {
      if (this.child.exitCode !== null || this.child.signalCode !== null || !this.child.pid) resolve()
      else this.child.once('exit', () => resolve())
    })
    await this.deadline(ended, 1000).catch(() => {})
    const verified = await forceTerminateProcessTree(this.child)
    this.setState(uncertain || !verified ? 'uncertain' : 'exited', verified ? undefined : 'ACP process termination could not be verified')
    if (!verified) throw new Error('ACP process termination could not be verified')
  }

  private async deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('ACP operation timed out')), ms) })]) }
    finally { clearTimeout(timer) }
  }
}
