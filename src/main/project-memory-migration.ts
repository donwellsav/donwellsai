import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PROJECT_MEMORY_MAX_DOCUMENT_BYTES, type ProjectMemoryDocument } from '@shared/project-memory'
import { assertJsonAuthority, readProjectMemorySnapshot } from './project-memory-store'
import { withProjectMemoryWriteLock } from './project-memory-lock'
import { readSqliteMemoryDocument } from './project-memory-sqlite'

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function projectEvidence(document: ProjectMemoryDocument) {
  return document.projects.map(project => ({
    projectKey: project.projectKey,
    entries: project.entries.length,
    historyRevisions: project.entries.reduce((count, entry) => count + entry.history.length, 0),
    sha256: digest(JSON.stringify({ ...project, entries: project.entries.slice().sort((a, b) => a.current.id.localeCompare(b.current.id)) }))
  })).sort((a, b) => a.projectKey.localeCompare(b.projectKey))
}

function writePrivate(path: string, bytes: string | Buffer, mode = 0o600): void {
  const descriptor = openSync(path, 'wx', mode)
  try { writeFileSync(descriptor, bytes); fsyncSync(descriptor) }
  finally { closeSync(descriptor) }
}

export type ProjectMemoryAuthority = {
  schemaVersion: 1
  state: 'preparing' | 'sqlite' | 'aborting'
  directory: string
  sourceSha256: string | null
  contentSha256: string
}

function privatePath(path: string, directory = false): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || (process.platform !== 'win32'
    && ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())))) throw new Error('Unsafe project memory authority path: ' + path)
}

export function readProjectMemoryAuthority(profile: string): ProjectMemoryAuthority | null {
  const path = join(profile, 'project-memory-active.json')
  try { privatePath(path) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let value: ProjectMemoryAuthority
  try {
    if (fstatSync(fd).size > 4096) throw new Error('Project memory authority manifest is too large')
    try { value = JSON.parse(readFileSync(fd, 'utf8')) }
    catch (error) { throw new Error('Invalid project memory authority manifest', { cause: error }) }
  } finally { closeSync(fd) }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'contentSha256,directory,schemaVersion,sourceSha256,state'
    || value.schemaVersion !== 1 || !['preparing', 'sqlite', 'aborting'].includes(value.state)
    || typeof value.directory !== 'string' || !/^project-memory-migration-[A-Za-z0-9]+$/.test(value.directory)
    || typeof value.contentSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.contentSha256)
    || !(value.sourceSha256 === null || typeof value.sourceSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sourceSha256))) throw new Error('Invalid project memory authority manifest')
  return value
}

export function openProjectMemoryDatabase(profile: string, authority: ProjectMemoryAuthority, readOnly: boolean): DatabaseSync {
  const directory = join(profile, authority.directory)
  privatePath(directory, true)
  const path = join(directory, 'project-memory.sqlite')
  privatePath(path)
  return new DatabaseSync(path, { readOnly })
}

function syncDirectory(path: string): void {
  if (process.platform === 'win32') return
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function publishAuthority(profile: string, value: ProjectMemoryAuthority): void {
  const path = join(profile, 'project-memory-active.json')
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writePrivate(temporary, JSON.stringify(value) + '\n')
    renameSync(temporary, path)
    syncDirectory(profile)
  } finally { rmSync(temporary, { force: true }) }
}

export type MemoryMigrationBoundary = 'candidate-prepared' | 'manifest-prepared' | 'legacy-retired' | 'legacy-fenced' | 'manifest-active'

/** Resume interrupted cutover under the same OS lock used by every current writer. */
export function migrateProjectMemory(userDataDir: string, onBoundary: (boundary: MemoryMigrationBoundary) => void = () => {}) {
  const profile = resolve(userDataDir)
  return withProjectMemoryWriteLock(profile, () => {
    let authority = readProjectMemoryAuthority(profile)
    if (authority?.state === 'aborting') throw new Error('Project memory abort is in progress; reopen memory to complete recovery')
    if (!authority) {
      const prepared = prepareLockedMigration(profile)
      onBoundary('candidate-prepared')
      authority = { schemaVersion: 1, state: 'preparing', directory: basename(prepared.directory), sourceSha256: prepared.sourceSha256, contentSha256: digest(JSON.stringify(prepared.projects)) }
      syncDirectory(prepared.directory)
      publishAuthority(profile, authority)
      onBoundary('manifest-prepared')
    }
    const db = openProjectMemoryDatabase(profile, authority, true)
    try {
      const imported = readSqliteMemoryDocument(db)
      if (authority.state === 'preparing' && digest(JSON.stringify(projectEvidence(imported))) !== authority.contentSha256) throw new Error('Prepared project memory database changed before cutover')
    } finally { db.close() }
    if (authority.state === 'sqlite') return authority
    const legacy = join(profile, 'project-memory.json')
    const retired = join(profile, authority.directory, 'retired-source.json')
    if (authority.sourceSha256 !== null) {
      try { privatePath(retired) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        privatePath(legacy)
        renameSync(legacy, retired)
        syncDirectory(dirname(retired)); syncDirectory(profile)
      }
      const snapshot = readProjectMemorySnapshot(retired)
      if (!snapshot.bytes || digest(snapshot.bytes) !== authority.sourceSha256) throw new Error('Legacy memory changed during cutover; preserved source requires recovery')
    }
    onBoundary('legacy-retired')
    try { mkdirSync(legacy, { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; privatePath(legacy, true) }
    // A directory at the old filename rejects old versions' atomic file replacement and JSON reads.
    syncDirectory(profile)
    onBoundary('legacy-fenced')
    authority = { ...authority, state: 'sqlite' }
    publishAuthority(profile, authority)
    onBoundary('manifest-active')
    return authority
  })
}

/** Abort only before activation. Never restore a pre-cutover source over an active SQLite authority. */
export function abortProjectMemoryMigration(userDataDir: string, onBoundary: (boundary: 'abort-marked' | 'json-restored') => void = () => {}) {
  const profile = resolve(userDataDir)
  const sourcePath = join(profile, 'project-memory.json')
  return withProjectMemoryWriteLock(profile, () => {
    let authority = readProjectMemoryAuthority(profile)
    if (!authority) {
      readProjectMemorySnapshot(sourcePath)
      return { state: 'json' as const, sourcePath }
    }
    if (authority.state === 'sqlite') throw new Error('Cannot abort an active migration; export current SQLite memory to preserve later writes')
    authority = { ...authority, state: 'aborting' }
    publishAuthority(profile, authority)
    onBoundary('abort-marked')
    const directory = join(profile, authority.directory)
    privatePath(directory, true)
    const retired = readProjectMemorySnapshot(join(directory, 'retired-source.json'))
    let legacyStat
    try { legacyStat = lstatSync(sourcePath) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (legacyStat?.isDirectory()) {
      privatePath(sourcePath, true)
      rmdirSync(sourcePath) // Refuse a non-empty directory; never recursively delete recovery data.
      legacyStat = undefined
    }
    if (legacyStat) {
      const current = readProjectMemorySnapshot(sourcePath)
      if (retired.bytes && digest(retired.bytes) !== authority.sourceSha256 && !retired.bytes.equals(current.bytes!)) {
        throw new Error('Conflicting preserved legacy sources require explicit recovery; neither copy was overwritten')
      }
    } else {
      if (authority.sourceSha256 !== null && retired.bytes === null) throw new Error('Preserved legacy source is missing; refusing to substitute the old backup')
      const bytes = retired.bytes ?? Buffer.from(JSON.stringify(retired.document) + '\n')
      const temporary = join(directory, `abort-source-${randomUUID()}.tmp`)
      try {
        writePrivate(temporary, bytes)
        linkSync(temporary, sourcePath) // Atomic exclusive publication: a racing old writer is never overwritten.
      } finally { rmSync(temporary, { force: true }) }
    }
    readProjectMemorySnapshot(sourcePath)
    syncDirectory(profile)
    onBoundary('json-restored')
    rmSync(join(profile, 'project-memory-active.json'))
    syncDirectory(profile)
    return { state: 'json' as const, sourcePath }
  })
}

/** Export the current authority, never its pre-cutover backup. Publication/switching remains a separate fenced operation. */
export function exportProjectMemoryForDowngrade(userDataDir: string) {
  const profile = resolve(userDataDir)
  return withProjectMemoryWriteLock(profile, () => {
    const authority = readProjectMemoryAuthority(profile)
    if (authority?.state !== 'sqlite') throw new Error('Downgrade export requires an active SQLite memory authority')
    const db = openProjectMemoryDatabase(profile, authority, true)
    let document: ProjectMemoryDocument
    const tooLarge = () => new Error(`Current memory exceeds the legacy reader limit of ${PROJECT_MEMORY_MAX_DOCUMENT_BYTES} bytes; keep SQLite active`)
    try {
      const entries = Number(db.prepare('SELECT coalesce(sum(length(CAST(current_json AS BLOB)) + length(CAST(history_json AS BLOB))),0) AS bytes FROM entries').get()!.bytes)
      const projects = Number(db.prepare('SELECT coalesce(sum(length(CAST(project_key AS BLOB)) + length(CAST(project_path AS BLOB))),0) AS bytes FROM projects').get()!.bytes)
      if (entries + projects > PROJECT_MEMORY_MAX_DOCUMENT_BYTES) throw tooLarge()
      document = readSqliteMemoryDocument(db)
    } finally { db.close() }
    const bytes = Buffer.from(JSON.stringify(document, null, 2) + '\n')
    if (bytes.length > PROJECT_MEMORY_MAX_DOCUMENT_BYTES) throw tooLarge()
    const path = join(profile, `project-memory-export-${randomUUID()}.json`)
    try {
      writePrivate(path, bytes)
      const verified = readProjectMemorySnapshot(path)
      if (!verified.bytes?.equals(bytes) || JSON.stringify(projectEvidence(verified.document)) !== JSON.stringify(projectEvidence(document))) throw new Error('Downgrade export verification failed')
      syncDirectory(profile)
      return { path, sha256: digest(bytes), bytes: bytes.length, sourceDirectory: authority.directory, projects: projectEvidence(document) }
    } catch (error) {
      rmSync(path, { force: true })
      throw error
    }
  })
}

/** Preparation holds the writer fence; no active authority is switched here. */
export function prepareProjectMemoryMigration(userDataDir: string) {
  const profile = resolve(userDataDir)
  return withProjectMemoryWriteLock(profile, () => prepareLockedMigration(profile))
}

function prepareLockedMigration(profile: string) {
  const sourcePath = join(profile, 'project-memory.json')
  assertJsonAuthority(sourcePath)
  const source = readProjectMemorySnapshot(sourcePath)
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  const directory = mkdtempSync(join(profile, 'project-memory-migration-'))
  const databasePath = join(directory, 'project-memory.sqlite')
  const backupPath = source.bytes === null ? null : join(directory, 'project-memory.json.backup')
  let db: DatabaseSync | undefined
  try {
    if (backupPath) writePrivate(backupPath, source.bytes!, 0o400)
    writePrivate(databasePath, '')
    db = new DatabaseSync(databasePath)
    db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA synchronous = FULL;
      PRAGMA user_version = 1;
      BEGIN IMMEDIATE;
      CREATE TABLE projects (project_key TEXT PRIMARY KEY, project_path TEXT NOT NULL) STRICT;
      CREATE TABLE entries (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL REFERENCES projects(project_key),
        current_json TEXT NOT NULL CHECK(json_valid(current_json)),
        history_json TEXT NOT NULL CHECK(json_valid(history_json)),
        revision INTEGER GENERATED ALWAYS AS (json_extract(current_json, '$.revision')) STORED,
        title TEXT GENERATED ALWAYS AS (json_extract(current_json, '$.title')) STORED,
        content TEXT GENERATED ALWAYS AS (json_extract(current_json, '$.content')) STORED,
        tags TEXT GENERATED ALWAYS AS (json_extract(current_json, '$.tags')) STORED,
        CHECK(id = json_extract(current_json, '$.id')),
        CHECK(revision > 0)
      ) STRICT;
      CREATE INDEX entries_project ON entries(project_key);
      CREATE VIRTUAL TABLE memory_search USING fts5(title, content, tags, content=entries, content_rowid=rowid);
      CREATE TRIGGER entries_insert AFTER INSERT ON entries BEGIN
        INSERT INTO memory_search(rowid,title,content,tags) VALUES(new.rowid,new.title,new.content,new.tags);
      END;
      CREATE TRIGGER entries_delete AFTER DELETE ON entries BEGIN
        INSERT INTO memory_search(memory_search,rowid,title,content,tags) VALUES('delete',old.rowid,old.title,old.content,old.tags);
      END;
      CREATE TRIGGER entries_update AFTER UPDATE ON entries BEGIN
        INSERT INTO memory_search(memory_search,rowid,title,content,tags) VALUES('delete',old.rowid,old.title,old.content,old.tags);
        INSERT INTO memory_search(rowid,title,content,tags) VALUES(new.rowid,new.title,new.content,new.tags);
      END;
    `)
    const projectInsert = db.prepare('INSERT INTO projects VALUES (?,?)')
    const entryInsert = db.prepare('INSERT INTO entries(id,project_key,current_json,history_json) VALUES (?,?,?,?)')
    for (const project of source.document.projects) {
      projectInsert.run(project.projectKey, project.projectPath)
      for (const entry of project.entries) entryInsert.run(entry.current.id, project.projectKey, JSON.stringify(entry.current), JSON.stringify(entry.history))
    }
    db.exec("INSERT INTO memory_search(memory_search,rank) VALUES('integrity-check',1)")
    db.exec('COMMIT')
    db.close()
    db = new DatabaseSync(databasePath, { readOnly: true })
    const imported = readSqliteMemoryDocument(db)
    const projects = projectEvidence(imported)
    if (JSON.stringify(projects) !== JSON.stringify(projectEvidence(source.document))) throw new Error('Memory import count or content verification failed')
    if (Object.values(db.prepare('PRAGMA integrity_check').get() ?? {})[0] !== 'ok') throw new Error('Memory database integrity check failed')
    db.close()
    db = undefined
    const current = readProjectMemorySnapshot(sourcePath)
    if (source.bytes === null ? current.bytes !== null : current.bytes === null || !source.bytes.equals(current.bytes)) {
      throw new Error('Project memory changed during preparation; retry under the maintenance fence')
    }
    const receipt = { state: 'prepared' as const, directory, sourcePath, sourceSha256: source.bytes === null ? null : digest(source.bytes), backupPath, databasePath, projects }
    writePrivate(join(directory, 'prepared.json'), JSON.stringify(receipt, null, 2) + '\n')
    return receipt
  } catch (error) {
    db?.close()
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}
