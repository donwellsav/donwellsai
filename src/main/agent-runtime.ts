import { parseAgentTaskIntent, type AgentTaskIntent, parseAgentExecutable, agentProviderForExecutable, type AgentExecutable } from '@shared/agent-runtime'
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
import type { DaemonClient } from './daemon-client'
import type { McpServer } from '@agentclientprotocol/sdk'

const MAX_AGENT_COMMAND_LENGTH = 16 * 1024
export type AgentWorkspaceRegistration = { path: string; host: ExecutionHost }

export type AgentRuntimeOptions = {
  nativeMcpArgs?: (workspacePath: string, provider: string, args: string[]) => Promise<string[]>
  acpMcpServers?: (workspacePath: string, sessionId: string) => Promise<McpServer[]>
  registeredWorkspaces: () =>
    | readonly AgentWorkspaceRegistration[]
    | Promise<readonly AgentWorkspaceRegistration[]>
  requireTask?: (path: string, id: string) => Promise<void>
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

  private async acpWorkspace(workspacePath: string): Promise<string> {
    if (!this.daemon.startAcp || !this.daemon.listAcp || !this.daemon.observeAcp || !this.daemon.promptAcp || !this.daemon.controlAcp) throw new Error('ACP runtime is unavailable')
    return validateAgentWorkspacePath(workspacePath, await this.options.registeredWorkspaces())
  }

  async switchMode(workspacePath: string, sessionId: string, target: 'native' | 'acp', requestId: string, context?: string) {
    if (!this.daemon.switchMode) throw new Error('Mode switching is unavailable')
    const cwd = await this.acpWorkspace(workspacePath)
    const executable = this.registry.findExecutable('opencode')
    if (!executable) throw new Error('Install OpenCode to switch modes')
    const servers = target === 'acp' ? await this.options.acpMcpServers?.(cwd, requestId) ?? [] : []
    await this.acpWorkspace(cwd)
    return this.daemon.switchMode(cwd, sessionId, target, requestId, executable, servers, context)
  }
  async modeSwitchResult(workspacePath: string, requestId: string) {
    if (!this.daemon.modeSwitchResult) throw new Error('Mode switching is unavailable')
    return this.daemon.modeSwitchResult(await this.acpWorkspace(workspacePath), requestId)
  }

  async startAcp(workspacePath: string, requestId: string, loadRunId?: string) {
    const cwd = await this.acpWorkspace(workspacePath)
    const executable = this.registry.findExecutable('opencode')
    if (!executable) throw new Error('Install OpenCode to start the admitted ACP adapter')
    const servers = await this.options.acpMcpServers?.(cwd, requestId) ?? []
    await this.acpWorkspace(cwd)
    return this.daemon.startAcp!(cwd, requestId, { executable, args: ['acp', '--cwd', cwd, '--hostname', '127.0.0.1', '--port', '0'] }, servers, loadRunId)
  }
  async listAcp(workspacePath: string) { return this.daemon.listAcp!(await this.acpWorkspace(workspacePath)) }
  async observeAcp(workspacePath: string, sessionId: string, afterSequence = 0) { return this.daemon.observeAcp!(await this.acpWorkspace(workspacePath), sessionId, afterSequence) }
  async promptAcp(workspacePath: string, sessionId: string, requestId: string, text: string) { return this.daemon.promptAcp!(await this.acpWorkspace(workspacePath), sessionId, requestId, text) }
  async controlAcp(workspacePath: string, sessionId: string, operation: 'cancel' | 'stop' | 'permission' | 'dismiss', permissionId?: string, optionId?: string) { return this.daemon.controlAcp!(await this.acpWorkspace(workspacePath), sessionId, operation, permissionId, optionId) }

  async findAcpSession(sessionId: string) {
    if (!this.daemon.listAcp) return undefined
    const registrations = await this.options.registeredWorkspaces()
    const paths = new Set<string>()
    for (const registration of registrations) {
      if (registration.host.kind !== 'local') continue
      try { paths.add(validateAgentWorkspacePath(registration.path, registrations)) }
      catch { /* A removed checkout cannot authorize a session. */ }
    }
    for (const workspacePath of paths) {
      const session = (await this.daemon.listAcp(workspacePath)).find(run => run.id === sessionId)
      if (session) return { sessionId: session.id, workspacePath: session.workspacePath, liveness: ['ready', 'working', 'permission'].includes(session.state) ? 'live' as const : session.state === 'exited' ? 'exited' as const : 'unverifiable' as const }
    }
    return undefined
  }

  observe(run: RunningAgent): void {
    this.cachedRuns.set(run.sessionId, structuredClone(run))
  }

  observeDismissed(sessionId: string): void {
    this.cachedRuns.delete(sessionId)
  }

  async start(workspacePath: string, command: string | AgentExecutable, task?: AgentTaskIntent): Promise<AgentStartResult> {
    const intent = task === undefined ? undefined : parseAgentTaskIntent(task)
    let launch = typeof command === 'string' ? undefined : parseAgentExecutable(command)
    if (launch) {
      const executable = this.registry.findExecutable(launch.executable)
      if (!executable) throw new Error('Agent executable is unavailable')
      launch.executable = executable
    }
    const normalizedCommand = typeof command === 'string' ? command.trim() : JSON.stringify([launch!.executable, ...launch!.args])
    if (!normalizedCommand || normalizedCommand.includes('\0')) throw new Error('agent command is empty or invalid')
    if (normalizedCommand.length > MAX_AGENT_COMMAND_LENGTH) throw new Error('agent command exceeds limit')
    const registrations = await this.options.registeredWorkspaces()
    const cwd = validateAgentWorkspacePath(workspacePath, registrations)
    if (intent?.externalId) {
      if (!this.options.requireTask) throw new Error('External task authority is unavailable')
      await this.options.requireTask(cwd, intent.externalId)
      validateAgentWorkspacePath(workspacePath, await this.options.registeredWorkspaces())
    }
    const provider = launch ? agentProviderForExecutable(launch.executable) : this.registry.providerForCommand(normalizedCommand)
    if (!launch && provider && !this.registry.findExecutable(normalizedCommand)) {
      throw new Error(`${provider.name} executable is unavailable`)
    }


    if (provider && ['codex', 'claude'].includes(provider.id) && this.options.nativeMcpArgs) {
      launch ??= { executable: this.registry.findExecutable(normalizedCommand)!, args: [] }
      const args = await this.options.nativeMcpArgs(cwd, provider.id, launch.args)
      launch = { ...launch, args: [...args, ...launch.args] }
      validateAgentWorkspacePath(workspacePath, await this.options.registeredWorkspaces())
    }
    const result = intent ? await this.daemon.startAgent(cwd, normalizedCommand, provider?.id, launch, 100, 30, intent) : launch ? await this.daemon.startAgent(cwd, normalizedCommand, provider?.id, launch) : await this.daemon.startAgent(cwd, normalizedCommand, provider?.id)
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
      return this.connectionLost()
    }
  }

  connectionLost(): RunningAgent[] {
    const observedAt = new Date().toISOString()
    for (const run of this.cachedRuns.values()) {
      if (run.liveness !== 'exited') this.observe({ ...run, liveness: 'unverifiable', updatedAt: observedAt })
    }
    return structuredClone([...this.cachedRuns.values()])
  }

  async interrupt(sessionId: string): Promise<RunningAgent> {
    return this.controlAgent(sessionId, 'interruptAgent')
  }

  async stop(sessionId: string): Promise<RunningAgent> {
    return this.controlAgent(sessionId, 'stopAgent')
  }

  private async controlAgent(sessionId: string, operation: 'interruptAgent' | 'stopAgent'): Promise<RunningAgent> {
    try {
      const run = await this.daemon[operation](sessionId)
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

export type AgentRuntimeDaemonContract = Partial<Pick<DaemonClient, 'switchMode' | 'modeSwitchResult' | 'startAcp' | 'listAcp' | 'observeAcp' | 'promptAcp' | 'controlAcp'>> & {
  startAgent: (
    cwd: string,
    command: string,
    providerId?: AgentProviderId,
    launch?: AgentExecutable,
    cols?: number,
    rows?: number,
    task?: AgentTaskIntent
  ) => Promise<AgentStartResult>
  listAgents: () => Promise<RunningAgent[]>
  interruptAgent: (sessionId: string) => Promise<RunningAgent>
  stopAgent: (sessionId: string) => Promise<RunningAgent>
  dismissAgent: (sessionId: string) => Promise<void>
}
