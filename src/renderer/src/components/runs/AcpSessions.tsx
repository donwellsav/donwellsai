import { useEffect, useRef, useState } from 'react'
import type { AcpAgentSnapshot, AcpObservation } from '@shared/agent-runtime'
import { acpOutput } from '../../acp-output'
import { switchAgentMode } from '../../agent-mode-switch'
import { useAppStore } from '../../store'

// Keep authored drafts across panel moves; protocol history remains daemon-owned.
const drafts = new Map<string, string>()
const selections = new Map<string, string>()

export function AcpSessions({ workspacePath }: { workspacePath: string }) {
  const [sessions, setSessions] = useState<AcpAgentSnapshot[]>([])
  const [selected, setSelected] = useState(selections.get(workspacePath) ?? '')
  const [observation, setObservation] = useState<AcpObservation | null>(null)
  const [draft, setDraft] = useState(drafts.get(workspacePath) ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [uncertain, setUncertain] = useState(false)
  const live = useRef(true)
  const startRequest = useRef(crypto.randomUUID())
  useEffect(() => {
    live.current = true
    let stopped = false, sequence = 0, timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const list = await window.donwells.agentAcpList(workspacePath)
        if (stopped) return
        setSessions(list)
        if (selected && list.some(session => session.id === selected)) {
          const next = await window.donwells.agentAcpObserve(workspacePath, selected, sequence)
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
  }, [workspacePath, selected])
  const start = async (loadRunId?: string) => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const session = await window.donwells.agentAcpStart(workspacePath, startRequest.current, loadRunId)
      startRequest.current = crypto.randomUUID()
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
    try {
      const request = await window.donwells.agentAcpPrompt(workspacePath, selected, crypto.randomUUID(), text)
      if (live.current && request.state !== 'uncertain') { drafts.delete(workspacePath); setDraft('') }
      if (live.current && request.state === 'uncertain') { setUncertain(true); setError('Delivery is uncertain. Inspect the session and resulting files before sending again; your draft is retained.') }
    } catch (cause) { if (live.current) { setUncertain(true); setError(`Delivery may be uncertain; inspect the request status before sending again. ${String(cause)}`) } }
    finally { if (live.current) setBusy(false) }
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
  return <section className="acp-sessions" aria-label="ACP sessions">
    <h3>OpenCode · ACP</h3>
    <p>Optional structured session using your OpenCode provider settings and this project’s tools. Native agents keep their terminals.</p>
    <button className="btn btn-secondary" disabled={busy} onClick={() => void start()}>Start ACP session</button>
    <label className="modal-field">ACP session<select className="input" value={selected} disabled={busy} onChange={event => { setObservation(null); selections.set(workspacePath, event.target.value); setSelected(event.target.value) }}>
      <option value="">Select a session</option>
      {sessions.map(session => <option key={session.id} value={session.id}>{session.protocolSessionId ?? session.id} · {session.state}</option>)}
    </select></label>
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
        <label className="modal-field">ACP message<textarea className="input" value={draft} maxLength={64000} disabled={busy} onChange={event => { drafts.set(workspacePath, event.target.value); setDraft(event.target.value) }} /></label>
        <button className="btn btn-primary" disabled={busy || uncertain || !draft.trim() || snapshot.state !== 'ready'}>Send to ACP</button>
      </form>
      {uncertain && <button className="btn btn-secondary" onClick={() => { setUncertain(false); setError('') }}>I inspected the outcome; allow a new request</button>}
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
