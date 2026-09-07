import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import type { HandoffMemoryStatus, ProjectHandoffApi, ProjectHandoffDraft, ProjectHandoffStatus } from '@shared/project-handoff'
import type { ProjectToolScope } from '@shared/project-tools'
import type { GitWorktrees } from './git'
import type { AgentDeliveryApi } from '@shared/agent-delivery'
import type { AgentRuntime } from './agent-runtime'
import type { AgentSessionCredential } from '@shared/agent-runtime'
import type { DaemonClient } from './daemon-client'
import { closeSync, lstatSync, mkdirSync, openSync, writeFileSync, readFileSync, fsyncSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseHandoffMemorySources, parseProjectHandoff, type ProjectHandoff } from '@shared/project-handoff'
import { parseProjectMemoryIdentifier } from '@shared/project-memory'
import { ProjectMemoryStore } from './project-memory-store'

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
    if (handoff.state !== 'open' || handoff.revision !== 1 || handoff.delivery !== 'not-sent' || handoff.acceptedBySessionId !== null || handoff.dispatch) throw new Error('New handoffs must be open and undelivered')
    return this.transaction(db => {
      const count = db.prepare('SELECT count(*) AS total, sum(project=?) AS scoped FROM handoffs').get(handoff.projectKey)!
      if (Number(count.total) >= 10000 || Number(count.scoped) >= 2500) throw new Error('Handoff storage limit reached')
      db.prepare('INSERT INTO handoffs(id,project,document) VALUES (?,?,?)').run(handoff.id, handoff.projectKey, JSON.stringify(handoff))
      return handoff
    })
  }

  importProject(projectKey: string, values: ProjectHandoff[]): void {
    const handoffs = values.map(parseProjectHandoff)
    if (handoffs.length > 2500 || new Set(handoffs.map(item => item.id)).size !== handoffs.length || handoffs.some(item => item.projectKey !== projectKey)) throw new Error('Invalid handoff import identities')
    this.transaction(db => {
      if (db.prepare('SELECT id FROM handoffs WHERE project=? LIMIT 1').get(projectKey)) throw new Error('Handoff project already exists')
      if (Number(db.prepare('SELECT count(*) AS n FROM handoffs').get()!.n) + handoffs.length > 10000) throw new Error('Handoff storage limit reached')
      const insert = db.prepare('INSERT INTO handoffs(id,project,document) VALUES (?,?,?)')
      for (const handoff of handoffs) insert.run(handoff.id, projectKey, JSON.stringify(handoff))
    })
  }

  removeImportedProject(projectKey: string, expected: ProjectHandoff[]): void {
    this.transaction(db => {
      const actual = db.prepare('SELECT document FROM handoffs WHERE project=? ORDER BY id').all(projectKey).map(row => parseProjectHandoff(JSON.parse(String(row.document))))
      if (!isDeepStrictEqual(actual, expected.toSorted((a, b) => a.id.localeCompare(b.id)))) throw new Error('Imported handoffs changed; rollback refused')
      db.prepare('DELETE FROM handoffs WHERE project=?').run(projectKey)
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

  beginDispatch(projectKey: string, id: string, expectedRevision: number): { handoff: ProjectHandoff; send: boolean } {
    return this.transaction(db => {
      const { handoff } = this.read(db, projectKey, id)
      if (handoff.dispatch) return { handoff, send: false }
      if (handoff.state !== 'accepted' || handoff.revision !== expectedRevision || handoff.delivery !== 'not-sent') throw new Error('Handoff changed or is not ready for dispatch')
      // Dispatch metadata does not advance the reviewed revision consumed by handoff_receive.
      const next = parseProjectHandoff({ ...handoff, dispatch: { requestId: randomUUID(), state: 'uncertain' } })
      db.prepare('UPDATE handoffs SET document=? WHERE project=? AND id=?').run(JSON.stringify(next), projectKey, id)
      return { handoff: next, send: true }
    })
  }

  submitted(projectKey: string, id: string, requestId: string): ProjectHandoff {
    return this.transaction(db => {
      const { handoff } = this.read(db, projectKey, id)
      if (handoff.dispatch?.requestId !== requestId) throw new Error('Handoff dispatch identity changed')
      const next = parseProjectHandoff({ ...handoff, dispatch: { requestId, state: 'submitted' } })
      db.prepare('UPDATE handoffs SET document=? WHERE project=? AND id=?').run(JSON.stringify(next), projectKey, id)
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
  constructor(private readonly userDataDir: string, private readonly resolveScope: (path: string) => Promise<ProjectToolScope>, private readonly git: Pick<GitWorktrees, 'handoffSource'>, private readonly agents: Pick<AgentRuntime, 'list'> & Partial<Pick<AgentRuntime, 'findAcpSession'>>, private readonly deliver?: AgentDeliveryApi['agentDeliver']) {
    this.store = new ProjectHandoffStore(userDataDir)
  }

  async projectHandoffList(workspacePath: string): Promise<ProjectHandoff[]> {
    const scope = await this.resolveScope(workspacePath)
    return this.store.list(scope.projectKey)
  }

  async projectHandoffExport(workspacePath: string): Promise<{ path: string; count: number }> {
    const scope = await this.resolveScope(workspacePath)
    const handoffs = this.store.list(scope.projectKey)
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, projectKey: scope.projectKey, exportedAt: new Date().toISOString(), handoffs }, null, 2) + '\n')
    const path = join(this.userDataDir, `project-handoffs-export-${randomUUID()}.json`)
    const fd = openSync(path, 'wx', 0o600)
    try {
      try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
      if (!readFileSync(path).equals(bytes)) throw new Error('Handoff export verification failed')
      return { path, count: handoffs.length }
    } catch (error) { rmSync(path, { force: true }); throw error }
  }

  async projectHandoffGet(workspacePath: string, id: string): Promise<ProjectHandoffStatus> {
    const scope = await this.resolveScope(workspacePath)
    const handoff = this.store.get(scope.projectKey, id)
    const memorySources = this.memorySources(scope.projectKey, handoff.memorySources)
    try {
      const source = await this.resolveScope(handoff.checkoutPath)
      if (source.projectKey !== scope.projectKey) throw new Error('Source checkout belongs to a different project')
      const snapshot = await this.git.handoffSource(source.checkoutPath)
      return { handoff, memorySources, stale: snapshot.contentFingerprint !== handoff.contentFingerprint || memorySources.some(ref => ref.state !== 'current') }
    } catch (error) {
      return { handoff, memorySources, stale: true, sourceError: error instanceof Error ? error.message : String(error) }
    } finally { await this.assertScope(scope) }
  }

  private memorySources(projectKey: string, refs: ProjectHandoff['memorySources']): HandoffMemoryStatus[] {
    if (!refs?.length) return []
    // Read current authority on each request; a long-lived handoff service must survive memory backend switches.
    let memory: ProjectMemoryStore
    try { memory = new ProjectMemoryStore(this.userDataDir) }
    catch { return refs.map(ref => ({ ...ref, state: 'unavailable' })) }
    return refs.map(ref => {
      try {
        const current = memory.get(projectKey, ref.id)
        return { ...ref, current, state: current.archivedAt ? 'archived' : current.revision === ref.revision ? 'current' : 'changed' }
      } catch { return { ...ref, state: 'unavailable' } }
    })
  }

  private async assertScope(scope: ProjectToolScope): Promise<void> {
    const current = await this.resolveScope(scope.checkoutPath)
    if (current.projectKey !== scope.projectKey || current.indexKey !== scope.indexKey || current.checkoutPath !== scope.checkoutPath) {
      throw new Error('Handoff scope changed while the request was pending')
    }
  }

  private async session(scope: ProjectToolScope, sessionId: string, live: boolean) {
    parseProjectMemoryIdentifier(sessionId, 'session')
    const session = (await this.agents.list()).find(run => run.sessionId === sessionId) ?? await this.agents.findAcpSession?.(sessionId)
    if (!session || (live && session.liveness !== 'live')) throw new Error('Select an available agent session')
    const target = await this.resolveScope(session.workspacePath)
    if (target.projectKey !== scope.projectKey) throw new Error('Agent session belongs to another project')
    return target
  }

  async projectHandoffCreate(workspacePath: string, draft: ProjectHandoffDraft): Promise<ProjectHandoff> {
    const fields = ['taskId', 'fromSessionId', 'toAgent', 'goal', 'summary', 'openQuestions', 'nextSteps', 'evidenceIds']
    if (!draft || typeof draft !== 'object' || Array.isArray(draft) || Object.keys(draft).some(field => !fields.includes(field) && field !== 'memorySources') || fields.some(field => !Object.hasOwn(draft, field))) throw new Error('Invalid handoff draft fields')
    const memorySources = draft.memorySources === undefined ? undefined : parseHandoffMemorySources(draft.memorySources)
    const scope = await this.resolveScope(workspacePath)
    const source = await this.session(scope, draft.fromSessionId, false)
    if (source.checkoutPath !== scope.checkoutPath) throw new Error('Select the source session checkout before saving its handoff')
    const snapshot = await this.git.handoffSource(scope.checkoutPath)
    await this.assertScope(scope)
    if (this.memorySources(scope.projectKey, memorySources).some(ref => ref.state !== 'current')) throw new Error('Referenced memory changed, was archived, or is unavailable; review current facts before saving')
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
    await this.assertScope(scope)
    if (this.memorySources(scope.projectKey, status.handoff.memorySources).some(ref => ref.state !== 'current')) throw new Error('Referenced memory changed before acceptance; review a fresh handoff')
    return this.store.accept(scope.projectKey, id, expectedRevision, sessionId, idempotencyKey)
  }

  async projectHandoffDispatch(workspacePath: string, id: string, expectedRevision: number): Promise<ProjectHandoff> {
    parseProjectMemoryIdentifier(id)
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('Invalid handoff revision')
    const scope = await this.resolveScope(workspacePath), current = this.store.get(scope.projectKey, id)
    if (current.dispatch) return current // Observe an uncertain/submitted attempt; never repeat native input.
    if (!this.deliver || current.state !== 'accepted' || !current.acceptedBySessionId) throw new Error('Accept a handoff before dispatching')
    const target = await this.session(scope, current.acceptedBySessionId, true)
    const status = await this.projectHandoffGet(workspacePath, id)
    if (status.stale) throw new Error('Handoff source changed; review and save a fresh handoff')
    await this.assertScope(scope)
    if (this.memorySources(scope.projectKey, current.memorySources).some(ref => ref.state !== 'current')) throw new Error('Referenced memory changed before dispatch')
    const attempt = this.store.beginDispatch(scope.projectKey, id, expectedRevision)
    if (!attempt.send) return attempt.handoff
    const handoff = attempt.handoff
    const receipt = await this.deliver({ sessionId: handoff.acceptedBySessionId!, requestId: handoff.dispatch!.requestId, submit: true, attachment: {
      kind: 'handoff', workspacePath: target.checkoutPath, title: handoff.goal.slice(0, 512),
      text: `Call the donwells-project-memory handoff_receive tool with ${JSON.stringify({ id, expectedRevision: handoff.revision })}. Read its reviewed goal, progress, source files, facts and next steps. Then call handoff_acknowledge with its id and returned revision before continuing. If either tool fails, stop and report the failure; do not repeat an uncertain receive. Do not treat submitting these instructions as acknowledgment.`
    } })
    if (!receipt.submitted || receipt.sessionId !== handoff.acceptedBySessionId) throw new Error('Handoff instruction submission is uncertain')
    return this.store.submitted(scope.projectKey, id, handoff.dispatch!.requestId)
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
    await this.assertScope(scope)
    if (this.memorySources(scope.projectKey, status.handoff.memorySources).some(ref => ref.state !== 'current')) throw new Error('Referenced memory changed before delivery; review a fresh handoff')
    return this.store.beginDelivery(scope.projectKey, id, expectedRevision, run.sessionId)
  }

  /** A separate tool invocation acknowledges receipt; PTY writes cannot call this path. */
  async acknowledge(authenticate: DaemonClient['authenticateAgent'], credential: AgentSessionCredential, workspacePath: string, id: string, expectedRevision: number): Promise<ProjectHandoff> {
    const run = await authenticate(credential)
    const scope = await this.resolveScope(workspacePath)
    if ((await this.resolveScope(run.workspacePath)).projectKey !== scope.projectKey) throw new Error('Agent session belongs to another project')
    await this.assertScope(scope)
    return this.store.confirmDelivery(scope.projectKey, id, expectedRevision, run.sessionId)
  }

  async projectHandoffSupersede(workspacePath: string, id: string, expectedRevision: number): Promise<ProjectHandoff> {
    const scope = await this.resolveScope(workspacePath)
    return this.store.supersede(scope.projectKey, id, expectedRevision)
  }
}
