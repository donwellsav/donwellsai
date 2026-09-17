import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentExecutable } from '@shared/agent-runtime'
import type { ProcessIdentity, ProcessIdentityVerdict } from '@shared/child-process/process-spec'
import { isolatedProviderEnvironment } from '@shared/child-process/process-environment'
import {
  canonicalResourceKey,
  TaskAuthorityError,
  type AuthenticatedAuthorityConnection,
  type AttemptSnapshot,
  type ClaimResult,
  type LeaseToken,
  type ProviderLaunchAdmissionTuple,
  type ScheduleExecutionSnapshot,
  type TaskExecutionSpecificationInput,
  type TaskSnapshot
} from '@shared/task-authority'
import type { ProviderCredentialMode, ProviderLaunchPreparation, ProviderSelection } from '@shared/provider-authority'
import { SecretAuthorityError, type ProviderLaunchSecrets } from '@shared/provider-secret-broker'
import { SequencedTaskOutputPump } from '@shared/terminal-stream'
import { agentProviderForExecutable } from '@shared/agent-runtime'
import { SqliteTaskAuthority, launchIntentFingerprint } from './task-authority'
import type { DaemonTaskEvidencePort, TaskEvidencePreObservation } from './task-evidence-port'
import type { SecretOutputBoundary } from '../secret-output-redactor'
import { ProviderInvocationError, resolveProviderInvocation, type ResolvedProviderInvocation } from '../agents/provider-hooks'

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

// ---------------------------------------------------------------------------
// Provider-backed launch (Stage 3, DORMANT)
//
// Nothing in production reaches the provider path: no renderer control,
// settings payload, CLI schema, or scheduled job names a provider selection
// yet, so until Task 4 migrates the real callers the only entries are this
// stage's direct tests. Generic shell and verification work continues on the
// provider-free path above and is never reinterpreted as provider work.
// ---------------------------------------------------------------------------

/** The maintenance gate calls a provider launch makes, and nothing else. */
export interface ProviderMaintenancePort {
  admit(participant: 'provider-authority', operationId: string): Promise<{ operationId: string; epoch: number; ownerConnectionId: string }>
  complete(operationId: string, epoch: number, ownerConnectionId: string, outcome: 'completed' | 'cancelled'): Promise<void>
}

/** The one credential-bearing call this daemon makes, and only after admission. */
export interface ProviderSecretPort {
  materialize(authorization: ProviderLaunchAuthorization): Promise<ProviderLaunchSecrets>
}

/**
 * The exact authorization tuple the admitted row produced. Every field comes
 * from the committed admission, never from a re-read or a serialized request.
 */
export type ProviderLaunchAuthorization = Readonly<{
  launchAdmissionId: string
  preparationId: string
  attemptId: string
  sessionId: string
  purpose: 'agent-launch'
  driverId: ProviderSelection['driverId']
  providerInstanceId: string
  instanceRevision: number
  accountId: string
  accountRevision: number
  credentialRef: string
  bindingGeneration: number
}>

/** The provider-instance surface the coordinator consumes: preparation only. */
export interface ProviderLaunchCatalogPort {
  prepareLaunch(input: { selection: ProviderSelection; attemptId: string; sessionId: string; purpose: 'agent-launch' }): ProviderLaunchPreparation
}

/** One provider child, owned by the daemon until its exit is confirmed. */
export interface ProviderChildPort {
  open(input: {
    /** The daemon-owned session id; the child must bind exactly this id so the output boundary and the PTY sink agree. */
    sessionId: string
    workspaceRoot: string
    invocation: ResolvedProviderInvocation
    environment: NodeJS.ProcessEnv
    cols: number
    rows: number
    /**
     * The exact admitted selection. The child port needs it to record the run's
     * provider provenance: the id, revision, and account are what the renderer
     * shows instead of a command family, and they are already durable facts by
     * the time the spawn is admitted.
     */
    selection: ProviderSelection
    /**
     * The credential mode the admission bound.
     *
     * It decides how the child's environment is treated: an isolated mode
     * supplies a complete allowlist environment, while `external` inherits the
     * process environment minus this app's own authority. The port cannot infer
     * this from the selection alone.
     */
    credentialMode: ProviderCredentialMode
  }): OpenedTaskChild
  stop(sessionId: string): Promise<void>
  stopProcess(identity: ProcessIdentity): Promise<void>
  /**
   * Cumulative per-stream output since spawn, plus the daemon-owned exit facts.
   * Cumulative totals (rather than deltas) match the PTY scrollback discipline,
   * so a restarted reader cannot double-consume or skip bytes; exit is never
   * inferred from transport loss.
   */
  output(sessionId: string): { stdout: string; stderr: string; exited: boolean; exitCode?: number }
}

export type ProviderLaunchPorts = Readonly<{
  maintenance: ProviderMaintenancePort
  catalog: ProviderLaunchCatalogPort
  /** Resolves a driver's executable; undefined when discovery failed. */
  driverExecutable: (driverId: ProviderSelection['driverId']) => string | undefined
  /** Creates the private per-launch isolation root the child's home resolves into. */
  createIsolationRoot: (sessionId: string) => string
  removeIsolationRoot: (root: string) => void
  /** Driver-declared environment pointing inside the isolated root. */
  driverEnvironment?: (driverId: ProviderSelection['driverId'], root: string) => NodeJS.ProcessEnv
  /** Present only when this daemon has an authenticated broker; absent for `none`. */
  secrets?: ProviderSecretPort | null
  boundary: SecretOutputBoundary
  child: ProviderChildPort
}>

export type ProviderLaunchDisposition = 'completed' | 'failed' | 'cancelled' | 'superseded' | 'secret-unavailable' | 'launched'

export type ProviderLaunchOutcome = Readonly<{
  disposition: ProviderLaunchDisposition
  admission: ProviderLaunchAdmissionTuple | null
  sessionId: string | null
  exitCode: number | null
  /** Why a pre-spawn rejection produced no child; never secret material. */
  reason: string | null
  /**
   * Present for an interactive launch: resolves when the child's lifecycle pump
   * has settled. A caller that releases the child's retained state must await
   * this first, or the pump can read a deleted session and record a clean exit
   * as a failure.
   */
  completion?: Promise<void>
}>

/** Typed, retryable marker for a launch that no broker could authorize. */
export const SECRET_AUTHORITY_UNAVAILABLE = 'SECRET_AUTHORITY_UNAVAILABLE'

/**
 * Resolves one provider command spec into the exact program and argv a launch
 * runs, in every credential mode.
 *
 * A `driver` command is the only path that reaches driver-owned executable and
 * argument policy. Managed/none may never execute an arbitrary program, so a
 * non-driver command in those modes is refused here as defense in depth behind
 * the Catalog's own creation-time certification check.
 */
export function resolveProviderLaunchInvocation(
  command: ProviderLaunchPreparation['command'],
  credentialMode: ProviderCredentialMode,
  driverExecutable: (driverId: ProviderSelection['driverId']) => string | undefined,
  platform?: NodeJS.Platform
): ResolvedProviderInvocation {
  if (command.kind === 'driver') {
    return resolveProviderInvocation({
      command,
      driverExecutable: driverExecutable(command.driverId),
      ...(platform === undefined ? {} : { platform })
    })
  }
  if (credentialMode !== 'external') {
    throw new ProviderInvocationError('COMMAND_SHAPE_INVALID', `${credentialMode} mode requires a driver-owned command`)
  }
  return resolveProviderInvocation({ command, ...(platform === undefined ? {} : { platform }) })
}

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

/** Bounded, secret-free description of a refusal for attempt error text. */
function describeFailure(error: unknown): string {
  return authorityMessage(error).slice(0, 512)
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
  private readonly cancelCheckMs: number
  private readonly deliveredStops = new Set<string>()
  private readonly childKinds = new Map<string, 'finite-job' | 'acp-agent'>()
  private readonly provider: ProviderLaunchPorts | null

  constructor(options: Readonly<{
    authority: SqliteTaskAuthority
    ports: TaskLaunchPorts
    evidence: DaemonTaskEvidencePort
    resolveWorkspace?: (root: string) => string
    verifyIdentity?: (identity: ProcessIdentity) => ProcessIdentityVerdict
    outputLimitBytes?: number
    pumpPollMs?: number
    cancelCheckMs?: number
    /**
     * The provider-backed launch seam. Absent by default: a daemon without this
     * wiring simply has no provider path, which is the shipped state until
     * Task 4 migrates the production callers.
     */
    provider?: ProviderLaunchPorts
  }>) {
    this.authority = options.authority
    this.ports = options.ports
    this.evidence = options.evidence
    this.provider = options.provider ?? null
    this.resolveWorkspace = options.resolveWorkspace ?? ((root: string) => realpathSync.native(root))
    this.verifyIdentity = options.verifyIdentity ?? null
    this.outputLimitBytes = options.outputLimitBytes ?? 64 * 1024
    this.pumpPollMs = options.pumpPollMs ?? 10
    this.cancelCheckMs = options.cancelCheckMs ?? 250
  }

  /**
   * One provider-backed launch, end to end.
   *
   * The durable order is: maintenance admission (before any freeze), Catalog
   * preparation, the Task Authority admission that consumes it, and only then
   * the broker request. Every rejection before the OS spawn returns without a
   * child; a failure after it converges through the Stage 2 stop/quarantine
   * path rather than claiming the spawn was rolled back.
   *
   * This method is unreachable from production in Stage 3: no caller outside
   * this stage's direct tests supplies a selection.
   */
  async launchProviderBacked(input: Readonly<{
    lease: LeaseToken
    attemptId: string
    sessionId: string
    workspaceRoot: string
    selection: ProviderSelection
    connection: AuthenticatedAuthorityConnection
    /**
     * Interactive launches return as soon as the child is admitted and running,
     * because their lifetime is the user's session. The default waits for exit,
     * which is what a finite task child needs.
     */
    interactive?: boolean
  }>): Promise<ProviderLaunchOutcome> {
    const ports = this.provider
    if (!ports) return this.providerRejection(null, 'no provider-backed launch wiring is registered on this daemon')
    const operationId = `provider-launch:${input.sessionId}`
    let claim: { operationId: string; epoch: number; ownerConnectionId: string }
    try {
      claim = await ports.maintenance.admit('provider-authority', operationId)
    } catch (error) {
      return this.providerRejection(null, `maintenance admission refused: ${describeFailure(error)}`)
    }

    let admission: ProviderLaunchAdmissionTuple
    try {
      const preparation = ports.catalog.prepareLaunch({ selection: input.selection, attemptId: input.attemptId, sessionId: input.sessionId, purpose: 'agent-launch' })
      admission = this.authority.admitProviderLaunch({
        lease: input.lease,
        attemptId: input.attemptId,
        sessionId: input.sessionId,
        purpose: 'agent-launch',
        preparationId: preparation.id,
        maintenance: { operationId: claim.operationId, epoch: claim.epoch, ownerConnectionId: claim.ownerConnectionId }
      })
    } catch (error) {
      // The preparation and the attempt both rolled back; no child exists.
      await this.closeProviderMaintenance(claim, 'cancelled')
      return this.providerRejection(null, `launch admission refused: ${describeFailure(error)}`)
    }

    let invocation: ResolvedProviderInvocation
    try {
      invocation = resolveProviderLaunchInvocation(admission.command, admission.credentialMode, ports.driverExecutable)
    } catch (error) {
      await this.failProviderAttempt(input, admission, `provider invocation refused: ${describeFailure(error)}`)
      await this.closeProviderMaintenance(claim, 'cancelled')
      return this.providerRejection(admission, `provider invocation refused: ${describeFailure(error)}`)
    }

    let secrets: ProviderLaunchSecrets | null = null
    if (admission.credentialMode === 'managed') {
      const broker = ports.secrets
      if (!broker || !admission.credential) {
        await this.failProviderAttempt(input, admission, `${SECRET_AUTHORITY_UNAVAILABLE}: no authenticated credential broker is available`)
        await this.closeProviderMaintenance(claim, 'cancelled')
        return this.providerRejection(admission, SECRET_AUTHORITY_UNAVAILABLE)
      }
      try {
        secrets = await broker.materialize({
          launchAdmissionId: admission.id,
          preparationId: admission.preparationId,
          attemptId: admission.attemptId,
          sessionId: admission.sessionId,
          purpose: admission.purpose,
          driverId: admission.selection.driverId,
          providerInstanceId: admission.selection.providerInstanceId,
          instanceRevision: admission.selection.instanceRevision,
          accountId: admission.credential.accountId,
          accountRevision: admission.credential.accountRevision,
          credentialRef: admission.credential.credentialRef,
          bindingGeneration: admission.credential.bindingGeneration
        })
      } catch (error) {
        // Broker absence, timeout, stale reply, or a Secret Authority refusal.
        // No child is created, the attempt fails with a typed retryable reason,
        // and this path never falls back to inherited or file credentials,
        // another instance, another account, or the global default.
        await this.failProviderAttempt(input, admission, `${SECRET_AUTHORITY_UNAVAILABLE}: ${describeFailure(error)}`)
        await this.closeProviderMaintenance(claim, 'cancelled')
        return this.providerRejection(admission, SECRET_AUTHORITY_UNAVAILABLE)
      }
    }

    // Environment construction is mode-specific and this is the boundary that
    // makes it so. A managed or `none` child starts from a strict ALLOWLIST plus
    // one private isolated home/config root; an external child deliberately
    // keeps the driver's inherited external authentication, because that is what
    // `external` mode means.
    const isolationRoot = admission.credentialMode === 'external' ? null : ports.createIsolationRoot(input.sessionId)
    let environment: NodeJS.ProcessEnv
    if (isolationRoot === null) {
      environment = { ...process.env }
    } else {
      environment = isolatedProviderEnvironment({
        isolationRoot,
        inherited: process.env,
        driverEnvironment: ports.driverEnvironment?.(admission.selection.driverId, isolationRoot) ?? {},
        credentialEnvironment: secrets?.environment ?? {}
      })
    }
    // Exactly the broker's own values become redaction patterns, and the last
    // local reference to the plaintext beyond the child's own environment is
    // released as soon as the spawn has taken it.
    const managedValues = secrets === null ? [] : Object.values(secrets.environment)
    secrets = null
    if (managedValues.length > 0) ports.boundary.register(input.sessionId, managedValues)

    const releaseIsolation = (): void => {
      if (isolationRoot !== null) ports.removeIsolationRoot(isolationRoot)
      if (managedValues.length > 0) ports.boundary.close(input.sessionId)
    }

    // The Stage 2 launch-intent state check, immediately before spawn: a
    // cancellation committed before this point prevents the spawn.
    try {
      this.authority.beginSpawn({ token: input.lease, launchIntentId: admission.launchIntentId, expectedSpecificationId: admission.specificationId })
    } catch (error) {
      releaseIsolation()
      await this.closeProviderMaintenance(claim, 'cancelled')
      return this.providerRejection(admission, `launch-intent check refused: ${describeFailure(error)}`)
    }

    let opened: OpenedTaskChild
    try {
      opened = ports.child.open({
        sessionId: input.sessionId,
        workspaceRoot: input.workspaceRoot,
        invocation,
        environment,
        cols: this.providerCols,
        rows: this.providerRows,
        selection: admission.selection,
        credentialMode: admission.credentialMode
      })
    } catch (error) {
      releaseIsolation()
      await this.failProviderAttempt(input, admission, `provider child failed to start: ${describeFailure(error)}`)
      await this.closeProviderMaintenance(claim, 'cancelled')
      return this.providerRejection(admission, `provider child failed to start: ${describeFailure(error)}`)
    }

    // The OS spawn is a fact now. Ownership is taken here and every later
    // failure converges through stop + quarantine.
    this.authority.recordReturnedIdentity({
      projectId: input.lease.projectId,
      taskId: input.lease.taskId,
      attemptId: input.attemptId,
      sessionId: opened.sessionId,
      processIdentity: opened.processIdentity
    })

    try {
      if (opened.processIdentity === null) throw new TaskAuthorityError('RESOURCE_QUARANTINED', 'the provider child returned no process identity to bind')
      this.authority.write({ kind: 'bind-runtime', connection: input.connection, token: input.lease, sessionId: opened.sessionId, processIdentity: opened.processIdentity })
    } catch {
      return this.convergeProviderLoss(input, admission, opened, isolationRoot, claim, 'runtime bind was refused after the provider child started')
    }
    // An interactive launch returns as soon as the child is bound and running,
    // because its lifetime is the user's session. Its lifecycle obligations are
    // NOT skipped, though: a background pump settles them when the child exits —
    // flushing and closing the output boundary, releasing the isolation root,
    // closing the maintenance admission, and recording the attempt's terminal
    // result. Without that, every interactive launch would leak a live
    // admission, which fences every later migration and keeps the attempt
    // running forever.
    if (input.interactive === true) {
      const completion = this.pumpProviderToExit(input, admission, opened, isolationRoot, claim)
        .then(() => undefined)
        .catch(() => undefined)
      return { disposition: 'launched', admission, sessionId: opened.sessionId, exitCode: null, reason: null, completion }
    }
    return this.pumpProviderToExit(input, admission, opened, isolationRoot, claim)
  }

  private readonly providerCols = 100
  private readonly providerRows = 30

  /** Pumps redacted output to the child's exit, then records the fenced terminal state. */
  private async pumpProviderToExit(
    input: Readonly<{ lease: LeaseToken; attemptId: string; connection: AuthenticatedAuthorityConnection }>,
    admission: ProviderLaunchAdmissionTuple,
    opened: OpenedTaskChild,
    isolationRoot: string | null,
    claim: { operationId: string; epoch: number; ownerConnectionId: string }
  ): Promise<ProviderLaunchOutcome> {
    const ports = this.provider as ProviderLaunchPorts
    // Both streams share one bounded redactor but one combined pump, so the
    // retained output stays a single bounded view of the child's bytes.
    const pump = new SequencedTaskOutputPump(this.outputLimitBytes)
    let stdoutOffset = 0
    let stderrOffset = 0
    let exitCode: number | null = null
    for (;;) {
      const chunk = ports.child.output(opened.sessionId)
      // Backpressure and the output limit apply to the settled redacted bytes,
      // never to the redactor's retain window.
      const safeStdout = this.redactProviderChunk(opened.sessionId, 'stdout', chunk.stdout, stdoutOffset)
      const safeStderr = this.redactProviderChunk(opened.sessionId, 'stderr', chunk.stderr, stderrOffset)
      stdoutOffset = chunk.stdout.length
      stderrOffset = chunk.stderr.length
      if (safeStdout.length > 0) pump.append(safeStdout)
      if (safeStderr.length > 0) pump.append(safeStderr)
      if (chunk.exited) {
        exitCode = chunk.exitCode ?? null
        break
      }
      await this.delay(this.pumpPollMs)
    }
    // Every child output pipe has closed, so the residual undecided bytes are
    // safe to emit and the patterns/carry can be zeroized.
    for (const stream of ['stdout', 'stderr'] as const) {
      const residual = ports.boundary.flush(opened.sessionId, stream)
      if (residual.length > 0) pump.append(residual)
    }
    ports.boundary.close(opened.sessionId)
    if (isolationRoot !== null) ports.removeIsolationRoot(isolationRoot)
    await this.closeProviderMaintenance(claim, 'completed')

    const attempt = this.freshAttemptOrNull(input)
    if (attempt !== null && (attempt.state === 'cancelling' || attempt.state === 'cancelled')) {
      this.authority.acknowledgeExit({
        projectId: input.lease.projectId,
        taskId: input.lease.taskId,
        attemptId: input.attemptId,
        leaseId: input.lease.leaseId,
        generation: input.lease.generation,
        reason: 'coordinator observed the cancelled provider child exit'
      })
      return { disposition: 'cancelled', admission, sessionId: opened.sessionId, exitCode, reason: 'cancelled' }
    }
    try {
      if (exitCode === 0) {
        this.authority.write({ kind: 'complete', connection: input.connection, token: input.lease, result: { summary: `provider child exited 0 (admission ${admission.id})` } })
        return { disposition: 'completed', admission, sessionId: opened.sessionId, exitCode, reason: null }
      }
      this.authority.write({ kind: 'fail', connection: input.connection, token: input.lease, error: `provider child exited with code ${exitCode}` })
      return { disposition: 'failed', admission, sessionId: opened.sessionId, exitCode, reason: `exit ${exitCode}` }
    } catch (error) {
      return { disposition: 'superseded', admission, sessionId: opened.sessionId, exitCode, reason: describeFailure(error) }
    }
  }

  /** Redacts one stream's new bytes, or passes them through for a `none` launch. */
  private redactProviderChunk(sessionId: string, stream: 'stdout' | 'stderr', cumulative: string, consumed: number): string {
    const ports = this.provider as ProviderLaunchPorts
    const fresh = consumed > 0 && consumed <= cumulative.length ? cumulative.slice(consumed) : cumulative
    if (fresh.length === 0) return ''
    return ports.boundary.has(sessionId) ? ports.boundary.push(sessionId, stream, fresh) : fresh
  }

  /**
   * Converges a post-spawn loss: idempotent stop, then quarantine until the
   * exit is confirmed. The spawn is never claimed to have been rolled back.
   */
  private async convergeProviderLoss(
    input: Readonly<{ lease: LeaseToken; attemptId: string; connection: AuthenticatedAuthorityConnection }>,
    admission: ProviderLaunchAdmissionTuple,
    opened: OpenedTaskChild,
    isolationRoot: string | null,
    claim: { operationId: string; epoch: number; ownerConnectionId: string },
    reason: string
  ): Promise<ProviderLaunchOutcome> {
    const ports = this.provider as ProviderLaunchPorts
    ports.boundary.flush(opened.sessionId, 'stdout')
    ports.boundary.flush(opened.sessionId, 'stderr')
    ports.boundary.close(opened.sessionId)
    try {
      await ports.child.stop(opened.sessionId)
    } catch {
      if (opened.processIdentity !== null) {
        try { await ports.child.stopProcess(opened.processIdentity) } catch { /* quarantine records it below */ }
      }
    }
    if (isolationRoot !== null) ports.removeIsolationRoot(isolationRoot)
    await this.closeProviderMaintenance(claim, 'completed')
    this.authority.reconcileStartupAttempt({
      projectId: input.lease.projectId,
      taskId: input.lease.taskId,
      attemptId: input.attemptId,
      verdict: 'indeterminate',
      reason: `provider launch lost ownership: ${reason}`
    })
    return { disposition: 'cancelled', admission, sessionId: opened.sessionId, exitCode: null, reason }
  }

  /** Records a terminal retryable attempt failure through the fenced write path. */
  private async failProviderAttempt(
    input: Readonly<{ lease: LeaseToken; attemptId: string; connection: AuthenticatedAuthorityConnection }>,
    admission: ProviderLaunchAdmissionTuple,
    reason: string
  ): Promise<void> {
    try {
      this.authority.write({ kind: 'fail', connection: input.connection, token: input.lease, error: `${reason} (admission ${admission.id})` })
    } catch {
      // A superseded lease owns the attempt now; its own reconciliation applies.
    }
  }

  private freshAttemptOrNull(input: Readonly<{ lease: LeaseToken; connection: AuthenticatedAuthorityConnection }>): AttemptSnapshot | null {
    try {
      return this.freshTask(input.connection, input.lease.projectId, input.lease.taskId).currentAttempt
    } catch {
      return null
    }
  }

  /** Completes the maintenance admission exactly once, and never under a database lock. */
  private async closeProviderMaintenance(claim: { operationId: string; epoch: number; ownerConnectionId: string }, outcome: 'completed' | 'cancelled'): Promise<void> {
    const ports = this.provider
    if (!ports) return
    try {
      await ports.maintenance.complete(claim.operationId, claim.epoch, claim.ownerConnectionId, outcome)
    } catch {
      // A closed or already-reconciled admission is not a launch failure; the
      // gate's own reconciliation owns the residue.
    }
  }

  private providerRejection(admission: ProviderLaunchAdmissionTuple | null, reason: string): ProviderLaunchOutcome {
    return { disposition: 'failed', admission, sessionId: null, exitCode: null, reason }
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
    let lastCancelCheck = 0
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
      // A cancellation committed mid-run must stop the child now, not at
      // natural completion; delivery is idempotent per lease/generation.
      if (Date.now() - lastCancelCheck >= this.cancelCheckMs) {
        lastCancelCheck = Date.now()
        this.deliverStopIfCancelling(token, connection)
      }
      this.renewLeaseIfDue(token, connection)
      await this.delay(this.pumpPollMs)
    }

    this.evidence.assertReservedWorkspace(prepared.preObservation, prepared.canonicalResourceKey)
    const capture = this.evidence.capturePost(prepared.preObservation, pump.output, pump.truncated)
    // Cancellation may have been committed while the child was still running.
    // When the pump observes its exit: a still-cancelling attempt needs the
    // exit acknowledgement now; an already-cancelled attempt was closed by our
    // own mid-run stop delivery.
    const preExitTask = this.freshTask(connection, token.projectId, token.taskId)
    const preExitAttempt = preExitTask.currentAttempt
    const sameLease = preExitAttempt?.currentLease?.leaseId === token.leaseId && preExitAttempt.currentLease.generation === token.generation
    if (preExitAttempt !== null && sameLease && (preExitAttempt.state === 'cancelling' || preExitAttempt.state === 'cancelled')) {
      if (preExitAttempt.state === 'cancelling') {
        const updated = this.authority.acknowledgeExit({ projectId: token.projectId, taskId: token.taskId, attemptId: token.attemptId, leaseId: token.leaseId, generation: token.generation, reason: 'coordinator observed the cancelled child exit' })
        return { task: updated, attempt: updated.currentAttempt ?? preExitAttempt, sessionId: child.sessionId, exitCode, disposition: 'cancelled', output: pump.output }
      }
      return { task: preExitTask, attempt: preExitAttempt, sessionId: child.sessionId, exitCode, disposition: 'cancelled', output: pump.output }
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
        else if (identity !== null) await this.stopProcessByIdentity(identity)
        else throw new TaskAuthorityError('STALE_AUTHORITY', `attempt ${token.attemptId} holds no child session or process identity to stop`)
        delivered = true
      } catch (error) {
        lastError = error
        // The restarted daemon may no longer own the session in its PtyManager;
        // a committed cancellation stop falls back to the recorded identity.
        if (identity !== null && !delivered) {
          try {
            await this.stopProcessByIdentity(identity)
            delivered = true
          } catch (fallbackError) {
            lastError = fallbackError
          }
        }
      }
    }
    if (!delivered) {
      // A failed delivery must not latch: the next mid-run cancel check or
      // restart reconciliation re-delivers through the retained handle.
      this.deliveredStops.delete(key)
      throw lastError instanceof Error ? lastError : new Error(String(lastError))
    }
    return this.authority.acknowledgeExit({ projectId: token.projectId, taskId: token.taskId, attemptId: token.attemptId, leaseId: token.leaseId, generation: token.generation, reason: 'cancellation stop delivered and exit confirmed' })
  }

  private stopProcessByIdentity(identity: ProcessIdentity): Promise<void> {
    if (this.ports.jobs.stopProcess) return this.ports.jobs.stopProcess(identity)
    if (this.ports.agents?.stopProcess) return this.ports.agents.stopProcess(identity)
    return Promise.reject(new TaskAuthorityError('AUTHORIZATION_DENIED', 'no daemon port can stop a process by identity'))
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
          try {
            await this.deliverStop({ projectId: attempt.projectId, taskId: attempt.taskId, attemptId: attempt.attemptId, ownerId: attempt.currentLease!.ownerId, leaseId: attempt.currentLease!.leaseId, generation: attempt.currentLease!.generation, expiresAt: attempt.currentLease!.expiresAt }, attempt)
            events.push({ ...base, action: 'stop-retried', detail: 'committed cancellation stop re-delivered' })
          } catch (error) {
            // Committed stop delivery must never abort startup reconciliation;
            // the reservation stays held and delivery is retried on the next boot.
            events.push({ ...base, action: 'stop-retried', detail: 'committed cancellation stop redelivery failed: ' + authorityMessage(error).slice(0, 256) })
          }
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

  private deliverStopIfCancelling(token: LeaseToken, connection: AuthenticatedAuthorityConnection): void {
    let attempt: AttemptSnapshot | null
    try {
      attempt = this.freshTask(connection, token.projectId, token.taskId).currentAttempt
    } catch {
      return
    }
    if (attempt === null || attempt.state !== 'cancelling') return
    if (attempt.currentLease?.leaseId !== token.leaseId || attempt.currentLease.generation !== token.generation) return
    void this.deliverStop(token, attempt).catch(() => {
      // Stop delivery is retried by the next check and by restart reconciliation.
    })
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
  /** Expected-scheduling failure scopes reported so far; repeat ticks stay quiet. */
  private readonly expectedSchedulingReported = new Set<string>()

  constructor(private readonly authority: SqliteTaskAuthority, private readonly workerOwnerId: string, options: Readonly<{ now?: () => number; connectionId?: string }> = {}) {
    this.now = options.now ?? Date.now
    this.connectionId = options.connectionId ?? 'daemon-scheduler'
  }

  /**
   * Expected scheduling state (capacity, blocked, unfinished dependency) is
   * reported once per scope and then stays quiet across ticks; unexpected
   * failures are always reported.
   */
  private recordClaimFailure(scope: string, error: unknown, failures: Array<{ scope: string; error: string }>): void {
    if (error instanceof TaskAuthorityError && (error.code === 'CAPACITY_EXHAUSTED' || error.code === 'DEPENDENCY_BLOCKED' || error.code === 'TASK_NOT_RUNNABLE')) {
      if (!this.expectedSchedulingReported.has(scope)) {
        this.expectedSchedulingReported.add(scope)
        failures.push({ scope, error: authorityMessage(error) })
      }
      return
    }
    failures.push({ scope, error: authorityMessage(error) })
  }

  private static isCapacityExhausted(error: unknown): boolean {
    return error instanceof TaskAuthorityError && error.code === 'CAPACITY_EXHAUSTED'
  }

  private static executionScope(execution: Readonly<{ executionId: string }>): string {
    return `execution:${execution.executionId}`
  }

  private static memberScope(member: Readonly<{ projectId: string; taskId: string }>): string {
    return `run-member:${member.projectId}:${member.taskId}`
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
    const liveScopes = new Set<string>()
    for (const execution of queued.executions) {
      if (claimed.some(entry => entry.claim.task.taskId === execution.taskId)) continue
      const scope = TaskSchedulerPump.executionScope(execution)
      liveScopes.add(scope)
      try {
        // Queued executions are claimed from their own committed schedule state,
        // independent of the due list: manual executions never advance next_run_at,
        // and a due execution whose claim failed in the enqueuing tick retries here.
        const schedule = this.authority.readSchedule(execution.projectId, execution.scheduleId)
        const specification: TaskExecutionSpecificationInput = { command: schedule.command, target: schedule.target, verification: schedule.verification }
        claimed.push({
          claim: this.authority.claim({
            connection: { connectionId: `${this.connectionId}-worker`, role: 'worker', ownerId: this.workerOwnerId, authorizedProjectIds: [execution.projectId] },
            projectId: execution.projectId,
            taskId: execution.taskId,
            specification
          }),
          specification
        })
        this.expectedSchedulingReported.delete(scope)
      } catch (error) {
        this.recordClaimFailure(scope, error, failures)
      }
    }
    // Queued run-group members with a committed immutable specification are
    // fanned out by the daemon worker; profile-wide capacity is enforced inside
    // the claim transaction. Capacity rejection is expected scheduling state,
    // not a failure: the whole group is skipped for the rest of this tick and
    // retried on the next one. Members without a specification await an
    // external worker that brings its own.
    const members = this.authority.listQueuedRunMembers()
    const capacityBlockedGroups = new Set<string>()
    for (const member of members) {
      if (member.specification === null) continue
      if (claimed.some(entry => entry.claim.task.taskId === member.taskId)) continue
      if (capacityBlockedGroups.has(member.runGroupId)) continue
      const scope = TaskSchedulerPump.memberScope(member)
      liveScopes.add(scope)
      try {
        claimed.push({
          claim: this.authority.claim({
            connection: { connectionId: `${this.connectionId}-worker`, role: 'worker', ownerId: this.workerOwnerId, authorizedProjectIds: [member.projectId] },
            projectId: member.projectId,
            taskId: member.taskId,
            specification: member.specification
          }),
          specification: member.specification
        })
        this.expectedSchedulingReported.delete(scope)
      } catch (error) {
        if (TaskSchedulerPump.isCapacityExhausted(error)) {
          capacityBlockedGroups.add(member.runGroupId)
        }
        this.recordClaimFailure(scope, error, failures)
      }
    }
    // Scopes absent from this tick's queued set left it for any reason — claimed
    // by the pump, claimed by another worker, completed, or cancelled. Their
    // condition resolved, so a future re-queue (for example a run-group retry)
    // must be able to report again; still-queued blocked scopes stay quiet.
    for (const scope of this.expectedSchedulingReported) {
      if (!liveScopes.has(scope)) this.expectedSchedulingReported.delete(scope)
    }
    return { enqueued, claimed, failures }
  }
}
