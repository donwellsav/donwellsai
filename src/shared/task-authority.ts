import type { ProcessIdentity, ProcessIdentityVerdict } from './child-process/process-spec'
import { OPERATIONAL_ERROR_LIMIT, OPERATIONAL_OUTPUT_LIMIT } from './operational-runs'

/**
 * Task Authority — strict shared contract for the single daemon-owned SQLite
 * authority over task/attempt/schedule/run-group facts.
 *
 * Authentication model: every input carries an {@link AuthenticatedAuthorityConnection}
 * produced by the daemon's connection authenticator. Worker identity (the lease
 * owner) is always derived from the connection; caller-supplied owner IDs are
 * never trusted alone. The `Trusted*` inputs are daemon-internal surfaces and
 * are never exposed to renderer/CLI/worker request decoders.
 */

export const TASK_AUTHORITY_MAX_IDENTIFIER = 128
export const TASK_AUTHORITY_MAX_TITLE = 512
export const TASK_AUTHORITY_MAX_USER_TEXT = OPERATIONAL_OUTPUT_LIMIT
export const TASK_AUTHORITY_MAX_ERROR_TEXT = OPERATIONAL_ERROR_LIMIT
export const TASK_AUTHORITY_MAX_BATCH = 100
export const TASK_AUTHORITY_MAX_PAGE = 500
export const TASK_AUTHORITY_DEFAULT_PAGE = 100
export const TASK_AUTHORITY_MIN_LEASE_TTL_MS = 1_000
export const TASK_AUTHORITY_MAX_LEASE_TTL_MS = 600_000
export const TASK_AUTHORITY_DEFAULT_LEASE_TTL_MS = 30_000
export const TASK_AUTHORITY_DEFAULT_OFFER_TTL_MS = 30_000

export class TaskAuthorityError extends Error {
  readonly code:
    | 'TASK_NOT_FOUND'
    | 'TASK_NOT_RUNNABLE'
    | 'DEPENDENCY_BLOCKED'
    | 'CAPACITY_EXHAUSTED'
    | 'STALE_AUTHORITY'
    | 'LEASE_EXPIRED'
    | 'HANDOFF_PENDING'
    | 'HANDOFF_INVALID'
    | 'TASK_CANCELLED'
    | 'COMPLETION_REJECTED'
    | 'RESOURCE_QUARANTINED'
    | 'AUTHORIZATION_DENIED'
    | 'MIGRATION_REQUIRED'
    | 'DAEMON_UPGRADE_REQUIRED'
    | 'PROJECT_SCOPE_MISMATCH'
    | 'IDEMPOTENCY_CONFLICT'

  constructor(code: TaskAuthorityError['code'], message: string) {
    super(message)
    this.name = 'TaskAuthorityError'
    this.code = code
  }
}

/** Bounded-input validation failure. Distinct from semantic fencing errors. */
export class TaskAuthorityValidationError extends Error {
  constructor(readonly field: string, message: string) {
    super(`${field}: ${message}`)
    this.name = 'TaskAuthorityValidationError'
    this.field = field
  }
}

// ---------------------------------------------------------------------------
// Principals and connections
// ---------------------------------------------------------------------------

export type TaskAuthorityRole = 'worker' | 'daemon-scheduler' | 'administrator' | 'reviewer'

/**
 * An authenticated daemon connection. `ownerId` is populated by the daemon
 * authenticator from session credentials; requests cannot self-certify it.
 * Project/profile authorizations are daemon-granted scopes; `undefined` means
 * the role carries no scope grant (administrators may omit scopes to act
 * globally; scoped roles with `undefined` scopes are denied).
 */
export type AuthenticatedAuthorityConnection = Readonly<{
  connectionId: string
  role: TaskAuthorityRole
  ownerId?: string
  authorizedProjectIds?: readonly string[]
  authorizedProfileIds?: readonly string[]
}>

// ---------------------------------------------------------------------------
// Identifiers and canonical keys
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256_HEX = /^[a-f0-9]{64}$/

export function isAuthorityUuid(value: string): boolean {
  return UUID.test(value)
}

export function assertAuthorityUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new TaskAuthorityValidationError(field, 'must be a UUID')
  }
  return value
}

function boundedIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > TASK_AUTHORITY_MAX_IDENTIFIER || value.includes('\0')) {
    throw new TaskAuthorityValidationError(field, `must be a non-empty string of at most ${TASK_AUTHORITY_MAX_IDENTIFIER} characters`)
  }
  return value
}

/** Canonical case-folded key for project-scoped external task IDs. */
export function canonicalExternalTaskId(externalTaskId: string): string {
  return externalTaskId.trim().toLowerCase()
}

/**
 * Canonical case-folded key for physical resources (worktrees). Trailing
 * slashes are stripped so path aliases resolve together, and macOS/Windows
 * filesystems in this fleet are case-insensitive, so aliases that differ only
 * by case must resolve to one canonical reservation; Linux keeps exact case.
 */
export function canonicalResourceKey(resourceKey: string): string {
  let trimmed = resourceKey.trim()
  while (trimmed.length > 1 && trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1)
  return process.platform === 'linux' ? trimmed : trimmed.toLowerCase()
}

export function parseAuthorityConnection(value: unknown, field = 'connection'): AuthenticatedAuthorityConnection {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TaskAuthorityValidationError(field, 'must be an object')
  }
  const record = value as Record<string, unknown>
  rejectUnknownKeys(record, field, ['connectionId', 'role', 'ownerId', 'authorizedProjectIds', 'authorizedProfileIds'])
  const connectionId = boundedIdentifier(record['connectionId'], `${field}.connectionId`)
  const role = record['role']
  if (role !== 'worker' && role !== 'daemon-scheduler' && role !== 'administrator' && role !== 'reviewer') {
    throw new TaskAuthorityValidationError(`${field}.role`, 'must be a known role')
  }
  const ownerId = record['ownerId'] === undefined ? undefined : assertAuthorityUuid(record['ownerId'], `${field}.ownerId`)
  return {
    connectionId,
    role,
    ownerId,
    authorizedProjectIds: parseScopeList(record['authorizedProjectIds'], `${field}.authorizedProjectIds`),
    authorizedProfileIds: parseScopeList(record['authorizedProfileIds'], `${field}.authorizedProfileIds`)
  }
}

function parseScopeList(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0) {
    throw new TaskAuthorityValidationError(field, 'must be a non-empty array of project/profile IDs')
  }
  return value.map((entry, index) => boundedIdentifier(entry, `${field}[${index}]`))
}

/** True when the connection holds no scope grant for the named project. */
export function connectionDeniedProject(connection: AuthenticatedAuthorityConnection, projectId: string): boolean {
  if (connection.role === 'administrator' && connection.authorizedProjectIds === undefined) return false
  return connection.authorizedProjectIds === undefined || !connection.authorizedProjectIds.includes(projectId)
}

export function connectionDeniedProfile(connection: AuthenticatedAuthorityConnection, profileId: string): boolean {
  if (connection.role === 'administrator' && connection.authorizedProfileIds === undefined) return false
  return connection.authorizedProfileIds === undefined || !connection.authorizedProfileIds.includes(profileId)
}

function rejectUnknownKeys(record: Record<string, unknown>, field: string, allowed: readonly string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new TaskAuthorityValidationError(field, `unknown key "${key}"`)
  }
}

// ---------------------------------------------------------------------------
// Task/attempt state
// ---------------------------------------------------------------------------

export type TaskStatus = 'todo' | 'blocked' | 'in-progress' | 'cancelling' | 'cancelled' | 'done' | 'failed' | 'quarantined'
export type AttemptState = 'claimed' | 'launching' | 'running' | 'cancelling' | 'cancelled' | 'exited' | 'completed' | 'failed' | 'quarantined'
export type AttemptProvenance = 'native' | 'imported-legacy'
export type TaskCancelState = 'none' | 'requested'
export type HandoffOfferStatus = 'pending' | 'accepted' | 'cancelled' | 'expired'
export type LaunchIntentState = 'planned' | 'spawning' | 'reconciling-no-spawn' | 'stopped'
export type LaunchStopState = 'none' | 'requested' | 'exited'
export type ScheduleExecutionState = 'queued' | 'running' | 'cancelling' | 'cancelled' | 'succeeded' | 'failed'
export type RunGroupState = 'active' | 'cancelling' | 'cancelled' | 'completed'
export type RunMemberState = 'queued' | 'claimed' | 'launching' | 'running' | 'cancelling' | 'cancelled' | 'completed' | 'failed' | 'quarantined'
export type MailboxEntryKind = 'attention' | 'progress' | 'artifact' | 'system'
export type ResourceReservationState = 'reserved' | 'quarantined' | 'released'
export type ReconciliationVerdict = ProcessIdentityVerdict['status']

export const TASK_STATUSES: readonly TaskStatus[] = ['todo', 'blocked', 'in-progress', 'cancelling', 'cancelled', 'done', 'failed', 'quarantined']
export const ACTIVE_ATTEMPT_STATES: readonly AttemptState[] = ['claimed', 'launching', 'running']
export const CAPACITY_CONSUMING_ATTEMPT_STATES: readonly AttemptState[] = ['claimed', 'launching', 'running', 'cancelling', 'quarantined']

// ---------------------------------------------------------------------------
// Execution specifications
// ---------------------------------------------------------------------------

export type TaskCommand = Readonly<{
  program: string
  args: readonly string[]
  cwd?: string
}>

export type TaskExecutionTarget =
  | Readonly<{ kind: 'local'; root: string; label: string }>
  | Readonly<{ kind: 'remote'; connectionId: string; root: string; label: string }>

export type ArtifactRelationship = 'attached-reference' | 'observed-during-run'

export type TaskVerificationRequirement = Readonly<{
  requiredArtifacts: readonly Readonly<{ path: string; relationship: ArtifactRelationship }>[]
}>

export type TaskExecutionSpecificationInput = Readonly<{
  command: TaskCommand
  target: TaskExecutionTarget
  verification: TaskVerificationRequirement
}>

export type VerificationArtifactInput = Readonly<{
  path: string
  sha256: string
  bytes: number
  sourceFingerprint: string | null
  relationship: ArtifactRelationship
}>

export type TaskCompletionInput = Readonly<{
  summary: string
}>

function boundedUserText(value: unknown, field: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > maximum || value.includes('\0')) {
    throw new TaskAuthorityValidationError(field, `must be a string of at most ${maximum} characters`)
  }
  return value
}

function boundedStringArray(value: unknown, field: string, maximum: number): readonly string[] {
  if (!Array.isArray(value)) throw new TaskAuthorityValidationError(field, 'must be an array of strings')
  if (value.length > maximum) throw new TaskAuthorityValidationError(field, `must contain at most ${maximum} entries`)
  return value.map((entry, index) => boundedUserText(entry, `${field}[${index}]`, maximum))
}

export function parseTaskExecutionSpecification(value: unknown, field = 'specification'): TaskExecutionSpecificationInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TaskAuthorityValidationError(field, 'must be an object')
  }
  const record = value as Record<string, unknown>
  rejectUnknownKeys(record, field, ['command', 'target', 'verification'])
  const command = record['command']
  if (typeof command !== 'object' || command === null || Array.isArray(command)) {
    throw new TaskAuthorityValidationError(`${field}.command`, 'must be an object')
  }
  const commandRecord = command as Record<string, unknown>
  rejectUnknownKeys(commandRecord, `${field}.command`, ['program', 'args', 'cwd'])
  const target = record['target']
  if (typeof target !== 'object' || target === null || Array.isArray(target)) {
    throw new TaskAuthorityValidationError(`${field}.target`, 'must be an object')
  }
  const targetRecord = target as Record<string, unknown>
  if (targetRecord['kind'] !== 'local' && targetRecord['kind'] !== 'remote') {
    throw new TaskAuthorityValidationError(`${field}.target.kind`, 'must be "local" or "remote"')
  }
  const verification = record['verification']
  if (typeof verification !== 'object' || verification === null || Array.isArray(verification)) {
    throw new TaskAuthorityValidationError(`${field}.verification`, 'must be an object')
  }
  const verificationRecord = verification as Record<string, unknown>
  rejectUnknownKeys(verificationRecord, `${field}.verification`, ['requiredArtifacts'])
  const requiredArtifacts = verificationRecord['requiredArtifacts'] ?? []
  if (!Array.isArray(requiredArtifacts)) {
    throw new TaskAuthorityValidationError(`${field}.verification.requiredArtifacts`, 'must be an array')
  }
  return {
    command: {
      program: boundedUserText(commandRecord['program'], `${field}.command.program`, TASK_AUTHORITY_MAX_IDENTIFIER),
      args: boundedStringArray(commandRecord['args'] ?? [], `${field}.command.args`, TASK_AUTHORITY_MAX_BATCH),
      cwd: commandRecord['cwd'] === undefined ? undefined : boundedUserText(commandRecord['cwd'], `${field}.command.cwd`, TASK_AUTHORITY_MAX_IDENTIFIER)
    },
    target: targetRecord['kind'] === 'local'
      ? {
          kind: 'local',
          root: boundedUserText(targetRecord['root'], `${field}.target.root`, TASK_AUTHORITY_MAX_IDENTIFIER),
          label: boundedUserText(targetRecord['label'], `${field}.target.label`, TASK_AUTHORITY_MAX_TITLE)
        }
      : {
          kind: 'remote',
          connectionId: boundedIdentifier(targetRecord['connectionId'], `${field}.target.connectionId`),
          root: boundedUserText(targetRecord['root'], `${field}.target.root`, TASK_AUTHORITY_MAX_IDENTIFIER),
          label: boundedUserText(targetRecord['label'], `${field}.target.label`, TASK_AUTHORITY_MAX_TITLE)
        },
    verification: {
      requiredArtifacts: requiredArtifacts.map((artifact, index) => {
        if (typeof artifact !== 'object' || artifact === null || Array.isArray(artifact)) {
          throw new TaskAuthorityValidationError(`${field}.verification.requiredArtifacts[${index}]`, 'must be an object')
        }
        const artifactRecord = artifact as Record<string, unknown>
        rejectUnknownKeys(artifactRecord, `${field}.verification.requiredArtifacts[${index}]`, ['path', 'relationship'])
        const relationship = artifactRecord['relationship']
        if (relationship !== 'attached-reference' && relationship !== 'observed-during-run') {
          throw new TaskAuthorityValidationError(`${field}.verification.requiredArtifacts[${index}].relationship`, 'must be a known relationship')
        }
        return {
          path: boundedUserText(artifactRecord['path'], `${field}.verification.requiredArtifacts[${index}].path`, TASK_AUTHORITY_MAX_IDENTIFIER),
          relationship
        }
      })
    }
  }
}

export function parseVerificationArtifact(value: unknown, field = 'artifact'): VerificationArtifactInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TaskAuthorityValidationError(field, 'must be an object')
  }
  const record = value as Record<string, unknown>
  rejectUnknownKeys(record, field, ['path', 'sha256', 'bytes', 'sourceFingerprint', 'relationship'])
  const sha256 = record['sha256']
  if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) {
    throw new TaskAuthorityValidationError(`${field}.sha256`, 'must be a lowercase sha256 hex digest')
  }
  const bytes = record['bytes']
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) {
    throw new TaskAuthorityValidationError(`${field}.bytes`, 'must be a non-negative integer')
  }
  const relationship = record['relationship']
  if (relationship !== 'attached-reference' && relationship !== 'observed-during-run') {
    throw new TaskAuthorityValidationError(`${field}.relationship`, 'must be a known relationship')
  }
  return {
    path: boundedUserText(record['path'], `${field}.path`, TASK_AUTHORITY_MAX_IDENTIFIER),
    sha256,
    bytes,
    sourceFingerprint: record['sourceFingerprint'] === undefined || record['sourceFingerprint'] === null
      ? null
      : boundedUserText(record['sourceFingerprint'], `${field}.sourceFingerprint`, TASK_AUTHORITY_MAX_IDENTIFIER),
    relationship
  }
}

/** Attempt runtime binding accepts only ACP agent identities; later runtime families fail before mutation. */
export function assertBindableProcessIdentity(identity: ProcessIdentity): void {
  if (identity.family !== 'acp-agent') {
    throw new TaskAuthorityError('AUTHORIZATION_DENIED', `attempt runtime binding accepts only acp-agent identities, not "${identity.family}"`)
  }
}

// ---------------------------------------------------------------------------
// Leases, tokens, snapshots
// ---------------------------------------------------------------------------

export type LeaseToken = {
  projectId: string
  taskId: string
  attemptId: string
  ownerId: string
  leaseId: string
  generation: number
  expiresAt: string
}

export type LeaseSnapshot = Readonly<{
  leaseId: string
  ownerId: string
  generation: number
  issuedAt: string
  expiresAt: string
  expiresAtMs: number
}>

export type AttemptRuntimeSnapshot = Readonly<{
  sessionId: string | null
  processIdentity: ProcessIdentity | null
  launchIntentId: string | null
  launchState: LaunchIntentState | null
  stopState: LaunchStopState | null
}>

export type ResourceReservationSnapshot = Readonly<{
  resourceKey: string
  canonicalResourceKey: string
  state: ResourceReservationState
}>

export type AttemptSnapshot = Readonly<{
  projectId: string
  taskId: string
  attemptId: string
  sequence: number
  retryOfAttemptId: string | null
  provenance: AttemptProvenance
  state: AttemptState
  specificationId: string
  currentLease: LeaseSnapshot | null
  runtime: AttemptRuntimeSnapshot | null
  reservation: ResourceReservationSnapshot | null
  lastProgress: string | null
  startedAt: string
  finishedAt: string | null
}>

export type TaskSnapshot = Readonly<{
  projectId: string
  taskId: string
  externalTaskId: string
  title: string
  body: string
  status: TaskStatus
  priority: number
  dependencies: readonly string[]
  /** Derived: at least one dependency is unfinished. Distinct from explicit `blocked` status. */
  dependencyBlocked: boolean
  /** Derived: `todo`, no unfinished dependency, no cancellation. */
  runnable: boolean
  cancelState: TaskCancelState
  currentAttempt: AttemptSnapshot | null
  entityVersion: number
  createdAt: string
  updatedAt: string
}>

export type ClaimResult = Readonly<{
  task: TaskSnapshot
  attempt: AttemptSnapshot
  token: LeaseToken
}>

// ---------------------------------------------------------------------------
// Admin task inputs
// ---------------------------------------------------------------------------

export type AdminCreateTaskInput = Readonly<{
  connection: AuthenticatedAuthorityConnection
  projectId: string
  repositoryId?: string
  workspaceRoot?: string
  externalTaskId: string
  title: string
  body?: string
  priority?: number
  status?: 'todo' | 'blocked'
}>

export type AdminUpdateTaskInput = Readonly<{
  connection: AuthenticatedAuthorityConnection
  projectId: string
  taskId: string
  expectedEntityVersion: number
  title?: string
  body?: string
  priority?: number
  status?: 'todo' | 'blocked'
}>

export type AdminSetDependenciesInput = Readonly<{
  connection: AuthenticatedAuthorityConnection
  projectId: string
  taskId: string
  expectedEntityVersion: number
  dependsOnTaskIds: readonly string[]
}>

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

export type TaskScheduleCadence =
  | Readonly<{ kind: 'interval'; minutes: number }>
  | Readonly<{ kind: 'daily'; time: string; timeZone: string }>

export type TaskScheduleSpec = Readonly<{
  profileId: string
  taskTitle: string
  cadence: TaskScheduleCadence
  command: TaskCommand
  target: TaskExecutionTarget
  verification: TaskVerificationRequirement
}>

export type ScheduleSnapshot = Readonly<{
  scheduleId: string
  projectId: string
  profileId: string
  taskTitle: string
  cadence: TaskScheduleCadence
  command: TaskCommand
  target: TaskExecutionTarget
  verification: TaskVerificationRequirement
  enabled: boolean
  entityVersion: number
  nextRunAt: string | null
  createdAt: string
  updatedAt: string
}>

export type AdminCreateScheduleInput = Readonly<{
  connection: AuthenticatedAuthorityConnection
  projectId: string
  repositoryId?: string
  workspaceRoot?: string
  spec: TaskScheduleSpec
  enabled?: boolean
  nextRunAt?: string
}>

export type AdminUpdateScheduleInput = Readonly<{
  connection: AuthenticatedAuthorityConnection
  projectId: string
  scheduleId: string
  expectedEntityVersion: number
  spec?: TaskScheduleSpec
  enabled?: boolean
  nextRunAt?: string | null
}>

export type AdminDuplicateScheduleInput = Readonly<{
  connection: AuthenticatedAuthorityConnection
  projectId: string
  scheduleId: string
  expectedEntityVersion: number
}>

export type AdminDeleteScheduleInput = Readonly<{
  connection: AuthenticatedAuthorityConnection
  projectId: string
  scheduleId: string
  expectedEntityVersion: number
}>

export type ScheduleExecutionSnapshot = Readonly<{
  projectId: string
  scheduleId: string
  executionId: string
  trigger: 'due' | 'manual'
  idempotencyKey: string
  intentSha256: string
  taskId: string
  attemptId: string | null
  dueAt: string | null
  state: ScheduleExecutionState
  entityVersion: number
  createdAt: string
}>

export type ScheduleExecutionQuery = Readonly<{
  connection: AuthenticatedAuthorityConnection
  projectId?: string
  scheduleId?: string
  state?: ScheduleExecutionState
  cursor?: string
  limit?: number
}>

export type ScheduleExecutionPage = Readonly<{
  executions: readonly ScheduleExecutionSnapshot[]
  nextCursor: string | null
}>

export type AdminCancelScheduleExecutionInput = Readonly<{
  connection: AuthenticatedAuthorityConnection
  projectId: string
  scheduleId: string
  executionId: string
  expectedEntityVersion: number
}>

export type EnqueueDueScheduleInput = Readonly<{
  connection: AuthenticatedAuthorityConnection
  projectId: string
  scheduleId: string
  expectedEntityVersion: number
  expectedNextRunAt: string
}>

export type EnqueueManualScheduleExecutionInput = Readonly<{
  connection: AuthenticatedAuthorityConnection
  projectId: string
  scheduleId: string
  expectedEntityVersion: number
  requestId: string
}>

// ---------------------------------------------------------------------------
// Run groups
// ---------------------------------------------------------------------------

export type AdminCreateRunGroupInput = Readonly<{
  connection: AuthenticatedAuthorityConnection
  profileId: string
  name: string
  concurrency: number
  members: readonly Readonly<{ projectId: string; taskId: string; specification?: TaskExecutionSpecificationInput }>[]
}>

export type RunMemberSnapshot = Readonly<{
  projectId: string
  taskId: string
  attemptId: string | null
  ordinal: number
  state: RunMemberState
  specification: TaskExecutionSpecificationInput | null
}>

export type RunGroupSnapshot = Readonly<{
  runGroupId: string
  profileId: string
  name: string
  retryOfRunGroupId: string | null
  concurrency: number
  state: RunGroupState
  entityVersion: number
  members: readonly RunMemberSnapshot[]
  createdAt: string
  updatedAt: string
}>

export type AdminRetryRunGroupInput = Readonly<{
  connection: AuthenticatedAuthorityConnection
  runGroupId: string
  expectedEntityVersion: number
  requestId: string
  ownerId: string
  memberTaskIds: Array<Readonly<{ projectId: string; taskId: string }>>
}>

export type AdminCancelRunGroupInput = Readonly<{
  connection: AuthenticatedAuthorityConnection
  profileId: string
  runGroupId: string
  expectedEntityVersion: number
}>

export type AdminDeleteRunGroupInput = Readonly<{
  connection: AuthenticatedAuthorityConnection
  profileId: string
  runGroupId: string
  expectedEntityVersion: number
}>

// ---------------------------------------------------------------------------
// Worker operations
// ---------------------------------------------------------------------------

export type AuthenticatedClaimInput = Readonly<{
  connection: AuthenticatedAuthorityConnection
  projectId: string
  taskId?: string
  externalTaskId?: string
  specification: TaskExecutionSpecificationInput
  leaseTtlMs?: number
}>

/**
 * Ordinary fenced writes. Every variant carries the authenticated connection;
 * the lease-owner predicate is always checked against the connection's
 * authenticated owner ID, never against caller-supplied token text alone.
 */
export type AuthorizedTaskOperation =
  | { kind: 'heartbeat'; connection: AuthenticatedAuthorityConnection; token: LeaseToken; ttlMs: number }
  | { kind: 'progress'; connection: AuthenticatedAuthorityConnection; token: LeaseToken; detail: string }
  | { kind: 'record-launch-intent'; connection: AuthenticatedAuthorityConnection; token: LeaseToken; specificationId: string }
  | { kind: 'bind-runtime'; connection: AuthenticatedAuthorityConnection; token: LeaseToken; sessionId: string; processIdentity: ProcessIdentity }
  | { kind: 'bind-worktree'; connection: AuthenticatedAuthorityConnection; token: LeaseToken; resourceKey: string; worktreePath: string; repositoryId: string }
  | { kind: 'attach-artifact'; connection: AuthenticatedAuthorityConnection; token: LeaseToken; artifact: VerificationArtifactInput }
  | { kind: 'complete'; connection: AuthenticatedAuthorityConnection; token: LeaseToken; result: TaskCompletionInput }
  | { kind: 'fail'; connection: AuthenticatedAuthorityConnection; token: LeaseToken; error: string }

export type AuthenticatedHandoffOfferInput = Readonly<{
  connection: AuthenticatedAuthorityConnection
  projectId: string
  taskId: string
  attemptId: string
  leaseId: string
  generation: number
  targetOwnerId: string
  ttlMs?: number
}>

export type HandoffOffer = Readonly<{
  offerId: string
  projectId: string
  taskId: string
  attemptId: string
  sourceOwnerId: string
  targetOwnerId: string
  sourceLeaseId: string
  sourceGeneration: number
  status: HandoffOfferStatus
  expiresAt: string
  createdAt: string
  resolvedAt: string | null
}>

export type AuthenticatedHandoffCancelInput = Readonly<{
  connection: AuthenticatedAuthorityConnection
  projectId: string
  taskId: string
  attemptId: string
  leaseId: string
  generation: number
  offerId: string
}>

export type AuthenticatedHandoffAcceptInput = Readonly<{
  connection: AuthenticatedAuthorityConnection
  projectId: string
  taskId: string
  attemptId: string
  offerId: string
}>

export type AuthenticatedTakeoverInput = Readonly<{
  connection: AuthenticatedAuthorityConnection
  projectId: string
  taskId: string
  attemptId: string
  leaseId: string
  generation: number
  leaseTtlMs?: number
}>

// ---------------------------------------------------------------------------
// Trusted daemon-internal surfaces (never exposed to request decoders)
// ---------------------------------------------------------------------------

export type TrustedBeginSpawnInput = Readonly<{
  token: LeaseToken
  launchIntentId: string
  expectedSpecificationId: string
}>

export type SpawnAdmission = Readonly<{
  projectId: string
  taskId: string
  attemptId: string
  leaseId: string
  leaseGeneration: number
  launchIntentId: string
  specificationId: string
  admittedAt: string
}>

export type TrustedExpiredOwnerReconciliationInput = Readonly<{
  projectId: string
  taskId: string
  attemptId: string
  leaseId: string
  generation: number
  launchIntentSha256: string
  processIdentity: ProcessIdentity
  verdict: ProcessIdentityVerdict
}>

export type TrustedExitAcknowledgement = Readonly<{
  projectId: string
  taskId: string
  attemptId: string
  leaseId: string
  generation: number
  reason?: string
}>

// ---------------------------------------------------------------------------
// Mailbox, projection
// ---------------------------------------------------------------------------

export type TaskMailboxEntry = Readonly<{
  entryId: string
  projectId: string
  taskId: string
  attemptId: string | null
  leaseId: string | null
  generation: number | null
  kind: MailboxEntryKind
  payload: Readonly<Record<string, unknown>>
  acknowledgedAt: string | null
  createdAt: string
}>

export type AuthenticatedMailboxInput = Readonly<{
  connection: AuthenticatedAuthorityConnection
  projectId: string
  taskId: string
  kind: MailboxEntryKind
  payload: Readonly<Record<string, unknown>>
}>

export type AuthenticatedAttentionAcknowledgement = Readonly<{
  connection: AuthenticatedAuthorityConnection
  projectId: string
  taskId: string
  mailboxEntryId: string
}>

export type TaskQuery = Readonly<{
  connection: AuthenticatedAuthorityConnection
  projectId?: string
  status?: TaskStatus
  runnableOnly?: boolean
  cursor?: string
  limit?: number
}>

export type TaskProjection = Readonly<{
  tasks: readonly TaskSnapshot[]
  nextCursor: string | null
}>

// ---------------------------------------------------------------------------
// Cancellation, retry, adoption
// ---------------------------------------------------------------------------

export type AdminCancellationInput = Readonly<{
  connection: AuthenticatedAuthorityConnection
  projectId: string
  taskId: string
  expectedEntityVersion: number
}>

export type AdminRetryFailedTaskInput = Readonly<{
  connection: AuthenticatedAuthorityConnection
  projectId: string
  taskId: string
  expectedEntityVersion: number
  ownerId: string
  specification?: TaskExecutionSpecificationInput
  leaseTtlMs?: number
}>

export type ReviewedArtifactAdoptionInput = Readonly<{
  connection: AuthenticatedAuthorityConnection
  projectId: string
  taskId: string
  artifactId: string
  reviewReceiptSha256: string
}>

// ---------------------------------------------------------------------------
// Authority interface
// ---------------------------------------------------------------------------

export interface TaskAuthority {
  createTask(input: AdminCreateTaskInput): TaskSnapshot
  updateTask(input: AdminUpdateTaskInput): TaskSnapshot
  setDependencies(input: AdminSetDependenciesInput): TaskSnapshot
  listSchedules(input: Readonly<{ connection: AuthenticatedAuthorityConnection; projectId?: string }>): readonly ScheduleSnapshot[]
  listRunGroups(input: Readonly<{ connection: AuthenticatedAuthorityConnection; profileId?: string }>): readonly RunGroupSnapshot[]
  createSchedule(input: AdminCreateScheduleInput): ScheduleSnapshot
  updateSchedule(input: AdminUpdateScheduleInput): ScheduleSnapshot
  duplicateSchedule(input: AdminDuplicateScheduleInput): ScheduleSnapshot
  deleteSchedule(input: AdminDeleteScheduleInput): ScheduleSnapshot
  enqueueDueSchedule(input: EnqueueDueScheduleInput): ScheduleExecutionSnapshot
  enqueueManualScheduleExecution(input: EnqueueManualScheduleExecutionInput): ScheduleExecutionSnapshot
  listScheduleExecutions(input: ScheduleExecutionQuery): ScheduleExecutionPage
  cancelScheduleExecution(input: AdminCancelScheduleExecutionInput): ScheduleExecutionSnapshot
  createRunGroup(input: AdminCreateRunGroupInput): RunGroupSnapshot
  retryRunGroup(input: AdminRetryRunGroupInput): RunGroupSnapshot
  cancelRunGroup(input: AdminCancelRunGroupInput): RunGroupSnapshot
  deleteRunGroup(input: AdminDeleteRunGroupInput): RunGroupSnapshot
  claim(input: AuthenticatedClaimInput): ClaimResult
  write(input: AuthorizedTaskOperation): TaskSnapshot
  beginSpawn(input: TrustedBeginSpawnInput): SpawnAdmission
  offerHandoff(input: AuthenticatedHandoffOfferInput): HandoffOffer
  cancelHandoff(input: AuthenticatedHandoffCancelInput): HandoffOffer
  acceptHandoff(input: AuthenticatedHandoffAcceptInput): ClaimResult
  takeOverExpired(input: AuthenticatedTakeoverInput): ClaimResult
  reconcileExpiredOwner(input: TrustedExpiredOwnerReconciliationInput): TaskSnapshot
  requestCancellation(input: AdminCancellationInput): TaskSnapshot
  acknowledgeExit(input: TrustedExitAcknowledgement): TaskSnapshot
  retryFailedTask(input: AdminRetryFailedTaskInput): ClaimResult
  adoptArtifact(input: ReviewedArtifactAdoptionInput): TaskSnapshot
  appendMailbox(input: AuthenticatedMailboxInput): TaskMailboxEntry
  acknowledgeAttention(input: AuthenticatedAttentionAcknowledgement): TaskMailboxEntry
  query(input: TaskQuery): TaskProjection
}

export function parseTaskQueryCursor(value: unknown, field = 'cursor'): string {
  return boundedUserText(value, field, TASK_AUTHORITY_MAX_IDENTIFIER)
}

export function parseProjectionLimit(value: unknown, field = 'limit'): number {
  if (value === undefined) return TASK_AUTHORITY_DEFAULT_PAGE
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > TASK_AUTHORITY_MAX_PAGE) {
    throw new TaskAuthorityValidationError(field, `must be an integer from 1 to ${TASK_AUTHORITY_MAX_PAGE}`)
  }
  return value
}
