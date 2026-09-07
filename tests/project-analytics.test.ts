import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ProjectSessionHistory, SESSION_HISTORY_BINARY_SHA256, SESSION_HISTORY_VERSION } from '../src/main/project-session-history'
import { resolveProjectToolScope } from '../src/main/project-tools'

it.each(['sqlite', ...(process.env.DONWELLS_DUCKDB_PYTHON ? ['duckdb'] : [])] as const)('aggregates only current project records through %s, retains missing cost coverage and never writes the archive', async engine => {
  const root = await mkdtemp(join(tmpdir(), 'project-analytics-'))
  const project = join(root, 'project'), foreign = join(root, 'foreign')
  await mkdir(project); await mkdir(foreign)
  const resolveScope = (path: string) => resolveProjectToolScope(path, async path => {
    if (![project, foreign].includes(path)) throw new Error('Unregistered project')
    return { path, projectPath: path }
  })
  const scope = await resolveScope(project), directory = join(root, 'cache', scope.indexKey, SESSION_HISTORY_VERSION)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'receipt.json'), JSON.stringify({ version: SESSION_HISTORY_VERSION, binarySha256: SESSION_HISTORY_BINARY_SHA256, indexKey: scope.indexKey, indexedAt: '2026-09-07T00:00:00Z' }))
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
  const service = new ProjectSessionHistory({ binary: '/unused', analyticsPython: process.env.DONWELLS_DUCKDB_PYTHON, cache: join(root, 'cache'), roots: { omp: [], 'deepseek-harness': [] } }, resolveScope)
  try {
    const result = await service.analytics(project, { engine: engine as 'sqlite' | 'duckdb', ...(engine === 'duckdb' ? { decisionAt: '2026-09-07T00:30:00Z' } : {}) })
    expect(result).toMatchObject({ sessions: 2, excluded: 2, truncated: false })
    expect(result.days).toEqual([{ day: '2026-09-07', agent: 'omp', sessions: 2, outputTokens: 400, tokenSessions: 1, peakContext: 900, contextSessions: 1 }])
    expect(result.costs).toEqual([
      { day: '2026-09-07', status: 'reported', source: 'native', events: 1, measuredEvents: 1, microdollars: 0 },
      { day: '2026-09-07', status: 'unknown', source: 'native', events: 1, measuredEvents: 0, microdollars: null }
    ])
    if (engine === 'duckdb') {
      expect(result.sourceGeneration).toMatch(/^[a-f0-9]{64}$/)
      expect(result.sourceRefs?.map(ref => ref.id)).toEqual(['own', "own'quoted"])
      expect(result.comparison).toEqual([
        { period: 'after', agent: 'omp', sessions: 1, outputTokens: null, tokenSessions: 0 },
        { period: 'before', agent: 'omp', sessions: 1, outputTokens: 400, tokenSessions: 1 }
      ])
    }
    await writeFile(source, 'changed native source')
    expect(await service.analytics(project, { engine: engine as 'sqlite' | 'duckdb' })).toMatchObject({ sessions: 0, excluded: 4, days: [], costs: [] })
    expect(await readFile(path)).toEqual(before)
    await expect(service.analytics(join(root, 'unregistered'))).rejects.toThrow()
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
})

it.skipIf(!process.env.DONWELLS_DUCKDB_PYTHON)('pages beyond 1000 sources and cancels only its own pending validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-analytics-paging-'))
  const project = join(root, 'project'); await mkdir(project)
  let block = false
  const reached = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  const resolveScope = async (path: string) => {
    if (block) { block = false; reached.resolve(); await resume.promise }
    return resolveProjectToolScope(path, async path => ({ path, projectPath: path }))
  }
  const scope = await resolveScope(project), directory = join(root, 'cache', scope.indexKey, SESSION_HISTORY_VERSION)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'receipt.json'), JSON.stringify({ version: SESSION_HISTORY_VERSION, binarySha256: SESSION_HISTORY_BINARY_SHA256, indexKey: scope.indexKey, indexedAt: '2026-09-07T00:00:00Z' }))
  const source = join(root, 'source.jsonl'); await writeFile(source, 'source')
  const file = await stat(source, { bigint: true }), db = new DatabaseSync(join(directory, 'sessions.db'))
  db.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY,agent TEXT,cwd TEXT,file_path TEXT,file_size INTEGER,file_mtime INTEGER,started_at TEXT,deleted_at TEXT,source_missing_at TEXT,total_output_tokens INTEGER,has_total_output_tokens INTEGER,peak_context_tokens INTEGER,has_peak_context_tokens INTEGER); CREATE TABLE usage_events(session_id TEXT,occurred_at TEXT,cost_status TEXT,cost_source TEXT,cost_microdollars INTEGER)')
  const insert = db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,NULL,NULL,1,1,NULL,0)')
  for (let i = 0; i < 1002; i++) insert.run('session-' + i, 'omp', project, source, Number(file.size), file.mtimeNs, '2026-09-07')
  db.close()
  const service = new ProjectSessionHistory({ binary: '/unused', cache: join(root, 'cache'), analyticsPython: process.env.DONWELLS_DUCKDB_PYTHON, roots: { omp: [], 'deepseek-harness': [] } }, resolveScope)
  try {
    expect(await service.analytics(project, { engine: 'duckdb', requestId: 'all-sources' })).toMatchObject({ sessions: 1002, truncated: false, days: [{ sessions: 1002, outputTokens: 1002 }], costs: [] })
    expect(await service.analyticsProgress(project, 'all-sources')).toEqual({ phase: 'complete', validated: 1002, scanned: 1002 })
    // Wait at a real source check after request registration; cancellation must not target another request.
    const originalCurrent = (service as any).current.bind(service)
    ;(service as any).current = async (...args: unknown[]) => { block = true; (service as any).current = originalCurrent; return originalCurrent(...args) }
    const pending = service.analytics(project, { engine: 'duckdb', requestId: 'cancel-me' })
    const rejected = expect(pending).rejects.toThrow('Analytics cancelled')
    await reached.promise
    await expect(service.cancelAnalytics(project, 'wrong-request')).rejects.toThrow('no longer active')
    const stopped = service.cancelAnalytics(project, 'cancel-me')
    resume.resolve(); await stopped; await rejected
    expect(await service.analyticsProgress(project, 'cancel-me')).toMatchObject({ phase: 'cancelled' })
  } finally { resume.resolve(); await service.close(); await rm(root, { recursive: true, force: true }) }
}, 20000)
