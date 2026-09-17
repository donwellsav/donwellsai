import { agentProviderName } from '@shared/agent-presentation'
import { useAppStore } from '../store'
import { pathBasename } from '../workspace-navigation'
import { Icon } from './Icon'
import { ModalDialog } from './ModalDialog'

/** A live PTY is never closed by an ambiguous tab click without confirmation. */
export function TerminalCloseDialog() {
  const request = useAppStore((state) => state.closeRequest)
  const cancel = useAppStore((state) => state.cancelClosePane)
  const confirm = useAppStore((state) => state.confirmClosePane)
  const agent = useAppStore((state) => request ? state.runningAgents[request.sessionId] : undefined)

  if (!request) return null
  const workspaceName = pathBasename(request.worktreePath)
  const exited = agent?.liveness === 'exited'
  const stopPending = !!agent && !exited && (agent.activity === 'stopping' || agent.liveness !== 'live')

  return (
    <ModalDialog className="modal terminal-close-modal" labelledBy="close-terminal-title" onClose={cancel}>
      <h3 id="close-terminal-title" className="modal-title">Stop “{request.label}”?</h3>
      <div className="terminal-close-warning">
        <Icon name="alert" size={15} />
        <div>
          <strong>{agent ? exited ? 'This agent has exited.' : 'Stop this agent before closing its tab.' : 'This terminal session is still live.'}</strong>
          <p>{agent ? exited ? 'Closing releases its retained terminal output.' : 'Stopping ends the agent process. Its output remains available until you close the tab.' : 'Stopping terminates the shell and any command running inside it. Hiding the view keeps them running.'}</p>
        </div>
      </div>
      <dl className="terminal-close-details">
        <div><dt>Workspace</dt><dd title={request.worktreePath}>{workspaceName}</dd></div>
        <div><dt>Session</dt><dd>{request.sessionId.slice(0, 12)}</dd></div>
        {agent && <div><dt>Agent</dt><dd>{agentProviderName(agent)} · {agent.activity}</dd></div>}
      </dl>
      <div className="modal-actions">
        <button className="btn" onClick={cancel}>Keep terminal</button>
        <button className="btn btn-danger" disabled={stopPending} onClick={() => void confirm()}>{agent ? exited ? 'Close agent tab' : agent.activity === 'stopping' ? 'Stopping…' : 'Stop agent' : 'Stop terminal'}</button>
      </div>
    </ModalDialog>
  )
}
