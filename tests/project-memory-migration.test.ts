import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { PROJECT_MEMORY_MAX_CONTENT_LENGTH } from '../src/shared/project-memory'
import { ProjectMemoryService } from '../src/main/project-memory'
import { prepareProjectMemoryMigration } from '../src/main/project-memory-migration'
import { withProjectMemoryWriteLock } from '../src/main/project-memory-lock'

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

it('fences every JSON writer during maintenance and releases the lock when its owning process dies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'donwells-memory-lock-'))
  let child: ReturnType<typeof spawn> | undefined
  try {
    const resolveProject = async () => ({ projectKey: 'a'.repeat(64), projectPath: '/a' })
    const first = new ProjectMemoryService(root, resolveProject)
    const stale = new ProjectMemoryService(root, resolveProject)
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
    expect(() => new ProjectMemoryService(root, resolveProject)).toThrow('authority changed')
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
