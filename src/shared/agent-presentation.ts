import {
  AGENT_PROVIDER_DEFINITIONS,
  type AgentActivity,
  type RunningAgent
} from './agent-runtime'

export type AgentPresentationStatus = AgentActivity | 'unverifiable' | 'exited'
export type AgentPresentationTone = 'working' | 'attention' | 'done' | 'failed'

export type AgentPresentation = {
  status: AgentPresentationStatus
  label: string
  description: string
  tone: AgentPresentationTone
  needsAttention: boolean
  inProgress: boolean
}


function defaultDescription(status: AgentPresentationStatus, exitCode: number | undefined): string {
  switch (status) {
    case 'starting': return 'Agent is starting'
    case 'working': return 'Agent is working'
    case 'waiting': return 'Agent is waiting for input'
    case 'permission': return 'Agent is waiting for permission'
    case 'stopping': return 'Agent is stopping'
    case 'completed': return 'Agent completed'
    case 'failed': return exitCode === undefined ? 'Agent failed' : `Agent exited with code ${exitCode}`
    case 'unverifiable': return 'The runtime cannot verify whether this agent is still live'
    case 'exited': return exitCode === undefined ? 'Agent process exited' : `Agent process exited with code ${exitCode}`
  }
}

function presentationStatus(run: RunningAgent): AgentPresentationStatus {
  if (run.liveness === 'unverifiable') return 'unverifiable'
  if (run.liveness === 'exited') {
    if (run.activity === 'failed' || (run.exitCode !== undefined && run.exitCode !== 0)) return 'failed'
    if (run.activity === 'completed') return 'completed'
    return 'exited'
  }
  return run.activity
}

export function agentPresentation(run: RunningAgent): AgentPresentation {
  const status = presentationStatus(run)
  const processOnly = status === 'working' && !run.hook.connected
  const label = status === 'permission'
    ? 'Permission needed'
    : status === 'unverifiable'
      ? 'Unverifiable'
      : status[0]!.toUpperCase() + status.slice(1)
  const needsAttention = status === 'waiting' || status === 'permission' || status === 'unverifiable' || status === 'failed'
  const inProgress = run.liveness === 'live' && status !== 'completed' && status !== 'failed' && status !== 'exited'
  const tone: AgentPresentationTone = status === 'failed'
    ? 'failed'
    : needsAttention
      ? 'attention'
      : status === 'completed' || status === 'exited'
        ? 'done'
        : 'working'
  return {
    status,
    label: processOnly ? 'Running' : label,
    description: run.detail?.trim() || (processOnly ? 'Process is running; task activity is not reported by this agent.' : defaultDescription(status, run.exitCode)),
    tone,
    needsAttention,
    inProgress
  }
}

export function agentNeedsAttention(run: RunningAgent): boolean {
  const status = presentationStatus(run)
  return status === 'waiting' || status === 'permission' || status === 'unverifiable' || status === 'failed'
}

export function agentIsInProgress(run: RunningAgent): boolean {
  return agentPresentation(run).inProgress
}

export function agentProviderName(run: RunningAgent): string {
  if (!run.presetId) return 'Custom command'
  return AGENT_PROVIDER_DEFINITIONS.find((provider) => provider.id === run.presetId)?.name ?? run.presetId
}

/** Prefer a live session for a workspace, then an attention state, then the latest retained outcome. */
export function agentForWorkspace(
  workspacePath: string,
  runs: Readonly<Record<string, RunningAgent>>
): RunningAgent | undefined {
  let selected: RunningAgent | undefined
  let selectedRank = Number.POSITIVE_INFINITY
  for (const sessionId in runs) {
    const run = runs[sessionId]
    if (!run || run.workspacePath !== workspacePath) continue
    const presentation = agentPresentation(run)
    const rank = presentation.inProgress ? 0 : presentation.needsAttention ? 1 : 2
    if (rank < selectedRank || (rank === selectedRank && (!selected || run.updatedAt > selected.updatedAt))) {
      selected = run
      selectedRank = rank
    }
  }
  return selected
}
