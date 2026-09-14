import { ACP_DAEMON_CAPABILITY, parseAcpAgentSnapshot, parseAcpObservation, parseAcpPromptRecord, parseAgentModeSwitchReceipt, parseAgentTaskIntent, type AgentTaskIntent, parseAgentExecutable } from '@shared/agent-runtime'
import type { ChildProcess } from 'node:child_process'
import { createConnection, type Socket } from 'node:net'
import { forceTerminateProcessTree } from '@shared/child-process/process-tree-termination'
import { existsSync } from 'node:fs'
import { RuntimeOwnershipStore } from '@shared/runtime-ownership'
import { canonicalPrivateDirectory } from '@shared/runtime-file-security'
import { runtimeIdentityAuthority } from './runtime-identity'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type {
  AgentSessionCredential,
  AgentProviderId,
  AgentExecutable,
  AgentStartResult,
  RunningAgent
} from '@shared/agent-runtime'
import type { AcpAgentSnapshot, AcpObservation, AcpPromptRecord, AuthenticatedAgentSession, AgentModeSwitchReceipt } from '@shared/agent-runtime'
import type { McpServer } from '@agentclientprotocol/sdk'
import {
  ATTENTION_INBOX_CAPABILITY,
  parseAttentionAcknowledgeRequest,
  parseAttentionInboxSnapshot,
  type AttentionAcknowledgeRequest,
  type AttentionAcknowledgeResult,
  type AttentionInboxListResult
} from '@shared/attention-inbox'
import type { TerminalSession } from '@shared/types'
import type { TerminalReplayChunk } from '@shared/terminal-stream'
import type { ProcessIdentity } from '@shared/child-process/process-spec'
import { sanitizedProcessEnv } from '@shared/child-process/process-environment'
import { spawnProcess } from '@shared/child-process/run-process'
import { readRuntimeRecord, localRuntimePaths, type LocalRuntimeRecord } from './local-runtime'
import { logger } from '@shared/logger'
import { reconcileRuntimeOwner } from './runtime-ownership'
import type {
  AttemptSnapshot,
  ClaimResult,
  HandoffOffer,
  LeaseSnapshot,
  LeaseToken,
  RunGroupSnapshot,
  ScheduleExecutionSnapshot,
  ScheduleSnapshot,
  TaskExecutionSpecificationInput,
  TaskMailboxEntry,
  TaskProjection,
  TaskScheduleCadence,
  TaskScheduleSpec,
  TaskSnapshot,
  TaskStatus,
  VerificationArtifactInput
} from '@shared/task-authority'

/** Daemon protocol capability that activates the task authority command surface. */
const TASK_AUTHORITY = 'task-authority-v1'
/** App-side transport for the detached terminal daemon. */

export type DaemonEvents = {
  acp?: (snapshot: AcpAgentSnapshot) => void
  disconnected?: () => void
  data: (sessionId: string, data: string, sequence?: number) => void
  exit: (sessionId: string, exitCode?: number) => void
  title: (sessionId: string, title: string) => void
  agent: (run: RunningAgent) => void
  agentDismissed: (sessionId: string) => void
}

export type DaemonClientOptions = {
  requestTimeoutMs?: number
  handshakeTimeoutMs?: number
}

export type DaemonJobResult = {
  exited: boolean
  exitCode?: number
  output: string
  sequence: number
}

export type DaemonStatus = {
  pid: number
  idle: boolean
  sessionCount: number
  liveSessionCount: number
}

type Pending = {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

type Handshake = {
  ok?: boolean
  id?: unknown
  capabilities?: unknown
  protocolVersion?: unknown
  runtimeIdentityContractVersion?: unknown
  ownerId?: unknown
  generation?: unknown
  processIdentity?: unknown
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 1_000
const SEQUENCED_OUTPUT = 'sequenced-output'
const ONESHOT_JOBS = 'oneshot-jobs'
const AGENT_RUNS = 'agent-runs-v1'
const AGENT_INPUT = 'agent-input-v1'
const MAX_TRANSPORT_BUFFER_BYTES = 2 * 1024 * 1024

/** Sanitized liveness facts about an older daemon that blocks task authority activation. */
export type SanitizedDaemonStatus = Readonly<{ pid: number | null; idle: boolean; sessionCount: number; liveSessionCount: number }>

/** Daemon-issued per-session worker credential forwarded by worker clients. */
export type TaskWorkerCredential = Readonly<{ credentialId: string; token: string }>

/** Raised when an older authenticated daemon owns live sessions and must exit before task authority activation. */
export class DaemonUpgradeRequiredError extends Error {
  readonly code = 'DAEMON_UPGRADE_REQUIRED'
  readonly status: SanitizedDaemonStatus

  constructor(status: SanitizedDaemonStatus) {
    super(`terminal daemon owns live sessions and blocks task authority activation until they exit (pid=${status.pid ?? 'unknown'}, sessions=${status.sessionCount}, live=${status.liveSessionCount})`)
    this.name = 'DaemonUpgradeRequiredError'
    this.status = status
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
} {
  return Promise.withResolvers<T>()
}

function delay(ms: number): Promise<void> {
  const result = Promise.withResolvers<void>()
  setTimeout(result.resolve, ms)
  return result.promise
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  const completion = Promise.withResolvers<boolean>()
  const onClose = (): void => {
    clearTimeout(timer)
    completion.resolve(true)
  }
  const timer = setTimeout(() => {
    child.removeListener('close', onClose)
    completion.resolve(false)
  }, timeoutMs)
  timer.unref?.()
  child.once('close', onClose)
  return completion.promise
}

export async function terminateSpawnedChild(child: ChildProcess): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  let terminated = false
  try {
    terminated = await forceTerminateProcessTree(child)
  } catch {
    terminated = false
  }
  const exited = await waitForChildExit(child, 2_000)
  return terminated && exited
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRunningAgent(value: unknown): value is RunningAgent {
  if (!isRecord(value) || !isRecord(value['hook']) || !Array.isArray(value['hook']['events'])) return false
  const activity = value['activity']
  const liveness = value['liveness']
  const support = value['hook']['support']
  return typeof value['id'] === 'string'
    && typeof value['sessionId'] === 'string'
    && typeof value['workspacePath'] === 'string'
    && typeof value['command'] === 'string'
    && typeof value['startedAt'] === 'string'
    && typeof value['updatedAt'] === 'string'
    && (liveness === 'live' || liveness === 'unverifiable' || liveness === 'exited')
    && (activity === 'starting' || activity === 'working' || activity === 'waiting'
      || activity === 'permission' || activity === 'stopping' || activity === 'completed' || activity === 'failed')
    && (support === 'native' || support === 'unavailable')
    && typeof value['hook']['connected'] === 'boolean'
    && value['hook']['events'].every((event) => (
      event === 'working' || event === 'waiting' || event === 'permission'
      || event === 'completed' || event === 'failed'
    ))
}

function requireRunningAgent(value: unknown): RunningAgent {
  if (!isRunningAgent(value)) throw new Error('terminal daemon returned an invalid agent record')
  return { ...structuredClone(value), ...(value.task === undefined ? {} : { task: parseAgentTaskIntent(value.task) }), ...(value.launch === undefined ? {} : { launch: parseAgentExecutable(value.launch) }) }
}

function parseWireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`terminal daemon returned an invalid ${label}`)
  return value as Record<string, unknown>
}

function parseWireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`terminal daemon returned an invalid ${label}`)
  return value
}

function parseWireText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`terminal daemon returned an invalid ${label}`)
  return value
}

function parseWireStringOrNull(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null
  return parseWireString(value, label)
}

function parseWireInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`terminal daemon returned an invalid ${label}`)
  return value
}

function parseWireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`terminal daemon returned an invalid ${label}`)
  return value
}

function parseWireStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`terminal daemon returned an invalid ${label}`)
  return value.map((entry, index) => parseWireString(entry, `${label}[${index}]`))
}

function parseWireEnum<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  const parsed = parseWireString(value, label)
  if (!allowed.includes(parsed as T)) throw new Error(`terminal daemon returned an invalid ${label}`)
  return parsed as T
}

const ATTEMPT_STATES = ['claimed', 'launching', 'running', 'cancelling', 'cancelled', 'exited', 'completed', 'failed', 'quarantined'] as const
const TASK_STATUSES = ['todo', 'blocked', 'in-progress', 'cancelling', 'cancelled', 'done', 'failed', 'quarantined'] as const
const LAUNCH_INTENT_STATES = ['planned', 'spawning', 'reconciling-no-spawn', 'stopped'] as const
const LAUNCH_STOP_STATES = ['none', 'requested', 'exited'] as const
const RESERVATION_STATES = ['reserved', 'quarantined', 'released'] as const
const HANDOFF_STATUSES = ['pending', 'accepted', 'cancelled', 'expired'] as const
const EXECUTION_STATES = ['queued', 'running', 'cancelling', 'cancelled', 'succeeded', 'failed'] as const
const RUN_GROUP_STATES = ['active', 'cancelling', 'cancelled', 'completed'] as const
const RUN_MEMBER_STATES = ['queued', 'claimed', 'launching', 'running', 'cancelling', 'cancelled', 'completed', 'failed', 'quarantined'] as const
const MAILBOX_KINDS = ['attention', 'progress', 'artifact', 'system'] as const

function parseLeaseTokenWire(value: unknown): LeaseToken {
  const record = parseWireRecord(value, 'lease token')
  return {
    projectId: parseWireString(record['projectId'], 'token.projectId'),
    taskId: parseWireString(record['taskId'], 'token.taskId'),
    attemptId: parseWireString(record['attemptId'], 'token.attemptId'),
    ownerId: parseWireString(record['ownerId'], 'token.ownerId'),
    leaseId: parseWireString(record['leaseId'], 'token.leaseId'),
    generation: parseWireInteger(record['generation'], 'token.generation'),
    expiresAt: parseWireString(record['expiresAt'], 'token.expiresAt')
  }
}

function parseLeaseSnapshotWire(value: unknown): LeaseSnapshot {
  const record = parseWireRecord(value, 'lease snapshot')
  return {
    leaseId: parseWireString(record['leaseId'], 'lease.leaseId'),
    ownerId: parseWireString(record['ownerId'], 'lease.ownerId'),
    generation: parseWireInteger(record['generation'], 'lease.generation'),
    issuedAt: parseWireString(record['issuedAt'], 'lease.issuedAt'),
    expiresAt: parseWireString(record['expiresAt'], 'lease.expiresAt'),
    expiresAtMs: parseWireInteger(record['expiresAtMs'], 'lease.expiresAtMs')
  }
}

function parseProcessIdentityWire(value: unknown): ProcessIdentity | null {
  if (value === null || value === undefined) return null
  const record = parseWireRecord(value, 'process identity')
  const family = parseWireString(record['family'], 'processIdentity.family')
  if (family !== 'donwells-app' && family !== 'terminal-daemon' && family !== 'acp-agent') {
    throw new Error('terminal daemon returned an invalid processIdentity.family')
  }
  return {
    pid: parseWireInteger(record['pid'], 'processIdentity.pid'),
    bootId: parseWireString(record['bootId'], 'processIdentity.bootId'),
    startedAt: parseWireString(record['startedAt'], 'processIdentity.startedAt'),
    executablePath: parseWireString(record['executablePath'], 'processIdentity.executablePath'),
    family,
    capturedAt: parseWireString(record['capturedAt'], 'processIdentity.capturedAt'),
    ...(record['generation'] === undefined ? {} : { generation: parseWireString(record['generation'], 'processIdentity.generation') })
  }
}

function parseAttemptSnapshotWire(value: unknown): AttemptSnapshot {
  const record = parseWireRecord(value, 'attempt snapshot')
  let runtime: AttemptSnapshot['runtime'] = null
  if (record['runtime'] !== null && record['runtime'] !== undefined) {
    const runtimeRecord = parseWireRecord(record['runtime'], 'attempt.runtime')
    const launchState = runtimeRecord['launchState']
    runtime = {
      sessionId: parseWireStringOrNull(runtimeRecord['sessionId'], 'attempt.runtime.sessionId'),
      processIdentity: parseProcessIdentityWire(runtimeRecord['processIdentity']),
      launchIntentId: parseWireStringOrNull(runtimeRecord['launchIntentId'], 'attempt.runtime.launchIntentId'),
      launchState: launchState === null || launchState === undefined ? null : parseWireEnum(launchState, 'attempt.runtime.launchState', LAUNCH_INTENT_STATES),
      stopState: runtimeRecord['stopState'] === null || runtimeRecord['stopState'] === undefined ? null : parseWireEnum(runtimeRecord['stopState'], 'attempt.runtime.stopState', LAUNCH_STOP_STATES)
    }
  }
  let reservation: AttemptSnapshot['reservation'] = null
  if (record['reservation'] !== null && record['reservation'] !== undefined) {
    const reservationRecord = parseWireRecord(record['reservation'], 'attempt.reservation')
    reservation = {
      resourceKey: parseWireString(reservationRecord['resourceKey'], 'attempt.reservation.resourceKey'),
      canonicalResourceKey: parseWireString(reservationRecord['canonicalResourceKey'], 'attempt.reservation.canonicalResourceKey'),
      state: parseWireEnum(reservationRecord['state'], 'attempt.reservation.state', RESERVATION_STATES)
    }
  }
  return {
    projectId: parseWireString(record['projectId'], 'attempt.projectId'),
    taskId: parseWireString(record['taskId'], 'attempt.taskId'),
    attemptId: parseWireString(record['attemptId'], 'attempt.attemptId'),
    sequence: parseWireInteger(record['sequence'], 'attempt.sequence'),
    retryOfAttemptId: parseWireStringOrNull(record['retryOfAttemptId'], 'attempt.retryOfAttemptId'),
    provenance: parseWireEnum(record['provenance'], 'attempt.provenance', ['native', 'imported-legacy'] as const),
    state: parseWireEnum(record['state'], 'attempt.state', ATTEMPT_STATES),
    specificationId: parseWireString(record['specificationId'], 'attempt.specificationId'),
    currentLease: record['currentLease'] === null || record['currentLease'] === undefined ? null : parseLeaseSnapshotWire(record['currentLease']),
    runtime,
    reservation,
    lastProgress: parseWireStringOrNull(record['lastProgress'], 'attempt.lastProgress'),
    startedAt: parseWireString(record['startedAt'], 'attempt.startedAt'),
    finishedAt: parseWireStringOrNull(record['finishedAt'], 'attempt.finishedAt')
  }
}

function parseTaskSnapshotWire(value: unknown): TaskSnapshot {
  const record = parseWireRecord(value, 'task snapshot')
  const status = parseWireEnum(record['status'], 'task.status', TASK_STATUSES)
  return {
    projectId: parseWireString(record['projectId'], 'task.projectId'),
    taskId: parseWireString(record['taskId'], 'task.taskId'),
    externalTaskId: parseWireString(record['externalTaskId'], 'task.externalTaskId'),
    title: parseWireString(record['title'], 'task.title'),
    body: parseWireText(record['body'], 'task.body'),
    status,
    priority: parseWireInteger(record['priority'], 'task.priority'),
    dependencies: parseWireStringArray(record['dependencies'], 'task.dependencies'),
    dependencyBlocked: parseWireBoolean(record['dependencyBlocked'], 'task.dependencyBlocked'),
    runnable: parseWireBoolean(record['runnable'], 'task.runnable'),
    cancelState: parseWireEnum(record['cancelState'], 'task.cancelState', ['none', 'requested'] as const),
    currentAttempt: record['currentAttempt'] === null || record['currentAttempt'] === undefined ? null : parseAttemptSnapshotWire(record['currentAttempt']),
    entityVersion: parseWireInteger(record['entityVersion'], 'task.entityVersion'),
    createdAt: parseWireString(record['createdAt'], 'task.createdAt'),
    updatedAt: parseWireString(record['updatedAt'], 'task.updatedAt')
  }
}

function parseTaskProjectionWire(value: unknown): TaskProjection {
  const record = parseWireRecord(value, 'task projection')
  if (!Array.isArray(record['tasks'])) throw new Error('terminal daemon returned an invalid task projection')
  return { tasks: record['tasks'].map(parseTaskSnapshotWire), nextCursor: parseWireStringOrNull(record['nextCursor'], 'projection.nextCursor') }
}

function parseClaimResultWire(value: unknown): ClaimResult {
  const record = parseWireRecord(value, 'claim result')
  return { task: parseTaskSnapshotWire(record['task']), attempt: parseAttemptSnapshotWire(record['attempt']), token: parseLeaseTokenWire(record['token']) }
}

function parseScheduleSnapshotWire(value: unknown): ScheduleSnapshot {
  const record = parseWireRecord(value, 'schedule snapshot')
  const cadenceRecord = parseWireRecord(record['cadence'], 'schedule.cadence')
  const cadence: TaskScheduleCadence = cadenceRecord['kind'] === 'interval'
    ? { kind: 'interval', minutes: parseWireInteger(cadenceRecord['minutes'], 'schedule.cadence.minutes') }
    : { kind: 'daily', time: parseWireString(cadenceRecord['time'], 'schedule.cadence.time'), timeZone: parseWireString(cadenceRecord['timeZone'], 'schedule.cadence.timeZone') }
  const commandRecord = parseWireRecord(record['command'], 'schedule.command')
  const targetRecord = parseWireRecord(record['target'], 'schedule.target')
  const verificationRecord = parseWireRecord(record['verification'], 'schedule.verification')
  if (!Array.isArray(verificationRecord['requiredArtifacts'])) throw new Error('terminal daemon returned an invalid schedule verification')
  const spec: TaskScheduleSpec = {
    profileId: parseWireString(record['profileId'], 'schedule.profileId'),
    taskTitle: parseWireString(record['taskTitle'], 'schedule.taskTitle'),
    cadence,
    command: {
      program: parseWireString(commandRecord['program'], 'schedule.command.program'),
      args: parseWireStringArray(commandRecord['args'], 'schedule.command.args'),
      ...(commandRecord['cwd'] === undefined ? {} : { cwd: parseWireString(commandRecord['cwd'], 'schedule.command.cwd') })
    },
    target: targetRecord['kind'] === 'local'
      ? { kind: 'local', root: parseWireString(targetRecord['root'], 'schedule.target.root'), label: parseWireString(targetRecord['label'], 'schedule.target.label') }
      : { kind: 'remote', connectionId: parseWireString(targetRecord['connectionId'], 'schedule.target.connectionId'), root: parseWireString(targetRecord['root'], 'schedule.target.root'), label: parseWireString(targetRecord['label'], 'schedule.target.label') },
    verification: {
      requiredArtifacts: verificationRecord['requiredArtifacts'].map((artifact, index) => {
        const artifactRecord = parseWireRecord(artifact, `schedule.verification.requiredArtifacts[${index}]`)
        return {
          path: parseWireString(artifactRecord['path'], `schedule.verification[${index}].path`),
          relationship: parseWireEnum(artifactRecord['relationship'], `schedule.verification[${index}].relationship`, ['attached-reference', 'observed-during-run'] as const)
        }
      })
    }
  }
  return {
    scheduleId: parseWireString(record['scheduleId'], 'schedule.scheduleId'),
    projectId: parseWireString(record['projectId'], 'schedule.projectId'),
    profileId: spec.profileId,
    taskTitle: spec.taskTitle,
    cadence: spec.cadence,
    command: spec.command,
    target: spec.target,
    verification: spec.verification,
    enabled: parseWireBoolean(record['enabled'], 'schedule.enabled'),
    entityVersion: parseWireInteger(record['entityVersion'], 'schedule.entityVersion'),
    nextRunAt: parseWireStringOrNull(record['nextRunAt'], 'schedule.nextRunAt'),
    createdAt: parseWireString(record['createdAt'], 'schedule.createdAt'),
    updatedAt: parseWireString(record['updatedAt'], 'schedule.updatedAt')
  }
}

function parseScheduleExecutionWire(value: unknown): ScheduleExecutionSnapshot {
  const record = parseWireRecord(value, 'schedule execution')
  return {
    projectId: parseWireString(record['projectId'], 'execution.projectId'),
    scheduleId: parseWireString(record['scheduleId'], 'execution.scheduleId'),
    executionId: parseWireString(record['executionId'], 'execution.executionId'),
    trigger: parseWireEnum(record['trigger'], 'execution.trigger', ['due', 'manual'] as const),
    idempotencyKey: parseWireString(record['idempotencyKey'], 'execution.idempotencyKey'),
    intentSha256: parseWireString(record['intentSha256'], 'execution.intentSha256'),
    taskId: parseWireString(record['taskId'], 'execution.taskId'),
    attemptId: parseWireStringOrNull(record['attemptId'], 'execution.attemptId'),
    dueAt: parseWireStringOrNull(record['dueAt'], 'execution.dueAt'),
    state: parseWireEnum(record['state'], 'execution.state', EXECUTION_STATES),
    entityVersion: parseWireInteger(record['entityVersion'], 'execution.entityVersion'),
    createdAt: parseWireString(record['createdAt'], 'execution.createdAt')
  }
}

function parseRunGroupWire(value: unknown): RunGroupSnapshot {
  const record = parseWireRecord(value, 'run group')
  if (!Array.isArray(record['members'])) throw new Error('terminal daemon returned an invalid run group')
  return {
    runGroupId: parseWireString(record['runGroupId'], 'runGroup.runGroupId'),
    profileId: parseWireString(record['profileId'], 'runGroup.profileId'),
    name: parseWireString(record['name'], 'runGroup.name'),
    retryOfRunGroupId: parseWireStringOrNull(record['retryOfRunGroupId'], 'runGroup.retryOfRunGroupId'),
    concurrency: parseWireInteger(record['concurrency'], 'runGroup.concurrency'),
    state: parseWireEnum(record['state'], 'runGroup.state', RUN_GROUP_STATES),
    entityVersion: parseWireInteger(record['entityVersion'], 'runGroup.entityVersion'),
    members: record['members'].map((member, index) => {
      const memberRecord = parseWireRecord(member, `runGroup.members[${index}]`)
      return {
        projectId: parseWireString(memberRecord['projectId'], `runGroup.members[${index}].projectId`),
        taskId: parseWireString(memberRecord['taskId'], `runGroup.members[${index}].taskId`),
        attemptId: parseWireStringOrNull(memberRecord['attemptId'], `runGroup.members[${index}].attemptId`),
        ordinal: parseWireInteger(memberRecord['ordinal'], `runGroup.members[${index}].ordinal`),
        state: parseWireEnum(memberRecord['state'], `runGroup.members[${index}].state`, RUN_MEMBER_STATES)
      }
    }),
    createdAt: parseWireString(record['createdAt'], 'runGroup.createdAt'),
    updatedAt: parseWireString(record['updatedAt'], 'runGroup.updatedAt')
  }
}

function parseHandoffOfferWire(value: unknown): HandoffOffer {
  const record = parseWireRecord(value, 'handoff offer')
  return {
    offerId: parseWireString(record['offerId'], 'offer.offerId'),
    projectId: parseWireString(record['projectId'], 'offer.projectId'),
    taskId: parseWireString(record['taskId'], 'offer.taskId'),
    attemptId: parseWireString(record['attemptId'], 'offer.attemptId'),
    sourceOwnerId: parseWireString(record['sourceOwnerId'], 'offer.sourceOwnerId'),
    targetOwnerId: parseWireString(record['targetOwnerId'], 'offer.targetOwnerId'),
    sourceLeaseId: parseWireString(record['sourceLeaseId'], 'offer.sourceLeaseId'),
    sourceGeneration: parseWireInteger(record['sourceGeneration'], 'offer.sourceGeneration'),
    status: parseWireEnum(record['status'], 'offer.status', HANDOFF_STATUSES),
    expiresAt: parseWireString(record['expiresAt'], 'offer.expiresAt'),
    createdAt: parseWireString(record['createdAt'], 'offer.createdAt'),
    resolvedAt: parseWireStringOrNull(record['resolvedAt'], 'offer.resolvedAt')
  }
}

function parseMailboxEntryWire(value: unknown): TaskMailboxEntry {
  const record = parseWireRecord(value, 'mailbox entry')
  const payload = record['payload']
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new Error('terminal daemon returned an invalid mailbox payload')
  return {
    entryId: parseWireString(record['entryId'], 'mailbox.entryId'),
    projectId: parseWireString(record['projectId'], 'mailbox.projectId'),
    taskId: parseWireString(record['taskId'], 'mailbox.taskId'),
    attemptId: parseWireStringOrNull(record['attemptId'], 'mailbox.attemptId'),
    leaseId: parseWireStringOrNull(record['leaseId'], 'mailbox.leaseId'),
    generation: record['generation'] === null || record['generation'] === undefined ? null : parseWireInteger(record['generation'], 'mailbox.generation'),
    kind: parseWireEnum(record['kind'], 'mailbox.kind', MAILBOX_KINDS),
    payload: payload as Record<string, unknown>,
    acknowledgedAt: parseWireStringOrNull(record['acknowledgedAt'], 'mailbox.acknowledgedAt'),
    createdAt: parseWireString(record['createdAt'], 'mailbox.createdAt')
  }
}

export class DaemonClient {
  private socket: Socket | null = null
  private pending = new Map<string, Pending>()
  private buffer = ''
  private connecting: Promise<void> | null = null
  private spawnedChild: ChildProcess | null = null
  private capabilities = new Set<string>()
  private connectedEndpoint: string | null = null
  private readonly requestTimeoutMs: number
  private readonly handshakeTimeoutMs: number
  constructor(
    private userDataDir: string,
    private events: DaemonEvents,
    private daemonEntryPath: string,
    options: DaemonClientOptions = {}
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
  }

  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return
    if (this.connecting) return this.connecting
    this.connecting = this.connectInner().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private async connectInner(): Promise<void> {
    const paths = localRuntimePaths(canonicalPrivateDirectory(this.userDataDir, { requireCanonical: true }), 'terminal')
    const record = readRuntimeRecord(paths.runtimeFile)
    if (record.status === 'legacy') {
      const ownership = new RuntimeOwnershipStore(paths.ownershipDatabasePath)
      try {
        if (ownership.observe('terminal-daemon').status !== 'vacant') {
          throw new Error('Legacy runtime locator conflicts with the recorded authority owner')
        }
      } finally {
        ownership.close()
      }
    }
    if (record.status === 'legacy') {
      const connected = await this.tryConnect(record.record.socketPath, record.record.authToken, undefined, true).catch(() => false)
      if (connected) return
    }
    if (record.status === 'current') {
      // Contact the advertised endpoint first; native identity alone is not liveness evidence.
      const connected = await this.tryConnect(record.record.socketPath, record.record.authToken, record.record).catch(() => false)
      if (connected) {
        let ownership: RuntimeOwnershipStore | null = null
        try {
          ownership = new RuntimeOwnershipStore(paths.ownershipDatabasePath, { readOnly: true })
          ownership.resolveActive('terminal-daemon', record.record, record.sha256)
          return
        } catch {
          // Endpoint contact is not sufficient: the exact locator must still resolve to an active row.
          this.disconnect()
        } finally {
          ownership?.close()
        }
      }
    }

    const ownership = new RuntimeOwnershipStore(paths.ownershipDatabasePath)
    try {
      const reconciled = await reconcileRuntimeOwner({
        userDataDir: this.userDataDir,
        kind: 'terminal-daemon',
        authority: runtimeIdentityAuthority(),
        store: ownership
      })
      if (reconciled.action !== 'claim') throw new Error('terminal daemon recovery requires the existing owner process')
    } finally {
      ownership.close()
    }
    if (record.status === 'missing' && process.platform !== 'win32' && existsSync(paths.socketPath)) {
      throw new Error('terminal daemon socket ownership is unverifiable; it was not replaced')
    }
    const token = randomUUID() + randomUUID().slice(0, 8)
    const child = spawnProcess({
      program: process.execPath,
      args: [this.daemonEntryPath, this.userDataDir],
      detached: true,
      stdio: 'ignore',
      env: sanitizedProcessEnv(process.env, {
        DONWELLS_DAEMON_TOKEN: token,
        ELECTRON_RUN_AS_NODE: '1'
      })
    })
    const spawned = Promise.withResolvers<void>()
    const onSpawn = (): void => {
      child.removeListener('error', onError)
      spawned.resolve()
    }
    const onError = (error: Error): void => {
      child.removeListener('spawn', onSpawn)
      spawned.reject(new Error('terminal daemon spawn failed: ' + error.message, { cause: error }))
    }
    child.once('spawn', onSpawn)
    child.once('error', onError)

    try {
      await spawned.promise
      this.spawnedChild = child
      child.unref()

      const deadline = Date.now() + 10_000
      while (Date.now() <= deadline) {
        const published = readRuntimeRecord(paths.runtimeFile)
        if (published.status === 'current' && published.record.authToken === token && await this.tryConnect(published.record.socketPath, token, published.record).catch(() => false)) return
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(
            'terminal daemon exited during startup (code=' + (child.exitCode ?? 'null') +
            ', signal=' + (child.signalCode ?? 'null') + ')'
          )
        }
        await delay(100)
      }
      throw new Error('terminal daemon connection timed out after 10000ms')
    } catch (error) {
      if (this.spawnedChild === child) this.spawnedChild = null
      if (child.pid) {
        const cleaned = await terminateSpawnedChild(child)
        if (!cleaned) {
          throw new Error('terminal daemon startup failed and child termination could not be verified', { cause: error })
        }
      }
      throw error
    }
  }

  private tryConnect(socketPath: string, authToken: string, expected?: LocalRuntimeRecord, allowLegacy = false): Promise<boolean> {
    const completion = deferred<boolean>()
    const socket = createConnection(socketPath)
    const helloId = randomUUID()
    const decoder = new StringDecoder('utf8')
    let buffer = ''
    let settled = false

    const finish = (connected: boolean, handshake?: Handshake): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeListener('connect', onConnect)
      socket.removeListener('data', onData)
      socket.removeListener('error', onFailure)
      socket.removeListener('close', onFailure)

      const handshakeMatches = connected && (
        (allowLegacy && handshake?.ok === true && handshake.protocolVersion === 3 && !Object.hasOwn(handshake, 'runtimeIdentityContractVersion'))
        || (expected !== undefined
          && handshake?.protocolVersion === 3
          && handshake.runtimeIdentityContractVersion === 1
          && handshake.ownerId === expected.ownerId
          && handshake.generation === expected.ownerGeneration
          && JSON.stringify(handshake.processIdentity) === JSON.stringify(expected.processIdentity))
      )
      if (!handshakeMatches) {
        socket.destroy()
        completion.resolve(false)
        return
      }

      const capabilities = Array.isArray(handshake?.capabilities)
        ? handshake.capabilities.filter((value): value is string => typeof value === 'string')
        : []
      this.capabilities = new Set(capabilities)
      this.socket = socket
      this.connectedEndpoint = socketPath
      this.wireSocket(socket, buffer, decoder)
      completion.resolve(true)
    }
    const onConnect = (): void => {
      this.rawSend(socket, { id: helloId, op: 'hello', authToken })
    }
    const onFailure = (): void => finish(false)
    const onData = (chunk: Buffer): void => {
      buffer += decoder.write(chunk)
      if (Buffer.byteLength(buffer) > MAX_TRANSPORT_BUFFER_BYTES) {
        finish(false)
        return
      }
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue

        let message: Handshake
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (String(message.id ?? '') !== helloId) continue
        finish(message.ok === true, message)
        return
      }
    }
    const timer = setTimeout(() => finish(false), this.handshakeTimeoutMs)

    socket.once('connect', onConnect)
    socket.on('data', onData)
    socket.once('error', onFailure)
    socket.once('close', onFailure)
    return completion.promise
  }

  private wireSocket(socket: Socket, initialBuffer: string, decoder: StringDecoder): void {
    this.buffer = initialBuffer
    const onData = (chunk: Buffer): void => {
      this.buffer += decoder.write(chunk)
      if (Buffer.byteLength(this.buffer) > MAX_TRANSPORT_BUFFER_BYTES) {
        this.resetTransport(socket, new Error('terminal daemon transport frame exceeded limit'))
        socket.destroy()
        return
      }
      this.drainFrames()
    }
    const onError = (error: Error): void => {
      this.resetTransport(socket, new Error(`terminal daemon transport error: ${error.message}`))
    }
    const onClose = (): void => {
      decoder.end()
      this.resetTransport(socket, new Error('terminal daemon transport closed'))
    }
    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
    this.drainFrames()
  }

  private drainFrames(): void {
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (!line.trim()) continue

      let message: Record<string, unknown>
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message['event']) {
        this.dispatchEvent(message)
        continue
      }
      const id = String(message['id'] ?? '')
      const pending = this.pending.get(id)
      if (!pending) continue
      clearTimeout(pending.timer)
      this.pending.delete(id)
      if (message['ok'] === true) pending.resolve(message)
      else pending.reject(new Error(String(message['error'] ?? 'daemon error')))
    }
  }

  private resetTransport(socket: Socket, error: Error): void {
    if (this.socket !== socket) return
    this.socket = null
    this.buffer = ''
    this.connectedEndpoint = null
    this.capabilities.clear()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.events.disconnected?.()
  }

  private dispatchEvent(message: Record<string, unknown>): void {
    const sessionId = String(message['sessionId'] ?? '')
    const event = String(message['event'])
    if (event === 'data') {
      const rawSequence = message['sequence']
      const sequence = typeof rawSequence === 'number' && Number.isSafeInteger(rawSequence) ? rawSequence : undefined
      this.events.data(sessionId, String(message['data'] ?? ''), sequence)
    } else if (event === 'exit') {
      const code = message['exitCode']
      this.events.exit(sessionId, typeof code === 'number' && Number.isSafeInteger(code) ? code : undefined)
    } else if (event === 'title') {
      this.events.title(sessionId, String(message['title'] ?? ''))
    } else if (event === 'agent' && isRunningAgent(message['run'])) {
      try { this.events.agent(requireRunningAgent(message['run'])) } catch { /* Ignore malformed unsolicited records. */ }
    } else if (event === 'acp') {
      try { this.events.acp?.(parseAcpAgentSnapshot(message['snapshot'])) } catch { /* Ignore malformed unsolicited records. */ }
    } else if (event === 'agent-dismissed') {
      this.events.agentDismissed(sessionId)
    }
  }

  private rawSend(socket: Socket, message: Record<string, unknown>): void {
    socket.write(`${JSON.stringify(message)}\n`)
  }

  private async requireCapability(capability: string, operation: string): Promise<void> {
    await this.connect()
    if (this.capabilities.has(capability)) return
    if (capability === TASK_AUTHORITY) {
      await this.upgradeTaskAuthorityDaemon(operation)
      return
    }
    throw new Error(
      `terminal daemon upgrade required for ${operation}; existing daemon and its sessions were left running`
    )
  }

  /**
   * An older authenticated daemon predates `task-authority-v1`. When it is
   * provably idle it is shut down, its Stage 1 ownership and endpoint are
   * awaited, and the packaged daemon is spawned. When it owns live sessions,
   * activation is blocked with their sanitized status until they exit; an old
   * daemon is never treated as an empty authority.
   */
  private async upgradeTaskAuthorityDaemon(operation: string): Promise<void> {
    let status: DaemonStatus
    try {
      status = await this.request<DaemonStatus>('daemon.status')
    } catch {
      this.disconnect()
      throw new DaemonUpgradeRequiredError({ pid: null, idle: false, sessionCount: 0, liveSessionCount: 0 })
    }
    if (!status.idle || status.sessionCount !== 0 || status.liveSessionCount !== 0) {
      this.disconnect()
      throw new DaemonUpgradeRequiredError({ pid: typeof status.pid === 'number' ? status.pid : null, idle: false, sessionCount: status.sessionCount, liveSessionCount: status.liveSessionCount })
    }
    const stopped = await this.request<{ stopped: boolean }>('daemon.shutdown').catch(() => ({ stopped: false }))
    if (stopped.stopped !== true) {
      this.disconnect()
      throw new DaemonUpgradeRequiredError({ pid: typeof status.pid === 'number' ? status.pid : null, idle: true, sessionCount: 0, liveSessionCount: 0 })
    }
    this.disconnect()
    await this.awaitDaemonEndpointCleanup()
    await this.connectInner()
    if (!this.capabilities.has(TASK_AUTHORITY)) {
      throw new Error(`terminal daemon upgrade for ${operation} did not reach ${TASK_AUTHORITY}`)
    }
  }

  private async awaitDaemonEndpointCleanup(): Promise<void> {
    const paths = localRuntimePaths(canonicalPrivateDirectory(this.userDataDir, { requireCanonical: true }), 'terminal')
    const previousEndpoint = this.connectedEndpoint
    const deadline = Date.now() + 5_000
    while (Date.now() <= deadline) {
      const record = readRuntimeRecord(paths.runtimeFile)
      // A v2 shutdown preserves the locator file; the authoritative cleanup
      // signal is the Stage 1 ownership row becoming vacant. A removed record
      // or a replacement locator at a different endpoint is also progress.
      if (record.status === 'missing') return
      let ownership: RuntimeOwnershipStore | null = null
      try {
        ownership = new RuntimeOwnershipStore(paths.ownershipDatabasePath, { readOnly: true })
        if (ownership.observe('terminal-daemon').status === 'vacant') return
      } catch {
        // Ownership observation unavailable; rely on the record checks below.
      } finally {
        ownership?.close()
      }
      if (previousEndpoint !== null && record.status === 'current' && record.record.socketPath !== previousEndpoint) return
      await delay(100)
    }
    throw new Error('terminal daemon shutdown did not release its runtime owner within 5s')
  }

  private async request<T = Record<string, unknown>>(
    operation: string,
    params: Record<string, unknown> = {}
  ): Promise<T> {
    await this.connect()
    const socket = this.socket
    if (!socket || socket.destroyed) throw new Error('terminal daemon not connected')
    const id = randomUUID()
    const completion = deferred<T>()
    const timer = setTimeout(() => {
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      pending.reject(new Error(`terminal daemon request timed out: ${operation}`))
    }, this.requestTimeoutMs)
    this.pending.set(id, {
      resolve: completion.resolve,
      reject: completion.reject,
      timer
    })
    try {
      this.rawSend(socket, { id, op: operation, ...params })
    } catch (error) {
      clearTimeout(timer)
      this.pending.delete(id)
      completion.reject(error instanceof Error ? error : new Error(String(error)))
    }
    return completion.promise
  }

  async open(cwd: string, cols = 100, rows = 30): Promise<TerminalSession> {
    await this.requireCapability(SEQUENCED_OUTPUT, 'opening a terminal')
    const response = await this.request<{ session: TerminalSession }>('session.open', { cwd, cols, rows })
    return response.session
  }

  async switchMode(workspacePath: string, sessionId: string, target: 'native' | 'acp', requestId: string, executable: string, mcpServers: McpServer[], context?: string): Promise<AgentModeSwitchReceipt> {
    await this.requireCapability(ACP_DAEMON_CAPABILITY, 'agent mode switch')
    const response = await this.request<{ receipt: unknown }>('agent.switch', { workspacePath, sessionId, target, requestId, executable, mcpServers, context })
    return parseAgentModeSwitchReceipt(response.receipt)
  }
  async modeSwitchResult(workspacePath: string, requestId: string): Promise<AgentModeSwitchReceipt> {
    await this.requireCapability(ACP_DAEMON_CAPABILITY, 'agent mode switch')
    const response = await this.request<{ receipt: unknown }>('agent.switch.get', { workspacePath, requestId })
    return parseAgentModeSwitchReceipt(response.receipt)
  }

  async startAcp(workspacePath: string, sessionId: string, launch: AgentExecutable, mcpServers: McpServer[], loadRunId?: string): Promise<AcpAgentSnapshot> {
    await this.requireCapability(ACP_DAEMON_CAPABILITY, 'ACP sessions')
    const response = await this.request<{ snapshot: unknown }>('acp.open', { workspacePath, sessionId, launch, mcpServers, loadRunId })
    return parseAcpAgentSnapshot(response.snapshot)
  }
  async listAcp(workspacePath: string): Promise<AcpAgentSnapshot[]> {
    await this.requireCapability(ACP_DAEMON_CAPABILITY, 'ACP sessions')
    const response = await this.request<{ sessions: unknown }>('acp.list', { workspacePath })
    if (!Array.isArray(response.sessions)) throw new Error('invalid ACP session list')
    return response.sessions.map(snapshot => parseAcpAgentSnapshot(snapshot))
  }
  async observeAcp(workspacePath: string, sessionId: string, afterSequence = 0): Promise<AcpObservation> {
    await this.requireCapability(ACP_DAEMON_CAPABILITY, 'ACP sessions')
    return parseAcpObservation(await this.request<unknown>('acp.observe', { workspacePath, sessionId, afterSequence }))
  }
  async promptAcp(workspacePath: string, sessionId: string, requestId: string, text: string): Promise<AcpPromptRecord> {
    await this.requireCapability(ACP_DAEMON_CAPABILITY, 'ACP sessions')
    const response = await this.request<{ request: unknown }>('acp.prompt', { workspacePath, sessionId, requestId, text })
    return parseAcpPromptRecord(response.request)
  }
  async controlAcp(workspacePath: string, sessionId: string, operation: 'cancel' | 'stop' | 'permission' | 'dismiss', permissionId?: string, optionId?: string): Promise<AcpAgentSnapshot> {
    await this.requireCapability(ACP_DAEMON_CAPABILITY, 'ACP sessions')
    const response = await this.request<{ snapshot: unknown }>(`acp.${operation}`, { workspacePath, sessionId, permissionId, optionId })
    return parseAcpAgentSnapshot(response.snapshot)
  }

  /** Start a finite shell command owned by the daemon, not by the app process. */
  async openJob(cwd: string, command: string, cols = 100, rows = 30): Promise<TerminalSession> {
    await this.requireCapability(ONESHOT_JOBS, 'running a command job')
    await this.requireCapability(SEQUENCED_OUTPUT, 'running a command job')
    const response = await this.request<{ session: TerminalSession }>('job.open', { cwd, command, cols, rows })
    return response.session
  }

  async startAgent(
    cwd: string,
    command: string,
    providerId?: AgentProviderId,
    launch?: AgentExecutable,
    cols = 100,
    rows = 30,
    task?: AgentTaskIntent
  ): Promise<AgentStartResult> {
    if (task) { task = parseAgentTaskIntent(task); await this.requireCapability('agent-task-intent-v1', 'retaining task intent') }
    if (launch) await this.requireCapability('agent-argv-v1', 'starting an agent with explicit arguments')
    await this.requireCapability(AGENT_RUNS, 'starting an agent run')
    await this.requireCapability(SEQUENCED_OUTPUT, 'starting an agent run')

    // Resolve session template if specified
    let resolvedCommand = command
    let resolvedEnv: Record<string, string> | undefined
    if (task?.templateId) {
      try {
        const { getServices } = await import('./services')
        const templates = getServices().sessionTemplates
        if (templates) {
          const template = await templates.get(task.templateId)
          if (template?.systemPrompt) {
            resolvedCommand = template.systemPrompt + '\n\n---\n\n' + command
          }
          if (template?.env) {
            resolvedEnv = template.env
          }
        }
      } catch (err) {
        // Template unresolved — the launch proceeds without it; record so the loss is visible.
        logger.warn({ err, templateId: task.templateId }, 'agent launch without session template')
      }
    }

    const response = await this.request<{ run: unknown; session: TerminalSession }>('agent.open', {
      cwd,
      command: resolvedCommand,
      ...(providerId ? { providerId } : {}),
      ...(launch ? { launch } : {}),
      ...(task ? { task } : {}),
      cols,
      rows,
      ...(resolvedEnv ? { env: resolvedEnv } : {}),
    })
    return { run: requireRunningAgent(response.run), session: response.session }
  }

  async listAgents(): Promise<RunningAgent[]> {
    await this.requireCapability(AGENT_RUNS, 'listing agent runs')
    const response = await this.request<{ runs: unknown }>('agent.list')
    if (!Array.isArray(response.runs)) throw new Error('terminal daemon returned an invalid agent list')
    return response.runs.map(requireRunningAgent)
  }
  /** Optional capability: an older detached daemon remains authoritative and untouched. */
  async attentionInboxList(): Promise<AttentionInboxListResult> {
    await this.connect()
    if (!this.capabilities.has(ATTENTION_INBOX_CAPABILITY)) {
      return { available: false, reason: 'daemon-upgrade-required' }
    }
    const response = await this.request<{ snapshot: unknown }>('attention.list')
    return { available: true, snapshot: parseAttentionInboxSnapshot(response.snapshot) }
  }

  /** Acknowledges one immutable event/version; it never clears a whole session implicitly. */
  async attentionInboxAcknowledge(value: AttentionAcknowledgeRequest): Promise<AttentionAcknowledgeResult> {
    const request = parseAttentionAcknowledgeRequest(value)
    await this.connect()
    if (!this.capabilities.has(ATTENTION_INBOX_CAPABILITY)) {
      return { available: false, reason: 'daemon-upgrade-required' }
    }
    const response = await this.request<{ outcome: unknown; snapshot: unknown }>('attention.ack', request)
    const outcome = response.outcome
    if (outcome !== 'acknowledged' && outcome !== 'already-acknowledged'
      && outcome !== 'not-found' && outcome !== 'version-mismatch') {
      throw new Error('terminal daemon returned an invalid attention acknowledgement outcome')
    }
    return {
      available: true,
      outcome,
      snapshot: parseAttentionInboxSnapshot(response.snapshot)
    }
  }

  async agentStatus(sessionId: string): Promise<RunningAgent> {
    await this.requireCapability(AGENT_RUNS, 'inspecting an agent run')
    const response = await this.request<{ run: unknown }>('agent.get', { sessionId })
    return requireRunningAgent(response.run)
  }

  /** Write exact caller-supplied bytes to one admitted daemon-owned agent PTY. */
  async writeAgent(sessionId: string, data: string): Promise<void> {
    await this.requireCapability(AGENT_INPUT, 'writing to an agent run')
    await this.request('agent.write', { sessionId, data })
  }

  async interruptAgent(sessionId: string): Promise<RunningAgent> {
    await this.requireCapability(AGENT_RUNS, 'interrupting an agent run')
    const response = await this.request<{ run: unknown }>('agent.interrupt', { sessionId })
    return requireRunningAgent(response.run)
  }

  async authenticateAgent(binding: AgentSessionCredential): Promise<AuthenticatedAgentSession> {
    if (!binding || typeof binding !== 'object' || Object.keys(binding).length !== 3 || ['runId', 'sessionId', 'token'].some(key => typeof binding[key as keyof AgentSessionCredential] !== 'string' || !binding[key as keyof AgentSessionCredential] || binding[key as keyof AgentSessionCredential].length > 256)) throw new Error('Invalid agent session credential')
    await this.requireCapability('agent-session-auth-v1', 'authenticating a native agent session')
    const response = await this.request<{ run: unknown }>('agent.authenticate', { runId: binding.runId, sessionId: binding.sessionId, hookToken: binding.token })
    const run = response.run
    if (isRecord(run) && run['mode'] === 'acp' && run['liveness'] === 'live' && run['id'] === binding.runId && run['sessionId'] === binding.sessionId && typeof run['workspacePath'] === 'string' && run['workspacePath']) return run as AuthenticatedAgentSession
    const native = requireRunningAgent(run)
    if (native.liveness !== 'live') throw new Error('Invalid agent session credential')
    return { ...native, liveness: 'live' }
  }

  async stopAgent(sessionId: string): Promise<RunningAgent> {
    await this.requireCapability('agent-stop-v1', 'stopping an agent process')
    const response = await this.request<{ run: unknown }>('agent.stop', { sessionId })
    return requireRunningAgent(response.run)
  }

  async dismissAgent(sessionId: string): Promise<void> {
    await this.requireCapability(AGENT_RUNS, 'dismissing an agent run')
    await this.request('agent.dismiss', { sessionId })
  }

  /** Inspect a retained job without inferring state from transport lifecycle. */
  async jobResult(sessionId: string): Promise<DaemonJobResult> {
    await this.requireCapability(ONESHOT_JOBS, 'inspecting a command job')
    return this.request<DaemonJobResult>('job.result', { sessionId })
  }

  async attach(sessionId: string): Promise<{ session: TerminalSession; scrollback: string; sequence: number; truncated: boolean; replay?: TerminalReplayChunk[] }> {
    await this.requireCapability(SEQUENCED_OUTPUT, 'reattaching a terminal')
    const response = await this.request<{
      session: TerminalSession
      scrollback: string
      sequence: number
      truncated?: boolean
      replay?: Array<{ offset: number; cols: number; rows: number }>
    }>('session.attach', { sessionId })
    if (!Number.isSafeInteger(response.sequence) || response.sequence < 0) {
      throw new Error('terminal daemon returned an invalid sequenced snapshot')
    }
    if (response.replay !== undefined && (!Array.isArray(response.replay) || response.replay.length > 4096
      || response.replay.some((chunk, index, chunks) => !chunk || !Number.isSafeInteger(chunk.offset)
        || (index === 0 ? chunk.offset !== 0 : chunk.offset <= chunks[index - 1]!.offset)
        || chunk.offset >= response.scrollback.length || ![chunk.cols, chunk.rows].every(size => Number.isInteger(size) && size >= 2 && size <= 65535))
      || (response.scrollback.length > 0 && response.replay.length === 0))) throw new Error('terminal daemon returned invalid replay geometry')
    return {
      session: response.session,
      scrollback: response.scrollback ?? '',
      truncated: response.truncated !== false,
      sequence: response.sequence,
      replay: response.replay?.map((chunk, index, chunks) => ({ cols: chunk.cols, rows: chunk.rows, data: response.scrollback.slice(chunk.offset, chunks[index + 1]?.offset) }))
    }
  }

  write(sessionId: string, data: string): void {
    void this.writeAcknowledged(sessionId, data).catch((err) => logger.warn({ err, sessionId }, 'terminal keystroke dropped: daemon write failed'))
  }

  async writeAcknowledged(sessionId: string, data: string): Promise<void> {
    await this.request('session.write', { sessionId, data })
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    await this.request('session.resize', { sessionId, cols, rows })
  }

  interrupt(sessionId: string): void {
    void this.request('session.interrupt', { sessionId }).catch((err) => logger.warn({ err, sessionId }, 'terminal interrupt dropped: daemon write failed'))
  }

  /** Resolve only after the daemon confirms the owned PTY has exited. */
  async close(sessionId: string): Promise<void> {
    await this.request('session.close', { sessionId })
  }

  async list(): Promise<TerminalSession[]> {
    const response = await this.request<{ sessions: TerminalSession[] }>('session.list')
    return response.sessions
  }

  /** Check only transport reachability; never equate disconnect with process exit. */
  async ping(): Promise<boolean> {
    try {
      await this.request('ping')
      return true
    } catch {
      return false
    }
  }

  async status(): Promise<DaemonStatus> {
    await this.requireCapability('daemon-status', 'inspecting daemon ownership')
    return this.request<DaemonStatus>('daemon.status')
  }

  /** Stops only this authenticated daemon and only after it proves it owns no sessions. */
  async shutdownIfIdle(): Promise<boolean> {
    await this.requireCapability('idle-shutdown', 'isolated daemon cleanup')
    const status = await this.status()
    if (!status.idle || status.sessionCount !== 0 || status.liveSessionCount !== 0) return false
    const response = await this.request<{ stopped: boolean }>('daemon.shutdown')
    return response.stopped === true
  }

  // -- typed task authority intents -------------------------------------------
  // Responses pass through strict wire parsers; renderer-facing surfaces must
  // never forward the lease tokens these methods return.

  async taskIssueWorkerCredential(projectId: string): Promise<{ credentialId: string; ownerId: string; token: string }> {
    await this.requireCapability(TASK_AUTHORITY, 'issuing a task worker credential')
    const response = await this.request<{ credential: { credentialId: string; ownerId: string; token: string } }>('task.credential.issue', { projectId })
    const credential = parseWireRecord(response.credential, 'task worker credential')
    return {
      credentialId: parseWireString(credential['credentialId'], 'credential.credentialId'),
      ownerId: parseWireString(credential['ownerId'], 'credential.ownerId'),
      token: parseWireString(credential['token'], 'credential.token')
    }
  }

  async taskQuery(input: Readonly<{ projectId?: string; status?: TaskStatus; runnableOnly?: boolean; cursor?: string; limit?: number }> = {}): Promise<TaskProjection> {
    await this.requireCapability(TASK_AUTHORITY, 'querying task authority')
    return parseTaskProjectionWire(await this.request('task.query', { ...input }))
  }

  async taskCreate(input: Readonly<{ projectId: string; externalTaskId: string; title: string; body?: string; priority?: number; status?: 'todo' | 'blocked'; repositoryId?: string; workspaceRoot?: string }>): Promise<TaskSnapshot> {
    await this.requireCapability(TASK_AUTHORITY, 'creating a task')
    const response = await this.request<{ task: unknown }>('task.create', { ...input })
    return parseTaskSnapshotWire(response.task)
  }

  async taskUpdate(input: Readonly<{ projectId: string; taskId: string; expectedEntityVersion: number; title?: string; body?: string; priority?: number; status?: 'todo' | 'blocked' }>): Promise<TaskSnapshot> {
    await this.requireCapability(TASK_AUTHORITY, 'updating a task')
    const response = await this.request<{ task: unknown }>('task.update', { ...input })
    return parseTaskSnapshotWire(response.task)
  }

  async taskSetDependencies(input: Readonly<{ projectId: string; taskId: string; expectedEntityVersion: number; dependsOnTaskIds: readonly string[] }>): Promise<TaskSnapshot> {
    await this.requireCapability(TASK_AUTHORITY, 'setting task dependencies')
    const response = await this.request<{ task: unknown }>('task.dependencies.set', { ...input, dependsOnTaskIds: [...input.dependsOnTaskIds] })
    return parseTaskSnapshotWire(response.task)
  }

  async taskScheduleCreate(input: Readonly<{ projectId: string; spec: TaskScheduleSpec; enabled?: boolean; nextRunAt?: string; repositoryId?: string; workspaceRoot?: string }>): Promise<ScheduleSnapshot> {
    await this.requireCapability(TASK_AUTHORITY, 'creating a task schedule')
    const response = await this.request<{ schedule: unknown }>('task.schedule.create', { ...input })
    return parseScheduleSnapshotWire(response.schedule)
  }

  async taskScheduleUpdate(input: Readonly<{ projectId: string; scheduleId: string; expectedEntityVersion: number; spec?: TaskScheduleSpec; enabled?: boolean; nextRunAt?: string | null }>): Promise<ScheduleSnapshot> {
    await this.requireCapability(TASK_AUTHORITY, 'updating a task schedule')
    const response = await this.request<{ schedule: unknown }>('task.schedule.update', { ...input })
    return parseScheduleSnapshotWire(response.schedule)
  }

  async taskScheduleDuplicate(input: Readonly<{ projectId: string; scheduleId: string; expectedEntityVersion: number }>): Promise<ScheduleSnapshot> {
    await this.requireCapability(TASK_AUTHORITY, 'duplicating a task schedule')
    const response = await this.request<{ schedule: unknown }>('task.schedule.duplicate', { ...input })
    return parseScheduleSnapshotWire(response.schedule)
  }

  async taskScheduleDelete(input: Readonly<{ projectId: string; scheduleId: string; expectedEntityVersion: number }>): Promise<ScheduleSnapshot> {
    await this.requireCapability(TASK_AUTHORITY, 'deleting a task schedule')
    const response = await this.request<{ schedule: unknown }>('task.schedule.delete', { ...input })
    return parseScheduleSnapshotWire(response.schedule)
  }

  async taskScheduleExecutionEnqueueDue(input: Readonly<{ projectId: string; scheduleId: string; expectedEntityVersion: number; expectedNextRunAt: string }>): Promise<ScheduleExecutionSnapshot> {
    await this.requireCapability(TASK_AUTHORITY, 'enqueuing a due schedule occurrence')
    const response = await this.request<{ execution: unknown }>('task.schedule.execution.enqueue-due', { ...input })
    return parseScheduleExecutionWire(response.execution)
  }

  async taskScheduleExecutionEnqueue(input: Readonly<{ projectId: string; scheduleId: string; expectedEntityVersion: number; requestId: string }>): Promise<ScheduleExecutionSnapshot> {
    await this.requireCapability(TASK_AUTHORITY, 'enqueuing a manual schedule execution')
    const response = await this.request<{ execution: unknown }>('task.schedule.execution.enqueue', { ...input })
    return parseScheduleExecutionWire(response.execution)
  }

  async taskScheduleExecutions(input: Readonly<{ projectId?: string; scheduleId?: string; state?: string; cursor?: string; limit?: number }> = {}): Promise<{ executions: readonly ScheduleExecutionSnapshot[]; nextCursor: string | null }> {
    await this.requireCapability(TASK_AUTHORITY, 'listing schedule executions')
    const response = await this.request<Record<string, unknown>>('task.schedule.executions.list', { ...input })
    if (!Array.isArray(response['executions'])) throw new Error('terminal daemon returned an invalid schedule execution list')
    return { executions: response['executions'].map(parseScheduleExecutionWire), nextCursor: parseWireStringOrNull(response['nextCursor'], 'executions.nextCursor') }
  }

  async taskScheduleExecutionCancel(input: Readonly<{ projectId: string; scheduleId: string; executionId: string; expectedEntityVersion: number }>): Promise<ScheduleExecutionSnapshot> {
    await this.requireCapability(TASK_AUTHORITY, 'cancelling a schedule execution')
    const response = await this.request<{ execution: unknown }>('task.schedule.execution.cancel', { ...input })
    return parseScheduleExecutionWire(response.execution)
  }

  async taskRunGroupCreate(input: Readonly<{ profileId: string; name: string; concurrency: number; members: readonly Readonly<{ projectId: string; taskId: string; specification?: TaskExecutionSpecificationInput }>[] }>): Promise<RunGroupSnapshot> {
    await this.requireCapability(TASK_AUTHORITY, 'creating a run group')
    const response = await this.request<{ runGroup: unknown }>('task.run-group.create', { ...input, members: input.members.map(member => ({ ...member })) })
    return parseRunGroupWire(response.runGroup)
  }

  async taskRunGroupCancel(input: Readonly<{ profileId: string; runGroupId: string; expectedEntityVersion: number }>): Promise<RunGroupSnapshot> {
    await this.requireCapability(TASK_AUTHORITY, 'cancelling a run group')
    const response = await this.request<{ runGroup: unknown }>('task.run-group.cancel', { ...input })
    return parseRunGroupWire(response.runGroup)
  }

  async taskRunGroupDelete(input: Readonly<{ profileId: string; runGroupId: string; expectedEntityVersion: number }>): Promise<RunGroupSnapshot> {
    await this.requireCapability(TASK_AUTHORITY, 'deleting a run group')
    const response = await this.request<{ runGroup: unknown }>('task.run-group.delete', { ...input })
    return parseRunGroupWire(response.runGroup)
  }

  async taskRunGroupRetry(input: Readonly<{ runGroupId: string; expectedEntityVersion: number; requestId: string; ownerId: string; memberTaskIds: readonly Readonly<{ projectId: string; taskId: string }>[] }>): Promise<RunGroupSnapshot> {
    await this.requireCapability(TASK_AUTHORITY, 'retrying a run group')
    const response = await this.request<{ runGroup: unknown }>('task.run-group.retry', { ...input, memberTaskIds: input.memberTaskIds.map(member => ({ ...member })) })
    return parseRunGroupWire(response.runGroup)
  }

  async taskCancel(input: Readonly<{ projectId: string; taskId: string; expectedEntityVersion: number }>): Promise<TaskSnapshot> {
    await this.requireCapability(TASK_AUTHORITY, 'cancelling a task')
    const response = await this.request<{ task: unknown }>('task.cancel', { ...input })
    return parseTaskSnapshotWire(response.task)
  }

  async taskRetry(input: Readonly<{ projectId: string; taskId: string; expectedEntityVersion: number; ownerId: string; specification?: TaskExecutionSpecificationInput; leaseTtlMs?: number }>): Promise<ClaimResult> {
    await this.requireCapability(TASK_AUTHORITY, 'retrying a failed task')
    const response = await this.request<{ claim: unknown }>('task.retry', { ...input })
    return parseClaimResultWire(response.claim)
  }

  async taskAdoptArtifact(input: Readonly<{ projectId: string; taskId: string; artifactId: string; reviewReceiptSha256: string }>): Promise<TaskSnapshot> {
    await this.requireCapability(TASK_AUTHORITY, 'adopting a reviewed artifact')
    const response = await this.request<{ task: unknown }>('task.adopt-artifact', { ...input })
    return parseTaskSnapshotWire(response.task)
  }

  async taskClaim(input: Readonly<{ credential: TaskWorkerCredential; projectId: string; taskId?: string; externalTaskId?: string; specification: TaskExecutionSpecificationInput; leaseTtlMs?: number }>): Promise<ClaimResult> {
    await this.requireCapability(TASK_AUTHORITY, 'claiming a task')
    const response = await this.request<Record<string, unknown>>('task.claim', { ...input })
    return parseClaimResultWire(response)
  }

  async taskWriteHeartbeat(input: Readonly<{ credential: TaskWorkerCredential; token: LeaseToken; ttlMs?: number }>): Promise<TaskSnapshot> {
    await this.requireCapability(TASK_AUTHORITY, 'renewing a task lease')
    const response = await this.request<{ task: unknown }>('task.write', { kind: 'heartbeat', ...input })
    return parseTaskSnapshotWire(response.task)
  }

  async taskWriteProgress(input: Readonly<{ credential: TaskWorkerCredential; token: LeaseToken; detail: string }>): Promise<TaskSnapshot> {
    await this.requireCapability(TASK_AUTHORITY, 'recording task progress')
    const response = await this.request<{ task: unknown }>('task.write', { kind: 'progress', ...input })
    return parseTaskSnapshotWire(response.task)
  }

  async taskWriteAttachArtifact(input: Readonly<{ credential: TaskWorkerCredential; token: LeaseToken; artifact: VerificationArtifactInput }>): Promise<TaskSnapshot> {
    await this.requireCapability(TASK_AUTHORITY, 'attaching task evidence')
    const response = await this.request<{ task: unknown }>('task.write', { kind: 'attach-artifact', ...input })
    return parseTaskSnapshotWire(response.task)
  }

  async taskWriteComplete(input: Readonly<{ credential: TaskWorkerCredential; token: LeaseToken; summary: string }>): Promise<TaskSnapshot> {
    await this.requireCapability(TASK_AUTHORITY, 'completing a task')
    const response = await this.request<{ task: unknown }>('task.write', { kind: 'complete', ...input })
    return parseTaskSnapshotWire(response.task)
  }

  async taskWriteFail(input: Readonly<{ credential: TaskWorkerCredential; token: LeaseToken; error: string }>): Promise<TaskSnapshot> {
    await this.requireCapability(TASK_AUTHORITY, 'failing a task')
    const response = await this.request<{ task: unknown }>('task.write', { kind: 'fail', ...input })
    return parseTaskSnapshotWire(response.task)
  }

  async taskHandoffOffer(input: Readonly<{ credential: TaskWorkerCredential; projectId: string; taskId: string; attemptId: string; leaseId: string; generation: number; targetOwnerId: string; ttlMs?: number }>): Promise<HandoffOffer> {
    await this.requireCapability(TASK_AUTHORITY, 'offering a task handoff')
    const response = await this.request<{ offer: unknown }>('task.handoff.offer', { ...input })
    return parseHandoffOfferWire(response.offer)
  }

  async taskHandoffCancel(input: Readonly<{ credential: TaskWorkerCredential; projectId: string; taskId: string; attemptId: string; leaseId: string; generation: number; offerId: string }>): Promise<HandoffOffer> {
    await this.requireCapability(TASK_AUTHORITY, 'cancelling a task handoff')
    const response = await this.request<{ offer: unknown }>('task.handoff.cancel', { ...input })
    return parseHandoffOfferWire(response.offer)
  }

  async taskHandoffAccept(input: Readonly<{ credential: TaskWorkerCredential; projectId: string; taskId: string; attemptId: string; offerId: string }>): Promise<ClaimResult> {
    await this.requireCapability(TASK_AUTHORITY, 'accepting a task handoff')
    const response = await this.request<Record<string, unknown>>('task.handoff.accept', { ...input })
    return parseClaimResultWire(response)
  }

  async taskTakeover(input: Readonly<{ credential: TaskWorkerCredential; projectId: string; taskId: string; attemptId: string; leaseId: string; generation: number; leaseTtlMs?: number }>): Promise<ClaimResult> {
    await this.requireCapability(TASK_AUTHORITY, 'taking over an expired task lease')
    const response = await this.request<Record<string, unknown>>('task.takeover', { ...input })
    return parseClaimResultWire(response)
  }

  async taskMailboxAppend(input: Readonly<{ credential: TaskWorkerCredential; projectId: string; taskId: string; kind: 'attention' | 'progress' | 'artifact' | 'system'; payload: Record<string, unknown> }>): Promise<TaskMailboxEntry> {
    await this.requireCapability(TASK_AUTHORITY, 'appending a task mailbox entry')
    const response = await this.request<{ mailboxEntry: unknown }>('task.mailbox.append', { ...input })
    return parseMailboxEntryWire(response.mailboxEntry)
  }

  async taskMailboxAcknowledge(input: Readonly<{ projectId: string; taskId: string; mailboxEntryId: string }>): Promise<TaskMailboxEntry> {
    await this.requireCapability(TASK_AUTHORITY, 'acknowledging task attention')
    const response = await this.request<{ mailboxEntry: unknown }>('task.mailbox.acknowledge', { ...input })
    return parseMailboxEntryWire(response.mailboxEntry)
  }

  disconnect(): void {
    const socket = this.socket
    if (!socket) return
    this.socket = null
    socket.destroy()
  }
}
