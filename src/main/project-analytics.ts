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
    max(CASE WHEN has_peak_context_tokens=1 THEN peak_context_tokens END) peakContext
    FROM sessions WHERE id IN (${selected}) GROUP BY 1,2 ORDER BY 1 DESC,2`).all(...ids)
  const costs = db.prepare(`SELECT coalesce(substr(occurred_at,1,10),'Unknown') day,cost_status status,cost_source source,
    count(*) events,count(cost_microdollars) measuredEvents,sum(cost_microdollars) microdollars
    FROM usage_events WHERE session_id IN (${selected}) GROUP BY 1,2,3 ORDER BY 1 DESC,2,3`).all(...ids)
  return { days: days as SessionHistoryAnalytics['days'], costs: costs as SessionHistoryAnalytics['costs'] }
}
