import type { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import {
  PROJECT_MEMORY_MAX_HISTORY_REVISIONS, PROJECT_MEMORY_SCHEMA_VERSION, PROJECT_MEMORY_MAX_ENTRIES, PROJECT_MEMORY_MAX_ENTRIES_PER_PROJECT,
  parseProjectMemoryDocument, parseProjectMemoryProject, parseStoredProjectMemoryEntry,
  projectMemoryRevisionFromEntry, type ProjectMemoryProject, type StoredProjectMemoryEntry
} from '@shared/project-memory'
import { ProjectMemoryConflictError, ProjectMemoryNotFoundError, ProjectMemoryLimitError } from './project-memory-store'

function assertSchema(db: DatabaseSync): void {
  if (db.prepare('PRAGMA user_version').get()?.user_version !== 1) throw new Error('Unsupported project memory database schema')
}

/** Internal migration/export operation; callers must not expose an unscoped database export to agents. */
export function readSqliteMemoryDocument(db: DatabaseSync) {
  db.exec('BEGIN')
  try {
    assertSchema(db)
    const entries = db.prepare('SELECT current_json,history_json FROM entries WHERE project_key = ? ORDER BY id')
    return parseProjectMemoryDocument({
      schemaVersion: PROJECT_MEMORY_SCHEMA_VERSION,
      projects: db.prepare('SELECT project_key,project_path FROM projects ORDER BY project_key').all().map(project => ({
        projectKey: project.project_key,
        projectPath: project.project_path,
        entries: entries.all(project.project_key!).map(entry => ({ current: JSON.parse(String(entry.current_json)), history: JSON.parse(String(entry.history_json)) }))
      }))
    })
  } finally { db.exec('ROLLBACK') }
}

export function createSqliteMemoryEntry(db: DatabaseSync, projectValue: ProjectMemoryProject, value: StoredProjectMemoryEntry) {
  const project = parseProjectMemoryProject(projectValue)
  const entry = parseStoredProjectMemoryEntry(value)
  if (entry.current.revision !== 1) throw new Error('A new project memory entry must start at revision 1')
  db.exec('BEGIN IMMEDIATE')
  try {
    assertSchema(db)
    if (db.prepare('SELECT id FROM entries WHERE id = ?').get(entry.current.id)) throw new ProjectMemoryConflictError(entry.current.id, 1, 1)
    if (Number(db.prepare('SELECT count(*) AS n FROM entries').get()!.n) >= PROJECT_MEMORY_MAX_ENTRIES) throw new ProjectMemoryLimitError('Project memory entry limit reached')
    if (Number(db.prepare('SELECT count(*) AS n FROM entries WHERE project_key = ?').get(project.projectKey)!.n) >= PROJECT_MEMORY_MAX_ENTRIES_PER_PROJECT) throw new ProjectMemoryLimitError('Project memory entry limit reached for this project')
    db.prepare('INSERT INTO projects(project_key,project_path) VALUES (?,?) ON CONFLICT(project_key) DO UPDATE SET project_path=excluded.project_path').run(project.projectKey, project.projectPath)
    db.prepare('INSERT INTO entries(id,project_key,current_json,history_json) VALUES (?,?,?,?)').run(entry.current.id, project.projectKey, JSON.stringify(entry.current), '[]')
    db.exec('COMMIT')
    return entry.current
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Atomically publish a validated next revision and its retained history, scoped by project and ID. */
export function replaceSqliteMemoryEntry(db: DatabaseSync, projectValue: ProjectMemoryProject, expectedRevision: number, value: StoredProjectMemoryEntry) {
  const project = parseProjectMemoryProject(projectValue)
  const next = parseStoredProjectMemoryEntry(value)
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('expectedRevision must be a positive integer')
  db.exec('BEGIN IMMEDIATE')
  try {
    assertSchema(db)
    const row = db.prepare('SELECT current_json,history_json FROM entries WHERE project_key = ? AND id = ?').get(project.projectKey, next.current.id)
    if (!row) throw new ProjectMemoryNotFoundError(next.current.id)
    const previous = parseStoredProjectMemoryEntry({ current: JSON.parse(String(row.current_json)), history: JSON.parse(String(row.history_json)) })
    if (previous.current.revision !== expectedRevision) throw new ProjectMemoryConflictError(next.current.id, expectedRevision, previous.current.revision)
    if (next.current.revision !== expectedRevision + 1 || next.current.createdAt !== previous.current.createdAt || next.current.updatedAt <= previous.current.updatedAt) {
      throw new Error('Memory replacement must advance exactly one revision and preserve creation time')
    }
    const history = [...previous.history, projectMemoryRevisionFromEntry(previous.current)].slice(-PROJECT_MEMORY_MAX_HISTORY_REVISIONS)
    if (!isDeepStrictEqual(next.history, history)) throw new Error('Memory replacement must preserve retained revision history')
    const result = db.prepare('UPDATE entries SET current_json = ?, history_json = ? WHERE project_key = ? AND id = ? AND revision = ?')
      .run(JSON.stringify(next.current), JSON.stringify(next.history), project.projectKey, next.current.id, expectedRevision)
    if (result.changes !== 1) throw new Error('Memory revision update did not affect exactly one scoped entry')
    db.prepare('UPDATE projects SET project_path = ? WHERE project_key = ?').run(project.projectPath, project.projectKey)
    db.exec('COMMIT')
    return next.current
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
