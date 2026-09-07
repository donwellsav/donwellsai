import { createHash, randomUUID } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { projectEnvironmentId, remoteMutation, type ProjectEnvironment, type ProjectRemoteMethod, type ProjectRemoteRequest, type SshEnvironmentConfig } from '@shared/project-environment'
import { parseProjectMemoryListRequest, parseProjectMemoryGetRequest, parseProjectMemoryCreateRequest, parseProjectMemoryUpdateRequest, parseProjectMemoryHistoryRequest, parseProjectMemoryArchiveRequest, type ProjectMemoryApi } from '@shared/project-memory'
import type { AgentSessionCredential } from '@shared/agent-runtime'
import type { ProjectToolScope } from '@shared/project-tools'
import { requestProjectRemote, validateSshConfig } from './project-remote'

type Transport = typeof requestProjectRemote
/** Registered-project authority is re-resolved for every dispatch; SSH never receives the app RPC credential. */
export class ProjectEnvironments {
  private readonly removing = new Set<string>()
  private readonly requests = new Map<string, number>()
  private readonly directory: string
  private readonly database: string
  constructor(userDataDir: string, private readonly scope: (path: string) => Promise<ProjectToolScope>, private readonly transport: Transport = requestProjectRemote, private readonly memory?: ProjectMemoryApi) {
    this.directory = join(userDataDir, 'project-environments')
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const directory = lstatSync(this.directory)
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o077 || process.getuid && directory.uid !== process.getuid()) throw new Error('Environment directory must be private and owned')
    this.database = join(this.directory, 'environments.sqlite')
    try { closeSync(openSync(this.database, 'wx', 0o600)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const file = lstatSync(this.database)
    if (!file.isFile() || file.isSymbolicLink() || file.mode & 0o077 || process.getuid && file.uid !== process.getuid()) throw new Error('Environment store must be private and owned')
    this.db(db => db.exec("CREATE TABLE IF NOT EXISTS environments (id TEXT PRIMARY KEY, record TEXT NOT NULL); CREATE TABLE IF NOT EXISTS memory_requests (environment_id TEXT NOT NULL, id TEXT NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL, receipt TEXT, PRIMARY KEY(environment_id,id)); UPDATE memory_requests SET state='uncertain' WHERE state='accepted'"))
  }
  private db<T>(fn: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(this.database)
    try { db.exec('PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE'); const result = fn(db); db.exec('COMMIT'); return result } finally { db.close() }
  }
  private read(id: string): ProjectEnvironment | undefined {
    const row = this.db(db => db.prepare('SELECT record FROM environments WHERE id=?').get(projectEnvironmentId(id)))
    return row ? JSON.parse(String(row.record)) as ProjectEnvironment : undefined
  }
  private save(record: ProjectEnvironment): ProjectEnvironment {
    if (this.read(record.id)?.retired) throw new Error('Environment binding was removed; use a new ID')
    this.db(db => db.prepare('INSERT INTO environments VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(record.id, JSON.stringify(record)))
    return record
  }
  async list(workspacePath: string): Promise<ProjectEnvironment[]> {
    const scope = await this.scope(workspacePath)
    return this.db(db => db.prepare('SELECT record FROM environments').all().map(row => JSON.parse(String(row.record)) as ProjectEnvironment).filter(item => !item.retired && item.projectKey === scope.projectKey && item.checkoutPath === scope.checkoutPath))
  }
  async get(workspacePath: string, id: string, generation: number): Promise<ProjectEnvironment> { return this.require(workspacePath, id, generation) }
  trustFile(id: string): string { return this.knownHosts(id) }

  private async require(workspacePath: string, id: string, generation: number): Promise<ProjectEnvironment> {
    const scope = await this.scope(workspacePath), record = this.read(id)
    if (this.removing.has(id)) throw new Error('Environment removal is in progress')
    if (!record || record.retired || record.projectKey !== scope.projectKey || record.checkoutPath !== scope.checkoutPath || record.generation !== generation) throw new Error('Environment project or generation mismatch')
    return record
  }
  async configure(workspacePath: string, id: string, config: SshEnvironmentConfig): Promise<ProjectEnvironment> {
    projectEnvironmentId(id)
    const scope = await this.scope(workspacePath), validated = validateSshConfig(config), prior = this.read(id)
    // ponytail: immutable pairing avoids losing live remote owners during configuration changes; explicit migration can be added after remote lifecycle qualification.
    if (prior) {
      if (prior.retired) throw new Error('Environment binding was removed; use a new ID')
      if (prior.projectKey !== scope.projectKey || prior.checkoutPath !== scope.checkoutPath || JSON.stringify(prior.config) !== JSON.stringify(validated)) throw new Error('Existing environment pairing cannot be reassigned')
      return prior
    }
    const knownHosts = this.knownHosts(id)
    const host = validated.port === 22 ? validated.hostname : '[' + validated.hostname + ']:' + validated.port
    const hostLine = host + ' ' + validated.hostKey + '\n'
    try { writeFileSync(knownHosts, hostLine, { mode: 0o600, flag: 'wx', flush: true }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || lstatSync(knownHosts).isSymbolicLink() || readFileSync(knownHosts, 'utf8') !== hostLine) throw error
    }
    return this.save({ id, generation: 1, projectKey: scope.projectKey, checkoutPath: scope.checkoutPath, state: 'configured', config: validated })
  }
  private knownHosts(id: string): string { return join(this.directory, projectEnvironmentId(id) + '.known_hosts') }
  async pause(workspacePath: string, id: string, generation: number): Promise<ProjectEnvironment> {
    return this.save({ ...await this.require(workspacePath, id, generation), state: 'paused' })
  }
  async remove(workspacePath: string, id: string, generation: number): Promise<void> {
    const record = await this.require(workspacePath, id, generation)
    if (record.state !== 'paused' || this.requests.has(id)) throw new Error('Pause and finish environment requests before removing its binding')
    this.removing.add(id)
    try {
      const sessions = await this.call(record, 'terminal.list', {}, randomUUID(), undefined, true) as Array<{ exited: boolean }>
      if (!Array.isArray(sessions) || sessions.some(session => session.exited !== true)) throw new Error('Stop remote terminals before removing this binding')
      if (this.db(db => db.prepare("SELECT 1 FROM memory_requests WHERE environment_id=? AND state='accepted' LIMIT 1").get(id))) throw new Error('Wait for the pending memory operation before removing this binding')
      // ponytail: retain the existing record so stale generations cannot revive a removed pairing.
      this.save({ ...record, retired: true })
    } finally { this.removing.delete(id) }
  }
  async connect(workspacePath: string, id: string, generation: number, signal?: AbortSignal): Promise<ProjectEnvironment> {
    const record = await this.require(workspacePath, id, generation)
    try {
      const hello = await this.call(record, 'hello', {}, randomUUID(), signal) as Record<string, unknown>
      const capabilities = hello.capabilities
      if (hello.projectId !== record.config.remoteProjectId || hello.root !== record.config.remoteRoot || hello.environmentId !== id || hello.generation !== generation || hello.version !== 1 || !['darwin', 'linux'].includes(String(hello.os)) || hello.arch !== 'arm64' || typeof hello.runtime !== 'string' || !/^v24\./.test(hello.runtime) || !Array.isArray(capabilities) || !['terminal', 'ordered-input', 'operation-journal'].every(capability => capabilities.includes(capability))) throw new Error('Remote handshake does not match the pairing')
      const current = await this.require(workspacePath, id, generation)
      if (current.state !== record.state) return current
      return this.save({ ...record, state: 'ready', detail: undefined })
    } catch (error) { this.save({ ...record, state: 'unverifiable', detail: String(error).slice(0, 1024) }); throw error }
  }
  private async call(record: ProjectEnvironment, method: ProjectRemoteMethod, params: Record<string, unknown>, requestId: string, signal?: AbortSignal, removing = false): Promise<unknown> {
    if (this.read(record.id)?.retired || this.removing.has(record.id) && !removing) throw new Error('Environment binding is removed or being removed')
    projectEnvironmentId(requestId)
    const request: ProjectRemoteRequest = { version: 1, environmentId: record.id, generation: record.generation, projectId: record.config.remoteProjectId, remoteRoot: record.config.remoteRoot, requestId, method, params }
    const knownHosts = this.knownHosts(record.id), file = lstatSync(knownHosts)
    if (!file.isFile() || file.isSymbolicLink() || file.mode & 0o077 || process.getuid && file.uid !== process.getuid()) throw new Error('Environment host trust file is not private')
    const host = record.config.port === 22 ? record.config.hostname : '[' + record.config.hostname + ']:' + record.config.port
    if (readFileSync(knownHosts, 'utf8') !== host + ' ' + record.config.hostKey + '\n') throw new Error('Environment host trust file changed')
    this.requests.set(record.id, (this.requests.get(record.id) ?? 0) + 1)
    try { return await this.transport(record, knownHosts, request, signal) }
    finally { const count = this.requests.get(record.id)! - 1; if (count) this.requests.set(record.id, count); else this.requests.delete(record.id) }
  }
  async invokeMemory(workspacePath: string, id: string, generation: number, requestId: string, method: string, params: Record<string, unknown>, credential: AgentSessionCredential): Promise<unknown> {
    const environment = await this.require(workspacePath, id, generation)
    if (environment.state !== 'ready' || !this.memory) throw new Error('Shared project memory is disconnected or paused')
    if (!['memory.operation', 'memory.list', 'memory.get', 'memory.history', 'memory.create', 'memory.update', 'memory.archive'].includes(method)) throw new Error('Remote bridge exposes only project memory methods')
    await this.call(environment, 'agent.authenticate', { credential }, randomUUID())
    if ((await this.require(workspacePath, id, generation)).state !== 'ready') throw new Error('Shared project memory was paused during authentication')
    projectEnvironmentId(requestId)
    if (method === 'memory.operation') {
      const operation = this.db(db => db.prepare('SELECT state,receipt FROM memory_requests WHERE environment_id=? AND id=?').get(id, projectEnvironmentId(params.requestId)))
      if (!operation) throw new Error('Memory operation was not found')
      return { requestId: params.requestId, state: operation.state, receipt: operation.receipt ? JSON.parse(String(operation.receipt)) : null }
    }
    const input = { ...params, workspacePath: environment.checkoutPath }
    const mutate = ['memory.create', 'memory.update', 'memory.archive'].includes(method)
    const hash = createHash('sha256').update(JSON.stringify({ generation, method, input, runId: credential.runId, sessionId: credential.sessionId })).digest('hex')
    if (mutate) {
      const prior = this.db(db => db.prepare('SELECT hash,state,receipt FROM memory_requests WHERE environment_id=? AND id=?').get(id, requestId))
      if (prior) {
        if (prior.hash !== hash) throw new Error('Memory request ID was reused with different parameters')
        if (prior.state !== 'completed') throw new Error('Previous memory mutation is pending or uncertain; it will not be replayed')
        return { alreadyCompleted: true, ...JSON.parse(String(prior.receipt)) }
      }
      this.db(db => {
        if (Number(db.prepare('SELECT COUNT(*) AS count FROM memory_requests').get()!.count) >= 10000) throw new Error('Environment memory journal reached its limit')
        db.prepare('INSERT INTO memory_requests VALUES (?,?,?,?,NULL)').run(id, requestId, hash, 'accepted')
      })
    }
    try {
      const result = method === 'memory.list' ? await this.memory.projectMemoryList(parseProjectMemoryListRequest(input))
        : method === 'memory.get' ? await this.memory.projectMemoryGet(parseProjectMemoryGetRequest(input))
        : method === 'memory.history' ? await this.memory.projectMemoryHistory(parseProjectMemoryHistoryRequest(input))
        : method === 'memory.create' ? await this.memory.projectMemoryCreate(parseProjectMemoryCreateRequest(input))
        : method === 'memory.update' ? await this.memory.projectMemoryUpdate(parseProjectMemoryUpdateRequest(input))
        : await this.memory.projectMemoryArchive(parseProjectMemoryArchiveRequest(input))
      if (mutate) {
        const entry = result as { id: string; revision: number }
        this.db(db => db.prepare("UPDATE memory_requests SET state='completed',receipt=? WHERE environment_id=? AND id=?").run(JSON.stringify({ id: entry.id, revision: entry.revision }), id, requestId))
      }
      return result
    } catch (error) {
      if (mutate) this.db(db => db.prepare("UPDATE memory_requests SET state='uncertain' WHERE environment_id=? AND id=?").run(id, requestId))
      throw error
    }
  }

  async request(workspacePath: string, id: string, generation: number, method: ProjectRemoteMethod, params: Record<string, unknown>, requestId: string, signal?: AbortSignal): Promise<unknown> {
    const record = await this.require(workspacePath, id, generation)
    if (remoteMutation(method) && method !== 'terminal.stop' && record.state !== 'ready') throw new Error('Connect or resume this environment before dispatching work')
    return this.call(record, method, params, requestId, signal)
  }
}
