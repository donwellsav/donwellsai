import { useEffect, useRef, useState } from 'react'
import type { SessionHistoryAnalytics } from '@shared/project-session-history'
import type { ProjectMemoryEntry } from '@shared/project-memory'
import type { VerificationEntry } from '@shared/operational-runs'

export function ProjectAnalytics({ workspacePath }: { workspacePath: string }) {
  const [open, setOpen] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [data, setData] = useState<SessionHistoryAnalytics | null>(null)
  const [checks, setChecks] = useState<VerificationEntry[] | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [engine, setEngine] = useState<'sqlite' | 'duckdb'>('sqlite')
  const [decisions, setDecisions] = useState<ProjectMemoryEntry[]>([])
  const [decisionId, setDecisionId] = useState('')
  const [progress, setProgress] = useState('')
  const request = useRef<{ path: string; id: string } | null>(null)
  useEffect(() => {
    setData(null); setChecks(null); setError('')
    if (!open) return
    setLoading(true)
    let cancelled = false
    const id = crypto.randomUUID()
    request.current = { path: workspacePath, id }
    const selected = decisions.find(decision => decision.id === decisionId)
    const timer = setInterval(() => {
      void window.donwells.projectSessionHistoryAnalyticsProgress(workspacePath, id).then(value => {
        if (!cancelled) setProgress(`${value.phase} · ${value.validated} current / ${value.scanned} checked sessions`)
      }).catch(() => {})
    }, 500)
    void Promise.allSettled([
      window.donwells.projectSessionHistoryAnalytics(workspacePath, { engine, requestId: id, ...(engine === 'duckdb' && selected ? { decisionAt: selected.updatedAt } : {}) }),
      window.donwells.verificationList(workspacePath)
    ]).then(([history, verification]) => {
      if (cancelled) return
      if (history.status === 'fulfilled') setData(history.value)
      if (verification.status === 'fulfilled') setChecks(verification.value)
      setError([history, verification].filter(result => result.status === 'rejected').map(result => String(result.reason)).join('\n'))
      setLoading(false); clearInterval(timer)
      if (request.current?.id === id) request.current = null
    })
    return () => {
      cancelled = true; clearInterval(timer)
      if (request.current?.id === id) { request.current = null; void window.donwells.projectSessionHistoryAnalyticsCancel(workspacePath, id).catch(() => {}) }
    }
  }, [workspacePath, open, refresh])
  const number = (value: number | null) => value === null ? 'Unavailable' : value.toLocaleString()
  return <details className="project-analytics" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Usage and outcomes</summary>
    {open && <>
      <label>Analysis engine<select value={engine} disabled={loading} onChange={event => setEngine(event.target.value === 'duckdb' ? 'duckdb' : 'sqlite')}><option value="sqlite">SQLite summary</option><option value="duckdb">DuckDB activity exploration</option></select></label>
      {engine === 'duckdb' && <>
        <button type="button" disabled={loading} onClick={() => { void window.donwells.projectMemoryList({ workspacePath, kinds: ['decision'], limit: 50 }).then(result => { setDecisions(result.entries); setDecisionId('') }).catch(cause => setError(String(cause))) }}>Load project decision dates</button>
        <label>Compare around a recorded decision<select value={decisionId} disabled={loading} onChange={event => setDecisionId(event.target.value)}><option value="">No date comparison</option>{decisions.map(decision => <option key={decision.id} value={decision.id}>{decision.title} · revision {decision.revision} · {new Date(decision.updatedAt).toLocaleString()}</option>)}</select></label>
        <p>Up to 50 recent project decisions. Comparison uses the selected revision's recorded timestamp; it does not infer causation.</p>
      </>}
      {loading && <button type="button" onClick={() => { const current = request.current; if (current) void window.donwells.projectSessionHistoryAnalyticsCancel(current.path, current.id).catch(cause => setError(String(cause))) }}>Cancel analytics</button>}
      {loading && progress && <p role="status">{progress}</p>}
      <button type="button" disabled={loading} onClick={() => { setLoading(true); setRefresh(value => value + 1) }}>Run selected analysis</button>
      {error && <p role="alert">{error}</p>}
      {!data && !checks && !error && <p role="status">Reading project records…</p>}
      {data && <>
        <p>{data.engine ?? 'sqlite'} · {data.sessions} current sessions · {data.excluded} outdated or out-of-project records excluded{data.truncated ? ' · latest 1,000 records only' : ''}. Indexed {new Date(data.indexedAt).toLocaleString()}.</p>
        <div className="project-analytics-table"><table><caption>Native session usage</caption><thead><tr><th>Day / agent</th><th>Sessions</th><th>Output tokens</th><th>Peak context</th></tr></thead><tbody>{data.days.map(row => <tr key={`${row.day}:${row.agent}`}><th scope="row">{row.day}<br />{row.agent}</th><td>{row.sessions}</td><td>{number(row.outputTokens)}<br />{row.tokenSessions}/{row.sessions} measured</td><td>{number(row.peakContext)}<br />{row.contextSessions}/{row.sessions} measured</td></tr>)}</tbody></table></div>
        {data.costs.length === 0 ? <p>Cost unavailable: these sessions contain no billing events.</p> : <div className="project-analytics-table"><table><caption>Recorded costs — status and source retained</caption><thead><tr><th>Day / source</th><th>Status</th><th>USD</th><th>Coverage</th></tr></thead><tbody>{data.costs.map(row => <tr key={JSON.stringify([row.day, row.status, row.source])}><th scope="row">{row.day}<br />{row.source || 'Unspecified'}</th><td>{row.status || 'Unspecified'}</td><td>{row.microdollars === null ? 'Unavailable' : (row.microdollars / 1e6).toFixed(6)}</td><td>{row.measuredEvents}/{row.events} events</td></tr>)}</tbody></table></div>}
        {!!data.comparison?.length && <div className="project-analytics-table"><table><caption>Activity around {data.decisionAt ? new Date(data.decisionAt).toLocaleString() : 'selected date'}</caption><thead><tr><th>Period / agent</th><th>Sessions</th><th>Output tokens</th></tr></thead><tbody>{data.comparison.map(row => <tr key={row.period + row.agent}><th>{row.period} · {row.agent}</th><td>{row.sessions}</td><td>{number(row.outputTokens)} · {row.tokenSessions}/{row.sessions} measured</td></tr>)}</tbody></table></div>}
        {data.sourceGeneration && <details><summary>Source snapshot</summary><p className="memory-storage-path">{data.sourceGeneration}</p><p>{data.sourceRefs?.length ?? 0} current source identities were rechecked before publishing these results.</p></details>}
        <p>CPU and RAM history unavailable. Context tokens describe model usage, not computer resources.</p>
      </>}
      {checks && <><p>Latest {checks.length} verification records (maximum 20). Source freshness is checked; attached artifacts are not revalidated here.</p>{checks.length === 0 ? <p>No verification runs recorded.</p> : <ul>{checks.map(entry => <li key={`${entry.runId}:${entry.task.id}`}>{entry.task.command}: {entry.task.status} · {entry.sourceState}</li>)}</ul>}</>}
    </>}
  </details>
}
