import { useEffect, useState } from 'react'
import type { GraphitiConfiguration, TemporalKnowledgeAnswer, TemporalKnowledgeStatus } from '@shared/project-temporal-knowledge'
import type { ProjectDoctorReport } from '@shared/project-doctor'
import type { ProjectMemoryEntry, ProjectMemoryRevision } from '@shared/project-memory'
import type { KnowledgeSelection } from '@shared/project-knowledge'
const initial: GraphitiConfiguration = { enabled: false, python: '', neo4jUri: 'bolt://127.0.0.1:7687', neo4jUser: 'neo4j', modelUrl: 'http://127.0.0.1:8000/v1', model: '', embeddingUrl: 'http://127.0.0.1:8000/v1', embeddingModel: '', embeddingDimensions: 1024 }
export function ProjectTemporalKnowledgePanel({ workspacePath }: { workspacePath: string }) {
  const [report, setReport] = useState<ProjectDoctorReport | null>(null), [draft, setDraft] = useState(initial)
  const [password, setPassword] = useState(''), [query, setQuery] = useState(''), [asOf, setAsOf] = useState('')
  const [sources, setSources] = useState<KnowledgeSelection[]>([]), [candidates, setCandidates] = useState<ProjectMemoryEntry[]>([])
  const [status, setStatus] = useState<TemporalKnowledgeStatus | null>(null), [answer, setAnswer] = useState<TemporalKnowledgeAnswer | null>(null)
  const [reviewedRevision, setReviewedRevision] = useState<ProjectMemoryRevision | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function run(action: () => Promise<void>) { setBusy(true); setAnswer(null); setError(''); try { await action() } catch (cause) { setError(String(cause)) } finally { setBusy(false) } }
  async function inspect() {
    const value = await window.donwells.projectDoctorInspect(workspacePath); setReport(value)
    if (value.configuration.graphiti) { setDraft(value.configuration.graphiti); const current = await window.donwells.projectTemporalKnowledgeStatus(workspacePath); setStatus(current); setSources(current.sources) }
  }
  useEffect(() => {
    if (!answer) return
    let stopped = false, pending = false
    const timer = window.setInterval(() => {
      if (pending) return
      pending = true
      void window.donwells.projectTemporalKnowledgeStatus(workspacePath).then(value => { if (!stopped && (!value.enabled || value.stale || value.pendingCleanup || value.generation !== answer.generation)) { setAnswer(null); setStatus(value) } }).catch(() => { if (!stopped) setAnswer(null) }).finally(() => { pending = false })
    }, 3000)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [answer, workspacePath])
  return <details className="memory-storage" onToggle={event => { if (event.currentTarget.open && !report && !busy) void run(inspect) }}>
    <summary>Dated relationships · Graphiti</summary>
    <p className="memory-guidance">Derived relationships from explicitly reviewed memory history. Current and historical answers distinguish source revision dates from inferred relationship validity.</p>
    {report && <>
      <details><summary>Neo4j and model configuration</summary>
        <label><input type="checkbox" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} /> Enable Graphiti</label>
        {([['python', 'Python with graphiti-core 0.30.1'], ['neo4jUri', 'Local Neo4j Bolt URI'], ['neo4jUser', 'Neo4j username'], ['modelUrl', 'Local model API'], ['model', 'Model identity'], ['embeddingUrl', 'Local embedding API'], ['embeddingModel', 'Embedding model identity']] as const).map(([field, label]) => <label key={field}>{label}<input className="input" value={draft[field]} onChange={event => setDraft({ ...draft, [field]: event.target.value })} /></label>)}
        <label>Embedding dimensions<input className="input" type="number" min={1} max={4096} value={draft.embeddingDimensions} onChange={event => setDraft({ ...draft, embeddingDimensions: Number(event.target.value) })} /></label>
        <button className="btn btn-secondary btn-sm" disabled={busy || !report.configurationValid} onClick={() => void run(async () => { await window.donwells.projectDoctorConfigure(workspacePath, { ...report.configuration, graphiti: draft }, report.revision); await inspect() })}>Save configuration and stop services</button>
        <label>Neo4j password<input className="input" type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} /></label>
        <button className="btn btn-secondary btn-sm" disabled={busy || !password} onClick={() => void run(async () => { await window.donwells.projectTemporalKnowledgePasswordSet(workspacePath, password); setPassword('') })}>Save password to protected store</button>
        <p className="memory-guidance">Use an existing local Neo4j service; the app does not install or own its server. Passwords are never returned to agents or stored in tool configuration.</p>
      </details>
      <p role="status">{busy ? 'Temporal knowledge operation running…' : status ? `${status.stale ? 'Sources need reconciliation' : 'Sources current'} · ${status.pendingCleanup} groups awaiting cleanup` : 'No published relationship group'}</p>
      <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void run(inspect)}>Refresh saved state</button>
      <label>Find sources / relationship question<input className="input" value={query} maxLength={2000} onChange={event => setQuery(event.target.value)} /></label>
      <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void run(async () => setCandidates((await window.donwells.projectMemoryList({ workspacePath, query: query.trim() || undefined, includeArchived: true, limit: 50 })).entries))}>Review matching source histories</button>
      {candidates.map(entry => <details key={entry.id}><summary>{entry.title} · r{entry.revision}{entry.archivedAt ? ' · archived' : ''}</summary><p style={{ whiteSpace: 'pre-wrap' }}>{entry.content}</p>
        <label><input type="checkbox" checked={sources.some(source => source.id === entry.id && source.revision === entry.revision)} disabled={busy} onChange={event => setSources(current => [...current.filter(source => source.id !== entry.id), ...(event.target.checked ? [{ kind: 'memory' as const, id: entry.id, revision: entry.revision }] : [])])} /> Include available revision history</label>
      </details>)}
      <p>{sources.length} selected sources. Up to 50 search matches; retained history is bounded to 128 episodes and 256 KiB per generation.</p>
      {sources.map(source => <div key={source.id}>{source.id} · r{source.revision} <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setSources(current => current.filter(item => item.id !== source.id))}>Remove</button></div>)}
      <button className="btn btn-secondary btn-sm" disabled={busy || !report.configuration.graphiti?.enabled} onClick={() => void run(async () => setStatus(await window.donwells.projectTemporalKnowledgeReconcile(workspacePath, sources)))}>Rebuild selected histories · uses model</button>
      <label>Historical time (blank for current)<input className="input" type="datetime-local" value={asOf} onChange={event => setAsOf(event.target.value)} /></label>
      <button className="btn btn-secondary btn-sm" disabled={busy || !query.trim()} onClick={() => void run(async () => setAnswer(await window.donwells.projectTemporalKnowledgeQuery(workspacePath, query.trim(), asOf ? new Date(asOf).toISOString() : undefined)))}>Find {asOf ? 'historical' : 'current'} relationships</button>
      <button className="btn btn-secondary btn-sm" onClick={() => void window.donwells.projectTemporalKnowledgeStop(workspacePath).then(() => setAnswer(null)).catch(cause => setError(String(cause)))}>Stop temporal work</button>
    </>}
    {reviewedRevision && <section aria-label="Cited canonical revision"><strong>{reviewedRevision.title} · r{reviewedRevision.revision}</strong><p style={{ whiteSpace: 'pre-wrap' }}>{reviewedRevision.content}</p><p>{reviewedRevision.updatedAt}</p><button className="btn btn-secondary btn-sm" onClick={() => setReviewedRevision(null)}>Close source</button></section>}
    {error && <p role="alert" className="memory-error">{error}</p>}
    {answer && <section aria-label="Learned temporal relationships"><p>Learned · {answer.mode} · {answer.asOf} · {answer.omitted} unsupported or limited results omitted</p>
      {!answer.relationships.length && <p>No relationships found for this time and source selection.</p>}
      {answer.relationships.map(row => <article key={row.id}><p>{row.text}</p><p>Inferred validity: {row.validAt ?? 'unknown'} → {row.invalidAt ?? 'open'}</p>
        {row.sources.map((source, i) => <button className="btn btn-secondary btn-sm" key={i} onClick={() => void window.donwells.projectMemoryHistory({ workspacePath, id: source.id, limit: 33 }).then(history => { const revision = history.revisions.find(item => item.revision === source.revision); if (!revision) throw new Error('Cited revision is no longer retained.'); setReviewedRevision(revision) }).catch(cause => setError(String(cause)))}>{source.id} · source r{source.revision} · {source.sourceTime}</button>)}
      </article>)}
    </section>}
  </details>
}
