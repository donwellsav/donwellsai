import { WorktreeFiles } from './worktree-files'
import { artifactPath } from '@shared/project-export'
import { ensureEnvironmentArtifactParents } from './environment-artifact-files'
import { createConnection } from 'node:net'
import { remoteMemoryRequest } from './project-remote-memory'
import { createHash } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, relative, sep, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { probeLocalProcessLiveness } from '@shared/child-process/execution-host'
import { projectEnvironmentId, remoteMutation, type ProjectRemoteRequest, type ProjectRemoteOperation } from '@shared/project-environment'
import type { DaemonClient } from './daemon-client'

export type RemoteProjectMapping = { version: 1; environmentId: string; generation: number; projectId: string; root: string; stateDirectory: string; opencodeExecutable?: string }
type RemoteDaemon = Pick<DaemonClient, 'open' | 'list' | 'attach' | 'resize' | 'close' | 'writeAcknowledged'> & Partial<Pick<DaemonClient, 'startAgent' | 'authenticateAgent'>>
const dimension = (value: unknown): number => { if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 1000) throw new Error('Invalid terminal dimensions'); return Number(value) }

/** Mapping and parent directories are administrator-owned, outside the editable checkout. */
export function readRemoteProjectMapping(path: string): RemoteProjectMapping {
  if (!isAbsolute(path)) throw new Error('Forced command mapping requires an absolute path')
  for (let current = path; ; current = dirname(current)) {
    const stat = lstatSync(current)
    if (stat.isSymbolicLink() || stat.uid !== 0 || stat.mode & 0o022) throw new Error('Forced command mapping must be protected by administrator ownership')
    if (dirname(current) === current) break
  }
  if (lstatSync(path).size > 16 * 1024) throw new Error('Remote mapping exceeds limit')
  const mapping = JSON.parse(readFileSync(path, 'utf8')) as RemoteProjectMapping
  projectEnvironmentId(mapping.environmentId); projectEnvironmentId(mapping.projectId)
  if (mapping.version !== 1 || !Number.isSafeInteger(mapping.generation) || mapping.generation < 1 || !isAbsolute(mapping.root) || !isAbsolute(mapping.stateDirectory)) throw new Error('Invalid remote mapping')
  mapping.root = realpathSync(mapping.root)
  const rel = relative(mapping.root, mapping.stateDirectory)
  if (!rel || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))) throw new Error('Remote supervisor state cannot be inside the editable checkout')
  return mapping
}

/** This is a restricted facade over the existing per-project terminal daemon, not a second process owner. */
export class ProjectRemoteServer {
  private readonly journal: string
  private readonly files = new WorktreeFiles()
  constructor(private readonly mapping: RemoteProjectMapping, private readonly daemon: RemoteDaemon) {
    mkdirSync(mapping.stateDirectory, { recursive: true, mode: 0o700 })
    const directory = lstatSync(mapping.stateDirectory)
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o077 || process.getuid && directory.uid !== process.getuid()) throw new Error('Remote supervisor directory must be private and owned')
    const stateRelative = relative(realpathSync(mapping.root), realpathSync(mapping.stateDirectory))
    if (!stateRelative || (!stateRelative.startsWith('..' + sep) && stateRelative !== '..' && !isAbsolute(stateRelative))) throw new Error('Remote state resolved inside the editable checkout')
    this.journal = join(mapping.stateDirectory, 'remote-requests.sqlite')
    try { closeSync(openSync(this.journal, 'wx', 0o600)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const file = lstatSync(this.journal)
    if (!file.isFile() || file.isSymbolicLink() || file.mode & 0o077 || process.getuid && file.uid !== process.getuid()) throw new Error('Remote journal must be private and owned')
    this.db(db => db.exec('CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, hash TEXT NOT NULL, owner INTEGER NOT NULL, record TEXT NOT NULL); CREATE TABLE IF NOT EXISTS input_sequence (session_id TEXT PRIMARY KEY, next INTEGER NOT NULL)'))
  }
  private db<T>(fn: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(this.journal)
    try { db.exec('PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE'); const result = fn(db); db.exec('COMMIT'); return result } finally { db.close() }
  }
  private async session(id: unknown): Promise<string> {
    projectEnvironmentId(id)
    const session = (await this.daemon.list()).find(item => item.id === id)
    if (!session || session.worktreePath !== this.mapping.root) throw new Error('Terminal is not owned by this remote project')
    return String(id)
  }
  private operation(id: unknown): ProjectRemoteOperation {
    const row = this.db(db => db.prepare('SELECT owner,record FROM requests WHERE id=?').get(projectEnvironmentId(id)))
    if (!row) throw new Error('Remote operation was not found')
    const record = JSON.parse(String(row.record)) as ProjectRemoteOperation
    if (record.state === 'accepted' && probeLocalProcessLiveness(Number(row.owner)) !== 'live') {
      record.state = 'uncertain'; record.error = 'Remote dispatch owner was lost; operation will not be replayed'
      this.db(db => db.prepare('UPDATE requests SET record=? WHERE id=?').run(JSON.stringify(record), String(id)))
    }
    return record
  }
  async dispatch(request: ProjectRemoteRequest): Promise<unknown> {
    const m = this.mapping
    if (!request || request.version !== 1 || request.environmentId !== m.environmentId || request.generation !== m.generation || request.projectId !== m.projectId || request.remoteRoot !== m.root) throw new Error('Remote project identity, root, version or generation mismatch')
    projectEnvironmentId(request.requestId)
    if (!request.params || typeof request.params !== 'object' || Array.isArray(request.params) || Buffer.byteLength(JSON.stringify(request)) > 2 * 1024 * 1024) throw new Error('Invalid remote request parameters')
    const p = request.params
    if (request.method === 'hello') return { version: 1, environmentId: m.environmentId, generation: m.generation, projectId: m.projectId, root: m.root, os: process.platform, arch: process.arch, runtime: process.version, capabilities: ['terminal', 'ordered-input', 'operation-journal'], sharedMemory: false, memorySocket: join(m.stateDirectory, 'memory.sock') }
    if (request.method === 'result.read') {
      const path = artifactPath(p.path)
      let stat
      try { stat = lstatSync(join(m.root, path)) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false }; throw error }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.mode & 0o111) throw new Error('Result is not a non-executable regular file')
      const file = await this.files.readFile(m.root, path)
      if (file.binary || file.truncated || !file.revision) throw new Error('Result is not a complete text file')
      const after = lstatSync(join(m.root, path))
      if (after.ino !== stat.ino || after.dev !== stat.dev || after.nlink !== 1 || after.mode & 0o111) throw new Error('Result file changed during transfer')
      return { exists: true, content: file.content, revision: file.revision }
    }
    if (request.method === 'agent.authenticate') {
      if (!this.daemon.authenticateAgent) throw new Error('Remote agent authentication unavailable')
      const identity = await this.daemon.authenticateAgent(p.credential as Parameters<DaemonClient['authenticateAgent']>[0])
      if (identity.workspacePath !== m.root) throw new Error('Agent is not owned by this remote project')
      return identity
    }
    if (request.method === 'memory.probe') return remoteMemoryRequest(join(m.stateDirectory, 'memory.sock'), 'bridge.ping', { challenge: p.challenge }, {}, undefined, 1000)
    if (request.method === 'memory.prepare') {
      const path = join(m.stateDirectory, 'memory.sock')
      let before
      try { before = lstatSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
      if (!before.isSocket() || before.uid !== process.getuid?.()) throw new Error('Remote memory socket is not owned')
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection(path)
        socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('Existing memory listener is unverifiable')) })
        socket.on('connect', () => { socket.destroy(); reject(new Error('A memory bridge already owns this environment')) })
        socket.on('error', error => { socket.destroy(); if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') resolve(); else reject(error) })
      })
      const current = lstatSync(path)
      if (current.ino !== before.ino || current.dev !== before.dev || !current.isSocket()) throw new Error('Memory socket changed while inspecting it')
      unlinkSync(path); return {}
    }
    if (request.method === 'memory.status') {
      try { return { socketExists: lstatSync(join(m.stateDirectory, 'memory.sock')).isSocket() } } catch { return { socketExists: false } }
    }
    if (request.method === 'terminal.list') return (await this.daemon.list()).filter(item => item.worktreePath === m.root)
    if (request.method === 'terminal.observe') {
      const sessionId = await this.session(p.sessionId)
      return { ...await this.daemon.attach(sessionId), nextInputSequence: Number(this.db(db => db.prepare('SELECT next FROM input_sequence WHERE session_id=?').get(sessionId))?.next ?? 0) }
    }
    if (request.method === 'operation.get') return this.operation(p.requestId)
    if (!remoteMutation(request.method)) throw new Error('Unsupported remote method')
    const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex')
    const prior = this.db(db => db.prepare('SELECT hash FROM requests WHERE id=?').get(request.requestId))
    if (prior) { if (prior.hash !== hash) throw new Error('Remote request ID reused with different parameters'); return this.operation(request.requestId) }
    const sessionId = ['source.put', 'terminal.open', 'agent.start'].includes(request.method) ? undefined : await this.session(p.sessionId)
    if (request.method === 'terminal.open' || request.method === 'terminal.resize') { dimension(p.cols); dimension(p.rows) }
    if (request.method === 'terminal.write' && (typeof p.data !== 'string' || !p.data || Buffer.byteLength(p.data) > 64 * 1024 || !Number.isSafeInteger(p.sequence) || Number(p.sequence) < 0)) throw new Error('Invalid ordered terminal input')
    const record: ProjectRemoteOperation = { requestId: request.requestId, state: 'accepted', ...(sessionId ? { sessionId } : {}), ...(request.method === 'terminal.write' ? { sequence: Number(p.sequence) } : {}) }
    this.db(db => {
      if (Number(db.prepare('SELECT COUNT(*) AS count FROM requests').get()!.count) >= 10000) throw new Error('Remote request journal reached its limit')
      if (request.method === 'terminal.write') {
        if (db.prepare("SELECT id FROM requests WHERE json_extract(record,'$.sessionId')=? AND json_extract(record,'$.sequence') IS NOT NULL AND json_extract(record,'$.state')!='completed' LIMIT 1").get(sessionId!)) throw new Error('Previous terminal input is pending or uncertain; inspect its operation before further input')
        const next = Number(db.prepare('SELECT next FROM input_sequence WHERE session_id=?').get(sessionId!)?.next ?? 0)
        if (p.sequence !== next) throw new Error('Terminal input sequence mismatch; inspect the original operation')
        db.prepare('INSERT INTO input_sequence VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET next=excluded.next').run(sessionId!, next + 1)
      }
      db.prepare('INSERT INTO requests VALUES (?,?,?,?)').run(request.requestId, hash, process.pid, JSON.stringify(record))
    })
    try {
      let result: unknown
      if (request.method === 'source.put') {
        const path = artifactPath(p.path)
        if (typeof p.content !== 'string' || Buffer.byteLength(p.content) > 512 * 1024 || p.content.includes('\0') || p.revision !== 'sha256:' + createHash('sha256').update(p.content).digest('hex')) throw new Error('Source bytes do not match the selected revision')
        await ensureEnvironmentArtifactParents(this.files, m.root, path)
        await this.files.createWorkspaceEntry(m.root, { path, kind: 'file', content: p.content })
        result = { path, revision: p.revision }
      }
      else if (request.method === 'agent.start') {
        if (!m.opencodeExecutable || !isAbsolute(m.opencodeExecutable) || !this.daemon.startAgent) throw new Error('No administrator-paired OpenCode executable')
        result = await this.daemon.startAgent(m.root, 'opencode', 'opencode', { executable: m.opencodeExecutable, args: [m.root] })
      }
      else if (request.method === 'terminal.open') result = await this.daemon.open(m.root, Number(p.cols), Number(p.rows))
      else if (request.method === 'terminal.write') { await this.daemon.writeAcknowledged(sessionId!, String(p.data)); result = { sequence: p.sequence } }
      else if (request.method === 'terminal.resize') await this.daemon.resize(sessionId!, Number(p.cols), Number(p.rows))
      else await this.daemon.close(sessionId!)
      record.state = 'completed'; record.result = result ?? {}
    } catch (error) { record.state = 'uncertain'; record.error = String(error).slice(0, 1024) }
    this.db(db => db.prepare('UPDATE requests SET record=? WHERE id=?').run(JSON.stringify(record), request.requestId))
    return record
  }
}
