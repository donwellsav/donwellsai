import { useEffect, useMemo, useState } from 'react'
import {
  agentPresentation,
  agentProviderName,
  type AgentPresentation
} from '@shared/agent-presentation'
import type { RunningAgent } from '@shared/types'
import { pinnedWorktree } from '../../commands'
import { useAppStore } from '../../store'
import { Icon } from '../Icon'
import { ModalDialog } from '../ModalDialog'
import { formatRunTime } from './RunStatus'

type PresentedAgent = { run: RunningAgent; presentation: AgentPresentation; provider: string }
type AgentConfirmation = { kind: 'stop' | 'dismiss'; run: RunningAgent }

function workspaceName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || path
}

export function AgentsSection() {
  const runningAgents = useAppStore((state) => state.runningAgents)
  const presets = useAppStore((state) => state.agents)
  const repos = useAppStore((state) => state.repos)
  const activeRepoId = useAppStore((state) => state.activeRepoId)
  const activeWorktreePath = useAppStore((state) => state.activeWorktreePath)
  const defaultCommand = useAppStore((state) => state.settings.agentCommand)
  const focusAgentSession = useAppStore((state) => state.focusAgentSession)
  const runAgent = useAppStore((state) => state.runAgent)
  const stopAgent = useAppStore((state) => state.stopAgent)
  const dismissAgent = useAppStore((state) => state.dismissAgent)
  const [command, setCommand] = useState(defaultCommand)
  const [commandTouched, setCommandTouched] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [launchError, setLaunchError] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [operation, setOperation] = useState<string | null>(null)
  const [sessionErrors, setSessionErrors] = useState<Record<string, string>>({})
  const [confirmation, setConfirmation] = useState<AgentConfirmation | null>(null)
  const [confirmationError, setConfirmationError] = useState<string | null>(null)

  const targetPath = useMemo(
    () => pinnedWorktree(useAppStore.getState()),
    [activeRepoId, activeWorktreePath, repos]
  )
  const availablePresets = useMemo(
    () => presets.filter((preset) => preset.available).sort((left, right) => left.name.localeCompare(right.name)),
    [presets]
  )
  const unavailablePresets = useMemo(() => presets.filter((preset) => !preset.available), [presets])
  const selectedPreset = availablePresets.find((preset) => preset.command === command.trim())

  useEffect(() => {
    if (!commandTouched) setCommand(defaultCommand)
  }, [commandTouched, defaultCommand])

  const agents = useMemo<PresentedAgent[]>(() => Object.values(runningAgents)
    .map((run) => ({ run, presentation: agentPresentation(run), provider: agentProviderName(run) }))
    .sort((left, right) => {
      const leftRank = left.presentation.needsAttention ? 0 : left.presentation.inProgress ? 1 : 2
      const rightRank = right.presentation.needsAttention ? 0 : right.presentation.inProgress ? 1 : 2
      return leftRank - rightRank || right.run.updatedAt.localeCompare(left.run.updatedAt)
    }), [runningAgents])


  const attentionCount = agents.filter((agent) => agent.presentation.needsAttention).length
  const activeCount = agents.filter((agent) => agent.presentation.inProgress).length

  const setSessionError = (sessionId: string, error: string | null): void => {
    setSessionErrors((current) => {
      if (error) return { ...current, [sessionId]: error }
      if (!(sessionId in current)) return current
      const next = { ...current }
      delete next[sessionId]
      return next
    })
  }

  const launch = async (): Promise<void> => {
    const trimmed = command.trim()
    if (!targetPath || !trimmed || launching) return
    setLaunching(true)
    setLaunchError(null)
    try {
      const result = await runAgent(targetPath, trimmed)
      if (!result.ok) {
        setLaunchError(result.error)
        return
      }
    } finally {
      setLaunching(false)
    }
  }

  const openTerminal = async (run: RunningAgent): Promise<void> => {
    if (opening) return
    setOpening(run.sessionId)
    setSessionError(run.sessionId, null)
    try {
      const focused = await focusAgentSession(run.sessionId)
      if (!focused) setSessionError(run.sessionId, 'The retained terminal is no longer available in this workspace.')
    } catch (error) {
      setSessionError(run.sessionId, error instanceof Error ? error.message : String(error))
    } finally {
      setOpening(null)
    }
  }

  const retry = async (run: RunningAgent): Promise<void> => {
    const key = `retry:${run.sessionId}`
    if (operation) return
    setOperation(key)
    setSessionError(run.sessionId, null)
    try {
      const result = await runAgent(run.workspacePath, run.command)
      if (!result.ok) {
        setSessionError(run.sessionId, result.error)
        return
      }
    } finally {
      setOperation(null)
    }
  }

  const confirmAgentAction = async (): Promise<void> => {
    if (!confirmation || operation) return
    const { kind, run } = confirmation
    const key = `${kind}:${run.sessionId}`
    setOperation(key)
    setConfirmationError(null)
    setSessionError(run.sessionId, null)
    try {
      const result = kind === 'stop' ? await stopAgent(run.sessionId) : await dismissAgent(run.sessionId)
      if (!result.ok) {
        setConfirmationError(result.error)
        return
      }
      setConfirmation(null)
    } finally {
      setOperation(null)
    }
  }

  return (
    <div className="op-section agents-section">
      <form className="agent-launcher" aria-labelledby="agent-launcher-title" onSubmit={(event) => {
        event.preventDefault()
        void launch()
      }}>
        <div className="agent-launcher-heading">
          <div>
            <span className="op-eyebrow">New agent session</span>
            <h3 id="agent-launcher-title">Start an agent</h3>
            <p>Choose an installed harness, verify the exact project, then start it in a real retained terminal.</p>
          </div>
          <span className="agent-harness-count">{availablePresets.length} available</span>
        </div>

        <div className={`agent-launch-target${targetPath ? '' : ' is-missing'}`}>
          <span>Working project</span>
          {targetPath ? (
            <div><strong>{workspaceName(targetPath)}</strong><code title={targetPath}>{targetPath}</code></div>
          ) : (
            <div><strong>No project selected</strong><span>Select a registered project before starting an agent.</span></div>
          )}
        </div>

        {availablePresets.length > 0 ? (
          <div className="agent-harness-grid" role="radiogroup" aria-label="Available agent harnesses">
            {availablePresets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                role="radio"
                aria-checked={selectedPreset?.id === preset.id}
                className={selectedPreset?.id === preset.id ? 'is-selected' : ''}
                onClick={() => {
                  setCommand(preset.command)
                  setCommandTouched(true)
                  setLaunchError(null)
                }}
              >
                <span><strong>{preset.name}</strong><small>{preset.hookSupport.support === 'native' ? 'Live activity' : 'Process status'}</small></span>
                <code>{preset.command}</code>
              </button>
            ))}
          </div>
        ) : (
          <div className="agent-launcher-note" role="status">
            <strong>No registered harness was found on PATH.</strong>
            <span>You can still enter an executable command or configure the default in Settings.</span>
          </div>
        )}

        {unavailablePresets.length > 0 && (
          <p className="agent-unavailable">Not installed: {unavailablePresets.map((preset) => preset.name).join(', ')}</p>
        )}

        <label className="agent-command-field" htmlFor="agent-launch-command">
          <span>Command</span>
          <input
            id="agent-launch-command"
            className="input"
            value={command}
            maxLength={4096}
            spellCheck={false}
            autoComplete="off"
            placeholder="Agent executable and arguments"
            onChange={(event) => {
              setCommand(event.currentTarget.value)
              setCommandTouched(true)
              setLaunchError(null)
            }}
          />
        </label>

        {launchError && <p className="op-inline-error" role="alert"><strong>Agent did not start.</strong><span>{launchError}</span></p>}
        <div className="agent-launcher-actions">
          <button type="button" className="btn btn-secondary" onClick={() => useAppStore.getState().openSettings('agents')}>Agent settings</button>
          <button type="submit" className="btn btn-primary" disabled={!targetPath || !command.trim() || launching}>
            <Icon name="robot" size={14} />
            {launching ? 'Starting agent…' : 'Start agent & open terminal'}
          </button>
        </div>
      </form>

      <div className="op-section-heading agent-supervision-heading">
        <div>
          <span className="op-eyebrow">Daemon-observed sessions</span>
          <h3>Supervise agents</h3>
          <p>Open retained output, retry exited work, or stop and dismiss sessions with explicit confirmation.</p>
        </div>
        <div className="agent-totals" aria-label="Agent status totals">
          <span><strong>{activeCount}</strong> in progress</span>
          <span className={attentionCount > 0 ? 'attention' : ''}><strong>{attentionCount}</strong> need attention</span>
        </div>
      </div>

      <div className="agent-list" aria-live="polite">
        {agents.map(({ run, presentation, provider }) => {
          const openingThis = opening === run.sessionId
          const retrying = operation === `retry:${run.sessionId}`
          const stopping = operation === `stop:${run.sessionId}` || run.activity === 'stopping'
          const canStop = run.liveness !== 'exited'
          const canDismiss = run.liveness === 'exited'
          return (
            <article key={run.id} className={`agent-card agent-card-${presentation.tone}`}>
              <div className="agent-card-head">
                <div className="agent-identity">
                  <span className={`agent-state-mark agent-state-mark-${presentation.tone}`} aria-hidden="true" />
                  <span>
                    <strong>{provider}</strong>
                    <small title={run.workspacePath}>{workspaceName(run.workspacePath)}</small>
                  </span>
                </div>
                <span className={`agent-status agent-status-${presentation.tone}`}>{presentation.label}</span>
                <div className="agent-card-actions">
                  <button type="button" className="btn btn-secondary btn-sm" disabled={openingThis || operation !== null} onClick={() => void openTerminal(run)}>
                    <Icon name="terminal" size={13} />
                    {openingThis ? 'Opening…' : run.liveness === 'exited' ? 'Open output' : 'Resume terminal'}
                  </button>
                  {canDismiss && (
                    <button type="button" className="btn btn-secondary btn-sm" disabled={operation !== null} onClick={() => void retry(run)}>
                      {retrying ? 'Starting…' : presentation.status === 'failed' ? 'Retry' : 'Run again'}
                    </button>
                  )}
                  {canStop && (
                    <button type="button" className="btn btn-danger btn-sm" disabled={operation !== null || run.activity === 'stopping'} onClick={() => {
                      setConfirmationError(null)
                      setConfirmation({ kind: 'stop', run })
                    }}>{stopping ? 'Stopping…' : run.liveness === 'unverifiable' ? 'Try to stop…' : 'Stop…'}</button>
                  )}
                  {canDismiss && (
                    <button type="button" className="btn btn-danger btn-sm" disabled={operation !== null} onClick={() => {
                      setConfirmationError(null)
                      setConfirmation({ kind: 'dismiss', run })
                    }}>Dismiss…</button>
                  )}
                </div>
              </div>

              <dl className="agent-facts">
                <div><dt>Workspace</dt><dd title={run.workspacePath}>{run.workspacePath}</dd></div>
                <div><dt>Harness</dt><dd><strong>{provider}</strong><code title={run.command}>{run.command}</code></dd></div>
                <div><dt>Activity</dt><dd><strong>{run.activity}</strong><span>{presentation.description}</span></dd></div>
                <div><dt>Liveness</dt><dd><strong>{run.liveness}</strong><span>{run.hook.connected ? 'Activity hook connected' : run.hook.support === 'native' ? 'Hook not connected' : 'Process observation only'}</span></dd></div>
              </dl>

              <div className="agent-card-foot">
                <span>Started {formatRunTime(run.startedAt)}</span>
                <span>Updated {formatRunTime(run.updatedAt)}</span>
                {run.exitCode !== undefined && <span>Exit code {run.exitCode}</span>}
              </div>
              {sessionErrors[run.sessionId] && <p className="agent-row-error" role="alert">{sessionErrors[run.sessionId]}</p>}
            </article>
          )
        })}
        {agents.length === 0 && (
          <div className="op-empty agent-empty">
            <Icon name="robot" size={20} />
            <strong>No retained sessions</strong>
            <span>Use Start agent above. New sessions appear here with daemon-backed liveness and activity.</span>
          </div>
        )}
      </div>

      {confirmation && (
        <ModalDialog className="modal op-confirm agent-confirm" labelledBy="agent-confirm-title" onClose={() => {
          if (!operation) setConfirmation(null)
        }}>
          <span className="op-eyebrow">Confirm agent operation</span>
          <h3 id="agent-confirm-title" className="modal-title">
            {confirmation.kind === 'stop' ? `Stop ${agentProviderName(confirmation.run)}?` : `Dismiss ${agentProviderName(confirmation.run)} history?`}
          </h3>
          <p>
            {confirmation.kind === 'stop'
              ? confirmation.run.liveness === 'unverifiable'
                ? 'The daemon cannot currently prove whether this process is live. A stop will be attempted, but the session remains Unverifiable unless the daemon acknowledges the result.'
                : 'The daemon will interrupt this exact session. It is only shown as stopped after the request is acknowledged.'
              : 'This removes the exited session, retained terminal output, and agent history. The working project is not changed.'}
          </p>
          <dl className="agent-confirm-facts">
            <div><dt>Project</dt><dd>{confirmation.run.workspacePath}</dd></div>
            <div><dt>Command</dt><dd>{confirmation.run.command}</dd></div>
          </dl>
          {confirmationError && <p className="op-inline-error" role="alert"><strong>Operation did not complete.</strong><span>{confirmationError}</span></p>}
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" disabled={operation !== null} onClick={() => setConfirmation(null)}>Keep session</button>
            <button type="button" className="btn btn-danger" disabled={operation !== null} onClick={() => void confirmAgentAction()}>
              {operation ? confirmation.kind === 'stop' ? 'Stopping…' : 'Dismissing…' : confirmation.kind === 'stop' ? 'Stop agent' : 'Dismiss history'}
            </button>
          </div>
        </ModalDialog>
      )}
    </div>
  )
}
