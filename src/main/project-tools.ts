import { version as appVersion } from '../../package.json'
import { createHash, randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import type { ChildProcess } from 'node:child_process'
import { isObject } from '@shared/command-catalog'
import { createOutputSink } from '@shared/child-process/bounded-output-sink'
import { ProcessExecutionError, spawnProcess, type ProcessSpec } from '@shared/child-process/run-process'
import { sanitizedProcessEnv } from '@shared/child-process/process-environment'
import { forceTerminateProcessTree } from '@shared/child-process/process-tree-termination'
import type { ProjectToolScope, ToolServiceState } from '@shared/project-tools'

export type ProjectToolDefinition = {
  id: string
  version: string
  protocolVersion?: '2025-06-18' | '2025-11-25'
  scope: 'project' | 'checkout'
  prepare?: (scope: ProjectToolScope, signal: AbortSignal) => Promise<void>
  stopped?: (scope: ProjectToolScope) => void | Promise<void>
  launch: (scope: ProjectToolScope) => Pick<ProcessSpec, 'program' | 'args' | 'env'>
  operations: Record<string, {
    tool: string
    readOnly: boolean
    requiresRunning?: boolean
    parameters: Record<string, (value: unknown) => unknown>
    targets: (scope: ProjectToolScope) => Record<string, unknown>
    run?: (scope: ProjectToolScope, request: (tool?: string, parameters?: Record<string, unknown>) => Promise<unknown>, arguments_: Record<string, unknown>) => Promise<unknown>
  }>
}

type ResolveWorkspace = (path: string) => Promise<{ path: string; projectPath: string }>
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }
type Service = {
  scope: ProjectToolScope
  state: ToolServiceState
  process: ChildProcess
  pending: Map<string, Pending>
  activeCalls: number
  ready: Promise<void>
  stopping?: Promise<boolean>
  stopRequested?: boolean
  stopped?: () => void | Promise<void>
}

export async function resolveProjectToolScope(path: string, resolveWorkspace: ResolveWorkspace): Promise<ProjectToolScope> {
  const workspace = await resolveWorkspace(path)
  const [projectPath, checkoutPath] = await Promise.all([realpath(workspace.projectPath), realpath(workspace.path)])
  const identity = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value
  const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
  const projectKey = hash(identity(projectPath))
  return { projectKey, projectPath, checkoutPath, indexKey: hash(projectKey + '\0' + identity(checkoutPath)) }
}

class ToolTransportError extends Error {}
export class ToolOutcomeUncertainError extends Error { readonly code = 'TOOL_OUTCOME_UNCERTAIN' }

/** Admitted MCP stdio services only. Private inherited pipes carry authority; callers cannot supply launch commands or targets. */
export class ProjectTools {
  private readonly services = new Map<string, Service>()
  private readonly attempts = new Map<string, number[]>()
  private readonly preparing = new Map<string, { controller: AbortController; promise: Promise<ToolServiceState> }>()
  private readonly setupStates = new Map<string, ToolServiceState>()
  private readonly unverifiedSetups = new Set<string>()
  private closed = false

  constructor(
    private readonly resolveWorkspace: ResolveWorkspace,
    private readonly definitions: readonly ProjectToolDefinition[],
    private readonly timeoutMs = 10_000
  ) {
    if (new Set(definitions.map(tool => tool.id)).size !== definitions.length) throw new Error('Duplicate tool definition')
  }

  private async bound(workspacePath: string, id: string) {
    if (this.closed) throw new Error('Project tools are shutting down')
    const definition = this.definitions.find(tool => tool.id === id)
    if (!definition) throw new Error('Tool is not admitted: ' + id)
    let scope = await resolveProjectToolScope(workspacePath, this.resolveWorkspace)
    if (this.closed) throw new Error('Project tools are shutting down')
    // A project service always launches at the main project, regardless of which linked checkout requested it first.
    if (definition.scope === 'project') scope = await resolveProjectToolScope(scope.projectPath, this.resolveWorkspace)
    const key = id + ':' + (definition.scope === 'project' ? scope.projectKey : scope.indexKey)
    return { definition, scope, key }
  }

  async list(workspacePath: string): Promise<ToolServiceState[]> {
    await resolveProjectToolScope(workspacePath, this.resolveWorkspace)
    return Promise.all(this.definitions.map(async definition => {
      const { key, scope } = await this.bound(workspacePath, definition.id)
      const service = this.services.get(key)
      return { ...(this.setupStates.get(key) ?? service?.state ?? { id: definition.id, status: 'stopped', version: null, detail: null }), owner: scope, scope: definition.scope, activeCalls: service?.activeCalls ?? 0, pid: service && service.process.exitCode === null && service.process.signalCode === null ? service.process.pid ?? null : null }
    }))
  }

  async start(workspacePath: string, id: string): Promise<ToolServiceState> {
    const { definition, scope, key } = await this.bound(workspacePath, id)
    if (this.unverifiedSetups.has(key)) throw new Error('Previous tool setup termination could not be verified')
    const pending = this.preparing.get(key)
    if (pending) return pending.promise
    const existing = this.services.get(key)
    if (existing?.state.status === 'ready' || existing?.state.status === 'starting') {
      await existing.ready
      return { ...existing.state }
    }
    const attempts = (this.attempts.get(key) ?? []).filter(time => Date.now() - time < 60_000)
    if (attempts.length >= 3) throw new Error('Tool restart limit reached; retry after one minute')
    attempts.push(Date.now()); this.attempts.set(key, attempts)
    const controller = new AbortController()
    this.setupStates.set(key, { id, status: 'starting', version: null, detail: 'Preparing tool' })
    const promise = Promise.resolve().then(async () => {
      if (existing?.stopping && !await existing.stopping) throw new Error('Previous tool termination could not be verified')
      if (controller.signal.aborted || this.closed) throw new Error('Tool stopped')
      await definition.prepare?.(scope, controller.signal)
      if (controller.signal.aborted || this.closed) throw new Error('Tool stopped')
      const state = await this.startPrepared(workspacePath, id, key, controller.signal)
      this.setupStates.delete(key)
      return state
    }).catch(error => {
      if (error instanceof ProcessExecutionError && error.kind === 'termination-unverified') this.unverifiedSetups.add(key)
      const stopped = (controller.signal.aborted || this.closed) && !(error instanceof ProcessExecutionError && error.kind === 'termination-unverified')
      this.setupStates.set(key, { id, status: stopped ? 'stopped' : 'failed', version: null, detail: stopped ? null : String(error) })
      throw error
    }).finally(() => { this.preparing.delete(key) })
    this.preparing.set(key, { controller, promise })
    return promise
  }

  private async startPrepared(workspacePath: string, id: string, preparedKey: string, signal: AbortSignal): Promise<ToolServiceState> {
    const { definition, scope, key } = await this.bound(workspacePath, id)
    if (key !== preparedKey) throw new Error('Tool scope changed during preparation')
    let service = this.services.get(key)
    if (service?.state.status === 'ready' || service?.state.status === 'starting') {
      await service.ready
      return { ...service.state }
    }
    if (service?.stopping && !await service.stopping) throw new Error('Previous tool termination could not be verified')
    if (this.closed || signal.aborted) throw new Error('Tool stopped')
    // Recheck after asynchronous cleanup so concurrent restart requests still share one process.
    const current = this.services.get(key)
    if (current !== service) return this.startPrepared(workspacePath, id, preparedKey, signal)
    const launch = definition.launch(scope)
    const child = spawnProcess({ ...launch, cwd: scope.checkoutPath, env: sanitizedProcessEnv(process.env, launch.env), detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    service = { scope, stopped: () => definition.stopped?.(scope), process: child, pending: new Map(), activeCalls: 0, ready: Promise.resolve(), state: { id, status: 'starting', version: null, detail: null } }
    this.services.set(key, service)
    const owned = service
    const fail = (detail: string): void => {
      if (owned.state.status === 'stopped' || owned.state.status === 'stopping' || owned.state.status === 'failed') return
      owned.state = { id, status: 'failed', version: owned.state.version, detail }
      for (const pending of owned.pending.values()) pending.reject(new ToolTransportError(detail))
      owned.pending.clear()
      owned.stopping ??= forceTerminateProcessTree(child).then(async stopped => { if (stopped) await owned.stopped?.(); return stopped }).catch(() => false)
    }
    child.once('error', () => fail('Tool process could not start'))
    child.once('close', () => fail('Tool process exited'))
    child.stdin?.on('error', () => fail('Tool input disconnected'))
    child.stdout?.on('error', () => fail('Tool output disconnected'))
    const logs = createOutputSink(64 * 1024, () => {})
    child.stderr?.on('data', chunk => logs.write(chunk))
    child.stderr?.on('error', () => {})
    const decoder = new StringDecoder('utf8')
    let buffer = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk)
      if (Buffer.byteLength(buffer) > 1024 * 1024) { fail('Tool response exceeded limit'); return }
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue
        try {
          const message: unknown = JSON.parse(line)
          if (!isObject(message) || message.jsonrpc !== '2.0') throw new Error()
          if (typeof message.method === 'string') {
            // No sampling, elicitation, filesystem roots or other callback authority is advertised.
            if (message.id !== undefined) child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client method unavailable' } }) + '\n')
            continue
          }
          const pending = owned.pending.get(String(message.id))
          if (!pending) continue
          if (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error')) throw new Error()
          owned.pending.delete(String(message.id))
          if (message.error !== undefined) pending.reject(new Error('Tool rejected request'))
          else pending.resolve(message.result)
        } catch { fail('Malformed tool response'); return }
      }
    })
    owned.ready = (async () => {
      try {
        const initialized = await this.request(owned, 'initialize', { protocolVersion: definition.protocolVersion ?? '2025-11-25', capabilities: {}, clientInfo: { name: 'donwells', version: appVersion } })
        if (!isObject(initialized) || initialized.protocolVersion !== (definition.protocolVersion ?? '2025-11-25') || !isObject(initialized.serverInfo) || initialized.serverInfo.version !== definition.version || !isObject(initialized.capabilities) || !isObject(initialized.capabilities.tools)) throw new Error('Tool version or capability mismatch')
        child.stdin?.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
        const catalog = await this.request(owned, 'tools/list', {})
        const catalogTools = isObject(catalog) && Array.isArray(catalog.tools) ? catalog.tools : []
        if (!isObject(catalog) || catalog.nextCursor !== undefined || Object.values(definition.operations).some(operation => !catalogTools.some((tool: unknown) => isObject(tool) && tool.name === operation.tool))) throw new Error('Required tool capabilities unavailable')
        if (owned.state.status !== 'starting') throw new Error('Tool start cancelled')
        owned.state = { id, status: 'ready', version: definition.version, detail: null }
      } catch (error) {
        fail(error instanceof ToolTransportError ? error.message : 'Tool readiness verification failed')
        throw error
      }
    })()
    await owned.ready
    return { ...owned.state }
  }

  private request(service: Service, method: string, params: unknown): Promise<unknown> {
    if (service.state.status === 'failed' || service.state.status === 'stopped' || service.state.status === 'stopping') return Promise.reject(new ToolTransportError('Tool is unavailable'))
    if (service.pending.size >= 64) return Promise.reject(new Error('Too many pending tool requests'))
    const id = randomUUID(), frame = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
    if (Buffer.byteLength(frame) > 64 * 1024) return Promise.reject(new Error('Tool request exceeded limit'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        service.pending.delete(id)
        reject(new ToolTransportError('Tool response timed out'))
      }, this.timeoutMs)
      service.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
      service.process.stdin!.write(frame)
    })
  }

  async call(workspacePath: string, id: string, operationName: string, input: unknown): Promise<unknown> {
    const { definition, scope, key } = await this.bound(workspacePath, id)
    const operation = Object.hasOwn(definition.operations, operationName) ? definition.operations[operationName]! : undefined
    if (!operation || !isObject(input)) throw new Error('Invalid tool operation or arguments')
    const targets = operation.targets(scope), args: Record<string, unknown> = {}
    for (const name of Object.keys(input)) {
      if (!Object.hasOwn(operation.parameters, name) || Object.hasOwn(targets, name)) throw new Error('Tool argument is not permitted: ' + name)
    }
    for (const [name, parse] of Object.entries(operation.parameters)) args[name] = parse(input[name])
    for (let attempt = 0; attempt < 2; attempt++) {
      if (operation.requiresRunning) {
        if (this.services.get(key)?.state.status !== 'ready') throw new Error('Tool is not running')
      } else await this.start(workspacePath, id)
      if ((await this.bound(workspacePath, id)).key !== key) throw new Error('Tool scope changed before request')
      const service = this.services.get(key)!
      service.activeCalls++
      try {
        const request = async (tool = operation.tool, parameters?: Record<string, unknown>) => {
          if (service.state.status !== 'ready') throw new ToolTransportError('Tool stopped')
          const result = await this.request(service, 'tools/call', { name: tool, arguments: parameters ?? { ...args, ...operation.targets(scope) } })
          if (!isObject(result) || !Array.isArray(result.content)) throw new ToolTransportError('Malformed tool result')
          return result
        }
        const result = await (operation.run ? operation.run(scope, request, args) : request())
        const fresh = await this.bound(workspacePath, id).catch(() => { throw new ToolTransportError('Tool scope is no longer available') })
        if (fresh.key !== key || this.services.get(key) !== service || service.state.status !== 'ready') throw new ToolTransportError('Tool scope or generation changed')
        return result
      } catch (error) {
        if (!(error instanceof ToolTransportError)) throw error
        await this.stopOwned(service)
        if (!service.stopRequested && !this.closed) service.state = { ...service.state, status: 'failed', detail: error.message }
        if (!operation.readOnly) throw new ToolOutcomeUncertainError('Tool action outcome is uncertain; inspect before retrying')
        if (service.stopRequested || this.closed) throw new Error('Tool stopped')
        if (operation.requiresRunning || attempt > 0) throw error
      } finally { service.activeCalls-- }
    }
    throw new Error('Tool unavailable')
  }

  async stop(workspacePath: string, id: string): Promise<void> {
    const { key } = await this.bound(workspacePath, id)
    if (this.unverifiedSetups.has(key)) throw new Error('Previous tool setup termination could not be verified')
    const pending = this.preparing.get(key)
    pending?.controller.abort()
    if (pending) this.setupStates.set(key, { id, status: 'stopping', version: null, detail: 'Cancelling tool setup' })
    const service = this.services.get(key)
    if (service) { service.stopRequested = true; await this.stopOwned(service) }
    await pending?.promise.catch(error => { if (error instanceof ProcessExecutionError && error.kind === 'termination-unverified') throw error })
    this.setupStates.delete(key)
    this.attempts.delete(key)
  }

  private async stopOwned(service: Service): Promise<void> {
    service.state = { ...service.state, status: 'stopping', detail: 'Waiting for owned process cleanup' }
    for (const pending of service.pending.values()) pending.reject(new ToolTransportError('Tool stopped'))
    service.pending.clear()
    service.stopping ??= (async () => {
      const child = service.process
      // MCP EOF lets native services close detached children such as Chromium.
      // Windows retains taskkill tree ownership; POSIX still verifies its private group below.
      if (process.platform !== 'win32' && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(timer); child.removeListener('close', finish); resolve() }
          const timer = setTimeout(finish, 2000)
          child.once('close', finish)
          child.stdin?.end()
        })
      }
      const stopped = await forceTerminateProcessTree(child)
      if (stopped) await service.stopped?.()
      return stopped
    })().catch(() => false)
    if (!await service.stopping) {
      service.state = { ...service.state, status: 'failed', detail: 'Tool termination could not be verified' }
      throw new Error(service.state.detail!)
    }
    service.state = { ...service.state, status: 'stopped', detail: null }
  }

  async close(): Promise<void> {
    this.closed = true
    const pending = [...this.preparing.values()]
    for (const setup of pending) setup.controller.abort()
    const results = await Promise.allSettled([...this.services.values()].map(service => this.stopOwned(service)))
    const setups = await Promise.allSettled(pending.map(setup => setup.promise))
    if (this.unverifiedSetups.size || results.some(result => result.status === 'rejected') || setups.some(result => result.status === 'rejected' && result.reason instanceof ProcessExecutionError && result.reason.kind === 'termination-unverified')) throw new Error('Some tool processes could not be stopped')
  }
}
