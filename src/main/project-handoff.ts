import { randomUUID } from 'node:crypto'
import type { ProjectHandoffApi, ProjectHandoffDraft, ProjectHandoffStatus } from '@shared/project-handoff'
import type { ProjectToolScope } from '@shared/project-tools'
import type { GitWorktrees } from './git'
import type { AgentRuntime } from './agent-runtime'
import type { AgentSessionCredential } from '@shared/agent-runtime'
import type { DaemonClient } from './daemon-client'
import { closeSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseProjectHandoff, type ProjectHandoff } from '@shared/project-handoff'
import { parseProjectMemoryIdentifier } from '@shared/project-memory'

/** Task handoffs are operational records, separate from permanent project facts.
 * Callers must bind project/session authority before accessing this store. */
export class ProjectHandoffStore {
  private readonly path: string
  constructor(private readonly userDataDir: string) { this.path = join(userDataDir, 'project-handoffs.sqlite') }

  // ponytail: short profile-wide transactions serialize reads with claims; split read connections if polling contends.
  private transaction<T>(action: (db: DatabaseSync) => T): T {
    mkdirSync(this.userDataDir, { recursive: true, mode: 0o700 })
    try { closeSync(openSync(this.path, 'wx', 0o600)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const file = lstatSync(this.path)
    if (!file.isFile() || file.isSymbolicLink() || (process.platform !== 'win32' && ((file.mode & 0o077) !== 0 || (process.getuid && file.uid !== process.getuid())))) throw new Error('Handoffs require a private regular file owned by the current user')
    const db = new DatabaseSync(this.path)
    try {
      db.exec('PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE')
      const version = db.prepare('PRAGMA user_version').get()!.user_version
      if (version !== 0 && version !== 1) throw new Error('Unsupported handoff storage version')
      if (version === 0) {
        if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length) throw new Error('Unrecognized handoff database; existing tables were left untouched')
        db.exec('CREATE TABLE handoffs (id TEXT PRIMARY KEY, project TEXT NOT NULL, document TEXT NOT NULL, claim_key TEXT, claim_revision INTEGER); PRAGMA user_version=1')
      }
      const result = action(db)
      db.exec('COMMIT')
      return result
    } finally { db.close() }
  }

  private read(db: DatabaseSync, projectKey: string, id: string): { handoff: ProjectHandoff; claimKey: string | null; claimRevision: number | null } {
    const row = db.prepare('SELECT document, claim_key, claim_revision FROM handoffs WHERE project=? AND id=?').get(projectKey, id)
    if (!row) throw new Error('Handoff not found in this project')
    const handoff = parseProjectHandoff(JSON.parse(String(row.document)))
    if (handoff.projectKey !== projectKey || handoff.id !== id) throw new Error('Handoff storage identity mismatch')
    return { handoff, claimKey: row.claim_key === null ? null : String(row.claim_key), claimRevision: row.claim_revision === null ? null : Number(row.claim_revision) }
  }

  create(value: ProjectHandoff): ProjectHandoff {
    const handoff = parseProjectHandoff(value)
    if (handoff.state !== 'open' || handoff.revision !== 1 || handoff.delivery !== 'not-sent' || handoff.acceptedBySessionId !== null) throw new Error('New handoffs must be open and undelivered')
    return this.transaction(db => {
      const count = db.prepare('SELECT count(*) AS total, sum(project=?) AS scoped FROM handoffs').get(handoff.projectKey)!
      if (Number(count.total) >= 10000 || Number(count.scoped) >= 2500) throw new Error('Handoff storage limit reached')
      db.prepare('INSERT INTO handoffs(id,project,document) VALUES (?,?,?)').run(handoff.id, handoff.projectKey, JSON.stringify(handoff))
      return handoff
    })
  }

  get(projectKey: string, id: string): ProjectHandoff { return this.transaction(db => this.read(db, projectKey, id).handoff) }

  list(projectKey: string): ProjectHandoff[] {
    return this.transaction(db => db.prepare('SELECT id FROM handoffs WHERE project=? ORDER BY rowid DESC LIMIT 2500').all(projectKey).map(row => this.read(db, projectKey, String(row.id)).handoff))
  }

  accept(projectKey: string, id: string, expectedRevision: number, sessionId: string, idempotencyKey: string): ProjectHandoff {
    parseProjectMemoryIdentifier(sessionId, 'receiving session')
    parseProjectMemoryIdentifier(idempotencyKey, 'idempotency key')
    return this.transaction(db => {
      const { handoff, claimKey, claimRevision } = this.read(db, projectKey, id)
      if (claimKey === idempotencyKey && claimRevision === expectedRevision && handoff.acceptedBySessionId === sessionId && handoff.state === 'accepted') return handoff
      if (handoff.revision !== expectedRevision || handoff.state !== 'open') throw new Error('Handoff changed or already claimed')
      const next = parseProjectHandoff({ ...handoff, state: 'accepted', acceptedBySessionId: sessionId, revision: handoff.revision + 1 })
      db.prepare('UPDATE handoffs SET document=?, claim_key=?, claim_revision=? WHERE project=? AND id=?').run(JSON.stringify(next), idempotencyKey, expectedRevision, projectKey, id)
      return next
    })
  }

  supersede(projectKey: string, id: string, expectedRevision: number): ProjectHandoff {
    return this.change(projectKey, id, expectedRevision, handoff => ({ ...handoff, state: 'superseded' }))
  }

  /** Persist uncertainty BEFORE attempting input. A retry must never blindly send again. */
  beginDelivery(projectKey: string, id: string, expectedRevision: number, sessionId: string): ProjectHandoff {
    return this.change(projectKey, id, expectedRevision, handoff => {
      if (handoff.state !== 'accepted' || handoff.acceptedBySessionId !== sessionId || handoff.delivery !== 'not-sent') throw new Error('Handoff is not ready for delivery')
      return { ...handoff, delivery: 'uncertain' }
    })
  }

  confirmDelivery(projectKey: string, id: string, expectedRevision: number, sessionId: string): ProjectHandoff {
    return this.transaction(db => {
      const { handoff } = this.read(db, projectKey, id)
      if (handoff.state !== 'accepted' || handoff.acceptedBySessionId !== sessionId) throw new Error('Handoff has no matching pending delivery')
      if (handoff.delivery === 'confirmed' && handoff.revision === expectedRevision + 1) return handoff
      if (handoff.delivery !== 'uncertain' || handoff.revision !== expectedRevision) throw new Error('Handoff has no matching pending delivery')
      const next = parseProjectHandoff({ ...handoff, delivery: 'confirmed', revision: handoff.revision + 1 })
      db.prepare('UPDATE handoffs SET document=? WHERE project=? AND id=?').run(JSON.stringify(next), projectKey, id)
      return next
    })
  }

  private change(projectKey: string, id: string, expectedRevision: number, update: (handoff: ProjectHandoff) => ProjectHandoff): ProjectHandoff {
    return this.transaction(db => {
      const { handoff } = this.read(db, projectKey, id)
      if (handoff.revision !== expectedRevision || handoff.state === 'superseded') throw new Error('Handoff revision changed or was superseded')
      const next = parseProjectHandoff({ ...update(handoff), revision: handoff.revision + 1 })
      db.prepare('UPDATE handoffs SET document=? WHERE project=? AND id=?').run(JSON.stringify(next), projectKey, id)
      return next
    })
  }
}


/** Desktop authority boundary. Native delivery and external MCP claims require separate binding. */
export class ProjectHandoffService implements ProjectHandoffApi {
  private readonly store: ProjectHandoffStore
  constructor(userDataDir: string, private readonly resolveScope: (path: string) => Promise<ProjectToolScope>, private readonly git: Pick<GitWorktrees, 'handoffSource'>, private readonly agents: Pick<AgentRuntime, 'list'>) {
    this.store = new ProjectHandoffStore(userDataDir)
  }

  async projectHandoffList(workspacePath: string): Promise<ProjectHandoff[]> {
    const scope = await this.resolveScope(workspacePath)
    return this.store.list(scope.projectKey)
  }

  async projectHandoffGet(workspacePath: string, id: string): Promise<ProjectHandoffStatus> {
    const scope = await this.resolveScope(workspacePath)
    const handoff = this.store.get(scope.projectKey, id)
    try {
      const source = await this.resolveScope(handoff.checkoutPath)
      if (source.projectKey !== scope.projectKey) throw new Error('Source checkout belongs to a different project')
      const snapshot = await this.git.handoffSource(source.checkoutPath)
      return { handoff, stale: snapshot.contentFingerprint !== handoff.contentFingerprint }
    } catch (error) {
      return { handoff, stale: true, sourceError: error instanceof Error ? error.message : String(error) }
    }
  }

  private async session(scope: ProjectToolScope, sessionId: string, live: boolean) {
    parseProjectMemoryIdentifier(sessionId, 'session')
    const session = (await this.agents.list()).find(run => run.sessionId === sessionId)
    if (!session || (live && session.liveness !== 'live')) throw new Error('Select an available agent session')
    const target = await this.resolveScope(session.workspacePath)
    if (target.projectKey !== scope.projectKey) throw new Error('Agent session belongs to another project')
    return target
  }

  async projectHandoffCreate(workspacePath: string, draft: ProjectHandoffDraft): Promise<ProjectHandoff> {
    const fields = ['taskId', 'fromSessionId', 'toAgent', 'goal', 'summary', 'openQuestions', 'nextSteps', 'evidenceIds']
    if (!draft || typeof draft !== 'object' || Array.isArray(draft) || Object.keys(draft).length !== fields.length || fields.some(field => !Object.hasOwn(draft, field))) throw new Error('Invalid handoff draft fields')
    const scope = await this.resolveScope(workspacePath)
    const source = await this.session(scope, draft.fromSessionId, false)
    if (source.checkoutPath !== scope.checkoutPath) throw new Error('Select the source session checkout before saving its handoff')
    const snapshot = await this.git.handoffSource(scope.checkoutPath)
    return this.store.create(parseProjectHandoff({ ...draft, ...snapshot, id: randomUUID(), projectKey: scope.projectKey, checkoutPath: scope.checkoutPath, state: 'open', delivery: 'not-sent', revision: 1, acceptedBySessionId: null }))
  }

  async projectHandoffAccept(workspacePath: string, id: string, expectedRevision: number, sessionId: string, idempotencyKey: string): Promise<ProjectHandoff> {
    const scope = await this.resolveScope(workspacePath)
    const current = this.store.get(scope.projectKey, id)
    if (current.state === 'accepted') return this.store.accept(scope.projectKey, id, expectedRevision, sessionId, idempotencyKey)
    await this.session(scope, sessionId, true)
    const status = await this.projectHandoffGet(workspacePath, id)
    if (status.stale) throw new Error('Handoff source changed or is unavailable; review and save a fresh handoff')
    await this.session(scope, sessionId, true)
    return this.store.accept(scope.projectKey, id, expectedRevision, sessionId, idempotencyKey)
  }

  /** Tool delivery returns the saved context only to its authenticated receiving session.
   * Uncertainty is durable before the response leaves this process. */
  async receive(authenticate: DaemonClient['authenticateAgent'], credential: AgentSessionCredential, workspacePath: string, id: string, expectedRevision: number): Promise<ProjectHandoff> {
    const run = await authenticate(credential)
    const scope = await this.resolveScope(workspacePath)
    if ((await this.resolveScope(run.workspacePath)).projectKey !== scope.projectKey) throw new Error('Agent session belongs to another project')
    const status = await this.projectHandoffGet(scope.checkoutPath, id)
    if (status.stale) throw new Error('Handoff source changed or is unavailable; inspect before delivery')
    await authenticate(credential)
    return this.store.beginDelivery(scope.projectKey, id, expectedRevision, run.sessionId)
  }

  /** A separate tool invocation acknowledges receipt; PTY writes cannot call this path. */
  async acknowledge(authenticate: DaemonClient['authenticateAgent'], credential: AgentSessionCredential, workspacePath: string, id: string, expectedRevision: number): Promise<ProjectHandoff> {
    const run = await authenticate(credential)
    const scope = await this.resolveScope(workspacePath)
    if ((await this.resolveScope(run.workspacePath)).projectKey !== scope.projectKey) throw new Error('Agent session belongs to another project')
    return this.store.confirmDelivery(scope.projectKey, id, expectedRevision, run.sessionId)
  }

  async projectHandoffSupersede(workspacePath: string, id: string, expectedRevision: number): Promise<ProjectHandoff> {
    const scope = await this.resolveScope(workspacePath)
    return this.store.supersede(scope.projectKey, id, expectedRevision)
  }
}
