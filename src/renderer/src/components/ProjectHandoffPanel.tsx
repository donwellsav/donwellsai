import { guiDraftMap } from '../gui-drafts'
import type { DiffReviewNote } from '@shared/diff-review'
import { useEffect, useRef, useState } from 'react'
import type { ProjectHandoff, ProjectHandoffStatus } from '@shared/project-handoff'
import type { AcpAgentSnapshot } from '@shared/agent-runtime'
import type { ProjectMemoryEntry } from '@shared/project-memory'
import { agentProviderName } from '@shared/agent-presentation'
import { useAppStore } from '../store'

const emptyHandoffDraft = { source: '', receiver: '', goal: '', summary: '', questions: '', steps: '', memoryQuery: '', memoryResults: [] as ProjectMemoryEntry[], memoryTotal: 0, reviewedMemory: [] as ProjectMemoryEntry[], reviewPath: '', comparison: 'working' as DiffReviewNote['target']['comparison'], reviewResults: [] as DiffReviewNote[], selectedReviews: [] as DiffReviewNote[], exportPath: '' }
const pendingOperations = new Map<string, Promise<string | null>>()
const handoffDrafts = guiDraftMap<typeof emptyHandoffDraft>('handoffs')

export function ProjectHandoffPanel({ workspacePath }: { workspacePath: string }) {
  const draft = handoffDrafts.get(workspacePath) ?? emptyHandoffDraft
  const agents = useAppStore(state => state.runningAgents)
  const repos = useAppStore(state => state.repos)
  const project = repos.find(repo => repo.worktrees.some(worktree => worktree.path === workspacePath))
  const [acpSessions, setAcpSessions] = useState<AcpAgentSnapshot[]>([])
  const nativeSessions = Object.values(agents).filter(agent => project?.worktrees.some(worktree => worktree.path === agent.workspacePath))
  const sessions = [
    ...nativeSessions.map(agent => ({ sessionId: agent.sessionId, workspacePath: agent.workspacePath, live: agent.liveness === 'live', label: `${agentProviderName(agent)} · Native` })),
    ...acpSessions.map(agent => ({ sessionId: agent.id, workspacePath: agent.workspacePath, live: ['ready', 'working', 'permission'].includes(agent.state), label: `OpenCode · ACP · ${agent.state}` }))
  ]
  const sources = sessions.filter(agent => agent.workspacePath === workspacePath)
  const [items, setItems] = useState<ProjectHandoff[]>([])
  const [selected, setSelected] = useState<ProjectHandoffStatus | null>(null)
  const [source, setSource] = useState(draft.source)
  useEffect(() => { if (!source && sources.length === 1) setSource(sources[0]!.sessionId) }, [source, sources.map(session => session.sessionId).join('\0')])
  const [receiver, setReceiver] = useState(draft.receiver)
  const [goal, setGoal] = useState(draft.goal)
  const [summary, setSummary] = useState(draft.summary)
  const [questions, setQuestions] = useState(draft.questions)
  const [steps, setSteps] = useState(draft.steps)
  const [memoryQuery, setMemoryQuery] = useState(draft.memoryQuery)
  const [memoryResults, setMemoryResults] = useState<ProjectMemoryEntry[]>(draft.memoryResults)
  const [memoryTotal, setMemoryTotal] = useState(draft.memoryTotal)
  const [reviewedMemory, setReviewedMemory] = useState<ProjectMemoryEntry[]>(draft.reviewedMemory)
  const [reviewPath, setReviewPath] = useState(draft.reviewPath)
  const [comparison, setComparison] = useState<DiffReviewNote['target']['comparison']>(draft.comparison)
  const [reviewResults, setReviewResults] = useState<DiffReviewNote[]>(draft.reviewResults)
  const [selectedReviews, setSelectedReviews] = useState<DiffReviewNote[]>(draft.selectedReviews)
  const [busy, setBusy] = useState(pendingOperations.has(workspacePath))
  const [copied, setCopied] = useState(false)
  const [exportPath, setExportPath] = useState(draft.exportPath)
  const [error, setError] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)
  useEffect(() => { handoffDrafts.set(workspacePath, { source, receiver, goal, summary, questions, steps, memoryQuery, memoryResults, memoryTotal, reviewedMemory, reviewPath, comparison, reviewResults, selectedReviews, exportPath }) }, [workspacePath, source, receiver, goal, summary, questions, steps, memoryQuery, memoryResults, memoryTotal, reviewedMemory, reviewPath, comparison, reviewResults, selectedReviews, exportPath])
  const checkoutPaths = project?.worktrees.map(worktree => worktree.path).join('\0') ?? ''
  useEffect(() => {
    let cancelled = false
    setAcpSessions([])
    if (checkoutPaths) void Promise.all(checkoutPaths.split('\0').map(path => window.donwells.agentAcpList(path))).then(groups => { if (!cancelled) setAcpSessions(groups.flat()) }, cause => { if (!cancelled) setError(`ACP session status unavailable: ${String(cause)}`) })
    return () => { cancelled = true }
  }, [checkoutPaths, generation])
  const claimKeys = useRef(new Map<string, string>())
  useEffect(() => setCopied(false), [selected?.handoff.id, selected?.handoff.revision])
  useEffect(() => {
    let cancelled = false
    void window.donwells.projectHandoffList(workspacePath).then(value => { if (!cancelled) setItems(value) }, cause => { if (!cancelled) setError(String(cause)) })
    return () => { cancelled = true }
  }, [workspacePath, generation])
  useEffect(() => {
    let live = true
    const pending = pendingOperations.get(workspacePath)
    if (pending) void pending.then(failure => {
      if (!live) return
      const retained = handoffDrafts.get(workspacePath)
      setGoal(retained?.goal ?? ''); setSummary(retained?.summary ?? ''); setQuestions(retained?.questions ?? ''); setSteps(retained?.steps ?? '')
      setReviewedMemory(retained?.reviewedMemory ?? []); setSelectedReviews(retained?.selectedReviews ?? [])
      setError(failure); setBusy(false); setGeneration(value => value + 1)
    })
    return () => { live = false }
  }, [workspacePath])
  const operate = async (action: () => Promise<void>) => {
    if (busy || pendingOperations.has(workspacePath)) return
    setBusy(true); setError(null)
    const pending = Promise.resolve().then(action).then(() => { setGeneration(value => value + 1); return null }).catch(cause => { const failure = String(cause); setError(failure); return failure }).finally(() => { pendingOperations.delete(workspacePath); setBusy(false) })
    pendingOperations.set(workspacePath, pending)
    await pending
  }
  const hasDraft = !!goal || !!summary || !!questions || !!steps || reviewedMemory.length > 0 || selectedReviews.length > 0
  const lines = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean)
  return <details className="handoff-panel">
    <summary>Agent handoffs{items.length > 0 ? ` · ${items.length}` : ''}</summary>
    <p>Agents can save handoffs as they work. Review them here, or write one yourself.</p>
    {error && <p role="alert" className="op-inline-error">{error}</p>}
    <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void operate(async () => {
      if (selected) setSelected(await window.donwells.projectHandoffGet(workspacePath, selected.handoff.id))
    })}>Refresh handoffs</button>
    {items.length > 0 && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void operate(async () => {
      setExportPath((await window.donwells.projectHandoffExport(workspacePath)).path)
    })}>Export project handoffs</button>}
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
      {selected.handoff.sourceBasis === 'folder-files' && <p>Folder snapshot includes authored files and hidden files. Dependency folders (node_modules), Git metadata and .DS_Store are excluded; .gitignore patterns are not applied.</p>}
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
      {!!selected.handoff.reviewEvidence?.length && <details open><summary>Captured diff selections · {selected.handoff.reviewEvidence.length}</summary>
        {selected.handoff.reviewEvidence.map(note => <div key={note.id}>
          <strong>{note.target.filePath} · {note.target.comparison} · {note.anchor.side} lines {note.anchor.startLine}–{note.anchor.endLine} · review revision {note.revision}</strong>
          <p>{note.body}</p><pre>{note.anchor.context.map(line => `${line.lineNumber}: ${line.text}`).join('\n')}</pre>
          <p className="memory-storage-path">Review {note.id} · captured {note.updatedAt}</p>
          <p className="memory-storage-path">Before: {note.snapshot.before.kind === 'content' ? note.snapshot.before.sha256 : 'absent'} · After: {note.snapshot.after.kind === 'content' ? note.snapshot.after.sha256 : 'absent'}</p>
        </div>)}
      </details>}
      {selected.stale && <p role="status">Source changed or is unavailable. Review and save a fresh handoff. {selected.sourceError}</p>}
      <button className="btn btn-secondary btn-sm" disabled={busy || !!goal.trim() || !!summary.trim() || !!questions.trim() || !!steps.trim() || reviewedMemory.length > 0 || selectedReviews.length > 0 || selected.handoff.checkoutPath !== workspacePath} onClick={() => {
        setSource(selected.handoff.fromSessionId); setGoal(selected.handoff.goal); setSummary(selected.handoff.summary)
        setQuestions(selected.handoff.openQuestions.join('\n')); setSteps(selected.handoff.nextSteps.join('\n'))
        setReviewedMemory([])
        setMemoryResults((selected.memorySources ?? []).flatMap(ref => ref.current && !ref.current.archivedAt ? [ref.current] : []))
        setMemoryTotal(selected.memorySources?.length ?? 0)
        setReviewResults(selected.handoff.reviewEvidence ?? []); setSelectedReviews([])
      }}>Copy to fresh draft for review</button>
      <p className="memory-caption">Refresh a handoff in its source checkout with an empty draft. Review and attach current facts again before saving.</p>
      <p>Instructions: {selected.handoff.dispatch?.state ?? 'not submitted'}. Receiver receipt: {selected.handoff.delivery}. Acceptance reserves the work.</p>
      {selected.handoff.state === 'open' && <>
        <label>Receiving session<select aria-label="Receiving session" className="input" value={receiver} disabled={busy} onChange={event => setReceiver(event.target.value)}>
          <option value="">Choose an active session</option>
          {sessions.filter(agent => agent.live).map(agent => <option value={agent.sessionId} key={agent.sessionId}>{agent.label} · {agent.sessionId.slice(0, 8)}</option>)}
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
      {selected.handoff.state === 'accepted' && selected.handoff.delivery === 'not-sent' && !selected.handoff.dispatch && <button className="btn btn-primary btn-sm" disabled={busy || selected.stale} onClick={() => void operate(async () => {
        try { await window.donwells.projectHandoffDispatch(workspacePath, selected.handoff.id, selected.handoff.revision) }
        finally { setSelected(await window.donwells.projectHandoffGet(workspacePath, selected.handoff.id)) }
      })}>Send instructions to receiving session</button>}
      {selected.handoff.dispatch && <p role="status">{selected.handoff.dispatch.state === 'uncertain' ? 'Instruction submission is uncertain. Inspect the receiving session before making a fresh handoff.' : 'Instructions submitted. The receiving agent must separately read and acknowledge the handoff.'} Refresh observes the saved attempt; it does not resend.</p>}
      {selected.handoff.state === 'accepted' && selected.handoff.delivery === 'not-sent' && !selected.handoff.dispatch && <button className="btn btn-secondary btn-sm" disabled={busy || selected.stale} onClick={() => void operate(async () => {
        await navigator.clipboard.writeText(`Receive the handoff accepted for this session using handoff_receive with ${JSON.stringify({ id: selected.handoff.id, expectedRevision: selected.handoff.revision })}. Read the returned context, then call handoff_acknowledge with its id and returned revision before continuing. If either tool is unavailable, reconnect this session to the project's Donwells memory MCP server. Do not repeat an uncertain receive; inspect its state first.`)
        setCopied(true)
      })}>{copied ? 'Instructions copied' : 'Copy receiving instructions'}</button>}
      {selected.handoff.delivery === 'uncertain' && <p role="status">Receipt is unconfirmed. Inspect the receiving terminal and its tool result before continuing. A delivery attempt cannot be blindly repeated.</p>}

      {selected.handoff.state !== 'superseded' && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void operate(async () => {
        await window.donwells.projectHandoffSupersede(workspacePath, selected.handoff.id, selected.handoff.revision)
        setSelected(await window.donwells.projectHandoffGet(workspacePath, selected.handoff.id))
      })}>Supersede handoff</button>}
    </section>}
    <details open={hasDraft}><summary>Write a handoff</summary>
    {!sources.length && !source && <><p>Start an agent in this checkout to create a handoff from its session.</p><button type="button" className="btn btn-secondary btn-sm" onClick={() => { const state = useAppStore.getState(); state.setActiveWorktree(workspacePath); state.openRuns('agents'); useAppStore.setState({ agentComposerOpen: true }) }}>New agent</button></>}
    <form hidden={!sources.length && !source && !hasDraft} aria-label="Save agent handoff" onSubmit={event => { event.preventDefault(); void operate(async () => {
      const handoff = await window.donwells.projectHandoffCreate(workspacePath, { taskId: null, fromSessionId: source, toAgent: null, goal, summary, openQuestions: lines(questions), nextSteps: lines(steps), evidenceIds: [], reviewSelections: selectedReviews.map(note => ({ id: note.id, revision: note.revision, filePath: note.target.filePath, comparison: note.target.comparison })), memorySources: reviewedMemory.map(({ id, revision }) => ({ id, revision })) })
      handoffDrafts.delete(workspacePath)
      setGoal(''); setSummary(''); setQuestions(''); setSteps(''); setReviewedMemory([]); setSelectedReviews([])
      setSelected(await window.donwells.projectHandoffGet(workspacePath, handoff.id))
    }) }}>
      <fieldset disabled={busy}>
        <label>Source session<select aria-label="Source session" className="input" required value={source} onChange={event => setSource(event.target.value)}>
          <option value="">Choose a session in this checkout</option>
          {sources.map(agent => <option value={agent.sessionId} key={agent.sessionId}>{agent.label} · {agent.sessionId.slice(0, 8)}</option>)}
        </select></label>
        {!sources.length && <p>Start an agent in this checkout before saving a handoff.</p>}
        <label>Goal<input className="input" required maxLength={8000} value={goal} onChange={event => setGoal(event.target.value)} /></label>
        <label>Progress summary<textarea className="input" required maxLength={24000} value={summary} onChange={event => setSummary(event.target.value)} /></label>
        <details><summary>Questions and next steps</summary>
        <label>Open questions · one per line<textarea className="input" maxLength={16000} value={questions} onChange={event => setQuestions(event.target.value)} /></label>
        <label>Next steps · one per line<textarea className="input" maxLength={16000} value={steps} onChange={event => setSteps(event.target.value)} /></label>
        </details>
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
        <details><summary>Attach reviewed diff selections · {selectedReviews.length} / 10</summary>
          <p>Choose a file and load its saved review notes. Selected lines and their source hashes are captured with this handoff.</p>
          <label>Diff file<input className="input" value={reviewPath} onChange={event => setReviewPath(event.target.value)} placeholder="src/example.ts" /></label>
          <label>Diff comparison<select className="input" aria-label="Diff comparison" value={comparison} onChange={event => setComparison(event.target.value as typeof comparison)}>
            <option value="working">Working tree vs HEAD</option><option value="staged">Staged vs HEAD</option><option value="unstaged">Working tree vs staged</option>
          </select></label>
          <button type="button" className="btn btn-secondary btn-sm" disabled={!reviewPath.trim()} onClick={() => void operate(async () => { setReviewResults((await window.donwells.diffReviewList({ workspacePath, filePath: reviewPath.trim(), comparison })).notes) })}>Load diff reviews</button>
          {reviewResults.map(note => <details key={note.id}><summary>{note.target.filePath} · {note.anchor.side} lines {note.anchor.startLine}–{note.anchor.endLine} · revision {note.revision}</summary>
            <p>{note.body}</p><pre>{note.anchor.context.map(line => `${line.lineNumber}: ${line.text}`).join('\n')}</pre>
            <button type="button" className="btn btn-secondary btn-sm" disabled={selectedReviews.length >= 10 && !selectedReviews.some(value => value.id === note.id)} onClick={() => setSelectedReviews(current => [...current.filter(value => value.id !== note.id), note])}>Attach selected diff</button>
          </details>)}
          {selectedReviews.map(note => <p key={note.id}>{note.target.filePath} · lines {note.anchor.startLine}–{note.anchor.endLine} · review revision {note.revision} <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSelectedReviews(current => current.filter(value => value.id !== note.id))}>Remove diff selection</button></p>)}
        </details>
        <button className="btn btn-primary btn-sm" disabled={!source || !goal.trim() || !summary.trim()}>Save handoff for review</button>
      </fieldset>
    </form>
    </details>
  </details>
}
