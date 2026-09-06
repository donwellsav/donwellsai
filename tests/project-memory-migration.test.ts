import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { PROJECT_MEMORY_MAX_CONTENT_LENGTH, projectMemoryRevisionFromEntry } from '../src/shared/project-memory'
import { ProjectMemoryService } from '../src/main/project-memory'
import { abortProjectMemoryMigration, reverseProjectMemoryMigration, exportProjectMemoryForDowngrade, migrateProjectMemory, prepareProjectMemoryMigration, type MemoryMigrationBoundary } from '../src/main/project-memory-migration'
import { withProjectMemoryWriteLock } from '../src/main/project-memory-lock'
import { createSqliteMemoryEntry, readSqliteMemoryDocument, replaceSqliteMemoryEntry } from '../src/main/project-memory-sqlite'

it('reports storage failures and switches the live service through validated desktop administration actions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'donwells-memory-admin-'))
  try {
    const service = new ProjectMemoryService(root, async () => ({ projectKey: 'a'.repeat(64), projectPath: '/a' }))
    expect(await service.projectMemoryStorageStatus()).toEqual({ backend: 'json' })
    const entry = await service.projectMemoryCreate({ workspacePath: '/a', kind: 'decision', title: 'Keep the live service', content: 'preserved', attribution: { harness: 'omp' } })
    await expect(service.projectMemoryStorageAction({ action: 'migrate' })).rejects.toThrow('Unknown project memory storage action')
    expect((await service.projectMemoryStorageAction('migrate')).status).toMatchObject({ backend: 'sqlite', backupPath: expect.any(String), backupBytes: expect.any(Number) })
    expect(await service.projectMemoryGet({ workspacePath: '/a', id: entry.id })).toEqual(entry)
    const result = await service.projectMemoryStorageAction('export')
    expect(JSON.parse(readFileSync(result.exportPath!, 'utf8')).projects[0].entries[0].current).toEqual(entry)
    await expect(service.projectMemoryStorageAction('abort')).rejects.toThrow('export current SQLite memory')
    expect(await service.projectMemoryGet({ workspacePath: '/a', id: entry.id })).toEqual(entry)
    const damaged = join(root, 'damaged')
    mkdirSync(damaged, { mode: 0o700 })
    writeFileSync(join(damaged, 'project-memory.json'), '{bad', { mode: 0o600 })
    const unavailable = new ProjectMemoryService(damaged, async () => ({ projectKey: 'a'.repeat(64), projectPath: '/a' }))
    expect(await unavailable.projectMemoryStorageStatus()).toMatchObject({ backend: 'json', error: expect.stringContaining('invalid JSON') })
    expect(readFileSync(join(damaged, 'project-memory.json'), 'utf8')).toBe('{bad')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('exports later SQLite writes and archive history into a legacy-readable profile without restoring the old backup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'donwells-memory-downgrade-'))
  try {
    const resolver = async (path: string) => ({ projectKey: (path === '/b' ? 'b' : 'a').repeat(64), projectPath: path === '/b' ? '/b' : '/a' })
    const original = new ProjectMemoryService(root, resolver)
    const request = { workspacePath: '/a', kind: 'decision' as const, title: 'Prior decision', content: 'old value', attribution: { harness: 'omp' } }
    const old = await original.projectMemoryCreate(request)
    const authority = migrateProjectMemory(root)
    const source = new ProjectMemoryService(root, resolver)
    await source.projectMemoryUpdate({ ...request, id: old.id, expectedRevision: 1, content: 'new SQLite value', attribution: { harness: 'kimi' } })
    const archived = await source.projectMemoryArchive({ workspacePath: '/a', id: old.id, expectedRevision: 2, archived: true, attribution: { harness: 'hermes' } })
    const added = await source.projectMemoryCreate({ ...request, workspacePath: '/b', title: 'Created after migration' })
    const backupPath = join(root, authority.directory, 'project-memory.json.backup')
    const backup = readFileSync(backupPath)
    const exported = exportProjectMemoryForDowngrade(root)
    expect(exported.projects.map(project => [project.entries, project.historyRevisions])).toEqual([[1, 2], [1, 0]])
    const target = join(root, 'legacy-reader')
    mkdirSync(target, { mode: 0o700 })
    writeFileSync(join(target, 'project-memory.json'), readFileSync(exported.path), { mode: 0o600 })
    const reader = new ProjectMemoryService(target, resolver)
    expect(await reader.projectMemoryGet({ workspacePath: '/worktree', id: old.id })).toEqual(archived)
    expect(await reader.projectMemoryGet({ workspacePath: '/b', id: added.id })).toEqual(added)
    expect(await reader.projectMemoryHistory({ workspacePath: '/a', id: old.id })).toEqual(await source.projectMemoryHistory({ workspacePath: '/a', id: old.id }))
    await expect(reader.projectMemoryGet({ workspacePath: '/a', id: added.id })).rejects.toThrow('not found in this project')
    expect(readFileSync(backupPath)).toEqual(backup)
    expect(statSync(join(root, 'project-memory.json')).isDirectory()).toBe(true)
    expect(JSON.parse(readFileSync(join(root, 'project-memory-active.json'), 'utf8')).state).toBe('sqlite')
    expect(exportProjectMemoryForDowngrade(root).path).not.toBe(exported.path)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('keeps SQLite active when its full retained history exceeds the legacy document limit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'donwells-memory-export-limit-'))
  try {
    const project = { projectKey: 'a'.repeat(64), projectPath: '/a' }
    const service = new ProjectMemoryService(root, async () => project)
    const first = await service.projectMemoryCreate({ workspacePath: '/a', kind: 'fact', title: 'Large retained history', content: 'initial', attribution: { harness: 'cli' } })
    const authority = migrateProjectMemory(root)
    const db = new DatabaseSync(join(root, authority.directory, 'project-memory.sqlite'))
    try {
      const content = 'x'.repeat(PROJECT_MEMORY_MAX_CONTENT_LENGTH)
      const at = (revision: number) => new Date(Date.parse(first.createdAt) + (revision - 1) * 1000).toISOString()
      const history = Array.from({ length: 32 }, (_, index) => ({ ...projectMemoryRevisionFromEntry(first), revision: index + 1, content, updatedAt: at(index + 1) }))
      const insert = db.prepare('INSERT INTO entries(id,project_key,current_json,history_json) VALUES (?,?,?,?)')
      for (let index = 0; index < 8; index++) {
        const current = { ...first, id: 'large-entry-' + index, revision: 33, content, updatedAt: at(33) }
        insert.run(current.id, project.projectKey, JSON.stringify(current), JSON.stringify(history))
      }
    } finally { db.close() }
    expect(() => exportProjectMemoryForDowngrade(root)).toThrow('exceeds the legacy reader limit')
    expect(() => reverseProjectMemoryMigration(root)).toThrow('exceeds the legacy reader limit')
    expect(readdirSync(root).filter(name => name.startsWith('project-memory-export-'))).toEqual([])
    expect(JSON.parse(readFileSync(join(root, 'project-memory-active.json'), 'utf8')).state).toBe('sqlite')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it.each<MemoryMigrationBoundary>(['candidate-prepared', 'manifest-prepared', 'legacy-retired', 'legacy-fenced', 'manifest-active'])('resumes cutover at %s and routes new API writes exclusively to SQLite', async boundary => {
  const root = mkdtempSync(join(tmpdir(), 'donwells-memory-cutover-'))
  try {
    const resolver = async (path: string) => ({ projectKey: (path === '/unrelated' ? 'b' : 'a').repeat(64), projectPath: path === '/unrelated' ? path : '/a' })
    const old = new ProjectMemoryService(root, resolver)
    const request = { workspacePath: '/a', kind: 'decision' as const, title: 'Keep across cutover', content: 'shared decision', attribution: { harness: 'omp' } }
    const first = await old.projectMemoryCreate(request)
    const beforeSearch = await old.projectMemoryList({ workspacePath: '/a', query: 'cutover' })
    const source = readFileSync(join(root, 'project-memory.json'))
    expect(() => migrateProjectMemory(root, reached => { if (reached === boundary) throw new Error('interrupted at ' + reached) })).toThrow('interrupted at')
    const authority = migrateProjectMemory(root)
    expect(migrateProjectMemory(root)).toEqual(authority)
    expect(statSync(join(root, 'project-memory.json')).isDirectory()).toBe(true)
    const attempted = join(root, 'old-writer.tmp')
    writeFileSync(attempted, 'stale old writer')
    expect(() => renameSync(attempted, join(root, 'project-memory.json'))).toThrow()
    expect(readFileSync(join(root, authority.directory, 'project-memory.json.backup'))).toEqual(source)
    await expect(old.projectMemoryCreate(request)).rejects.toMatchObject({ code: 'PROJECT_MEMORY_BACKEND_CHANGED' })
    const current = new ProjectMemoryService(root, resolver)
    expect(await current.projectMemoryList({ workspacePath: '/a', query: 'cutover' })).toEqual(beforeSearch)
    expect(await current.projectMemoryGet({ workspacePath: '/worktree', id: first.id })).toEqual(first)
    await expect(current.projectMemoryGet({ workspacePath: '/unrelated', id: first.id })).rejects.toThrow('not found in this project')
    const updated = await current.projectMemoryUpdate({ ...request, id: first.id, expectedRevision: 1, content: 'new SQLite decision', attribution: { harness: 'kimi' } })
    expect(() => abortProjectMemoryMigration(root)).toThrow('export current SQLite memory')
    const fresh = await current.projectMemoryCreate({ ...request, title: 'SQLite-only creation' })
    const reopened = new ProjectMemoryService(root, resolver)
    expect(await reopened.projectMemoryGet({ workspacePath: '/worktree', id: first.id })).toEqual(updated)
    expect(await reopened.projectMemoryGet({ workspacePath: '/a', id: fresh.id })).toEqual(fresh)
    await expect(reopened.projectMemoryUpdate({ ...request, id: first.id, expectedRevision: 1 })).rejects.toThrow('revision 2; expected revision 1')
    expect(readFileSync(join(root, authority.directory, 'project-memory.json.backup'))).toEqual(source)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('preserves an uncooperative old writer instead of activating a stale import', async () => {
  const root = mkdtempSync(join(tmpdir(), 'donwells-memory-old-writer-'))
  try {
    const service = new ProjectMemoryService(root, async () => ({ projectKey: 'a'.repeat(64), projectPath: '/a' }))
    await service.projectMemoryCreate({ workspacePath: '/a', kind: 'decision', title: 'Original', content: 'before', attribution: { harness: 'omp' } })
    let changed = ''
    expect(() => migrateProjectMemory(root, boundary => {
      if (boundary !== 'manifest-prepared') return
      const original = JSON.parse(readFileSync(join(root, 'project-memory.json'), 'utf8'))
      original.projects[0].entries[0].current.content = 'new old-client write'
      changed = JSON.stringify(original)
      const temporary = join(root, 'uncooperative.tmp')
      writeFileSync(temporary, changed, { mode: 0o600 })
      renameSync(temporary, join(root, 'project-memory.json'))
    })).toThrow('Legacy memory changed during cutover')
    const manifest = JSON.parse(readFileSync(join(root, 'project-memory-active.json'), 'utf8'))
    expect(manifest.state).toBe('preparing')
    expect(readFileSync(join(root, manifest.directory, 'retired-source.json'), 'utf8')).toBe(changed)
    await expect(new ProjectMemoryService(root, async () => ({ projectKey: 'a'.repeat(64), projectPath: '/a' })).projectMemoryList({ workspacePath: '/a' })).rejects.toThrow('Legacy memory changed during cutover')
    abortProjectMemoryMigration(root)
    const recovered = new ProjectMemoryService(root, async () => ({ projectKey: 'a'.repeat(64), projectPath: '/a' }))
    expect((await recovered.projectMemoryList({ workspacePath: '/a' })).entries[0].content).toBe('new old-client write')
    expect(readFileSync(join(root, manifest.directory, 'retired-source.json'), 'utf8')).toBe(changed)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it.each(['abort-marked', 'json-restored'] as const)('resumes an abort interrupted at %s without activating SQLite', async boundary => {
  const root = mkdtempSync(join(tmpdir(), 'donwells-memory-abort-'))
  try {
    const resolver = async () => ({ projectKey: 'a'.repeat(64), projectPath: '/a' })
    const service = new ProjectMemoryService(root, resolver)
    const entry = await service.projectMemoryCreate({ workspacePath: '/a', kind: 'decision', title: 'Keep this source', content: 'retained', attribution: { harness: 'omp' } })
    expect(() => migrateProjectMemory(root, step => { if (step === 'legacy-fenced') throw new Error('cutover interrupted') })).toThrow('cutover interrupted')
    expect(() => abortProjectMemoryMigration(root, step => { if (step === boundary) throw new Error('abort interrupted') })).toThrow('abort interrupted')
    const reader = new ProjectMemoryService(root, resolver)
    expect(await reader.projectMemoryGet({ workspacePath: '/a', id: entry.id })).toEqual(entry)
    expect(statSync(join(root, 'project-memory.json')).isFile()).toBe(true)
    expect(abortProjectMemoryMigration(root).state).toBe('json')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('does not delete unexpected recovery files or choose between conflicting newer sources', async () => {
  const root = mkdtempSync(join(tmpdir(), 'donwells-memory-abort-conflict-'))
  try {
    const service = new ProjectMemoryService(root, async () => ({ projectKey: 'a'.repeat(64), projectPath: '/a' }))
    await service.projectMemoryCreate({ workspacePath: '/a', kind: 'fact', title: 'Original', content: 'baseline', attribution: { harness: 'cli' } })
    expect(() => migrateProjectMemory(root, boundary => { if (boundary === 'legacy-fenced') throw new Error('stop before activation') })).toThrow('stop before activation')
    const legacy = join(root, 'project-memory.json')
    const keep = join(legacy, 'keep.txt')
    writeFileSync(keep, 'preserve unexpected file')
    expect(() => abortProjectMemoryMigration(root)).toThrow()
    expect(readFileSync(keep, 'utf8')).toBe('preserve unexpected file')
    rmSync(keep); rmdirSync(legacy)
    const manifest = JSON.parse(readFileSync(join(root, 'project-memory-active.json'), 'utf8'))
    const retired = join(root, manifest.directory, 'retired-source.json')
    const one = JSON.parse(readFileSync(retired, 'utf8'))
    one.projects[0].entries[0].current.content = 'new source one'
    const two = structuredClone(one)
    two.projects[0].entries[0].current.content = 'new source two'
    writeFileSync(retired, JSON.stringify(one), { mode: 0o600 })
    writeFileSync(legacy, JSON.stringify(two), { mode: 0o600 })
    expect(() => abortProjectMemoryMigration(root)).toThrow('Conflicting preserved legacy sources')
    expect(JSON.parse(readFileSync(retired, 'utf8'))).toEqual(one)
    expect(JSON.parse(readFileSync(legacy, 'utf8'))).toEqual(two)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('stages private SQLite memory with exact backup, history, archives and project isolation without cutover', async () => {
  const root = mkdtempSync(join(tmpdir(), 'donwells-memory-migration-'))
  try {
    let tick = 0
    const service = new ProjectMemoryService(root, async path => ({ projectPath: path, projectKey: path === '/a' ? 'a'.repeat(64) : 'b'.repeat(64) }), {
      now: () => new Date(Date.UTC(2026, 8, 6) + tick++ * 1000)
    })
    const first = await service.projectMemoryCreate({ workspacePath: '/a', kind: 'decision', title: 'Neutral theme', content: '#16161D', attribution: { harness: 'omp' } })
    await service.projectMemoryUpdate({ workspacePath: '/a', id: first.id, expectedRevision: 1, kind: 'decision', title: 'Neutral theme', content: 'Keep #16161D', attribution: { harness: 'kimi' } })
    await service.projectMemoryArchive({ workspacePath: '/a', id: first.id, expectedRevision: 2, archived: true, attribution: { harness: 'hermes' } })
    await service.projectMemoryCreate({ workspacePath: '/b', kind: 'fact', title: 'Separate project', content: 'x'.repeat(PROJECT_MEMORY_MAX_CONTENT_LENGTH), attribution: { harness: 'cli' } })
    const source = join(root, 'project-memory.json')
    const original = readFileSync(source)
    const stage = prepareProjectMemoryMigration(root)
    expect(readFileSync(source)).toEqual(original)
    expect(readFileSync(stage.backupPath!)).toEqual(original)
    expect(stage.projects.map(project => [project.entries, project.historyRevisions])).toEqual([[1, 2], [1, 0]])
    if (process.platform !== 'win32') {
      expect(statSync(stage.directory).mode & 0o077).toBe(0)
      expect(statSync(stage.databasePath).mode & 0o077).toBe(0)
      expect(statSync(stage.backupPath!).mode & 0o777).toBe(0o400)
    }
    const db = new DatabaseSync(stage.databasePath, { readOnly: true })
    try {
      expect(db.prepare('SELECT id FROM entries WHERE project_key = ? AND id = ?').get('b'.repeat(64), first.id)).toBeUndefined()
      const row = db.prepare('SELECT current_json, history_json FROM entries WHERE id = ?').get(first.id)!
      expect(JSON.parse(String(row.current_json))).toMatchObject({ revision: 3, provenance: { harness: 'hermes' } })
      expect(JSON.parse(String(row.current_json)).archivedAt).not.toBeNull()
      expect(JSON.parse(String(row.history_json)).map((revision: { provenance: { harness: string } }) => revision.provenance.harness)).toEqual(['omp', 'kimi'])
      expect(db.prepare("SELECT count(*) AS n FROM memory_search WHERE memory_search MATCH 'theme'").get()).toEqual({ n: 1 })
    } finally { db.close() }
    const reader = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1], { readOnly: true });
      console.log(JSON.stringify({ pid: process.pid, rows: db.prepare('SELECT project_key,current_json,history_json FROM entries ORDER BY project_key').all() }));
      db.close();
    `, stage.databasePath], { encoding: 'utf8', timeout: 5000 })
    expect(reader.status, reader.stderr).toBe(0)
    const reopened = JSON.parse(reader.stdout)
    expect(reopened.pid).not.toBe(process.pid)
    expect(reopened.rows).toHaveLength(2)
    expect(JSON.parse(reopened.rows[0].history_json)).toHaveLength(2)
    expect(JSON.parse(reopened.rows[1].current_json).content).toHaveLength(PROJECT_MEMORY_MAX_CONTENT_LENGTH)
    const duplicate = prepareProjectMemoryMigration(root)
    expect(duplicate.directory).not.toBe(stage.directory)
    expect(duplicate.projects).toEqual(stage.projects)
    writeFileSync(source, '{broken')
    expect(() => prepareProjectMemoryMigration(root)).toThrow('invalid JSON')
    expect(readFileSync(source, 'utf8')).toBe('{broken')
    writeFileSync(source, JSON.stringify({ schemaVersion: 999, projects: [] }))
    expect(() => prepareProjectMemoryMigration(root)).toThrow('Unsupported project memory schema')
    const empty = prepareProjectMemoryMigration(join(root, 'empty-profile'))
    expect(empty.backupPath).toBeNull()
    expect(empty.sourceSha256).toBeNull()
    expect(empty.projects).toEqual([])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('commits scoped SQLite revisions and FTS atomically while rejecting stale revisions and rewritten history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'donwells-memory-sqlite-cas-'))
  try {
    const project = { projectKey: 'a'.repeat(64), projectPath: '/a' }
    const service = new ProjectMemoryService(root, async () => project)
    const first = await service.projectMemoryCreate({ workspacePath: '/a', kind: 'decision', title: 'oldmarker', content: 'original', attribution: { harness: 'omp' } })
    const stage = prepareProjectMemoryMigration(root)
    const db = new DatabaseSync(stage.databasePath)
    try {
      const next = { current: { ...first, title: 'newmarker', revision: 2, updatedAt: new Date(Date.parse(first.updatedAt) + 1000).toISOString() }, history: [projectMemoryRevisionFromEntry(first)] }
      expect(() => replaceSqliteMemoryEntry(db, { ...project, projectKey: 'b'.repeat(64) }, 1, next)).toThrow('not found in this project')
      const altered = structuredClone(next)
      altered.history[0].content = 'rewritten past'
      expect(() => replaceSqliteMemoryEntry(db, project, 1, altered)).toThrow('preserve retained revision history')
      expect(readSqliteMemoryDocument(db).projects[0].entries[0].current).toEqual(first)
      expect(replaceSqliteMemoryEntry(db, project, 1, next)).toEqual(next.current)
      expect(() => replaceSqliteMemoryEntry(db, project, 1, next)).toThrow('revision 2; expected revision 1')
      expect(readSqliteMemoryDocument(db).projects[0].entries[0]).toEqual(next)
      expect(db.prepare("SELECT count(*) AS n FROM memory_search WHERE memory_search MATCH 'newmarker'").get()).toEqual({ n: 1 })
      expect(db.prepare("SELECT count(*) AS n FROM memory_search WHERE memory_search MATCH 'oldmarker'").get()).toEqual({ n: 0 })
      db.exec('CREATE TRIGGER fail_project_update BEFORE UPDATE ON projects BEGIN SELECT RAISE(ABORT, \'injected storage failure\'); END')
      const third = { current: { ...next.current, title: 'failedmarker', revision: 3, updatedAt: new Date(Date.parse(first.updatedAt) + 2000).toISOString() }, history: [...next.history, projectMemoryRevisionFromEntry(next.current)] }
      expect(() => replaceSqliteMemoryEntry(db, project, 2, third)).toThrow('injected storage failure')
      expect(readSqliteMemoryDocument(db).projects[0].entries[0]).toEqual(next)
      expect(db.prepare("SELECT count(*) AS n FROM memory_search WHERE memory_search MATCH 'failedmarker'").get()).toEqual({ n: 0 })
      const other = { projectKey: 'b'.repeat(64), projectPath: '/b' }
      expect(() => createSqliteMemoryEntry(db, other, { current: first, history: [] })).toThrow('revision 1')
      expect(readSqliteMemoryDocument(db).projects).toHaveLength(1)
      const fresh = { ...first, id: 'independent-entry', title: 'independentmarker' }
      expect(createSqliteMemoryEntry(db, other, { current: fresh, history: [] })).toEqual(fresh)
      expect(readSqliteMemoryDocument(db).projects[1].entries[0].current).toEqual(fresh)
      expect(db.prepare("SELECT count(*) AS n FROM memory_search WHERE memory_search MATCH 'independentmarker'").get()).toEqual({ n: 1 })
      db.exec('PRAGMA user_version = 999')
      expect(() => readSqliteMemoryDocument(db)).toThrow('Unsupported project memory database schema')
      expect(() => replaceSqliteMemoryEntry(db, project, 2, third)).toThrow('Unsupported project memory database schema')
    } finally { db.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('fences every JSON writer during maintenance and releases the lock when its owning process dies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'donwells-memory-lock-'))
  let child: ReturnType<typeof spawn> | undefined
  try {
    const resolveProject = async () => ({ projectKey: 'a'.repeat(64), projectPath: '/a' })
    const first = new ProjectMemoryService(root, resolveProject)
    const stale = new ProjectMemoryService(root, resolveProject)
    await stale.projectMemoryList({ workspacePath: '/a' })
    const request = { workspacePath: '/a', kind: 'decision' as const, title: 'Kept decision', content: 'first writer', attribution: { harness: 'omp' } }
    await first.projectMemoryCreate(request)
    const source = join(root, 'project-memory.json')
    const original = readFileSync(source)
    await expect(stale.projectMemoryCreate({ ...request, content: 'stale writer' })).rejects.toMatchObject({ code: 'PROJECT_MEMORY_CHANGED' })
    expect(readFileSync(source)).toEqual(original)
    withProjectMemoryWriteLock(root, () => {})
    child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN EXCLUSIVE');
      console.log('locked');
      setTimeout(() => { db.close(); process.exit(0); }, 10000);
    `, join(root, 'project-memory.lock.sqlite')], { stdio: ['ignore', 'pipe', 'pipe'] })
    const ready = await Promise.race([
      once(child.stdout!, 'data').then(([data]) => String(data)),
      once(child, 'exit').then(() => { throw new Error('Lock owner exited before readiness') })
    ])
    expect(ready).toContain('locked')
    await expect(first.projectMemoryCreate(request)).rejects.toMatchObject({ code: 'PROJECT_MEMORY_MAINTENANCE' })
    expect(() => prepareProjectMemoryMigration(root)).toThrow('maintenance')
    expect(readFileSync(source)).toEqual(original)
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
    await first.projectMemoryCreate({ ...request, content: 'after owner exit' })
    expect(prepareProjectMemoryMigration(root).projects[0].entries).toBe(2)
    const beforeCutover = readFileSync(source)
    writeFileSync(join(root, 'project-memory-active.json'), '{unreadable manifest', { mode: 0o600 })
    await expect(first.projectMemoryCreate(request)).rejects.toMatchObject({ code: 'PROJECT_MEMORY_BACKEND_CHANGED' })
    await expect(first.projectMemoryList({ workspacePath: '/a' })).rejects.toMatchObject({ code: 'PROJECT_MEMORY_BACKEND_CHANGED' })
    await expect(new ProjectMemoryService(root, resolveProject).projectMemoryList({ workspacePath: '/a' })).rejects.toThrow('Invalid project memory authority manifest')
    expect(readFileSync(source)).toEqual(beforeCutover)
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
    rmSync(root, { recursive: true, force: true })
  }
})


it.each(['reverse-prepared', 'reverse-marked', 'reverse-unfenced', 'reverse-published', 'reverse-active'] as const)('preserves post-upgrade writes when reverse migration resumes at %s', async boundary => {
  const root = mkdtempSync(join(tmpdir(), 'donwells-memory-reverse-'))
  try {
    const resolver = async () => ({ projectKey: 'a'.repeat(64), projectPath: '/a' })
    const service = new ProjectMemoryService(root, resolver)
    const request = { workspacePath: '/a', kind: 'decision' as const, title: 'Reverse migration', content: 'before upgrade', attribution: { harness: 'omp' } }
    const entry = await service.projectMemoryCreate(request)
    await service.projectMemoryStorageAction('migrate')
    const authority = JSON.parse(readFileSync(join(root, 'project-memory-active.json'), 'utf8'))
    const backupPath = join(root, authority.directory, 'project-memory.json.backup')
    const backup = readFileSync(backupPath)
    const changed = await service.projectMemoryUpdate({ ...request, id: entry.id, expectedRevision: 1, content: 'written to SQLite', attribution: { harness: 'hermes' } })
    const history = await service.projectMemoryHistory({ workspacePath: '/a', id: entry.id })
    expect(() => reverseProjectMemoryMigration(root, step => { if (step === boundary) throw new Error('reverse interrupted') })).toThrow('reverse interrupted')
    if (boundary === 'reverse-prepared') {
      expect((await service.projectMemoryStorageStatus()).backend).toBe('sqlite')
      await service.projectMemoryStorageAction('reverse')
    }
    const reopened = new ProjectMemoryService(root, resolver)
    expect(await reopened.projectMemoryGet({ workspacePath: '/a', id: entry.id })).toEqual(changed)
    expect(await reopened.projectMemoryHistory({ workspacePath: '/a', id: entry.id })).toEqual(history)
    expect((await reopened.projectMemoryStorageStatus()).backend).toBe('json')
    const next = await reopened.projectMemoryUpdate({ ...request, id: entry.id, expectedRevision: 2, content: 'written after downgrade' })
    expect(await new ProjectMemoryService(root, resolver).projectMemoryGet({ workspacePath: '/a', id: entry.id })).toEqual(next)
    expect(readFileSync(backupPath)).toEqual(backup)
    expect(reverseProjectMemoryMigration(root).state).toBe('json')
  } finally { rmSync(root, { recursive: true, force: true }) }
})


it('keeps conflicting legacy writes and the frozen SQLite snapshot during reverse recovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'donwells-memory-reverse-conflict-'))
  try {
    const resolver = async () => ({ projectKey: 'a'.repeat(64), projectPath: '/a' })
    const service = new ProjectMemoryService(root, resolver)
    const request = { workspacePath: '/a', kind: 'fact' as const, title: 'Conflict', content: 'SQLite value', attribution: { harness: 'cli' } }
    const entry = await service.projectMemoryCreate(request)
    await service.projectMemoryStorageAction('migrate')
    expect(await service.projectMemoryGet({ workspacePath: '/a', id: entry.id })).toEqual(entry)
    expect(() => reverseProjectMemoryMigration(root, step => { if (step === 'reverse-published') throw new Error('interrupted') })).toThrow('interrupted')
    const authority = JSON.parse(readFileSync(join(root, 'project-memory-active.json'), 'utf8'))
    const candidatePath = join(root, authority.directory, 'reverse-source.json')
    const candidate = readFileSync(candidatePath)
    const legacyPath = join(root, 'project-memory.json')
    const changed = JSON.parse(readFileSync(legacyPath, 'utf8'))
    changed.projects[0].entries[0].current.content = 'an old client wrote this'
    writeFileSync(legacyPath, JSON.stringify(changed))
    expect(() => reverseProjectMemoryMigration(root)).toThrow('neither source was overwritten')
    expect(JSON.parse(readFileSync(legacyPath, 'utf8'))).toEqual(changed)
    expect(readFileSync(candidatePath)).toEqual(candidate)
    await expect(service.projectMemoryUpdate({ ...request, id: entry.id, expectedRevision: 1 })).rejects.toThrow('authority changed')
    expect(() => abortProjectMemoryMigration(root)).toThrow('Cannot abort reverse migration')
    expect(() => migrateProjectMemory(root)).toThrow('Reverse migration is in progress')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
