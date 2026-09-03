import { useEffect, useState } from 'react'
import { useAppStore } from '../store'
import { Icon } from './Icon'

/**
 * Agent run bar (Orca's composer strip): type a command, Enter/Run launches it
 * into the worktree's terminal; a running agent shows a chip with Stop.
 */
export function AgentRunBar({ worktreePath }: { worktreePath: string }) {
  const agentCommand = useAppStore((s) => s.settings.agentCommand)
  const runningAgents = useAppStore((s) => s.runningAgents)
  const runAgent = useAppStore((s) => s.runAgent)
  const stopAgent = useAppStore((s) => s.stopAgent)
  const [value, setValue] = useState(agentCommand)

  // follow settings changes until the user edits the field
  const [dirty, setDirty] = useState(false)
  useEffect(() => {
    if (!dirty) setValue(agentCommand)
  }, [agentCommand, dirty])

  const agentForPath = Object.values(runningAgents).find((a) => a.worktreePath === worktreePath)

  return (
    <div className="agent-run-bar">
      {agentForPath ? (
        <div className={`agent-chip agent-state-${agentForPath.state}`}>
          {agentForPath.state === 'working' && <span className="spinner" />}
          {agentForPath.state === 'permission' && <span className="state-icon state-permission" title="Permission requested" />}
          {agentForPath.state === 'done' && <span className="state-icon state-done" title="Completed" />}
          {agentForPath.state === 'note' && <span className="state-icon state-note" title="Info" />}
          <span className="agent-cmd">{agentForPath.agent}</span>
          <button className="btn btn-secondary btn-sm" onClick={() => stopAgent(agentForPath.sessionId)}>
            {agentForPath.state === 'done' ? 'Dismiss' : 'Stop'}
          </button>
        </div>
      ) : (
        <>
          <input
            className="input agent-input"
            value={value}
            placeholder={`Run agent in ${worktreePath.split('/').pop()}…`}
            onChange={(e) => {
              setValue(e.target.value)
              setDirty(true)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && value.trim()) {
                void runAgent(worktreePath, value)
              }
            }}
          />
          <button className="btn btn-primary btn-sm" disabled={!value.trim()} onClick={() => void runAgent(worktreePath, value)}>
            <Icon name="play" size={11} /> Run
          </button>
        </>
      )}
    </div>
  )
}
