import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ProcessIdentity } from '@shared/child-process/process-spec'
import {
  assertBindableProcessIdentity,
  assertAuthorityUuid,
  canonicalExternalTaskId,
  canonicalResourceKey,
  connectionDeniedProfile,
  connectionDeniedProject,
  parseAuthorityConnection,
  parseProjectionLimit,
  parseTaskExecutionSpecification,
  parseTaskQueryCursor,
  parseVerificationArtifact,
  TASK_AUTHORITY_DEFAULT_LEASE_TTL_MS,
  TASK_AUTHORITY_DEFAULT_OFFER_TTL_MS,
  TASK_AUTHORITY_MAX_BATCH,
  TASK_AUTHORITY_MAX_ERROR_TEXT,
  TASK_AUTHORITY_MAX_LEASE_TTL_MS,
  TASK_AUTHORITY_MAX_TITLE,
  TASK_AUTHORITY_MAX_USER_TEXT,
  TASK_AUTHORITY_MIN_LEASE_TTL_MS,
  TaskAuthorityError,
  TaskAuthorityValidationError,
  type TaskExecutionSpecificationInput,
  type AdminCancelRunGroupInput,
  type AdminCancelScheduleExecutionInput,
  type AdminCancellationInput,
  type AdminCreateRunGroupInput,
  type AdminCreateScheduleInput,
  type AdminCreateTaskInput,
  type AdminDeleteRunGroupInput,
  type AdminDeleteScheduleInput,
  type AdminDuplicateScheduleInput,
  type AdminRetryFailedTaskInput,
  type AdminRetryRunGroupInput,
  type AdminSetDependenciesInput,
  type AdminUpdateScheduleInput,
  type AdminUpdateTaskInput,
  type ArtifactRelationship,
  type AttemptSnapshot,
  type AttemptState,
  type AuthenticatedAttentionAcknowledgement,
  type AuthenticatedAuthorityConnection,
  type AuthenticatedClaimInput,
  type AuthenticatedHandoffAcceptInput,
  type AuthenticatedHandoffCancelInput,
  type AuthenticatedHandoffOfferInput,
  type AuthenticatedMailboxInput,
  type AuthenticatedTakeoverInput,
  type AuthorizedTaskOperation,
  type ClaimResult,
  type EnqueueDueScheduleInput,
  type EnqueueManualScheduleExecutionInput,
  type HandoffOffer,
  type LeaseToken,
  type ResourceReservationSnapshot,
  type ReviewedArtifactAdoptionInput,
  type RunGroupSnapshot,
  type RunGroupState,
  type RunMemberState,
  type ScheduleExecutionPage,
  type ScheduleExecutionQuery,
  type ScheduleExecutionSnapshot,
  type ScheduleExecutionState,
  type ScheduleSnapshot,
  type SpawnAdmission,
  type TaskAuthority,
  type TaskMailboxEntry,
  type TaskProjection,
  type TaskQuery,
  type TaskScheduleCadence,
  type TaskScheduleSpec,
  type TaskSnapshot,
  type TaskStatus,
  type TrustedBeginSpawnInput,
  type TrustedExitAcknowledgement,
  type TrustedExpiredOwnerReconciliationInput
} from '@shared/task-authority'
import { MAX_PARALLELISM } from '@shared/operational-runs'
import { DeferredAuthorityError, openTaskAuthorityDatabase, type TaskAuthorityDatabase } from './schema'

type Row = Record<string, unknown>

const ACTIVE_STATES: Record<string, true> = { claimed: true, launching: true, running: true }
const CAPACITY_STATES: Record<string, true> = { claimed: true, launching: true, running: true, cancelling: true, quarantined: true }
const TERMINAL_ATTEMPT_STATES: Record<string, true> = { cancelled: true, exited: true, completed: true, failed: true }
const TERMINAL_MEMBER_STATES: Record<string, true> = { cancelled: true, completed: true, failed: true }
const TERMINAL_TASK_STATUSES: Record<string, true> = { cancelled: true, done: true, failed: true }
const TERMINAL_EXECUTION_STATES: Record<string, true> = { cancelled: true, succeeded: true, failed: true }

function nowIso(): string {
  return new Date().toISOString()
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function authorityNowMs(db: DatabaseSync): number {
  const row = db.prepare("SELECT unixepoch('subsec') * 1000 AS ms").get() as Row
  return int(row['ms'])
}

function text(value: unknown): string {
  return String(value)
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function int(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new TaskAuthorityError('DAEMON_UPGRADE_REQUIRED', 'persisted task authority value was not a safe integer')
  }
  return parsed
}

function bool(value: unknown): boolean {
  return value === 1 || value === true
}

function parseJson(value: unknown): unknown {
  return JSON.parse(String(value))
}

function boundedField(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0')) {
    throw new TaskAuthorityValidationError(field, `must be a non-empty string of at most ${maximum} characters`)
  }
  return value
}

function boundedText(value: unknown, field: string, maximum: number, allowEmpty = true): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > maximum || value.includes('\0')) {
    throw new TaskAuthorityValidationError(field, `must be a string of at most ${maximum} characters`)
  }
  return value
}

/** Rejects unknown keys on mutation inputs before any parsing or database work. */
function assertKnownFields(value: unknown, field: string, allowed: readonly string[]): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TaskAuthorityValidationError(field, 'must be an object')
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TaskAuthorityValidationError(field, `unknown key "${key}"`)
  }
}

function entityVersion(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TaskAuthorityValidationError(field, 'must be a positive integer')
  }
  return value
}

function ttlMs(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < TASK_AUTHORITY_MIN_LEASE_TTL_MS || value > TASK_AUTHORITY_MAX_LEASE_TTL_MS) {
    throw new TaskAuthorityValidationError(field, `must be an integer from ${TASK_AUTHORITY_MIN_LEASE_TTL_MS} to ${TASK_AUTHORITY_MAX_LEASE_TTL_MS} milliseconds`)
  }
  return value
}

function isoTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new TaskAuthorityValidationError(field, 'must be an ISO 8601 timestamp')
  }
  return new Date(value).toISOString()
}

function optionalIsoTimestamp(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  return isoTimestamp(value, field)
}

function encodeCursor(parts: readonly (string | number)[]): string {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string): Array<string | number> {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new TaskAuthorityValidationError('cursor', 'was malformed')
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some(part => typeof part !== 'string' && typeof part !== 'number')) {
    throw new TaskAuthorityValidationError('cursor', 'was malformed')
  }
  return parsed as Array<string | number>
}

// ---------------------------------------------------------------------------
// Row loading and snapshots
// ---------------------------------------------------------------------------

function loadTaskRow(db: DatabaseSync, projectId: string, taskId: string): Row {
  const row = db.prepare('SELECT * FROM tasks WHERE project_id = ? AND id = ?').get(projectId, taskId) as Row | undefined
  if (!row) throw new TaskAuthorityError('TASK_NOT_FOUND', `task ${taskId} was not found in project ${projectId}`)
  return row
}

function loadAttemptRow(db: DatabaseSync, projectId: string, attemptId: string): Row {
  const row = db.prepare('SELECT * FROM attempts WHERE project_id = ? AND id = ?').get(projectId, attemptId) as Row | undefined
  if (!row) throw new TaskAuthorityError('STALE_AUTHORITY', `attempt ${attemptId} was not found in project ${projectId}`)
  return row
}

function loadLeaseRow(db: DatabaseSync, projectId: string, leaseId: string): Row {
  const row = db.prepare('SELECT * FROM leases WHERE project_id = ? AND id = ?').get(projectId, leaseId) as Row | undefined
  if (!row) throw new TaskAuthorityError('STALE_AUTHORITY', `lease ${leaseId} was not found in project ${projectId}`)
  return row
}

function effectiveExpiryMs(db: DatabaseSync, lease: Row): number {
  const row = db.prepare('SELECT COALESCE(MAX(expires_at_ms), ?) AS expiry FROM lease_renewals WHERE project_id = ? AND lease_id = ?')
    .get(int(lease['initial_expires_at_ms']), text(lease['project_id']), text(lease['id'])) as Row
  return int(row['expiry'])
}

function leaseSnapshot(db: DatabaseSync, lease: Row): { leaseId: string; ownerId: string; generation: number; issuedAt: string; expiresAt: string; expiresAtMs: number } {
  const expiryMs = effectiveExpiryMs(db, lease)
  return {
    leaseId: text(lease['id']),
    ownerId: text(lease['owner_id']),
    generation: int(lease['generation']),
    issuedAt: new Date(int(lease['issued_at_ms'])).toISOString(),
    expiresAt: new Date(expiryMs).toISOString(),
    expiresAtMs: expiryMs
  }
}

function latestLaunchIntent(db: DatabaseSync, projectId: string, attemptId: string): Row | undefined {
  return db.prepare('SELECT * FROM launch_intents WHERE project_id = ? AND attempt_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(projectId, attemptId) as Row | undefined
}

function attemptSnapshot(db: DatabaseSync, attempt: Row): AttemptSnapshot {
  const projectId = text(attempt['project_id'])
  const attemptId = text(attempt['id'])
  const leaseId = textOrNull(attempt['current_lease_id'])
  const lease = leaseId === null ? null : loadLeaseRow(db, projectId, leaseId)
  const intent = latestLaunchIntent(db, projectId, attemptId)
  const reservation = db.prepare("SELECT * FROM resource_reservations WHERE project_id = ? AND attempt_id = ? AND state IN ('reserved','quarantined') ORDER BY created_at DESC, rowid DESC LIMIT 1").get(projectId, attemptId) as Row | undefined
  const progress = db.prepare("SELECT payload_json FROM task_events WHERE project_id = ? AND task_id = ? AND attempt_id = ? AND event_type = 'task-progress' ORDER BY sequence DESC LIMIT 1").get(projectId, text(attempt['task_id']), attemptId) as Row | undefined
  let processIdentity: ProcessIdentity | null = null
  const identityJson = intent === undefined ? null : textOrNull(intent['process_identity_json'])
  if (identityJson !== null) processIdentity = parseJson(identityJson) as ProcessIdentity
  let lastProgress: string | null = null
  if (progress !== undefined) {
    const payload = parseJson(progress['payload_json']) as Record<string, unknown>
    lastProgress = typeof payload['detail'] === 'string' ? payload['detail'] : null
  }
  return {
    projectId,
    taskId: text(attempt['task_id']),
    attemptId,
    sequence: int(attempt['sequence']),
    retryOfAttemptId: textOrNull(attempt['retry_of_attempt_id']),
    provenance: text(attempt['provenance_kind']) as AttemptSnapshot['provenance'],
    state: text(attempt['state']) as AttemptSnapshot['state'],
    specificationId: text(attempt['specification_id']),
    currentLease: lease === null ? null : leaseSnapshot(db, lease),
    runtime: intent === undefined ? null : {
      sessionId: textOrNull(intent['session_id']),
      processIdentity,
      launchIntentId: text(intent['id']),
      launchState: text(intent['state']) as 'planned' | 'spawning' | 'reconciling-no-spawn' | 'stopped',
      stopState: text(intent['stop_state']) as 'none' | 'requested' | 'exited'
    },
    reservation: reservation === undefined ? null : {
      resourceKey: text(reservation['canonical_resource_key']),
      canonicalResourceKey: text(reservation['canonical_resource_key']),
      state: text(reservation['state']) as ResourceReservationSnapshot['state']
    },
    lastProgress,
    startedAt: text(attempt['started_at']),
    finishedAt: textOrNull(attempt['finished_at'])
  }
}

function dependencyStatus(db: DatabaseSync, projectId: string, taskId: string): { dependencies: string[]; dependencyBlocked: boolean } {
  const rows = db.prepare('SELECT depends_on_task_id FROM task_dependencies WHERE project_id = ? AND task_id = ? ORDER BY depends_on_task_id').all(projectId, taskId) as Row[]
  const dependencies = rows.map(row => text(row['depends_on_task_id']))
  let dependencyBlocked = false
  for (const dependsOn of dependencies) {
    const dep = db.prepare('SELECT status FROM tasks WHERE project_id = ? AND id = ?').get(projectId, dependsOn) as Row | undefined
    if (!dep || text(dep['status']) !== 'done') dependencyBlocked = true
  }
  return { dependencies, dependencyBlocked }
}

function taskSnapshot(db: DatabaseSync, task: Row): TaskSnapshot {
  const projectId = text(task['project_id'])
  const taskId = text(task['id'])
  const { dependencies, dependencyBlocked } = dependencyStatus(db, projectId, taskId)
  const status = text(task['status']) as TaskStatus
  const cancelState = text(task['cancel_state']) as TaskSnapshot['cancelState']
  const currentAttemptId = textOrNull(task['current_attempt_id'])
  return {
    projectId,
    taskId,
    externalTaskId: text(task['external_task_id']),
    title: text(task['title']),
    body: text(task['body']),
    status,
    priority: int(task['priority']),
    dependencies,
    dependencyBlocked,
    runnable: status === 'todo' && !dependencyBlocked && cancelState === 'none',
    cancelState,
    currentAttempt: currentAttemptId === null ? null : attemptSnapshot(db, loadAttemptRow(db, projectId, currentAttemptId)),
    entityVersion: int(task['entity_version']),
    createdAt: text(task['created_at']),
    updatedAt: text(task['updated_at'])
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function appendTaskEvent(db: DatabaseSync, projectId: string, taskId: string, attemptId: string | null, eventType: string, entityVersion: number, payload: Record<string, unknown>): void {
  db.prepare('INSERT INTO task_events(event_id, project_id, task_id, attempt_id, event_type, entity_version, payload_json, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(randomUUID(), projectId, taskId, attemptId, eventType, entityVersion, JSON.stringify(payload), nowIso())
}

function appendProfileEvent(db: DatabaseSync, profileId: string, runGroupId: string | null, eventType: string, entityVersion: number, payload: Record<string, unknown>): void {
  db.prepare('INSERT INTO authority_profile_events(event_id, profile_id, run_group_id, event_type, entity_version, payload_json, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(randomUUID(), profileId, runGroupId, eventType, entityVersion, JSON.stringify(payload), nowIso())
}

// ---------------------------------------------------------------------------
// Authorization and fencing
// ---------------------------------------------------------------------------

function requireAdministrator(connection: AuthenticatedAuthorityConnection): void {
  if (connection.role !== 'administrator') {
    throw new TaskAuthorityError('AUTHORIZATION_DENIED', `role "${connection.role}" may not perform administrator task authority intents`)
  }
}

function requireWorker(connection: AuthenticatedAuthorityConnection, projectId: string): string {
  if (connection.role !== 'worker') {
    throw new TaskAuthorityError('AUTHORIZATION_DENIED', `role "${connection.role}" may not act as a task worker`)
  }
  if (connection.ownerId === undefined) {
    throw new TaskAuthorityError('AUTHORIZATION_DENIED', 'worker connection carried no authenticated owner identity')
  }
  if (connectionDeniedProject(connection, projectId)) {
    throw new TaskAuthorityError('PROJECT_SCOPE_MISMATCH', `worker connection is not authorized for project ${projectId}`)
  }
  return connection.ownerId
}

function requireReviewer(connection: AuthenticatedAuthorityConnection, projectId: string): string {
  if (connection.role !== 'reviewer' && connection.role !== 'administrator') {
    throw new TaskAuthorityError('AUTHORIZATION_DENIED', `role "${connection.role}" may not review task authority artifacts`)
  }
  if (connection.role === 'reviewer' && connectionDeniedProject(connection, projectId)) {
    throw new TaskAuthorityError('PROJECT_SCOPE_MISMATCH', `reviewer connection is not authorized for project ${projectId}`)
  }
  return connection.ownerId ?? connection.connectionId
}

function requireAdminProject(connection: AuthenticatedAuthorityConnection, projectId: string): void {
  requireAdministrator(connection)
  if (connection.authorizedProjectIds !== undefined && !connection.authorizedProjectIds.includes(projectId)) {
    throw new TaskAuthorityError('PROJECT_SCOPE_MISMATCH', `administrator connection is not authorized for project ${projectId}`)
  }
}

function requireAdminProfile(connection: AuthenticatedAuthorityConnection, profileId: string): void {
  requireAdministrator(connection)
  if (connectionDeniedProfile(connection, profileId)) {
    throw new TaskAuthorityError('PROJECT_SCOPE_MISMATCH', `administrator connection is not authorized for profile ${profileId}`)
  }
}

function requireAdminProjectOrWorkerRead(connection: AuthenticatedAuthorityConnection, projectId: string): void {
  if (connection.role === 'administrator') {
    if (connection.authorizedProjectIds !== undefined && !connection.authorizedProjectIds.includes(projectId)) {
      throw new TaskAuthorityError('PROJECT_SCOPE_MISMATCH', `administrator connection is not authorized for project ${projectId}`)
    }
    return
  }
  if (connectionDeniedProject(connection, projectId)) {
    throw new TaskAuthorityError('PROJECT_SCOPE_MISMATCH', `connection is not authorized for project ${projectId}`)
  }
}

type FencedWrite = Readonly<{ task: Row; attempt: Row; lease: Row; expiryMs: number }>

/**
 * Runs the ordinary-write predicate and dissects every failure into a
 * deterministic typed error: cancelled, expired, handoff-pending,
 * authorization-denied, project-mismatch, or stale-authority.
 */
function requireFencedWrite(db: DatabaseSync, token: LeaseToken, ownerId: string): FencedWrite {
  const task = db.prepare('SELECT * FROM tasks WHERE project_id = ? AND id = ?').get(token.projectId, token.taskId) as Row | undefined
  if (!task) throw new TaskAuthorityError('TASK_NOT_FOUND', `task ${token.taskId} was not found in project ${token.projectId}`)
  const attempt = db.prepare('SELECT * FROM attempts WHERE project_id = ? AND id = ? AND task_id = ?').get(token.projectId, token.attemptId, token.taskId) as Row | undefined
  if (!attempt || textOrNull(attempt['current_lease_id']) !== token.leaseId) {
    throw new TaskAuthorityError('STALE_AUTHORITY', `attempt ${token.attemptId} is not the current attempt of task ${token.taskId}`)
  }
  const lease = db.prepare('SELECT * FROM leases WHERE project_id = ? AND id = ? AND attempt_id = ?').get(token.projectId, token.leaseId, token.attemptId) as Row | undefined
  if (!lease || int(lease['generation']) !== token.generation) {
    throw new TaskAuthorityError('STALE_AUTHORITY', `lease ${token.leaseId} generation ${token.generation} is not current for attempt ${token.attemptId}`)
  }
  if (text(task['cancel_state']) !== 'none') throw new TaskAuthorityError('TASK_CANCELLED', `task ${token.taskId} has cancellation requested`)
  const cancellingMember = db.prepare(
    "SELECT 1 FROM run_members rm JOIN run_groups rg ON rg.id = rm.run_group_id WHERE rm.project_id = ? AND rm.task_id = ? AND (rg.state IN ('cancelling','cancelled') OR rm.state IN ('cancelling','cancelled')) LIMIT 1"
  ).get(token.projectId, token.taskId) as Row | undefined
  if (cancellingMember) throw new TaskAuthorityError('TASK_CANCELLED', `task ${token.taskId} belongs to a cancelling run group or member`)
  const cancellingExecution = db.prepare(
    "SELECT 1 FROM schedule_executions WHERE project_id = ? AND task_id = ? AND state IN ('cancelling','cancelled') LIMIT 1"
  ).get(token.projectId, token.taskId) as Row | undefined
  if (cancellingExecution) throw new TaskAuthorityError('TASK_CANCELLED', `task ${token.taskId} belongs to a cancelling schedule execution`)
  const attemptState = text(attempt['state']) as AttemptState
  if (attemptState === 'quarantined') throw new TaskAuthorityError('RESOURCE_QUARANTINED', `attempt ${token.attemptId} is quarantined`)
  if (!ACTIVE_STATES[attemptState]) throw new TaskAuthorityError('STALE_AUTHORITY', `attempt ${token.attemptId} is ${attemptState} and no longer writable`)
  if (text(lease['owner_id']) !== ownerId) {
    throw new TaskAuthorityError('AUTHORIZATION_DENIED', `lease ${token.leaseId} belongs to a different authenticated owner`)
  }
  const expiryMs = effectiveExpiryMs(db, lease)
  if (expiryMs <= authorityNowMs(db)) throw new TaskAuthorityError('LEASE_EXPIRED', `lease ${token.leaseId} expired before the write`)
  const liveOffer = db.prepare(
    "SELECT 1 FROM handoff_offers WHERE project_id = ? AND task_id = ? AND attempt_id = ? AND status = 'pending' AND expires_at_ms > unixepoch('subsec') * 1000 LIMIT 1"
  ).get(token.projectId, token.taskId, token.attemptId) as Row | undefined
  if (liveOffer) throw new TaskAuthorityError('HANDOFF_PENDING', `attempt ${token.attemptId} has a live handoff offer`)
  return { task, attempt, lease, expiryMs }
}

function parseLeaseToken(value: unknown, field = 'token'): LeaseToken {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TaskAuthorityValidationError(field, 'must be a lease token object')
  }
  const record = value as Record<string, unknown>
  const allowed = ['projectId', 'taskId', 'attemptId', 'ownerId', 'leaseId', 'generation', 'expiresAt']
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new TaskAuthorityValidationError(field, `unknown key "${key}"`)
  }
  return {
    projectId: boundedField(record['projectId'], `${field}.projectId`, 128),
    taskId: assertAuthorityUuid(record['taskId'], `${field}.taskId`),
    attemptId: assertAuthorityUuid(record['attemptId'], `${field}.attemptId`),
    ownerId: assertAuthorityUuid(record['ownerId'], `${field}.ownerId`),
    leaseId: assertAuthorityUuid(record['leaseId'], `${field}.leaseId`),
    generation: entityVersion(record['generation'], `${field}.generation`),
    expiresAt: isoTimestamp(record['expiresAt'], `${field}.expiresAt`)
  }
}

// ---------------------------------------------------------------------------
// Specifications and shared mutation helpers
// ---------------------------------------------------------------------------

function insertSpecification(db: DatabaseSync, projectId: string, taskId: string, specification: TaskExecutionSpecificationInput): string {
  const specificationId = randomUUID()
  const commandJson = JSON.stringify(specification.command)
  const targetJson = JSON.stringify(specification.target)
  const verificationJson = JSON.stringify(specification.verification)
  db.prepare("INSERT INTO execution_specifications(id, project_id, task_id, command_json, target_json, verification_json, source_sha256, provenance_kind, created_at) VALUES (?,?,?,?,?,?,?,'native',?)")
    .run(specificationId, projectId, taskId, commandJson, targetJson, verificationJson, sha256(commandJson + targetJson + verificationJson), nowIso())
  return specificationId
}

function ensureProject(db: DatabaseSync, projectId: string, repositoryId: string | undefined, workspaceRoot: string | undefined): void {
  const existing = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId) as Row | undefined
  if (existing) return
  db.prepare('INSERT INTO projects(id, repository_id, workspace_root, version) VALUES (?,?,?,1)').run(projectId, repositoryId ?? '', workspaceRoot ?? '')
}

function insertAttemptWithLease(db: DatabaseSync, projectId: string, taskId: string, sequence: number, retryOfAttemptId: string | null, specificationId: string, ownerId: string, ttl: number, nowMs: number): { attemptId: string; leaseId: string } {
  const attemptId = randomUUID()
  const leaseId = randomUUID()
  db.prepare('INSERT INTO leases(id, project_id, task_id, attempt_id, owner_id, generation, issued_at_ms, initial_expires_at_ms) VALUES (?,?,?,?,?,1,?,?)')
    .run(leaseId, projectId, taskId, attemptId, ownerId, nowMs, nowMs + ttl)
  db.prepare("INSERT INTO attempts(id, project_id, task_id, sequence, retry_of_attempt_id, provenance_kind, state, specification_id, current_lease_id, started_at, finished_at) VALUES (?,?,?,?,?,'native','claimed',?,?,?,NULL)")
    .run(attemptId, projectId, taskId, sequence, retryOfAttemptId, specificationId, leaseId, nowIso())
  return { attemptId, leaseId }
}

function tokenFor(projectId: string, taskId: string, attemptId: string, lease: Row, expiryMs: number): LeaseToken {
  return {
    projectId,
    taskId,
    attemptId,
    ownerId: text(lease['owner_id']),
    leaseId: text(lease['id']),
    generation: int(lease['generation']),
    expiresAt: new Date(expiryMs).toISOString()
  }
}

function bumpTask(db: DatabaseSync, projectId: string, taskId: string, set: string, params: Array<string | number | null>): number {
  db.prepare(`UPDATE tasks SET ${set}, entity_version = entity_version + 1, updated_at = ? WHERE project_id = ? AND id = ?`).run(...params, nowIso(), projectId, taskId)
  const updated = db.prepare('SELECT entity_version FROM tasks WHERE project_id = ? AND id = ?').get(projectId, taskId) as Row | undefined
  if (!updated) throw new TaskAuthorityError('STALE_AUTHORITY', `task ${taskId} changed concurrently`)
  return int(updated['entity_version'])
}

function syncMemberState(db: DatabaseSync, projectId: string, taskId: string, state: RunMemberState): void {
  db.prepare("UPDATE run_members SET state = ? WHERE project_id = ? AND task_id = ? AND state NOT IN ('cancelled','completed')").run(state, projectId, taskId)
}

function releaseReservation(db: DatabaseSync, projectId: string, attemptId: string): void {
  db.prepare("UPDATE resource_reservations SET state = 'released', released_at = ? WHERE project_id = ? AND attempt_id = ? AND state IN ('reserved','quarantined')").run(nowIso(), projectId, attemptId)
}

function syncExecutionForTask(db: DatabaseSync, projectId: string, taskId: string, apply: (execution: Row) => { state: ScheduleExecutionState; attemptId?: string | null }): void {
  const execution = db.prepare('SELECT * FROM schedule_executions WHERE project_id = ? AND task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(projectId, taskId) as Row | undefined
  if (!execution) return
  const next = apply(execution)
  db.prepare('UPDATE schedule_executions SET state = ?, attempt_id = COALESCE(?, attempt_id), entity_version = entity_version + 1 WHERE project_id = ? AND id = ?')
    .run(next.state, next.attemptId === undefined ? null : next.attemptId, projectId, text(execution['id']))
}

function stopLaunchIntent(db: DatabaseSync, projectId: string, attemptId: string, state: string, stopState: string): void {
  db.prepare('UPDATE launch_intents SET state = ?, stop_state = ?, updated_at = ? WHERE project_id = ? AND attempt_id = ? AND state IN (?,?)')
    .run(state, stopState, nowIso(), projectId, attemptId, 'planned', 'spawning')
}

function nextAttemptSequence(db: DatabaseSync, projectId: string, taskId: string): number {
  const row = db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS seq FROM attempts WHERE project_id = ? AND task_id = ?').get(projectId, taskId) as Row
  return int(row['seq'])
}

function assertTaskClaimable(db: DatabaseSync, task: Row): void {
  const projectId = text(task['project_id'])
  const taskId = text(task['id'])
  if (text(task['cancel_state']) !== 'none' || text(task['status']) === 'cancelling' || text(task['status']) === 'cancelled') {
    throw new TaskAuthorityError('TASK_CANCELLED', `task ${taskId} has cancellation requested`)
  }
  if (text(task['status']) === 'blocked') throw new TaskAuthorityError('TASK_NOT_RUNNABLE', `task ${taskId} is explicitly blocked`)
  if (text(task['status']) !== 'todo') throw new TaskAuthorityError('TASK_NOT_RUNNABLE', `task ${taskId} is ${text(task['status'])} and cannot be claimed`)
  if (textOrNull(task['current_attempt_id']) !== null) throw new TaskAuthorityError('STALE_AUTHORITY', `task ${taskId} already has a current attempt`)
  const unfinished = db.prepare(
    "SELECT 1 FROM task_dependencies d JOIN tasks dep ON dep.project_id = d.project_id AND dep.id = d.depends_on_task_id WHERE d.project_id = ? AND d.task_id = ? AND dep.status <> 'done' LIMIT 1"
  ).get(projectId, taskId) as Row | undefined
  if (unfinished) throw new TaskAuthorityError('DEPENDENCY_BLOCKED', `task ${taskId} has an unfinished dependency`)
}

function assertNoDependencyCycle(db: DatabaseSync, projectId: string, taskId: string): void {
  const edges = db.prepare('SELECT task_id, depends_on_task_id FROM task_dependencies WHERE project_id = ?').all(projectId) as Row[]
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    const from = text(edge['task_id'])
    const to = text(edge['depends_on_task_id'])
    const list = adjacency.get(from) ?? []
    list.push(to)
    adjacency.set(from, list)
  }
  const visited = new Set<string>()
  const stack = new Set<string>()
  const visit = (node: string): boolean => {
    if (stack.has(node)) return true
    if (visited.has(node)) return false
    visited.add(node)
    stack.add(node)
    for (const next of adjacency.get(node) ?? []) {
      if (visit(next)) return true
    }
    stack.delete(node)
    return false
  }
  if (visit(taskId)) {
    throw new TaskAuthorityError('DEPENDENCY_BLOCKED', `dependency edges for task ${taskId} would create a cycle`)
  }
}

function quarantineAttempt(db: DatabaseSync, projectId: string, taskId: string, attemptId: string, reason: string): void {
  db.prepare("UPDATE attempts SET state = 'quarantined' WHERE project_id = ? AND id = ? AND state NOT IN ('cancelled','exited','completed','failed')").run(projectId, attemptId)
  db.prepare("UPDATE resource_reservations SET state = 'quarantined' WHERE project_id = ? AND attempt_id = ? AND state = 'reserved'").run(projectId, attemptId)
  db.prepare("UPDATE tasks SET status = 'quarantined', entity_version = entity_version + 1, updated_at = ? WHERE project_id = ? AND id = ? AND status NOT IN ('cancelled','done')").run(nowIso(), projectId, taskId)
  syncMemberState(db, projectId, taskId, 'quarantined')
  appendTaskEvent(db, projectId, taskId, attemptId, 'attempt-quarantined', int(loadTaskRow(db, projectId, taskId)['entity_version']), { reason })
}

/** True when the task holds a live attempt whose exit must be acknowledged before terminal close. */
function taskAwaitingExitAck(db: DatabaseSync, projectId: string, taskId: string, attemptId: string | null): boolean {
  if (attemptId === null) return false
  const attempt = db.prepare('SELECT state FROM attempts WHERE project_id = ? AND id = ?').get(projectId, attemptId) as Row | undefined
  return attempt !== undefined && CAPACITY_STATES[text(attempt['state']) as AttemptState] === true
}

/**
 * Terminal close for cancellations whose task has no live attempt (todo,
 * queued, or otherwise attempt-less): there is no process exit to
 * acknowledge, so the same transaction moves every linked record to
 * terminal cancelled. Attempt-holding tasks still require trusted
 * acknowledgeExit and keep capacity/reservations while cancelling.
 */
function closeCancellationTerminal(db: DatabaseSync, projectId: string, taskId: string, attemptId: string | null): number {
  if (attemptId !== null) {
    db.prepare("UPDATE attempts SET state = 'cancelled', finished_at = ? WHERE project_id = ? AND id = ? AND state NOT IN ('cancelled','exited','completed','failed')").run(nowIso(), projectId, attemptId)
    stopLaunchIntent(db, projectId, attemptId, 'stopped', 'exited')
    releaseReservation(db, projectId, attemptId)
  }
  db.prepare("UPDATE run_members SET state = 'cancelled' WHERE project_id = ? AND task_id = ? AND state <> 'completed'").run(projectId, taskId)
  syncExecutionForTask(db, projectId, taskId, () => ({ state: 'cancelled' }))
  return bumpTask(db, projectId, taskId, "status = 'cancelled', cancel_state = 'none'", [])
}

/** Flip a run group to terminal cancelled once every linked member is terminal. */
function closeGroupIfFullyTerminal(db: DatabaseSync, runGroupId: string): void {
  const open = db.prepare("SELECT 1 FROM run_members WHERE run_group_id = ? AND state IN ('queued','claimed','launching','running','cancelling','quarantined') LIMIT 1").get(runGroupId) as Row | undefined
  if (open) return
  db.prepare("UPDATE run_groups SET state = 'cancelled', entity_version = entity_version + 1, updated_at = ? WHERE id = ? AND state = 'cancelling'").run(nowIso(), runGroupId)
}

function assertCompletionRequirements(db: DatabaseSync, token: LeaseToken): void {
  const attempt = loadAttemptRow(db, token.projectId, token.attemptId)
  const specification = db.prepare('SELECT verification_json FROM execution_specifications WHERE project_id = ? AND id = ?').get(token.projectId, text(attempt['specification_id'])) as Row | undefined
  if (!specification) throw new TaskAuthorityError('STALE_AUTHORITY', `specification ${text(attempt['specification_id'])} was not found`)
  const verification = parseJson(specification['verification_json']) as { requiredArtifacts?: Array<{ path: string; relationship: string }> }
  for (const required of verification.requiredArtifacts ?? []) {
    const satisfied = db.prepare(
      `SELECT 1 FROM verification_artifacts va WHERE va.project_id = ? AND va.task_id = ? AND va.path = ? AND va.relationship = ? AND (
        (va.provenance_kind = 'native' AND va.attempt_id = ? AND va.lease_id = ? AND va.generation = ?)
        OR (va.provenance_kind = 'imported-legacy' AND EXISTS (SELECT 1 FROM artifact_adoptions ad WHERE ad.artifact_id = va.id AND ad.project_id = va.project_id AND ad.current_attempt_id = ?))
      ) LIMIT 1`
    ).get(token.projectId, token.taskId, required.path, required.relationship, token.attemptId, token.leaseId, token.generation, token.attemptId) as Row | undefined
    if (!satisfied) {
      throw new TaskAuthorityError('COMPLETION_REJECTED', `required verification artifact ${required.path} (${required.relationship}) is not satisfied for the current attempt`)
    }
  }
}

function reconciliationReason(verdict: unknown): string {
  const status = (verdict as Record<string, unknown>)['status']
  if (status === 'valid') return 'child process identity verified live'
  if (status === 'stale') return `child process confirmed exited: ${JSON.stringify((verdict as Record<string, unknown>)['reason'])}`
  return `child process observation indeterminate: ${JSON.stringify((verdict as Record<string, unknown>)['detail'])}`
}

/**
 * Fencing side effects (quarantine, offer expiry) commit before the semantic
 * error is reported; the transaction wrapper persists them and rethrows.
 */
function failAfterCommit(code: InstanceType<typeof TaskAuthorityError>['code'], message: string): never {
  throw new DeferredAuthorityError(new TaskAuthorityError(code, message))
}

// ---------------------------------------------------------------------------
// Schedule helpers
// ---------------------------------------------------------------------------

function parseScheduleSpec(value: unknown, field = 'spec'): TaskScheduleSpec {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TaskAuthorityValidationError(field, 'must be an object')
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!['profileId', 'taskTitle', 'cadence', 'command', 'target', 'verification'].includes(key)) {
      throw new TaskAuthorityValidationError(field, `unknown key "${key}"`)
    }
  }
  const profileId = boundedField(record['profileId'], `${field}.profileId`, 128)
  const taskTitle = boundedText(record['taskTitle'], `${field}.taskTitle`, TASK_AUTHORITY_MAX_TITLE, false)
  const cadence = record['cadence']
  if (typeof cadence !== 'object' || cadence === null || Array.isArray(cadence)) {
    throw new TaskAuthorityValidationError(`${field}.cadence`, 'must be an object')
  }
  const cadenceRecord = cadence as Record<string, unknown>
  let parsedCadence: TaskScheduleSpec['cadence']
  if (cadenceRecord['kind'] === 'interval') {
    const minutes = cadenceRecord['minutes']
    if (typeof minutes !== 'number' || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 60 * 24 * 31) {
      throw new TaskAuthorityValidationError(`${field}.cadence.minutes`, 'must be an integer number of minutes')
    }
    parsedCadence = { kind: 'interval', minutes }
  } else if (cadenceRecord['kind'] === 'daily') {
    const time = cadenceRecord['time']
    const timeZone = cadenceRecord['timeZone']
    if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      throw new TaskAuthorityValidationError(`${field}.cadence.time`, 'must be HH:MM')
    }
    if (typeof timeZone !== 'string' || timeZone.length === 0 || timeZone.length > 128) {
      throw new TaskAuthorityValidationError(`${field}.cadence.timeZone`, 'must be an IANA time zone name')
    }
    try {
      Intl.DateTimeFormat(undefined, { timeZone })
    } catch {
      throw new TaskAuthorityValidationError(`${field}.cadence.timeZone`, 'must be an IANA time zone name')
    }
    parsedCadence = { kind: 'daily', time, timeZone }
  } else {
    throw new TaskAuthorityValidationError(`${field}.cadence.kind`, 'must be "interval" or "daily"')
  }
  const specification = parseTaskExecutionSpecification({ command: record['command'], target: record['target'], verification: record['verification'] }, field)
  return { profileId, taskTitle, cadence: parsedCadence, command: specification.command, target: specification.target, verification: specification.verification }
}

function scheduleDefinitionJson(spec: TaskScheduleSpec): string {
  return JSON.stringify({
    profileId: spec.profileId,
    taskTitle: spec.taskTitle,
    cadence: spec.cadence,
    command: spec.command,
    target: spec.target,
    verification: spec.verification
  })
}

function readScheduleSpec(definitionJson: string): TaskScheduleSpec {
  return parseScheduleSpec(parseJson(definitionJson), 'persisted schedule definition')
}

function scheduleSnapshot(db: DatabaseSync, row: Row): ScheduleSnapshot {
  const spec = readScheduleSpec(text(row['definition_json']))
  return {
    scheduleId: text(row['id']),
    projectId: text(row['project_id']),
    profileId: spec.profileId,
    taskTitle: spec.taskTitle,
    cadence: spec.cadence,
    command: spec.command,
    target: spec.target,
    verification: spec.verification,
    enabled: bool(row['enabled']),
    entityVersion: int(row['entity_version']),
    nextRunAt: textOrNull(row['next_run_at']),
    createdAt: text(row['created_at']),
    updatedAt: text(row['updated_at'])
  }
}

function loadSchedule(db: DatabaseSync, projectId: string, scheduleId: string): Row {
  const row = db.prepare('SELECT * FROM schedules WHERE project_id = ? AND id = ?').get(projectId, scheduleId) as Row | undefined
  if (!row) throw new TaskAuthorityError('TASK_NOT_FOUND', `schedule ${scheduleId} was not found in project ${projectId}`)
  return row
}

function nextIntervalRun(spec: TaskScheduleSpec, afterIso: string): string {
  return new Date(Date.parse(afterIso) + (spec.cadence.kind === 'interval' ? spec.cadence.minutes * 60_000 : 24 * 60 * 60_000)).toISOString()
}

function zonedUtcParts(instant: Date, timeZone: string): { zonedUtc: number; year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(instant).reduce<Record<string, string>>((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value
    return acc
  }, {})
  const year = Number(parts['year'])
  const month = Number(parts['month'])
  const day = Number(parts['day'])
  const zonedUtc = Date.UTC(year, month - 1, day, Number(parts['hour']) % 24, Number(parts['minute']), Number(parts['second']))
  return { zonedUtc, year, month, day }
}

function computeNextRunAt(spec: TaskScheduleSpec, afterIso: string): string {
  if (spec.cadence.kind === 'interval') return nextIntervalRun(spec, afterIso)
  const [hours, minutes] = spec.cadence.time.split(':').map(part => Number(part))
  const anchor = new Date(afterIso)
  for (let dayOffset = 0; dayOffset < 3; dayOffset += 1) {
    const probe = new Date(anchor.getTime() + dayOffset * 24 * 60 * 60_000)
    const zoned = zonedUtcParts(probe, spec.cadence.timeZone)
    const zoneOffsetMs = zoned.zonedUtc - probe.getTime()
    const wallUtc = Date.UTC(zoned.year, zoned.month - 1, zoned.day, hours, minutes, 0)
    const candidate = new Date(wallUtc - zoneOffsetMs)
    if (candidate.getTime() > anchor.getTime()) return candidate.toISOString()
  }
  throw new TaskAuthorityError('DAEMON_UPGRADE_REQUIRED', 'could not compute the next daily schedule occurrence')
}

function executionSnapshot(row: Row): ScheduleExecutionSnapshot {
  return {
    projectId: text(row['project_id']),
    scheduleId: text(row['schedule_id']),
    executionId: text(row['id']),
    trigger: text(row['trigger']) as ScheduleExecutionSnapshot['trigger'],
    idempotencyKey: text(row['idempotency_key']),
    intentSha256: text(row['intent_sha256']),
    taskId: text(row['task_id']),
    attemptId: textOrNull(row['attempt_id']),
    dueAt: textOrNull(row['due_at']),
    state: text(row['state']) as ScheduleExecutionState,
    entityVersion: int(row['entity_version']),
    createdAt: text(row['created_at'])
  }
}

function findExecutionReceipt(db: DatabaseSync, projectId: string, scheduleId: string, trigger: string, idempotencyKey: string): Row | undefined {
  return db.prepare('SELECT * FROM schedule_executions WHERE project_id = ? AND schedule_id = ? AND trigger = ? AND idempotency_key = ?').get(projectId, scheduleId, trigger, idempotencyKey) as Row | undefined
}

function intentSha256(value: Record<string, unknown>): string {
  return sha256(JSON.stringify(value))
}

/** Deterministic fingerprint binding a launch intent row to its attempt/lease tuple. */
export function launchIntentFingerprint(launchIntentId: string, attemptId: string, leaseId: string): string {
  return sha256(JSON.stringify({ launchIntentId, attemptId, leaseId }))
}

// ---------------------------------------------------------------------------
// The authority
// ---------------------------------------------------------------------------

export class SqliteTaskAuthority implements TaskAuthority {
  /**
   * The shared central database. Daemon-internal surfaces (the profile
   * maintenance gate and the legacy importer) open this same connection policy
   * rather than a second file, connection, or SQLite `ATTACH`.
   */
  readonly database: TaskAuthorityDatabase

  constructor(database: TaskAuthorityDatabase) {
    this.database = database
  }

  static open(options: Parameters<typeof openTaskAuthorityDatabase>[0] = {}): SqliteTaskAuthority {
    return new SqliteTaskAuthority(openTaskAuthorityDatabase(options))
  }

  get databasePath(): string {
    return this.database.databasePath
  }

  close(): void {
    this.database.close()
  }

  // -- admin task intents ---------------------------------------------------

  createTask(input: AdminCreateTaskInput): TaskSnapshot {
    assertKnownFields(input, 'input', ['connection', 'projectId', 'repositoryId', 'workspaceRoot', 'externalTaskId', 'title', 'body', 'priority', 'status'])
    const connection = parseAuthorityConnection(input?.['connection'])
    const projectId = boundedField(input?.['projectId'], 'projectId', 128)
    const externalTaskId = boundedField(input?.['externalTaskId'], 'externalTaskId', 128)
    const title = boundedText(input?.['title'], 'title', TASK_AUTHORITY_MAX_TITLE, false)
    const body = boundedText(input?.['body'] ?? '', 'body', TASK_AUTHORITY_MAX_USER_TEXT)
    const priority = input?.['priority'] ?? 0
    if (typeof priority !== 'number' || !Number.isSafeInteger(priority) || Math.abs(priority) > 1_000_000) {
      throw new TaskAuthorityValidationError('priority', 'must be an integer')
    }
    const status = input?.['status'] ?? 'todo'
    if (status !== 'todo' && status !== 'blocked') {
      throw new TaskAuthorityValidationError('status', 'must be "todo" or "blocked"')
    }
    return this.database.withImmediate(db => {
      requireAdminProject(connection, projectId)
      ensureProject(db, projectId, input?.['repositoryId'], input?.['workspaceRoot'])
      const canonical = canonicalExternalTaskId(externalTaskId)
      const existing = db.prepare('SELECT id FROM tasks WHERE project_id = ? AND external_task_id_canonical = ?').get(projectId, canonical) as Row | undefined
      if (existing) {
        throw new TaskAuthorityValidationError('externalTaskId', `task "${externalTaskId}" already exists in project ${projectId}`)
      }
      const taskId = randomUUID()
      const created = nowIso()
      db.prepare("INSERT INTO tasks(id, project_id, external_task_id, external_task_id_canonical, title, body, status, priority, current_attempt_id, cancel_state, entity_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,NULL,'none',1,?,?)")
        .run(taskId, projectId, externalTaskId, canonical, title, body, status, priority, created, created)
      appendTaskEvent(db, projectId, taskId, null, 'task-created', 1, { externalTaskId, title, priority, status })
      return taskSnapshot(db, loadTaskRow(db, projectId, taskId))
    })
  }

  updateTask(input: AdminUpdateTaskInput): TaskSnapshot {
    assertKnownFields(input, 'input', ['connection', 'projectId', 'taskId', 'expectedEntityVersion', 'title', 'body', 'priority', 'status'])
    const connection = parseAuthorityConnection(input?.['connection'])
    const projectId = boundedField(input?.['projectId'], 'projectId', 128)
    const taskId = assertAuthorityUuid(input?.['taskId'], 'taskId')
    const expectedEntityVersion = entityVersion(input?.['expectedEntityVersion'], 'expectedEntityVersion')
    return this.database.withImmediate(db => {
      requireAdminProject(connection, projectId)
      const task = loadTaskRow(db, projectId, taskId)
      if (int(task['entity_version']) !== expectedEntityVersion) {
        throw new TaskAuthorityError('STALE_AUTHORITY', `task ${taskId} entity version ${expectedEntityVersion} did not match ${int(task['entity_version'])}`)
      }
      if (TERMINAL_TASK_STATUSES[text(task['status']) as TaskStatus]) {
        throw new TaskAuthorityError('STALE_AUTHORITY', `task ${taskId} is terminal and cannot be updated`)
      }
      const nextTitle = input?.['title'] === undefined ? text(task['title']) : boundedText(input['title'], 'title', TASK_AUTHORITY_MAX_TITLE, false)
      const nextBody = input?.['body'] === undefined ? text(task['body']) : boundedText(input['body'], 'body', TASK_AUTHORITY_MAX_USER_TEXT)
      const nextPriority = input?.['priority'] === undefined ? int(task['priority']) : input['priority']
      if (typeof nextPriority !== 'number' || !Number.isSafeInteger(nextPriority) || Math.abs(nextPriority) > 1_000_000) {
        throw new TaskAuthorityValidationError('priority', 'must be an integer')
      }
      const nextStatus = input?.['status'] ?? text(task['status'])
      if (nextStatus !== 'todo' && nextStatus !== 'blocked' && nextStatus !== text(task['status'])) {
        throw new TaskAuthorityValidationError('status', 'may only be set to "todo" or "blocked"')
      }
      const version = bumpTask(db, projectId, taskId, 'title = ?, body = ?, priority = ?, status = ?', [nextTitle, nextBody, nextPriority, nextStatus])
      appendTaskEvent(db, projectId, taskId, textOrNull(task['current_attempt_id']), 'task-updated', version, { title: nextTitle, priority: nextPriority, status: nextStatus })
      return taskSnapshot(db, loadTaskRow(db, projectId, taskId))
    })
  }

  setDependencies(input: AdminSetDependenciesInput): TaskSnapshot {
    assertKnownFields(input, 'input', ['connection', 'projectId', 'taskId', 'expectedEntityVersion', 'dependsOnTaskIds'])
    const connection = parseAuthorityConnection(input?.['connection'])
    const projectId = boundedField(input?.['projectId'], 'projectId', 128)
    const taskId = assertAuthorityUuid(input?.['taskId'], 'taskId')
    const expectedEntityVersion = entityVersion(input?.['expectedEntityVersion'], 'expectedEntityVersion')
    const dependsOn = input?.['dependsOnTaskIds']
    if (!Array.isArray(dependsOn) || dependsOn.length > TASK_AUTHORITY_MAX_BATCH) {
      throw new TaskAuthorityValidationError('dependsOnTaskIds', `must be an array of at most ${TASK_AUTHORITY_MAX_BATCH} task IDs`)
    }
    const dependsOnIds = dependsOn.map((id, index) => assertAuthorityUuid(id, `dependsOnTaskIds[${index}]`))
    return this.database.withImmediate(db => {
      requireAdminProject(connection, projectId)
      const task = loadTaskRow(db, projectId, taskId)
      if (int(task['entity_version']) !== expectedEntityVersion) {
        throw new TaskAuthorityError('STALE_AUTHORITY', `task ${taskId} entity version ${expectedEntityVersion} did not match ${int(task['entity_version'])}`)
      }
      for (const dependsOnId of dependsOnIds) {
        if (dependsOnId === taskId) throw new TaskAuthorityError('DEPENDENCY_BLOCKED', 'a task cannot depend on itself')
        const dep = db.prepare('SELECT id FROM tasks WHERE project_id = ? AND id = ?').get(projectId, dependsOnId) as Row | undefined
        if (!dep) throw new TaskAuthorityError('TASK_NOT_FOUND', `dependency task ${dependsOnId} was not found in project ${projectId}`)
      }
      db.prepare('DELETE FROM task_dependencies WHERE project_id = ? AND task_id = ?').run(projectId, taskId)
      for (const dependsOnId of dependsOnIds) {
        db.prepare('INSERT INTO task_dependencies(project_id, task_id, depends_on_task_id) VALUES (?,?,?)').run(projectId, taskId, dependsOnId)
      }
      assertNoDependencyCycle(db, projectId, taskId)
      const version = bumpTask(db, projectId, taskId, 'status = ?', [text(task['status'])])
      appendTaskEvent(db, projectId, taskId, textOrNull(task['current_attempt_id']), 'task-dependencies-set', version, { dependsOnTaskIds: dependsOnIds })
      return taskSnapshot(db, loadTaskRow(db, projectId, taskId))
    })
  }

  // -- schedules ------------------------------------------------------------

  createSchedule(input: AdminCreateScheduleInput): ScheduleSnapshot {
    assertKnownFields(input, 'input', ['connection', 'projectId', 'repositoryId', 'workspaceRoot', 'spec', 'enabled', 'nextRunAt'])
    const connection = parseAuthorityConnection(input?.['connection'])
    const projectId = boundedField(input?.['projectId'], 'projectId', 128)
    const spec = parseScheduleSpec(input?.['spec'])
    const enabled = input?.['enabled'] ?? true
    if (typeof enabled !== 'boolean') throw new TaskAuthorityValidationError('enabled', 'must be a boolean')
    const nextRunAt = optionalIsoTimestamp(input?.['nextRunAt'], 'nextRunAt')
    return this.database.withImmediate(db => {
      requireAdminProject(connection, projectId)
      ensureProject(db, projectId, input?.['repositoryId'], input?.['workspaceRoot'])
      const scheduleId = randomUUID()
      const created = nowIso()
      db.prepare('INSERT INTO schedules(id, project_id, definition_json, enabled, entity_version, next_run_at, created_at, updated_at) VALUES (?,?,?,?,1,?,?,?)')
        .run(scheduleId, projectId, scheduleDefinitionJson(spec), enabled ? 1 : 0, nextRunAt, created, created)
      appendProfileEvent(db, spec.profileId, null, 'schedule-created', 1, { projectId, scheduleId })
      return scheduleSnapshot(db, loadSchedule(db, projectId, scheduleId))
    })
  }

  updateSchedule(input: AdminUpdateScheduleInput): ScheduleSnapshot {
    assertKnownFields(input, 'input', ['connection', 'projectId', 'scheduleId', 'expectedEntityVersion', 'spec', 'enabled', 'nextRunAt'])
    const connection = parseAuthorityConnection(input?.['connection'])
    const projectId = boundedField(input?.['projectId'], 'projectId', 128)
    const scheduleId = assertAuthorityUuid(input?.['scheduleId'], 'scheduleId')
    const expectedEntityVersion = entityVersion(input?.['expectedEntityVersion'], 'expectedEntityVersion')
    const spec = input?.['spec'] === undefined ? undefined : parseScheduleSpec(input['spec'])
    const enabled = input?.['enabled']
    if (enabled !== undefined && typeof enabled !== 'boolean') throw new TaskAuthorityValidationError('enabled', 'must be a boolean')
    const nextRunAt = input === undefined ? undefined : 'nextRunAt' in input ? optionalIsoTimestamp(input['nextRunAt'], 'nextRunAt') : undefined
    return this.database.withImmediate(db => {
      requireAdminProject(connection, projectId)
      const schedule = loadSchedule(db, projectId, scheduleId)
      if (int(schedule['entity_version']) !== expectedEntityVersion) {
        throw new TaskAuthorityError('STALE_AUTHORITY', `schedule ${scheduleId} entity version ${expectedEntityVersion} did not match ${int(schedule['entity_version'])}`)
      }
      const previous = scheduleSnapshot(db, schedule)
      const merged = spec ?? previous
      const enabledValue = enabled === undefined ? previous.enabled : enabled
      const nextRunValue = nextRunAt === undefined ? previous.nextRunAt : nextRunAt
      db.prepare('UPDATE schedules SET definition_json = ?, enabled = ?, next_run_at = ?, entity_version = entity_version + 1, updated_at = ? WHERE project_id = ? AND id = ?')
        .run(scheduleDefinitionJson(merged), enabledValue ? 1 : 0, nextRunValue, nowIso(), projectId, scheduleId)
      appendProfileEvent(db, merged.profileId, null, 'schedule-updated', expectedEntityVersion + 1, { projectId, scheduleId })
      return scheduleSnapshot(db, loadSchedule(db, projectId, scheduleId))
    })
  }

  duplicateSchedule(input: AdminDuplicateScheduleInput): ScheduleSnapshot {
    assertKnownFields(input, 'input', ['connection', 'projectId', 'scheduleId', 'expectedEntityVersion'])
    const connection = parseAuthorityConnection(input?.['connection'])
    const projectId = boundedField(input?.['projectId'], 'projectId', 128)
    const scheduleId = assertAuthorityUuid(input?.['scheduleId'], 'scheduleId')
    const expectedEntityVersion = entityVersion(input?.['expectedEntityVersion'], 'expectedEntityVersion')
    return this.database.withImmediate(db => {
      requireAdminProject(connection, projectId)
      const schedule = loadSchedule(db, projectId, scheduleId)
      if (int(schedule['entity_version']) !== expectedEntityVersion) {
        throw new TaskAuthorityError('STALE_AUTHORITY', `schedule ${scheduleId} entity version ${expectedEntityVersion} did not match ${int(schedule['entity_version'])}`)
      }
      const copyId = randomUUID()
      const created = nowIso()
      db.prepare('INSERT INTO schedules(id, project_id, definition_json, enabled, entity_version, next_run_at, created_at, updated_at) VALUES (?,?,?,0,1,?,?,?)')
        .run(copyId, projectId, text(schedule['definition_json']), textOrNull(schedule['next_run_at']), created, created)
      const spec = readScheduleSpec(text(schedule['definition_json']))
      appendProfileEvent(db, spec.profileId, null, 'schedule-duplicated', 1, { projectId, scheduleId, duplicateId: copyId })
      return scheduleSnapshot(db, loadSchedule(db, projectId, copyId))
    })
  }

  deleteSchedule(input: AdminDeleteScheduleInput): ScheduleSnapshot {
    assertKnownFields(input, 'input', ['connection', 'projectId', 'scheduleId', 'expectedEntityVersion'])
    const connection = parseAuthorityConnection(input?.['connection'])
    const projectId = boundedField(input?.['projectId'], 'projectId', 128)
    const scheduleId = assertAuthorityUuid(input?.['scheduleId'], 'scheduleId')
    const expectedEntityVersion = entityVersion(input?.['expectedEntityVersion'], 'expectedEntityVersion')
    return this.database.withImmediate(db => {
      requireAdminProject(connection, projectId)
      const schedule = loadSchedule(db, projectId, scheduleId)
      if (int(schedule['entity_version']) !== expectedEntityVersion) {
        throw new TaskAuthorityError('STALE_AUTHORITY', `schedule ${scheduleId} entity version ${expectedEntityVersion} did not match ${int(schedule['entity_version'])}`)
      }
      const snapshot = scheduleSnapshot(db, schedule)
      db.prepare('DELETE FROM schedules WHERE project_id = ? AND id = ?').run(projectId, scheduleId)
      appendProfileEvent(db, snapshot.profileId, null, 'schedule-deleted', expectedEntityVersion, { projectId, scheduleId })
      return snapshot
    })
  }

  enqueueDueSchedule(input: EnqueueDueScheduleInput): ScheduleExecutionSnapshot {
    assertKnownFields(input, 'input', ['connection', 'projectId', 'scheduleId', 'expectedEntityVersion', 'expectedNextRunAt'])
    const connection = parseAuthorityConnection(input?.['connection'])
    if (connection.role !== 'daemon-scheduler') {
      throw new TaskAuthorityError('AUTHORIZATION_DENIED', `role "${connection.role}" may not enqueue due schedule executions`)
    }
    const projectId = boundedField(input?.['projectId'], 'projectId', 128)
    const scheduleId = assertAuthorityUuid(input?.['scheduleId'], 'scheduleId')
    const expectedEntityVersion = entityVersion(input?.['expectedEntityVersion'], 'expectedEntityVersion')
    const expectedNextRunAt = isoTimestamp(input?.['expectedNextRunAt'], 'expectedNextRunAt')
    return this.database.withImmediate(db => {
      const schedule = db.prepare('SELECT * FROM schedules WHERE project_id = ? AND id = ?').get(projectId, scheduleId) as Row | undefined
      if (!schedule) throw new TaskAuthorityError('AUTHORIZATION_DENIED', 'connection is not authorized to enqueue this schedule occurrence')
      const spec = readScheduleSpec(text(schedule['definition_json']))
      if (connectionDeniedProject(connection, projectId) || connectionDeniedProfile(connection, spec.profileId)) {
        throw new TaskAuthorityError('AUTHORIZATION_DENIED', 'connection is not authorized for this schedule occurrence scope')
      }
      const dueKey = expectedNextRunAt
      const fingerprint = intentSha256({ projectId, scheduleId, trigger: 'due', dueAt: dueKey })
      const existing = findExecutionReceipt(db, projectId, scheduleId, 'due', dueKey)
      if (existing) {
        if (text(existing['intent_sha256']) !== fingerprint) {
          throw new TaskAuthorityError('IDEMPOTENCY_CONFLICT', `due occurrence ${dueKey} was already enqueued with a different intent`)
        }
        return executionSnapshot(existing)
      }
      if (!bool(schedule['enabled'])) {
        throw new TaskAuthorityError('TASK_NOT_RUNNABLE', `schedule ${scheduleId} is disabled`)
      }
      if (int(schedule['entity_version']) !== expectedEntityVersion) {
        throw new TaskAuthorityError('STALE_AUTHORITY', `schedule ${scheduleId} entity version ${expectedEntityVersion} did not match ${int(schedule['entity_version'])}`)
      }
      const storedNextRunAt = textOrNull(schedule['next_run_at'])
      if (storedNextRunAt === null || Date.parse(storedNextRunAt) !== Date.parse(expectedNextRunAt)) {
        throw new TaskAuthorityError('STALE_AUTHORITY', `schedule ${scheduleId} next run ${expectedNextRunAt} did not match the stored occurrence`)
      }
      const execution = this.materializeExecution(db, projectId, schedule, spec, 'due', dueKey, fingerprint, dueKey)
      db.prepare('UPDATE schedules SET next_run_at = ?, entity_version = entity_version + 1, updated_at = ? WHERE project_id = ? AND id = ?')
        .run(computeNextRunAt(spec, dueKey), nowIso(), projectId, scheduleId)
      appendProfileEvent(db, spec.profileId, null, 'schedule-due-enqueued', int(schedule['entity_version']) + 1, { projectId, scheduleId, executionId: execution.executionId, dueAt: dueKey })
      return execution
    })
  }

  enqueueManualScheduleExecution(input: EnqueueManualScheduleExecutionInput): ScheduleExecutionSnapshot {
    assertKnownFields(input, 'input', ['connection', 'projectId', 'scheduleId', 'expectedEntityVersion', 'requestId'])
    const connection = parseAuthorityConnection(input?.['connection'])
    if (connection.role !== 'administrator') {
      throw new TaskAuthorityError('AUTHORIZATION_DENIED', `role "${connection.role}" may not enqueue manual schedule executions`)
    }
    const projectId = boundedField(input?.['projectId'], 'projectId', 128)
    const scheduleId = assertAuthorityUuid(input?.['scheduleId'], 'scheduleId')
    const expectedEntityVersion = entityVersion(input?.['expectedEntityVersion'], 'expectedEntityVersion')
    const requestId = boundedField(input?.['requestId'], 'requestId', 128)
    return this.database.withImmediate(db => {
      const schedule = db.prepare('SELECT * FROM schedules WHERE project_id = ? AND id = ?').get(projectId, scheduleId) as Row | undefined
      if (!schedule) throw new TaskAuthorityError('AUTHORIZATION_DENIED', 'connection is not authorized to enqueue this schedule execution')
      const spec = readScheduleSpec(text(schedule['definition_json']))
      if (connectionDeniedProject(connection, projectId) || connectionDeniedProfile(connection, spec.profileId)) {
        throw new TaskAuthorityError('AUTHORIZATION_DENIED', 'connection is not authorized for this schedule execution scope')
      }
      const fingerprint = intentSha256({ projectId, scheduleId, trigger: 'manual', requestId })
      const existing = findExecutionReceipt(db, projectId, scheduleId, 'manual', requestId)
      if (existing) {
        if (text(existing['intent_sha256']) !== fingerprint) {
          throw new TaskAuthorityError('IDEMPOTENCY_CONFLICT', `manual execution ${requestId} was already enqueued with a different intent`)
        }
        return executionSnapshot(existing)
      }
      if (int(schedule['entity_version']) !== expectedEntityVersion) {
        throw new TaskAuthorityError('STALE_AUTHORITY', `schedule ${scheduleId} entity version ${expectedEntityVersion} did not match ${int(schedule['entity_version'])}`)
      }
      const execution = this.materializeExecution(db, projectId, schedule, spec, 'manual', requestId, fingerprint, null)
      appendProfileEvent(db, spec.profileId, null, 'schedule-manual-enqueued', int(schedule['entity_version']), { projectId, scheduleId, executionId: execution.executionId, requestId })
      return execution
    })
  }

  private materializeExecution(db: DatabaseSync, projectId: string, schedule: Row, spec: TaskScheduleSpec, trigger: 'due' | 'manual', idempotencyKey: string, fingerprint: string, dueAt: string | null): ScheduleExecutionSnapshot {
    const scheduleId = text(schedule['id'])
    const taskId = randomUUID()
    const executionId = randomUUID()
    const created = nowIso()
    const externalTaskId = `${scheduleId}:${idempotencyKey}`.slice(0, 128)
    ensureProject(db, projectId, undefined, undefined)
    db.prepare("INSERT INTO tasks(id, project_id, external_task_id, external_task_id_canonical, title, body, status, priority, current_attempt_id, cancel_state, entity_version, created_at, updated_at) VALUES (?,?,?,?,?,?,'todo',0,NULL,'none',1,?,?)")
      .run(taskId, projectId, externalTaskId, canonicalExternalTaskId(externalTaskId), spec.taskTitle, '', created, created)
    insertSpecification(db, projectId, taskId, { command: spec.command, target: spec.target, verification: spec.verification })
    db.prepare("INSERT INTO schedule_executions(id, project_id, schedule_id, trigger, idempotency_key, intent_sha256, task_id, attempt_id, due_at, state, entity_version, created_at) VALUES (?,?,?,?,?,?,?,NULL,?,'queued',1,?)")
      .run(executionId, projectId, scheduleId, trigger, idempotencyKey, fingerprint, taskId, dueAt, created)
    appendTaskEvent(db, projectId, taskId, null, 'schedule-execution-enqueued', 1, { scheduleId, executionId, trigger, dueAt })
    return executionSnapshot(db.prepare('SELECT * FROM schedule_executions WHERE project_id = ? AND id = ?').get(projectId, executionId) as Row)
  }

  listScheduleExecutions(input: ScheduleExecutionQuery): ScheduleExecutionPage {
    assertKnownFields(input, 'input', ['connection', 'projectId', 'scheduleId', 'state', 'cursor', 'limit'])
    const connection = parseAuthorityConnection(input?.['connection'])
    const projectId = input?.['projectId'] === undefined ? undefined : boundedField(input['projectId'], 'projectId', 128)
    const scheduleId = input?.['scheduleId'] === undefined ? undefined : assertAuthorityUuid(input['scheduleId'], 'scheduleId')
    const state = input?.['state']
    if (state !== undefined && !['queued', 'running', 'cancelling', 'cancelled', 'succeeded', 'failed'].includes(state)) {
      throw new TaskAuthorityValidationError('state', 'must be a known schedule execution state')
    }
    const limit = parseProjectionLimit(input?.['limit'])
    const cursor = input?.['cursor'] === undefined ? null : decodeCursor(parseTaskQueryCursor(input['cursor']))
    if (projectId !== undefined) requireAdminProjectOrWorkerRead(connection, projectId)
    else if (connection.role !== 'administrator') {
      throw new TaskAuthorityError('AUTHORIZATION_DENIED', 'unscoped schedule execution listing requires an administrator connection')
    }
    return this.database.withReadOnly(db => {
      const clauses: string[] = []
      const params: string[] = []
      if (projectId !== undefined) { clauses.push('project_id = ?'); params.push(projectId) }
      if (scheduleId !== undefined) { clauses.push('schedule_id = ?'); params.push(scheduleId) }
      if (state !== undefined) { clauses.push('state = ?'); params.push(state) }
      if (cursor !== null) {
        clauses.push('(created_at > ? OR (created_at = ? AND id > ?))')
        params.push(String(cursor[0]), String(cursor[0]), String(cursor[1]))
      }
      const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
      const rows = db.prepare(`SELECT * FROM schedule_executions${where} ORDER BY created_at, id LIMIT ?`).all(...params, limit + 1) as Row[]
      const page = rows.slice(0, limit)
      const nextCursor = rows.length > limit && page.length > 0
        ? encodeCursor([text(page[page.length - 1]['created_at']), text(page[page.length - 1]['id'])])
        : null
      return { executions: page.map(executionSnapshot), nextCursor }
    })
  }

  cancelScheduleExecution(input: AdminCancelScheduleExecutionInput): ScheduleExecutionSnapshot {
    assertKnownFields(input, 'input', ['connection', 'projectId', 'scheduleId', 'executionId', 'expectedEntityVersion'])
    const connection = parseAuthorityConnection(input?.['connection'])
    const projectId = boundedField(input?.['projectId'], 'projectId', 128)
    const scheduleId = assertAuthorityUuid(input?.['scheduleId'], 'scheduleId')
    const executionId = assertAuthorityUuid(input?.['executionId'], 'executionId')
    const expectedEntityVersion = entityVersion(input?.['expectedEntityVersion'], 'expectedEntityVersion')
    return this.database.withImmediate(db => {
      requireAdminProject(connection, projectId)
      const execution = db.prepare('SELECT * FROM schedule_executions WHERE project_id = ? AND schedule_id = ? AND id = ?').get(projectId, scheduleId, executionId) as Row | undefined
      if (!execution) throw new TaskAuthorityError('TASK_NOT_FOUND', `schedule execution ${executionId} was not found`)
      if (int(execution['entity_version']) !== expectedEntityVersion) {
        throw new TaskAuthorityError('STALE_AUTHORITY', `schedule execution ${executionId} entity version ${expectedEntityVersion} did not match ${int(execution['entity_version'])}`)
      }
      if (TERMINAL_EXECUTION_STATES[text(execution['state']) as ScheduleExecutionState]) {
        throw new TaskAuthorityError('STALE_AUTHORITY', `schedule execution ${executionId} is already terminal`)
      }
      const taskId = text(execution['task_id'])
      const attemptId = textOrNull(loadTaskRow(db, projectId, taskId)['current_attempt_id'])
      if (taskAwaitingExitAck(db, projectId, taskId, attemptId)) {
        db.prepare("UPDATE schedule_executions SET state = 'cancelling', entity_version = entity_version + 1 WHERE project_id = ? AND id = ?").run(projectId, executionId)
        db.prepare("UPDATE tasks SET status = 'cancelling', cancel_state = 'requested', entity_version = entity_version + 1, updated_at = ? WHERE project_id = ? AND id = ?").run(nowIso(), projectId, taskId)
        db.prepare("UPDATE attempts SET state = 'cancelling' WHERE project_id = ? AND id = ?").run(projectId, attemptId as string)
        syncMemberState(db, projectId, taskId, 'cancelling')
        appendTaskEvent(db, projectId, taskId, attemptId, 'schedule-execution-cancelling', int(execution['entity_version']) + 1, { executionId })
      } else {
        // Queued executions have no live attempt; close every linked record to terminal cancelled atomically.
        db.prepare("UPDATE schedule_executions SET state = 'cancelled', entity_version = entity_version + 1 WHERE project_id = ? AND id = ?").run(projectId, executionId)
        const version = closeCancellationTerminal(db, projectId, taskId, attemptId)
        appendTaskEvent(db, projectId, taskId, attemptId, 'schedule-execution-cancelled', version, { executionId })
      }
      return executionSnapshot(db.prepare('SELECT * FROM schedule_executions WHERE project_id = ? AND id = ?').get(projectId, executionId) as Row)
    })
  }

  // -- run groups -----------------------------------------------------------

  createRunGroup(input: AdminCreateRunGroupInput): RunGroupSnapshot {
    assertKnownFields(input, 'input', ['connection', 'profileId', 'name', 'concurrency', 'members'])
    const connection = parseAuthorityConnection(input?.['connection'])
    const profileId = boundedField(input?.['profileId'], 'profileId', 128)
    const name = boundedText(input?.['name'], 'name', TASK_AUTHORITY_MAX_TITLE, false)
    const concurrency = input?.['concurrency']
    if (typeof concurrency !== 'number' || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_PARALLELISM) {
      throw new TaskAuthorityValidationError('concurrency', `must be an integer from 1 to ${MAX_PARALLELISM}`)
    }
    const members = input?.['members']
    if (!Array.isArray(members) || members.length === 0 || members.length > TASK_AUTHORITY_MAX_BATCH) {
      throw new TaskAuthorityValidationError('members', `must be a non-empty array of at most ${TASK_AUTHORITY_MAX_BATCH} members`)
    }
    return this.database.withImmediate(db => {
      requireAdminProfile(connection, profileId)
      const runGroupId = randomUUID()
      const created = nowIso()
      db.prepare("INSERT INTO run_groups(id, profile_id, name, retry_of_run_group_id, concurrency, state, entity_version, created_at, updated_at) VALUES (?,?,?,NULL,?,'active',1,?,?)").run(runGroupId, profileId, name, concurrency, created, created)
      members.forEach((member, ordinal) => {
        const memberProject = boundedField(member?.['projectId'], `members[${ordinal}].projectId`, 128)
        const memberTask = assertAuthorityUuid(member?.['taskId'], `members[${ordinal}].taskId`)
        const memberSpecification = member?.['specification'] === undefined ? null : parseTaskExecutionSpecification(member['specification'], `members[${ordinal}].specification`)
        loadTaskRow(db, memberProject, memberTask)
        db.prepare("INSERT INTO run_members(run_group_id, project_id, task_id, source_attempt_id, ordinal, state, specification_json) VALUES (?,?,?,NULL,?,'queued',?)")
          .run(runGroupId, memberProject, memberTask, ordinal, memberSpecification === null ? null : JSON.stringify({ command: memberSpecification.command, target: memberSpecification.target, verification: memberSpecification.verification }))
      })
      appendProfileEvent(db, profileId, runGroupId, 'run-group-created', 1, { name, concurrency, members: members.length })
      return runGroupSnapshot(db, loadRunGroup(db, runGroupId))
    })
  }

  retryRunGroup(input: AdminRetryRunGroupInput): RunGroupSnapshot {
    assertKnownFields(input, 'input', ['connection', 'runGroupId', 'expectedEntityVersion', 'requestId', 'ownerId', 'memberTaskIds'])
    const connection = parseAuthorityConnection(input?.['connection'])
    const runGroupId = assertAuthorityUuid(input?.['runGroupId'], 'runGroupId')
    const expectedEntityVersion = entityVersion(input?.['expectedEntityVersion'], 'expectedEntityVersion')
    const requestId = boundedField(input?.['requestId'], 'requestId', 128)
    assertAuthorityUuid(input?.['ownerId'], 'ownerId')
    const memberTaskIds = input?.['memberTaskIds']
    if (!Array.isArray(memberTaskIds) || memberTaskIds.length === 0 || memberTaskIds.length > TASK_AUTHORITY_MAX_BATCH) {
      throw new TaskAuthorityValidationError('memberTaskIds', `must be a non-empty array of at most ${TASK_AUTHORITY_MAX_BATCH} members`)
    }
    const selected = memberTaskIds.map((member, index) => ({
      projectId: boundedField(member?.['projectId'], `memberTaskIds[${index}].projectId`, 128),
      taskId: assertAuthorityUuid(member?.['taskId'], `memberTaskIds[${index}].taskId`)
    }))
    const fingerprint = intentSha256({
      runGroupId,
      requestId,
      memberTaskIds: [...selected].sort((a, b) => `${a.projectId}:${a.taskId}`.localeCompare(`${b.projectId}:${b.taskId}`))
    })
    return this.database.withImmediate(db => {
      const source = db.prepare('SELECT * FROM run_groups WHERE id = ?').get(runGroupId) as Row | undefined
      if (!source) throw new TaskAuthorityError('AUTHORIZATION_DENIED', 'connection is not authorized to retry this run group')
      const profileId = text(source['profile_id'])
      requireAdminProfile(connection, profileId)
      const receipt = db.prepare('SELECT * FROM run_group_mutation_receipts WHERE profile_id = ? AND request_id = ?').get(profileId, requestId) as Row | undefined
      if (receipt) {
        if (text(receipt['intent_sha256']) !== fingerprint) {
          throw new TaskAuthorityError('IDEMPOTENCY_CONFLICT', `run group retry request ${requestId} was already used with a different intent`)
        }
        return runGroupSnapshot(db, loadRunGroup(db, text(receipt['result_run_group_id'])))
      }
      if (int(source['entity_version']) !== expectedEntityVersion) {
        throw new TaskAuthorityError('STALE_AUTHORITY', `run group ${runGroupId} entity version ${expectedEntityVersion} did not match ${int(source['entity_version'])}`)
      }
      if (text(source['state']) !== 'active') {
        throw new TaskAuthorityError('TASK_CANCELLED', `run group ${runGroupId} is ${text(source['state'])} and cannot be retried`)
      }
      const newGroupId = randomUUID()
      const created = nowIso()
      db.prepare("INSERT INTO run_groups(id, profile_id, name, retry_of_run_group_id, concurrency, state, entity_version, created_at, updated_at) VALUES (?,?,?,?,?,'active',1,?,?)")
        .run(newGroupId, profileId, `${text(source['name'])} (retry)`, runGroupId, int(source['concurrency']), created, created)
      selected.forEach((member, ordinal) => {
        const sourceMember = db.prepare('SELECT * FROM run_members WHERE run_group_id = ? AND project_id = ? AND task_id = ?').get(runGroupId, member.projectId, member.taskId) as Row | undefined
        if (!sourceMember) throw new TaskAuthorityError('TASK_NOT_FOUND', `task ${member.taskId} is not a member of run group ${runGroupId}`)
        if (text(sourceMember['state']) !== 'failed') {
          throw new TaskAuthorityError('TASK_NOT_RUNNABLE', `member ${member.taskId} is ${text(sourceMember['state'])}; only failed members can be retried`)
        }
        const sourceAttemptId = textOrNull(loadTaskRow(db, member.projectId, member.taskId)['current_attempt_id'])
        db.prepare("INSERT INTO run_members(run_group_id, project_id, task_id, source_attempt_id, ordinal, state, specification_json) VALUES (?,?,?,?,?,'queued',?)")
          .run(newGroupId, member.projectId, member.taskId, sourceAttemptId, ordinal, textOrNull(sourceMember['specification_json']))
        db.prepare("UPDATE tasks SET status = 'todo', cancel_state = 'none', current_attempt_id = NULL, entity_version = entity_version + 1, updated_at = ? WHERE project_id = ? AND id = ?")
          .run(nowIso(), member.projectId, member.taskId)
      })
      db.prepare('INSERT INTO run_group_mutation_receipts(profile_id, request_id, intent_sha256, result_run_group_id, created_at) VALUES (?,?,?,?,?)')
        .run(profileId, requestId, fingerprint, newGroupId, created)
      appendProfileEvent(db, profileId, newGroupId, 'run-group-retried', 1, { sourceRunGroupId: runGroupId, requestId, members: selected.map(member => `${member.projectId}:${member.taskId}`) })
      return runGroupSnapshot(db, loadRunGroup(db, newGroupId))
    })
  }

  cancelRunGroup(input: AdminCancelRunGroupInput): RunGroupSnapshot {
    assertKnownFields(input, 'input', ['connection', 'profileId', 'runGroupId', 'expectedEntityVersion'])
    const connection = parseAuthorityConnection(input?.['connection'])
    const profileId = boundedField(input?.['profileId'], 'profileId', 128)
    const runGroupId = assertAuthorityUuid(input?.['runGroupId'], 'runGroupId')
    const expectedEntityVersion = entityVersion(input?.['expectedEntityVersion'], 'expectedEntityVersion')
    return this.database.withImmediate(db => {
      requireAdminProfile(connection, profileId)
      const group = loadRunGroup(db, runGroupId)
      if (text(group['profile_id']) !== profileId) {
        throw new TaskAuthorityError('PROJECT_SCOPE_MISMATCH', `run group ${runGroupId} does not belong to profile ${profileId}`)
      }
      if (int(group['entity_version']) !== expectedEntityVersion) {
        throw new TaskAuthorityError('STALE_AUTHORITY', `run group ${runGroupId} entity version ${expectedEntityVersion} did not match ${int(group['entity_version'])}`)
      }
      if (text(group['state']) !== 'active') {
        return runGroupSnapshot(db, group)
      }
      const members = db.prepare('SELECT * FROM run_members WHERE run_group_id = ?').all(runGroupId) as Row[]
      let anyAwaitingExit = false
      for (const member of members) {
        const memberProject = text(member['project_id'])
        const memberTask = text(member['task_id'])
        if (TERMINAL_MEMBER_STATES[text(member['state']) as RunMemberState]) continue
        const attemptId = textOrNull(loadTaskRow(db, memberProject, memberTask)['current_attempt_id'])
        if (taskAwaitingExitAck(db, memberProject, memberTask, attemptId)) {
          anyAwaitingExit = true
          db.prepare("UPDATE run_members SET state = 'cancelling' WHERE run_group_id = ? AND project_id = ? AND task_id = ?").run(runGroupId, memberProject, memberTask)
          db.prepare("UPDATE tasks SET status = 'cancelling', cancel_state = 'requested', entity_version = entity_version + 1, updated_at = ? WHERE project_id = ? AND id = ? AND status NOT IN ('done','cancelled','failed')")
            .run(nowIso(), memberProject, memberTask)
          db.prepare("UPDATE attempts SET state = 'cancelling' WHERE project_id = ? AND id = ?").run(memberProject, attemptId as string)
          syncExecutionForTask(db, memberProject, memberTask, execution => {
            if (TERMINAL_EXECUTION_STATES[text(execution['state']) as ScheduleExecutionState]) return { state: text(execution['state']) as ScheduleExecutionState }
            return { state: 'cancelling' }
          })
          appendTaskEvent(db, memberProject, memberTask, attemptId, 'run-group-cancelling', int(group['entity_version']) + 1, { runGroupId })
        } else {
          // Queued members have no live attempt; close them to terminal cancelled in the same transaction.
          const version = closeCancellationTerminal(db, memberProject, memberTask, attemptId)
          appendTaskEvent(db, memberProject, memberTask, attemptId, 'run-group-member-cancelled', version, { runGroupId })
        }
      }
      const groupState = anyAwaitingExit ? 'cancelling' : 'cancelled'
      db.prepare('UPDATE run_groups SET state = ?, entity_version = entity_version + 1, updated_at = ? WHERE id = ?').run(groupState, nowIso(), runGroupId)
      appendProfileEvent(db, profileId, runGroupId, anyAwaitingExit ? 'run-group-cancelling' : 'run-group-cancelled', int(group['entity_version']) + 1, { runGroupId })
      return runGroupSnapshot(db, loadRunGroup(db, runGroupId))
    })
  }

  deleteRunGroup(input: AdminDeleteRunGroupInput): RunGroupSnapshot {
    assertKnownFields(input, 'input', ['connection', 'profileId', 'runGroupId', 'expectedEntityVersion'])
    const connection = parseAuthorityConnection(input?.['connection'])
    const profileId = boundedField(input?.['profileId'], 'profileId', 128)
    const runGroupId = assertAuthorityUuid(input?.['runGroupId'], 'runGroupId')
    const expectedEntityVersion = entityVersion(input?.['expectedEntityVersion'], 'expectedEntityVersion')
    return this.database.withImmediate(db => {
      requireAdminProfile(connection, profileId)
      const group = loadRunGroup(db, runGroupId)
      if (text(group['profile_id']) !== profileId) {
        throw new TaskAuthorityError('PROJECT_SCOPE_MISMATCH', `run group ${runGroupId} does not belong to profile ${profileId}`)
      }
      if (int(group['entity_version']) !== expectedEntityVersion) {
        throw new TaskAuthorityError('STALE_AUTHORITY', `run group ${runGroupId} entity version ${expectedEntityVersion} did not match ${int(group['entity_version'])}`)
      }
      const child = db.prepare('SELECT id FROM run_groups WHERE retry_of_run_group_id = ? LIMIT 1').get(runGroupId) as Row | undefined
      if (child) throw new TaskAuthorityError('STALE_AUTHORITY', `run group ${runGroupId} has retry lineage and cannot be deleted`)
      const members = db.prepare('SELECT * FROM run_members WHERE run_group_id = ?').all(runGroupId) as Row[]
      for (const member of members) {
        if (!TERMINAL_MEMBER_STATES[text(member['state']) as RunMemberState]) {
          throw new TaskAuthorityError('STALE_AUTHORITY', `run group ${runGroupId} still has non-terminal linked work`)
        }
      }
      const snapshot = runGroupSnapshot(db, group)
      db.prepare('DELETE FROM run_members WHERE run_group_id = ?').run(runGroupId)
      db.prepare('DELETE FROM run_groups WHERE id = ?').run(runGroupId)
      appendProfileEvent(db, profileId, runGroupId, 'run-group-deleted', expectedEntityVersion, { runGroupId })
      return snapshot
    })
  }

  // -- claims ---------------------------------------------------------------

  claim(input: AuthenticatedClaimInput): ClaimResult {
    assertKnownFields(input, 'input', ['connection', 'projectId', 'taskId', 'externalTaskId', 'specification', 'leaseTtlMs'])
    const connection = parseAuthorityConnection(input?.['connection'])
    const projectId = boundedField(input?.['projectId'], 'projectId', 128)
    const specification = parseTaskExecutionSpecification(input?.['specification'])
    const ttl = ttlMs(input?.['leaseTtlMs'], 'leaseTtlMs', TASK_AUTHORITY_DEFAULT_LEASE_TTL_MS)
    const taskId = input?.['taskId'] === undefined ? undefined : assertAuthorityUuid(input['taskId'], 'taskId')
    const externalTaskId = input?.['externalTaskId'] === undefined ? undefined : boundedField(input['externalTaskId'], 'externalTaskId', 128)
    if (taskId === undefined && externalTaskId === undefined) {
      throw new TaskAuthorityValidationError('claim', 'either taskId or externalTaskId is required')
    }
    return this.database.withImmediate(db => {
      const ownerId = requireWorker(connection, projectId)
      const nowMs = authorityNowMs(db)
      let task: Row | undefined
      if (taskId !== undefined) {
        task = db.prepare('SELECT * FROM tasks WHERE project_id = ? AND id = ?').get(projectId, taskId) as Row | undefined
        if (!task) throw new TaskAuthorityError('TASK_NOT_FOUND', `task ${taskId} was not found in project ${projectId}`)
      } else {
        task = db.prepare('SELECT * FROM tasks WHERE project_id = ? AND external_task_id_canonical = ?').get(projectId, canonicalExternalTaskId(externalTaskId as string)) as Row | undefined
        if (!task) throw new TaskAuthorityError('TASK_NOT_FOUND', `task "${externalTaskId}" was not found in project ${projectId}`)
      }
      assertTaskClaimable(db, task)
      const taskIdValue = text(task['id'])
      const member = db.prepare('SELECT rm.*, rg.state AS group_state, rg.concurrency AS group_concurrency, rg.id AS group_id FROM run_members rm JOIN run_groups rg ON rg.id = rm.run_group_id WHERE rm.project_id = ? AND rm.task_id = ? ORDER BY rm.rowid DESC LIMIT 1').get(projectId, taskIdValue) as Row | undefined
      if (member !== undefined) {
        if (text(member['group_state']) !== 'active') throw new TaskAuthorityError('TASK_CANCELLED', `run group ${text(member['group_id'])} is ${text(member['group_state'])}`)
        if (text(member['state']) !== 'queued') throw new TaskAuthorityError('TASK_NOT_RUNNABLE', `run member is ${text(member['state'])} and cannot be claimed`)
        const consuming = db.prepare(
          "SELECT COUNT(*) AS count FROM run_members m JOIN tasks t ON t.project_id = m.project_id AND t.id = m.task_id JOIN attempts a ON a.project_id = t.project_id AND a.id = t.current_attempt_id WHERE m.run_group_id = ? AND a.state IN ('claimed','launching','running','cancelling','quarantined')"
        ).get(text(member['group_id'])) as Row
        if (int(consuming['count']) >= int(member['group_concurrency'])) {
          throw new TaskAuthorityError('CAPACITY_EXHAUSTED', `run group ${text(member['group_id'])} has no free concurrency`)
        }
      }
      const specificationId = insertSpecification(db, projectId, taskIdValue, specification)
      const { attemptId, leaseId } = insertAttemptWithLease(db, projectId, taskIdValue, nextAttemptSequence(db, projectId, taskIdValue), null, specificationId, ownerId, ttl, nowMs)
      db.prepare("UPDATE tasks SET current_attempt_id = ?, status = 'in-progress', entity_version = entity_version + 1, updated_at = ? WHERE project_id = ? AND id = ?").run(attemptId, nowIso(), projectId, taskIdValue)
      db.prepare("UPDATE run_members SET state = 'claimed' WHERE project_id = ? AND task_id = ? AND state = 'queued'").run(projectId, taskIdValue)
      syncExecutionForTask(db, projectId, taskIdValue, () => ({ state: 'running', attemptId }))
      const versionRow = db.prepare('SELECT entity_version FROM tasks WHERE project_id = ? AND id = ?').get(projectId, taskIdValue) as Row
      appendTaskEvent(db, projectId, taskIdValue, attemptId, 'task-claimed', int(versionRow['entity_version']), { ownerId, leaseId, generation: 1 })
      const lease = loadLeaseRow(db, projectId, leaseId)
      return {
        task: taskSnapshot(db, loadTaskRow(db, projectId, taskIdValue)),
        attempt: attemptSnapshot(db, loadAttemptRow(db, projectId, attemptId)),
        token: tokenFor(projectId, taskIdValue, attemptId, lease, nowMs + ttl)
      }
    })
  }

  // -- ordinary fenced writes -------------------------------------------------

  write(input: AuthorizedTaskOperation): TaskSnapshot {
    if (typeof input !== 'object' || input === null) {
      throw new TaskAuthorityValidationError('operation', 'must be an operation object')
    }
    const record = input as Record<string, unknown>
    const kind = record['kind']
    const connection = parseAuthorityConnection(record['connection'])
    switch (kind) {
      case 'heartbeat': {
        assertKnownFields(record, 'operation', ['kind', 'connection', 'token', 'ttlMs'])
        const token = parseLeaseToken(record['token'])
        const ttl = ttlMs(record['ttlMs'], 'ttlMs', TASK_AUTHORITY_DEFAULT_LEASE_TTL_MS)
        return this.database.withImmediate(db => {
          const ownerId = requireWorker(connection, token.projectId)
          requireFencedWrite(db, token, ownerId)
          const expiresAtMs = authorityNowMs(db) + ttl
          db.prepare('INSERT INTO lease_renewals(id, project_id, task_id, attempt_id, lease_id, expires_at_ms, created_at_ms) VALUES (?,?,?,?,?,?,?)')
            .run(randomUUID(), token.projectId, token.taskId, token.attemptId, token.leaseId, expiresAtMs, authorityNowMs(db))
          appendTaskEvent(db, token.projectId, token.taskId, token.attemptId, 'lease-renewed', int(loadTaskRow(db, token.projectId, token.taskId)['entity_version']), { leaseId: token.leaseId, expiresAtMs })
          return taskSnapshot(db, loadTaskRow(db, token.projectId, token.taskId))
        })
      }
      case 'progress': {
        assertKnownFields(record, 'operation', ['kind', 'connection', 'token', 'detail'])
        const token = parseLeaseToken(record['token'])
        const detail = boundedText(record['detail'], 'detail', TASK_AUTHORITY_MAX_USER_TEXT, false)
        return this.database.withImmediate(db => {
          const ownerId = requireWorker(connection, token.projectId)
          requireFencedWrite(db, token, ownerId)
          appendTaskEvent(db, token.projectId, token.taskId, token.attemptId, 'task-progress', int(loadTaskRow(db, token.projectId, token.taskId)['entity_version']), { detail })
          return taskSnapshot(db, loadTaskRow(db, token.projectId, token.taskId))
        })
      }
      case 'record-launch-intent': {
        assertKnownFields(record, 'operation', ['kind', 'connection', 'token', 'specificationId'])
        const token = parseLeaseToken(record['token'])
        const specificationId = assertAuthorityUuid(record['specificationId'], 'specificationId')
        return this.database.withImmediate(db => {
          const ownerId = requireWorker(connection, token.projectId)
          const { attempt } = requireFencedWrite(db, token, ownerId)
          if (text(attempt['specification_id']) !== specificationId) {
            throw new TaskAuthorityError('STALE_AUTHORITY', `specification ${specificationId} is not the current attempt specification`)
          }
          const existing = latestLaunchIntent(db, token.projectId, token.attemptId)
          if (existing !== undefined && text(existing['state']) !== 'planned') {
            throw new TaskAuthorityError('STALE_AUTHORITY', `launch intent ${text(existing['id'])} is already ${text(existing['state'])}`)
          }
          if (existing === undefined) {
            const created = nowIso()
            db.prepare("INSERT INTO launch_intents(id, project_id, task_id, attempt_id, lease_id, state, session_id, process_identity_json, stop_state, created_at, updated_at) VALUES (?,?,?,?,?,'planned',NULL,NULL,'none',?,?)")
              .run(randomUUID(), token.projectId, token.taskId, token.attemptId, token.leaseId, created, created)
          }
          appendTaskEvent(db, token.projectId, token.taskId, token.attemptId, 'launch-intent-recorded', int(loadTaskRow(db, token.projectId, token.taskId)['entity_version']), { specificationId })
          return taskSnapshot(db, loadTaskRow(db, token.projectId, token.taskId))
        })
      }
      case 'bind-runtime': {
        assertKnownFields(record, 'operation', ['kind', 'connection', 'token', 'sessionId', 'processIdentity'])
        const token = parseLeaseToken(record['token'])
        const sessionId = boundedField(record['sessionId'], 'sessionId', 128)
        const processIdentity = record['processIdentity']
        if (typeof processIdentity !== 'object' || processIdentity === null) {
          throw new TaskAuthorityValidationError('processIdentity', 'must be a process identity object')
        }
        return this.database.withImmediate(db => {
          const ownerId = requireWorker(connection, token.projectId)
          requireFencedWrite(db, token, ownerId)
          assertBindableProcessIdentity(processIdentity as ProcessIdentity)
          const intent = latestLaunchIntent(db, token.projectId, token.attemptId)
          if (!intent || text(intent['state']) !== 'spawning') {
            throw new TaskAuthorityError('STALE_AUTHORITY', `attempt ${token.attemptId} has no spawning launch intent to bind`)
          }
          db.prepare('UPDATE launch_intents SET session_id = ?, process_identity_json = ?, updated_at = ? WHERE project_id = ? AND id = ?')
            .run(sessionId, JSON.stringify(processIdentity), nowIso(), token.projectId, text(intent['id']))
          db.prepare("UPDATE attempts SET state = 'running' WHERE project_id = ? AND id = ? AND state = 'launching'").run(token.projectId, token.attemptId)
          syncMemberState(db, token.projectId, token.taskId, 'running')
          appendTaskEvent(db, token.projectId, token.taskId, token.attemptId, 'runtime-bound', int(loadTaskRow(db, token.projectId, token.taskId)['entity_version']), { sessionId, launchIntentId: text(intent['id']) })
          return taskSnapshot(db, loadTaskRow(db, token.projectId, token.taskId))
        })
      }
      case 'bind-worktree': {
        assertKnownFields(record, 'operation', ['kind', 'connection', 'token', 'resourceKey', 'worktreePath', 'repositoryId'])
        const token = parseLeaseToken(record['token'])
        const resourceKey = boundedField(record['resourceKey'], 'resourceKey', 128)
        const worktreePath = boundedText(record['worktreePath'], 'worktreePath', 128, false)
        const repositoryId = boundedField(record['repositoryId'], 'repositoryId', 128)
        return this.database.withImmediate(db => {
          const ownerId = requireWorker(connection, token.projectId)
          requireFencedWrite(db, token, ownerId)
          const canonical = canonicalResourceKey(resourceKey)
          const conflicting = db.prepare("SELECT attempt_id FROM resource_reservations WHERE canonical_resource_key = ? AND state IN ('reserved','quarantined') AND attempt_id <> ? LIMIT 1").get(canonical, token.attemptId) as Row | undefined
          if (conflicting) {
            throw new TaskAuthorityError('RESOURCE_QUARANTINED', `canonical resource ${canonical} is already reserved by another attempt`)
          }
          const existing = db.prepare("SELECT id FROM resource_reservations WHERE project_id = ? AND attempt_id = ? AND state IN ('reserved','quarantined') LIMIT 1").get(token.projectId, token.attemptId) as Row | undefined
          if (!existing) {
            db.prepare("INSERT INTO resource_reservations(id, canonical_resource_key, project_id, attempt_id, state, created_at, released_at) VALUES (?,?,?,?,'reserved',?,NULL)")
              .run(randomUUID(), canonical, token.projectId, token.attemptId, nowIso())
          }
          appendTaskEvent(db, token.projectId, token.taskId, token.attemptId, 'worktree-bound', int(loadTaskRow(db, token.projectId, token.taskId)['entity_version']), { resourceKey: canonical, worktreePath, repositoryId })
          return taskSnapshot(db, loadTaskRow(db, token.projectId, token.taskId))
        })
      }
      case 'attach-artifact': {
        assertKnownFields(record, 'operation', ['kind', 'connection', 'token', 'artifact'])
        const token = parseLeaseToken(record['token'])
        const artifact = parseVerificationArtifact(record['artifact'])
        return this.database.withImmediate(db => {
          const ownerId = requireWorker(connection, token.projectId)
          requireFencedWrite(db, token, ownerId)
          db.prepare("INSERT INTO verification_artifacts(id, project_id, task_id, attempt_id, lease_id, generation, provenance_kind, path, sha256, bytes, source_fingerprint, relationship, attached_at) VALUES (?,?,?,?,?,?,'native',?,?,?,?,?,?)")
            .run(randomUUID(), token.projectId, token.taskId, token.attemptId, token.leaseId, token.generation, artifact.path, artifact.sha256, artifact.bytes, artifact.sourceFingerprint, artifact.relationship, nowIso())
          appendTaskEvent(db, token.projectId, token.taskId, token.attemptId, 'artifact-attached', int(loadTaskRow(db, token.projectId, token.taskId)['entity_version']), { path: artifact.path, relationship: artifact.relationship })
          return taskSnapshot(db, loadTaskRow(db, token.projectId, token.taskId))
        })
      }
      case 'complete': {
        assertKnownFields(record, 'operation', ['kind', 'connection', 'token', 'result'])
        const token = parseLeaseToken(record['token'])
        const result = record['result']
        if (typeof result !== 'object' || result === null) throw new TaskAuthorityValidationError('result', 'must be a completion object')
        const summary = boundedText((result as Record<string, unknown>)['summary'], 'result.summary', TASK_AUTHORITY_MAX_USER_TEXT, false)
        return this.database.withImmediate(db => {
          const ownerId = requireWorker(connection, token.projectId)
          requireFencedWrite(db, token, ownerId)
          assertCompletionRequirements(db, token)
          db.prepare("UPDATE attempts SET state = 'completed', finished_at = ? WHERE project_id = ? AND id = ?").run(nowIso(), token.projectId, token.attemptId)
          stopLaunchIntent(db, token.projectId, token.attemptId, 'stopped', 'exited')
          releaseReservation(db, token.projectId, token.attemptId)
          syncMemberState(db, token.projectId, token.taskId, 'completed')
          syncExecutionForTask(db, token.projectId, token.taskId, () => ({ state: 'succeeded' }))
          const version = bumpTask(db, token.projectId, token.taskId, "status = 'done', cancel_state = 'none'", [])
          appendTaskEvent(db, token.projectId, token.taskId, token.attemptId, 'task-completed', version, { summary })
          return taskSnapshot(db, loadTaskRow(db, token.projectId, token.taskId))
        })
      }
      case 'fail': {
        assertKnownFields(record, 'operation', ['kind', 'connection', 'token', 'error'])
        const token = parseLeaseToken(record['token'])
        const error = boundedText(record['error'], 'error', TASK_AUTHORITY_MAX_ERROR_TEXT, false)
        return this.database.withImmediate(db => {
          const ownerId = requireWorker(connection, token.projectId)
          requireFencedWrite(db, token, ownerId)
          db.prepare("UPDATE attempts SET state = 'failed', finished_at = ? WHERE project_id = ? AND id = ?").run(nowIso(), token.projectId, token.attemptId)
          stopLaunchIntent(db, token.projectId, token.attemptId, 'stopped', 'exited')
          releaseReservation(db, token.projectId, token.attemptId)
          syncMemberState(db, token.projectId, token.taskId, 'failed')
          syncExecutionForTask(db, token.projectId, token.taskId, () => ({ state: 'failed' }))
          const version = bumpTask(db, token.projectId, token.taskId, "status = 'failed', cancel_state = 'none'", [])
          appendTaskEvent(db, token.projectId, token.taskId, token.attemptId, 'task-failed', version, { error })
          return taskSnapshot(db, loadTaskRow(db, token.projectId, token.taskId))
        })
      }
      default:
        throw new TaskAuthorityValidationError('kind', 'must be a known authorized task operation')
    }
  }

  beginSpawn(input: TrustedBeginSpawnInput): SpawnAdmission {
    assertKnownFields(input, 'input', ['token', 'launchIntentId', 'expectedSpecificationId'])
    const token = parseLeaseToken(input?.['token'])
    const launchIntentId = assertAuthorityUuid(input?.['launchIntentId'], 'launchIntentId')
    const expectedSpecificationId = assertAuthorityUuid(input?.['expectedSpecificationId'], 'expectedSpecificationId')
    return this.database.withImmediate(db => {
      const task = loadTaskRow(db, token.projectId, token.taskId)
      const attempt = db.prepare('SELECT * FROM attempts WHERE project_id = ? AND id = ? AND task_id = ?').get(token.projectId, token.attemptId, token.taskId) as Row | undefined
      if (!attempt || textOrNull(attempt['current_lease_id']) !== token.leaseId) {
        throw new TaskAuthorityError('STALE_AUTHORITY', `attempt ${token.attemptId} is not current for task ${token.taskId}`)
      }
      const lease = loadLeaseRow(db, token.projectId, token.leaseId)
      if (int(lease['generation']) !== token.generation) {
        throw new TaskAuthorityError('STALE_AUTHORITY', `lease ${token.leaseId} generation ${token.generation} is not current`)
      }
      if (text(task['cancel_state']) !== 'none') throw new TaskAuthorityError('TASK_CANCELLED', `task ${token.taskId} has cancellation requested`)
      if (text(attempt['state']) === 'quarantined') throw new TaskAuthorityError('RESOURCE_QUARANTINED', `attempt ${token.attemptId} is quarantined`)
      if (!ACTIVE_STATES[text(attempt['state']) as AttemptState]) {
        throw new TaskAuthorityError('STALE_AUTHORITY', `attempt ${token.attemptId} is ${text(attempt['state'])} and cannot admit a spawn`)
      }
      const cancellingMember = db.prepare(
        "SELECT 1 FROM run_members rm JOIN run_groups rg ON rg.id = rm.run_group_id WHERE rm.project_id = ? AND rm.task_id = ? AND (rg.state IN ('cancelling','cancelled') OR rm.state IN ('cancelling','cancelled')) LIMIT 1"
      ).get(token.projectId, token.taskId) as Row | undefined
      if (cancellingMember) throw new TaskAuthorityError('TASK_CANCELLED', `task ${token.taskId} belongs to a cancelling run group or member`)
      const cancellingExecution = db.prepare(
        "SELECT 1 FROM schedule_executions WHERE project_id = ? AND task_id = ? AND state IN ('cancelling','cancelled') LIMIT 1"
      ).get(token.projectId, token.taskId) as Row | undefined
      if (cancellingExecution) throw new TaskAuthorityError('TASK_CANCELLED', `task ${token.taskId} belongs to a cancelling schedule execution`)
      if (effectiveExpiryMs(db, lease) <= authorityNowMs(db)) throw new TaskAuthorityError('LEASE_EXPIRED', `lease ${token.leaseId} expired before spawn admission`)
      if (text(attempt['specification_id']) !== expectedSpecificationId) {
        throw new TaskAuthorityError('STALE_AUTHORITY', `specification ${expectedSpecificationId} did not match the attempt specification`)
      }
      const existing = db.prepare('SELECT * FROM launch_intents WHERE project_id = ? AND id = ?').get(token.projectId, launchIntentId) as Row | undefined
      if (existing) {
        if (text(existing['attempt_id']) !== token.attemptId || text(existing['lease_id']) !== token.leaseId) {
          throw new TaskAuthorityError('STALE_AUTHORITY', `launch intent ${launchIntentId} is bound to a different attempt or lease`)
        }
        if (text(existing['state']) === 'planned') {
          db.prepare("UPDATE launch_intents SET state = 'spawning', updated_at = ? WHERE project_id = ? AND id = ?").run(nowIso(), token.projectId, launchIntentId)
        } else if (text(existing['state']) !== 'spawning') {
          throw new TaskAuthorityError('STALE_AUTHORITY', `launch intent ${launchIntentId} is already ${text(existing['state'])}`)
        }
      } else {
        const created = nowIso()
        db.prepare("INSERT INTO launch_intents(id, project_id, task_id, attempt_id, lease_id, state, session_id, process_identity_json, stop_state, created_at, updated_at) VALUES (?,?,?,?,?,'spawning',NULL,NULL,'none',?,?)")
          .run(launchIntentId, token.projectId, token.taskId, token.attemptId, token.leaseId, created, created)
      }
      if (text(attempt['state']) === 'claimed') {
        db.prepare("UPDATE attempts SET state = 'launching' WHERE project_id = ? AND id = ?").run(token.projectId, token.attemptId)
        db.prepare("UPDATE run_members SET state = 'launching' WHERE project_id = ? AND task_id = ? AND state = 'claimed'").run(token.projectId, token.taskId)
      }
      const admittedAt = nowIso()
      appendTaskEvent(db, token.projectId, token.taskId, token.attemptId, 'spawn-admitted', int(task['entity_version']), { launchIntentId, specificationId: expectedSpecificationId })
      return {
        projectId: token.projectId,
        taskId: token.taskId,
        attemptId: token.attemptId,
        leaseId: token.leaseId,
        leaseGeneration: token.generation,
        launchIntentId,
        specificationId: expectedSpecificationId,
        admittedAt
      }
    })
  }

  // -- handoff, takeover, reconciliation ---------------------------------------

  offerHandoff(input: AuthenticatedHandoffOfferInput): HandoffOffer {
    assertKnownFields(input, 'input', ['connection', 'projectId', 'taskId', 'attemptId', 'leaseId', 'generation', 'targetOwnerId', 'ttlMs'])
    const connection = parseAuthorityConnection(input?.['connection'])
    const projectId = boundedField(input?.['projectId'], 'projectId', 128)
    const taskId = assertAuthorityUuid(input?.['taskId'], 'taskId')
    const attemptId = assertAuthorityUuid(input?.['attemptId'], 'attemptId')
    const leaseId = assertAuthorityUuid(input?.['leaseId'], 'leaseId')
    const generation = entityVersion(input?.['generation'], 'generation')
    const targetOwnerId = assertAuthorityUuid(input?.['targetOwnerId'], 'targetOwnerId')
    const ttl = ttlMs(input?.['ttlMs'], 'ttlMs', TASK_AUTHORITY_DEFAULT_OFFER_TTL_MS)
    return this.database.withImmediate(db => {
      const ownerId = requireWorker(connection, projectId)
      const token: LeaseToken = {
        projectId, taskId, attemptId, ownerId, leaseId, generation,
        expiresAt: new Date(authorityNowMs(db) + ttl).toISOString()
      }
      requireFencedWrite(db, token, ownerId)
      const existing = db.prepare(
        "SELECT id FROM handoff_offers WHERE project_id = ? AND task_id = ? AND attempt_id = ? AND status = 'pending' LIMIT 1"
      ).get(projectId, taskId, attemptId) as Row | undefined
      if (existing) throw new TaskAuthorityError('HANDOFF_PENDING', `attempt ${attemptId} already has a live handoff offer`)
      const offerId = randomUUID()
      db.prepare("INSERT INTO handoff_offers(id, project_id, task_id, attempt_id, source_owner_id, target_owner_id, source_lease_id, source_generation, status, expires_at_ms, created_at, resolved_at) VALUES (?,?,?,?,?,?,?,?, 'pending', ?, ?, NULL)")
        .run(offerId, projectId, taskId, attemptId, ownerId, targetOwnerId, leaseId, generation, authorityNowMs(db) + ttl, nowIso())
      appendTaskEvent(db, projectId, taskId, attemptId, 'handoff-offered', int(loadTaskRow(db, projectId, taskId)['entity_version']), { offerId, targetOwnerId })
      return handoffOfferSnapshot(db.prepare('SELECT * FROM handoff_offers WHERE project_id = ? AND id = ?').get(projectId, offerId) as Row)
    })
  }

  cancelHandoff(input: AuthenticatedHandoffCancelInput): HandoffOffer {
    assertKnownFields(input, 'input', ['connection', 'projectId', 'taskId', 'attemptId', 'leaseId', 'generation', 'offerId'])
    const connection = parseAuthorityConnection(input?.['connection'])
    const projectId = boundedField(input?.['projectId'], 'projectId', 128)
    const taskId = assertAuthorityUuid(input?.['taskId'], 'taskId')
    const attemptId = assertAuthorityUuid(input?.['attemptId'], 'attemptId')
    const leaseId = assertAuthorityUuid(input?.['leaseId'], 'leaseId')
    const generation = entityVersion(input?.['generation'], 'generation')
    const offerId = assertAuthorityUuid(input?.['offerId'], 'offerId')
    return this.database.withImmediate(db => {
      const ownerId = requireWorker(connection, projectId)
      const offer = db.prepare('SELECT * FROM handoff_offers WHERE project_id = ? AND id = ?').get(projectId, offerId) as Row | undefined
      if (!offer || text(offer['status']) !== 'pending'
        || text(offer['task_id']) !== taskId || text(offer['attempt_id']) !== attemptId
        || text(offer['source_owner_id']) !== ownerId || text(offer['source_lease_id']) !== leaseId
        || int(offer['source_generation']) !== generation) {
        throw new TaskAuthorityError('HANDOFF_INVALID', `handoff offer ${offerId} is not a pending offer bound to the source tuple`)
      }
      db.prepare("UPDATE handoff_offers SET status = 'cancelled', resolved_at = ? WHERE project_id = ? AND id = ?").run(nowIso(), projectId, offerId)
      appendTaskEvent(db, projectId, taskId, attemptId, 'handoff-cancelled', int(loadTaskRow(db, projectId, taskId)['entity_version']), { offerId })
      return handoffOfferSnapshot(db.prepare('SELECT * FROM handoff_offers WHERE project_id = ? AND id = ?').get(projectId, offerId) as Row)
    })
  }

  acceptHandoff(input: AuthenticatedHandoffAcceptInput): ClaimResult {
    assertKnownFields(input, 'input', ['connection', 'projectId', 'taskId', 'attemptId', 'offerId'])
    const connection = parseAuthorityConnection(input?.['connection'])
    const projectId = boundedField(input?.['projectId'], 'projectId', 128)
    const taskId = assertAuthorityUuid(input?.['taskId'], 'taskId')
    const attemptId = assertAuthorityUuid(input?.['attemptId'], 'attemptId')
    const offerId = assertAuthorityUuid(input?.['offerId'], 'offerId')
    return this.database.withImmediate(db => {
      const ownerId = requireWorker(connection, projectId)
      const offer = db.prepare('SELECT * FROM handoff_offers WHERE project_id = ? AND id = ?').get(projectId, offerId) as Row | undefined
      if (!offer) throw new TaskAuthorityError('HANDOFF_INVALID', `handoff offer ${offerId} was not found`)
      if (text(offer['status']) !== 'pending') {
        throw new TaskAuthorityError('HANDOFF_INVALID', `handoff offer ${offerId} is ${text(offer['status'])} and cannot authorize transfer`)
      }
      if (text(offer['target_owner_id']) !== ownerId) {
        throw new TaskAuthorityError('AUTHORIZATION_DENIED', 'authenticated target does not match the handoff offer target')
      }
      const task = loadTaskRow(db, projectId, taskId)
      const attempt = db.prepare('SELECT * FROM attempts WHERE project_id = ? AND id = ? AND task_id = ?').get(projectId, attemptId, taskId) as Row | undefined
      if (!attempt || textOrNull(attempt['current_lease_id']) !== text(offer['source_lease_id']) || text(offer['attempt_id']) !== attemptId) {
        throw new TaskAuthorityError('HANDOFF_INVALID', `handoff offer ${offerId} is not bound to the current attempt tuple`)
      }
      const sourceLease = loadLeaseRow(db, projectId, text(offer['source_lease_id']))
      if (int(sourceLease['generation']) !== int(offer['source_generation'])) {
        throw new TaskAuthorityError('HANDOFF_INVALID', `handoff offer ${offerId} source generation no longer matches the lease`)
      }
      if (text(task['cancel_state']) !== 'none') throw new TaskAuthorityError('TASK_CANCELLED', `task ${taskId} has cancellation requested`)
      if (text(attempt['state']) === 'quarantined') throw new TaskAuthorityError('RESOURCE_QUARANTINED', `attempt ${attemptId} is quarantined`)
      if (!ACTIVE_STATES[text(attempt['state']) as AttemptState]) {
        throw new TaskAuthorityError('STALE_AUTHORITY', `attempt ${attemptId} is ${text(attempt['state'])} and cannot accept a handoff`)
      }
      const nowMs = authorityNowMs(db)
      if (int(offer['expires_at_ms']) <= nowMs) {
        db.prepare("UPDATE handoff_offers SET status = 'expired', resolved_at = ? WHERE project_id = ? AND id = ?").run(nowIso(), projectId, offerId)
        appendTaskEvent(db, projectId, taskId, attemptId, 'handoff-expired', int(task['entity_version']), { offerId })
        failAfterCommit('HANDOFF_INVALID', `handoff offer ${offerId} expired and cannot authorize transfer`)
      }
      const newLeaseId = randomUUID()
      const newGeneration = int(offer['source_generation']) + 1
      db.prepare('INSERT INTO leases(id, project_id, task_id, attempt_id, owner_id, generation, issued_at_ms, initial_expires_at_ms) VALUES (?,?,?,?,?,?,?,?)')
        .run(newLeaseId, projectId, taskId, attemptId, ownerId, newGeneration, nowMs, nowMs + TASK_AUTHORITY_DEFAULT_LEASE_TTL_MS)
      db.prepare('UPDATE attempts SET current_lease_id = ? WHERE project_id = ? AND id = ?').run(newLeaseId, projectId, attemptId)
      db.prepare("UPDATE handoff_offers SET status = 'accepted', resolved_at = ? WHERE project_id = ? AND id = ?").run(nowIso(), projectId, offerId)
      const version = bumpTask(db, projectId, taskId, "status = 'in-progress', cancel_state = 'none'", [])
      appendTaskEvent(db, projectId, taskId, attemptId, 'handoff-accepted', version, { offerId, leaseId: newLeaseId, generation: newGeneration })
      const lease = loadLeaseRow(db, projectId, newLeaseId)
      const expiryMs = effectiveExpiryMs(db, lease)
      return {
        task: taskSnapshot(db, loadTaskRow(db, projectId, taskId)),
        attempt: attemptSnapshot(db, loadAttemptRow(db, projectId, attemptId)),
        token: tokenFor(projectId, taskId, attemptId, lease, expiryMs)
      }
    })
  }

  takeOverExpired(input: AuthenticatedTakeoverInput): ClaimResult {
    assertKnownFields(input, 'input', ['connection', 'projectId', 'taskId', 'attemptId', 'leaseId', 'generation', 'leaseTtlMs'])
    const connection = parseAuthorityConnection(input?.['connection'])
    const projectId = boundedField(input?.['projectId'], 'projectId', 128)
    const taskId = assertAuthorityUuid(input?.['taskId'], 'taskId')
    const attemptId = assertAuthorityUuid(input?.['attemptId'], 'attemptId')
    const leaseId = assertAuthorityUuid(input?.['leaseId'], 'leaseId')
    const generation = entityVersion(input?.['generation'], 'generation')
    const ttl = ttlMs(input?.['leaseTtlMs'], 'leaseTtlMs', TASK_AUTHORITY_DEFAULT_LEASE_TTL_MS)
    return this.database.withImmediate(db => {
      const ownerId = requireWorker(connection, projectId)
      const task = loadTaskRow(db, projectId, taskId)
      const attempt = db.prepare('SELECT * FROM attempts WHERE project_id = ? AND id = ? AND task_id = ?').get(projectId, attemptId, taskId) as Row | undefined
      if (!attempt || textOrNull(attempt['current_lease_id']) !== leaseId) {
        throw new TaskAuthorityError('STALE_AUTHORITY', `lease ${leaseId} is not the current lease of attempt ${attemptId}`)
      }
      const lease = loadLeaseRow(db, projectId, leaseId)
      if (int(lease['generation']) !== generation) {
        throw new TaskAuthorityError('STALE_AUTHORITY', `lease ${leaseId} generation ${generation} is not current`)
      }
      if (text(task['cancel_state']) !== 'none') throw new TaskAuthorityError('TASK_CANCELLED', `task ${taskId} has cancellation requested`)
      const liveOffer = db.prepare(
        "SELECT 1 FROM handoff_offers WHERE project_id = ? AND task_id = ? AND attempt_id = ? AND status = 'pending' AND expires_at_ms > unixepoch('subsec') * 1000 LIMIT 1"
      ).get(projectId, taskId, attemptId) as Row | undefined
      if (liveOffer) throw new TaskAuthorityError('HANDOFF_PENDING', `attempt ${attemptId} has a live handoff offer`)
      const attemptState = text(attempt['state']) as AttemptState
      if (TERMINAL_ATTEMPT_STATES[attemptState]) {
        throw new TaskAuthorityError('STALE_AUTHORITY', `attempt ${attemptId} is ${attemptState} and cannot be taken over`)
      }
      const nowMs = authorityNowMs(db)
      if (effectiveExpiryMs(db, lease) > nowMs) {
        throw new TaskAuthorityError('STALE_AUTHORITY', `lease ${leaseId} has not expired; takeover requires an expired lease`)
      }
      const intent = latestLaunchIntent(db, projectId, attemptId)
      if (intent !== undefined) {
        const intentState = text(intent['state'])
        if (intentState === 'planned') {
          db.prepare("UPDATE launch_intents SET state = 'reconciling-no-spawn', updated_at = ? WHERE project_id = ? AND id = ?").run(nowIso(), projectId, text(intent['id']))
        } else if (intentState === 'spawning') {
          if (textOrNull(intent['process_identity_json']) === null) {
            quarantineAttempt(db, projectId, taskId, attemptId, 'launch intent is spawning without a returned identity')
            failAfterCommit('RESOURCE_QUARANTINED', `attempt ${attemptId} is spawning without a returned identity and cannot transfer`)
          }
          const fingerprint = launchIntentFingerprint(text(intent['id']), attemptId, leaseId)
          const receipt = db.prepare('SELECT verdict FROM runtime_reconciliations WHERE project_id = ? AND attempt_id = ? AND lease_id = ? AND generation = ? AND launch_intent_sha256 = ? ORDER BY sequence DESC LIMIT 1')
            .get(projectId, attemptId, leaseId, generation, fingerprint) as Row | undefined
          if (!receipt) {
            throw new TaskAuthorityError('STALE_AUTHORITY', `attempt ${attemptId} requires expired-owner reconciliation before takeover`)
          }
          if (text(receipt['verdict']) !== 'stale') {
            quarantineAttempt(db, projectId, taskId, attemptId, `latest reconciliation verdict is ${text(receipt['verdict'])}`)
            failAfterCommit('RESOURCE_QUARANTINED', `attempt ${attemptId} child process is ${text(receipt['verdict'])} and cannot transfer`)
          }
        }
      }
      const newLeaseId = randomUUID()
      const newGeneration = generation + 1
      db.prepare('INSERT INTO leases(id, project_id, task_id, attempt_id, owner_id, generation, issued_at_ms, initial_expires_at_ms) VALUES (?,?,?,?,?,?,?,?)')
        .run(newLeaseId, projectId, taskId, attemptId, ownerId, newGeneration, nowMs, nowMs + ttl)
      db.prepare("UPDATE attempts SET state = 'claimed', current_lease_id = ?, finished_at = NULL WHERE project_id = ? AND id = ?").run(newLeaseId, projectId, attemptId)
      db.prepare("UPDATE resource_reservations SET state = 'reserved' WHERE project_id = ? AND attempt_id = ? AND state = 'quarantined'").run(projectId, attemptId)
      db.prepare("UPDATE tasks SET status = 'in-progress', entity_version = entity_version + 1, updated_at = ? WHERE project_id = ? AND id = ?").run(nowIso(), projectId, taskId)
      db.prepare("UPDATE run_members SET state = 'claimed' WHERE project_id = ? AND task_id = ? AND state IN ('launching','running','quarantined')").run(projectId, taskId)
      const versionRow = db.prepare('SELECT entity_version FROM tasks WHERE project_id = ? AND id = ?').get(projectId, taskId) as Row
      appendTaskEvent(db, projectId, taskId, attemptId, 'lease-takeover', int(versionRow['entity_version']), { leaseId: newLeaseId, generation: newGeneration, ownerId })
      const newLease = loadLeaseRow(db, projectId, newLeaseId)
      return {
        task: taskSnapshot(db, loadTaskRow(db, projectId, taskId)),
        attempt: attemptSnapshot(db, loadAttemptRow(db, projectId, attemptId)),
        token: tokenFor(projectId, taskId, attemptId, newLease, nowMs + ttl)
      }
    })
  }

  reconcileExpiredOwner(input: TrustedExpiredOwnerReconciliationInput): TaskSnapshot {
    assertKnownFields(input, 'input', ['projectId', 'taskId', 'attemptId', 'leaseId', 'generation', 'launchIntentSha256', 'processIdentity', 'verdict'])
    const projectId = boundedField(input?.['projectId'], 'projectId', 128)
    const taskId = assertAuthorityUuid(input?.['taskId'], 'taskId')
    const attemptId = assertAuthorityUuid(input?.['attemptId'], 'attemptId')
    const leaseId = assertAuthorityUuid(input?.['leaseId'], 'leaseId')
    const generation = entityVersion(input?.['generation'], 'generation')
    const launchIntentSha256 = boundedField(input?.['launchIntentSha256'], 'launchIntentSha256', 64)
    const processIdentity = input?.['processIdentity']
    const verdict = input?.['verdict']
    if (typeof processIdentity !== 'object' || processIdentity === null) {
      throw new TaskAuthorityValidationError('processIdentity', 'must be a process identity object')
    }
    if (typeof verdict !== 'object' || verdict === null) {
      throw new TaskAuthorityValidationError('verdict', 'must be a process identity verdict')
    }
    return this.database.withImmediate(db => {
      const task = loadTaskRow(db, projectId, taskId)
      const attempt = db.prepare('SELECT * FROM attempts WHERE project_id = ? AND id = ? AND task_id = ?').get(projectId, attemptId, taskId) as Row | undefined
      if (!attempt || textOrNull(attempt['current_lease_id']) !== leaseId) {
        throw new TaskAuthorityError('STALE_AUTHORITY', `lease ${leaseId} is not the current lease of attempt ${attemptId}`)
      }
      const lease = loadLeaseRow(db, projectId, leaseId)
      if (int(lease['generation']) !== generation) {
        throw new TaskAuthorityError('STALE_AUTHORITY', `lease ${leaseId} generation ${generation} is not current`)
      }
      const nowMs = authorityNowMs(db)
      if (effectiveExpiryMs(db, lease) > nowMs) {
        throw new TaskAuthorityError('STALE_AUTHORITY', `lease ${leaseId} has not expired; reconciliation requires an expired owner`)
      }
      const intent = latestLaunchIntent(db, projectId, attemptId)
      if (!intent) {
        throw new TaskAuthorityError('STALE_AUTHORITY', `attempt ${attemptId} has no launch intent to reconcile`)
      }
      if (launchIntentFingerprint(text(intent['id']), attemptId, leaseId) !== launchIntentSha256) {
        throw new TaskAuthorityError('STALE_AUTHORITY', `launch intent hash did not match attempt ${attemptId} lease tuple`)
      }
      const verdictStatus = (verdict as Record<string, unknown>)['status']
      if (verdictStatus !== 'valid' && verdictStatus !== 'stale' && verdictStatus !== 'indeterminate') {
        throw new TaskAuthorityValidationError('verdict.status', 'must be a known verdict status')
      }
      const observation = sha256(JSON.stringify({ processIdentity, verdict }))
      const existing = db.prepare('SELECT id FROM runtime_reconciliations WHERE project_id = ? AND attempt_id = ? AND lease_id = ? AND generation = ? AND launch_intent_sha256 = ? AND verdict = ? AND observation_sha256 = ?')
        .get(projectId, attemptId, leaseId, generation, launchIntentSha256, verdictStatus, observation) as Row | undefined
      if (existing) {
        return taskSnapshot(db, loadTaskRow(db, projectId, taskId))
      }
      const sequenceRow = db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS seq FROM runtime_reconciliations WHERE project_id = ? AND attempt_id = ? AND lease_id = ? AND generation = ? AND launch_intent_sha256 = ?')
        .get(projectId, attemptId, leaseId, generation, launchIntentSha256) as Row
      db.prepare('INSERT INTO runtime_reconciliations(id, project_id, task_id, attempt_id, lease_id, generation, launch_intent_sha256, sequence, process_identity_json, observation_sha256, verdict, reason, observed_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(randomUUID(), projectId, taskId, attemptId, leaseId, generation, launchIntentSha256, int(sequenceRow['seq']), JSON.stringify(processIdentity), observation, verdictStatus, reconciliationReason(verdict), nowMs)
      if (verdictStatus === 'valid' || verdictStatus === 'indeterminate') {
        quarantineAttempt(db, projectId, taskId, attemptId, `expired owner reconciliation verdict was ${verdictStatus}`)
      } else {
        db.prepare("UPDATE launch_intents SET stop_state = 'exited', updated_at = ? WHERE project_id = ? AND id = ?").run(nowIso(), projectId, text(intent['id']))
      }
      appendTaskEvent(db, projectId, taskId, attemptId, 'runtime-reconciled', int(task['entity_version']), { launchIntentSha256, verdict: verdictStatus, sequence: int(sequenceRow['seq']) })
      return taskSnapshot(db, loadTaskRow(db, projectId, taskId))
    })
  }

  // -- cancellation, recovery, adoption, mailbox, projection -------------------

  requestCancellation(input: AdminCancellationInput): TaskSnapshot {
    assertKnownFields(input, 'input', ['connection', 'projectId', 'taskId', 'expectedEntityVersion'])
    const connection = parseAuthorityConnection(input?.['connection'])
    const projectId = boundedField(input?.['projectId'], 'projectId', 128)
    const taskId = assertAuthorityUuid(input?.['taskId'], 'taskId')
    const expectedEntityVersion = entityVersion(input?.['expectedEntityVersion'], 'expectedEntityVersion')
    return this.database.withImmediate(db => {
      requireAdminProject(connection, projectId)
      const task = loadTaskRow(db, projectId, taskId)
      if (int(task['entity_version']) !== expectedEntityVersion) {
        throw new TaskAuthorityError('STALE_AUTHORITY', `task ${taskId} entity version ${expectedEntityVersion} did not match ${int(task['entity_version'])}`)
      }
      if (TERMINAL_TASK_STATUSES[text(task['status']) as TaskStatus]) {
        return taskSnapshot(db, task)
      }
      const attemptId = textOrNull(task['current_attempt_id'])
      if (taskAwaitingExitAck(db, projectId, taskId, attemptId)) {
        if (text(task['status']) !== 'cancelling') {
          db.prepare("UPDATE tasks SET status = 'cancelling', entity_version = entity_version + 1, updated_at = ? WHERE project_id = ? AND id = ?").run(nowIso(), projectId, taskId)
        }
        db.prepare("UPDATE tasks SET cancel_state = 'requested' WHERE project_id = ? AND id = ?").run(projectId, taskId)
        db.prepare("UPDATE attempts SET state = 'cancelling' WHERE project_id = ? AND id = ?").run(projectId, attemptId as string)
        syncMemberState(db, projectId, taskId, 'cancelling')
        syncExecutionForTask(db, projectId, taskId, execution => {
          if (TERMINAL_EXECUTION_STATES[text(execution['state']) as ScheduleExecutionState]) return { state: text(execution['state']) as ScheduleExecutionState }
          return { state: 'cancelling' }
        })
        const versionRow = db.prepare('SELECT entity_version FROM tasks WHERE project_id = ? AND id = ?').get(projectId, taskId) as Row
        appendTaskEvent(db, projectId, taskId, attemptId, 'cancellation-requested', int(versionRow['entity_version']), {})
      } else {
        // Attempt-less cancellation has no process exit to acknowledge; close to terminal in the same transaction.
        const version = closeCancellationTerminal(db, projectId, taskId, attemptId)
        appendTaskEvent(db, projectId, taskId, attemptId, 'cancellation-closed', version, { reason: 'no live attempt to acknowledge' })
      }
      return taskSnapshot(db, loadTaskRow(db, projectId, taskId))
    })
  }

  acknowledgeExit(input: TrustedExitAcknowledgement): TaskSnapshot {
    assertKnownFields(input, 'input', ['projectId', 'taskId', 'attemptId', 'leaseId', 'generation', 'reason'])
    const projectId = boundedField(input?.['projectId'], 'projectId', 128)
    const taskId = assertAuthorityUuid(input?.['taskId'], 'taskId')
    const attemptId = assertAuthorityUuid(input?.['attemptId'], 'attemptId')
    const leaseId = assertAuthorityUuid(input?.['leaseId'], 'leaseId')
    const generation = entityVersion(input?.['generation'], 'generation')
    const reason = boundedText(input?.['reason'] ?? 'daemon-confirmed exit', 'reason', TASK_AUTHORITY_MAX_ERROR_TEXT)
    return this.database.withImmediate(db => {
      const task = loadTaskRow(db, projectId, taskId)
      const attempt = db.prepare('SELECT * FROM attempts WHERE project_id = ? AND id = ? AND task_id = ?').get(projectId, attemptId, taskId) as Row | undefined
      if (!attempt || textOrNull(attempt['current_lease_id']) !== leaseId) {
        throw new TaskAuthorityError('STALE_AUTHORITY', `lease ${leaseId} is not the current lease of attempt ${attemptId}`)
      }
      const lease = loadLeaseRow(db, projectId, leaseId)
      if (int(lease['generation']) !== generation) {
        throw new TaskAuthorityError('STALE_AUTHORITY', `lease ${leaseId} generation ${generation} is not current`)
      }
      if (text(attempt['state']) !== 'cancelling') {
        throw new TaskAuthorityError('STALE_AUTHORITY', `attempt ${attemptId} is ${text(attempt['state'])}; only cancelling attempts accept exit acknowledgement`)
      }
      db.prepare("UPDATE attempts SET state = 'cancelled', finished_at = ? WHERE project_id = ? AND id = ?").run(nowIso(), projectId, attemptId)
      stopLaunchIntent(db, projectId, attemptId, 'stopped', 'exited')
      releaseReservation(db, projectId, attemptId)
      db.prepare("UPDATE run_members SET state = 'cancelled' WHERE project_id = ? AND task_id = ? AND state <> 'completed'").run(projectId, taskId)
      const memberGroups = db.prepare('SELECT run_group_id FROM run_members WHERE project_id = ? AND task_id = ?').all(projectId, taskId) as Row[]
      for (const memberGroup of memberGroups) closeGroupIfFullyTerminal(db, text(memberGroup['run_group_id']))
      syncExecutionForTask(db, projectId, taskId, () => ({ state: 'cancelled' }))
      const version = bumpTask(db, projectId, taskId, "status = 'cancelled'", [])
      appendTaskEvent(db, projectId, taskId, attemptId, 'exit-acknowledged', version, { reason })
      return taskSnapshot(db, loadTaskRow(db, projectId, taskId))
    })
  }

  // -- trusted daemon-internal surfaces (never exposed to request decoders) ---

  /**
   * Persists the exact session/process facts returned by the finite-job or
   * agent-open port. Unlike `bind-runtime` this is not fenced: it must record
   * what the child returned even when the original token has since been
   * superseded, so a successor reconciliation sees the exact identity.
   */
  recordReturnedIdentity(input: Readonly<{ projectId: string; taskId: string; attemptId: string; sessionId: string; processIdentity: ProcessIdentity | null }>): void {
    assertKnownFields(input, 'input', ['projectId', 'taskId', 'attemptId', 'sessionId', 'processIdentity'])
    const projectId = boundedField(input?.['projectId'], 'projectId', 128)
    const taskId = assertAuthorityUuid(input?.['taskId'], 'taskId')
    const attemptId = assertAuthorityUuid(input?.['attemptId'], 'attemptId')
    const sessionId = boundedField(input?.['sessionId'], 'sessionId', 128)
    const processIdentity = input?.['processIdentity']
    if (processIdentity !== null && (typeof processIdentity !== 'object' || processIdentity === null)) {
      throw new TaskAuthorityValidationError('processIdentity', 'must be a process identity object or null')
    }
    this.database.withImmediate(db => {
      loadTaskRow(db, projectId, taskId)
      loadAttemptRow(db, projectId, attemptId)
      const intent = latestLaunchIntent(db, projectId, attemptId)
      if (!intent || text(intent['state']) !== 'spawning') {
        throw new TaskAuthorityError('STALE_AUTHORITY', `attempt ${attemptId} has no spawning launch intent to record returned identity on`)
      }
      db.prepare('UPDATE launch_intents SET session_id = ?, process_identity_json = ?, updated_at = ? WHERE project_id = ? AND id = ?')
        .run(sessionId, processIdentity === null ? null : JSON.stringify(processIdentity), nowIso(), projectId, text(intent['id']))
      appendTaskEvent(db, projectId, taskId, attemptId, 'runtime-facts-recorded', int(loadTaskRow(db, projectId, taskId)['entity_version']), { sessionId, launchIntentId: text(intent['id']) })
    })
  }

  /** Audit-only record that a superseded generation's child exited late; never mutates state. */
  recordStaleGenerationExit(input: Readonly<{ projectId: string; taskId: string; attemptId: string; leaseId: string; generation: number; exitCode: number | null; outputDigest: string }>): void {
    assertKnownFields(input, 'input', ['projectId', 'taskId', 'attemptId', 'leaseId', 'generation', 'exitCode', 'outputDigest'])
    const projectId = boundedField(input?.['projectId'], 'projectId', 128)
    const taskId = assertAuthorityUuid(input?.['taskId'], 'taskId')
    const attemptId = assertAuthorityUuid(input?.['attemptId'], 'attemptId')
    const leaseId = assertAuthorityUuid(input?.['leaseId'], 'leaseId')
    const generation = entityVersion(input?.['generation'], 'generation')
    const exitCode = input?.['exitCode']
    if (exitCode !== null && (!Number.isSafeInteger(exitCode) || (exitCode as number) < 0 || (exitCode as number) > 255)) {
      throw new TaskAuthorityValidationError('exitCode', 'must be an exit code from 0 to 255 or null')
    }
    const outputDigest = boundedField(input?.['outputDigest'], 'outputDigest', 64)
    this.database.withImmediate(db => {
      appendTaskEvent(db, projectId, taskId, attemptId, 'stale-generation-exit', int(loadTaskRow(db, projectId, taskId)['entity_version']), { leaseId, generation, exitCode, outputDigest })
    })
  }

  /**
   * Startup reconciliation for one nonterminal attempt with a recorded
   * runtime binding. `valid` preserves ownership (event only); `stale` closes
   * the attempt failed and releases its reservation; `indeterminate`
   * quarantines it. Cancelling attempts with a confirmed-exited runtime are
   * closed through the fenced `acknowledgeExit` path by the caller instead.
   */
  reconcileStartupAttempt(input: Readonly<{ projectId: string; taskId: string; attemptId: string; verdict: 'valid' | 'stale' | 'indeterminate'; reason: string }>): 'preserved' | 'closed' | 'quarantined' {
    assertKnownFields(input, 'input', ['projectId', 'taskId', 'attemptId', 'verdict', 'reason'])
    const projectId = boundedField(input?.['projectId'], 'projectId', 128)
    const taskId = assertAuthorityUuid(input?.['taskId'], 'taskId')
    const attemptId = assertAuthorityUuid(input?.['attemptId'], 'attemptId')
    const verdict = input?.['verdict']
    if (verdict !== 'valid' && verdict !== 'stale' && verdict !== 'indeterminate') {
      throw new TaskAuthorityValidationError('verdict', 'must be a known reconciliation verdict')
    }
    const reason = boundedText(input?.['reason'], 'reason', TASK_AUTHORITY_MAX_ERROR_TEXT, false)
    return this.database.withImmediate(db => {
      const task = loadTaskRow(db, projectId, taskId)
      const attempt = loadAttemptRow(db, projectId, attemptId)
      const attemptState = text(attempt['state']) as AttemptState
      if (TERMINAL_ATTEMPT_STATES[attemptState]) return attemptState === 'failed' ? 'closed' : 'preserved'
      if (verdict === 'valid') {
        appendTaskEvent(db, projectId, taskId, attemptId, 'startup-reconciled-preserved', int(task['entity_version']), { reason })
        return 'preserved'
      }
      if (verdict === 'stale') {
        db.prepare("UPDATE attempts SET state = 'failed', finished_at = ? WHERE project_id = ? AND id = ?").run(nowIso(), projectId, attemptId)
        stopLaunchIntent(db, projectId, attemptId, 'stopped', 'exited')
        releaseReservation(db, projectId, attemptId)
        const version = bumpTask(db, projectId, taskId, "status = 'failed'", [])
        appendTaskEvent(db, projectId, taskId, attemptId, 'startup-reconciled-closed', version, { reason })
        return 'closed'
      }
      quarantineAttempt(db, projectId, taskId, attemptId, reason)
      return 'quarantined'
    })
  }

  /** Expires pending handoff offers whose authority-time deadline passed; returns the count. */
  expireDueHandoffOffers(): number {
    return this.database.withImmediate(db => {
      const nowMs = authorityNowMs(db)
      const due = db.prepare("SELECT * FROM handoff_offers WHERE status = 'pending' AND expires_at_ms <= ?").all(nowMs) as Row[]
      for (const offer of due) {
        db.prepare("UPDATE handoff_offers SET status = 'expired', resolved_at = ? WHERE project_id = ? AND id = ?").run(nowIso(), text(offer['project_id']), text(offer['id']))
        appendTaskEvent(db, text(offer['project_id']), text(offer['task_id']), text(offer['attempt_id']), 'handoff-offer-expired', int(loadTaskRow(db, text(offer['project_id']), text(offer['task_id']))['entity_version']), { offerId: text(offer['id']) })
      }
      return due.length
    })
  }

  /** Enabled schedules whose next occurrence is due at or before the given authority time. */
  listSchedulesDue(nowMs: number): ScheduleSnapshot[] {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TaskAuthorityValidationError('nowMs', 'must be a non-negative integer')
    return this.database.withReadOnly(db => {
      const rows = db.prepare("SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at, project_id, id").all(new Date(nowMs).toISOString()) as Row[]
      return rows.map(row => scheduleSnapshot(db, row))
    })
  }

  /** Reads one schedule snapshot for daemon-side enqueue coordination. */
  readSchedule(projectId: string, scheduleId: string): ScheduleSnapshot {
    const boundedProjectId = boundedField(projectId, 'projectId', 128)
    const id = assertAuthorityUuid(scheduleId, 'scheduleId')
    return this.database.withReadOnly(db => scheduleSnapshot(db, loadSchedule(db, boundedProjectId, id)))
  }

  /** Queued members of active run groups, in deterministic dispatch order. */
  listQueuedRunMembers(): Array<Readonly<{ runGroupId: string; profileId: string; projectId: string; taskId: string; ordinal: number; specification: TaskExecutionSpecificationInput | null }>> {
    return this.database.withReadOnly(db => {
      const rows = db.prepare(
        "SELECT rm.run_group_id AS run_group_id, rg.profile_id AS profile_id, rm.project_id AS project_id, rm.task_id AS task_id, rm.ordinal AS ordinal, rm.specification_json AS specification_json FROM run_members rm JOIN run_groups rg ON rg.id = rm.run_group_id WHERE rm.state = 'queued' AND rg.state = 'active' ORDER BY rg.created_at, rm.ordinal, rm.project_id, rm.task_id LIMIT 500"
      ).all() as Row[]
      return rows.map(row => ({
        runGroupId: text(row['run_group_id']),
        profileId: text(row['profile_id']),
        projectId: text(row['project_id']),
        taskId: text(row['task_id']),
        ordinal: int(row['ordinal']),
        specification: textOrNull(row['specification_json']) === null
          ? null
          : parseTaskExecutionSpecification(parseJson(textOrNull(row['specification_json']) as string), 'persisted run member specification')
      }))
    })
  }

  /** Nonterminal native attempts with their runtime bindings, in deterministic order. */
  listNonterminalAttempts(): AttemptSnapshot[] {
    return this.database.withReadOnly(db => {
      const rows = db.prepare(
        "SELECT * FROM attempts WHERE provenance_kind = 'native' AND state IN ('claimed','launching','running','cancelling') ORDER BY project_id, task_id, sequence"
      ).all() as Row[]
      return rows.map(row => attemptSnapshot(db, row))
    })
  }

  /** Reads one committed immutable execution specification back for daemon coordination. */
  readExecutionSpecification(projectId: string, specificationId: string): TaskExecutionSpecificationInput {
    const boundedProjectId = boundedField(projectId, 'projectId', 128)
    const id = assertAuthorityUuid(specificationId, 'specificationId')
    return this.database.withReadOnly(db => {
      const row = db.prepare('SELECT command_json, target_json, verification_json FROM execution_specifications WHERE project_id = ? AND id = ?').get(boundedProjectId, id) as Row | undefined
      if (!row) throw new TaskAuthorityError('STALE_AUTHORITY', `specification ${id} was not found in project ${boundedProjectId}`)
      return parseTaskExecutionSpecification({ command: parseJson(row['command_json']), target: parseJson(row['target_json']), verification: parseJson(row['verification_json']) })
    })
  }

  retryFailedTask(input: AdminRetryFailedTaskInput): ClaimResult {
    assertKnownFields(input, 'input', ['connection', 'projectId', 'taskId', 'expectedEntityVersion', 'ownerId', 'specification', 'leaseTtlMs'])
    const connection = parseAuthorityConnection(input?.['connection'])
    const projectId = boundedField(input?.['projectId'], 'projectId', 128)
    const taskId = assertAuthorityUuid(input?.['taskId'], 'taskId')
    const expectedEntityVersion = entityVersion(input?.['expectedEntityVersion'], 'expectedEntityVersion')
    const ownerId = assertAuthorityUuid(input?.['ownerId'], 'ownerId')
    const specification = input?.['specification'] === undefined ? undefined : parseTaskExecutionSpecification(input['specification'])
    const ttl = ttlMs(input?.['leaseTtlMs'], 'leaseTtlMs', TASK_AUTHORITY_DEFAULT_LEASE_TTL_MS)
    return this.database.withImmediate(db => {
      requireAdminProject(connection, projectId)
      const task = loadTaskRow(db, projectId, taskId)
      if (int(task['entity_version']) !== expectedEntityVersion) {
        throw new TaskAuthorityError('STALE_AUTHORITY', `task ${taskId} entity version ${expectedEntityVersion} did not match ${int(task['entity_version'])}`)
      }
      if (text(task['status']) !== 'failed') {
        throw new TaskAuthorityError('STALE_AUTHORITY', `task ${taskId} is ${text(task['status'])}; only failed tasks can be retried`)
      }
      const failedAttemptId = textOrNull(task['current_attempt_id'])
      if (failedAttemptId === null) throw new TaskAuthorityError('STALE_AUTHORITY', `task ${taskId} has no failed attempt to retry`)
      const failedAttempt = loadAttemptRow(db, projectId, failedAttemptId)
      if (text(failedAttempt['state']) !== 'failed') {
        throw new TaskAuthorityError('STALE_AUTHORITY', `attempt ${failedAttemptId} is ${text(failedAttempt['state'])}; retry requires a failed attempt`)
      }
      const nowMs = authorityNowMs(db)
      const specificationId = specification === undefined ? text(failedAttempt['specification_id']) : insertSpecification(db, projectId, taskId, specification)
      const { attemptId, leaseId } = insertAttemptWithLease(db, projectId, taskId, nextAttemptSequence(db, projectId, taskId), failedAttemptId, specificationId, ownerId, ttl, nowMs)
      db.prepare("UPDATE tasks SET current_attempt_id = ?, status = 'in-progress', cancel_state = 'none', entity_version = entity_version + 1, updated_at = ? WHERE project_id = ? AND id = ?")
        .run(attemptId, nowIso(), projectId, taskId)
      db.prepare("UPDATE run_members SET state = 'claimed' WHERE project_id = ? AND task_id = ? AND state = 'failed'").run(projectId, taskId)
      const versionRow = db.prepare('SELECT entity_version FROM tasks WHERE project_id = ? AND id = ?').get(projectId, taskId) as Row
      appendTaskEvent(db, projectId, taskId, attemptId, 'task-retried', int(versionRow['entity_version']), { retryOfAttemptId: failedAttemptId, ownerId })
      const lease = loadLeaseRow(db, projectId, leaseId)
      return {
        task: taskSnapshot(db, loadTaskRow(db, projectId, taskId)),
        attempt: attemptSnapshot(db, loadAttemptRow(db, projectId, attemptId)),
        token: tokenFor(projectId, taskId, attemptId, lease, nowMs + ttl)
      }
    })
  }

  adoptArtifact(input: ReviewedArtifactAdoptionInput): TaskSnapshot {
    assertKnownFields(input, 'input', ['connection', 'projectId', 'taskId', 'artifactId', 'reviewReceiptSha256'])
    const connection = parseAuthorityConnection(input?.['connection'])
    const projectId = boundedField(input?.['projectId'], 'projectId', 128)
    const taskId = assertAuthorityUuid(input?.['taskId'], 'taskId')
    const artifactId = assertAuthorityUuid(input?.['artifactId'], 'artifactId')
    const reviewReceiptSha256 = boundedField(input?.['reviewReceiptSha256'], 'reviewReceiptSha256', 64)
    return this.database.withImmediate(db => {
      const reviewerId = requireReviewer(connection, projectId)
      const task = loadTaskRow(db, projectId, taskId)
      const artifact = db.prepare('SELECT * FROM verification_artifacts WHERE project_id = ? AND id = ? AND task_id = ?').get(projectId, artifactId, taskId) as Row | undefined
      if (!artifact) throw new TaskAuthorityError('TASK_NOT_FOUND', `artifact ${artifactId} was not found for task ${taskId}`)
      if (text(artifact['provenance_kind']) !== 'imported-legacy') {
        throw new TaskAuthorityError('COMPLETION_REJECTED', 'native artifacts are already lease-bound and need no adoption')
      }
      const currentAttemptId = textOrNull(task['current_attempt_id'])
      if (currentAttemptId === null) throw new TaskAuthorityError('STALE_AUTHORITY', `task ${taskId} has no current attempt to adopt into`)
      const existing = db.prepare('SELECT * FROM artifact_adoptions WHERE project_id = ? AND current_attempt_id = ? AND artifact_id = ?').get(projectId, currentAttemptId, artifactId) as Row | undefined
      if (existing) {
        if (text(existing['review_receipt_sha256']) !== reviewReceiptSha256 || text(existing['reviewer_id']) !== reviewerId) {
          throw new TaskAuthorityError('IDEMPOTENCY_CONFLICT', `artifact ${artifactId} was already adopted with a different review`)
        }
        return taskSnapshot(db, loadTaskRow(db, projectId, taskId))
      }
      db.prepare('INSERT INTO artifact_adoptions(id, project_id, task_id, current_attempt_id, source_attempt_id, artifact_id, reviewer_id, review_receipt_sha256, adopted_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(randomUUID(), projectId, taskId, currentAttemptId, textOrNull(artifact['attempt_id']), artifactId, reviewerId, reviewReceiptSha256, nowIso())
      appendTaskEvent(db, projectId, taskId, currentAttemptId, 'artifact-adopted', int(task['entity_version']), { artifactId, reviewerId })
      return taskSnapshot(db, loadTaskRow(db, projectId, taskId))
    })
  }

  appendMailbox(input: AuthenticatedMailboxInput): TaskMailboxEntry {
    assertKnownFields(input, 'input', ['connection', 'projectId', 'taskId', 'kind', 'payload'])
    const connection = parseAuthorityConnection(input?.['connection'])
    const projectId = boundedField(input?.['projectId'], 'projectId', 128)
    const taskId = assertAuthorityUuid(input?.['taskId'], 'taskId')
    const kind = input?.['kind']
    if (kind !== 'attention' && kind !== 'progress' && kind !== 'artifact' && kind !== 'system') {
      throw new TaskAuthorityValidationError('kind', 'must be a known mailbox kind')
    }
    const payload = input?.['payload']
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new TaskAuthorityValidationError('payload', 'must be an object')
    }
    const payloadJson = JSON.stringify(payload)
    if (payloadJson.length > TASK_AUTHORITY_MAX_USER_TEXT) {
      throw new TaskAuthorityValidationError('payload', `must serialize to at most ${TASK_AUTHORITY_MAX_USER_TEXT} characters`)
    }
    return this.database.withImmediate(db => {
      requireWorker(connection, projectId)
      const task = loadTaskRow(db, projectId, taskId)
      const attemptId = textOrNull(task['current_attempt_id'])
      const entryId = randomUUID()
      db.prepare('INSERT INTO task_mailbox(id, project_id, task_id, attempt_id, lease_id, generation, kind, payload_json, acknowledged_at, created_at) VALUES (?,?,?,?,NULL,NULL,?,?,NULL,?)')
        .run(entryId, projectId, taskId, attemptId, kind, payloadJson, nowIso())
      appendTaskEvent(db, projectId, taskId, attemptId, 'mailbox-appended', int(task['entity_version']), { entryId, kind })
      return mailboxEntrySnapshot(db.prepare('SELECT * FROM task_mailbox WHERE project_id = ? AND id = ?').get(projectId, entryId) as Row)
    })
  }

  acknowledgeAttention(input: AuthenticatedAttentionAcknowledgement): TaskMailboxEntry {
    assertKnownFields(input, 'input', ['connection', 'projectId', 'taskId', 'mailboxEntryId'])
    const connection = parseAuthorityConnection(input?.['connection'])
    const projectId = boundedField(input?.['projectId'], 'projectId', 128)
    const taskId = assertAuthorityUuid(input?.['taskId'], 'taskId')
    const mailboxEntryId = assertAuthorityUuid(input?.['mailboxEntryId'], 'mailboxEntryId')
    return this.database.withImmediate(db => {
      requireReviewer(connection, projectId)
      const task = loadTaskRow(db, projectId, taskId)
      const entry = db.prepare('SELECT * FROM task_mailbox WHERE project_id = ? AND id = ? AND task_id = ?').get(projectId, mailboxEntryId, taskId) as Row | undefined
      if (!entry) throw new TaskAuthorityError('TASK_NOT_FOUND', `mailbox entry ${mailboxEntryId} was not found for task ${taskId}`)
      if (text(entry['kind']) !== 'attention') {
        throw new TaskAuthorityValidationError('mailboxEntryId', 'only attention entries can be acknowledged')
      }
      if (textOrNull(entry['acknowledged_at']) === null) {
        db.prepare('UPDATE task_mailbox SET acknowledged_at = ? WHERE project_id = ? AND id = ?').run(nowIso(), projectId, mailboxEntryId)
      }
      appendTaskEvent(db, projectId, taskId, textOrNull(task['current_attempt_id']), 'attention-acknowledged', int(task['entity_version']), { mailboxEntryId })
      return mailboxEntrySnapshot(db.prepare('SELECT * FROM task_mailbox WHERE project_id = ? AND id = ?').get(projectId, mailboxEntryId) as Row)
    })
  }

  query(input: TaskQuery): TaskProjection {
    assertKnownFields(input, 'input', ['connection', 'projectId', 'status', 'runnableOnly', 'cursor', 'limit'])
    const connection = parseAuthorityConnection(input?.['connection'])
    const projectId = input?.['projectId'] === undefined ? undefined : boundedField(input['projectId'], 'projectId', 128)
    const status = input?.['status']
    if (status !== undefined && !['todo', 'blocked', 'in-progress', 'cancelling', 'cancelled', 'done', 'failed', 'quarantined'].includes(status)) {
      throw new TaskAuthorityValidationError('status', 'must be a known task status')
    }
    const runnableOnly = input?.['runnableOnly'] ?? false
    if (typeof runnableOnly !== 'boolean') throw new TaskAuthorityValidationError('runnableOnly', 'must be a boolean')
    const limit = parseProjectionLimit(input?.['limit'])
    const cursor = input?.['cursor'] === undefined ? null : decodeCursor(parseTaskQueryCursor(input['cursor']))
    if (projectId !== undefined) {
      if (connection.role === 'administrator') {
        if (connection.authorizedProjectIds !== undefined && !connection.authorizedProjectIds.includes(projectId)) {
          throw new TaskAuthorityError('PROJECT_SCOPE_MISMATCH', `administrator connection is not authorized for project ${projectId}`)
        }
      } else if (connectionDeniedProject(connection, projectId)) {
        throw new TaskAuthorityError('PROJECT_SCOPE_MISMATCH', `connection is not authorized for project ${projectId}`)
      }
    } else if (connection.role !== 'administrator') {
      if (connection.authorizedProjectIds === undefined) {
        throw new TaskAuthorityError('AUTHORIZATION_DENIED', 'unscoped task projection requires an administrator connection')
      }
    }
    return this.database.withReadOnly(db => {
      const clauses: string[] = []
      const params: Array<string | number> = []
      if (projectId !== undefined) {
        clauses.push('project_id = ?')
        params.push(projectId)
      } else if (connection.role !== 'administrator' && connection.authorizedProjectIds !== undefined) {
        clauses.push(`project_id IN (${connection.authorizedProjectIds.map(() => '?').join(',')})`)
        params.push(...connection.authorizedProjectIds)
      }
      if (status !== undefined) { clauses.push('status = ?'); params.push(status) }
      if (runnableOnly) {
        clauses.push("status = 'todo'", "cancel_state = 'none'", 'current_attempt_id IS NULL')
        clauses.push("NOT EXISTS (SELECT 1 FROM task_dependencies d JOIN tasks dep ON dep.project_id = d.project_id AND dep.id = d.depends_on_task_id WHERE d.project_id = tasks.project_id AND d.task_id = tasks.id AND dep.status <> 'done')")
      }
      if (cursor !== null) {
        clauses.push('(priority > ? OR (priority = ? AND created_at > ?) OR (priority = ? AND created_at = ? AND id > ?))')
        const priority = Number(cursor[0])
        params.push(priority, priority, String(cursor[1]), priority, String(cursor[1]), String(cursor[2]))
      }
      const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
      const rows = db.prepare(`SELECT * FROM tasks${where} ORDER BY priority, created_at, id LIMIT ?`).all(...params, limit + 1) as Row[]
      const page = rows.slice(0, limit)
      const last = page[page.length - 1]
      const nextCursor = rows.length > limit && last !== undefined
        ? encodeCursor([int(last['priority']), text(last['created_at']), text(last['id'])])
        : null
      return { tasks: page.map(row => taskSnapshot(db, row)), nextCursor }
    })
  }
}

// ---------------------------------------------------------------------------
// Run group, mailbox, and handoff snapshots
// ---------------------------------------------------------------------------

function loadRunGroup(db: DatabaseSync, runGroupId: string): Row {
  const row = db.prepare('SELECT * FROM run_groups WHERE id = ?').get(runGroupId) as Row | undefined
  if (!row) throw new TaskAuthorityError('TASK_NOT_FOUND', `run group ${runGroupId} was not found`)
  return row
}

function runGroupSnapshot(db: DatabaseSync, group: Row): RunGroupSnapshot {
  const members = db.prepare('SELECT * FROM run_members WHERE run_group_id = ? ORDER BY ordinal').all(text(group['id'])) as Row[]
  return {
    runGroupId: text(group['id']),
    profileId: text(group['profile_id']),
    name: text(group['name']),
    retryOfRunGroupId: textOrNull(group['retry_of_run_group_id']),
    concurrency: int(group['concurrency']),
    state: text(group['state']) as RunGroupSnapshot['state'],
    entityVersion: int(group['entity_version']),
    members: members.map(member => ({
      projectId: text(member['project_id']),
      taskId: text(member['task_id']),
      attemptId: textOrNull(member['source_attempt_id']),
      ordinal: int(member['ordinal']),
      state: text(member['state']) as RunGroupSnapshot['members'][number]['state']
    })),
    createdAt: text(group['created_at']),
    updatedAt: text(group['updated_at'])
  }
}

function handoffOfferSnapshot(offer: Row): HandoffOffer {
  return {
    offerId: text(offer['id']),
    projectId: text(offer['project_id']),
    taskId: text(offer['task_id']),
    attemptId: text(offer['attempt_id']),
    sourceOwnerId: text(offer['source_owner_id']),
    targetOwnerId: text(offer['target_owner_id']),
    sourceLeaseId: text(offer['source_lease_id']),
    sourceGeneration: int(offer['source_generation']),
    status: text(offer['status']) as HandoffOffer['status'],
    expiresAt: new Date(int(offer['expires_at_ms'])).toISOString(),
    createdAt: text(offer['created_at']),
    resolvedAt: textOrNull(offer['resolved_at'])
  }
}

function mailboxEntrySnapshot(entry: Row): TaskMailboxEntry {
  return {
    entryId: text(entry['id']),
    projectId: text(entry['project_id']),
    taskId: text(entry['task_id']),
    attemptId: textOrNull(entry['attempt_id']),
    leaseId: textOrNull(entry['lease_id']),
    generation: entry['generation'] === null || entry['generation'] === undefined ? null : int(entry['generation']),
    kind: text(entry['kind']) as TaskMailboxEntry['kind'],
    payload: parseJson(entry['payload_json']) as Record<string, unknown>,
    acknowledgedAt: textOrNull(entry['acknowledged_at']),
    createdAt: text(entry['created_at'])
  }
}

// ---------------------------------------------------------------------------
// Daemon-internal migration source surface (Task 3 builds the importer on this)
// ---------------------------------------------------------------------------

export type TaskAuthorityMigrationMappingInput = Readonly<{
  entityKind: string
  sourceEntityKey: string
  authorityEntityId: string
  sourceFingerprint: string
  state?: 'active' | 'superseded' | 'retired'
}>

export type TaskAuthorityMigrationSourceInput = Readonly<{
  scopeKind: 'project' | 'profile'
  scopeId: string
  projectId?: string
  sourceKind: string
  canonicalSourcePath: string
  sourceSha256: string
  normalizedJson: string
  /** Exact byte length of the frozen source file; defaults to the normalized payload length. */
  sourceBytes?: number
  phase?: 'imported' | 'superseded' | 'retired'
  supersedesSourceId?: string
  entityMappings?: readonly TaskAuthorityMigrationMappingInput[]
}>

export type TaskAuthorityMigrationSourceReceipt = Readonly<{
  sourceId: string
  created: boolean
}>

function migrationPhase(value: unknown, field: string): 'imported' | 'superseded' | 'retired' {
  if (value === undefined) return 'imported'
  if (value !== 'imported' && value !== 'superseded' && value !== 'retired') {
    throw new TaskAuthorityValidationError(field, 'must be a known migration phase')
  }
  return value
}

/**
 * Records an immutable imported-source snapshot and its entity mappings. The
 * UNIQUE(scope_kind, scope_id, source_kind, canonical_source_path,
 * source_sha256) constraint plus BEGIN IMMEDIATE make concurrent recording of
 * the same source deterministic: exactly one row wins, every caller receives
 * the same source ID, and native authority rows are never touched here.
 */
export function recordMigrationSource(database: TaskAuthorityDatabase, input: TaskAuthorityMigrationSourceInput): TaskAuthorityMigrationSourceReceipt {
  return database.withImmediate(db => recordMigrationSourceIn(db, input))
}

/** Transaction-internal form of {@link recordMigrationSource} for callers that own the transaction. */
export function recordMigrationSourceIn(db: DatabaseSync, input: TaskAuthorityMigrationSourceInput): TaskAuthorityMigrationSourceReceipt {
  assertKnownFields(input, 'input', ['scopeKind', 'scopeId', 'projectId', 'sourceKind', 'canonicalSourcePath', 'sourceSha256', 'sourceBytes', 'normalizedJson', 'phase', 'supersedesSourceId', 'entityMappings'])
  const scopeKind = input?.['scopeKind']
  if (scopeKind !== 'project' && scopeKind !== 'profile') {
    throw new TaskAuthorityValidationError('scopeKind', 'must be "project" or "profile"')
  }
  const scopeId = boundedField(input?.['scopeId'], 'scopeId', 128)
  const sourceKind = boundedField(input?.['sourceKind'], 'sourceKind', 128)
  const canonicalSourcePath = boundedField(input?.['canonicalSourcePath'], 'canonicalSourcePath', 128)
  const sourceSha256 = boundedField(input?.['sourceSha256'], 'sourceSha256', 64)
  const normalizedJson = boundedText(input?.['normalizedJson'], 'normalizedJson', TASK_AUTHORITY_MAX_USER_TEXT)
  const sourceBytes = input?.['sourceBytes'] ?? Buffer.byteLength(normalizedJson, 'utf8')
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 0) {
    throw new TaskAuthorityValidationError('sourceBytes', 'must be a non-negative integer')
  }
  const phase = migrationPhase(input?.['phase'], 'phase')
  const mappings = input?.['entityMappings'] ?? []
  if (!Array.isArray(mappings) || mappings.length > TASK_AUTHORITY_MAX_BATCH) {
    throw new TaskAuthorityValidationError('entityMappings', `must be an array of at most ${TASK_AUTHORITY_MAX_BATCH} mappings`)
  }
  const projectId = input?.['projectId'] === undefined ? null : boundedField(input['projectId'], 'projectId', 128)
  const supersedesSourceId = input?.['supersedesSourceId'] === undefined ? null : assertAuthorityUuid(input['supersedesSourceId'], 'supersedesSourceId')
  {
    const existing = db.prepare('SELECT id FROM migration_sources WHERE scope_kind = ? AND scope_id = ? AND source_kind = ? AND canonical_source_path = ? AND source_sha256 = ?')
      .get(scopeKind, scopeId, sourceKind, canonicalSourcePath, sourceSha256) as Row | undefined
    let sourceId: string
    let created: boolean
    if (existing) {
      sourceId = text(existing['id'])
      created = false
    } else {
      sourceId = randomUUID()
      db.prepare('INSERT INTO migration_sources(id, scope_kind, scope_id, project_id, source_kind, canonical_source_path, source_sha256, source_bytes, normalized_json, phase, supersedes_source_id, retired_path, fence_receipt_json, imported_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?)')
        .run(sourceId, scopeKind, scopeId, projectId, sourceKind, canonicalSourcePath, sourceSha256, sourceBytes, normalizedJson, phase, supersedesSourceId, nowIso())
      created = true
    }
    for (const mapping of mappings) {
      const entityKind = boundedField(mapping?.['entityKind'], 'entityKind', 128)
      const sourceEntityKey = boundedField(mapping?.['sourceEntityKey'], 'sourceEntityKey', 128)
      const authorityEntityId = boundedField(mapping?.['authorityEntityId'], 'authorityEntityId', 128)
      const sourceFingerprint = boundedField(mapping?.['sourceFingerprint'], 'sourceFingerprint', 128)
      const mappingState = mapping?.['state'] ?? 'active'
      if (mappingState !== 'active' && mappingState !== 'superseded' && mappingState !== 'retired') {
        throw new TaskAuthorityValidationError('entityMappings.state', 'must be a known mapping state')
      }
      db.prepare('INSERT INTO migration_entity_mappings(source_id, entity_kind, source_entity_key, authority_entity_id, source_fingerprint, state) VALUES (?,?,?,?,?,?) ON CONFLICT(source_id, entity_kind, source_entity_key) DO UPDATE SET authority_entity_id = excluded.authority_entity_id, source_fingerprint = excluded.source_fingerprint, state = excluded.state')
        .run(sourceId, entityKind, sourceEntityKey, authorityEntityId, sourceFingerprint, mappingState)
    }
    if (supersedesSourceId !== null) {
      db.prepare("UPDATE migration_sources SET phase = 'superseded' WHERE id = ? AND phase = 'imported'").run(supersedesSourceId)
      db.prepare("UPDATE migration_entity_mappings SET state = 'superseded' WHERE source_id = ? AND state = 'active'").run(supersedesSourceId)
    }
    return { sourceId, created }
  }
}

/** Terminal metadata compaction for a recorded source; native rows are untouched. */
export function retireMigrationSource(database: TaskAuthorityDatabase, sourceId: string, retiredPath: string): void {
  const retired = boundedField(retiredPath, 'retiredPath', 128)
  database.withImmediate(db => {
    const existing = db.prepare('SELECT id FROM migration_sources WHERE id = ?').get(assertAuthorityUuid(sourceId, 'sourceId')) as Row | undefined
    if (!existing) throw new TaskAuthorityError('TASK_NOT_FOUND', `migration source ${sourceId} was not found`)
    db.prepare("UPDATE migration_sources SET phase = 'retired', retired_path = ? WHERE id = ?").run(retired, sourceId)
    db.prepare("UPDATE migration_entity_mappings SET state = 'retired' WHERE source_id = ? AND state <> 'retired'").run(sourceId)
  })
}

// ---------------------------------------------------------------------------
// Migration-only legacy import surface (Task 3)
// ---------------------------------------------------------------------------

export type LegacyImportTask = Readonly<{
  /**
   * Owning project. Required for a profile-global snapshot, which maps entities
   * across projects; for a project-scoped snapshot it must equal the scope.
   */
  projectId?: string
  externalTaskId: string
  title: string
  body: string
  /** Explicit user/admin state. `blocked` is never invented from dependency readiness. */
  status: Extract<TaskStatus, 'todo' | 'blocked' | 'in-progress' | 'done' | 'failed' | 'cancelled'>
  priority: number
  dependencies: readonly string[]
}>

export type LegacyImportArtifact = Readonly<{
  path: string
  sha256: string
  bytes: number
  sourceFingerprint?: string
  relationship: ArtifactRelationship
}>

export type LegacyImportAttempt = Readonly<{
  attemptKey: string
  /** Owning project of the owning task; same rules as {@link LegacyImportTask.projectId}. */
  projectId?: string
  taskExternalTaskId: string
  state: Extract<AttemptState, 'cancelled' | 'exited' | 'completed' | 'failed'>
  specification: TaskExecutionSpecificationInput
  /** True when the source does not prove which mutable definition ran. */
  specificationLegacyUnknown?: boolean
  retryOfAttemptKey?: string
  sessionId?: string
  startedAt: string
  finishedAt?: string
  exitCode?: number
  error?: string
  output?: string
  artifacts?: readonly LegacyImportArtifact[]
}>

export type LegacyImportSchedule = Readonly<{
  scheduleKey: string
  projectId: string
  profileId: string
  taskTitle: string
  cadence: TaskScheduleCadence
  specification: TaskExecutionSpecificationInput
  enabled: boolean
  nextRunAt?: string | null
  createdAt: string
  updatedAt: string
}>

export type LegacyImportScheduleExecution = Readonly<{
  executionKey: string
  scheduleKey: string
  trigger: 'due' | 'manual'
  idempotencyKey: string
  dueAt?: string | null
  state: ScheduleExecutionState
  createdAt: string
  attemptKey?: string
}>

export type LegacyImportRunGroupMember = Readonly<{
  projectId: string
  taskExternalTaskId: string
  ordinal: number
  state: RunMemberState
  specification?: TaskExecutionSpecificationInput
  sourceAttemptKey?: string
}>

export type LegacyImportRunGroup = Readonly<{
  groupKey: string
  profileId: string
  name: string
  retryOfGroupKey?: string
  concurrency: number
  state: RunGroupState
  createdAt: string
  updatedAt: string
  members: readonly LegacyImportRunGroupMember[]
}>

export type LegacyImportEntitiesInput = Readonly<{
  scopeKind: 'project' | 'profile'
  scopeId: string
  tasks?: readonly LegacyImportTask[]
  attempts?: readonly LegacyImportAttempt[]
  schedules?: readonly LegacyImportSchedule[]
  scheduleExecutions?: readonly LegacyImportScheduleExecution[]
  runGroups?: readonly LegacyImportRunGroup[]
}>

/**
 * Stable authority entity id for one source-scoped legacy key.
 *
 * Derived from the scope, kind, and key alone — never from the source digest or
 * the wall clock — so a resumed or concurrent import re-derives exactly the
 * same IDs and a duplicate is rejected by the primary key instead of
 * duplicating rows.
 */
export function legacyEntityId(scopeKind: 'project' | 'profile', scopeId: string, kind: string, key: string): string {
  const hex = sha256(`${scopeKind}\u0000${scopeId}\u0000${kind}\u0000${key}`)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function legacyTaskStatus(value: unknown): LegacyImportTask['status'] {
  if (value === 'todo' || value === 'blocked' || value === 'in-progress' || value === 'done' || value === 'failed' || value === 'cancelled') return value
  throw new TaskAuthorityValidationError('tasks.status', 'must be a known importable legacy task status')
}

function legacyAttemptState(value: unknown): LegacyImportAttempt['state'] {
  if (value === 'cancelled' || value === 'exited' || value === 'completed' || value === 'failed') return value
  throw new TaskAuthorityValidationError('attempts.state', 'imported attempts must be terminal and lease-less')
}

function legacyExecutionState(value: unknown): ScheduleExecutionState {
  if (value === 'queued' || value === 'running' || value === 'cancelling' || value === 'cancelled' || value === 'succeeded' || value === 'failed') return value
  throw new TaskAuthorityValidationError('scheduleExecutions.state', 'must be a known schedule execution state')
}

function legacyGroupState(value: unknown): RunGroupState {
  if (value === 'active' || value === 'cancelling' || value === 'cancelled' || value === 'completed') return value
  throw new TaskAuthorityValidationError('runGroups.state', 'must be a known run group state')
}

function legacyMemberState(value: unknown): RunMemberState {
  if (value === 'queued' || value === 'claimed' || value === 'launching' || value === 'running' || value === 'cancelling' || value === 'cancelled' || value === 'completed' || value === 'failed' || value === 'quarantined') return value
  throw new TaskAuthorityValidationError('runGroups.members.state', 'must be a known run member state')
}

function importArtifactRelationship(value: unknown): ArtifactRelationship {
  if (value === 'attached-reference' || value === 'observed-during-run') return value
  throw new TaskAuthorityValidationError('artifacts.relationship', 'must be a known artifact relationship')
}

function parseImportCadence(value: unknown): TaskScheduleCadence {
  if (typeof value !== 'object' || value === null) throw new TaskAuthorityValidationError('schedules.cadence', 'must be an object')
  const record = value as Record<string, unknown>
  if (record['kind'] === 'interval') {
    const minutes = record['minutes']
    if (typeof minutes !== 'number' || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 60 * 24 * 31) {
      throw new TaskAuthorityValidationError('schedules.cadence.minutes', 'must be an integer number of minutes')
    }
    return { kind: 'interval', minutes }
  }
  if (record['kind'] === 'daily') {
    const time = record['time']
    const timeZone = record['timeZone']
    if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new TaskAuthorityValidationError('schedules.cadence.time', 'must be HH:MM')
    if (typeof timeZone !== 'string' || timeZone.length === 0) throw new TaskAuthorityValidationError('schedules.cadence.timeZone', 'must be an IANA time zone name')
    return { kind: 'daily', time, timeZone }
  }
  throw new TaskAuthorityValidationError('schedules.cadence.kind', 'must be "interval" or "daily"')
}

/**
 * Writes the imported-legacy entities of one recorded source snapshot.
 *
 * Every row is lease-less and provenance-marked. The importer never invents an
 * owner, a lease, a generation, a live claim, or a mutable schedule
 * definition: an imported execution carries either the execution-time
 * specification the source proves or a `legacy-unknown` specification that no
 * native completion or adoption path can consume without explicit review.
 *
 * Only `imported-legacy` rows are written or replaced here, so a rebuild can
 * never mutate a native post-cutover row. The whole write is one
 * `BEGIN IMMEDIATE`, so an interruption leaves no partial import.
 */
export function importLegacyEntities(database: TaskAuthorityDatabase, input: LegacyImportEntitiesInput): Record<string, string> {
  return database.withImmediate(db => importLegacyEntitiesIn(db, input))
}

/**
 * Transaction-internal form of {@link importLegacyEntities}.
 *
 * Callers that must commit the source record and its entity mappings together
 * use this inside their own `BEGIN IMMEDIATE`; the migration does exactly that,
 * so an interrupted import leaves no entity without its provenance row.
 */
export function importLegacyEntitiesIn(db: DatabaseSync, input: LegacyImportEntitiesInput): Record<string, string> {
  assertKnownFields(input, 'input', ['scopeKind', 'scopeId', 'tasks', 'attempts', 'schedules', 'scheduleExecutions', 'runGroups'])
  const scopeKind = input?.scopeKind
  if (scopeKind !== 'project' && scopeKind !== 'profile') {
    throw new TaskAuthorityValidationError('scopeKind', 'must be "project" or "profile"')
  }
  const scopeId = boundedField(input?.['scopeId'], 'scopeId', 128)
  const taskInputs = (input?.tasks ?? []).map(task => ({
    projectId: task?.projectId,
    externalTaskId: boundedField(task?.externalTaskId, 'tasks.externalTaskId', 128),
    title: boundedText(task?.title, 'tasks.title', TASK_AUTHORITY_MAX_TITLE, false),
    body: boundedText(task?.body ?? '', 'tasks.body', TASK_AUTHORITY_MAX_USER_TEXT),
    status: legacyTaskStatus(task?.status),
    priority: typeof task?.priority === 'number' && Number.isSafeInteger(task.priority) && task.priority >= 0 ? task.priority : 0,
    dependencies: (task?.dependencies ?? []).map(dependency => boundedField(dependency, 'tasks.dependencies', 128))
  }))
  const attemptInputs = (input?.attempts ?? []).map(attempt => ({
    attemptKey: boundedField(attempt?.attemptKey, 'attempts.attemptKey', 128),
    projectId: attempt?.projectId,
    taskExternalTaskId: boundedField(attempt?.taskExternalTaskId, 'attempts.taskExternalTaskId', 128),
    state: legacyAttemptState(attempt?.state),
    specification: parseTaskExecutionSpecification(attempt?.specification, 'attempts.specification'),
    specificationLegacyUnknown: attempt?.specificationLegacyUnknown === true,
    retryOfAttemptKey: attempt?.retryOfAttemptKey === undefined ? null : boundedField(attempt.retryOfAttemptKey, 'attempts.retryOfAttemptKey', 128),
    sessionId: attempt?.sessionId === undefined ? null : boundedField(attempt.sessionId, 'attempts.sessionId', 128),
    startedAt: isoTimestamp(attempt?.startedAt, 'attempts.startedAt'),
    finishedAt: attempt?.finishedAt === undefined ? null : isoTimestamp(attempt.finishedAt, 'attempts.finishedAt'),
    exitCode: typeof attempt?.exitCode === 'number' && Number.isSafeInteger(attempt.exitCode) ? attempt.exitCode : null,
    error: attempt?.error === undefined ? null : boundedText(attempt.error, 'attempts.error', TASK_AUTHORITY_MAX_ERROR_TEXT),
    output: attempt?.output === undefined ? null : boundedText(attempt.output, 'attempts.output', TASK_AUTHORITY_MAX_USER_TEXT),
    artifacts: (attempt?.artifacts ?? []).map(artifact => ({
      path: boundedField(artifact?.path, 'attempts.artifacts.path', 128),
      sha256: boundedField(artifact?.sha256, 'attempts.artifacts.sha256', 64),
      bytes: typeof artifact?.bytes === 'number' && Number.isSafeInteger(artifact.bytes) && artifact.bytes >= 0 ? artifact.bytes : 0,
      sourceFingerprint: artifact?.sourceFingerprint === undefined ? null : boundedField(artifact.sourceFingerprint, 'attempts.artifacts.sourceFingerprint', 128),
      relationship: importArtifactRelationship(artifact?.relationship)
    }))
  }))
  const scheduleInputs = (input?.schedules ?? []).map(schedule => ({
    scheduleKey: boundedField(schedule?.scheduleKey, 'schedules.scheduleKey', 128),
    projectId: boundedField(schedule?.projectId, 'schedules.projectId', 128),
    profileId: boundedField(schedule?.profileId, 'schedules.profileId', 128),
    taskTitle: boundedText(schedule?.taskTitle, 'schedules.taskTitle', TASK_AUTHORITY_MAX_TITLE, false),
    cadence: parseImportCadence(schedule?.cadence),
    specification: parseTaskExecutionSpecification(schedule?.specification, 'schedules.specification'),
    enabled: schedule?.enabled !== false,
    nextRunAt: schedule?.nextRunAt === undefined || schedule.nextRunAt === null ? null : isoTimestamp(schedule.nextRunAt, 'schedules.nextRunAt'),
    createdAt: isoTimestamp(schedule?.createdAt, 'schedules.createdAt'),
    updatedAt: isoTimestamp(schedule?.updatedAt, 'schedules.updatedAt')
  }))
  const executionInputs = (input?.scheduleExecutions ?? []).map(execution => ({
    executionKey: boundedField(execution?.executionKey, 'scheduleExecutions.executionKey', 128),
    scheduleKey: boundedField(execution?.scheduleKey, 'scheduleExecutions.scheduleKey', 128),
    trigger: execution?.trigger === 'manual' ? 'manual' as const : 'due' as const,
    idempotencyKey: boundedField(execution?.idempotencyKey, 'scheduleExecutions.idempotencyKey', 128),
    dueAt: execution?.dueAt === undefined || execution.dueAt === null ? null : isoTimestamp(execution.dueAt, 'scheduleExecutions.dueAt'),
    state: legacyExecutionState(execution?.state),
    createdAt: isoTimestamp(execution?.createdAt, 'scheduleExecutions.createdAt'),
    attemptKey: execution?.attemptKey === undefined ? null : boundedField(execution.attemptKey, 'scheduleExecutions.attemptKey', 128)
  }))
  const groupInputs = (input?.runGroups ?? []).map(group => ({
    groupKey: boundedField(group?.groupKey, 'runGroups.groupKey', 128),
    profileId: boundedField(group?.profileId, 'runGroups.profileId', 128),
    name: boundedText(group?.name, 'runGroups.name', TASK_AUTHORITY_MAX_TITLE, false),
    retryOfGroupKey: group?.retryOfGroupKey === undefined ? null : boundedField(group.retryOfGroupKey, 'runGroups.retryOfGroupKey', 128),
    concurrency: typeof group?.concurrency === 'number' && Number.isSafeInteger(group.concurrency) && group.concurrency >= 1 && group.concurrency <= MAX_PARALLELISM ? group.concurrency : 1,
    state: legacyGroupState(group?.state),
    createdAt: isoTimestamp(group?.createdAt, 'runGroups.createdAt'),
    updatedAt: isoTimestamp(group?.updatedAt, 'runGroups.updatedAt'),
    members: (group?.members ?? []).map(member => ({
      projectId: boundedField(member?.projectId, 'runGroups.members.projectId', 128),
      taskExternalTaskId: boundedField(member?.taskExternalTaskId, 'runGroups.members.taskExternalTaskId', 128),
      ordinal: typeof member?.ordinal === 'number' && Number.isSafeInteger(member.ordinal) && member.ordinal >= 0 ? member.ordinal : 0,
      state: legacyMemberState(member?.state),
      specification: member?.specification === undefined ? undefined : parseTaskExecutionSpecification(member.specification, 'runGroups.members.specification'),
      sourceAttemptKey: member?.sourceAttemptKey === undefined ? null : boundedField(member.sourceAttemptKey, 'runGroups.members.sourceAttemptKey', 128)
    }))
  }))

  {
    const entities: Record<string, string> = {}
    // A project-scoped snapshot owns exactly one project. A profile-global
    // snapshot maps entities across projects, so each entity names its own
    // project and is never duplicated per project.
    const projectFor = (candidate: string | undefined, field: string): string => {
      if (scopeKind === 'project') {
        if (candidate !== undefined && candidate !== scopeId) {
          throw new TaskAuthorityValidationError(field, 'must equal the project scope of this snapshot')
        }
        return scopeId
      }
      return boundedField(candidate, field, 128)
    }

    for (const task of taskInputs) {
      const projectId = projectFor(task.projectId, 'tasks.projectId')
      const taskId = legacyEntityId(scopeKind, scopeId, 'task', task.externalTaskId)
      const existing = db.prepare('SELECT provenance_kind FROM tasks WHERE project_id = ? AND id = ?').get(projectId, taskId) as Row | undefined
      ensureProject(db, projectId, undefined, undefined)
      if (existing && text(existing['provenance_kind']) !== 'imported-legacy') {
        throw new TaskAuthorityError('MIGRATION_REQUIRED', `import would overwrite native task ${taskId}`)
      }
      if (existing) {
        db.prepare("UPDATE tasks SET title = ?, body = ?, status = ?, priority = ?, updated_at = ? WHERE project_id = ? AND id = ? AND provenance_kind = 'imported-legacy' AND (title <> ? OR body <> ? OR status <> ? OR priority <> ?)")
          .run(task.title, task.body, task.status, task.priority, nowIso(), projectId, taskId, task.title, task.body, task.status, task.priority)
      } else {
        db.prepare("INSERT INTO tasks(id, project_id, external_task_id, external_task_id_canonical, title, body, status, priority, current_attempt_id, cancel_state, entity_version, created_at, updated_at, provenance_kind) VALUES (?,?,?,?,?,?,?,?,NULL,'none',1,?,?,'imported-legacy')")
          .run(taskId, projectId, task.externalTaskId, canonicalExternalTaskId(task.externalTaskId), task.title, task.body, task.status, task.priority, nowIso(), nowIso())
      }
      // Dependencies are rewritten from the exact snapshot, so an edge the
      // source no longer carries does not linger from the prior import.
      db.prepare('DELETE FROM task_dependencies WHERE project_id = ? AND task_id = ?').run(projectId, taskId)
      for (const dependency of task.dependencies) {
        db.prepare('INSERT INTO task_dependencies(project_id, task_id, depends_on_task_id) VALUES (?,?,?) ON CONFLICT DO NOTHING')
          .run(projectId, taskId, legacyEntityId(scopeKind, scopeId, 'task', dependency))
      }
      entities[`task:${task.externalTaskId}`] = taskId
    }

    for (const attempt of attemptInputs) {
      const projectId = projectFor(attempt.projectId, 'attempts.projectId')
      const taskId = legacyEntityId(scopeKind, scopeId, 'task', attempt.taskExternalTaskId)
      const attemptId = legacyEntityId(scopeKind, scopeId, 'attempt', attempt.attemptKey)
      entities[`attempt:${attempt.attemptKey}`] = attemptId
      if (db.prepare('SELECT id FROM attempts WHERE project_id = ? AND id = ?').get(projectId, attemptId)) continue
      const specificationId = legacyEntityId(scopeKind, scopeId, 'specification', attempt.attemptKey)
      const specificationJson = JSON.stringify(attempt.specification)
      db.prepare('INSERT INTO execution_specifications(id, project_id, task_id, command_json, target_json, verification_json, source_sha256, provenance_kind, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(specificationId, projectId, taskId, JSON.stringify(attempt.specification.command), JSON.stringify(attempt.specification.target), JSON.stringify(attempt.specification.verification),
          attempt.specificationLegacyUnknown ? 'legacy-unknown' : sha256(specificationJson),
          attempt.specificationLegacyUnknown ? 'legacy-unknown' : 'native', attempt.startedAt)
      const sequence = int((db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS seq FROM attempts WHERE project_id = ? AND task_id = ?').get(projectId, taskId) as Row)['seq'])
      db.prepare("INSERT INTO attempts(id, project_id, task_id, sequence, retry_of_attempt_id, provenance_kind, state, specification_id, current_lease_id, started_at, finished_at) VALUES (?,?,?,?,?,'imported-legacy',?,?,NULL,?,?)")
        .run(attemptId, projectId, taskId, sequence,
          attempt.retryOfAttemptKey === null ? null : legacyEntityId(scopeKind, scopeId, 'attempt', attempt.retryOfAttemptKey),
          attempt.state, specificationId, attempt.startedAt, attempt.finishedAt)
      appendTaskEvent(db, projectId, taskId, attemptId, 'legacy-attempt-imported', 1, {
        specificationLegacyUnknown: attempt.specificationLegacyUnknown,
        sessionId: attempt.sessionId, exitCode: attempt.exitCode, error: attempt.error, output: attempt.output
      })
      for (const artifact of attempt.artifacts) {
        const artifactId = legacyEntityId(scopeKind, scopeId, 'artifact', `${attempt.attemptKey}\u0000${artifact.path}`)
        entities[`artifact:${attempt.attemptKey}:${artifact.path}`] = artifactId
        if (db.prepare('SELECT id FROM verification_artifacts WHERE project_id = ? AND id = ?').get(projectId, artifactId)) continue
        db.prepare("INSERT INTO verification_artifacts(id, project_id, task_id, attempt_id, lease_id, generation, provenance_kind, path, sha256, bytes, source_fingerprint, relationship, attached_at) VALUES (?,?,?,?,NULL,NULL,'imported-legacy',?,?,?,?,?,?)")
          .run(artifactId, projectId, taskId, attemptId, artifact.path, artifact.sha256, artifact.bytes, artifact.sourceFingerprint, artifact.relationship, attempt.finishedAt ?? attempt.startedAt)
      }
    }

    for (const schedule of scheduleInputs) {
      const scheduleId = legacyEntityId(scopeKind, scopeId, 'schedule', schedule.scheduleKey)
      entities[`schedule:${schedule.scheduleKey}`] = scheduleId
      ensureProject(db, schedule.projectId, undefined, undefined)
      const definitionJson = scheduleDefinitionJson({
        profileId: schedule.profileId,
        taskTitle: schedule.taskTitle,
        cadence: schedule.cadence,
        command: schedule.specification.command,
        target: schedule.specification.target,
        verification: schedule.specification.verification
      })
      const existing = db.prepare('SELECT id FROM schedules WHERE project_id = ? AND id = ?').get(schedule.projectId, scheduleId) as Row | undefined
      if (existing) {
        // A definition that already matches the frozen snapshot is untouched:
        // replaying an import must not churn the entity version.
        db.prepare('UPDATE schedules SET definition_json = ?, enabled = ?, next_run_at = ?, entity_version = entity_version + 1, updated_at = ? WHERE project_id = ? AND id = ? AND definition_json <> ?')
          .run(definitionJson, schedule.enabled ? 1 : 0, schedule.nextRunAt, schedule.updatedAt, schedule.projectId, scheduleId, definitionJson)
      } else {
        db.prepare('INSERT INTO schedules(id, project_id, definition_json, enabled, entity_version, next_run_at, created_at, updated_at) VALUES (?,?,?,?,1,?,?,?)')
          .run(scheduleId, schedule.projectId, definitionJson, schedule.enabled ? 1 : 0, schedule.nextRunAt, schedule.createdAt, schedule.updatedAt)
      }
      appendProfileEvent(db, schedule.profileId, null, 'legacy-schedule-imported', 1, { projectId: schedule.projectId, scheduleId, scheduleKey: schedule.scheduleKey })
    }

    for (const execution of executionInputs) {
      const executionId = legacyEntityId(scopeKind, scopeId, 'execution', execution.executionKey)
      const scheduleId = legacyEntityId(scopeKind, scopeId, 'schedule', execution.scheduleKey)
      entities[`execution:${execution.executionKey}`] = executionId
      const scheduleRow = db.prepare('SELECT project_id, definition_json FROM schedules WHERE id = ?').get(scheduleId) as Row | undefined
      if (scheduleRow === undefined) {
        throw new TaskAuthorityValidationError('scheduleExecutions.scheduleKey', `schedule ${execution.scheduleKey} was not part of this snapshot`)
      }
      const ownerProject = text(scheduleRow['project_id'])
      if (db.prepare('SELECT id FROM schedule_executions WHERE project_id = ? AND id = ?').get(ownerProject, executionId)) continue
      // A historical execution does not prove which mutable definition ran, so
      // its materialized task carries a provenance-marked legacy-unknown
      // specification rather than the current definition.
      const taskId = legacyEntityId(scopeKind, scopeId, 'execution-task', execution.executionKey)
      const spec = readScheduleSpec(text(scheduleRow['definition_json']))
      db.prepare("INSERT INTO tasks(id, project_id, external_task_id, external_task_id_canonical, title, body, status, priority, current_attempt_id, cancel_state, entity_version, created_at, updated_at, provenance_kind) VALUES (?,?,?,?,?,'','todo',0,NULL,'none',1,?,?,'imported-legacy')")
        .run(taskId, ownerProject, `${execution.executionKey}:legacy`, canonicalExternalTaskId(`${execution.executionKey}:legacy`), spec.taskTitle, execution.createdAt, execution.createdAt)
      const specificationId = legacyEntityId(scopeKind, scopeId, 'execution-specification', execution.executionKey)
      db.prepare("INSERT INTO execution_specifications(id, project_id, task_id, command_json, target_json, verification_json, source_sha256, provenance_kind, created_at) VALUES (?,?,?,?,?,?,?,'legacy-unknown',?)")
        .run(specificationId, ownerProject, taskId, JSON.stringify(spec.command), JSON.stringify(spec.target), JSON.stringify(spec.verification), 'legacy-unknown', execution.createdAt)
      const attemptId = execution.attemptKey === null ? null : legacyEntityId(scopeKind, scopeId, 'attempt', execution.attemptKey)
      db.prepare('INSERT INTO schedule_executions(id, project_id, schedule_id, trigger, idempotency_key, intent_sha256, task_id, attempt_id, due_at, state, entity_version, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?)')
        .run(executionId, ownerProject, scheduleId, execution.trigger, execution.idempotencyKey, sha256(`${execution.scheduleKey}\u0000${execution.trigger}\u0000${execution.idempotencyKey}`), taskId, attemptId, execution.dueAt, execution.state, execution.createdAt)
      appendTaskEvent(db, ownerProject, taskId, attemptId, 'legacy-execution-imported', 1, { scheduleId, executionId, trigger: execution.trigger, dueAt: execution.dueAt })
    }

    for (const group of groupInputs) {
      const groupId = legacyEntityId(scopeKind, scopeId, 'run-group', group.groupKey)
      entities[`run-group:${group.groupKey}`] = groupId
      const existing = db.prepare('SELECT id FROM run_groups WHERE id = ?').get(groupId) as Row | undefined
      if (existing) {
        db.prepare('UPDATE run_groups SET name = ?, concurrency = ?, state = ?, updated_at = ? WHERE id = ? AND (name <> ? OR concurrency <> ? OR state <> ?)')
          .run(group.name, group.concurrency, group.state, group.updatedAt, groupId, group.name, group.concurrency, group.state)
      } else {
        db.prepare('INSERT INTO run_groups(id, profile_id, name, retry_of_run_group_id, concurrency, state, entity_version, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?)')
          .run(groupId, group.profileId, group.name,
            group.retryOfGroupKey === null ? null : legacyEntityId(scopeKind, scopeId, 'run-group', group.retryOfGroupKey),
            group.concurrency, group.state, group.createdAt, group.updatedAt)
      }
      for (const member of group.members) {
        // Membership is project-scoped: the member names both its project and
        // its task, and the pair must already exist in this snapshot.
        const memberTask = db.prepare('SELECT id FROM tasks WHERE project_id = ? AND id = ?')
          .get(member.projectId, legacyEntityId(scopeKind, scopeId, 'task', member.taskExternalTaskId)) as Row | undefined
        if (memberTask === undefined) {
          throw new TaskAuthorityValidationError('runGroups.members.taskExternalTaskId', `member task ${member.taskExternalTaskId} was not part of this snapshot in project ${member.projectId}`)
        }
        const taskId = text(memberTask['id'])
        db.prepare('INSERT INTO run_members(run_group_id, project_id, task_id, source_attempt_id, ordinal, state, specification_json) VALUES (?,?,?,?,?,?,?) ON CONFLICT(run_group_id, project_id, task_id) DO UPDATE SET source_attempt_id = excluded.source_attempt_id, ordinal = excluded.ordinal, state = excluded.state, specification_json = excluded.specification_json')
          .run(groupId, member.projectId, taskId,
            member.sourceAttemptKey === null ? null : legacyEntityId(scopeKind, scopeId, 'attempt', member.sourceAttemptKey),
            member.ordinal, member.state, member.specification === undefined ? null : JSON.stringify(member.specification))
      }
    }

    return entities
  }
}
