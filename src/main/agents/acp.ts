import { randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { Readable, Transform, Writable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { ClientSideConnection, ndJsonStream, type InitializeResponse, type McpServer, type PromptResponse, type RequestPermissionRequest, type RequestPermissionResponse, type SessionNotification } from '@agentclientprotocol/sdk'
import { parseAgentExecutable, type AgentExecutable } from '@shared/agent-runtime'
import { spawnProcess } from '@shared/child-process/run-process'
import { forceTerminateProcessTree } from '@shared/child-process/process-tree-termination'
import { version } from '../../../package.json'

export type AcpAgentSnapshot = {
  mode: 'acp'
  id: string
  workspacePath: string
  protocolSessionId: string | null
  state: 'starting' | 'ready' | 'working' | 'permission' | 'stopping' | 'exited' | 'uncertain'
  capabilities: InitializeResponse['agentCapabilities']
  permissions: Array<{ id: string; request: RequestPermissionRequest }>
  detail?: string
}

type Options = {
  /** The owning runtime must authorize this existing directory against its registered projects. */
  workspacePath: string
  launch: AgentExecutable
  env?: NodeJS.ProcessEnv
  mcpServers: McpServer[]
  loadSessionId?: string
  onChange: (snapshot: AcpAgentSnapshot) => void
}

/** One process owner and protocol session; no PTY or implicit native-session attachment. */
export class AcpAgent {
  private readonly child: ChildProcess
  private readonly connection: ClientSideConnection
  private readonly snapshot: AcpAgentSnapshot
  private readonly permissions = new Map<string, { request: RequestPermissionRequest; resolve: (response: RequestPermissionResponse) => void }>()
  private readonly updates: Array<{ sequence: number; notification: SessionNotification; bytes: number }> = []
  private sequence = 0
  private updateBytes = 0
  private pending?: Promise<PromptResponse>
  private stopping?: Promise<void>
  private stderr = ''

  private constructor(private readonly options: Options, workspacePath: string) {
    this.snapshot = { mode: 'acp', id: randomUUID(), workspacePath, protocolSessionId: null, state: 'starting', capabilities: {}, permissions: [] }
    const launch = parseAgentExecutable(options.launch)
    this.child = spawnProcess({ program: launch.executable, args: launch.args, cwd: workspacePath, env: options.env, detached: true })
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

  static async start(options: Options): Promise<AcpAgent> {
    if (!isAbsolute(options.workspacePath)) throw new Error('ACP workspace must be an absolute directory')
    const path = realpathSync(options.workspacePath)
    if (!statSync(path).isDirectory()) throw new Error('ACP workspace is not a directory')
    const agent = new AcpAgent(options, path)
    try {
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
    }
  }

  get(): AcpAgentSnapshot { return structuredClone(this.snapshot) }

  observe(afterSequence = 0) {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error('Invalid ACP observation sequence')
    return { snapshot: this.get(), sequence: this.sequence, truncated: this.updates.length > 0 && afterSequence < this.updates[0]!.sequence - 1, updates: structuredClone(this.updates.filter(update => update.sequence > afterSequence).map(({ sequence, notification }) => ({ sequence, notification }))) }
  }

  private setState(state: AcpAgentSnapshot['state'], detail?: string) {
    this.snapshot.state = state
    this.snapshot.detail = detail
    this.snapshot.permissions = [...this.permissions].map(([id, { request }]) => ({ id, request }))
    this.options.onChange(this.get())
  }

  private update(notification: SessionNotification) {
    if (notification.sessionId !== this.snapshot.protocolSessionId) return
    const bytes = Buffer.byteLength(JSON.stringify(notification))
    this.updates.push({ sequence: ++this.sequence, notification, bytes })
    this.updateBytes += bytes
    while (this.updateBytes > 2 * 1024 * 1024 || this.updates.length > 2048) this.updateBytes -= this.updates.shift()!.bytes
    this.options.onChange(this.get())
  }

  private permission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (request.sessionId !== this.snapshot.protocolSessionId || !this.pending || this.stopping || !['working', 'permission'].includes(this.snapshot.state) || this.permissions.size >= 32) return Promise.resolve({ outcome: { outcome: 'cancelled' } })
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
