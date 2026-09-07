import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ProjectSessionHistory, SESSION_HISTORY_VERSION } from '../src/main/project-session-history'
import { resolveProjectToolScope } from '../src/main/project-tools'

it('aggregates only current project records, retains missing cost coverage and never writes the archive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-analytics-'))
  const project = join(root, 'project'), foreign = join(root, 'foreign')
  await mkdir(project); await mkdir(foreign)
  const resolveScope = (path: string) => resolveProjectToolScope(path, async path => {
    if (![project, foreign].includes(path)) throw new Error('Unregistered project')
    return { path, projectPath: path }
  })
  const scope = await resolveScope(project), directory = join(root, 'cache', scope.indexKey, SESSION_HISTORY_VERSION)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'receipt.json'), JSON.stringify({ version: SESSION_HISTORY_VERSION, indexKey: scope.indexKey, indexedAt: '2026-09-07T00:00:00Z' }))
  const source = join(root, 'native.jsonl'); await writeFile(source, 'original source')
  const file = await stat(source, { bigint: true }), path = join(directory, 'sessions.db')
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,agent TEXT,cwd TEXT,file_path TEXT,file_size INTEGER,file_mtime INTEGER,started_at TEXT,deleted_at TEXT,source_missing_at TEXT,total_output_tokens INTEGER,has_total_output_tokens INTEGER,peak_context_tokens INTEGER,has_peak_context_tokens INTEGER);
    CREATE TABLE usage_events(session_id TEXT,occurred_at TEXT,cost_status TEXT,cost_source TEXT,cost_microdollars INTEGER);`)
  const insert = db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,NULL,NULL,?,?,?,?)')
  insert.run('own', 'omp', project, source, Number(file.size), file.mtimeNs, '2026-09-07T00:00:00Z', 400, 1, 900, 1)
  insert.run("own'quoted", 'omp', project, source, Number(file.size), file.mtimeNs, '2026-09-07T01:00:00Z', 0, 0, 0, 0)
  insert.run('foreign', 'omp', foreign, source, Number(file.size), file.mtimeNs, '2026-09-07T02:00:00Z', 9999, 1, 9999, 1)
  insert.run('stale', 'omp', project, source, 999, file.mtimeNs, '2026-09-07T03:00:00Z', 9999, 1, 9999, 1)
  db.exec("INSERT INTO usage_events VALUES('own','2026-09-07','reported','native',0),('own','2026-09-07','unknown','native',NULL),('foreign','2026-09-07','reported','native',999999),('stale','2026-09-07','reported','native',888888)")
  db.close()
  const before = await readFile(path)
  const service = new ProjectSessionHistory({ binary: '/unused', cache: join(root, 'cache'), roots: { omp: [], 'deepseek-harness': [] } }, resolveScope)
  try {
    const result = await service.analytics(project)
    expect(result).toMatchObject({ sessions: 2, excluded: 2, truncated: false })
    expect(result.days).toEqual([{ day: '2026-09-07', agent: 'omp', sessions: 2, outputTokens: 400, tokenSessions: 1, peakContext: 900, contextSessions: 1 }])
    expect(result.costs).toEqual([
      { day: '2026-09-07', status: 'reported', source: 'native', events: 1, measuredEvents: 1, microdollars: 0 },
      { day: '2026-09-07', status: 'unknown', source: 'native', events: 1, measuredEvents: 0, microdollars: null }
    ])
    await writeFile(source, 'changed native source')
    expect(await service.analytics(project)).toMatchObject({ sessions: 0, excluded: 4, days: [], costs: [] })
    expect(await readFile(path)).toEqual(before)
    await expect(service.analytics(join(root, 'unregistered'))).rejects.toThrow()
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
})
