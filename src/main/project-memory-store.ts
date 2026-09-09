import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { withProjectMemoryWriteLock } from './project-memory-lock'
import type { DatabaseSync } from 'node:sqlite'
import { abortProjectMemoryMigration, reverseProjectMemoryMigration, migrateProjectMemory, openProjectMemoryDatabase, readProjectMemoryAuthority, type ProjectMemoryAuthority, upgradeProjectMemoryErasureSchema } from './project-memory-migration'
import { createSqliteMemoryEntry, readSqliteMemoryDocument, replaceSqliteMemoryEntry, eraseSqliteMemoryEntry } from './project-memory-sqlite'
import {
  PROJECT_MEMORY_MAX_DOCUMENT_BYTES,
  PROJECT_MEMORY_MAX_ENTRIES,
  PROJECT_MEMORY_MAX_ENTRIES_PER_PROJECT,
  PROJECT_MEMORY_MAX_HISTORY_REVISIONS,
  PROJECT_MEMORY_MAX_RESULT_LIMIT,
  PROJECT_MEMORY_SCHEMA_VERSION,
  parseProjectMemoryDocument,
  parseProjectMemoryEntry,
  parseProjectMemoryProject,
  parseProjectMemoryRevision,
  parseStoredProjectMemoryEntry,
  projectMemoryRevisionFromEntry,
  type ProjectMemoryDocument,
  type ProjectMemoryEntry,
  type ProjectMemoryKind,
  type ProjectMemoryProject,
  type ProjectMemoryRevision,
  type StoredProjectMemoryEntry
} from '@shared/project-memory'

const FILE_NAME = 'project-memory.json'

export type ProjectMemoryLoadErrorKind =
  | 'corrupt'
  | 'unsupported-schema'
  | 'read'
  | 'permissions'
  | 'too-large'

export class ProjectMemoryLoadError extends Error {
  constructor(
    readonly kind: ProjectMemoryLoadErrorKind,
    readonly path: string,
    message: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'ProjectMemoryLoadError'
  }
}

export class ProjectMemoryConflictError extends Error {
  readonly code = 'PROJECT_MEMORY_CONFLICT'

  constructor(
    readonly id: string,
    readonly expectedRevision: number,
    readonly actualRevision: number
  ) {
    super(`Memory ${id} is at revision ${actualRevision}; expected revision ${expectedRevision}`)
    this.name = 'ProjectMemoryConflictError'
  }
}

export class ProjectMemoryNotFoundError extends Error {
  readonly code = 'PROJECT_MEMORY_NOT_FOUND'

  constructor(readonly id: string) {
    super(`Memory ${id} was not found in this project`)
    this.name = 'ProjectMemoryNotFoundError'
  }
}

export class ProjectMemoryStateError extends Error {
  readonly code = 'PROJECT_MEMORY_INVALID_STATE'

  constructor(readonly id: string, archived: boolean) {
    super(`Memory ${id} is already ${archived ? 'archived' : 'active'}`)
    this.name = 'ProjectMemoryStateError'
  }
}

export class ProjectMemoryLimitError extends Error {
  readonly code = 'PROJECT_MEMORY_LIMIT_REACHED'

  constructor(message: string) {
    super(message)
    this.name = 'ProjectMemoryLimitError'
  }
}

export type ProjectMemoryListOptions = {
  query?: string
  kinds?: readonly ProjectMemoryKind[]
  includeArchived: boolean
  offset?: number
  limit: number
}

export type ProjectMemoryReplacement = {
  kind: ProjectMemoryKind
  title: string
  content: string
  tags: string[]
  provenance: ProjectMemoryRevision['provenance']
  updatedAt: string
}

export type ProjectMemoryArchiveTransition = {
  archived: boolean
  provenance: ProjectMemoryRevision['provenance']
  updatedAt: string
}

function emptyDocument(): ProjectMemoryDocument {
  return { schemaVersion: PROJECT_MEMORY_SCHEMA_VERSION, projects: [] }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

/** Any cutover manifest fences this legacy JSON implementation, including a corrupt manifest. */
export function assertJsonAuthority(path: string): void {
  try { lstatSync(join(dirname(path), 'project-memory-active.json')) }
  catch (error) { if (errorCode(error) === 'ENOENT') return; throw error }
  throw Object.assign(new Error('Project memory authority changed; reopen the active backend instead of the legacy JSON snapshot'), {
    code: 'PROJECT_MEMORY_BACKEND_CHANGED'
  })
}

export function readProjectMemorySnapshot(path: string): { document: ProjectMemoryDocument; bytes: Buffer | null } {
  let stat
  try {
    const linkStat = lstatSync(path)
    if (linkStat.isSymbolicLink()) {
      throw new ProjectMemoryLoadError('permissions', path, 'Project memory persistence must not be a symbolic link')
    }
    const flags = process.platform === 'win32'
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW
    const descriptor = openSync(path, flags)
    try {
      stat = fstatSync(descriptor)
      if (!stat.isFile()) {
        throw new ProjectMemoryLoadError('permissions', path, 'Project memory persistence must be a regular file')
      }
      if (stat.size > PROJECT_MEMORY_MAX_DOCUMENT_BYTES) {
        throw new ProjectMemoryLoadError(
          'too-large',
          path,
          `Project memory persistence exceeds ${PROJECT_MEMORY_MAX_DOCUMENT_BYTES} bytes`
        )
      }
      if (process.platform !== 'win32') {
        if ((stat.mode & 0o077) !== 0) {
          throw new ProjectMemoryLoadError('permissions', path, 'Project memory persistence must be owner-only')
        }
        if (process.getuid && stat.uid !== process.getuid()) {
          throw new ProjectMemoryLoadError('permissions', path, 'Project memory persistence must be owned by the current user')
        }
      }
      let decoded: unknown
      let bytes: Buffer
      try {
        bytes = readFileSync(descriptor)
        decoded = JSON.parse(bytes.toString('utf8'))
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new ProjectMemoryLoadError('corrupt', path, 'Project memory persistence contains invalid JSON', error)
        }
        throw error
      }
      if (typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded)
        && 'schemaVersion' in decoded && decoded.schemaVersion !== 1 && decoded.schemaVersion !== PROJECT_MEMORY_SCHEMA_VERSION) {
        throw new ProjectMemoryLoadError(
          'unsupported-schema',
          path,
          `Unsupported project memory schema version: ${String(decoded.schemaVersion)}`
        )
      }
      try {
        return { document: parseProjectMemoryDocument(decoded), bytes }
      } catch (error) {
        throw new ProjectMemoryLoadError('corrupt', path, 'Project memory persistence failed validation', error)
      }
    } finally {
      closeSync(descriptor)
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { document: emptyDocument(), bytes: null }
    if (error instanceof ProjectMemoryLoadError) throw error
    throw new ProjectMemoryLoadError('read', path, 'Project memory persistence could not be read', error)
  }
}

/** Fsync the complete next document before atomically publishing it. */
function writeDocument(path: string, document: ProjectMemoryDocument): void {
  const serialized = `${JSON.stringify(document, null, 2)}\n`
  const byteLength = Buffer.byteLength(serialized)
  if (byteLength > PROJECT_MEMORY_MAX_DOCUMENT_BYTES) {
    throw new ProjectMemoryLimitError(
      `Project memory persistence would exceed ${PROJECT_MEMORY_MAX_DOCUMENT_BYTES} bytes`
    )
  }

  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const previous = readProjectMemorySnapshot(path).bytes
  if (previous && JSON.parse(previous.toString('utf8')).schemaVersion === 1) {
    const backup = openSync(`${path}.schema1-backup-${randomUUID()}`, 'wx', 0o600)
    try { writeFileSync(backup, previous); fsyncSync(backup) } finally { closeSync(backup) }
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, serialized, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, path)
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    rmSync(temporary, { force: true })
    throw error
  }

  if (process.platform === 'win32') return
  let directoryDescriptor: number | undefined
  try {
    directoryDescriptor = openSync(directory, 'r')
    fsyncSync(directoryDescriptor)
  } catch {
    // The file itself is already flushed and atomically renamed. Some Unix
    // filesystems do not support directory fsync.
  } finally {
    if (directoryDescriptor !== undefined) closeSync(directoryDescriptor)
  }
}

function folded(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US')
}

function termOccurrences(value: string, term: string, cap: number): number {
  let count = 0
  let offset = 0
  while (count < cap) {
    const index = value.indexOf(term, offset)
    if (index < 0) break
    count += 1
    offset = index + Math.max(term.length, 1)
  }
  return count
}

function lexicalScore(entry: ProjectMemoryEntry, query: string): number | undefined {
  const normalizedQuery = folded(query)
  const title = folded(entry.title)
  const tags = entry.tags.map(folded)
  const content = folded(entry.content)
  const terms = normalizedQuery.match(/[\p{L}\p{N}_-]+/gu) ?? [normalizedQuery]

  if (terms.some((term) => !title.includes(term)
    && !tags.some((tag) => tag.includes(term))
    && !content.includes(term))) return undefined

  let score = 0
  if (title === normalizedQuery) score += 20_000
  else if (title.startsWith(normalizedQuery)) score += 8_000
  else if (title.includes(normalizedQuery)) score += 4_000
  if (tags.some((tag) => tag === normalizedQuery)) score += 3_000
  else if (tags.some((tag) => tag.includes(normalizedQuery))) score += 1_500
  if (content.includes(normalizedQuery)) score += 500

  for (const term of terms) {
    if (title === term) score += 1_000
    else if (title.startsWith(term)) score += 500
    else score += termOccurrences(title, term, 8) * 160
    for (const tag of tags) {
      if (tag === term) score += 900
      else if (tag.includes(term)) score += 480
    }
    score += termOccurrences(content, term, 20) * 12
  }
  return score
}

function nextHistory(stored: StoredProjectMemoryEntry): ProjectMemoryRevision[] {
  return [...stored.history, projectMemoryRevisionFromEntry(stored.current)]
    .slice(-PROJECT_MEMORY_MAX_HISTORY_REVISIONS)
}

/** Sole main-process persistence authority for every project and harness. */
export class ProjectMemoryStore {
  readonly path: string
  private document: ProjectMemoryDocument
  private readonly authority: ProjectMemoryAuthority | null

  constructor(userDataDir: string) {
    this.path = join(userDataDir, FILE_NAME)
    let authority = readProjectMemoryAuthority(userDataDir)
    if (authority?.state === 'reversing') { reverseProjectMemoryMigration(userDataDir); authority = null }
    if (authority?.state === 'aborting') { abortProjectMemoryMigration(userDataDir); authority = null }
    this.authority = authority?.state === 'preparing' ? migrateProjectMemory(userDataDir) : authority
    this.document = this.authority ? this.withSqlite(true, db => readSqliteMemoryDocument(db)) : readProjectMemorySnapshot(this.path).document
  }

  list(projectKey: string, options: ProjectMemoryListOptions): { entries: ProjectMemoryEntry[]; total: number } {
    this.refreshProject(projectKey)
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > PROJECT_MEMORY_MAX_RESULT_LIMIT) {
      throw new Error(`Project memory result limit must be between 1 and ${PROJECT_MEMORY_MAX_RESULT_LIMIT}`)
    }
    const offset = options.offset ?? 0
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid project memory offset')
    const project = this.document.projects.find((candidate) => candidate.projectKey === projectKey)
    if (!project) return { entries: [], total: 0 }
    const kinds = options.kinds === undefined ? undefined : new Set(options.kinds)
    const ranked: Array<{ entry: ProjectMemoryEntry; score: number }> = []
    for (const stored of project.entries) {
      const entry = stored.current
      if (!options.includeArchived && entry.archivedAt !== null) continue
      if (kinds && !kinds.has(entry.kind)) continue
      const score = options.query === undefined ? 0 : lexicalScore(entry, options.query)
      if (score === undefined) continue
      ranked.push({ entry, score })
    }
    ranked.sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score
      const recency = right.entry.updatedAt.localeCompare(left.entry.updatedAt)
      return recency || left.entry.id.localeCompare(right.entry.id)
    })
    return {
      entries: ranked.slice(offset, offset + options.limit).map(({ entry }, index) => parseProjectMemoryEntry(entry, `list result ${index}`)),
      total: ranked.length
    }
  }

  get(projectKey: string, id: string): ProjectMemoryEntry {
    const stored = this.storedEntry(projectKey, id)
    return parseProjectMemoryEntry(stored.current)
  }

  create(projectValue: ProjectMemoryProject, entryValue: ProjectMemoryEntry): ProjectMemoryEntry {
    const project = parseProjectMemoryProject(projectValue)
    if (this.authority) this.refreshProject(project.projectKey)
    else assertJsonAuthority(this.path)
    const entry = parseProjectMemoryEntry(entryValue)
    if (entry.revision !== 1) throw new Error('A new project memory entry must start at revision 1')
    const totalEntries = this.document.projects.reduce((total, candidate) => total + candidate.entries.length + (candidate.erased?.length ?? 0), 0)
    if (totalEntries >= PROJECT_MEMORY_MAX_ENTRIES) {
      throw new ProjectMemoryLimitError(`Project memory limit reached (${PROJECT_MEMORY_MAX_ENTRIES})`)
    }
    if (this.document.projects.some((candidate) => candidate.entries.some((stored) => stored.current.id === entry.id))) {
      throw new ProjectMemoryConflictError(entry.id, entry.revision, entry.revision)
    }

    const existing = this.document.projects.find((candidate) => candidate.projectKey === project.projectKey)
    if (existing && existing.entries.length >= PROJECT_MEMORY_MAX_ENTRIES_PER_PROJECT) {
      throw new ProjectMemoryLimitError(
        `Project memory limit reached for this project (${PROJECT_MEMORY_MAX_ENTRIES_PER_PROJECT})`
      )
    }
    const stored = parseStoredProjectMemoryEntry({ current: entry, history: [] })
    const nextProject = existing
      ? { ...existing, projectPath: project.projectPath, entries: [...existing.entries, stored] }
      : { ...project, entries: [stored] }
    this.commitProject(nextProject)
    return parseProjectMemoryEntry(entry)
  }

  replace(
    projectValue: ProjectMemoryProject,
    id: string,
    expectedRevision: number,
    replacement: ProjectMemoryReplacement
  ): ProjectMemoryEntry {
    const project = parseProjectMemoryProject(projectValue)
    const { projectDocument, stored, index } = this.locate(project.projectKey, id)
    this.assertRevision(stored.current, expectedRevision)
    if (stored.current.archivedAt !== null) throw new ProjectMemoryStateError(id, true)
    const next = parseProjectMemoryEntry({
      ...stored.current,
      ...replacement,
      revision: stored.current.revision + 1,
      archivedAt: null
    })
    if (next.updatedAt <= stored.current.updatedAt) throw new Error('A memory update timestamp must advance')
    const entries = projectDocument.entries.slice()
    entries[index] = parseStoredProjectMemoryEntry({ current: next, history: nextHistory(stored) })
    this.commitProject({ ...projectDocument, projectPath: project.projectPath, entries })
    return parseProjectMemoryEntry(next)
  }

  setArchived(
    projectValue: ProjectMemoryProject,
    id: string,
    expectedRevision: number,
    transition: ProjectMemoryArchiveTransition
  ): ProjectMemoryEntry {
    const project = parseProjectMemoryProject(projectValue)
    const { projectDocument, stored, index } = this.locate(project.projectKey, id)
    this.assertRevision(stored.current, expectedRevision)
    const currentlyArchived = stored.current.archivedAt !== null
    if (currentlyArchived === transition.archived) throw new ProjectMemoryStateError(id, currentlyArchived)
    const next = parseProjectMemoryEntry({
      ...stored.current,
      revision: stored.current.revision + 1,
      provenance: transition.provenance,
      updatedAt: transition.updatedAt,
      archivedAt: transition.archived ? transition.updatedAt : null
    })
    if (next.updatedAt <= stored.current.updatedAt) throw new Error('A memory archive timestamp must advance')
    const entries = projectDocument.entries.slice()
    entries[index] = parseStoredProjectMemoryEntry({ current: next, history: nextHistory(stored) })
    this.commitProject({ ...projectDocument, projectPath: project.projectPath, entries })
    return parseProjectMemoryEntry(next)
  }

  history(projectKey: string, id: string, limit: number): {
    entry: ProjectMemoryEntry
    revisions: ProjectMemoryRevision[]
    truncated: boolean
  } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > PROJECT_MEMORY_MAX_HISTORY_REVISIONS + 1) {
      throw new Error(`Project memory history limit must be between 1 and ${PROJECT_MEMORY_MAX_HISTORY_REVISIONS + 1}`)
    }
    const stored = this.storedEntry(projectKey, id)
    const all = [
      projectMemoryRevisionFromEntry(stored.current),
      ...stored.history.slice().reverse().map((revision, index) => parseProjectMemoryRevision(revision, `history ${index}`))
    ]
    const revisions = all.slice(0, limit)
    const oldestRetained = stored.history[0]?.revision ?? stored.current.revision
    return {
      entry: parseProjectMemoryEntry(stored.current),
      revisions,
      truncated: all.length > limit || oldestRetained > 1
    }
  }

  erase(project: ProjectMemoryProject, id: string, expectedRevision: number, erasedAt: string) {
    return withProjectMemoryWriteLock(dirname(this.path), () => {
      if (this.authority) return this.withSqlite(false, db => {
        upgradeProjectMemoryErasureSchema(db, join(dirname(this.path), this.authority!.directory, `schema1-backup-${randomUUID()}.sqlite`))
        return eraseSqliteMemoryEntry(db, project.projectKey, id, expectedRevision, erasedAt)
      })
      assertJsonAuthority(this.path)
      this.document = readProjectMemorySnapshot(this.path).document
      const { projectDocument, stored } = this.locate(project.projectKey, id)
      this.assertRevision(stored.current, expectedRevision)
      const erased = { id, revision: expectedRevision, erasedAt }
      this.commitLockedProject({ ...projectDocument, entries: projectDocument.entries.filter(entry => entry.current.id !== id), erased: [...(projectDocument.erased ?? []), erased] })
      return erased
    })
  }

  /** Scoped portable snapshot; retain archived entries and every retained revision. */
  exportProject(project: ProjectMemoryProject): ProjectMemoryDocument['projects'][number] {
    this.refreshProject(project.projectKey)
    if (!this.authority) this.document = readProjectMemorySnapshot(this.path).document
    return structuredClone(this.document.projects.find(value => value.projectKey === project.projectKey) ?? { ...project, entries: [] })
  }

  /** Restore only into an absent identity; never merge or overwrite another project. */
  importProject(value: ProjectMemoryDocument['projects'][number]): void {
    const project = parseProjectMemoryDocument({ schemaVersion: PROJECT_MEMORY_SCHEMA_VERSION, projects: [value] }).projects[0]!
    withProjectMemoryWriteLock(dirname(this.path), () => {
      if (this.authority) {
        this.withSqlite(false, db => {
          upgradeProjectMemoryErasureSchema(db, join(dirname(this.path), this.authority!.directory, `schema1-backup-${randomUUID()}.sqlite`))
          db.exec('BEGIN IMMEDIATE')
          try {
            if (db.prepare('SELECT project_key FROM projects WHERE project_key=?').get(project.projectKey)) throw new Error('Memory project already exists')
            if (Number(db.prepare('SELECT (SELECT count(*) FROM entries) + (SELECT count(*) FROM erased_memories) AS n').get()!.n) + project.entries.length + (project.erased?.length ?? 0) > PROJECT_MEMORY_MAX_ENTRIES) throw new ProjectMemoryLimitError('Project memory entry limit reached')
            db.prepare('INSERT INTO projects(project_key,project_path) VALUES (?,?)').run(project.projectKey, project.projectPath)
            const insert = db.prepare('INSERT INTO entries(id,project_key,current_json,history_json) VALUES (?,?,?,?)')
            for (const entry of project.entries) {
              if (db.prepare('SELECT id FROM erased_memories WHERE id=?').get(entry.current.id)) throw new Error('An erased memory ID cannot be reused')
              insert.run(entry.current.id, project.projectKey, JSON.stringify(entry.current), JSON.stringify(entry.history))
            }
            for (const erased of project.erased ?? []) {
              if (db.prepare('SELECT id FROM entries WHERE id=?').get(erased.id)) throw new Error('Erased ID conflicts with existing memory')
              db.prepare('INSERT INTO erased_memories(id,project_key,revision,erased_at) VALUES (?,?,?,?)').run(erased.id, project.projectKey, erased.revision, erased.erasedAt)
            }
            db.exec('COMMIT')
          } catch (error) { db.exec('ROLLBACK'); throw error }
        })
      } else {
        assertJsonAuthority(this.path)
        const current = readProjectMemorySnapshot(this.path).document
        if (current.projects.some(value => value.projectKey === project.projectKey)) throw new Error('Memory project already exists')
        const next = parseProjectMemoryDocument({ schemaVersion: PROJECT_MEMORY_SCHEMA_VERSION, projects: [...current.projects, project] })
        writeDocument(this.path, next); this.document = next
      }
    })
  }

  /** Roll back only the exact just-imported snapshot, never subsequent edits. */
  removeImportedProject(expected: ProjectMemoryDocument['projects'][number]): void {
    withProjectMemoryWriteLock(dirname(this.path), () => {
      if (this.authority) this.withSqlite(false, db => {
        const actual = readSqliteMemoryDocument(db, expected.projectKey).projects[0]
        const sorted = (value: typeof expected | undefined) => value && { ...value, entries: value.entries.toSorted((a, b) => a.current.id.localeCompare(b.current.id)) }
        if (!isDeepStrictEqual(sorted(actual), sorted(expected))) throw new Error('Imported memory changed; rollback refused')
        db.exec('BEGIN IMMEDIATE')
        try { if (Number(db.prepare('PRAGMA user_version').get()?.user_version) === 2) db.prepare('DELETE FROM erased_memories WHERE project_key=?').run(expected.projectKey); db.prepare('DELETE FROM entries WHERE project_key=?').run(expected.projectKey); db.prepare('DELETE FROM projects WHERE project_key=?').run(expected.projectKey); db.exec('COMMIT') }
        catch (error) { db.exec('ROLLBACK'); throw error }
      })
      else {
        assertJsonAuthority(this.path)
        const current = readProjectMemorySnapshot(this.path).document
        if (!isDeepStrictEqual(current.projects.find(value => value.projectKey === expected.projectKey), expected)) throw new Error('Imported memory changed; rollback refused')
        const next = { ...current, projects: current.projects.filter(value => value.projectKey !== expected.projectKey) }
        writeDocument(this.path, next); this.document = next
      }
    })
  }

  private storedEntry(projectKey: string, id: string): StoredProjectMemoryEntry {
    return this.locate(projectKey, id).stored
  }

  private locate(projectKey: string, id: string): {
    projectDocument: ProjectMemoryDocument['projects'][number]
    stored: StoredProjectMemoryEntry
    index: number
  } {
    this.refreshProject(projectKey)
    const projectDocument = this.document.projects.find((candidate) => candidate.projectKey === projectKey)
    if (!projectDocument) throw new ProjectMemoryNotFoundError(id)
    const index = projectDocument.entries.findIndex((candidate) => candidate.current.id === id)
    if (index < 0) throw new ProjectMemoryNotFoundError(id)
    return { projectDocument, stored: projectDocument.entries[index]!, index }
  }

  private assertRevision(entry: ProjectMemoryEntry, expectedRevision: number): void {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new Error('expectedRevision must be a positive integer')
    }
    if (entry.revision !== expectedRevision) {
      throw new ProjectMemoryConflictError(entry.id, expectedRevision, entry.revision)
    }
  }

  private commitProject(project: ProjectMemoryDocument['projects'][number]): void {
    withProjectMemoryWriteLock(dirname(this.path), () => this.commitLockedProject(project))
  }

  private commitLockedProject(project: ProjectMemoryDocument['projects'][number]): void {
    if (this.authority) {
      const previous = this.document.projects.find(candidate => candidate.projectKey === project.projectKey)
      const before = new Map(previous?.entries.map(entry => [entry.current.id, entry]))
      const changed = project.entries.filter(entry => !isDeepStrictEqual(entry, before.get(entry.current.id)))
      if (changed.length !== 1) throw new Error('Memory mutation must change exactly one entry')
      const next = changed[0]!
      const old = before.get(next.current.id)
      this.withSqlite(false, db => {
        const identity = { projectKey: project.projectKey, projectPath: project.projectPath }
        if (old) replaceSqliteMemoryEntry(db, identity, old.current.revision, next)
        else createSqliteMemoryEntry(db, identity, next)
      })
      this.document = { schemaVersion: PROJECT_MEMORY_SCHEMA_VERSION, projects: [project] }
      return
    }
    assertJsonAuthority(this.path)
    const current = readProjectMemorySnapshot(this.path).document
    if (!isDeepStrictEqual(current, this.document)) {
      this.document = current
      throw Object.assign(new Error('Project memory changed in another writer; read the current memory and retry'), {
        code: 'PROJECT_MEMORY_CHANGED', retryable: true
      })
    }
    const index = this.document.projects.findIndex((candidate) => candidate.projectKey === project.projectKey)
    const projects = this.document.projects.slice()
    if (index < 0) projects.push(project)
    else projects[index] = project
    projects.sort((left, right) => left.projectKey.localeCompare(right.projectKey))
    const document = parseProjectMemoryDocument({
      schemaVersion: PROJECT_MEMORY_SCHEMA_VERSION,
      projects
    })
    writeDocument(this.path, document)
    this.document = document
  }

  private refreshProject(projectKey: string): void {
    if (!this.authority) {
      assertJsonAuthority(this.path)
      this.document = readProjectMemorySnapshot(this.path).document
      return
    }
    this.document = this.withSqlite(true, db => readSqliteMemoryDocument(db, projectKey))
  }

  private withSqlite<T>(readOnly: boolean, operation: (db: DatabaseSync) => T): T {
    const profile = dirname(this.path)
    const run = () => {
      const current = readProjectMemoryAuthority(profile)
      if (current?.state !== 'sqlite' || current.directory !== this.authority?.directory) {
        throw Object.assign(new Error('Project memory authority changed; reopen the active backend'), { code: 'PROJECT_MEMORY_BACKEND_CHANGED' })
      }
      const db = openProjectMemoryDatabase(profile, current, readOnly)
      try { return operation(db) } finally { db.close() }
    }
    // Writes already hold this lock through commitProject; readers fence authority switches too.
    return readOnly ? withProjectMemoryWriteLock(profile, run) : run()
  }
}
