import { useEffect, useMemo, useState } from 'react'
import { logger } from '@shared/logger'
import { useAppStore } from '../store'

type AutonomousPhase = 'idle' | 'running' | 'finished' | 'error'

interface AutonomousRunState {
  iterations: number
  totalTokens: number | null
  durationMs: number
  stopped: boolean
}

interface AutonomousRunResult {
  success: boolean
  finalResult: string
  iterations: number
  totalTokens: number | null
  totalDurationMs: number
  stoppedReason?: string
}

function workspaceName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || path
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

function formatTokens(tokens: number | null): string {
  return tokens === null ? 'tokens unavailable' : `${Math.round(tokens / 1000)}K tokens`
}

function verdictFor(result: AutonomousRunResult): string {
  if (result.success) return 'Goal achieved'
  switch (result.stoppedReason) {
    case 'max_iterations': return 'Stopped: iteration limit reached'
    case 'max_duration': return 'Stopped: time limit reached'
    case 'max_tokens': return 'Stopped: token limit reached'
    case 'user_stopped': return 'Stopped by you'
    case 'error': return 'Stopped: agent error'
    default: return 'Not achieved'
  }
}

/**
 * Autonomous Agent Panel
 *
 * Runs the goal loop in a registered checkout with a chosen agent command.
 * Progress comes from the main process state poll; token counts are shown
 * only when the provider reports usage, otherwise explicitly unavailable.
 */
export function AutonomousAgentPanel({ onReplaySession }: { onReplaySession?: (sessionId: string) => void }) {
  const repos = useAppStore((state) => state.repos)
  const presets = useAppStore((state) => state.agents)
  const activeWorktreePath = useAppStore((state) => state.activeWorktreePath)

  const [phase, setPhase] = useState<AutonomousPhase>('idle')
  const [goal, setGoal] = useState('')
  const [targetPath, setTargetPath] = useState(activeWorktreePath ?? '')
  const [presetId, setPresetId] = useState('')
  const [runState, setRunState] = useState<AutonomousRunState | null>(null)
  const [result, setResult] = useState<AutonomousRunResult | null>(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [pendingAction, setPendingAction] = useState<{ actionId: string; type: string; description: string } | null>(null)

  const availablePresets = useMemo(
    () => presets.filter((preset) => preset.available).sort((left, right) => left.name.localeCompare(right.name)),
    [presets]
  )
  const selectedPreset = availablePresets.find((preset) => preset.id === presetId)
  const command = selectedPreset ? selectedPreset.executablePath ?? selectedPreset.command : ''
  const canStart = goal.trim().length > 0 && targetPath !== '' && selectedPreset !== undefined && phase !== 'running'

  useEffect(() => {
    if (phase !== 'running') return
    let cancelled = false
    const poll = async () => {
      try {
        const state = await window.donwells.autonomousState()
        if (!cancelled) setRunState(state)
      } catch (err) {
        logger.error({ err }, 'autonomous-agent: state poll failed')
      }
    }
    void poll()
    const interval = setInterval(() => void poll(), 1000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [phase])

  useEffect(() => {
    if (phase !== 'running') {
      setPendingAction(null)
      return
    }
    return window.donwells.on('autonomous:action-request', setPendingAction)
  }, [phase])

  const start = async () => {
    if (!canStart) return
    setPhase('running')
    setRunState({ iterations: 0, totalTokens: null, durationMs: 0, stopped: false })
    setResult(null)
    setErrorMessage('')
    try {
      const outcome = await window.donwells.autonomousStart(goal.trim(), { workspacePath: targetPath, command })
      setResult(outcome)
      setPhase('finished')
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err))
      setPhase('error')
      logger.error({ err }, 'autonomous-agent: failed to start or run')
    }
  }

  const stop = async () => {
    try {
      await window.donwells.autonomousStop()
    } catch (err) {
      logger.error({ err }, 'autonomous-agent: failed to stop')
      setErrorMessage(err instanceof Error ? err.message : String(err))
    }
  }

  const showControls = phase !== 'running'

  return (
    <div>
      {showControls && (
        <>
          <label className="modal-field">Checkout
            <select
              className="input"
              aria-label="Autonomous agent checkout"
              value={targetPath}
              onChange={(event) => setTargetPath(event.target.value)}
            >
              {!targetPath && <option value="">Select a checkout</option>}
              {repos.flatMap((repo) => repo.worktrees.map((worktree) => (
                <option key={worktree.path} value={worktree.path}>
                  {workspaceName(repo.repo.path)} · {worktree.isMain ? 'Main checkout' : workspaceName(worktree.path)}{worktree.branch ? ` (${worktree.branch})` : ''}
                </option>
              )))}
            </select>
          </label>
          {availablePresets.length > 0 ? (
            <label className="modal-field">Agent
              <select
                className="input"
                aria-label="Autonomous agent type"
                value={presetId}
                onChange={(event) => setPresetId(event.target.value)}
              >
                <option value="" disabled>Select an agent</option>
                {availablePresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
              </select>
            </label>
          ) : (
            <div className="agent-launcher-note" role="status">
              <strong>No supported agent was found.</strong>
              <span>Install an agent first. </span>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => useAppStore.getState().openSettings('agents')}>Agent settings</button>
            </div>
          )}
          <div>
            <input
              className="input"
              type="text"
              placeholder="Goal for the autonomous agent…"
              value={goal}
              maxLength={2000}
              onChange={(event) => setGoal(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void start() }}
              aria-label="Autonomous agent goal"
            />
            <button className="btn btn-primary btn-sm" onClick={() => void start()} disabled={!canStart}>Start</button>
          </div>
        </>
      )}

      {phase === 'running' && runState && (
        <div>
          <div>
            <span>● Running</span>
            <span>
              Iteration {runState.iterations} · {formatDuration(runState.durationMs)} · {formatTokens(runState.totalTokens)}
            </span>
          </div>
          <button
            className="btn btn-secondary"
            title="The current agent job finishes first; the loop stops before the next iteration"
            onClick={() => void stop()}
          >
            Stop after current iteration
          </button>
        </div>
      )}

      {phase === 'running' && pendingAction && (
        <div className="input" role="alert">
          <p>
            Agent requests: <strong>{pendingAction.type}</strong> — {pendingAction.description}
          </p>
          <div>
            <button
              className="btn btn-primary"
              onClick={() => { void window.donwells.autonomousActionDecide(pendingAction.actionId, true); setPendingAction(null) }}
            >
              Allow
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => { void window.donwells.autonomousActionDecide(pendingAction.actionId, false); setPendingAction(null) }}
            >
              Deny
            </button>
          </div>
        </div>
      )}

      {phase === 'finished' && result && (
        <div>
          <p role="status">{verdictFor(result)}</p>
          <pre className="input" role="status" style={{ whiteSpace: 'pre-wrap', maxHeight: '10rem', overflowY: 'auto' }}>{result.finalResult || 'No summary was reported.'}</pre>
          <p>
            {result.iterations} iterations · {formatDuration(result.totalDurationMs)} · {formatTokens(result.totalTokens)}
          </p>
          <div>
            <button className="btn btn-secondary" onClick={() => { setPhase('idle'); setResult(null); setRunState(null) }}>New goal</button>
            {onReplaySession && (
              <button className="btn btn-secondary" title="Scrub the recorded iteration events for autonomous runs" onClick={() => onReplaySession('autonomous-run')}>Replay iterations</button>
            )}
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div>
          <p role="alert">Autonomous run failed: {errorMessage}</p>
          <button className="btn btn-secondary" onClick={() => { setPhase('idle'); setErrorMessage('') }}>Try again</button>
        </div>
      )}
    </div>
  )
}
