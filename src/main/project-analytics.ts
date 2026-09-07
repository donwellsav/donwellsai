import { createHash } from 'node:crypto'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { ProcessExecutionError, runProcess } from '@shared/child-process/run-process'
import workerSource from './project-analytics-worker.py?raw'
import type { DatabaseSync } from 'node:sqlite'
import type { SessionHistoryAnalytics } from '@shared/project-session-history'

/** Caller supplies only current, project-confined native IDs within its read transaction. */
export function aggregateSessionHistory(db: DatabaseSync, ids: string[]): Pick<SessionHistoryAnalytics, 'days' | 'costs'> {
  if (!ids.length) return { days: [], costs: [] }
  if (ids.length > 1000 || new Set(ids).size !== ids.length) throw new Error('Invalid analytics session selection')
  const selected = ids.map(() => '?').join(',')
  const days = db.prepare(`SELECT coalesce(substr(started_at,1,10),'Unknown') day,agent,count(*) sessions,
    sum(CASE WHEN has_total_output_tokens=1 THEN total_output_tokens END) outputTokens,
    sum(CASE WHEN has_total_output_tokens=1 THEN 1 ELSE 0 END) tokenSessions,
    max(CASE WHEN has_peak_context_tokens=1 THEN peak_context_tokens END) peakContext,
    sum(CASE WHEN has_peak_context_tokens=1 THEN 1 ELSE 0 END) contextSessions
    FROM sessions WHERE id IN (${selected}) GROUP BY 1,2 ORDER BY 1 DESC,2`).all(...ids)
  const costs = db.prepare(`SELECT coalesce(substr(occurred_at,1,10),'Unknown') day,cost_status status,cost_source source,
    count(*) events,count(cost_microdollars) measuredEvents,sum(cost_microdollars) microdollars
    FROM usage_events WHERE session_id IN (${selected}) GROUP BY 1,2,3 ORDER BY 1 DESC,2,3`).all(...ids)
  return { days: days as SessionHistoryAnalytics['days'], costs: costs as SessionHistoryAnalytics['costs'] }
}


/** Snapshot only explicitly selected rows. The caller retains its validated SQLite read transaction. */
export async function duckdbSessionHistory(db: DatabaseSync, ids: string[], python: string, signal: AbortSignal, beforeRun: () => Promise<void>, decisionAt?: string): Promise<Pick<SessionHistoryAnalytics, 'days' | 'costs' | 'comparison' | 'sourceGeneration'>> {
  if (!isAbsolute(python) || python.includes('\0')) throw new Error('Configure an absolute Python executable with DuckDB 1.5.5')
  if (ids.length > 10000 || new Set(ids).size !== ids.length) throw new Error('Analytics snapshot supports at most 10000 selected sessions')
  const directory = await mkdtemp(join(tmpdir(), 'donwells-analytics-'))
  try {
    const path = join(directory, 'snapshot.ndjson'), output = await open(path, 'wx', 0o600), digest = createHash('sha256')
    let bytes = 0, events = 0
    const write = async (value: unknown) => {
      signal.throwIfAborted()
      const line = JSON.stringify(value) + '\n'
      bytes += Buffer.byteLength(line)
      if (bytes > 32 * 1024 * 1024) throw new Error('Analytics snapshot exceeds 32 MiB; narrow the indexed session roots')
      digest.update(line); await output.writeFile(line)
    }
    try {
      for (let offset = 0; offset < ids.length; offset += 500) {
        const page = ids.slice(offset, offset + 500), placeholders = page.map(() => '?').join(',')
        for (const row of db.prepare(`SELECT id,agent,started_at startedAt,CASE WHEN has_total_output_tokens=1 THEN total_output_tokens END outputTokens,CASE WHEN has_peak_context_tokens=1 THEN peak_context_tokens END peakContext FROM sessions WHERE id IN (${placeholders}) ORDER BY id`).all(...page)) await write({ kind: 'session', ...row })
        for (const row of db.prepare(`SELECT session_id sessionId,occurred_at occurredAt,cost_status status,cost_source source,cost_microdollars microdollars FROM usage_events WHERE session_id IN (${placeholders}) ORDER BY session_id,occurred_at,cost_status,cost_source LIMIT 100001`).all(...page)) {
          if (++events > 100000) throw new Error('Analytics snapshot exceeds 100000 usage events; narrow the indexed session roots')
          await write({ kind: 'usage', ...row })
        }
      }
      await output.sync()
    } finally { await output.close() }
    await beforeRun(); signal.throwIfAborted()
    const result = await runProcess({ program: python, args: ['-I', '-c', workerSource, path, decisionAt ?? ''], cwd: directory, env: { PATH: process.env.PATH }, signal, timeoutMs: 60000, maxOutputBytes: 4 * 1024 * 1024 }).catch(error => {
      signal.throwIfAborted()
      throw new Error('DuckDB analysis failed: ' + (error instanceof ProcessExecutionError ? error.result?.stderr.trim().slice(-1500) || error.message : String(error)))
    })
    const value = JSON.parse(result.stdout)
    if (!value || !Array.isArray(value.days) || !Array.isArray(value.costs) || !Array.isArray(value.comparison)) throw new Error('Invalid DuckDB analytics result')
    return { ...value, sourceGeneration: digest.digest('hex') }
  } finally { await rm(directory, { recursive: true, force: true }) }
}
