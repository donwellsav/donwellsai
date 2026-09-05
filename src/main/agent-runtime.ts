import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type {
  AgentPreset,
  AgentProviderId,
  AgentStartResult,
  RunningAgent
} from '@shared/agent-runtime'
import { requireLocalExecutionHost } from '@shared/child-process/execution-host'
import type { ExecutionHost } from '@shared/child-process/process-spec'
import { AgentRegistry } from './agents/registry'

const MAX_AGENT_COMMAND_LENGTH = 16 * 1024
export type AgentWorkspaceRegistration = { path: string; host: ExecutionHost }

export type AgentRuntimeOptions = {
  registeredWorkspaces: () =>
    | readonly AgentWorkspaceRegistration[]
    | Promise<readonly AgentWorkspaceRegistration[]>
  registry?: AgentRegistry
}

function containsPath(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function canonicalDirectory(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute local path`)
  let canonical: string
  try {
    canonical = realpathSync.native(resolve(path))
  } catch (error) {
    throw new Error(`${label} does not resolve to an existing local directory`, { cause: error })
  }
  if (!statSync(canonical).isDirectory()) throw new Error(`${label} is not a directory`)
  return canonical
}

/** Resolve through real paths so a symlink cannot escape the registered workspace set. */
export function validateAgentWorkspacePath(
  workspacePath: string,
  registrations: readonly AgentWorkspaceRegistration[]
): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(workspacePath)) {
    throw new Error('remote workspace hosts are unsupported for local agent runs')
  }
  const candidate = canonicalDirectory(workspacePath, 'agent workspace')
  for (const registration of registrations) {
    if (registration.host.kind === 'remote') {
      const remoteRoot = registration.path.replace(/[\\/]+$/, '')
      const requested = workspacePath.replace(/[\\/]+$/, '')
      if (requested === remoteRoot || requested.startsWith(`${remoteRoot}/`) || requested.startsWith(`${remoteRoot}\\`)) {
        requireLocalExecutionHost(registration.host)
      }
      continue
    }
    requireLocalExecutionHost(registration.host)
    const root = canonicalDirectory(registration.path, 'registered workspace')
    if (containsPath(root, candidate)) return candidate
  }
  throw new Error('agent workspace is not inside a registered local workspace')
}

/** Main-process facade: validates local authority and degrades contact loss to unverifiable. */
export class AgentRuntime {
  private readonly registry: AgentRegistry
  private readonly cachedRuns = new Map<string, RunningAgent>()

  constructor(
    private readonly daemon: AgentRuntimeDaemonContract,
    private readonly options: AgentRuntimeOptions
  ) {
    this.registry = options.registry ?? new AgentRegistry()
  }

  listAgents(): AgentPreset[] {
    return this.registry.list()
  }

  observe(run: RunningAgent): void {
    this.cachedRuns.set(run.sessionId, structuredClone(run))
  }

  observeDismissed(sessionId: string): void {
    this.cachedRuns.delete(sessionId)
  }

  async start(workspacePath: string, command: string): Promise<AgentStartResult> {
    const normalizedCommand = command.trim()
    if (!normalizedCommand || normalizedCommand.includes('\0')) throw new Error('agent command is empty or invalid')
    if (normalizedCommand.length > MAX_AGENT_COMMAND_LENGTH) throw new Error('agent command exceeds limit')
    const registrations = await this.options.registeredWorkspaces()
    const cwd = validateAgentWorkspacePath(workspacePath, registrations)
    const provider = this.registry.providerForCommand(normalizedCommand)
    if (provider && !this.registry.findExecutable(normalizedCommand)) {
      throw new Error(`${provider.name} executable is unavailable`)
    }
    const result = await this.daemon.startAgent(cwd, normalizedCommand, provider?.id)
    this.observe(result.run)
    return structuredClone(result)
  }

  async list(): Promise<RunningAgent[]> {
    try {
      const runs = await this.daemon.listAgents()
      this.cachedRuns.clear()
      for (const run of runs) this.observe(run)
      return structuredClone(runs)
    } catch (error) {
      if (this.cachedRuns.size === 0) throw error
      const observedAt = new Date().toISOString()
      const runs = [...this.cachedRuns.values()].map((run) => {
        if (run.liveness === 'exited') return run
        const unverifiable: RunningAgent = {
          ...run,
          liveness: 'unverifiable',
          updatedAt: observedAt
        }
        this.cachedRuns.set(run.sessionId, unverifiable)
        return unverifiable
      })
      return structuredClone(runs)
    }
  }

  async interrupt(sessionId: string): Promise<RunningAgent> {
    try {
      const run = await this.daemon.interruptAgent(sessionId)
      this.observe(run)
      return structuredClone(run)
    } catch (error) {
      const cached = this.cachedRuns.get(sessionId)
      if (cached && cached.liveness !== 'exited') {
        this.observe({ ...cached, liveness: 'unverifiable', updatedAt: new Date().toISOString() })
      }
      throw error
    }
  }

  async dismiss(sessionId: string): Promise<void> {
    await this.daemon.dismissAgent(sessionId)
    this.observeDismissed(sessionId)
  }
}

export type AgentRuntimeDaemonContract = {
  startAgent: (
    cwd: string,
    command: string,
    providerId?: AgentProviderId
  ) => Promise<AgentStartResult>
  listAgents: () => Promise<RunningAgent[]>
  interruptAgent: (sessionId: string) => Promise<RunningAgent>
  dismissAgent: (sessionId: string) => Promise<void>
}
