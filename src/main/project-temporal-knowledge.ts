import { createHash, randomUUID } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { runProcess } from '@shared/child-process/run-process'
import type { ProcessResult, ProcessSpec } from '@shared/child-process/process-spec'
import { isObject } from '@shared/command-catalog'
import type { KnowledgeSelection } from '@shared/project-knowledge'
import { parseGraphitiConfiguration, type GraphitiConfiguration, type TemporalKnowledgeAnswer, type TemporalKnowledgeStatus, type TemporalSnapshot } from '@shared/project-temporal-knowledge'
import type { ProjectToolScope } from '@shared/project-tools'
import { acquireKnowledgeOperation } from './project-knowledge'
import { temporalSources } from './project-temporal-sources'
import workerSource from './project-knowledge-worker.py?raw'

const validDate = (value: unknown) => value === null || value === undefined || (typeof value === 'string' && Number.isFinite(Date.parse(value)))
/** Bound for one Neo4j password delivered over the worker's stdin pipe. */
const GRAPHITI_MAX_PASSWORD_BYTES = 4096
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
type Generation = { group_id: string; configuration: string; digest: string; state: string; selection: string; receipts: string }
/** The finite-process runner used for one worker run; injected by tests. */
export type GraphitiProcessRunner = (spec: ProcessSpec) => Promise<ProcessResult>
type WorkerRequest = { operation: 'retain' | 'query' | 'delete'; group: string; configuration: GraphitiConfiguration; sources?: TemporalSnapshot['sources']; query?: string; asOf?: string }
export type GraphitiWorker = (input: WorkerRequest, signal: AbortSignal) => Promise<Record<string, unknown>>

/** Graphiti owns only derived groups. Canonical facts and their bounded history remain in ProjectMemoryStore. */
export class ProjectTemporalKnowledge {
  private config: GraphitiConfiguration
  private closed = false
  private error: string | null = null
  private operation: { abort: AbortController; done: ReturnType<typeof Promise.withResolvers<void>> } | null = null
  constructor(private profile: string, configuration: GraphitiConfiguration, private resolveScope: (path: string) => Promise<ProjectToolScope>, private password: () => string | null = () => null, private worker: GraphitiWorker = (input, signal) => this.execute(input, signal), private spawnWorker: GraphitiProcessRunner = runProcess) { this.config = parseGraphitiConfiguration(configuration) }
  private ledger<T>(action: (db: DatabaseSync) => T): T {
    const directory = join(this.profile, 'project-knowledge'); mkdirSync(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, 'temporal-projections.sqlite')
    try { closeSync(openSync(path, 'wx', 0o600)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink() || (process.platform !== 'win32' && ((info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())))) throw new Error('Temporal ledger must be a private regular file')
    const db = new DatabaseSync(path)
    try {
      db.exec('PRAGMA busy_timeout=1000; BEGIN IMMEDIATE')
      const version = db.prepare('PRAGMA user_version').get()!.user_version
      if (version !== 0 && version !== 1) throw new Error('Unsupported temporal projection ledger')
      if (version === 0) {
        if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length) throw new Error('Unknown temporal ledger left untouched')
        db.exec('CREATE TABLE generations(project TEXT NOT NULL,group_id TEXT PRIMARY KEY,configuration TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,selection TEXT NOT NULL,receipts TEXT NOT NULL); PRAGMA user_version=1')
      }
      const value = action(db); db.exec('COMMIT'); return value
    } finally { db.close() }
  }
  private generations(project: string): Generation[] { return this.ledger(db => db.prepare('SELECT * FROM generations WHERE project=? ORDER BY rowid DESC').all(project) as Generation[]) }
  /**
   * One finite worker run. The Neo4j password never touches argv, the request
   * file, or the environment: it is written to the child's anonymous stdin pipe,
   * which is then closed, and the local plaintext reference is released before
   * the promise settles. A missing password is a refusal, not an empty string.
   */
  private async execute(input: WorkerRequest, signal: AbortSignal): Promise<Record<string, unknown>> {
    const password = this.password()
    if (password === null || password.length === 0) throw new Error('Graphiti requires a stored Neo4j password; save one before reconciling')
    if (password.length > GRAPHITI_MAX_PASSWORD_BYTES || /[\u0000-\u001f\u007f]/.test(password)) throw new Error('Stored Graphiti password is not a valid one-line secret')
    const directory = await mkdtemp(join(tmpdir(), 'donwells-temporal-'))
    try {
      const path = join(directory, 'request.json'), file = await open(path, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify(input)); await file.sync() } finally { await file.close() }
      const output = await this.spawnWorker({ program: input.configuration.python, args: ['-I', '-c', workerSource, path], cwd: directory, env: { HOME: process.env.HOME, PATH: process.env.PATH, PYTHON_DOTENV_DISABLED: '1', GRAPHITI_TELEMETRY_ENABLED: 'false' }, input: password, timeoutMs: 120000, maxOutputBytes: 1024 * 1024, signal }).catch(() => { signal.throwIfAborted(); throw new Error('Graphiti worker failed; check the configured service, pinned Python dependencies and model endpoints') })
      const result = JSON.parse(output.stdout)
      if (!isObject(result) || result.group !== input.group) throw new Error('Invalid or foreign Graphiti response')
      return result
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
  private async scope(path: string) { if (this.closed || !this.config.enabled) throw new Error('Graphiti is disabled or stopped'); return this.resolveScope(path) }
  private async run<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.operation) throw new Error('A temporal knowledge operation is already running')
    const release = acquireKnowledgeOperation()
    const operation = { abort: new AbortController(), done: Promise.withResolvers<void>() }; this.operation = operation; this.error = null
    try { return await action(operation.abort.signal) } catch (error) { this.error = String(error).slice(0, 500); throw error } finally { this.operation = null; release(); operation.done.resolve() }
  }
  private async cleanup(project: string, generations: Generation[], signal: AbortSignal) {
    for (const generation of generations) {
      if (!generation.group_id.startsWith('donwells-' + project + '-')) throw new Error('Refusing foreign temporal group cleanup')
      const result = await this.worker({ operation: 'delete', group: generation.group_id, configuration: parseGraphitiConfiguration(JSON.parse(generation.configuration)) }, signal)
      if (result.deleted !== true || result.group !== generation.group_id) throw new Error('Temporal cleanup is unacknowledged; queries remain blocked')
      this.ledger(db => db.prepare('DELETE FROM generations WHERE project=? AND group_id=?').run(project, generation.group_id))
    }
  }
  async status(path: string): Promise<TemporalKnowledgeStatus> {
    const scope = await this.resolveScope(path), rows = this.generations(scope.projectKey), current = rows.find(row => row.state === 'published')
    let stale = true
    try { if (current && current.configuration === JSON.stringify(this.config)) stale = current.digest !== digest(temporalSources(this.profile, scope.projectKey, JSON.parse(current.selection))) } catch { /* Erased or changed sources invalidate every derived relationship. */ }
    return { enabled: this.config.enabled && !this.closed, generation: current?.group_id ?? null, sources: current ? JSON.parse(current.selection) : [], stale, pendingCleanup: rows.filter(row => row.state !== 'published').length, busy: Boolean(this.operation), error: this.error }
  }
  async reconcile(path: string, sources: KnowledgeSelection[]) {
    const scope = await this.scope(path)
    await this.run(async signal => {
      const snapshot = temporalSources(this.profile, scope.projectKey, sources), sourceDigest = digest(snapshot), previous = this.generations(scope.projectKey)
      await this.cleanup(scope.projectKey, previous.filter(row => row.state !== 'published'), signal)
      const current = previous.find(row => row.state === 'published')
      if (current?.digest === sourceDigest && current.configuration === JSON.stringify(this.config)) return
      const group = 'donwells-' + scope.projectKey + '-' + randomUUID()
      const episodes = snapshot.sources.map(source => {
        // Graphiti UUID uniqueness spans groups; never reuse source UUIDs across generations.
        const hash = digest([group, source.episodeId])
        return { ...source, episodeId: `${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}` }
      })
      this.ledger(db => db.prepare('INSERT INTO generations VALUES(?,?,?,?,?,?,?)').run(scope.projectKey, group, JSON.stringify(this.config), sourceDigest, 'building', JSON.stringify(snapshot.selected), JSON.stringify(episodes.map(source => ({ episode: source.episodeId, ref: source.ref })))))
      const result = await this.worker({ operation: 'retain', group, configuration: this.config, sources: episodes }, signal)
      if (result.group !== group || !Array.isArray(result.receipts) || result.receipts.length !== episodes.length || result.receipts.some((receipt, i) => !isObject(receipt) || receipt.episode !== episodes[i].episodeId || !Array.isArray(receipt.edges))) throw new Error('Graphiti retain receipt is incomplete; clean the unpublished group before retrying')
      if (digest(temporalSources(this.profile, scope.projectKey, sources)) !== sourceDigest || (await this.scope(path)).projectKey !== scope.projectKey) throw new Error('Temporal sources changed during retention')
      const retained = result.receipts as Array<Record<string, unknown>>
      this.ledger(db => {
        db.prepare("UPDATE generations SET state='cleanup' WHERE project=? AND state='published'").run(scope.projectKey)
        db.prepare("UPDATE generations SET state='published',receipts=? WHERE group_id=?").run(JSON.stringify(episodes.map((source, i) => ({ ...retained[i], ref: source.ref }))), group)
      })
      await this.cleanup(scope.projectKey, this.generations(scope.projectKey).filter(row => row.state !== 'published'), signal)
    })
    return this.status(path)
  }
  async query(path: string, query: string, asOf?: string): Promise<TemporalKnowledgeAnswer> {
    if (typeof query !== 'string' || !query.trim() || query.length > 2000 || /[\x00-\x1f\x7f]/.test(query)) throw new Error('Temporal query must contain 1–2000 characters')
    const instant = asOf === undefined ? new Date().toISOString() : asOf
    if (typeof instant !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(instant) || !Number.isFinite(Date.parse(instant))) throw new Error('Historical time must be an ISO timestamp with timezone')
    const scope = await this.scope(path)
    return this.run(async signal => {
      const status = await this.status(path)
      if (!status.generation || status.stale || status.pendingCleanup) throw new Error('Temporal sources are stale or cleanup is pending; reconcile first')
      const snapshot = temporalSources(this.profile, scope.projectKey, status.sources), sourceDigest = digest(snapshot)
      if (snapshot.historyFloors.some(floor => Date.parse(instant) < Date.parse(floor.oldestAvailableAt))) throw new Error('Requested historical interval is unavailable because canonical revision history was truncated')
      const generation = this.generations(scope.projectKey).find(row => row.group_id === status.generation)!
      const receipts = JSON.parse(generation.receipts) as Array<{ episode: string; ref: TemporalSnapshot['sources'][number]['ref'] }>
      const available = new Map(receipts.flatMap(receipt => {
        const source = snapshot.sources.find(source => source.ref.id === receipt.ref.id && source.ref.revision === receipt.ref.revision)
        return source && Date.parse(source.availableFrom) <= Date.parse(instant) && (!source.availableUntil || Date.parse(instant) < Date.parse(source.availableUntil)) ? [[receipt.episode, source.ref] as const] : []
      }))
      const result = await this.worker({ operation: 'query', group: status.generation, configuration: this.config, query, asOf: instant }, signal)
      if (result.group !== status.generation || !Array.isArray(result.edges)) throw new Error('Invalid temporal query response')
      const relationships: TemporalKnowledgeAnswer['relationships'] = []; let omitted = 0
      for (const edge of result.edges.slice(0, 20)) {
        if (!isObject(edge) || edge.group_id !== status.generation || typeof edge.uuid !== 'string' || typeof edge.fact !== 'string' || !validDate(edge.valid_at) || !validDate(edge.invalid_at) || !Array.isArray(edge.episodes) || !edge.episodes.length || edge.episodes.some(id => typeof id !== 'string' || !available.has(id)) || (edge.valid_at && Date.parse(String(edge.valid_at)) > Date.parse(instant)) || (edge.invalid_at && Date.parse(String(edge.invalid_at)) <= Date.parse(instant))) { omitted++; continue }
        relationships.push({ id: edge.uuid, text: edge.fact, validAt: typeof edge.valid_at === 'string' ? edge.valid_at : null, invalidAt: typeof edge.invalid_at === 'string' ? edge.invalid_at : null, sources: edge.episodes.map(id => available.get(id as string)!) })
      }
      omitted += Math.max(0, result.edges.length - 20)
      if (digest(temporalSources(this.profile, scope.projectKey, status.sources)) !== sourceDigest || (await this.scope(path)).projectKey !== scope.projectKey) throw new Error('Temporal sources changed during query; no relationship text returned')
      return { classification: 'learned', generation: status.generation, asOf: instant, mode: asOf === undefined ? 'current' : 'historical', omitted, relationships }
    })
  }
  matches(configuration: GraphitiConfiguration) { return JSON.stringify(this.config) === JSON.stringify(parseGraphitiConfiguration(configuration)) }
  get stopped() { return this.closed }
  async close() { this.closed = true; const operation = this.operation; if (operation) { operation.abort.abort(new Error('Temporal work stopped')); await operation.done.promise } }
}
