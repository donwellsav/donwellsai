import { useEffect, useState } from 'react'
import type { KnowledgeAnswer, KnowledgeSelection, KnowledgeStatus } from '@shared/project-knowledge'
import type { ProjectDoctorReport } from '@shared/project-doctor'
import { openProjectMemoryEditor, useProjectMemoryEditor } from '../project-memory-editor'

type Candidate = KnowledgeSelection & { title: string; content: string }
export function ProjectKnowledgePanel({ workspacePath }: { workspacePath: string }) {
  const [report, setReport] = useState<ProjectDoctorReport | null>(null)
  const [endpoint, setEndpoint] = useState('http://127.0.0.1:8888'), [model, setModel] = useState('')
  const [enabled, setEnabled] = useState(false), [status, setStatus] = useState<KnowledgeStatus | null>(null)
  const [sources, setSources] = useState<KnowledgeSelection[]>([]), [candidates, setCandidates] = useState<Candidate[]>([])
  const [query, setQuery] = useState(''), [answer, setAnswer] = useState<KnowledgeAnswer | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const memoryGeneration = useProjectMemoryEditor(state => state.generation)
  useEffect(() => { setAnswer(null) }, [memoryGeneration])
  useEffect(() => {
    if (!answer) return
    let cancelled = false, pending = false
    const timer = window.setInterval(() => {
      if (pending) return
      pending = true
      void window.donwells.projectKnowledgeStatus(workspacePath).then(value => {
        if (!cancelled && (value.stale || value.pendingCleanup || value.generation !== answer.generation)) { setAnswer(null); setStatus(value); setError('Sources changed; reconcile and ask again.') }
      }).catch(() => { if (!cancelled) setAnswer(null) }).finally(() => { pending = false })
    }, 3000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [answer, workspacePath])
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(''); setAnswer(null)
    try { await action() } catch (cause) { setError(String(cause)) } finally { setBusy(false) }
  }
  async function inspect() {
    const value = await window.donwells.projectDoctorInspect(workspacePath)
    setReport(value)
    if (value.configuration.hindsight) {
      setEndpoint(value.configuration.hindsight.endpoint); setModel(value.configuration.hindsight.model); setEnabled(value.configuration.hindsight.enabled)
      const current = await window.donwells.projectKnowledgeStatus(workspacePath); setStatus(current); setSources(current.sources)
    }
  }
  async function review() {
    const [memory, handoffs] = await Promise.all([window.donwells.projectMemoryList({ workspacePath, query: query.trim() || undefined, limit: 50 }), window.donwells.projectHandoffList(workspacePath)])
    setCandidates([
      ...memory.entries.map(entry => ({ kind: 'memory' as const, id: entry.id, revision: entry.revision, title: entry.title, content: entry.content })),
      ...handoffs.filter(entry => entry.state !== 'superseded').slice(0, 50).map(entry => ({ kind: 'handoff' as const, id: entry.id, revision: entry.revision, title: entry.goal, content: entry.summary }))
    ])
  }
  return <details className="memory-storage" onToggle={event => { if (event.currentTarget.open && !report && !busy) void run(inspect) }}>
    <summary>Learned knowledge · Hindsight</summary>
    <p className="memory-guidance">Select reviewed project sources, then retain them explicitly. Recall and reflection use the selected local service. Learned answers remain separate from authored memory.</p>
    {report && <>
      <details><summary>Service configuration</summary>
      <label><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /> Enable local Hindsight</label>
      <label>Service origin<input className="input" value={endpoint} onChange={event => setEndpoint(event.target.value)} /></label>
      <label>Server model (configured externally)<input className="input" value={model} onChange={event => setModel(event.target.value)} placeholder="Exact model configured on your service" /></label><p className="memory-guidance">This records your server configuration; Hindsight’s API does not expose or verify its model identity.</p>
      <p className="memory-guidance">Use an existing local HTTP service. Remote endpoints and credentials are not supported here.</p>
      <button className="btn btn-secondary btn-sm" disabled={busy || !report.configurationValid} onClick={() => void run(async () => {
        await window.donwells.projectDoctorConfigure(workspacePath, { ...report.configuration, hindsight: { enabled, endpoint, model } }, report.revision)
        await inspect()
      })}>Save configuration and stop services</button>
      <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void run(inspect)}>Refresh saved configuration</button>
      </details>
      <p role="status">{busy ? 'Knowledge operation running…' : status ? `${status.phase} · ${status.stale ? 'sources need reconciliation' : 'sources current'} · ${status.pendingCleanup} generations awaiting cleanup` : 'No retained generation'}</p>
      <label>Find sources / ask a question<input className="input" value={query} maxLength={2000} onChange={event => setQuery(event.target.value)} /></label>
      <button className="btn btn-secondary btn-sm" disabled={busy || !query.trim()} onClick={() => void run(async () => setAnswer(await window.donwells.projectKnowledgeRecall(workspacePath, query.trim())))}>Recall</button>
      <button className="btn btn-secondary btn-sm" disabled={busy || !query.trim()} onClick={() => void run(async () => setAnswer(await window.donwells.projectKnowledgeReflect(workspacePath, query.trim())))}>Reflect · uses model</button>
      <button className="btn btn-secondary btn-sm" onClick={() => void window.donwells.projectKnowledgeStop(workspacePath).then(async () => { setStatus(await window.donwells.projectKnowledgeStatus(workspacePath)); setAnswer(null) }).catch(cause => setError(String(cause)))}>Stop knowledge work</button>
      <p className="memory-guidance">Stop cancels this workspace's requests; your external service stays running. Reconcile resumes work and retries acknowledged cleanup.</p>
      <details><summary>Reviewed source selection · {sources.length}</summary>
      <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void run(review)}>Review matching memories and handoffs</button>
      {candidates.map(source => {
        const selected = sources.find(item => item.kind === source.kind && item.id === source.id)
        return <details key={source.kind + source.id}>
          <summary>{source.kind} · {source.title} · r{source.revision}</summary>
          <p style={{ whiteSpace: 'pre-wrap' }}>{source.content}</p>
          <label><input type="checkbox" checked={selected?.revision === source.revision} disabled={busy || (!selected && sources.length >= 50)} onChange={event => setSources(current => [...current.filter(item => item.kind !== source.kind || item.id !== source.id), ...(event.target.checked ? [{ kind: source.kind, id: source.id, revision: source.revision }] : [])])} /> Retain this reviewed revision</label>
        </details>
      })}
      <p>{sources.length} selected sources. Search lists at most 50 matching memories and 50 open handoffs.</p>
      {sources.map(source => <div key={source.kind + source.id}>{source.kind} · {source.id} · r{source.revision} <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setSources(current => current.filter(item => item !== source))}>Remove</button></div>)}
      <button className="btn btn-secondary btn-sm" disabled={busy || !report.configuration.hindsight?.enabled} onClick={() => void run(async () => setStatus(await window.donwells.projectKnowledgeReconcile(workspacePath, sources)))}>Reconcile selected sources · uses model</button>
      </details>
    </>}
    {error && <p className="memory-error" role="alert">{error}</p>}
    {answer && <section aria-label="Learned answers">
      <p>Learned · {answer.model} · {answer.omitted} results omitted for missing provenance or result limits</p>
      {!answer.items.length && <p>No learned results for these sources.</p>}
      {answer.items.map((item, index) => <article key={index}>
        <p style={{ whiteSpace: 'pre-wrap' }}>{item.text}</p>
        {item.sources.map((source, i) => <button key={i} className="btn btn-secondary btn-sm" onClick={() => void (async () => {
          if (source.kind === 'memory') openProjectMemoryEditor(workspacePath, await window.donwells.projectMemoryGet({ workspacePath, id: source.id }))
          else { const value = await window.donwells.projectHandoffGet(workspacePath, source.id); setCandidates([{ ...source, title: value.handoff.goal, content: value.handoff.summary }]) }
        })().catch(cause => setError(String(cause)))}>{source.kind} {source.id} · r{source.revision}</button>)}
        <button className="btn btn-secondary btn-sm" onClick={() => {
          if (useProjectMemoryEditor.getState().editor) { setError('Save or close the existing memory draft first.'); return }
          openProjectMemoryEditor(workspacePath)
          useProjectMemoryEditor.getState().change({ title: 'Review learned knowledge', content: item.text + '\n\nReviewed source revisions:\n' + item.sources.map(source => `${source.kind}:${source.id}@${source.revision} (${source.projectKey})`).join('\n'), sourceRef: `hindsight:${answer.generation}; model:${answer.model}` })
        }}>Review as new memory draft</button>
      </article>)}
    </section>}
  </details>
}
