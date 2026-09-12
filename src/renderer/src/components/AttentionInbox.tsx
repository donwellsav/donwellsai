import { Icon } from './Icon'
import { ModalDialog } from './ModalDialog'
import { useAppStore } from '../store'
import {
  closeAttentionInbox,
  revealAttentionEntry,
  useAttentionInboxState,
  type AttentionInboxRendererState
} from '../attention-inbox'
import type { AttentionInboxEntry } from '@shared/attention-inbox'

const KIND_LABEL: Record<AttentionInboxEntry['kind'], string> = {
  permission: 'Needs permission',
  waiting: 'Waiting for input',
  failed: 'Failed',
  completed: 'Completed',
  contact: 'Follow-up'
}

function orderEntries(state: AttentionInboxRendererState): AttentionInboxEntry[] {
  const entries = state.snapshot?.entries ?? []
  return [...entries].sort((a, b) => {
    const aUnread = a.acknowledgedAt === undefined ? 0 : 1
    const bUnread = b.acknowledgedAt === undefined ? 0 : 1
    if (aUnread !== bUnread) return aUnread - bUnread
    return b.occurredAt.localeCompare(a.occurredAt)
  })
}

/**
 * Daemon-backed attention inbox: agents that need permission, input, or a
 * look at a failure. Revealing focuses the exact retained terminal; the event
 * acknowledges only once that terminal owns visible focus (attention-inbox.ts).
 */
export function AttentionInbox() {
  const state = useAttentionInboxState()
  if (!state.overlayOpen) return null
  const entries = orderEntries(state)
  const unread = state.snapshot?.unreadCount ?? 0

  const reveal = (entry: AttentionInboxEntry): void => {
    void revealAttentionEntry(entry, sessionId => useAppStore.getState().focusAgentSession(sessionId))
      .then(focused => { if (!focused) useAppStore.getState().setError('The terminal for this event is no longer available. Open its agent session manually.') })
      .catch(error => useAppStore.getState().setError(String(error)))
  }

  return <ModalDialog labelledBy="attention-inbox-title" className="modal attention-inbox-modal" onClose={closeAttentionInbox}>
    <h2 id="attention-inbox-title" className="modal-title">Attention inbox</h2>
    <p className="attention-inbox-summary" role="status">
      {state.phase === 'loading' && !state.snapshot ? 'Loading…'
        : state.phase === 'unavailable' ? (state.error ?? 'Unavailable.')
        : state.phase === 'error' ? (state.error ?? 'The inbox could not be read.')
        : unread === 0 ? 'Nothing needs your attention.'
        : `${unread} event${unread === 1 ? '' : 's'} need attention.`}
    </p>
    {entries.length > 0 && <ul className="attention-inbox-list">
      {entries.map(entry => <li key={`${entry.id}:${entry.version}`} className={entry.acknowledgedAt === undefined ? 'unread' : 'read'}>
        <div className="attention-inbox-entry-head">
          <strong>{KIND_LABEL[entry.kind]}</strong>
          <span>{entry.providerId ?? 'agent'} · {new Date(entry.occurredAt).toLocaleString()}</span>
        </div>
        <code className="attention-inbox-command">{entry.command}</code>
        {entry.detail && <p>{entry.detail}</p>}
        <p className="attention-inbox-workspace">{entry.workspacePath}</p>
        {entry.acknowledgedAt === undefined && <div className="modal-footer">
          <button type="button" className="btn btn-secondary btn-sm" disabled={entry.terminalAvailability !== 'retained'} onClick={() => reveal(entry)}>
            <Icon name="monitor" size={13} /> {entry.terminalAvailability === 'retained' ? 'Go to terminal' : 'Terminal no longer retained'}
          </button>
        </div>}
      </li>)}
    </ul>}
    {state.snapshot && state.snapshot.retention.discardedAcknowledged > 0 && <p className="attention-inbox-retention">{state.snapshot.retention.discardedAcknowledged} acknowledged event(s) were trimmed from history. Unread events are never discarded.</p>}
  </ModalDialog>
}
