import { lstat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DiffReviewRunState } from '@shared/diff-review'
import { isObject } from '@shared/command-catalog'
import { runProcess } from '@shared/child-process/run-process'
import { sanitizedProcessEnv } from '@shared/child-process/process-environment'
import { AgentRegistry } from './agents/registry'
import { shellCommand } from './agents/provider-hooks'
import { WorktreeFiles } from './worktree-files'
import { hashVerificationArtifact } from './diff-review'
import type { VerificationRunOptions, VerificationSource, VerificationArtifact, VerificationEntry, OperationalRunsApi, OperationalTarget, ParallelRunInput, ScheduledRunInput, ParallelRun, ParallelRunTask, ScheduledRunDefinition, ScheduledExecution } from '@shared/operational-runs'
import { parseParallelRunInput, parseScheduledRunInput, parseVerificationOutputPaths } from '@shared/operational-runs'
import type { DaemonClient } from './daemon-client'
import type { RunGroupSnapshot, ScheduleExecutionSnapshot, ScheduleSnapshot, TaskExecutionSpecificationInput, TaskSnapshot } from '@shared/task-authority'

/** Open verified checkout text in the existing editor; other artifacts use the platform opener. */
export async function openVerificationArtifact(path: string, workspacePath: string, sha256: string, openEditor: (workspacePath: string, relPath: string) => Promise<unknown>, openExternal: (path: string) => Promise<string>): Promise<void> {
  const relPath = relative(workspacePath, path)
  if (relPath && relPath !== '..' && !relPath.startsWith(`..${sep}`) && !isAbsolute(relPath)) {
    const file = await new WorktreeFiles().readFile(workspacePath, relPath.split(sep).join('/'))
    if (!file.binary && !file.truncated) {
      if (file.revision !== `sha256:${sha256}`) throw new Error('Artifact changed before opening in the editor')
      await openEditor(workspacePath, file.path)
      return
    }
  }
  const error = await openExternal(path)
  if (error) throw new Error(error)
}

function commandSpec(command: string, root: string, outputs: readonly string[] = []): TaskExecutionSpecificationInput {
  const parts = command.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) throw new Error('Run command is empty')
  return {
    command: { program: parts[0], args: parts.slice(1), cwd: root },
    target: { kind: 'local', root, label: basename(root) },
    verification: { requiredArtifacts: outputs.map(path => ({ path, relationship: 'observed-during-run' as const })) }
  }
}

function runGroupToLegacy(group: RunGroupSnapshot, specs: readonly TaskExecutionSpecificationInput[] = []): ParallelRun {
  const tasks: ParallelRunTask[] = group.members.map((member, index) => {
    const spec = specs[index]
    const attempt = member.attemptId
    const status: ParallelRunTask['status'] = member.state === 'claimed' || member.state === 'launching' ? 'launching' : member.state === 'running' ? 'running' : member.state === 'completed' ? 'succeeded' : member.state === 'failed' ? 'failed' : member.state === 'cancelled' ? 'cancelled' : member.state === 'cancelling' ? 'cancelling' : 'queued'
    return {
      id: member.taskId,
      target: spec?.target ?? { kind: 'local', root: '', label: member.taskId },
      command: spec ? [spec.command.program, ...spec.command.args].join(' ') : '',
      status,
      ...(attempt ? { sessionId: attempt } : {})
    }
  })
  const status: ParallelRun['status'] = group.state === 'completed' ? 'succeeded' : group.state === 'cancelled' ? 'cancelled' : group.state === 'cancelling' ? 'cancelling' : tasks.some(task => task.status === 'running') ? 'running' : 'queued'
  return { id: group.runGroupId, name: group.name, command: tasks[0]?.command ?? '', concurrency: group.concurrency, status, createdAt: group.createdAt, ...(group.retryOfRunGroupId ? { retryOfRunId: group.retryOfRunGroupId } : {}), tasks }
}

function scheduleToLegacy(schedule: ScheduleSnapshot): ScheduledRunDefinition {
  return {
    id: schedule.scheduleId,
    name: schedule.taskTitle,
    target: schedule.target,
    command: [schedule.command.program, ...schedule.command.args].join(' '),
    schedule: schedule.cadence,
    enabled: schedule.enabled,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
    ...(schedule.nextRunAt ? { nextRunAt: schedule.nextRunAt } : {})
  }
}

function executionToLegacy(execution: ScheduleExecutionSnapshot): ScheduledExecution {
  const status: ScheduledExecution['status'] = execution.state === 'succeeded' ? 'succeeded' : execution.state === 'failed' ? 'failed' : execution.state === 'cancelled' ? 'cancelled' : execution.state === 'cancelling' ? 'running' : execution.state === 'running' ? 'running' : 'running'
  return { id: execution.executionId, scheduledRunId: execution.scheduleId, trigger: execution.trigger === 'manual' ? 'manual' : 'schedule', startedAt: execution.createdAt, status, ...(execution.attemptId ? { sessionId: execution.attemptId } : {}) }
}

/** Main-process validation and intent adapter. All durable run state belongs to the daemon. */
export class OperationalRunService implements OperationalRunsApi {
  private readonly profileId: string
  private readonly resolveProjectId: (path: string) => Promise<string>
  private readonly resolveWorkspacePath: (path: string) => Promise<string>

  constructor(userDataDir: string, private readonly terminals: DaemonClient, resolveWorkspace: (path: string) => Promise<string>, private readonly verification?: { source: (path: string) => Promise<VerificationSource>; artifactRoots: (path: string) => Promise<string[]>; openArtifact?: (path: string, workspacePath: string, sha256: string) => Promise<void> }, _admitAffectedWork?: (operationId: string) => Promise<string>, _completeAffectedWork?: (operationId: string, outcome: 'completed' | 'cancelled') => Promise<void>, resolveProjectId?: (path: string) => Promise<string>) {
    this.profileId = userDataDir
    this.resolveWorkspacePath = resolveWorkspace
    this.resolveProjectId = resolveProjectId ?? (async path => path)
  }

  async resume(): Promise<void> { /* scheduler and reconciliation live in the daemon */ }
  stop(): void { /* daemon survives Electron disconnect */ }
  async onDaemonEvent(_kind: 'data' | 'exit', _sessionId: string, _data: string, _exitCode?: number): Promise<void> { /* daemon owns output */ }

  private async localWorkspace(target: OperationalTarget): Promise<string> {
    if (target.kind !== 'local') throw new Error('Remote operational execution is unavailable; this run was not launched locally')
    return this.resolveWorkspacePath(target.root)
  }

  private async createTask(root: string, title: string): Promise<TaskSnapshot> {
    return this.terminals.taskCreate({ projectId: await this.resolveProjectId(root), externalTaskId: `donwells:${randomUUID()}`, title, workspaceRoot: root })
  }

  async scheduledRunsList(): Promise<ScheduledRunDefinition[]> {
    const schedules = await this.terminals.taskSchedules()
    return schedules.map(scheduleToLegacy)
  }

  async scheduledRunHistory(id: string): Promise<ScheduledExecution[]> {
    const schedules = await this.terminals.taskSchedules()
    const schedule = schedules.find(candidate => candidate.scheduleId === id)
    if (!schedule) throw new Error('Scheduled run does not exist')
    const result = await this.terminals.taskScheduleExecutions({ projectId: schedule.projectId, scheduleId: id, limit: 100 })
    return result.executions.map(executionToLegacy)
  }

  async scheduledRunSave(value: ScheduledRunInput): Promise<ScheduledRunDefinition> {
    const input = parseScheduledRunInput(value)
    const root = await this.localWorkspace(input.target)
    const projectId = await this.resolveProjectId(root)
    const spec = commandSpec(input.command, root)
    const schedule = input.id
      ? await this.terminals.taskScheduleUpdate({ projectId, scheduleId: input.id, expectedEntityVersion: 1, spec: { profileId: this.profileId, taskTitle: input.name, cadence: input.schedule, command: spec.command, target: spec.target, verification: spec.verification }, enabled: input.enabled })
      : await this.terminals.taskScheduleCreate({ projectId, spec: { profileId: this.profileId, taskTitle: input.name, cadence: input.schedule, command: spec.command, target: spec.target, verification: spec.verification }, enabled: input.enabled, workspaceRoot: root })
    return scheduleToLegacy(schedule)
  }

  async scheduledRunSetEnabled(id: string, enabled: boolean): Promise<ScheduledRunDefinition> {
    const schedule = (await this.terminals.taskSchedules()).find(candidate => candidate.scheduleId === id)
    if (!schedule) throw new Error('Scheduled run does not exist')
    return scheduleToLegacy(await this.terminals.taskScheduleUpdate({ projectId: schedule.projectId, scheduleId: id, expectedEntityVersion: schedule.entityVersion, enabled }))
  }

  async scheduledRunDuplicate(id: string): Promise<ScheduledRunDefinition> {
    const schedule = (await this.terminals.taskSchedules()).find(candidate => candidate.scheduleId === id)
    if (!schedule) throw new Error('Scheduled run does not exist')
    return scheduleToLegacy(await this.terminals.taskScheduleDuplicate({ projectId: schedule.projectId, scheduleId: id, expectedEntityVersion: schedule.entityVersion }))
  }

  async scheduledRunDelete(id: string): Promise<void> {
    const schedule = (await this.terminals.taskSchedules()).find(candidate => candidate.scheduleId === id)
    if (!schedule) throw new Error('Scheduled run does not exist')
    await this.terminals.taskScheduleDelete({ projectId: schedule.projectId, scheduleId: id, expectedEntityVersion: schedule.entityVersion })
  }

  async scheduledRunRunNow(id: string): Promise<ScheduledExecution> {
    const schedule = (await this.terminals.taskSchedules()).find(candidate => candidate.scheduleId === id)
    if (!schedule) throw new Error('Scheduled run does not exist')
    return executionToLegacy(await this.terminals.taskScheduleExecutionEnqueue({ projectId: schedule.projectId, scheduleId: id, expectedEntityVersion: schedule.entityVersion, requestId: randomUUID() }))
  }

  async scheduledRunCancel(executionId: string): Promise<ScheduledExecution> {
    const executions = await this.terminals.taskScheduleExecutions({ limit: 100 })
    const execution = executions.executions.find(candidate => candidate.executionId === executionId)
    if (!execution) throw new Error('Scheduled execution does not exist')
    const schedule = (await this.terminals.taskSchedules()).find(candidate => candidate.scheduleId === execution.scheduleId)
    if (!schedule) throw new Error('Scheduled run does not exist')
    return executionToLegacy(await this.terminals.taskScheduleExecutionCancel({ projectId: execution.projectId, scheduleId: execution.scheduleId, executionId, expectedEntityVersion: schedule.entityVersion }))
  }

  async parallelRunsList(): Promise<ParallelRun[]> {
    const groups = await this.terminals.taskRunGroups(this.profileId)
    return groups.map(group => runGroupToLegacy(group))
  }

  async parallelRunStart(value: ParallelRunInput, options?: VerificationRunOptions): Promise<ParallelRun> {
    const input = parseParallelRunInput(value)
    const outputs = parseVerificationOutputPaths(options?.outputs ?? [])
    if (options?.credential) await this.terminals.authenticateAgent(options.credential)
    const members: Array<{ projectId: string; taskId: string; specification: TaskExecutionSpecificationInput }> = []
    for (const target of input.targets) {
      const root = await this.localWorkspace(target)
      const task = await this.createTask(root, input.name)
      const spec = commandSpec(input.command, root, outputs)
      members.push({ projectId: task.projectId, taskId: task.taskId, specification: spec })
    }
    const group = await this.terminals.taskRunGroupCreate({ profileId: this.profileId, name: input.name, concurrency: input.concurrency, members })
    return runGroupToLegacy(group, members.map(member => member.specification))
  }

  async parallelRunRetry(id: string, taskIds: string[]): Promise<ParallelRun> {
    if (!Array.isArray(taskIds) || taskIds.some(taskId => typeof taskId !== 'string')) throw new Error('Task IDs must be a string list')
    const group = (await this.terminals.taskRunGroups(this.profileId)).find(candidate => candidate.runGroupId === id)
    if (!group) throw new Error('Parallel run does not exist')
    return runGroupToLegacy(await this.terminals.taskRunGroupRetry({ runGroupId: id, expectedEntityVersion: group.entityVersion, requestId: randomUUID(), ownerId: randomUUID(), memberTaskIds: group.members.filter(member => taskIds.includes(member.taskId)).map(member => ({ projectId: member.projectId, taskId: member.taskId })) }))
  }

  async parallelRunCancel(id: string): Promise<ParallelRun> {
    const group = (await this.terminals.taskRunGroups(this.profileId)).find(candidate => candidate.runGroupId === id)
    if (!group) throw new Error('Parallel run does not exist')
    return runGroupToLegacy(await this.terminals.taskRunGroupCancel({ profileId: this.profileId, runGroupId: id, expectedEntityVersion: group.entityVersion }))
  }

  async parallelRunDelete(id: string): Promise<void> {
    const group = (await this.terminals.taskRunGroups(this.profileId)).find(candidate => candidate.runGroupId === id)
    if (!group) throw new Error('Parallel run does not exist')
    await this.terminals.taskRunGroupDelete({ profileId: this.profileId, runGroupId: id, expectedEntityVersion: group.entityVersion })
  }

  private async packageInfo(path: string): Promise<Record<string, unknown>> {
    const file = await new WorktreeFiles().readFile(path, 'package.json')
    if (file.binary || file.truncated || !file.revision || Buffer.byteLength(file.content) > 1024 * 1024) throw new Error('Package manifest is not complete stable text')
    const pkg = JSON.parse(file.content)
    if (!isObject(pkg)) throw new Error('Invalid package manifest')
    return pkg
  }

  private async packageManager(path: string): Promise<string> {
    const pkg = await this.packageInfo(path)
    const name = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : 'npm'
    if (!name || !['npm', 'pnpm', 'yarn', 'bun'].includes(name)) throw new Error('Package manager is not supported')
    return name
  }

  async verificationScripts(workspacePath: string): Promise<string[]> {
    const root = await this.resolveWorkspacePath(workspacePath)
    const pkg = await this.packageInfo(root)
    return isObject(pkg.scripts) ? Object.keys(pkg.scripts).filter(name => name.length > 0 && name.length <= 128 && !/[\u0000-\u001f]/.test(name) && typeof (pkg.scripts as Record<string, unknown>)[name] === 'string') : []
  }

  async verificationRun(workspacePath: string, script: string, options?: VerificationRunOptions): Promise<ParallelRun> {
    const root = await this.resolveWorkspacePath(workspacePath)
    if (!(await this.verificationScripts(root)).includes(script)) throw new Error('Choose an existing package script')
    const manager = await this.packageManager(root)
    const program = new AgentRegistry().findExecutable(manager)
    if (!program) throw new Error('Package manager is unavailable: ' + manager)
    return this.parallelRunStart({ name: 'Verify ' + script, command: shellCommand([program, 'run', script], process.platform), targets: [{ kind: 'local', root, label: basename(root) }], concurrency: 1 }, options)
  }

  async verificationList(workspacePath: string, _verifyArtifacts = false): Promise<VerificationEntry[]> {
    const root = await this.resolveWorkspacePath(workspacePath)
    const projectId = await this.resolveProjectId(root)
    const projection = await this.terminals.taskQuery({ projectId, limit: 100 })
    return projection.tasks.filter(task => task.currentAttempt?.runtime?.sessionId !== null).slice(0, 20).map(task => ({ runId: task.currentAttempt?.attemptId ?? task.taskId, task: this.taskToLegacy(task), sourceState: task.status === 'done' ? 'current' : task.status === 'failed' ? 'stale' : 'running', artifacts: [] }))
  }

  async verificationReviewRuns(workspacePath: string): Promise<Record<string, DiffReviewRunState>> {
    const entries = await this.verificationList(workspacePath)
    return Object.fromEntries(entries.map(entry => [entry.runId + ':' + entry.task.id, { status: entry.task.status, sourceState: entry.sourceState, exitCode: entry.task.exitCode, sourceFingerprint: null }]))
  }

  private taskToLegacy(task: TaskSnapshot): ParallelRunTask {
    const attempt = task.currentAttempt
    const spec = attempt ? { command: { program: 'unknown', args: [] }, target: { kind: 'local' as const, root: '', label: '' }, verification: { requiredArtifacts: [] } } : undefined
    return { id: task.taskId, target: spec?.target ?? { kind: 'local', root: '', label: '' }, command: spec ? spec.command.program : '', status: task.status === 'done' ? 'succeeded' : task.status === 'failed' ? 'failed' : task.status === 'cancelled' ? 'cancelled' : 'running', ...(attempt?.runtime?.sessionId ? { sessionId: attempt.runtime.sessionId } : {}), ...(attempt?.startedAt ? { startedAt: attempt.startedAt } : {}), ...(attempt?.finishedAt ? { finishedAt: attempt.finishedAt } : {}) }
  }

  async verificationOpen(_workspacePath: string, _runId: string, _taskId: string, _path: string): Promise<void> {
    throw new Error('Artifact opening requires a daemon verification projection')
  }

  async verificationAttach(_workspacePath: string, _runId: string, _taskId: string, _path: string): Promise<VerificationArtifact> {
    throw new Error('Artifact attachment requires a daemon-issued worker credential and lease')
  }
}
