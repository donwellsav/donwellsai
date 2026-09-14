import { realpathSync } from 'node:fs'
import type { AgentExecutable } from '@shared/agent-runtime'
import type { ProcessIdentity, ProcessIdentityVerdict } from '@shared/child-process/process-spec'
import {
  canonicalResourceKey,
  TaskAuthorityError,
  type AuthenticatedAuthorityConnection,
  type AttemptSnapshot,
  type ClaimResult,
  type LeaseToken,
  type ScheduleExecutionSnapshot,
  type TaskExecutionSpecificationInput,
  type TaskSnapshot
} from '@shared/task-authority'
import { SequencedTaskOutputPump } from '@shared/terminal-stream'
import { agentProviderForExecutable } from '@shared/agent-runtime'
import { SqliteTaskAuthority, launchIntentFingerprint } from './task-authority'
import type { DaemonTaskEvidencePort, TaskEvidencePreObservation } from './task-evidence-port'

/** Task children bind runtime only as acp-agent today; Stage 5 widens the union. */
export type TaskChildRuntime = 'finite-job' | 'acp-agent'

export type OpenedTaskChild = Readonly<{ sessionId: string; processIdentity: ProcessIdentity | null }>

export interface TaskFiniteJobPort {
  openJob(cwd: string, command: string, cols?: number, rows?: number): OpenedTaskChild
}

export interface TaskAgentOpenPort {
  openAgent(cwd: string, command: string, launch?: AgentExecutable, cols?: number, rows?: number): OpenedTaskChild
}

/**
 * The retained owning child handle. `stop` is idempotent per attempt and
 * resolves only after confirmed exit; `output` reads must never infer exit
 * from transport loss, so it reports the daemon-owned exit facts explicitly.
 */
export interface TaskChildOwnerPort {
  stop(sessionId: string): Promise<void>
  /** Process-group stop by recorded identity, for children the restarted daemon no longer owns in its PtyManager. */
  stopProcess?(identity: ProcessIdentity): Promise<void>
  output(sessionId: string, afterOffset: number): { output: string; totalBytes: number; exited: boolean; exitCode?: number }
}

export type TaskLaunchPorts = Readonly<{
  jobs: TaskFiniteJobPort & TaskChildOwnerPort
  agents: (TaskAgentOpenPort & TaskChildOwnerPort) | null
}>

export type PreparedTaskLaunch = Readonly<{
  token: LeaseToken
  specificationId: string
  launchIntentId: string
  canonicalResourceKey: string
  workspaceRoot: string
  preObservation: TaskEvidencePreObservation
}>

export type TaskLaunchDisposition = 'completed' | 'failed' | 'cancelled' | 'superseded' | 'reconciled'

export type TaskLaunchOutcome = Readonly<{
  task: TaskSnapshot
  attempt: AttemptSnapshot
  sessionId: string | null
  exitCode: number | null
  disposition: TaskLaunchDisposition
  output: string
}>

export type TaskReconciliationEvent = Readonly<{
  projectId: string
  taskId: string
  attemptId: string | null
  action: 'preserved' | 'closed-stale' | 'quarantined-indeterminate' | 'wrong-family-closed' | 'exit-acknowledged' | 'stop-retried' | 'offers-expired'
  detail: string
}>

const FENCED_BIND_LOSS = new Set(['TASK_CANCELLED', 'STALE_AUTHORITY', 'LEASE_EXPIRED', 'HANDOFF_PENDING', 'AUTHORIZATION_DENIED', 'RESOURCE_QUARANTINED'])
const LEASE_RENEWAL_WINDOW_MS = 15_000
const LEASE_RENEWAL_TTL_MS = 60_000

function authorityCode(error: unknown): string {
  return error instanceof TaskAuthorityError ? error.code : 'UNKNOWN'
}

function authorityMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function shellCommand(specification: TaskExecutionSpecificationInput): string {
  return [specification.command.program, ...specification.command.args].map(part => (/^[A-Za-z0-9_./:=+-]+$/.test(part) ? part : JSON.stringify(part))).join(' ')
}

/**
 * Daemon-owned execution coordinator. It owns in-memory pumps only: every
 * durable decision is committed by the Task Authority before the next step.
 * A launch is claim -> canonical reservation -> durable planned intent ->
 * beginSpawn admission -> child creation outside SQLite -> persisted returned
 * identity facts -> fenced runtime bind -> bounded output pump -> daemon-owned
 * evidence capture -> fenced terminal write.
 */
export class TaskExecutionCoordinator {
  private readonly authority: SqliteTaskAuthority
  private readonly ports: TaskLaunchPorts
  private readonly evidence: DaemonTaskEvidencePort
  private readonly resolveWorkspace: (root: string) => string
  private readonly verifyIdentity: ((identity: ProcessIdentity) => ProcessIdentityVerdict) | null
  private readonly outputLimitBytes: number
  private readonly pumpPollMs: number
  private readonly deliveredStops = new Set<string>()
  private readonly childKinds = new Map<string, 'finite-job' | 'acp-agent'>()

  constructor(options: Readonly<{
    authority: SqliteTaskAuthority
    ports: TaskLaunchPorts
    evidence: DaemonTaskEvidencePort
    resolveWorkspace?: (root: string) => string
    verifyIdentity?: (identity: ProcessIdentity) => ProcessIdentityVerdict
    outputLimitBytes?: number
    pumpPollMs?: number
  }>) {
    this.authority = options.authority
    this.ports = options.ports
    this.evidence = options.evidence
    this.resolveWorkspace = options.resolveWorkspace ?? ((root: string) => realpathSync.native(root))
    this.verifyIdentity = options.verifyIdentity ?? null
    this.outputLimitBytes = options.outputLimitBytes ?? 64 * 1024
    this.pumpPollMs = options.pumpPollMs ?? 10
  }

  /** Stages 1-2: canonical reservation plus the durable `planned` launch intent. */
  prepareLaunch(claim: ClaimResult, specification: TaskExecutionSpecificationInput, connection: AuthenticatedAuthorityConnection, repositoryId?: string): PreparedTaskLaunch {
    if (specification.target.kind !== 'local') throw new TaskAuthorityError('AUTHORIZATION_DENIED', 'task launches support local execution targets only')
    const token = claim.token
    const workspaceRoot = this.resolveWorkspace(specification.command.cwd ?? specification.target.root)
    const preObservation = this.evidence.observePre(specification, workspaceRoot)
    const canonical = canonicalResourceKey(preObservation.workspaceRoot)
    this.authority.write({ kind: 'bind-worktree', connection, token, resourceKey: preObservation.workspaceRoot, worktreePath: preObservation.workspaceRoot, repositoryId: repositoryId ?? token.projectId })
    this.authority.write({ kind: 'record-launch-intent', connection, token, specificationId: claim.attempt.specificationId })
    const task = this.freshTask(connection, token.projectId, token.taskId)
    const runtime = task.currentAttempt?.runtime
    if (!runtime?.launchIntentId) throw new TaskAuthorityError('STALE_AUTHORITY', `attempt ${token.attemptId} recorded no launch intent`)
    return { token, specificationId: claim.attempt.specificationId, launchIntentId: runtime.launchIntentId, canonicalResourceKey: canonical, workspaceRoot: preObservation.workspaceRoot, preObservation }
  }

  /** Stages 3-9: spawn admission through the fenced terminal write. */
  async continueLaunch(prepared: PreparedTaskLaunch, specification: TaskExecutionSpecificationInput, connection: AuthenticatedAuthorityConnection, runtime: TaskChildRuntime = 'finite-job'): Promise<TaskLaunchOutcome> {
    const token = prepared.token
    try {
      this.authority.beginSpawn({ token, launchIntentId: prepared.launchIntentId, expectedSpecificationId: prepared.specificationId })
    } catch (error) {
      const disposition: TaskLaunchDisposition = authorityCode(error) === 'TASK_CANCELLED' ? 'cancelled' : 'superseded'
      const task = this.freshTask(connection, token.projectId, token.taskId)
      return { task, attempt: task.currentAttempt ?? preparedAttemptFallback(task), sessionId: null, exitCode: null, disposition, output: '' }
    }

    const owner = runtime === 'acp-agent' ? this.ports.agents : this.ports.jobs
    if (!owner) throw new TaskAuthorityError('AUTHORIZATION_DENIED', `no daemon port is available for ${runtime} task children`)
    const cwd = specification.command.cwd ?? prepared.workspaceRoot
    const command = shellCommand(specification)
    const launch = runtime === 'acp-agent' && agentProviderForExecutable(specification.command.program)
      ? { executable: specification.command.program, args: [...specification.command.args] }
      : undefined
    const child = runtime === 'acp-agent'
      ? (this.ports.agents as TaskAgentOpenPort & TaskChildOwnerPort).openAgent(cwd, command, launch)
      : this.ports.jobs.openJob(cwd, command)
    this.childKinds.set(child.sessionId, runtime)

    // Persist the returned session/process facts even if the token is already superseded.
    this.authority.recordReturnedIdentity({ projectId: token.projectId, taskId: token.taskId, attemptId: token.attemptId, sessionId: child.sessionId, processIdentity: child.processIdentity })

    try {
      this.authority.write({ kind: 'bind-runtime', connection, token, sessionId: child.sessionId, processIdentity: child.processIdentity as ProcessIdentity })
    } catch (error) {
      return this.handleBindLoss(prepared, child, owner, error, connection)
    }

    const pump = new SequencedTaskOutputPump(this.outputLimitBytes)
    let offset = 0
    let exitCode: number | null = null
    for (;;) {
      const chunk = owner.output(child.sessionId, offset)
      if (chunk.output.length > 0) {
        pump.append(chunk.output)
        offset = chunk.totalBytes
      }
      if (chunk.exited) {
        exitCode = chunk.exitCode ?? null
        break
      }
      this.renewLeaseIfDue(token, connection)
      await this.delay(this.pumpPollMs)
    }

    this.evidence.assertReservedWorkspace(prepared.preObservation, prepared.canonicalResourceKey)
    const capture = this.evidence.capturePost(prepared.preObservation, pump.output, pump.truncated)
    // Cancellation may have been committed while the child was still running;
    // the pump observing its exit is the confirmation the cancelling state needs.
    const preExitTask = this.freshTask(connection, token.projectId, token.taskId)
    if (preExitTask.currentAttempt?.state === 'cancelling' && preExitTask.currentAttempt.currentLease?.leaseId === token.leaseId && preExitTask.currentAttempt.currentLease.generation === token.generation) {
      const updated = this.authority.acknowledgeExit({ projectId: token.projectId, taskId: token.taskId, attemptId: token.attemptId, leaseId: token.leaseId, generation: token.generation, reason: 'coordinator observed the cancelled child exit' })
      return { task: updated, attempt: updated.currentAttempt ?? preExitTask.currentAttempt, sessionId: child.sessionId, exitCode, disposition: 'cancelled', output: pump.output }
    }
    try {
      for (const artifact of capture.artifacts) {
        this.authority.write({ kind: 'attach-artifact', connection, token, artifact })
      }
      this.authority.write({ kind: 'progress', connection, token, detail: `child exited with code ${exitCode}; outputSha256=${capture.outputDigest}; outputBytes=${capture.outputBytes}; truncated=${capture.outputTruncated}` })
      if (exitCode === 0) {
        try {
          const task = this.authority.write({ kind: 'complete', connection, token, result: { summary: `task child exited 0; outputSha256=${capture.outputDigest}` } })
          return { task, attempt: task.currentAttempt ?? preparedAttemptFallback(task), sessionId: child.sessionId, exitCode, disposition: 'completed', output: pump.output }
        } catch (error) {
          if (authorityCode(error) !== 'COMPLETION_REJECTED') throw error
          const task = this.authority.write({ kind: 'fail', connection, token, error: authorityMessage(error).slice(0, 2048) })
          return { task, attempt: task.currentAttempt ?? preparedAttemptFallback(task), sessionId: child.sessionId, exitCode, disposition: 'failed', output: pump.output }
        }
      }
      const task = this.authority.write({ kind: 'fail', connection, token, error: `task child exited with code ${exitCode}` })
      return { task, attempt: task.currentAttempt ?? preparedAttemptFallback(task), sessionId: child.sessionId, exitCode, disposition: 'failed', output: pump.output }
    } catch (error) {
      if (!FENCED_BIND_LOSS.has(authorityCode(error))) throw error
      this.authority.recordStaleGenerationExit({ projectId: token.projectId, taskId: token.taskId, attemptId: token.attemptId, leaseId: token.leaseId, generation: token.generation, exitCode, outputDigest: capture.outputDigest })
      const task = this.freshTask(connection, token.projectId, token.taskId)
      return { task, attempt: task.currentAttempt ?? preparedAttemptFallback(task), sessionId: child.sessionId, exitCode, disposition: 'superseded', output: pump.output }
    }
  }

  async launch(claim: ClaimResult, specification: TaskExecutionSpecificationInput, connection: AuthenticatedAuthorityConnection, runtime: TaskChildRuntime = 'finite-job', repositoryId?: string): Promise<TaskLaunchOutcome> {
    const prepared = this.prepareLaunch(claim, specification, connection, repositoryId)
    return this.continueLaunch(prepared, specification, connection, runtime)
  }

  /**
   * Idempotent cancellation stop delivery through the retained owning child
   * handle. A transient stop failure is retried exactly once; confirmed exit
   * is then acknowledged through the trusted daemon path.
   */
  async deliverStop(token: LeaseToken, attempt: AttemptSnapshot): Promise<TaskSnapshot> {
    const key = `${token.leaseId}:${token.generation}`
    if (this.deliveredStops.has(key)) {
      return this.freshTask({ connectionId: 'daemon-stop-reader', role: 'administrator' }, token.projectId, token.taskId)
    }
    this.deliveredStops.add(key)
    const sessionId = attempt.runtime?.sessionId ?? null
    const identity = attempt.runtime?.processIdentity ?? null
    const kind = sessionId === null ? null : this.childKinds.get(sessionId) ?? null
    const owner = kind === 'acp-agent' ? this.ports.agents : this.ports.jobs
    if (!owner) throw new TaskAuthorityError('AUTHORIZATION_DENIED', `no daemon port is available for ${kind ?? 'unknown'} task children`)
    let delivered = false
    let lastError: unknown
    for (let tries = 0; tries < 2 && !delivered; tries += 1) {
      try {
        if (sessionId !== null) await owner.stop(sessionId)
        else if (identity !== null && this.ports.jobs.stopProcess) await this.ports.jobs.stopProcess(identity)
        else if (identity !== null && this.ports.agents?.stopProcess) await this.ports.agents.stopProcess(identity)
        else throw new TaskAuthorityError('STALE_AUTHORITY', `attempt ${token.attemptId} holds no child session or process identity to stop`)
        delivered = true
      } catch (error) {
        lastError = error
      }
    }
    if (!delivered) throw lastError instanceof Error ? lastError : new Error(String(lastError))
    return this.authority.acknowledgeExit({ projectId: token.projectId, taskId: token.taskId, attemptId: token.attemptId, leaseId: token.leaseId, generation: token.generation, reason: 'cancellation stop delivered and exit confirmed' })
  }

  /**
   * Startup reconciliation over every nonterminal attempt. Valid acp-agent
   * runtime bindings are preserved; confirmed-exited runtimes close the
   * attempt; indeterminate runtimes quarantine it; cancelling attempts
   * re-deliver stop when the child is still live or acknowledge exit when it
   * is confirmed gone. No model prompt is ever replayed and process absence
   * never proves completion.
   */
  async reconcileStartup(verifyIdentity: (identity: ProcessIdentity) => ProcessIdentityVerdict): Promise<TaskReconciliationEvent[]> {
    const events: TaskReconciliationEvent[] = []
    const attempts = this.authority.listNonterminalAttempts()
    for (const attempt of attempts) {
      const identity = attempt.runtime?.processIdentity ?? null
      const base = { projectId: attempt.projectId, taskId: attempt.taskId, attemptId: attempt.attemptId }
      if (identity === null) {
        if (attempt.runtime !== null && attempt.runtime.launchState === 'spawning') {
          this.authority.reconcileStartupAttempt({ ...base, verdict: 'indeterminate', reason: 'launch intent is spawning without a returned identity' })
          events.push({ ...base, action: 'quarantined-indeterminate', detail: 'spawning without a returned identity' })
        }
        continue
      }
      const verdict = verifyIdentity(identity)
      if (verdict.status === 'valid' && identity.family !== 'acp-agent') {
        this.authority.reconcileStartupAttempt({ ...base, verdict: 'stale', reason: `runtime family ${identity.family} cannot keep a task attempt alive` })
        events.push({ ...base, action: 'wrong-family-closed', detail: `wrong-family identity ${identity.family}` })
        continue
      }
      if (attempt.state === 'cancelling') {
        if (verdict.status === 'stale') {
          this.authority.acknowledgeExit({ ...base, leaseId: attempt.currentLease!.leaseId, generation: attempt.currentLease!.generation, reason: 'startup reconciliation confirmed the cancelling child exited' })
          events.push({ ...base, action: 'exit-acknowledged', detail: 'cancelling child confirmed exited' })
        } else if (verdict.status === 'valid') {
          await this.deliverStop({ projectId: attempt.projectId, taskId: attempt.taskId, attemptId: attempt.attemptId, ownerId: attempt.currentLease!.ownerId, leaseId: attempt.currentLease!.leaseId, generation: attempt.currentLease!.generation, expiresAt: attempt.currentLease!.expiresAt }, attempt)
          events.push({ ...base, action: 'stop-retried', detail: 'committed cancellation stop re-delivered' })
        } else {
          this.authority.reconcileStartupAttempt({ ...base, verdict: 'indeterminate', reason: 'cancelling child liveness is indeterminate' })
          events.push({ ...base, action: 'quarantined-indeterminate', detail: 'cancelling child liveness indeterminate' })
        }
        continue
      }
      if (verdict.status === 'valid') {
        this.authority.reconcileStartupAttempt({ ...base, verdict: 'valid', reason: 'child process identity verified live' })
        events.push({ ...base, action: 'preserved', detail: 'valid daemon-owned runtime binding preserved' })
      } else if (verdict.status === 'stale') {
        this.authority.reconcileStartupAttempt({ ...base, verdict: 'stale', reason: 'child process confirmed exited before completion' })
        events.push({ ...base, action: 'closed-stale', detail: 'stale runtime closed the attempt' })
      } else {
        this.authority.reconcileStartupAttempt({ ...base, verdict: 'indeterminate', reason: 'child process liveness is indeterminate' })
        events.push({ ...base, action: 'quarantined-indeterminate', detail: 'indeterminate runtime quarantined' })
      }
    }
    const expired = this.authority.expireDueHandoffOffers()
    if (expired > 0) {
      events.push({ projectId: '*', taskId: '*', attemptId: null, action: 'offers-expired', detail: `${expired} handoff offer(s) expired by authority time` })
    }
    return events
  }

  private async handleBindLoss(prepared: PreparedTaskLaunch, child: OpenedTaskChild, owner: TaskChildOwnerPort, error: unknown, connection: AuthenticatedAuthorityConnection): Promise<TaskLaunchOutcome> {
    const token = prepared.token
    const code = authorityCode(error)
    await this.stopChildOnce(`${token.leaseId}:${token.generation}`, owner, child.sessionId, child.processIdentity)
    const task = this.freshTask(connection, token.projectId, token.taskId)
    const attempt = task.currentAttempt
    if (attempt?.state === 'cancelling') {
      const updated = this.authority.acknowledgeExit({ projectId: token.projectId, taskId: token.taskId, attemptId: token.attemptId, leaseId: token.leaseId, generation: token.generation, reason: 'cancellation won before the runtime bind' })
      return { task: updated, attempt: updated.currentAttempt ?? attempt, sessionId: child.sessionId, exitCode: null, disposition: 'cancelled', output: '' }
    }
    if (code === 'LEASE_EXPIRED') {
      const verdict: ProcessIdentityVerdict = child.processIdentity !== null && this.verifyIdentity !== null
        ? this.verifyIdentity(child.processIdentity)
        : { status: 'stale', reason: 'not-found' }
      this.authority.reconcileExpiredOwner({
        projectId: token.projectId,
        taskId: token.taskId,
        attemptId: token.attemptId,
        leaseId: token.leaseId,
        generation: token.generation,
        launchIntentSha256: launchIntentFingerprint(prepared.launchIntentId, token.attemptId, token.leaseId),
        processIdentity: child.processIdentity as ProcessIdentity,
        verdict
      })
      const reconciled = this.freshTask(connection, token.projectId, token.taskId)
      return { task: reconciled, attempt: reconciled.currentAttempt ?? attempt ?? preparedAttemptFallback(reconciled), sessionId: child.sessionId, exitCode: null, disposition: 'reconciled', output: '' }
    }
    this.authority.recordStaleGenerationExit({ projectId: token.projectId, taskId: token.taskId, attemptId: token.attemptId, leaseId: token.leaseId, generation: token.generation, exitCode: null, outputDigest: '' })
    return { task, attempt: attempt ?? preparedAttemptFallback(task), sessionId: child.sessionId, exitCode: null, disposition: 'superseded', output: '' }
  }

  private async stopChildOnce(key: string, owner: TaskChildOwnerPort, sessionId: string, identity: ProcessIdentity | null): Promise<void> {
    if (this.deliveredStops.has(key)) return
    this.deliveredStops.add(key)
    try {
      await owner.stop(sessionId)
    } catch (error) {
      if (identity !== null && owner.stopProcess) await owner.stopProcess(identity)
      else throw error
    }
  }

  private renewLeaseIfDue(token: LeaseToken, connection: AuthenticatedAuthorityConnection): void {
    if (Number.isNaN(Date.parse(token.expiresAt))) return
    if (Date.parse(token.expiresAt) - Date.now() > LEASE_RENEWAL_WINDOW_MS) return
    try {
      this.authority.write({ kind: 'heartbeat', connection, token, ttlMs: LEASE_RENEWAL_TTL_MS })
    } catch {
      // A fencing failure surfaces at the next fenced write; never retry a stale mutation as transient.
    }
  }

  private freshTask(connection: AuthenticatedAuthorityConnection, projectId: string, taskId: string): TaskSnapshot {
    const page = this.authority.query({ connection, projectId, limit: 500 })
    const task = page.tasks.find(candidate => candidate.taskId === taskId)
    if (!task) throw new TaskAuthorityError('TASK_NOT_FOUND', `task ${taskId} was not found in project ${projectId}`)
    return task
  }

  private delay(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, ms)
    return promise
  }
}

function preparedAttemptFallback(task: TaskSnapshot): AttemptSnapshot {
  if (task.currentAttempt) return task.currentAttempt
  throw new TaskAuthorityError('STALE_AUTHORITY', `task ${task.taskId} holds no current attempt`)
}

export type TaskSchedulerTickResult = Readonly<{
  enqueued: readonly ScheduleExecutionSnapshot[]
  claimed: readonly Readonly<{ claim: ClaimResult; specification: TaskExecutionSpecificationInput }>[]
  failures: readonly Readonly<{ scope: string; error: string }>[]
}>

/**
 * Daemon-owned due-schedule pump. One tick enqueues each due occurrence at
 * most once (the authority's expected-occurrence precondition arbitrates
 * concurrent ticks) and claims the materialized tasks with the daemon worker
 * identity, so schedules keep executing with no Electron client connected.
 */
export class TaskSchedulerPump {
  private readonly now: () => number
  private readonly connectionId: string

  constructor(private readonly authority: SqliteTaskAuthority, private readonly workerOwnerId: string, options: Readonly<{ now?: () => number; connectionId?: string }> = {}) {
    this.now = options.now ?? Date.now
    this.connectionId = options.connectionId ?? 'daemon-scheduler'
  }

  tick(): TaskSchedulerTickResult {
    const enqueued: ScheduleExecutionSnapshot[] = []
    const claimed: Array<Readonly<{ claim: ClaimResult; specification: TaskExecutionSpecificationInput }>> = []
    const failures: Array<Readonly<{ scope: string; error: string }>> = []
    const due = this.authority.listSchedulesDue(this.now())
    for (const schedule of due) {
      try {
        const execution = this.authority.enqueueDueSchedule({
          connection: { connectionId: this.connectionId, role: 'daemon-scheduler', authorizedProjectIds: [schedule.projectId], authorizedProfileIds: [schedule.profileId] },
          projectId: schedule.projectId,
          scheduleId: schedule.scheduleId,
          expectedEntityVersion: schedule.entityVersion,
          expectedNextRunAt: schedule.nextRunAt as string
        })
        enqueued.push(execution)
      } catch (error) {
        failures.push({ scope: `schedule:${schedule.scheduleId}`, error: authorityMessage(error) })
      }
    }
    const queued = this.authority.listScheduleExecutions({ connection: { connectionId: this.connectionId, role: 'administrator' }, state: 'queued', limit: 500 })
    for (const execution of queued.executions) {
      if (claimed.some(entry => entry.claim.task.taskId === execution.taskId)) continue
      const scheduleSpec = due.find(schedule => schedule.scheduleId === execution.scheduleId)
      if (!scheduleSpec) continue
      const specification: TaskExecutionSpecificationInput = { command: scheduleSpec.command, target: scheduleSpec.target, verification: scheduleSpec.verification }
      try {
        claimed.push({
          claim: this.authority.claim({
            connection: { connectionId: `${this.connectionId}-worker`, role: 'worker', ownerId: this.workerOwnerId, authorizedProjectIds: [execution.projectId] },
            projectId: execution.projectId,
            taskId: execution.taskId,
            specification
          }),
          specification
        })
      } catch (error) {
        failures.push({ scope: `execution:${execution.executionId}`, error: authorityMessage(error) })
      }
    }
    return { enqueued, claimed, failures }
  }
}
