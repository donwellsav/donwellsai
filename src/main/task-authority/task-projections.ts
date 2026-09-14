import {
  parseParallelRun,
  parseScheduledExecution,
  parseScheduledRunDefinition,
  PARALLEL_HISTORY_LIMIT,
  SCHEDULED_HISTORY_LIMIT,
  type ParallelRun,
  type ParallelRunStatus,
  type ParallelRunTask,
  type ParallelTaskStatus,
  type ScheduledExecution,
  type ScheduledExecutionStatus,
  type ScheduledRunDefinition,
  type ScheduledRunSchedule,
  type VerificationArtifact
} from '@shared/operational-runs'
import type { ProjectTasksInspection } from '@shared/agent-runtime'
import type {
  AttemptProvenance,
  AttemptState,
  RunGroupState,
  RunMemberState,
  ScheduleExecutionState,
  TaskCommand,
  TaskExecutionTarget,
  TaskSnapshot,
  TaskStatus
} from '@shared/task-authority'

/**
 * Deterministic projections from Task Authority snapshots onto the existing
 * renderer-visible operational-run shapes.
 *
 * Every function here is pure: same input, same output, no clock, no I/O, no
 * database. Ordering is explicit (authority ordinal, then id) and every list is
 * bounded by the same limits the legacy stores enforced, so a caller migrating
 * off the JSON stores sees identical renderer contracts.
 */

export const PROJECTION_MAX_TASKS = 500
export const PROJECTION_MAX_MEMBERS = 100

/**
 * A projection could not be expressed in the renderer shape without lying.
 *
 * The legacy shapes carry invariants the authority model does not (one distinct
 * execution target per run task, a resolvable command, one history entry per
 * execution). Reporting the conflict beats emitting a shape that misstates
 * where or what ran.
 */
export class ProjectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectionError'
  }
}

export type ProjectionVerification = Readonly<{ requiredArtifacts: readonly Readonly<{ path: string; relationship: 'attached-reference' | 'observed-during-run' }>[] }>

export type ProjectionSpecification = Readonly<{
  command: TaskCommand
  target: TaskExecutionTarget
  verification: ProjectionVerification
  /** True when the imported execution specification is provenance-marked `legacy-unknown`. */
  legacyUnknown: boolean
}>

export type ProjectionArtifact = Readonly<{
  path: string
  sha256: string
  bytes: number
  attachedAt: string
  sourceFingerprint: string | null
  relationship: 'attached-reference' | 'observed-during-run'
  provenance: AttemptProvenance
}>

export type ProjectionAttempt = Readonly<{
  projectId: string
  taskId: string
  attemptId: string
  sequence: number
  state: AttemptState
  provenance: AttemptProvenance
  sessionId: string | null
  startedAt: string
  finishedAt: string | null
  exitCode: number | null
  error: string | null
  output: string | null
  specification: ProjectionSpecification | null
  artifacts: readonly ProjectionArtifact[]
}>

export type ProjectionRunMember = Readonly<{
  projectId: string
  taskId: string
  ordinal: number
  state: RunMemberState
  externalTaskId: string | null
  title: string | null
  /**
   * The member's committed fan-out specification, or null when the snapshot
   * carries none. A member may be queued with a specification and no attempt.
   */
  specification: ProjectionSpecification | null
  attempt: ProjectionAttempt | null
}>

export type ProjectionRunGroup = Readonly<{
  runGroupId: string
  profileId: string
  name: string
  retryOfRunGroupId: string | null
  concurrency: number
  state: RunGroupState
  createdAt: string
  updatedAt: string
  members: readonly ProjectionRunMember[]
}>

export type ProjectionSchedule = Readonly<{
  scheduleId: string
  projectId: string
  profileId: string
  taskTitle: string
  cadence: ScheduledRunSchedule
  command: TaskCommand
  target: TaskExecutionTarget
  verification: ProjectionVerification
  enabled: boolean
  nextRunAt: string | null
  createdAt: string
  updatedAt: string
  lastRunAt: string | null
  lastStatus: ScheduledExecutionStatus | null
}>

export type ProjectionScheduleExecution = Readonly<{
  projectId: string
  scheduleId: string
  executionId: string
  trigger: 'due' | 'manual'
  idempotencyKey: string
  taskId: string
  dueAt: string | null
  state: ScheduleExecutionState
  createdAt: string
  attempt: ProjectionAttempt | null
}>

const MEMBER_TASK_STATUS: Record<RunMemberState, ParallelTaskStatus> = {
  queued: 'queued',
  claimed: 'queued',
  launching: 'launching',
  running: 'running',
  cancelling: 'cancelling',
  cancelled: 'cancelled',
  completed: 'succeeded',
  failed: 'failed',
  quarantined: 'unverifiable'
}

const ATTEMPT_TASK_STATUS: Record<AttemptState, ParallelTaskStatus> = {
  claimed: 'queued',
  launching: 'launching',
  running: 'running',
  cancelling: 'cancelling',
  cancelled: 'cancelled',
  exited: 'failed',
  completed: 'succeeded',
  failed: 'failed',
  quarantined: 'unverifiable'
}

const SCHEDULED_STATUS: Record<ScheduleExecutionState, ScheduledExecutionStatus> = {
  queued: 'running',
  running: 'running',
  cancelling: 'cancelling',
  cancelled: 'cancelled',
  succeeded: 'succeeded',
  failed: 'failed'
}

/**
 * Renderer-visible task status labels. The legacy inspection shape is a
 * passthrough string carrying the native board's own wording, so the
 * projection reproduces those exact labels.
 */
const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'To Do',
  blocked: 'Blocked',
  'in-progress': 'In Progress',
  cancelling: 'In Progress',
  cancelled: 'Cancelled',
  done: 'Done',
  failed: 'Blocked',
  quarantined: 'Blocked'
}

function isLiveTaskStatus(status: ParallelTaskStatus): boolean {
  return status === 'launching' || status === 'running' || status === 'unverifiable' || status === 'cancelling'
}

function isLiveRunStatus(status: ParallelRunStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'unverifiable' || status === 'cancelling'
}

function isLiveExecutionStatus(status: ScheduledExecutionStatus): boolean {
  return status === 'running' || status === 'cancelling' || status === 'unverifiable'
}

/** Deterministic member order: authority ordinal, then project, then task UUID. */
export function compareRunMembers(left: ProjectionRunMember, right: ProjectionRunMember): number {
  if (left.ordinal !== right.ordinal) return left.ordinal - right.ordinal
  if (left.projectId !== right.projectId) return left.projectId < right.projectId ? -1 : 1
  return left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0
}

/** Deterministic artifact order: path, then attachment time. */
export function compareArtifacts(left: ProjectionArtifact, right: ProjectionArtifact): number {
  if (left.path !== right.path) return left.path < right.path ? -1 : 1
  return left.attachedAt < right.attachedAt ? -1 : left.attachedAt > right.attachedAt ? 1 : 0
}

export function projectArtifact(artifact: ProjectionArtifact): VerificationArtifact {
  return {
    path: artifact.path,
    sha256: artifact.sha256,
    bytes: artifact.bytes,
    attachedAt: artifact.attachedAt,
    sourceFingerprint: artifact.sourceFingerprint,
    relationship: artifact.relationship
  }
}

/**
 * Projects one run member.
 *
 * The renderer shape requires a resolvable execution target and command, so a
 * member without a committed specification fails loudly instead of rendering a
 * placeholder target that misstates where the work ran.
 */
export function projectParallelRunTask(member: ProjectionRunMember): ParallelRunTask {
  const attempt = member.attempt
  const status = attempt === null ? MEMBER_TASK_STATUS[member.state] : ATTEMPT_TASK_STATUS[attempt.state]
  const specification = attempt?.specification ?? member.specification
  if (specification === null) {
    throw new ProjectionError(`run member ${member.taskId} has no committed execution specification to project`)
  }
  const task: ParallelRunTask = {
    id: member.taskId,
    target: specification.target,
    command: [specification.command.program, ...specification.command.args].join(' '),
    status
  }
  if (attempt !== null) {
    if (attempt.sessionId !== null) task.sessionId = attempt.sessionId
    task.startedAt = attempt.startedAt
    if (attempt.finishedAt !== null) task.finishedAt = attempt.finishedAt
    if (attempt.exitCode !== null) task.exitCode = attempt.exitCode
    if (attempt.error !== null) task.error = attempt.error
    if (attempt.output !== null) task.output = attempt.output
  }
  task.verificationSetup = { outputs: specification.verification.requiredArtifacts.map(artifact => artifact.path), origin: { kind: 'unattributed' } }
  return task
}

/**
 * Run status derived exactly as the legacy orchestrator derived it: an
 * unverifiable member dominates, then any live member, then an unstarted queue
 * (a queued member beside an already-started run is a running run), then the
 * failed/cancelled/succeeded terminal precedence.
 */
function projectedRunStatus(group: ProjectionRunGroup, tasks: readonly ParallelRunTask[]): ParallelRunStatus {
  if (group.state === 'cancelling') return 'cancelling'
  if (group.state === 'cancelled') return 'cancelled'
  const live = tasks.filter(task => isLiveTaskStatus(task.status))
  if (live.some(task => task.status === 'unverifiable')) return 'unverifiable'
  if (live.length > 0) return 'running'
  const runStarted = tasks.some(task => task.startedAt !== undefined)
  if (tasks.some(task => task.status === 'queued')) return runStarted ? 'running' : 'queued'
  if (tasks.some(task => task.status === 'failed')) return 'failed'
  if (tasks.some(task => task.status === 'cancelled')) return 'cancelled'
  return 'succeeded'
}

/**
 * Run-group projection. Run status is derived from members exactly as the
 * legacy orchestrator derived it, so a cancelled or partially failed group
 * renders identically before and after cutover.
 */
export function projectParallelRun(group: ProjectionRunGroup): ParallelRun {
  const members = [...group.members].sort(compareRunMembers).slice(0, PROJECTION_MAX_MEMBERS)
  const tasks = members.map(projectParallelRunTask)
  // The renderer shape keys a run task by its target workspace, so two members
  // sharing one target cannot be represented faithfully.
  const targets = new Set<string>()
  for (const task of tasks) {
    const key = task.target.kind === 'local' ? `local ${task.target.root}` : `remote ${task.target.connectionId} ${task.target.root}`
    if (targets.has(key)) {
      throw new ProjectionError(`run group ${group.runGroupId} has two members sharing the target ${task.target.label}`)
    }
    targets.add(key)
  }
  const run: ParallelRun = {
    id: group.runGroupId,
    name: group.name,
    command: tasks[0]?.command ?? '',
    concurrency: group.concurrency,
    status: projectedRunStatus(group, tasks),
    createdAt: group.createdAt,
    tasks
  }
  if (group.retryOfRunGroupId !== null) run.retryOfRunId = group.retryOfRunGroupId
  const started = tasks.map(task => task.startedAt).filter((value): value is string => typeof value === 'string').sort()
  if (started.length > 0) run.startedAt = started[0]
  const finished = tasks.map(task => task.finishedAt).filter((value): value is string => typeof value === 'string').sort()
  if (!isLiveRunStatus(run.status)) run.finishedAt = finished[finished.length - 1] ?? group.updatedAt ?? group.createdAt
  return parseParallelRun(run)
}

export function projectScheduledRunDefinition(schedule: ProjectionSchedule, lastExecution?: ProjectionScheduleExecution): ScheduledRunDefinition {
  const definition: ScheduledRunDefinition = {
    id: schedule.scheduleId,
    name: schedule.taskTitle,
    target: schedule.target,
    command: [schedule.command.program, ...schedule.command.args].join(' '),
    schedule: schedule.cadence,
    enabled: schedule.enabled,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt
  }
  if (schedule.nextRunAt !== null) definition.nextRunAt = schedule.nextRunAt
  const lastRunAt = schedule.lastRunAt ?? lastExecution?.attempt?.startedAt ?? lastExecution?.createdAt
  if (lastRunAt !== undefined) definition.lastRunAt = lastRunAt
  const lastStatus = schedule.lastStatus ?? (lastExecution === undefined ? undefined : SCHEDULED_STATUS[lastExecution.state])
  if (lastStatus !== undefined) definition.lastStatus = lastStatus
  return parseScheduledRunDefinition(definition)
}

export function projectScheduledExecution(execution: ProjectionScheduleExecution): ScheduledExecution {
  const attempt = execution.attempt
  const projected: ScheduledExecution = {
    id: execution.executionId,
    scheduledRunId: execution.scheduleId,
    trigger: execution.trigger === 'due' ? 'schedule' : 'manual',
    startedAt: attempt?.startedAt ?? execution.createdAt,
    status: SCHEDULED_STATUS[execution.state]
  }
  if (attempt !== null) {
    if (attempt.sessionId !== null) projected.sessionId = attempt.sessionId
    if (attempt.finishedAt !== null) projected.finishedAt = attempt.finishedAt
    if (attempt.exitCode !== null) projected.exitCode = attempt.exitCode
    if (attempt.output !== null) projected.output = attempt.output
    if (attempt.error !== null) projected.error = attempt.error
  }
  return parseScheduledExecution(projected)
}

function compareExecutionsNewestFirst(left: ProjectionScheduleExecution, right: ProjectionScheduleExecution): number {
  const leftAt = left.attempt?.startedAt ?? left.createdAt
  const rightAt = right.attempt?.startedAt ?? right.createdAt
  if (leftAt !== rightAt) return rightAt < leftAt ? -1 : 1
  return right.executionId < left.executionId ? -1 : right.executionId > left.executionId ? 1 : 0
}

/**
 * Bounded schedule history in the legacy store's order: newest first, live
 * executions always retained, then the bounded completed tail.
 */
export function projectScheduledHistory(executions: readonly ProjectionScheduleExecution[]): ScheduledExecution[] {
  const ordered = [...executions].sort(compareExecutionsNewestFirst)
  const live = ordered.filter(execution => isLiveExecutionStatus(SCHEDULED_STATUS[execution.state]))
  const completed = ordered.filter(execution => !isLiveExecutionStatus(SCHEDULED_STATUS[execution.state]))
  return [...live, ...completed.slice(0, Math.max(0, SCHEDULED_HISTORY_LIMIT - live.length))].map(projectScheduledExecution)
}

/** Bounded parallel-run history in the legacy store's order: newest first, live runs retained. */
export function projectParallelRunHistory(groups: readonly ProjectionRunGroup[]): ParallelRun[] {
  const ordered = [...groups].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  const projected = ordered.map(group => ({ group, run: projectParallelRun(group) }))
  const live = projected.filter(entry => isLiveRunStatus(entry.run.status))
  const completed = projected.filter(entry => !isLiveRunStatus(entry.run.status))
  return [...live, ...completed.slice(0, Math.max(0, PARALLEL_HISTORY_LIMIT - live.length))].map(entry => entry.run)
}

/** Bounded, ordered task projection in the renderer's existing inspection shape. */
export function projectProjectTasksInspection(
  authority: ProjectTasksInspection['authority'],
  tools: ProjectTasksInspection['tools'],
  tasks: readonly TaskSnapshot[],
  problem?: string
): ProjectTasksInspection {
  const ordered = [...tasks]
    .sort((left, right) => (left.priority !== right.priority
      ? left.priority - right.priority
      : left.createdAt !== right.createdAt
        ? (left.createdAt < right.createdAt ? -1 : 1)
        : left.taskId < right.taskId ? -1 : 1))
    .slice(0, PROJECTION_MAX_TASKS)
  const result: ProjectTasksInspection = {
    authority,
    tools,
    tasks: ordered.map(task => ({ id: task.externalTaskId, title: task.title, status: TASK_STATUS_LABEL[task.status] }))
  }
  if (problem !== undefined) result.problem = problem
  return result
}
