import { createHash } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseProjectMemoryDocument, type ProjectMemoryDocument } from '@shared/project-memory'
import { assertJsonAuthority, readProjectMemorySnapshot } from './project-memory-store'
import { withProjectMemoryWriteLock } from './project-memory-lock'

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
    const readEntries = db.prepare('SELECT current_json,history_json FROM entries WHERE project_key = ? ORDER BY id')
    const imported = parseProjectMemoryDocument({
      schemaVersion: source.document.schemaVersion,
      projects: db.prepare('SELECT project_key,project_path FROM projects ORDER BY project_key').all().map(project => ({
        projectKey: project.project_key,
        projectPath: project.project_path,
        entries: readEntries.all(project.project_key!).map(entry => ({ current: JSON.parse(String(entry.current_json)), history: JSON.parse(String(entry.history_json)) }))
      }))
    })
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
