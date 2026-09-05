import { useMemo, useState } from 'react'
import {
  agentPresentation,
  agentProviderName,
  type AgentPresentation
} from '@shared/agent-presentation'
import type { RunningAgent } from '@shared/types'
import { useAppStore } from '../../store'
import { Icon } from '../Icon'
import { formatRunTime } from './RunStatus'

type AgentFilter = 'all' | 'attention' | 'active' | 'waiting' | 'permission' | 'unverifiable' | 'failed' | 'finished'
type PresentedAgent = { run: RunningAgent; presentation: AgentPresentation; provider: string }
const AGENT_FILTERS: Record<string, AgentFilter> = {
  all: 'all',
  attention: 'attention',
  active: 'active',
  waiting: 'waiting',
  permission: 'permission',
  unverifiable: 'unverifiable',
  failed: 'failed',
  finished: 'finished'
}

function workspaceName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || path
}

function matchesFilter(agent: PresentedAgent, filter: AgentFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'attention') return agent.presentation.needsAttention
  if (filter === 'active') return agent.presentation.inProgress
  if (filter === 'finished') return agent.presentation.status === 'completed' || agent.presentation.status === 'exited'
  return agent.presentation.status === filter
}

export function AgentsSection() {
  const runningAgents = useAppStore((state) => state.runningAgents)
  const focusAgentSession = useAppStore((state) => state.focusAgentSession)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<AgentFilter>('all')
  const [opening, setOpening] = useState<string | null>(null)
  const [terminalErrors, setTerminalErrors] = useState<Record<string, string>>({})

  const agents = useMemo<PresentedAgent[]>(() => Object.values(runningAgents)
    .map((run) => ({ run, presentation: agentPresentation(run), provider: agentProviderName(run) }))
    .sort((left, right) => {
      const leftRank = left.presentation.needsAttention ? 0 : left.presentation.inProgress ? 1 : 2
      const rightRank = right.presentation.needsAttention ? 0 : right.presentation.inProgress ? 1 : 2
      return leftRank - rightRank || right.run.updatedAt.localeCompare(left.run.updatedAt)
    }), [runningAgents])

  const matchingAgents = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return agents.filter((agent) => {
      if (!matchesFilter(agent, filter)) return false
      if (!needle) return true
      const { run, presentation, provider } = agent
      return [
        workspaceName(run.workspacePath),
        run.workspacePath,
        provider,
        run.presetId ?? '',
        run.command,
        presentation.label,
        presentation.description,
        run.activity,
        run.liveness
      ].some((value) => value.toLocaleLowerCase().includes(needle))
    })
  }, [agents, filter, query])

  const attentionCount = agents.filter((agent) => agent.presentation.needsAttention).length
  const activeCount = agents.filter((agent) => agent.presentation.inProgress).length

  const openTerminal = async (run: RunningAgent): Promise<void> => {
    setOpening(run.sessionId)
    setTerminalErrors((current) => {
      if (!(run.sessionId in current)) return current
      const next = { ...current }
      delete next[run.sessionId]
      return next
    })
    try {
      const focused = await focusAgentSession(run.sessionId)
      if (!focused) {
        setTerminalErrors((current) => ({ ...current, [run.sessionId]: 'The daemon session is no longer available in this workspace.' }))
      }
    } catch (error) {
      setTerminalErrors((current) => ({
        ...current,
        [run.sessionId]: error instanceof Error ? error.message : String(error)
      }))
    } finally {
      setOpening(null)
    }
  }

  return (
    <div className="op-section agents-section">
      <div className="op-section-heading">
        <div>
          <span className="op-eyebrow">Daemon-observed sessions</span>
          <h3>Agents</h3>
          <p>Inspect agent state without launching providers. Liveness and activity come from the native runtime.</p>
        </div>
        <div className="agent-totals" aria-label="Agent status totals">
          <span><strong>{activeCount}</strong> in progress</span>
          <span className={attentionCount > 0 ? 'attention' : ''}><strong>{attentionCount}</strong> need attention</span>
        </div>
      </div>

      <div className="op-toolbar agent-toolbar">
        <label className="op-search">
          <span className="sr-only">Search agents</span>
          <Icon name="search" size={13} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search workspace, provider, activity…" />
        </label>
        <label className="agent-filter">
          <span className="sr-only">Filter agents by status</span>
          <select value={filter} onChange={(event) => setFilter(AGENT_FILTERS[event.target.value] ?? 'all')}>
            <option value="all">All statuses</option>
            <option value="attention">Needs attention</option>
            <option value="active">In progress</option>
            <option value="waiting">Waiting</option>
            <option value="permission">Permission needed</option>
            <option value="unverifiable">Unverifiable</option>
            <option value="failed">Failed</option>
            <option value="finished">Finished</option>
          </select>
        </label>
        <span className="op-count">{matchingAgents.length} of {agents.length}</span>
      </div>

      <div className="agent-list" aria-live="polite">
        {matchingAgents.map(({ run, presentation, provider }) => (
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
              <button
                className="btn btn-secondary btn-sm agent-open-terminal"
                disabled={opening === run.sessionId}
                onClick={() => void openTerminal(run)}
              >
                <Icon name="terminal" size={13} />
                {opening === run.sessionId ? 'Opening…' : 'Open terminal'}
              </button>
            </div>

            <dl className="agent-facts">
              <div><dt>Workspace</dt><dd title={run.workspacePath}>{run.workspacePath}</dd></div>
              <div><dt>Provider</dt><dd><strong>{provider}</strong><code title={run.command}>{run.command}</code></dd></div>
              <div><dt>Activity</dt><dd><strong>{run.activity}</strong><span>{presentation.description}</span></dd></div>
              <div><dt>Liveness</dt><dd><strong>{run.liveness}</strong><span>{run.hook.connected ? 'Hook connected' : run.hook.support === 'native' ? 'Hook not connected' : 'Process observation only'}</span></dd></div>
            </dl>

            <div className="agent-card-foot">
              <span>Started {formatRunTime(run.startedAt)}</span>
              <span>Updated {formatRunTime(run.updatedAt)}</span>
              {run.exitCode !== undefined && <span>Exit code {run.exitCode}</span>}
            </div>
            {terminalErrors[run.sessionId] && <p className="agent-row-error" role="alert">{terminalErrors[run.sessionId]}</p>}
          </article>
        ))}
        {agents.length === 0 && (
          <div className="op-empty agent-empty">
            <Icon name="robot" size={18} />
            <strong>No agent sessions yet</strong>
            <span>Start an agent from a workspace terminal; this view will follow its native runtime state.</span>
          </div>
        )}
        {agents.length > 0 && matchingAgents.length === 0 && (
          <div className="op-empty agent-empty">
            <Icon name="search" size={18} />
            <strong>No matching agents</strong>
            <span>Adjust the search or status filter to see other retained sessions.</span>
          </div>
        )}
      </div>
    </div>
  )
}
