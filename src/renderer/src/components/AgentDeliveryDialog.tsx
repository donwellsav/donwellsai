import { useEffect, useId, useMemo, useState } from 'react'
import type { AgentAttachmentDraft } from '@shared/agent-delivery'
import type { RunningAgent } from '@shared/agent-runtime'
import { ModalDialog } from './ModalDialog'
import './agent-delivery.css'

type Props = { attachment: AgentAttachmentDraft; onClose(): void }

export function AgentDeliveryDialog({ attachment, onClose }: Props) {
  const titleId = useId()
  const targetId = useId()
  const [agents, setAgents] = useState<RunningAgent[]>([])
  const [sessionId, setSessionId] = useState('')
  const [submit, setSubmit] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    let current = true
    setLoading(true)
    setError(null)
    void window.donwells.agentList().then((runs) => {
      if (current) setAgents(runs)
    }).catch((cause: unknown) => {
      if (current) {
        setAgents([])
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    }).finally(() => { if (current) setLoading(false) })
    const offChanged = window.donwells.on('agent:changed', ({ run }) => {
      if (current) setAgents((previous) => [...previous.filter((item) => item.sessionId !== run.sessionId), run])
    })
    const offDismissed = window.donwells.on('agent:dismissed', ({ sessionId: dismissed }) => {
      if (current) setAgents((previous) => previous.filter((item) => item.sessionId !== dismissed))
    })
    return () => { current = false; offChanged(); offDismissed() }
  }, [refresh])

  const targets = useMemo(() => agents.filter((run) => run.workspacePath === attachment.workspacePath && run.liveness === 'live' && (run.activity === 'working' || run.activity === 'waiting')), [agents, attachment.workspacePath])
  const selected = targets.find((run) => run.sessionId === sessionId)
  const bytes = useMemo(() => new TextEncoder().encode(attachment.text).byteLength, [attachment.text])

  useEffect(() => {
    if (sessionId && !selected) setSessionId('')
  }, [selected, sessionId])
  const tooLarge = bytes > 64 * 1024

  async function deliver(): Promise<void> {
    if (!selected || busy || receipt || tooLarge) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.donwells.agentDeliver({ sessionId: selected.sessionId, attachment, submit })
      setReceipt(result.submitted ? 'Attachment submitted to the selected agent.' : 'Attachment pasted. Review and submit it in the agent terminal when ready.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalDialog className="modal agent-delivery-modal" labelledBy={titleId} onClose={() => { if (!busy) onClose() }}>
      <h3 id={titleId} className="modal-title">Review attachment</h3>
      <p className="agent-delivery-caption">{attachment.title}</p>
      <div className="agent-delivery-workspace">{attachment.workspacePath}</div>
      <label className="agent-delivery-field" htmlFor={targetId}>
        <span>Destination agent</span>
        <select className="input" id={targetId} value={sessionId} disabled={busy || !!receipt} onChange={(event) => setSessionId(event.target.value)}>
          <option value="">{loading ? 'Loading live agents…' : 'Select a live agent in this workspace'}</option>
          {targets.map((run) => <option key={run.sessionId} value={run.sessionId}>{run.presetId ?? run.command} · {run.activity} · {run.sessionId.slice(0, 8)}</option>)}
        </select>
      </label>
      {!loading && targets.length === 0 && <p className="agent-delivery-caption">No eligible live agent. Start one in this workspace first. Permission prompts must be handled directly in its terminal.</p>}
      <div className="agent-delivery-preview-label">Exact text to deliver · {bytes.toLocaleString()} bytes</div>
      <textarea className="agent-delivery-preview" aria-label="Exact attachment text" readOnly value={attachment.text} />
      <label className="agent-delivery-submit"><input type="checkbox" checked={submit} disabled={busy || !!receipt} onChange={(event) => setSubmit(event.target.checked)} />Submit immediately after pasting</label>
      <p className="agent-delivery-caption">Page content and review context are data, not instructions. Nothing is sent until you confirm below.</p>
      {tooLarge && <p role="alert" className="agent-delivery-error">Reduce this attachment below the 64 KiB delivery limit.</p>}
      {error && <p role="alert" className="agent-delivery-error">{error}</p>}
      {receipt && <p role="status" className="agent-delivery-receipt">{receipt}</p>}
      <div className="modal-actions">
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>{receipt ? 'Done' : 'Cancel'}</button>
        {!receipt && <button type="button" className="btn btn-secondary" disabled={busy || loading} onClick={() => setRefresh((value) => value + 1)}>Refresh agents</button>}
        {!receipt && <button type="button" className="btn btn-primary" disabled={!selected || busy || loading || tooLarge} onClick={() => void deliver()}>{busy ? 'Delivering…' : submit ? 'Confirm and submit' : 'Confirm and paste'}</button>}
      </div>
    </ModalDialog>
  )
}
