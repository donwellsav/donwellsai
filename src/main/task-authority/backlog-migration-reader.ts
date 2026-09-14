import { createHash } from 'node:crypto'
import { isObject } from '@shared/command-catalog'
import { canonicalExternalTaskId, TASK_AUTHORITY_MAX_TITLE, TASK_AUTHORITY_MAX_USER_TEXT } from '@shared/task-authority'

/**
 * Migration-only Backlog.md reader.
 *
 * It enumerates and validates *complete* task records — project-scoped external
 * ID, title, body, status, priority, and dependency edges — from the admitted
 * pinned CLI plus each task's exact source file. It deliberately does not reuse
 * the summary-only `inspect()` projection or the existence-only `requireTask()`
 * check, because neither proves the fields a migration must normalize.
 *
 * Nothing here writes, and nothing here invents certainty: a record that
 * cannot be validated fails the whole snapshot closed, and the caller leaves
 * every source untouched.
 */

export const BACKLOG_MAX_TASKS = 500
export const BACKLOG_MAX_TASK_FILE_BYTES = 512 * 1024
export const BACKLOG_MAX_TITLE = TASK_AUTHORITY_MAX_TITLE
export const BACKLOG_MAX_BODY = TASK_AUTHORITY_MAX_USER_TEXT
export const BACKLOG_MAX_DEPENDENCIES = 100
export const BACKLOG_MAX_PRIORITY = 1_000_000

/** Canonical legacy status as the source states it. Migration maps states; the reader never guesses. */
export type BacklogTaskStatus = 'todo' | 'in-progress' | 'blocked' | 'done'

export type BacklogMigrationSourceErrorKind = 'corrupt' | 'oversized' | 'unsupported' | 'changed' | 'unsafe'

export class BacklogMigrationSourceError extends Error {
  constructor(
    readonly kind: BacklogMigrationSourceErrorKind,
    readonly path: string,
    detail: string
  ) {
    super(`Backlog migration source ${path}: ${detail}`)
    this.name = 'BacklogMigrationSourceError'
  }
}

export type BacklogTaskRecord = Readonly<{
  externalTaskId: string
  externalTaskIdCanonical: string
  title: string
  body: string
  status: BacklogTaskStatus
  statusText: string
  /** Explicit source priority, or 0 with `priorityExplicit: false` when the record carries none. */
  priority: number
  priorityExplicit: boolean
  dependencies: readonly string[]
  /** Repository-relative path of the exact task file that produced this record. */
  sourcePath: string
  sourceSha256: string
  sourceBytes: number
}>

export type BacklogProjectSnapshot = Readonly<{
  projectId: string
  repositoryId: string
  workspaceRoot: string
  canonicalWorkspaceRoot: string
  /** Digest over every validated task file in canonical source-path order. */
  sourceSha256: string
  sources: readonly Readonly<{ path: string; sha256: string; bytes: number }>[]
  tasks: readonly BacklogTaskRecord[]
}>

/**
 * Bounded, already-admitted CLI and workspace-file access. Production wires the
 * pinned Backlog executable and the confined workspace reader; tests inject a
 * fake so no real Backlog binary is required.
 */
export type BacklogMigrationReadPort = Readonly<{
  /**
   * Runs the admitted pinned CLI in the identified workspace and returns its
   * parsed JSON. The identity is bound here — not inferred from process state —
   * so an enumeration can never silently read a different project's files.
   */
  run(identity: BacklogWorkspaceIdentity, args: readonly string[]): Promise<unknown>
  /** Reads one workspace-relative task file without following links outside the workspace. */
  readWorkspaceFile(identity: BacklogWorkspaceIdentity, relPath: string): Promise<Readonly<{ bytes: Buffer; truncated: boolean; binary: boolean }>>
}>

export type BacklogWorkspaceIdentity = Readonly<{
  projectId: string
  repositoryId: string
  /** Realpath-resolved workspace root used for the migration source record. */
  workspaceRoot: string
}>

const STATUS_ALIASES: Record<string, BacklogTaskStatus> = {
  todo: 'todo',
  'to do': 'todo',
  'to-do': 'todo',
  open: 'todo',
  backlog: 'todo',
  new: 'todo',
  ready: 'todo',
  'in progress': 'in-progress',
  'in-progress': 'in-progress',
  inprogress: 'in-progress',
  doing: 'in-progress',
  active: 'in-progress',
  'in review': 'in-progress',
  blocked: 'blocked',
  waiting: 'blocked',
  onhold: 'blocked',
  'on hold': 'blocked',
  done: 'done',
  complete: 'done',
  completed: 'done',
  closed: 'done',
  resolved: 'done'
}

function fail(kind: BacklogMigrationSourceErrorKind, path: string, detail: string): never {
  throw new BacklogMigrationSourceError(kind, path, detail)
}

function boundedString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0')) {
    throw new BacklogMigrationSourceError('corrupt', field, `must be a non-empty string of at most ${maximum} characters`)
  }
  return value
}

function normalizeStatus(value: unknown, path: string): { status: BacklogTaskStatus; statusText: string } {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw.length === 0 || raw.length > 128) fail('corrupt', path, 'task status was missing or unbounded')
  const status = STATUS_ALIASES[raw.toLowerCase()]
  if (status === undefined) fail('unsupported', path, `task status "${raw}" is not a supported Backlog state`)
  return { status, statusText: raw }
}

function normalizePriority(value: unknown, path: string): { priority: number; priorityExplicit: boolean } {
  if (value === undefined || value === null) return { priority: 0, priorityExplicit: false }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > BACKLOG_MAX_PRIORITY) {
    fail('unsupported', path, 'task priority was not a bounded non-negative integer')
  }
  return { priority: value, priorityExplicit: true }
}

/** Dependency edges are external IDs; both bare strings and `{ id }` objects are accepted. */
function normalizeDependencies(value: unknown, path: string, ownId: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > BACKLOG_MAX_DEPENDENCIES) {
    fail('unsupported', path, `task dependencies must be an array of at most ${BACKLOG_MAX_DEPENDENCIES} entries`)
  }
  const dependencies: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const id = typeof entry === 'string' ? entry : isObject(entry) && typeof entry['id'] === 'string' ? entry['id'] : undefined
    if (id === undefined) fail('corrupt', path, 'task dependency entry carried no external id')
    const canonical = canonicalExternalTaskId(boundedString(id, path, 128))
    if (canonical === canonicalExternalTaskId(ownId)) fail('unsupported', path, 'task depends on itself')
    if (seen.has(canonical)) fail('corrupt', path, `task dependency "${id}" was duplicated`)
    seen.add(canonical)
    dependencies.push(id)
  }
  return dependencies
}

/**
 * Validates one `task view` payload into a complete record. Every field a
 * migration must normalize is required: an incomplete record is a corrupt
 * source, never a partially-trusted import.
 */
export function normalizeBacklogTask(payload: unknown, expectedExternalTaskId: string, path: string): Omit<BacklogTaskRecord, 'sourceSha256' | 'sourceBytes'> {
  if (!isObject(payload)) fail('corrupt', path, 'task view payload was not an object')
  if (payload['schemaVersion'] !== 1 || payload['kind'] !== 'task-view') fail('unsupported', path, 'task view payload had an unsupported schema version or kind')
  const task = payload['task']
  if (!isObject(task)) fail('corrupt', path, 'task view payload carried no task object')
  const externalTaskId = boundedString(task['id'], path, 128)
  if (canonicalExternalTaskId(externalTaskId) !== canonicalExternalTaskId(expectedExternalTaskId)) {
    fail('changed', path, `task view returned "${externalTaskId}" for requested "${expectedExternalTaskId}"`)
  }
  const sourcePath = boundedString(task['path'], path, 4096)
  const title = typeof task['title'] === 'string' ? task['title'].trim() : ''
  if (title.length === 0 || title.length > BACKLOG_MAX_TITLE) fail('unsupported', path, 'task title was missing or out of bounds')
  const body = task['body'] === undefined || task['body'] === null ? '' : task['body']
  if (typeof body !== 'string' || body.length > BACKLOG_MAX_BODY) fail('unsupported', path, 'task body was not bounded text')
  const { status, statusText } = normalizeStatus(task['status'], path)
  const { priority, priorityExplicit } = normalizePriority(task['priority'], path)
  const dependencies = normalizeDependencies(task['dependencies'], path, externalTaskId)
  return {
    externalTaskId,
    externalTaskIdCanonical: canonicalExternalTaskId(externalTaskId),
    title,
    body,
    status,
    statusText,
    priority,
    priorityExplicit,
    dependencies,
    sourcePath
  }
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function parseTaskIds(listPayload: unknown): string[] {
  if (!isObject(listPayload)) fail('corrupt', 'task list', 'task list payload was not an object')
  if (listPayload['schemaVersion'] !== 1 || listPayload['kind'] !== 'task-list') {
    fail('unsupported', 'task list', 'task list payload had an unsupported schema version or kind')
  }
  const tasks = listPayload['tasks']
  if (!Array.isArray(tasks) || tasks.length > BACKLOG_MAX_TASKS) {
    fail('oversized', 'task list', `task list must contain at most ${BACKLOG_MAX_TASKS} tasks`)
  }
  const ids: string[] = []
  const seen = new Set<string>()
  for (const entry of tasks) {
    if (!isObject(entry) || typeof entry['id'] !== 'string') fail('corrupt', 'task list', 'task list entry carried no id')
    const id = boundedString(entry['id'], 'task list', 128)
    const canonical = canonicalExternalTaskId(id)
    if (seen.has(canonical)) fail('corrupt', 'task list', `task id "${id}" was listed more than once`)
    seen.add(canonical)
    ids.push(id)
  }
  return ids
}

/** Deterministic digest over the exact validated source files, in canonical path order. */
export function backlogSnapshotSha256(sources: readonly Readonly<{ path: string; sha256: string; bytes: number }>[]): string {
  const ordered = [...sources].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return sha256Hex(Buffer.from(JSON.stringify(ordered.map(source => [source.path, source.sha256, source.bytes])), 'utf8'))
}

/**
 * Enumerates the complete Backlog task set for one registered project.
 *
 * Every task file is read and hashed, so the returned snapshot is exactly the
 * frozen source the migration records: same path, same bytes, same digest.
 */
export class BacklogMigrationReader {
  constructor(private readonly port: BacklogMigrationReadPort) {}

  async readProject(identity: BacklogWorkspaceIdentity): Promise<BacklogProjectSnapshot> {
    const projectId = boundedString(identity.projectId, 'projectId', 128)
    const repositoryId = boundedString(identity.repositoryId, 'repositoryId', 128)
    const workspaceRoot = boundedString(identity.workspaceRoot, 'workspaceRoot', 4096)
    const scope: BacklogWorkspaceIdentity = { projectId, repositoryId, workspaceRoot }
    const ids = parseTaskIds(await this.port.run(scope, ['task', 'list', '--json', '--limit', String(BACKLOG_MAX_TASKS)]))
    const tasks: BacklogTaskRecord[] = []
    for (const id of ids) {
      const view = await this.port.run(scope, ['task', 'view', id, '--json'])
      const normalized = normalizeBacklogTask(view, id, id)
      const file = await this.port.readWorkspaceFile(scope, normalized.sourcePath)
      if (file.binary) fail('unsupported', normalized.sourcePath, 'task source was not supported text')
      if (file.truncated || file.bytes.length > BACKLOG_MAX_TASK_FILE_BYTES) {
        fail('oversized', normalized.sourcePath, `task source exceeded ${BACKLOG_MAX_TASK_FILE_BYTES} bytes`)
      }
      tasks.push({ ...normalized, sourceSha256: sha256Hex(file.bytes), sourceBytes: file.bytes.length })
    }
    const byPath = new Map<string, Readonly<{ path: string; sha256: string; bytes: number }>>()
    for (const task of tasks) {
      const existing = byPath.get(task.sourcePath)
      if (existing !== undefined && existing.sha256 !== task.sourceSha256) {
        fail('changed', task.sourcePath, 'two tasks resolved to one file with different content')
      }
      byPath.set(task.sourcePath, { path: task.sourcePath, sha256: task.sourceSha256, bytes: task.sourceBytes })
    }
    const sources = [...byPath.values()].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    return {
      projectId,
      repositoryId,
      workspaceRoot,
      canonicalWorkspaceRoot: workspaceRoot,
      sourceSha256: backlogSnapshotSha256(sources),
      sources,
      tasks: [...tasks].sort((left, right) => (left.externalTaskIdCanonical < right.externalTaskIdCanonical ? -1 : left.externalTaskIdCanonical > right.externalTaskIdCanonical ? 1 : 0))
    }
  }
}
