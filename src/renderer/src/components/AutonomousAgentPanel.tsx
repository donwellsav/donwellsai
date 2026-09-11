import { useEffect, useState, useCallback } from 'react'
import { logger } from '@shared/logger'

interface AutonomousAgentState {
  status: 'idle' | 'running' | 'paused' | 'stopped' | 'error'
  iterations: number
  totalTokens: number
  durationMs: number
  stopped: boolean
}

/**
 * Autonomous Agent Panel
 *
 * Controls for starting/stopping long-running autonomous agents.
 * Shows real-time progress (iterations, tokens).
 */
export function AutonomousAgentPanel() {
  const [state, setState] = useState<AutonomousAgentState>({ status: 'idle', iterations: 0, totalTokens: 0, durationMs: 0, stopped: false })
  const [goal, setGoal] = useState('')

  const refreshState = useCallback(async () => {
    try {
      const result = await window.donwells.autonomousState()
      setState({
        ...result as unknown as AutonomousAgentState,
        status: (result as unknown as { stopped: boolean }).stopped ? 'stopped' : 'running',
      })
    } catch {
      setState({ status: 'idle', iterations: 0, totalTokens: 0, durationMs: 0, stopped: false })
    }
  }, [])

  useEffect(() => {
    void refreshState()
    const interval = setInterval(refreshState, 2000)
    return () => clearInterval(interval)
  }, [refreshState])

  const startAgent = useCallback(async () => {
    if (!goal.trim()) return
    try {
      setState(s => ({ ...s, status: 'running', stopped: false }))
      await window.donwells.autonomousStart(goal)
    } catch (err) {
      setState(s => ({ ...s, status: 'error' }))
      logger.error({ err }, 'autonomous-agent: failed to start')
    }
  }, [goal])

  const stopAgent = useCallback(async () => {
    try {
      await window.donwells.autonomousStop()
      setState(s => ({ ...s, status: 'stopped', stopped: true }))
    } catch (err) {
      logger.error({ err }, 'autonomous-agent: failed to stop')
    }
  }, [])

  return (
    <div className="autonomous-agent-panel p-3 border-t border-border/30">
      <h4 className="text-xs font-semibold text-foreground mb-2">Autonomous Agent</h4>

      {state.status === 'idle' || state.status === 'stopped' || state.status === 'error' ? (
        <div className="flex gap-2">
          <input
            className="input flex-1"
            type="text"
            placeholder="Goal for the autonomous agent…"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void startAgent() }}
            aria-label="Autonomous agent goal"
          />
          <button
            className="btn btn-primary btn-sm"
            onClick={() => void startAgent()}
            disabled={!goal.trim()}
          >
            Start
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className={`font-medium ${state.status === 'running' ? 'text-green-500' : 'text-yellow-500'}`}>
              {state.status === 'running' ? '● Running' : '⏸ Paused'}
            </span>
            <span className="text-muted">
              {state.iterations} iterations · {Math.round(state.totalTokens / 1000)}K tokens
            </span>
          </div>

          <div className="h-1 bg-muted/20 rounded-full overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-500"
              style={{ width: `${Math.min(100, state.iterations)}%` }}
            />
          </div>

          <button className="btn btn-secondary btn-xs" onClick={() => void stopAgent()}>
            Stop
          </button>
        </div>
      )}
    </div>
  )
}
