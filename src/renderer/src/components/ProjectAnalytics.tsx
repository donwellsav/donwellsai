import { useEffect, useState } from 'react'
import type { SessionHistoryAnalytics } from '@shared/project-session-history'
import type { VerificationEntry } from '@shared/operational-runs'

export function ProjectAnalytics({ workspacePath }: { workspacePath: string }) {
  const [open, setOpen] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [data, setData] = useState<SessionHistoryAnalytics | null>(null)
  const [checks, setChecks] = useState<VerificationEntry[] | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    setData(null); setChecks(null); setError('')
    if (!open) return
    setLoading(true)
    let cancelled = false
    void Promise.allSettled([
      window.donwells.projectSessionHistoryAnalytics(workspacePath),
      window.donwells.verificationList(workspacePath)
    ]).then(([history, verification]) => {
      if (cancelled) return
      if (history.status === 'fulfilled') setData(history.value)
      if (verification.status === 'fulfilled') setChecks(verification.value)
      setError([history, verification].filter(result => result.status === 'rejected').map(result => String(result.reason)).join('\n'))
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [workspacePath, open, refresh])
  const number = (value: number | null) => value === null ? 'Unavailable' : value.toLocaleString()
  return <details className="project-analytics" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Usage and outcomes</summary>
    {open && <>
      <button type="button" disabled={loading} onClick={() => { setLoading(true); setRefresh(value => value + 1) }}>Refresh analytics</button>
      {error && <p role="alert">{error}</p>}
      {!data && !checks && !error && <p role="status">Reading project records…</p>}
      {data && <>
        <p>{data.sessions} current sessions · {data.excluded} outdated or out-of-project records excluded{data.truncated ? ' · latest 1,000 records only' : ''}. Indexed {new Date(data.indexedAt).toLocaleString()}.</p>
        <div className="project-analytics-table"><table><caption>Native session usage</caption><thead><tr><th>Day / agent</th><th>Sessions</th><th>Output tokens</th><th>Peak context</th></tr></thead><tbody>{data.days.map(row => <tr key={`${row.day}:${row.agent}`}><th scope="row">{row.day}<br />{row.agent}</th><td>{row.sessions}</td><td>{number(row.outputTokens)}<br />{row.tokenSessions}/{row.sessions} measured</td><td>{number(row.peakContext)}<br />{row.contextSessions}/{row.sessions} measured</td></tr>)}</tbody></table></div>
        {data.costs.length === 0 ? <p>Cost unavailable: these sessions contain no billing events.</p> : <div className="project-analytics-table"><table><caption>Recorded costs — status and source retained</caption><thead><tr><th>Day / source</th><th>Status</th><th>USD</th><th>Coverage</th></tr></thead><tbody>{data.costs.map(row => <tr key={JSON.stringify([row.day, row.status, row.source])}><th scope="row">{row.day}<br />{row.source || 'Unspecified'}</th><td>{row.status || 'Unspecified'}</td><td>{row.microdollars === null ? 'Unavailable' : (row.microdollars / 1e6).toFixed(6)}</td><td>{row.measuredEvents}/{row.events} events</td></tr>)}</tbody></table></div>}
        <p>CPU and RAM history unavailable. Context tokens describe model usage, not computer resources.</p>
      </>}
      {checks && <><p>Latest {checks.length} verification records (maximum 20). Source freshness is checked; attached artifacts are not revalidated here.</p>{checks.length === 0 ? <p>No verification runs recorded.</p> : <ul>{checks.map(entry => <li key={`${entry.runId}:${entry.task.id}`}>{entry.task.command}: {entry.task.status} · {entry.sourceState}</li>)}</ul>}</>}
    </>}
  </details>
}
