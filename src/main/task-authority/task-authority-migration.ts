import { createHash } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  parseParallelRunsDocument,
  parseScheduledExecutionsDocument,
  parseScheduledRunsDocument,
  type ParallelRun,
  type ParallelRunTask,
  type ScheduledExecution,
  type ScheduledRunDefinition
} from '@shared/operational-runs'
import { canonicalExternalTaskId } from '@shared/task-authority'
import { BacklogMigrationReader, type BacklogMigrationReadPort, type BacklogProjectSnapshot, type BacklogWorkspaceIdentity } from './backlog-migration-reader'
import {
  importLegacyEntitiesIn,
  recordMigrationSourceIn,
  SqliteTaskAuthority,
  type LegacyImportAttempt,
  type LegacyImportEntitiesInput,
  type LegacyImportRunGroup,
  type LegacyImportSchedule,
  type LegacyImportScheduleExecution,
  type LegacyImportTask
} from './task-authority'
import type { TaskAuthorityDatabase } from './schema'

/**
 * Resumable, evidence-first legacy import and read-only projections.
 *
 * The migration is a durable state machine over the central authority database
 * plus a bounded set of exact source files. Every phase re-reads and re-hashes
 * those sources; every interruption (crash, concurrent resume, changed source)
 * resolves from persisted evidence rather than in-memory belief. A resumed call
 * re-derives the same stable entity IDs and returns the prior committed mapping
 * instead of duplicating rows; a changed frozen source records a successor
 * source record and runs one deterministic rebuild transaction.
 *
 * Nothing here activates a caller. Shadow comparison is read-only against the
 * legacy readers; activation only publishes retirement/fence receipts through
 * the Stage 2 maintenance gate.
 */

export const TASK_AUTHORITY_MIGRATION_STATES = ['legacy', 'preparing', 'shadow', 'draining', 'cutting-over', 'active', 'failed'] as const
export type TaskAuthorityMigrationState = (typeof TASK_AUTHORITY_MIGRATION_STATES)[number]

export const MIGRATION_MAX_SOURCE_BYTES = 8 * 1024 * 1024
export const MIGRATION_MAX_SHADOW_DIFFERENCES = 200
export const MIGRATION_EXPORT_LIMIT = 500

/** Profile-global operational snapshots; each is recorded once under the profile scope. */
export const OPERATIONAL_SOURCE_KINDS = ['orchestrations', 'automations', 'automation-runs'] as const
export type OperationalSourceKind = (typeof OPERATIONAL_SOURCE_KINDS)[number]

export const OPERATIONAL_FILE_NAMES: Record<OperationalSourceKind, string> = {
  orchestrations: 'orchestrations.json',
  automations: 'automations.json',
  'automation-runs': 'automation-runs.json'
}

export class TaskAuthorityMigrationError extends Error {
  readonly code:
    | 'MIGRATION_SOURCE_UNSAFE'
    | 'MIGRATION_SOURCE_CORRUPT'
    | 'MIGRATION_SOURCE_OVERSIZED'
    | 'MIGRATION_SOURCE_CHANGED'
    | 'MIGRATION_STATE_INVALID'
    | 'MIGRATION_READER_UNREACHABLE'

  constructor(code: TaskAuthorityMigrationError['code'], message: string) {
    super(message)
    this.name = 'TaskAuthorityMigrationError'
    this.code = code
  }
}

/** One exact source file the migration froze: canonical path plus SHA-256. */
export type MigrationSourceRecord = Readonly<{
  sourceKind: string
  canonicalSourcePath: string
  sourceSha256: string
  bytes: number
}>

export type MigrationSourceSet = Readonly<{
  sources: readonly MigrationSourceRecord[]
  sha256: string
}>

/** One observed difference between the authority projection and the live legacy reader. */
export type ShadowDifference = Readonly<{
  sourcePath: string
  field: string
  authorityValue: string | null
  legacyValue: string | null
}>

export type ShadowReport = Readonly<{
  differences: readonly ShadowDifference[]
  compared: number
  clean: boolean
}>

export type TaskAuthorityMigrationStatus = Readonly<{
  profileId: string
  state: TaskAuthorityMigrationState
  sourceSetSha256: string | null
  sources: readonly MigrationSourceRecord[]
  entityMappings: number
  exportedRepositories: readonly string[]
}>

/** Read-only legacy readers used for shadow comparison; never written. */
export type LegacyShadowReaders = Readonly<{
  parallelRuns(): Promise<readonly ParallelRun[]>
  scheduledRuns(): Promise<readonly ScheduledRunDefinition[]>
  scheduledExecutions(): Promise<readonly ScheduledExecution[]>
  /** Every registered project the migration must cover. */
  projects(): Promise<readonly BacklogWorkspaceIdentity[]>
  /** Live legacy project task summaries, keyed by project ID. */
  projectTaskSummaries(): Promise<Readonly<Record<string, readonly Readonly<{ id: string; title: string; status: string }>[]>>>
}>

export type LegacyOperationalSnapshot = Readonly<{
  sourceKind: OperationalSourceKind
  path: string
  sha256: string
  bytes: number
  normalizedJson: string
  entities: LegacyImportEntitiesInput
}>

export type TaskAuthorityMigrationOptions = Readonly<{
  authority: SqliteTaskAuthority
  database: TaskAuthorityDatabase
  profileId: string
  /** Profile user-data directory holding the legacy operational snapshots. */
  userDataDirectory: string
  readers: LegacyShadowReaders
  backlog: BacklogMigrationReadPort
}>

type Row = Record<string, unknown>

export function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Deterministic digest over the exact ordered source set.
 *
 * Sorted by (path, kind) so the digest is stable across enumeration order, and
 * byte length is included so a same-digest truncation cannot pass as identical.
 */
export function migrationSourceSetSha256(sources: readonly MigrationSourceRecord[]): string {
  const ordered = [...sources]
    .map(source => [source.canonicalSourcePath, source.sourceKind, source.sourceSha256, source.bytes] as const)
    .sort((left, right) => (left[0] === right[0] ? (left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0) : left[0] < right[0] ? -1 : 1))
  return sha256Hex(JSON.stringify(ordered))
}

/**
 * Reads one legacy file under the private-file contract.
 *
 * A missing file is the empty document the legacy stores themselves load, so an
 * unconfigured profile migrates deterministically instead of failing.
 * Symlinks, non-files, non-private ownership, and oversized files fail closed
 * and leave the file untouched.
 */
export function readLegacyOperationalFile(userDataDirectory: string, sourceKind: OperationalSourceKind): Readonly<{ path: string; text: string; sha256: string; bytes: number }> {
  const path = join(userDataDirectory, OPERATIONAL_FILE_NAMES[sourceKind])
  const key = sourceKind === 'orchestrations' ? 'parallelRuns' : sourceKind === 'automations' ? 'scheduledRuns' : 'executions'
  const empty = JSON.stringify({ schemaVersion: 1, [key]: [] })
  let stats
  try {
    stats = lstatSync(path)
  } catch {
    return { path, text: empty, sha256: sha256Hex(empty), bytes: Buffer.byteLength(empty, 'utf8') }
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new TaskAuthorityMigrationError('MIGRATION_SOURCE_UNSAFE', `legacy source ${path} must be a regular private file, not a link or directory`)
  }
  if (process.platform !== 'win32' && ((process.getuid && stats.uid !== process.getuid()) || (stats.mode & 0o077) !== 0)) {
    throw new TaskAuthorityMigrationError('MIGRATION_SOURCE_UNSAFE', `legacy source ${path} must be owned by the current user with no group or world access`)
  }
  if (stats.size > MIGRATION_MAX_SOURCE_BYTES) {
    throw new TaskAuthorityMigrationError('MIGRATION_SOURCE_OVERSIZED', `legacy source ${path} exceeded ${MIGRATION_MAX_SOURCE_BYTES} bytes`)
  }
  const bytes = readFileSync(path)
  return { path, text: bytes.toString('utf8'), sha256: sha256Hex(bytes), bytes: bytes.length }
}

/** Parses one operational snapshot with the legacy contract; a corrupt file is reported, never repaired. */
export function parseOperationalSnapshot(sourceKind: OperationalSourceKind, text: string, path: string): unknown {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch (error) {
    throw new TaskAuthorityMigrationError('MIGRATION_SOURCE_CORRUPT', `operational snapshot ${path} was not valid JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  try {
    if (sourceKind === 'orchestrations') return parseParallelRunsDocument(document)
    if (sourceKind === 'automations') return parseScheduledRunsDocument(document)
    return parseScheduledExecutionsDocument(document)
  } catch (error) {
    throw new TaskAuthorityMigrationError('MIGRATION_SOURCE_CORRUPT', `operational snapshot ${path} was invalid (${error instanceof Error ? error.message : String(error)})`)
  }
}

/**
 * Deterministic digest over the exact ordered (kind, key, id) entity mapping set.
 * Used to prove a replayed import produced the same authority entities.
 */
export function entityMappingSha256(entities: Readonly<Record<string, string>>): string {
  const ordered = Object.entries(entities).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return sha256Hex(JSON.stringify(ordered))
}

// ---------------------------------------------------------------------------
// Legacy operational normalization
// ---------------------------------------------------------------------------

const TERMINAL_RUN_TASK_STATUS = new Set(['succeeded', 'failed', 'cancelled'])

function operationalTasks(document: unknown): readonly ParallelRun[] {
  const record = document as { parallelRuns?: readonly unknown[] }
  return (record.parallelRuns ?? []) as readonly ParallelRun[]
}

function operationalDefinitions(document: unknown): readonly ScheduledRunDefinition[] {
  const record = document as { scheduledRuns?: readonly unknown[] }
  return (record.scheduledRuns ?? []) as readonly ScheduledRunDefinition[]
}

function operationalExecutions(document: unknown): readonly ScheduledExecution[] {
  const record = document as { executions?: readonly unknown[] }
  return (record.executions ?? []) as readonly ScheduledExecution[]
}

/** Maps one historical parallel task onto a provenance-marked imported-legacy terminal attempt. */
function legacyAttemptOfTask(run: ParallelRun, task: ParallelRunTask, projectId: string): LegacyImportAttempt {
  const evidence = task.verification
  return {
    attemptKey: `${run.id}#${task.id}`,
    projectId,
    taskExternalTaskId: task.id,
    state: task.status === 'succeeded' ? 'completed' : task.status === 'cancelled' ? 'cancelled' : 'failed',
    specification: {
      command: { program: task.command, args: [], ...(task.target.kind === 'local' ? { cwd: task.target.root } : {}) },
      target: task.target,
      verification: { requiredArtifacts: [] }
    },
    // The legacy JSON stores no execution-time definition provenance, so the
    // imported specification is explicitly partial: it is what the record says
    // the task ran, not proof of which mutable definition produced it.
    specificationLegacyUnknown: true,
    ...(task.sessionId === undefined ? {} : { sessionId: task.sessionId }),
    startedAt: task.startedAt ?? run.createdAt,
    ...(task.finishedAt === undefined ? {} : { finishedAt: task.finishedAt }),
    ...(task.exitCode === undefined ? {} : { exitCode: task.exitCode }),
    ...(task.error === undefined ? {} : { error: task.error }),
    ...(task.output === undefined ? {} : { output: task.output }),
    ...(evidence === undefined ? {} : {
      artifacts: evidence.artifacts.map(artifact => ({
        path: artifact.path,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
        ...(artifact.sourceFingerprint === null ? {} : { sourceFingerprint: artifact.sourceFingerprint }),
        relationship: artifact.relationship
      }))
    })
  }
}

/**
 * Normalizes the profile-global operational snapshots into imported entities.
 *
 * Historical executions do not prove which mutable schedule definition ran:
 * each imported execution carries a `legacy-unknown` execution-time
 * specification, and the current definition is never retroactively bound to it.
 * Such history is ineligible for native completion or adoption without explicit
 * review.
 */
export function normalizeOperationalSnapshot(sourceKind: OperationalSourceKind, document: unknown, profileId: string): LegacyImportEntitiesInput {
  if (sourceKind === 'orchestrations') {
    const runs = operationalTasks(document)
    const tasks: LegacyImportTask[] = []
    const attempts: LegacyImportAttempt[] = []
    const runGroups: LegacyImportRunGroup[] = []
    for (const run of runs) {
      const runLabel = run.tasks[0]?.target.kind === 'local' ? run.tasks[0].target.root : run.id
      for (const task of run.tasks) {
        // Each task's own target names the project it belongs to; a run group
        // may span repositories, so the run never supplies one project.
        const taskProjectId = task.target.kind === 'local' ? task.target.root : runLabel
        tasks.push({
          projectId: taskProjectId,
          externalTaskId: task.id,
          title: `${run.name} · ${task.target.label}`,
          body: task.command,
          status: task.status === 'succeeded' ? 'done' : task.status === 'cancelled' ? 'cancelled' : task.status === 'failed' ? 'failed' : 'blocked',
          priority: 0,
          dependencies: []
        })
        if (TERMINAL_RUN_TASK_STATUS.has(task.status)) attempts.push(legacyAttemptOfTask(run, task, taskProjectId))
      }
      runGroups.push({
        groupKey: run.id,
        profileId,
        name: run.name,
        ...(run.retryOfRunId === undefined ? {} : { retryOfGroupKey: run.retryOfRunId }),
        concurrency: run.concurrency,
        state: run.status === 'cancelling' ? 'cancelling' : run.status === 'cancelled' ? 'cancelled' : run.status === 'succeeded' ? 'completed' : 'active',
        createdAt: run.createdAt,
        updatedAt: run.finishedAt ?? run.createdAt,
        members: run.tasks.map((task, ordinal) => ({
          projectId: task.target.kind === 'local' ? task.target.root : runLabel,
          taskExternalTaskId: task.id,
          ordinal,
          state: task.status === 'succeeded' ? 'completed' : task.status === 'cancelled' ? 'cancelled' : task.status === 'failed' ? 'failed' : task.status === 'queued' ? 'queued' : 'running',
          specification: {
            command: { program: task.command, args: [], ...(task.target.kind === 'local' ? { cwd: task.target.root } : {}) },
            target: task.target,
            verification: { requiredArtifacts: [] }
          },
          ...(TERMINAL_RUN_TASK_STATUS.has(task.status) ? { sourceAttemptKey: `${run.id}#${task.id}` } : {})
        }))
      })
    }
    return { scopeKind: 'profile', scopeId: profileId, tasks, attempts, runGroups }
  }

  if (sourceKind === 'automations') {
    const schedules: LegacyImportSchedule[] = operationalDefinitions(document).map(definition => ({
      scheduleKey: definition.id,
      projectId: definition.target.root,
      profileId,
      taskTitle: definition.name,
      cadence: definition.schedule.kind === 'interval'
        ? { kind: 'interval', minutes: definition.schedule.minutes }
        : { kind: 'daily', time: definition.schedule.time, timeZone: definition.schedule.timeZone },
      specification: {
        command: { program: definition.command, args: [], ...(definition.target.kind === 'local' ? { cwd: definition.target.root } : {}) },
        target: definition.target,
        verification: { requiredArtifacts: [] }
      },
      enabled: definition.enabled,
      nextRunAt: definition.nextRunAt ?? null,
      createdAt: definition.createdAt,
      updatedAt: definition.updatedAt
    }))
    return { scopeKind: 'profile', scopeId: profileId, schedules }
  }

  const executions: LegacyImportScheduleExecution[] = operationalExecutions(document).map(execution => ({
    executionKey: execution.id,
    scheduleKey: execution.scheduledRunId,
    trigger: execution.trigger === 'manual' ? 'manual' : 'due',
    // The execution ID is the legacy store's own unique key, so it is a
    // faithful idempotency key under the project/schedule/trigger unique index.
    idempotencyKey: execution.id,
    dueAt: execution.startedAt,
    state: execution.status === 'succeeded' ? 'succeeded' : execution.status === 'cancelled' ? 'cancelled' : execution.status === 'failed' || execution.status === 'unverifiable' ? 'failed' : 'cancelled',
    createdAt: execution.startedAt
  }))
  return { scopeKind: 'profile', scopeId: profileId, scheduleExecutions: executions }
}

/**
 * Publishes the registered project set the migration must cover.
 *
 * The daemon runs detached from the app process that owns the repository
 * registry, so the registry is handed over as one private file the daemon
 * re-reads on every import. It carries identity only — project, repository,
 * and canonical workspace root — never task content.
 */
export function publishRegisteredProjects(userDataDirectory: string, projects: readonly BacklogWorkspaceIdentity[]): void {
  const directory = join(userDataDirectory, 'task-authority-migration')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  atomicWritePrivate(join(directory, 'projects.json'), Buffer.from(JSON.stringify(projects), 'utf8'))
}

/** Reads the published project registry; a missing file means no Backlog sources. */
export function readRegisteredProjects(userDataDirectory: string): readonly BacklogWorkspaceIdentity[] {
  const path = join(userDataDirectory, 'task-authority-migration', 'projects.json')
  if (!isPrivateFile(path)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap(entry => {
    if (typeof entry !== 'object' || entry === null) return []
    const record = entry as Record<string, unknown>
    const projectId = record['projectId']
    const repositoryId = record['repositoryId']
    const workspaceRoot = record['workspaceRoot']
    if (typeof projectId !== 'string' || typeof repositoryId !== 'string' || typeof workspaceRoot !== 'string') return []
    if (projectId.length === 0 || repositoryId.length === 0 || workspaceRoot.length === 0) return []
    return [{ projectId, repositoryId, workspaceRoot }]
  })
}

// ---------------------------------------------------------------------------
// Private file helpers
// ---------------------------------------------------------------------------

/** Bounded non-empty identifier, matching the authority's own input contract. */
function boundedField(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0')) {
    throw new TaskAuthorityMigrationError('MIGRATION_STATE_INVALID', `${field}: must be a non-empty string of at most ${maximum} characters`)
  }
  return value
}

function isPrivateFile(path: string): boolean {
  try {
    const stats = lstatSync(path)
    return stats.isFile() && !stats.isSymbolicLink()
  } catch {
    return false
  }
}

/** Atomic private publication: temp file in the destination directory, then rename. */
export function atomicWritePrivate(path: string, bytes: Buffer): void {
  const temporary = `${path}.${process.pid}.${sha256Hex(String(Date.now())).slice(0, 12)}.tmp`
  try {
    writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
    fsyncPath(dirname(path))
  } finally {
    rmSync(temporary, { force: true })
  }
}

/** Fsync a path where the platform supports it; failure is not a durability claim. */
export function fsyncPath(path: string): boolean {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return false
  }
  try {
    fsyncSync(fd)
    return true
  } catch {
    // Directory fsync is unsupported on some platforms. Only the file fsync
    // above is claimed as proved on this platform.
    return false
  } finally {
    closeSync(fd)
  }
}

// ---------------------------------------------------------------------------
// Durable migration
// ---------------------------------------------------------------------------

/**
 * Durable, resumable Task Authority migration.
 *
 * Source scoping follows the brief exactly: a Backlog file records the exact
 * project scope, and each profile-global operational JSON snapshot records the
 * profile scope exactly once — never one invented project, never duplicated per
 * project.
 */
export class TaskAuthorityMigration {
  private readonly authority: SqliteTaskAuthority
  private readonly database: TaskAuthorityDatabase
  private readonly profileId: string
  private readonly userDataDirectory: string
  private readonly readers: LegacyShadowReaders
  private readonly reader: BacklogMigrationReader

  constructor(options: TaskAuthorityMigrationOptions) {
    this.authority = options.authority
    this.database = options.database
    this.profileId = options.profileId
    this.userDataDirectory = options.userDataDirectory
    this.readers = options.readers
    this.reader = new BacklogMigrationReader(options.backlog)
  }

  // -- durable state ---------------------------------------------------------

  status(): TaskAuthorityMigrationStatus {
    return this.database.withReadOnly(db => {
      const row = db.prepare('SELECT state, source_set_sha256 FROM task_authority_migration_state WHERE profile_id = ?').get(this.profileId) as Row | undefined
      const state = row === undefined ? 'legacy' : String(row['state'])
      if (!(TASK_AUTHORITY_MIGRATION_STATES as readonly string[]).includes(state)) {
        throw new TaskAuthorityMigrationError('MIGRATION_STATE_INVALID', `persisted migration state "${state}" was unrecognized`)
      }
      const sourceRows = db.prepare("SELECT source_kind, canonical_source_path, source_sha256, source_bytes FROM migration_sources WHERE phase = 'imported' ORDER BY canonical_source_path, source_kind").all() as Row[]
      const mappingCount = Number((db.prepare('SELECT COUNT(*) AS count FROM migration_entity_mappings').get() as Row)['count'])
      const exports = db.prepare("SELECT name FROM projection_checkpoints WHERE name LIKE 'backlog-export:%' ORDER BY name").all() as Row[]
      return {
        profileId: this.profileId,
        state: state as TaskAuthorityMigrationState,
        sourceSetSha256: row === undefined || row['source_set_sha256'] === null ? null : String(row['source_set_sha256']),
        sources: sourceRows.map(source => ({
          sourceKind: String(source['source_kind']),
          canonicalSourcePath: String(source['canonical_source_path']),
          sourceSha256: String(source['source_sha256']),
          bytes: Number(source['source_bytes'])
        })),
        entityMappings: mappingCount,
        exportedRepositories: exports.map(entry => String(entry['name']).slice('backlog-export:'.length))
      }
    })
  }

  private setState(db: DatabaseSync, state: TaskAuthorityMigrationState, sourceSetSha256: string | null, reason?: string): void {
    db.prepare('INSERT INTO task_authority_migration_state(profile_id, state, source_set_sha256, updated_at) VALUES (?,?,?,?) ON CONFLICT(profile_id) DO UPDATE SET state = excluded.state, source_set_sha256 = excluded.source_set_sha256, updated_at = excluded.updated_at')
      .run(this.profileId, state, sourceSetSha256, new Date().toISOString())
    if (reason !== undefined) {
      db.prepare('INSERT INTO task_authority_migration_failure(profile_id, reason, created_at) VALUES (?,?,?)')
        .run(this.profileId, reason.slice(0, 1024), new Date().toISOString())
    }
  }

  private requireState(...allowed: readonly TaskAuthorityMigrationState[]): TaskAuthorityMigrationState {
    const state = this.status().state
    if (!allowed.includes(state)) {
      throw new TaskAuthorityMigrationError('MIGRATION_STATE_INVALID', `migration state "${state}" is not one of ${allowed.join(', ')}`)
    }
    return state
  }

  // -- source reading --------------------------------------------------------

  /** Reads, validates, and hashes every exact source without writing anything. */
  async readSources(): Promise<Readonly<{ backlog: readonly BacklogProjectSnapshot[]; operational: readonly LegacyOperationalSnapshot[]; sourceSet: MigrationSourceSet }>> {
    const backlog: BacklogProjectSnapshot[] = []
    for (const identity of await this.readers.projects()) {
      backlog.push(await this.reader.readProject(identity))
    }
    const operational = OPERATIONAL_SOURCE_KINDS.map(sourceKind => {
      const file = readLegacyOperationalFile(this.userDataDirectory, sourceKind)
      const normalized = parseOperationalSnapshot(sourceKind, file.text, file.path)
      return {
        sourceKind,
        path: file.path,
        sha256: file.sha256,
        bytes: file.bytes,
        normalizedJson: JSON.stringify(normalized),
        entities: normalizeOperationalSnapshot(sourceKind, normalized, this.profileId)
      }
    })
    const sources: MigrationSourceRecord[] = [
      ...backlog.flatMap(snapshot => snapshot.sources.map(source => ({
        sourceKind: 'backlog',
        canonicalSourcePath: `${snapshot.workspaceRoot}/${source.path}`,
        sourceSha256: source.sha256,
        bytes: source.bytes
      }))),
      ...operational.map(source => ({
        sourceKind: source.sourceKind,
        canonicalSourcePath: source.path,
        sourceSha256: source.sha256,
        bytes: source.bytes
      }))
    ]
    return { backlog, operational, sourceSet: { sources, sha256: migrationSourceSetSha256(sources) } }
  }

  // -- prepare: resumable import ---------------------------------------------

  /**
   * Records every exact source and imports its normalized entities.
   *
   * A repeat call with unchanged sources re-derives the same stable authority
   * entity IDs and returns the prior committed mapping instead of duplicating
   * rows. A changed frozen source records a successor source record and runs
   * one rebuild transaction per source that reuses stable IDs, replaces
   * imported fields, inserts additions, and marks superseded imported history.
   */
  async prepare(): Promise<Readonly<{ state: TaskAuthorityMigrationState; sourceSetSha256: string; entities: Readonly<Record<string, string>>; supersededSourceIds: readonly string[] }>> {
    const prior = this.status()
    if (prior.state === 'active') {
      throw new TaskAuthorityMigrationError('MIGRATION_STATE_INVALID', 'the migration is already active; a post-cutover rebuild is a separate reviewed operation')
    }
    if (prior.state === 'failed') {
      throw new TaskAuthorityMigrationError('MIGRATION_STATE_INVALID', 'the migration is failed; resolve or abort the durable failure before re-importing')
    }
    if (prior.state === 'legacy') this.database.withImmediate(db => this.setState(db, 'preparing', null))
    const { backlog, operational, sourceSet } = await this.readSources()
    // Supersession is per exact source: only a source whose bytes changed takes
    // a successor record, so an unrelated file change never rewrites the others.
    const predecessors = this.predecessorSourceIds(prior.sources, sourceSet.sources)
    const entities: Record<string, string> = {}
    for (const snapshot of backlog) Object.assign(entities, this.importBacklog(snapshot, predecessors))
    for (const snapshot of operational) Object.assign(entities, this.importOperational(snapshot, predecessors))
    // A prior source whose path no longer exists at all has no successor to
    // carry the supersession, so it is retired here: its snapshot is no longer
    // authoritative and must not remain `imported`.
    const vanished = this.retireVanishedSources(prior.sources, sourceSet.sources)
    this.database.withImmediate(db => this.setState(db, 'preparing', sourceSet.sha256))
    return { state: 'preparing', sourceSetSha256: sourceSet.sha256, entities, supersededSourceIds: [...new Set([...predecessors.values(), ...vanished])] }
  }

  /** Marks prior sources whose canonical path vanished as superseded with their mappings. */
  private retireVanishedSources(previous: readonly MigrationSourceRecord[], current: readonly MigrationSourceRecord[]): string[] {
    const currentPaths = new Set(current.map(record => record.canonicalSourcePath))
    const vanished = previous.filter(record => !currentPaths.has(record.canonicalSourcePath))
    if (vanished.length === 0) return []
    return this.database.withImmediate(db => {
      const ids: string[] = []
      for (const record of vanished) {
        const row = db.prepare('SELECT id FROM migration_sources WHERE source_kind = ? AND canonical_source_path = ? AND source_sha256 = ? AND phase = ?')
          .get(record.sourceKind, record.canonicalSourcePath, record.sourceSha256, 'imported') as Row | undefined
        if (row === undefined) continue
        const id = String(row['id'])
        db.prepare("UPDATE migration_sources SET phase = 'superseded' WHERE id = ?").run(id)
        db.prepare("UPDATE migration_entity_mappings SET state = 'superseded' WHERE source_id = ? AND state = 'active'").run(id)
        ids.push(id)
      }
      return ids
    })
  }

  /**
   * Maps each current canonical source path to the prior source id it replaces,
   * for exactly those sources whose recorded digest differs.
   */
  private predecessorSourceIds(previous: readonly MigrationSourceRecord[], current: readonly MigrationSourceRecord[]): Map<string, string> {
    return this.database.withReadOnly(db => {
      const currentByPath = new Map(current.map(record => [record.canonicalSourcePath, record.sourceSha256]))
      // A prior source that still exists takes a successor record when its
      // exact bytes changed; a prior source whose path vanished has no successor
      // and is retired separately.
      const superseded = previous.filter(record => currentByPath.has(record.canonicalSourcePath) && currentByPath.get(record.canonicalSourcePath) !== record.sourceSha256)
      const replacements = new Map<string, string>()
      for (const record of superseded) {
        const row = db.prepare('SELECT id FROM migration_sources WHERE source_kind = ? AND canonical_source_path = ? AND source_sha256 = ? AND phase = ?')
          .get(record.sourceKind, record.canonicalSourcePath, record.sourceSha256, 'imported') as Row | undefined
        if (row !== undefined) replacements.set(record.canonicalSourcePath, String(row['id']))
      }
      return replacements
    })
  }

  /**
   * One source record plus its entity mappings plus its entities commit in a
   * single transaction, so an interruption leaves no entity without the
   * provenance row that names the snapshot which produced it.
   */
  private recordAndImport(input: Readonly<{
    scopeKind: 'project' | 'profile'
    scopeId: string
    projectId?: string
    sourceKind: string
    canonicalSourcePath: string
    sourceSha256: string
    sourceBytes: number
    normalizedJson: string
    supersedesSourceId?: string
    entities: LegacyImportEntitiesInput
  }>): { entities: Record<string, string>; sourceId: string } {
    return this.database.withImmediate(db => {
      const receipt = recordMigrationSourceIn(db, {
        scopeKind: input.scopeKind,
        scopeId: input.scopeId,
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        sourceKind: input.sourceKind,
        canonicalSourcePath: input.canonicalSourcePath,
        sourceSha256: input.sourceSha256,
        sourceBytes: input.sourceBytes,
        normalizedJson: input.normalizedJson,
        ...(input.supersedesSourceId === undefined ? {} : { supersedesSourceId: input.supersedesSourceId })
      })
      const entities = importLegacyEntitiesIn(db, input.entities)
      for (const [key, authorityEntityId] of Object.entries(entities)) {
        const separator = key.indexOf(':')
        const entityKind = key.slice(0, separator)
        const sourceEntityKey = key.slice(separator + 1)
        db.prepare("INSERT INTO migration_entity_mappings(source_id, entity_kind, source_entity_key, authority_entity_id, source_fingerprint, state) VALUES (?,?,?,?,?,'active') ON CONFLICT(source_id, entity_kind, source_entity_key) DO UPDATE SET authority_entity_id = excluded.authority_entity_id, source_fingerprint = excluded.source_fingerprint, state = 'active'")
          .run(receipt.sourceId, entityKind, sourceEntityKey.slice(0, 128), authorityEntityId, input.sourceSha256.slice(0, 128))
      }
      return { entities, sourceId: receipt.sourceId }
    })
  }

  private importBacklog(snapshot: BacklogProjectSnapshot, predecessors: ReadonlyMap<string, string>): Record<string, string> {
    const entities: Record<string, string> = {}
    for (const source of snapshot.sources) {
      const canonicalPath = `${snapshot.workspaceRoot}/${source.path}`
      const fileTasks = snapshot.tasks.filter(task => task.sourcePath === source.path)
      const tasks: LegacyImportTask[] = fileTasks.map(task => ({
        externalTaskId: task.externalTaskId,
        title: task.title,
        body: task.body,
        // Existing in-progress Backlog state without a Donwells attempt imports
        // as explicit blocked with migration provenance, never a live claim.
        status: task.status === 'in-progress' ? 'blocked' : task.status,
        priority: task.priority,
        dependencies: task.dependencies
      }))
      const imported = this.recordAndImport({
        scopeKind: 'project',
        scopeId: snapshot.projectId,
        projectId: snapshot.projectId,
        sourceKind: 'backlog',
        canonicalSourcePath: canonicalPath,
        sourceSha256: source.sha256,
        sourceBytes: source.bytes,
        // The normalized payload is exactly the records this file produced.
        normalizedJson: JSON.stringify(fileTasks),
        ...(predecessors.has(canonicalPath) ? { supersedesSourceId: predecessors.get(canonicalPath) as string } : {}),
        entities: { scopeKind: 'project', scopeId: snapshot.projectId, tasks }
      })
      Object.assign(entities, imported.entities)
    }
    return entities
  }

  private importOperational(snapshot: LegacyOperationalSnapshot, predecessors: ReadonlyMap<string, string>): Record<string, string> {
    const predecessor = predecessors.get(snapshot.path)
    const imported = this.recordAndImport({
      // One profile-global snapshot is recorded once under the profile scope and
      // may map entities across projects; it is never duplicated per project.
      scopeKind: 'profile',
      scopeId: this.profileId,
      sourceKind: snapshot.sourceKind,
      canonicalSourcePath: snapshot.path,
      sourceSha256: snapshot.sha256,
      sourceBytes: snapshot.bytes,
      normalizedJson: snapshot.normalizedJson,
      ...(predecessor === undefined ? {} : { supersedesSourceId: predecessor }),
      entities: { ...snapshot.entities, scopeKind: 'profile', scopeId: this.profileId }
    })
    return imported.entities
  }

  // -- shadow comparison (read-only) -----------------------------------------

  /**
   * Compares authority projections against the live legacy readers.
   *
   * Read-only on both sides: Task Authority receives no mirrored writes and
   * nothing is auto-repaired. Each difference names its source path and field.
   */
  async shadow(): Promise<ShadowReport> {
    this.requireState('preparing', 'shadow')
    void 0
    const status = this.status()
    this.database.withImmediate(db => this.setState(db, 'shadow', status.sourceSetSha256))
    const [legacyRuns, legacyDefinitions, legacyExecutions, legacyTasks] = await Promise.all([
      this.readers.parallelRuns(),
      this.readers.scheduledRuns(),
      this.readers.scheduledExecutions(),
      this.readers.projectTaskSummaries()
    ])
    const differences: ShadowDifference[] = []
    let compared = 0

    for (const [projectId, tasks] of Object.entries(legacyTasks)) {
      for (const legacy of tasks) {
        compared += 1
        const row = this.database.withReadOnly(db => db.prepare('SELECT title FROM tasks WHERE project_id = ? AND external_task_id_canonical = ?')
          .get(projectId, canonicalExternalTaskId(legacy.id)) as Row | undefined)
        if (row === undefined) {
          differences.push({ sourcePath: projectId, field: `task:${legacy.id}`, authorityValue: null, legacyValue: legacy.id })
          continue
        }
        if (String(row['title']) !== legacy.title) {
          differences.push({ sourcePath: projectId, field: `task:${legacy.id}.title`, authorityValue: String(row['title']), legacyValue: legacy.title })
        }
      }
    }

    for (const definition of legacyDefinitions) {
      compared += 1
      const row = this.database.withReadOnly(db => db.prepare('SELECT id, definition_json, enabled FROM schedules WHERE project_id = ? AND id = ?')
        .get(definition.target.root, definition.id) as Row | undefined)
      if (row === undefined) {
        differences.push({ sourcePath: definition.target.root, field: `schedule:${definition.id}`, authorityValue: null, legacyValue: definition.id })
        continue
      }
      const stored = JSON.parse(String(row['definition_json'])) as { cadence?: unknown }
      const legacyCadence = definition.schedule.kind === 'interval'
        ? { kind: 'interval', minutes: definition.schedule.minutes }
        : { kind: 'daily', time: definition.schedule.time, timeZone: definition.schedule.timeZone }
      if (JSON.stringify(stored.cadence) !== JSON.stringify(legacyCadence)) {
        differences.push({ sourcePath: definition.target.root, field: `schedule:${definition.id}.cadence`, authorityValue: JSON.stringify(stored.cadence), legacyValue: JSON.stringify(legacyCadence) })
      }
      if ((Number(row['enabled']) === 1) !== definition.enabled) {
        differences.push({ sourcePath: definition.target.root, field: `schedule:${definition.id}.enabled`, authorityValue: String(row['enabled']), legacyValue: String(definition.enabled) })
      }
    }

    for (const run of legacyRuns) {
      compared += 1
      const row = this.database.withReadOnly(db => db.prepare('SELECT concurrency FROM run_groups WHERE id = ?').get(run.id) as Row | undefined)
      if (row === undefined) {
        differences.push({ sourcePath: run.id, field: `run-group:${run.id}`, authorityValue: null, legacyValue: run.id })
        continue
      }
      if (Number(row['concurrency']) !== run.concurrency) {
        differences.push({ sourcePath: run.id, field: `run-group:${run.id}.concurrency`, authorityValue: String(row['concurrency']), legacyValue: String(run.concurrency) })
      }
      const members = this.database.withReadOnly(db => db.prepare('SELECT COUNT(*) AS count FROM run_members WHERE run_group_id = ?').get(run.id) as Row)
      if (Number(members['count']) !== run.tasks.length) {
        differences.push({ sourcePath: run.id, field: `run-group:${run.id}.members`, authorityValue: String(members['count']), legacyValue: String(run.tasks.length) })
      }
    }

    for (const execution of legacyExecutions) {
      compared += 1
      const row = this.database.withReadOnly(db => db.prepare('SELECT id FROM schedule_executions WHERE idempotency_key = ? LIMIT 1').get(execution.id) as Row | undefined)
      if (row === undefined) {
        differences.push({ sourcePath: execution.scheduledRunId, field: `execution:${execution.id}`, authorityValue: null, legacyValue: execution.id })
      }
    }

    const bounded = differences.slice(0, MIGRATION_MAX_SHADOW_DIFFERENCES)
    return { differences: bounded, compared, clean: bounded.length === 0 }
  }

  // -- cutover helpers -------------------------------------------------------

  /**
   * Re-hashes every source under the held migration lease. Any change after the
   * shadow comparison invalidates the snapshot and returns to explicit import;
   * final hashes are never trusted from an unfrozen writer set.
   */
  async rehashFrozenSources(): Promise<MigrationSourceSet> {
    this.requireState('preparing', 'shadow', 'draining', 'cutting-over')
    const expected = this.status().sourceSetSha256
    const { sourceSet } = await this.readSources()
    if (expected === null || expected !== sourceSet.sha256) {
      this.database.withImmediate(db => this.setState(db, 'preparing', sourceSet.sha256))
      throw new TaskAuthorityMigrationError('MIGRATION_SOURCE_CHANGED', 'sources changed after the frozen snapshot; re-run the explicit import before cutover')
    }
    return sourceSet
  }

  /** Moves the durable state to cutting-over once the lease is drained and frozen. */
  cutover(sourceSet: MigrationSourceSet): void {
    this.requireState('preparing', 'shadow', 'draining', 'cutting-over')
    this.database.withImmediate(db => this.setState(db, 'cutting-over', sourceSet.sha256))
  }

  /**
   * Publishes a preserved backup plus a directory fence for each profile-global
   * operational snapshot, fsyncing the file (and the parent directory where the
   * platform supports it) before the caller records the durable
   * retirement/fence receipt.
   *
   * Backups are never deleted: the legacy file is copied, the copy is verified
   * against the frozen digest, and only then is the original retired as an
   * authority source. The original file itself stays on disk.
   */
  publishOperationalFences(migrationId: string): readonly Readonly<{ retiredPath: string; fenceReceiptSha256: string; fsynced: boolean }>[] {
    this.requireState('cutting-over')
    const fenceDirectory = join(this.userDataDirectory, 'task-authority-migration')
    mkdirSync(fenceDirectory, { recursive: true, mode: 0o700 })
    const receipts: Array<Readonly<{ retiredPath: string; fenceReceiptSha256: string; fsynced: boolean }>> = []
    for (const sourceKind of OPERATIONAL_SOURCE_KINDS) {
      const source = readLegacyOperationalFile(this.userDataDirectory, sourceKind)
      // A snapshot that never existed has no legacy writer to retire, so there
      // is nothing to preserve or fence.
      if (!isPrivateFile(source.path)) continue
      const backupPath = join(fenceDirectory, `${basename(source.path)}.retired`)
      if (!isPrivateFile(backupPath)) {
        atomicWritePrivate(backupPath, Buffer.from(source.text, 'utf8'))
      }
      if (sha256Hex(readFileSync(backupPath)) !== source.sha256) {
        throw new TaskAuthorityMigrationError('MIGRATION_SOURCE_CHANGED', `preserved backup of ${source.path} did not reproduce the frozen digest`)
      }
      const fencePath = join(fenceDirectory, `${basename(source.path)}.fence`)
      atomicWritePrivate(fencePath, Buffer.from(JSON.stringify({ retiredPath: source.path, sha256: source.sha256, migrationId }), 'utf8'))
      // Only the file fsync is claimed: process-crash durability for this file
      // is what the published receipt actually proves on this platform.
      const fsynced = fsyncPath(fencePath) && fsyncPath(backupPath)
      receipts.push({
        retiredPath: source.path,
        fenceReceiptSha256: sha256Hex(JSON.stringify({ migrationId, sourceKind, retiredPath: source.path, sha256: source.sha256 })),
        fsynced
      })
    }
    return receipts
  }

  /** Records the durable active state and the generated export checkpoints. */
  activate(repositoryIds: readonly string[]): void {
    this.requireState('cutting-over', 'active')
    const sourceSetSha256 = this.status().sourceSetSha256
    this.database.withImmediate(db => {
      for (const repositoryId of repositoryIds) {
        db.prepare('INSERT INTO projection_checkpoints(name, sequence, updated_at) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET sequence = excluded.sequence, updated_at = excluded.updated_at')
          .run(`backlog-export:${repositoryId}`, 0, new Date().toISOString())
      }
      this.setState(db, 'active', sourceSetSha256)
    })
  }

  /** Durable failure; startup must resolve this before any affected handler registers. */
  fail(reason: string): void {
    this.database.withImmediate(db => this.setState(db, 'failed', null, reason))
  }

  /**
   * Returns to the legacy state and discards candidate-only imported authority
   * rows through provenance-guarded deletes. Native post-cutover rows are never
   * touched: every statement below is scoped to `imported-legacy` provenance.
   */
  abort(): void {
    this.database.withImmediate(db => {
      // Deletion order follows the foreign keys with `foreign_keys=ON`: every
      // child row that references an imported task, attempt, schedule, group,
      // or specification is removed before the row it points at. Imported rows
      // carry either `imported-legacy` (attempts, tasks, imported schedule
      // tasks) or `legacy-unknown` (historical execution specifications), so
      // both provenance values are covered wherever the spec may appear.
      const importedSpecifications = "SELECT id FROM execution_specifications WHERE provenance_kind IN ('imported-legacy','legacy-unknown')"
      const importedTasks = "SELECT id FROM tasks WHERE provenance_kind = 'imported-legacy'"
      const importedAttempts = "SELECT id FROM attempts WHERE provenance_kind = 'imported-legacy'"
      const importedGroups = "SELECT authority_entity_id FROM migration_entity_mappings WHERE entity_kind = 'run-group'"
      const importedSchedules = "SELECT authority_entity_id FROM migration_entity_mappings WHERE entity_kind = 'schedule'"

      // 1. Leaves that reference an imported task/attempt/artifact.
      db.prepare(`DELETE FROM artifact_adoptions WHERE artifact_id IN (SELECT id FROM verification_artifacts WHERE provenance_kind = 'imported-legacy')`).run()
      db.prepare(`DELETE FROM verification_artifacts WHERE provenance_kind = 'imported-legacy'`).run()
      db.prepare(`DELETE FROM task_mailbox WHERE task_id IN (${importedTasks})`).run()
      db.prepare(`DELETE FROM task_events WHERE task_id IN (${importedTasks})`).run()
      db.prepare(`DELETE FROM handoff_offers WHERE attempt_id IN (${importedAttempts})`).run()
      db.prepare(`DELETE FROM launch_intents WHERE attempt_id IN (${importedAttempts})`).run()
      db.prepare(`DELETE FROM runtime_reconciliations WHERE attempt_id IN (${importedAttempts})`).run()
      db.prepare(`DELETE FROM lease_renewals WHERE attempt_id IN (${importedAttempts})`).run()
      db.prepare(`DELETE FROM leases WHERE attempt_id IN (${importedAttempts})`).run()
      db.prepare(`DELETE FROM resource_reservations WHERE attempt_id IN (${importedAttempts})`).run()

      // 2. Group/schedule children before their parents.
      db.prepare(`DELETE FROM run_members WHERE run_group_id IN (${importedGroups}) OR task_id IN (${importedTasks})`).run()
      db.prepare(`DELETE FROM schedule_executions WHERE schedule_id IN (${importedSchedules}) OR task_id IN (${importedTasks})`).run()
      db.prepare(`DELETE FROM run_groups WHERE id IN (${importedGroups})`).run()
      db.prepare(`DELETE FROM schedules WHERE id IN (${importedSchedules})`).run()

      // 3. Task children, then tasks themselves (dependencies reference tasks).
      db.prepare(`DELETE FROM task_dependencies WHERE task_id IN (${importedTasks}) OR depends_on_task_id IN (${importedTasks})`).run()
      // Attempts must go before tasks: they reference their task.
      db.prepare(`UPDATE tasks SET current_attempt_id = NULL WHERE current_attempt_id IN (${importedAttempts})`).run()
      db.prepare(`DELETE FROM attempts WHERE id IN (${importedAttempts})`).run()
      // Specs reference their task, so they go before it — both provenance values.
      db.prepare(`DELETE FROM execution_specifications WHERE id IN (${importedSpecifications})`).run()
      db.prepare(`DELETE FROM tasks WHERE id IN (${importedTasks})`).run()

      // 4. Provenance rows last.
      db.prepare('DELETE FROM migration_entity_mappings').run()
      db.prepare('DELETE FROM migration_sources').run()
      this.setState(db, 'legacy', null, 'ABORTED')
    })
  }

  /**
   * The migration-only Backlog reader is unreachable once the authority is
   * active: post-cutover reads and writes ignore Backlog as an authority.
   */
  readBacklogSnapshot(identity: BacklogWorkspaceIdentity): Promise<BacklogProjectSnapshot> {
    this.requireState('legacy', 'preparing', 'shadow', 'draining', 'cutting-over')
    return this.reader.readProject(identity)
  }

  /**
   * Generates the human-readable Backlog-compatible export into a private
   * user-data projection directory keyed by repository ID. The export carries a
   * generated/read-only header and the source authority event sequence, and is
   * never parsed back into authority. Repository task files are never touched.
   *
   * The projection is scoped to the requested project: an export keyed by one
   * repository must never carry another repository's tasks.
   */
  exportBacklog(projectId: string, limit = MIGRATION_EXPORT_LIMIT): Readonly<{ path: string; sha256: string; tasks: number }> {
    this.requireState('active')
    const status = this.status()
    const repositoryId = boundedField(projectId, 'repositoryId', 128)
    const directory = join(this.userDataDirectory, 'task-authority-projections', repositoryId)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const tasks = this.authority.query({
      connection: { connectionId: 'migration-export', role: 'administrator' },
      projectId: repositoryId,
      limit: Math.max(1, Math.min(limit, 500))
    }).tasks
    const events = this.database.withReadOnly(db => db.prepare('SELECT sequence, event_type, entity_version, created_at FROM task_events WHERE project_id = ? ORDER BY sequence LIMIT 500').all(repositoryId) as Row[])
    const lines = [
      '<!-- generated: do not edit; this is a read-only Task Authority projection -->',
      `<!-- authority: task-authority; profile: ${this.profileId}; repository: ${repositoryId} -->`,
      `<!-- scope: project ${repositoryId} only; no other project's tasks are included -->`,
      `<!-- frozen-source-set: ${status.sourceSetSha256 ?? 'unknown'} -->`,
      '',
      ...tasks.map(task => `- [${task.status}] ${task.externalTaskId} · ${task.title}${task.dependencies.length === 0 ? '' : ` (depends on ${task.dependencies.join(', ')})`}`),
      '',
      '<!-- authority event sequence -->',
      ...events.map(event => `<!-- ${String(event['sequence'])} ${String(event['event_type'])} v${String(event['entity_version'])} ${String(event['created_at'])} -->`)
    ]
    const target = join(directory, 'backlog-export.md')
    atomicWritePrivate(target, Buffer.from(`${lines.join('\n')}\n`, 'utf8'))
    return { path: target, sha256: sha256Hex(readFileSync(target)), tasks: tasks.length }
  }
}
