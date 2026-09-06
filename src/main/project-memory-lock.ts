import { closeSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export class ProjectMemoryMaintenanceError extends Error {
  readonly code = 'PROJECT_MEMORY_MAINTENANCE'
  readonly retryable = true

  constructor() { super('Project memory is in maintenance or another writer is active; retry after it finishes') }
}

/** Synchronous critical section, shared by writers and migration.
 * ponytail: one profile-wide lock; use per-project transactions only after shared-store migration.
 * This empty SQLite file owns no memory data. OS locks disappear on process exit.
 */
export function withProjectMemoryWriteLock<T>(userDataDir: string, action: () => T): T {
  mkdirSync(userDataDir, { recursive: true, mode: 0o700 })
  const path = join(userDataDir, 'project-memory.lock.sqlite')
  try { closeSync(openSync(path, 'wx', 0o600)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const identity = lstatSync(path)
  if (!identity.isFile() || identity.isSymbolicLink() || (process.platform !== 'win32'
    && ((identity.mode & 0o077) !== 0 || (process.getuid && identity.uid !== process.getuid())))) {
    throw new Error('Project memory lock must be a private regular file owned by the current user')
  }
  const db = new DatabaseSync(path)
  try {
    try { db.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE') }
    catch (error) {
      if ((error as { errcode?: number }).errcode === 5 || (error as { errcode?: number }).errcode === 6) throw new ProjectMemoryMaintenanceError()
      throw error
    }
    return action()
  } finally { db.close() }
}
