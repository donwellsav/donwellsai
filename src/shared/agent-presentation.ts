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
    case 'completed': return 'Agent reported completion; task verification is separate'
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

/**
 * Display-only provenance for a run recorded before provider instances existed.
 *
 * A pre-Stage-3 run carries a command family, not an admitted provider
 * identity, so it can only ever be shown. It is never launch authority: nothing
 * resolves an instance, driver, account, or executable from this text.
 */
export function legacyProviderDisplayName(value: string): string {
  const trimmed = value.trim()
  return `legacy provider: ${trimmed === '' ? 'unknown' : trimmed}`
}

/**
 * The provider name shown for one run.
 *
 * An admitted run names its driver directly. Anything recorded before provider
 * instances existed is shown as legacy provenance and is never resolved back
 * into a launch identity.
 */
export function agentProviderName(run: RunningAgent): string {
  if (run.provider) {
    return AGENT_PROVIDER_DEFINITIONS.find((provider) => provider.id === run.provider!.driverId)?.name
      ?? run.provider.driverId
  }
  return legacyProviderDisplayName(run.command)
}

/** Cycles only live input/permission waits within the selected project. */
export function nextWaitingSession(runs: readonly RunningAgent[], workspacePaths: readonly string[], currentSessionId?: string): RunningAgent | undefined {
  const waiting = runs.filter(run => workspacePaths.includes(run.workspacePath) && run.liveness === 'live'
    && (run.activity === 'waiting' || run.activity === 'permission'))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.sessionId.localeCompare(b.sessionId))
  return waiting[(waiting.findIndex(run => run.sessionId === currentSessionId) + 1) % waiting.length]
}
