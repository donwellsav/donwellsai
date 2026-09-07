import { useEffect, useRef, useState } from 'react'
import type { ProjectHandoff, ProjectHandoffStatus } from '@shared/project-handoff'
import type { ProjectMemoryEntry } from '@shared/project-memory'
import { agentProviderName } from '@shared/agent-presentation'
import { useAppStore } from '../store'

export function ProjectHandoffPanel({ workspacePath }: { workspacePath: string }) {
  const agents = useAppStore(state => state.runningAgents)
  const repos = useAppStore(state => state.repos)
  const project = repos.find(repo => repo.worktrees.some(worktree => worktree.path === workspacePath))
  const sessions = Object.values(agents).filter(agent => project?.worktrees.some(worktree => worktree.path === agent.workspacePath))
  const sources = sessions.filter(agent => agent.workspacePath === workspacePath)
  const [items, setItems] = useState<ProjectHandoff[]>([])
  const [selected, setSelected] = useState<ProjectHandoffStatus | null>(null)
  const [source, setSource] = useState('')
  const [receiver, setReceiver] = useState('')
  const [goal, setGoal] = useState('')
  const [summary, setSummary] = useState('')
  const [questions, setQuestions] = useState('')
  const [steps, setSteps] = useState('')
  const [memoryQuery, setMemoryQuery] = useState('')
  const [memoryResults, setMemoryResults] = useState<ProjectMemoryEntry[]>([])
  const [memoryTotal, setMemoryTotal] = useState(0)
  const [reviewedMemory, setReviewedMemory] = useState<ProjectMemoryEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [exportPath, setExportPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)
  const claimKeys = useRef(new Map<string, string>())
  useEffect(() => setCopied(false), [selected?.handoff.id, selected?.handoff.revision])
  useEffect(() => {
    let cancelled = false
    void window.donwells.projectHandoffList(workspacePath).then(value => { if (!cancelled) setItems(value) }, cause => { if (!cancelled) setError(String(cause)) })
    return () => { cancelled = true }
  }, [workspacePath, generation])
  const operate = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError(null)
    try { await action(); setGeneration(value => value + 1) }
    catch (cause) { setError(String(cause)) }
    finally { setBusy(false) }
  }
  const lines = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean)
  return <details className="handoff-panel">
    <summary>Agent handoffs · {items.length}</summary>
    <p>Save the work in progress for another session. Shared decisions remain in project memory.</p>
    {error && <p role="alert" className="op-inline-error">{error}</p>}
    <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void operate(async () => {
      if (selected) setSelected(await window.donwells.projectHandoffGet(workspacePath, selected.handoff.id))
    })}>Refresh handoffs</button>
    <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void operate(async () => {
      setExportPath((await window.donwells.projectHandoffExport(workspacePath)).path)
    })}>Export project handoffs</button>
    {exportPath && <p className="memory-storage-path" role="status">Handoff export saved: {exportPath}</p>}
    <ul>{items.map(item => <li key={item.id}><button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void operate(async () => {
      setSelected(await window.donwells.projectHandoffGet(workspacePath, item.id)); setReceiver('')
    })}>{item.goal} · {item.state}</button></li>)}</ul>
    {selected && <section aria-label="Handoff review">
      <strong>{selected.handoff.goal}</strong>
      <p>{selected.handoff.summary}</p>
      <p>From {selected.handoff.fromSessionId} · Revision {selected.handoff.revision}</p>
      <p title={selected.handoff.contentFingerprint}>Source {selected.handoff.sourceRevision?.slice(0, 12) ?? 'uncommitted'}</p>
      <p className="memory-storage-path">{selected.handoff.checkoutPath}</p>
      <details><summary>Changed files · {selected.handoff.changedFiles.length}</summary>
        <ul>{selected.handoff.changedFiles.map(path => <li key={path}>{path}</li>)}</ul>
      </details>
      {selected.handoff.openQuestions.length > 0 && <><strong>Open questions</strong><ul>{selected.handoff.openQuestions.map((text, i) => <li key={i}>{text}</li>)}</ul></>}
      <strong>Next steps</strong><ol>{selected.handoff.nextSteps.map((text, i) => <li key={i}>{text}</li>)}</ol>
      {!!selected.memorySources?.length && <details open><summary>Referenced project facts · {selected.memorySources.length}</summary>
        {selected.memorySources.map(ref => <div key={ref.id}>
          <strong>{ref.current?.title ?? ref.id} · reviewed revision {ref.revision} · {ref.state}</strong>
          {ref.current && <><p>Current revision {ref.current.revision}</p><pre>{ref.current.content}</pre></>}
        </div>)}
      </details>}
      {selected.stale && <p role="status">Source changed or is unavailable. Review and save a fresh handoff. {selected.sourceError}</p>}
      <button className="btn btn-secondary btn-sm" disabled={busy || !!goal.trim() || !!summary.trim() || !!questions.trim() || !!steps.trim() || reviewedMemory.length > 0 || selected.handoff.checkoutPath !== workspacePath} onClick={() => {
        setSource(selected.handoff.fromSessionId); setGoal(selected.handoff.goal); setSummary(selected.handoff.summary)
        setQuestions(selected.handoff.openQuestions.join('\n')); setSteps(selected.handoff.nextSteps.join('\n'))
        setReviewedMemory([])
        setMemoryResults((selected.memorySources ?? []).flatMap(ref => ref.current && !ref.current.archivedAt ? [ref.current] : []))
        setMemoryTotal(selected.memorySources?.length ?? 0)
      }}>Copy to fresh draft for review</button>
      <p className="memory-caption">Refresh a handoff in its source checkout with an empty draft. Review and attach current facts again before saving.</p>
      <p>Delivery: {selected.handoff.delivery}. Acceptance reserves the work; it does not send terminal input.</p>
      {selected.handoff.state === 'open' && <>
        <label>Receiving session<select aria-label="Receiving session" className="input" value={receiver} disabled={busy} onChange={event => setReceiver(event.target.value)}>
          <option value="">Choose an active session</option>
          {sessions.filter(agent => agent.liveness === 'live').map(agent => <option value={agent.sessionId} key={agent.sessionId}>{agentProviderName(agent)} · {agent.sessionId.slice(0, 8)}</option>)}
        </select></label>
        <button className="btn btn-primary btn-sm" disabled={busy || selected.stale || !receiver} onClick={() => void operate(async () => {
          const target = `${selected.handoff.id}:${receiver}`
          let key = claimKeys.current.get(target)
          if (!key) { key = crypto.randomUUID(); claimKeys.current.set(target, key) }
          await window.donwells.projectHandoffAccept(workspacePath, selected.handoff.id, selected.handoff.revision, receiver, key)
          setSelected(await window.donwells.projectHandoffGet(workspacePath, selected.handoff.id))
        })}>Accept handoff</button>
      </>}
      {selected.handoff.acceptedBySessionId && <p>Accepted by {selected.handoff.acceptedBySessionId}</p>}
      {selected.handoff.state === 'accepted' && selected.handoff.delivery === 'not-sent' && <button className="btn btn-secondary btn-sm" disabled={busy || selected.stale} onClick={() => void operate(async () => {
        await navigator.clipboard.writeText(`Receive the handoff accepted for this session using handoff_receive with ${JSON.stringify({ id: selected.handoff.id, expectedRevision: selected.handoff.revision })}. Read the returned context, then call handoff_acknowledge with its id and returned revision before continuing. If either tool is unavailable, reconnect this session to the project's Donwells memory MCP server. Do not repeat an uncertain receive; inspect its state first.`)
        setCopied(true)
      })}>{copied ? 'Instructions copied' : 'Copy receiving instructions'}</button>}
      {selected.handoff.delivery === 'uncertain' && <p role="status">Receipt is unconfirmed. Inspect the receiving terminal and its tool result before continuing. A delivery attempt cannot be blindly repeated.</p>}

      {selected.handoff.state !== 'superseded' && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void operate(async () => {
        await window.donwells.projectHandoffSupersede(workspacePath, selected.handoff.id, selected.handoff.revision)
        setSelected(await window.donwells.projectHandoffGet(workspacePath, selected.handoff.id))
      })}>Supersede handoff</button>}
    </section>}
    <form aria-label="Save agent handoff" onSubmit={event => { event.preventDefault(); void operate(async () => {
      const handoff = await window.donwells.projectHandoffCreate(workspacePath, { taskId: null, fromSessionId: source, toAgent: null, goal, summary, openQuestions: lines(questions), nextSteps: lines(steps), evidenceIds: [], memorySources: reviewedMemory.map(({ id, revision }) => ({ id, revision })) })
      setSelected(await window.donwells.projectHandoffGet(workspacePath, handoff.id))
      setGoal(''); setSummary(''); setQuestions(''); setSteps(''); setReviewedMemory([])
    }) }}>
      <strong>Save a handoff</strong>
      <fieldset disabled={busy}>
        <label>Source session<select aria-label="Source session" className="input" required value={source} onChange={event => setSource(event.target.value)}>
          <option value="">Choose a session in this checkout</option>
          {sources.map(agent => <option value={agent.sessionId} key={agent.sessionId}>{agentProviderName(agent)} · {agent.sessionId.slice(0, 8)}</option>)}
        </select></label>
        {!sources.length && <p>Start an agent in this checkout before saving a handoff.</p>}
        <label>Goal<input className="input" required maxLength={8000} value={goal} onChange={event => setGoal(event.target.value)} /></label>
        <label>Progress summary<textarea className="input" required maxLength={24000} value={summary} onChange={event => setSummary(event.target.value)} /></label>
        <label>Open questions · one per line<textarea className="input" maxLength={16000} value={questions} onChange={event => setQuestions(event.target.value)} /></label>
        <label>Next steps · one per line<textarea className="input" maxLength={16000} value={steps} onChange={event => setSteps(event.target.value)} /></label>
        <details><summary>Attach reviewed project facts · {reviewedMemory.length} / 50</summary>
          <label>Find project facts<input className="input" value={memoryQuery} onChange={event => setMemoryQuery(event.target.value)} /></label>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void operate(async () => {
            const result = await window.donwells.projectMemoryList({ workspacePath, ...(memoryQuery.trim() ? { query: memoryQuery.trim() } : {}), limit: 50 })
            setMemoryResults(result.entries); setMemoryTotal(result.total)
          })}>Find facts</button>
          <p>Showing {memoryResults.length} of {memoryTotal} matches. Narrow the query for other facts. Attaching saves the reviewed ID and revision, not a second copy of the fact.</p>
          {memoryResults.map(fact => <details key={fact.id}><summary>{fact.title} · Revision {fact.revision}</summary>
            <pre>{fact.content}</pre><p>{fact.kind} · {fact.tags.join(', ')} · {fact.provenance.sourceRef ?? 'No source reference'}</p>
            <button type="button" className="btn btn-secondary btn-sm" disabled={reviewedMemory.length >= 50 && !reviewedMemory.some(ref => ref.id === fact.id)} onClick={() => setReviewedMemory(current => [...current.filter(ref => ref.id !== fact.id), fact])}>Attach reviewed revision</button>
          </details>)}
          {reviewedMemory.map(fact => <p key={fact.id}>{fact.title} · Revision {fact.revision} <button type="button" className="btn btn-secondary btn-sm" onClick={() => setReviewedMemory(current => current.filter(ref => ref.id !== fact.id))}>Remove reference</button></p>)}
        </details>
        <button className="btn btn-primary btn-sm" disabled={!source || !goal.trim() || !summary.trim()}>Save handoff for review</button>
      </fieldset>
    </form>
  </details>
}
