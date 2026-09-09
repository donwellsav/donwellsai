import { guiDraftMap } from '../../gui-drafts'
import { useEffect, useRef, useState } from 'react'
import type { AcpAgentSnapshot, AcpObservation } from '@shared/agent-runtime'
import { acpOutput } from '../../acp-output'
import { switchAgentMode } from '../../agent-mode-switch'
import { useAppStore } from '../../store'

// Keep authored drafts across panel moves; protocol history remains daemon-owned.
const drafts = guiDraftMap<string>('acp-messages')
const selections = guiDraftMap<string>('acp-selections')
const requests = guiDraftMap<{ id: string; state: 'pending' | 'uncertain'; text: string }>('acp-requests')
const inFlight = new Set<string>()
const starts = guiDraftMap<string>('acp-starts')

export function AcpSessions({ workspacePath }: { workspacePath: string }) {
  const [sessions, setSessions] = useState<AcpAgentSnapshot[]>([])
  const [selected, setSelected] = useState(selections.get(workspacePath) ?? '')
  const [observation, setObservation] = useState<AcpObservation | null>(null)
  const draftKey = `${workspacePath}\0${selected}`
  const retainedRequest = requests.get(draftKey)
  if (retainedRequest?.state === 'pending' && !inFlight.has(retainedRequest.id)) requests.set(draftKey, { ...retainedRequest, state: 'uncertain' })
  const [draft, setDraft] = useState(drafts.get(draftKey) ?? '')
  const [busy, setBusy] = useState(requests.get(draftKey)?.state === 'pending')
  const [error, setError] = useState('')
  const [uncertain, setUncertain] = useState(requests.get(draftKey)?.state === 'uncertain')
  const live = useRef(true)
  const promptPending = useRef(requests.get(draftKey)?.state === 'pending')
  const activeKey = useRef(draftKey); activeKey.current = draftKey
  const startRequest = useRef(starts.get(workspacePath) ?? crypto.randomUUID())
  starts.set(workspacePath, startRequest.current)
  useEffect(() => {
    live.current = true
    setDraft(drafts.get(draftKey) ?? '')
    setUncertain(requests.get(draftKey)?.state === 'uncertain')
    let stopped = false, sequence = 0, timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const list = await window.donwells.agentAcpList(workspacePath)
        if (stopped) return
        setSessions(list)
        if (!selected && list.length === 1 && !drafts.get(draftKey) && !requests.has(draftKey)) {
          selections.set(workspacePath, list[0]!.id); setSelected(list[0]!.id)
          return
        }
        if (promptPending.current) {
          promptPending.current = requests.get(draftKey)?.state === 'pending'
          setBusy(promptPending.current)
        }
        setUncertain(requests.get(draftKey)?.state === 'uncertain')
        setDraft(drafts.get(draftKey) ?? '')
        if (selected && list.some(session => session.id === selected)) {
          const next = await window.donwells.agentAcpObserve(workspacePath, selected, sequence)
          if (stopped) return
          const retained = requests.get(draftKey)
          const outcome = retained && next.requests.find(request => request.requestId === retained.id)
          if (outcome?.state === 'completed' || outcome?.state === 'accepted') {
            requests.delete(draftKey)
            if (drafts.get(draftKey) === retained?.text) drafts.delete(draftKey)
            promptPending.current = false
            setBusy(false); setUncertain(false); setDraft(drafts.get(draftKey) ?? ''); setError('')
          }
          sequence = next.sequence
          if (!stopped) setObservation(previous => {
            const updates = [...(previous?.snapshot.id === next.snapshot.id ? previous.updates : []), ...next.updates]
            let bytes = 0, start = updates.length
            while (start > 0 && updates.length - start < 2048) {
              const size = JSON.stringify(updates[start - 1]).length * 2
              if (bytes + size > 2 * 1024 * 1024) break
              bytes += size; start--
            }
            return { ...next, updates: updates.slice(start), truncated: next.truncated || !!previous?.truncated || start > 0 }
          })
        } else setObservation(null)
      } catch (cause) { if (!stopped) setError(String(cause)) }
      finally { if (!stopped) timer = setTimeout(() => void refresh(), 1200) }
    }
    void refresh()
    return () => { stopped = true; live.current = false; clearTimeout(timer) }
  }, [workspacePath, selected, draftKey])
  const start = async (loadRunId?: string) => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const session = await window.donwells.agentAcpStart(workspacePath, startRequest.current, loadRunId)
      startRequest.current = crypto.randomUUID()
      starts.set(workspacePath, startRequest.current)
      if (live.current) { setSessions(list => [...list.filter(item => item.id !== session.id), session]); selections.set(workspacePath, session.id); setSelected(session.id) }
    } catch (cause) { if (live.current) setError(String(cause)) }
    finally { if (live.current) setBusy(false) }
  }
  const control = async (operation: 'cancel' | 'stop' | 'permission' | 'dismiss', permissionId?: string, optionId?: string) => {
    setError('')
    try { await window.donwells.agentAcpControl(workspacePath, selected, operation, permissionId, optionId) }
    catch (cause) { if (live.current) setError(String(cause)) }
  }
  const send = async () => {
    if (busy || uncertain || !draft.trim() || observation?.snapshot.state !== 'ready') return
    setBusy(true); setError('')
    const text = draft
    const requestId = crypto.randomUUID()
    promptPending.current = true
    inFlight.add(requestId)
    requests.set(draftKey, { id: requestId, state: 'pending', text })
    try {
      const request = await window.donwells.agentAcpPrompt(workspacePath, selected, requestId, text)
      if (requests.get(draftKey)?.id !== requestId) return
      if (request.state === 'uncertain') {
        requests.set(draftKey, { id: requestId, state: 'uncertain', text })
        if (live.current && activeKey.current === draftKey) { setUncertain(true); setError('Delivery is uncertain. Inspect the session before sending again; your draft is retained.') }
      } else {
        requests.delete(draftKey)
        if (drafts.get(draftKey) === text) drafts.delete(draftKey)
        if (live.current && activeKey.current === draftKey) setDraft(drafts.get(draftKey) ?? '')
      }
    } catch (cause) {
      if (requests.get(draftKey)?.id !== requestId) return
      requests.set(draftKey, { id: requestId, state: 'uncertain', text })
      if (live.current && activeKey.current === draftKey) { setUncertain(true); setError(`Delivery may be uncertain. ${String(cause)}`) }
    } finally { inFlight.delete(requestId); if (live.current && activeKey.current === draftKey) setBusy(false) }
  }

  const snapshot = observation?.snapshot
  const finished = snapshot?.state === 'exited' || snapshot?.state === 'uncertain'
  const openNative = async () => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const result = await switchAgentMode(workspacePath, selected, 'native')
      if (live.current && result.native) await useAppStore.getState().focusAgentSession(result.native.run.sessionId)
    } catch (cause) { if (live.current) setError(String(cause)) }
    finally { if (live.current) setBusy(false) }
  }
  return <section className="acp-sessions" aria-label="OpenCode chat">
    <h3>OpenCode chat</h3>
    <p>Chat here using your OpenCode settings and this project’s tools.</p>
    <button className="btn btn-secondary" disabled={busy} onClick={() => void start()}>New chat</button>
    {sessions.length > 1 && <label className="modal-field">Conversation<select className="input" value={selected} disabled={busy} onChange={event => { setObservation(null); selections.set(workspacePath, event.target.value); setSelected(event.target.value) }}>
      <option value="">Select a session</option>
      {sessions.map(session => <option key={session.id} value={session.id}>{session.protocolSessionId ?? session.id} · {session.state}</option>)}
    </select></label>}
    {snapshot && <>
      <p role="status">{snapshot.state}{snapshot.detail ? ` · ${snapshot.detail}` : ''}</p>
      {observation.truncated && <p>Earlier output is outside the retained replay window.</p>}
      <div className="acp-output" aria-label="ACP output">
        {acpOutput(observation.updates).map((row, index) => <p key={row.kind === 'tool' ? row.id : index}>{row.kind === 'text' ? row.text : `${row.title} · ${row.status}`}</p>)}
      </div>
      {snapshot.permissions.map(permission => <fieldset key={permission.id}><legend>{permission.request.toolCall.title ?? 'Agent operation'}</legend>
        {permission.request.toolCall.rawInput !== undefined && <pre style={{ maxHeight: 180, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(permission.request.toolCall.rawInput, null, 2)}</pre>}
        {permission.request.toolCall.locations?.map((location, index) => <p key={index}>{location.path}{location.line ? `:${location.line}` : ''}</p>)}
        {permission.request.options.map(option => <button className="btn btn-secondary" key={option.optionId} onClick={() => void control('permission', permission.id, option.optionId)}>{option.name}</button>)}
      </fieldset>)}
      {observation.requests.slice(-5).map(request => <p key={request.requestId}>Request {request.requestId.slice(0, 8)} · {request.state}{request.result ? ` · ${request.result.stopReason}` : ''}{request.error ? ` · ${request.error}` : ''}</p>)}
      <form onSubmit={event => { event.preventDefault(); void send() }}>
        <label className="modal-field">Message<textarea className="input" value={draft} maxLength={64000} disabled={busy} onChange={event => { drafts.set(draftKey, event.target.value); setDraft(event.target.value) }} /></label>
        <button className="btn btn-primary" disabled={busy || uncertain || !draft.trim() || snapshot.state !== 'ready'}>Send to ACP</button>
      </form>
      {uncertain && <button className="btn btn-secondary" onClick={() => { requests.delete(draftKey); setUncertain(false); setError('') }}>I inspected the outcome; allow a new request</button>}
      <div className="agent-launcher-actions">
        <button className="btn btn-secondary" disabled={!['working', 'permission'].includes(snapshot.state)} onClick={() => void control('cancel')}>Cancel turn</button>
        <button className="btn btn-secondary" disabled={finished || snapshot.state === 'stopping'} onClick={() => void control('stop')}>Stop ACP</button>
        <button className="btn btn-secondary" disabled={busy || !snapshot.protocolSessionId || !['ready', 'exited'].includes(snapshot.state)} onClick={() => void openNative()}>Continue in native terminal</button>
        {finished && <button className="btn btn-secondary" disabled={busy || !snapshot.capabilities?.loadSession || !snapshot.protocolSessionId} onClick={() => void start(snapshot.id)}>Load saved session</button>}
      </div>
    </>}
    {error && <p role="alert">{error}</p>}
  </section>
}
