import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { logger } from '@shared/logger'
import type { McpServer } from '@agentclientprotocol/sdk'
import type { AcpAgentSnapshot, AcpObservation, AcpPromptRecord, AgentExecutable, AuthenticatedAgentSession, AgentModeSwitchReceipt } from '@shared/agent-runtime'
import { probeLocalProcessLiveness } from '@shared/child-process/execution-host'
import { AcpAgent } from './acp'

const identifier = (id: string) => { if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid ACP identifier'); return id }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Daemon-owned protocol sessions; journal intent before sending any prompt. */
export class AcpSessions {
  private readonly path: string
  private readonly owners = new Map<string, AcpAgent>()
  private readonly starting = new Map<string, AbortController>()
  private readonly stopping = new Set<string>()
  private readonly lastSaved = new Map<string, string>()
  private readonly credentials = new Map<string, string>()
  private readonly switching = new Set<string>()

  constructor(userDataDir: string, private readonly changed: (snapshot: AcpAgentSnapshot) => void) {
    mkdirSync(userDataDir, { recursive: true, mode: 0o700 })
    this.path = join(userDataDir, 'acp-sessions.sqlite')
    try { closeSync(openSync(this.path, 'wx', 0o600)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const file = lstatSync(this.path)
    if (!file.isFile() || file.isSymbolicLink() || (process.platform !== 'win32' && ((file.mode & 0o077) !== 0 || (process.getuid && file.uid !== process.getuid())))) throw new Error('ACP journal requires a private regular file owned by the current user')
    this.transaction(db => {
      const version = Number(db.prepare('PRAGMA user_version').get()!.user_version)
      if (version !== 0 && version !== 1) throw new Error('Unsupported ACP journal version')
      if (!version) {
        if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length) throw new Error('Unrecognized ACP journal')
        db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, launch_hash TEXT NOT NULL, snapshot TEXT NOT NULL, dismissed INTEGER NOT NULL DEFAULT 0); CREATE TABLE requests (run_id TEXT NOT NULL, id TEXT NOT NULL, payload_hash TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY (run_id,id)); PRAGMA user_version=1')
      }
      for (const row of db.prepare('SELECT id,snapshot FROM sessions').all()) {
        const snapshot = JSON.parse(String(row.snapshot)) as AcpAgentSnapshot
        if (snapshot.state !== 'exited') {
          snapshot.state = 'uncertain'; snapshot.permissions = []; snapshot.detail = 'Previous daemon ownership was lost. Work will not be replayed.'
          db.prepare('UPDATE sessions SET snapshot=? WHERE id=?').run(JSON.stringify(snapshot), String(row.id))
        }
      }
      for (const row of db.prepare('SELECT run_id,id,record FROM requests').all()) {
        const record = JSON.parse(String(row.record)) as AcpPromptRecord
        if (record.state === 'accepted') { record.state = 'uncertain'; record.error = 'Daemon restarted before the outcome was recorded'; db.prepare('UPDATE requests SET record=? WHERE run_id=? AND id=?').run(JSON.stringify(record), String(row.run_id), String(row.id)) }
      }
    })
  }

  private transaction<T>(fn: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(this.path)
    try { db.exec('PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE'); const result = fn(db); db.exec('COMMIT'); return result }
    finally { db.close() }
  }

  private saved(workspacePath: string, id: string): AcpAgentSnapshot {
    const row = this.transaction(db => db.prepare('SELECT snapshot FROM sessions WHERE workspace=? AND id=?').get(workspacePath, identifier(id)))
    if (!row) throw new Error('ACP session is not owned by this workspace')
    return JSON.parse(String(row.snapshot)) as AcpAgentSnapshot
  }

  private save(snapshot: AcpAgentSnapshot): void {
    if (snapshot.state === 'exited' || snapshot.state === 'uncertain') this.credentials.delete(snapshot.id)
    const value = JSON.stringify(snapshot)
    if (this.lastSaved.get(snapshot.id) !== value) {
      this.transaction(db => db.prepare('UPDATE sessions SET snapshot=? WHERE id=? AND workspace=?').run(value, snapshot.id, snapshot.workspacePath))
      this.lastSaved.set(snapshot.id, value)
    }
    this.changed(snapshot)
  }

  list(workspacePath?: string): AcpAgentSnapshot[] {
    return this.transaction(db => (workspacePath ? db.prepare('SELECT snapshot FROM sessions WHERE workspace=? AND dismissed=0').all(workspacePath) : db.prepare('SELECT snapshot FROM sessions WHERE dismissed=0').all()).map(row => JSON.parse(String(row.snapshot)) as AcpAgentSnapshot))
  }

  hasOwnedSessions(): boolean { return this.starting.size > 0 || this.switching.size > 0 || this.list().some(run => run.state !== 'exited' && run.pid !== null && probeLocalProcessLiveness(run.pid) !== 'exited') }

  isSwitching(sessionId: string): boolean { return this.switching.has(sessionId) }

  ownsHistory(workspacePath: string, protocolSessionId: string): boolean {
    return this.list(workspacePath).some(run => run.protocolSessionId === protocolSessionId && run.state !== 'exited' && (!run.pid || probeLocalProcessLiveness(run.pid) !== 'exited'))
  }

  switchResult(workspacePath: string, requestId: string): AgentModeSwitchReceipt {
    const row = this.transaction(db => db.prepare("SELECT record FROM requests WHERE run_id='@switch' AND id=?").get(identifier(requestId)))
    if (!row) throw new Error('Mode switch was not found')
    const record = JSON.parse(String(row.record)) as AgentModeSwitchReceipt
    if (record.workspacePath !== workspacePath) throw new Error('Mode switch belongs to another workspace')
    return record
  }

  switchMode(workspacePath: string, sessionId: string, requestId: string, target: 'native' | 'acp', context: string | undefined, execute: () => Promise<Pick<AgentModeSwitchReceipt, 'native' | 'acp'>>): AgentModeSwitchReceipt {
    identifier(requestId); identifier(sessionId)
    if (context !== undefined && (typeof context !== 'string' || Buffer.byteLength(context) > 64 * 1024)) throw new Error('Reviewed mode-switch context exceeds limit')
    const payloadHash = hash({ workspacePath, sessionId, target, context })
    const row = this.transaction(db => db.prepare("SELECT payload_hash,record FROM requests WHERE run_id='@switch' AND id=?").get(requestId))
    if (row) {
      if (row.payload_hash !== payloadHash) throw new Error('Mode-switch request ID was already used with different parameters')
      return JSON.parse(String(row.record)) as AgentModeSwitchReceipt
    }
    if (this.switching.has(sessionId)) throw new Error('This session already has a mode switch in progress')
    const record: AgentModeSwitchReceipt = { workspacePath, sessionId, requestId, target, state: 'accepted', continuity: target === 'native' ? 'same-history' : 'new-session' }
    this.transaction(db => {
      if (Number(db.prepare('SELECT COUNT(*) AS count FROM requests').get()!.count) >= 10000) throw new Error('ACP journal reached its request limit')
      db.prepare('INSERT INTO requests VALUES (?,?,?,?)').run('@switch', requestId, payloadHash, JSON.stringify(record))
    })
    this.switching.add(sessionId)
    const finish = (result: AgentModeSwitchReceipt) => this.transaction(db => db.prepare("UPDATE requests SET record=? WHERE run_id='@switch' AND id=?").run(JSON.stringify(result), requestId))
    void Promise.resolve().then(execute).then(result => finish({ ...record, ...result, state: 'completed' }), error => finish({ ...record, state: 'uncertain', error: String(error).slice(0, 1024) })).catch(error => logger.error({ err: error }, 'Mode-switch outcome could not be persisted')).finally(() => this.switching.delete(sessionId))
    return record
  }

  authenticate(runId: string, sessionId: string, token: string): AuthenticatedAgentSession | undefined {
    const expected = this.credentials.get(runId), owner = this.owners.get(runId)
    if (!expected || sessionId !== runId || typeof token !== 'string' || Buffer.byteLength(token) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(token), Buffer.from(expected)) || !owner) return undefined
    const snapshot = owner.get()
    if (!['ready', 'working', 'permission'].includes(snapshot.state) || !snapshot.pid || probeLocalProcessLiveness(snapshot.pid) !== 'live') return undefined
    return { id: runId, sessionId, workspacePath: snapshot.workspacePath, liveness: 'live', mode: 'acp' }
  }

  start(workspacePath: string, id: string, launch: AgentExecutable, mcpServers: McpServer[], loadRunId?: string, initialContext?: string): AcpAgentSnapshot {
    identifier(id); workspacePath = realpathSync(workspacePath)
    if (initialContext !== undefined && (typeof initialContext !== 'string' || Buffer.byteLength(initialContext) > 64 * 1024)) throw new Error('Invalid initial context')
    const launchHash = hash({ workspacePath, launch, loadRunId, initialContext })
    const existing = this.transaction(db => db.prepare('SELECT workspace,launch_hash,snapshot FROM sessions WHERE id=?').get(id))
    if (existing) {
      if (existing.workspace !== workspacePath || existing.launch_hash !== launchHash) throw new Error('ACP start ID was already used with different parameters')
      return JSON.parse(String(existing.snapshot)) as AcpAgentSnapshot
    }
    let loadSessionId: string | undefined
    if (loadRunId) {
      const prior = this.saved(workspacePath, loadRunId)
      if (this.starting.has(loadRunId) || prior.pid && probeLocalProcessLiveness(prior.pid) !== 'exited') throw new Error('Previous ACP process must be verified stopped before loading its session')
      if (!prior.protocolSessionId) throw new Error('Previous ACP session has no protocol history to load')
      loadSessionId = prior.protocolSessionId
    }
    const initial: AcpAgentSnapshot = { mode: 'acp', id, workspacePath, protocolSessionId: loadSessionId ?? null, pid: null, state: 'starting', capabilities: {}, permissions: [] }
    this.transaction(db => db.prepare('INSERT INTO sessions (id,workspace,launch_hash,snapshot) VALUES (?,?,?,?)').run(id, workspacePath, launchHash, JSON.stringify(initial)))
    const token = randomBytes(32).toString('hex')
    this.credentials.set(id, token)
    const credentialEnv = { DONWELLS_AGENT_HOOK_RUN_ID: id, DONWELLS_AGENT_HOOK_SESSION_ID: id, DONWELLS_AGENT_HOOK_TOKEN: token }
    const scopedServers = mcpServers.map(server => server.name === 'donwells-project-memory' && 'command' in server ? { ...server, env: [...server.env.filter(item => !Object.hasOwn(credentialEnv, item.name)), ...Object.entries(credentialEnv).map(([name, value]) => ({ name, value }))] } : server)
    const controller = new AbortController()
    this.starting.set(id, controller)
    const start = async () => {
      if (loadRunId) {
        // A lost prompt stays uncertain; finish its process cleanup without deleting its journal.
        await this.owners.get(loadRunId)?.stop()
        const prior = this.saved(workspacePath, loadRunId)
        if (prior.pid && probeLocalProcessLiveness(prior.pid) !== 'exited') throw new Error('Previous ACP process termination could not be verified')
      }
      return AcpAgent.start({ id, signal: controller.signal, workspacePath, launch, mcpServers: scopedServers, loadSessionId, onChange: snapshot => this.save(snapshot) })
    }
    void start().then(async owner => {
      this.owners.set(id, owner)
      if (this.stopping.has(id)) await owner.stop()
      else if (initialContext?.trim()) this.prompt(workspacePath, id, 'reviewed-context', initialContext)
    }).catch(error => {
      const snapshot = this.saved(workspacePath, id)
      this.save({ ...snapshot, state: snapshot.pid && probeLocalProcessLiveness(snapshot.pid) !== 'exited' ? 'uncertain' : 'exited', permissions: [], detail: String(error) })
    }).finally(() => { this.starting.delete(id); this.stopping.delete(id) })
    return this.saved(workspacePath, id)
  }

  observe(workspacePath: string, id: string, afterSequence = 0): AcpObservation {
    const snapshot = this.saved(workspacePath, id)
    const current = this.owners.get(id)?.observe(afterSequence) ?? { snapshot, sequence: 0, updates: [], truncated: true }
    const requests = this.transaction(db => db.prepare('SELECT record FROM requests WHERE run_id=? ORDER BY rowid DESC LIMIT 100').all(id).map(row => JSON.parse(String(row.record)) as AcpPromptRecord))
    return { ...current, requests }
  }

  prompt(workspacePath: string, id: string, requestId: string, text: string): AcpPromptRecord {
    this.saved(workspacePath, id); identifier(requestId)
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 64 * 1024) throw new Error('Invalid ACP prompt size')
    const payloadHash = hash(text)
    const existing = this.transaction(db => db.prepare('SELECT payload_hash,record FROM requests WHERE run_id=? AND id=?').get(id, requestId))
    if (existing) {
      if (existing.payload_hash !== payloadHash) throw new Error('ACP request ID was already used for a different prompt')
      return JSON.parse(String(existing.record)) as AcpPromptRecord
    }
    const owner = this.owners.get(id)
    if (this.switching.has(id)) throw new Error('Session is switching modes')
    if (!owner || owner.get().state !== 'ready') throw new Error('ACP owner is not ready; existing work was not replayed')
    const record: AcpPromptRecord = { requestId, state: 'accepted' }
    this.transaction(db => {
      if (Number(db.prepare('SELECT COUNT(*) AS count FROM requests').get()!.count) >= 10000) throw new Error('ACP journal reached 10000 requests. Dismiss reviewed, stopped sessions before sending more prompts.')
      db.prepare('INSERT INTO requests VALUES (?,?,?,?)').run(id, requestId, payloadHash, JSON.stringify(record))
    })
    const finish = (result: AcpPromptRecord) => this.transaction(db => db.prepare('UPDATE requests SET record=? WHERE run_id=? AND id=?').run(JSON.stringify(result), id, requestId))
    void owner.prompt(text).then(result => finish({ requestId, state: 'completed', result: { stopReason: result.stopReason } }), error => finish({ requestId, state: 'uncertain', error: String(error).slice(0, 1024) })).catch(error => { this.save({ ...owner.get(), state: 'uncertain', detail: `ACP outcome could not be saved: ${String(error).slice(0, 1024)}` }); void owner.stop().catch(() => {}) })
    return record
  }

  async control(workspacePath: string, id: string, operation: 'stop' | 'cancel' | 'permission' | 'dismiss', permissionId?: string, optionId?: string): Promise<AcpAgentSnapshot> {
    const saved = this.saved(workspacePath, id), owner = this.owners.get(id)
    if (operation === 'dismiss') {
      if (this.starting.has(id) || saved.pid && probeLocalProcessLiveness(saved.pid) !== 'exited') throw new Error('ACP process remains live or unverifiable')
      this.transaction(db => { db.prepare('DELETE FROM requests WHERE run_id=?').run(id); db.prepare('UPDATE sessions SET dismissed=1 WHERE id=?').run(id) })
      this.owners.delete(id); this.lastSaved.delete(id)
      this.credentials.delete(id)
      return saved
    }
    if (operation === 'stop' && this.starting.has(id)) { this.stopping.add(id); this.starting.get(id)!.abort(); return this.saved(workspacePath, id) }
    if (!owner) {
      if (operation === 'stop' && (!saved.pid || probeLocalProcessLiveness(saved.pid) === 'exited')) { const stopped = { ...saved, state: 'exited' as const }; this.save(stopped); return stopped }
      throw new Error('ACP process ownership is unavailable; no input or signal was sent')
    }
    if (operation === 'permission') owner.answerPermission(identifier(permissionId!), optionId ?? null)
    else if (operation === 'cancel') await owner.cancel()
    else await owner.stop()
    return owner.get()
  }
}
