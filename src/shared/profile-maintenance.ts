import { createHash } from 'node:crypto'

/**
 * Stage-neutral durable profile maintenance contract.
 *
 * One profile-wide migration lease serializes every authority cutover
 * (Task Authority in Stage 2, Provider Catalog in Stage 3, Derived Knowledge
 * in Stage 4, Local Model Runtime / project tools in Stage 5). Every affected
 * operation registers a durable admission before authority work and closes or
 * reconciles it exactly once.
 *
 * Principal identity is constructed by the daemon handshake. Nothing in this
 * module decodes a participant, owner stage, or connection identity from
 * request JSON: callers receive `Authenticated*Context` values from the daemon
 * and cannot author them.
 */

export const PROFILE_MAINTENANCE_MAX_IDENTIFIER = 128
export const PROFILE_MAINTENANCE_MAX_BATCH = 100
export const PROFILE_MAINTENANCE_MAX_PATH = 4096

export const PROFILE_MAINTENANCE_PARTICIPANTS = [
  'task-authority',
  'provider-authority',
  'derived-knowledge',
  'project-tools',
  'local-model-runtime'
] as const

export const PROFILE_MAINTENANCE_STAGES = ['stage-2', 'stage-3', 'stage-4', 'stage-5'] as const

export const PROFILE_MAINTENANCE_PHASES = ['open', 'freezing', 'draining', 'cutting-over', 'failed'] as const

/**
 * Reserved migration id for admissions recorded while no migration lease
 * exists. `acquire` adopts every outstanding pre-migration admission into the
 * new migration so the drain step reconciles exactly the work that was live
 * when the lease was taken.
 */
export const PROFILE_MAINTENANCE_UNMIGRATED = 'unmigrated'

export type ProfileMaintenanceParticipant = (typeof PROFILE_MAINTENANCE_PARTICIPANTS)[number]
export type ProfileMaintenancePhase = (typeof PROFILE_MAINTENANCE_PHASES)[number]
export type ProfileMaintenanceOwnerStage = (typeof PROFILE_MAINTENANCE_STAGES)[number]
export type ProfileMaintenanceAdmissionState = 'active' | 'completed' | 'cancelled' | 'indeterminate'
export type ProfileMaintenanceReceiptState = 'prepared' | 'completed'
export type ProfileMaintenanceExternalVisibility = 'not-required' | 'pending' | 'acknowledged'
export type ProfileMaintenanceVisibilityMode = 'central' | 'external-wal'

export type ProfileMaintenanceAdmission = Readonly<{
  participant: ProfileMaintenanceParticipant
  operationId: string
  epoch: number
  ownerConnectionId: string
}>

export type ProfileMaintenanceLease = Readonly<{
  migrationId: string
  ownerStage: ProfileMaintenanceOwnerStage
  epoch: number
  revision: number
}>

export type AuthenticatedProfileMaintenanceParticipantContext = Readonly<{
  connectionId: string
  participant: ProfileMaintenanceParticipant
}>

export type AuthenticatedProfileMaintenanceMigrationContext = Readonly<{
  connectionId: string
  ownerStage: ProfileMaintenanceOwnerStage
}>

/**
 * Authenticated connection context for ordinary affected work.
 *
 * `participant` is present only when the daemon authenticated the connection
 * for one authority participant; the gate then refuses any other participant
 * name. Daemon-internal admissions (the daemon itself performing the work)
 * carry no participant binding, so the daemon — never a serialized request —
 * names the participant.
 */
export type AuthenticatedCallerContext = Readonly<{
  connectionId: string
  participant?: ProfileMaintenanceParticipant
}>

export type AuthenticatedAdministratorContext = Readonly<{
  connectionId: string
  /** Migration-owner stage the daemon authenticated this coordinator for, when the connection is a migration coordinator. */
  ownerStage?: ProfileMaintenanceOwnerStage
}>

export type ProfileMaintenanceTransitionIntent = Readonly<{
  participant: ProfileMaintenanceParticipant
  operationId: string
  sourceSha256: string
  intentSha256: string
  visibilityMode: ProfileMaintenanceVisibilityMode
}>

export type ProfileMaintenanceTransitionReceipt = Readonly<{
  id: string
  migrationId: string
  ownerStage: ProfileMaintenanceOwnerStage
  epoch: number
  participant: ProfileMaintenanceParticipant
  operationId: string
  sourceSha256: string
  intentSha256: string
  visibilityMode: ProfileMaintenanceVisibilityMode
  state: ProfileMaintenanceReceiptState
  externalVisibility: ProfileMaintenanceExternalVisibility
  localVisibleRevision: string | null
  localVisibleEvidenceSha256: string | null
  revision: number
}>

export type ProfileMaintenanceAdmissionObservation = Readonly<{
  operationId: string
  epoch: number
  outcome: 'completed' | 'cancelled' | 'active' | 'indeterminate'
  evidenceSha256: string
}>

export type ProfileMaintenanceFailure = Readonly<{ code: string; evidenceSha256: string }>
export type ProfileMaintenanceResumeInput = Readonly<{
  migrationId: string
  expectedRevision: number
  expectedSourceSetSha256: string
}>
export type ProfileMaintenanceAbortInput = Readonly<{
  migrationId: string
  expectedRevision: number
  observedSourceSetSha256: string
}>

/** Durable retirement/fence receipt: publishing one makes rollback irreversible. */
export type ProfileMaintenanceFenceReceipt = Readonly<{
  id: string
  migrationId: string
  ownerStage: ProfileMaintenanceOwnerStage
  epoch: number
  participant: ProfileMaintenanceParticipant
  retiredPath: string
  fenceReceiptSha256: string
  fsynced: boolean
}>

/** Persisted gate state read by startup before any affected handler is registered. */
export type ProfileMaintenanceState = Readonly<{
  phase: ProfileMaintenancePhase
  lease: ProfileMaintenanceLease | null
  /** Persisted profile revision; every durable transition bumps it. Used as the optimistic precondition for admin intents. */
  revision: number
  participants: readonly ProfileMaintenanceParticipant[]
  frozenSourceSetSha256: string | null
  safePhase: ProfileMaintenancePhase | null
  irreversible: boolean
  failureCode: string | null
}>

export interface ProfileMaintenanceGate {
  admit(context: AuthenticatedCallerContext, participant: ProfileMaintenanceParticipant, operationId: string): Promise<ProfileMaintenanceAdmission>
  complete(context: AuthenticatedCallerContext, admission: ProfileMaintenanceAdmission, outcome: 'completed' | 'cancelled' | 'indeterminate'): Promise<void>
  listOwnedAdmissions(context: AuthenticatedProfileMaintenanceParticipantContext, migrationId: string): Promise<ProfileMaintenanceAdmission[]>
  reconcileOwnedAdmissions(context: AuthenticatedProfileMaintenanceParticipantContext, migrationId: string, observations: ProfileMaintenanceAdmissionObservation[]): Promise<void>
  acquire(context: AuthenticatedAdministratorContext, input: { migrationId: string; ownerStage: ProfileMaintenanceOwnerStage; participants: ProfileMaintenanceParticipant[]; expectedRevision: number }): Promise<ProfileMaintenanceLease>
  freeze(context: AuthenticatedAdministratorContext, lease: ProfileMaintenanceLease): Promise<void>
  acknowledgeDrained(context: AuthenticatedProfileMaintenanceParticipantContext, migrationId: string): Promise<void>
  beginCutover(context: AuthenticatedAdministratorContext, lease: ProfileMaintenanceLease): Promise<void>
  prepareMigrationTransition(context: AuthenticatedProfileMaintenanceMigrationContext, lease: ProfileMaintenanceLease, intent: ProfileMaintenanceTransitionIntent): Promise<ProfileMaintenanceTransitionReceipt>
  completeMigrationTransition(context: AuthenticatedProfileMaintenanceMigrationContext, receipt: ProfileMaintenanceTransitionReceipt, evidenceSha256: string): Promise<ProfileMaintenanceTransitionReceipt>
  acknowledgeExternalVisibility(context: AuthenticatedProfileMaintenanceMigrationContext, receipt: ProfileMaintenanceTransitionReceipt, input: { expectedRevision: number; localVisibleRevision: string; localVisibleEvidenceSha256: string }): Promise<ProfileMaintenanceTransitionReceipt>
  listMigrationTransitions(context: AuthenticatedProfileMaintenanceMigrationContext, lease: ProfileMaintenanceLease): Promise<ProfileMaintenanceTransitionReceipt[]>
  fail(context: AuthenticatedAdministratorContext, lease: ProfileMaintenanceLease, failure: ProfileMaintenanceFailure): Promise<ProfileMaintenanceLease>
  resume(context: AuthenticatedAdministratorContext, input: ProfileMaintenanceResumeInput): Promise<ProfileMaintenanceLease>
  abort(context: AuthenticatedAdministratorContext, input: ProfileMaintenanceAbortInput): Promise<void>
  release(context: AuthenticatedAdministratorContext, lease: ProfileMaintenanceLease, outcome: 'active'): Promise<void>
}

/**
 * Daemon-internal gate surface. Not exposed to renderer, CLI, plugin, or
 * worker request decoders: startup needs persisted phase resolution,
 * disconnect bookkeeping, and the retirement/fence receipt that decides
 * whether rollback is still possible.
 */
export interface ProfileMaintenanceGateInternal extends ProfileMaintenanceGate {
  /** Persisted phase/lease/participant facts; read before registering any affected handler. */
  readState(): ProfileMaintenanceState
  /**
   * Marks every live admission owned by the disconnected authenticated
   * connection indeterminate. Only the daemon calls this, on socket close.
   */
  markConnectionDisconnected(connectionId: string): Promise<void>
  /** Publishes the durable retirement/fence receipt that makes rollback irreversible. */
  recordRetirementFence(context: AuthenticatedProfileMaintenanceMigrationContext, lease: ProfileMaintenanceLease, input: { participant: ProfileMaintenanceParticipant; retiredPath: string; fenceReceiptSha256: string; fsynced: boolean }): Promise<ProfileMaintenanceFenceReceipt>
  listRetirementFences(lease: { migrationId: string }): Promise<ProfileMaintenanceFenceReceipt[]>
}

export class ProfileMaintenanceError extends Error {
  readonly code:
    | 'GATE_NOT_OPEN'
    | 'GATE_LEASED'
    | 'GATE_NOT_LEASED'
    | 'GATE_PHASE_INVALID'
    | 'GATE_FAILED'
    | 'GATE_IRREVERSIBLE'
    | 'GATE_STALE'
    | 'GATE_CONFLICT'
    | 'GATE_ADMISSION_UNRESOLVED'
    | 'GATE_PARTICIPANT_MISMATCH'
    | 'GATE_STAGE_UNAUTHORIZED'
    | 'GATE_SOURCE_SET_MISMATCH'
    | 'GATE_TRANSITION_INCOMPLETE'
    | 'GATE_VISIBILITY_PENDING'
    | 'AUTHORIZATION_DENIED'

  constructor(code: ProfileMaintenanceError['code'], message: string) {
    super(message)
    this.name = 'ProfileMaintenanceError'
    this.code = code
  }
}

/** Bounded-input validation failure; distinct from durable-state fencing errors. */
export class ProfileMaintenanceValidationError extends Error {
  constructor(readonly field: string, message: string) {
    super(`${field}: ${message}`)
    this.name = 'ProfileMaintenanceValidationError'
    this.field = field
  }
}

function boundedIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > PROFILE_MAINTENANCE_MAX_IDENTIFIER || value.includes('\0')) {
    throw new ProfileMaintenanceValidationError(field, `must be a non-empty string of at most ${PROFILE_MAINTENANCE_MAX_IDENTIFIER} characters`)
  }
  return value
}

function boundedPath(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > PROFILE_MAINTENANCE_MAX_PATH || value.includes('\0')) {
    throw new ProfileMaintenanceValidationError(field, `must be a non-empty path of at most ${PROFILE_MAINTENANCE_MAX_PATH} characters`)
  }
  return value
}

function digest(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new ProfileMaintenanceValidationError(field, 'must be a lowercase hex sha256 digest')
  }
  return value
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new ProfileMaintenanceValidationError(field, 'must be a positive integer')
  }
  return value
}

function exactKeys(value: unknown, field: string, allowed: readonly string[]): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProfileMaintenanceValidationError(field, 'must be an object')
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new ProfileMaintenanceValidationError(field, `unknown key "${key}"`)
  }
}

export function isProfileMaintenanceParticipant(value: unknown): value is ProfileMaintenanceParticipant {
  return typeof value === 'string' && (PROFILE_MAINTENANCE_PARTICIPANTS as readonly string[]).includes(value)
}

export function isProfileMaintenanceOwnerStage(value: unknown): value is ProfileMaintenanceOwnerStage {
  return typeof value === 'string' && (PROFILE_MAINTENANCE_STAGES as readonly string[]).includes(value)
}

export function parseProfileMaintenanceParticipant(value: unknown, field = 'participant'): ProfileMaintenanceParticipant {
  if (!isProfileMaintenanceParticipant(value)) {
    throw new ProfileMaintenanceValidationError(field, `must be one of ${PROFILE_MAINTENANCE_PARTICIPANTS.join(', ')}`)
  }
  return value
}

export function parseProfileMaintenanceOwnerStage(value: unknown, field = 'ownerStage'): ProfileMaintenanceOwnerStage {
  if (!isProfileMaintenanceOwnerStage(value)) {
    throw new ProfileMaintenanceValidationError(field, `must be one of ${PROFILE_MAINTENANCE_STAGES.join(', ')}`)
  }
  return value
}

/** Exact, duplicate-free participant set; the empty set is not a migration. */
export function parseProfileMaintenanceParticipantSet(value: unknown, field = 'participants'): ProfileMaintenanceParticipant[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > PROFILE_MAINTENANCE_PARTICIPANTS.length) {
    throw new ProfileMaintenanceValidationError(field, `must be an array of 1 to ${PROFILE_MAINTENANCE_PARTICIPANTS.length} participants`)
  }
  const participants = value.map((entry, index) => parseProfileMaintenanceParticipant(entry, `${field}[${index}]`))
  const seen = new Set<string>()
  for (const participant of participants) {
    if (seen.has(participant)) throw new ProfileMaintenanceValidationError(field, `duplicates participant "${participant}"`)
    seen.add(participant)
  }
  return participants
}

export function parseAuthenticatedCallerContext(value: unknown, field = 'context'): AuthenticatedCallerContext {
  exactKeys(value, field, ['connectionId', 'participant'])
  const record = value as Record<string, unknown>
  const connectionId = boundedIdentifier(record['connectionId'], `${field}.connectionId`)
  if (record['participant'] === undefined) return { connectionId }
  return { connectionId, participant: parseProfileMaintenanceParticipant(record['participant'], `${field}.participant`) }
}

export function parseAuthenticatedAdministratorContext(value: unknown, field = 'context'): AuthenticatedAdministratorContext {
  exactKeys(value, field, ['connectionId', 'ownerStage'])
  const record = value as Record<string, unknown>
  const connectionId = boundedIdentifier(record['connectionId'], `${field}.connectionId`)
  if (record['ownerStage'] === undefined) return { connectionId }
  return { connectionId, ownerStage: parseProfileMaintenanceOwnerStage(record['ownerStage'], `${field}.ownerStage`) }
}

export function parseAuthenticatedParticipantContext(value: unknown, field = 'context'): AuthenticatedProfileMaintenanceParticipantContext {
  exactKeys(value, field, ['connectionId', 'participant'])
  const record = value as Record<string, unknown>
  return {
    connectionId: boundedIdentifier(record['connectionId'], `${field}.connectionId`),
    participant: parseProfileMaintenanceParticipant(record['participant'], `${field}.participant`)
  }
}

export function parseAuthenticatedMigrationContext(value: unknown, field = 'context'): AuthenticatedProfileMaintenanceMigrationContext {
  exactKeys(value, field, ['connectionId', 'ownerStage'])
  const record = value as Record<string, unknown>
  return {
    connectionId: boundedIdentifier(record['connectionId'], `${field}.connectionId`),
    ownerStage: parseProfileMaintenanceOwnerStage(record['ownerStage'], `${field}.ownerStage`)
  }
}

export function parseProfileMaintenanceLease(value: unknown, field = 'lease'): ProfileMaintenanceLease {
  exactKeys(value, field, ['migrationId', 'ownerStage', 'epoch', 'revision'])
  const record = value as Record<string, unknown>
  return {
    migrationId: boundedIdentifier(record['migrationId'], `${field}.migrationId`),
    ownerStage: parseProfileMaintenanceOwnerStage(record['ownerStage'], `${field}.ownerStage`),
    epoch: positiveInteger(record['epoch'], `${field}.epoch`),
    revision: positiveInteger(record['revision'], `${field}.revision`)
  }
}

export function parseProfileMaintenanceAdmission(value: unknown, field = 'admission'): ProfileMaintenanceAdmission {
  exactKeys(value, field, ['participant', 'operationId', 'epoch', 'ownerConnectionId'])
  const record = value as Record<string, unknown>
  return {
    participant: parseProfileMaintenanceParticipant(record['participant'], `${field}.participant`),
    operationId: boundedIdentifier(record['operationId'], `${field}.operationId`),
    epoch: positiveInteger(record['epoch'], `${field}.epoch`),
    ownerConnectionId: boundedIdentifier(record['ownerConnectionId'], `${field}.ownerConnectionId`)
  }
}

export function parseProfileMaintenanceTransitionIntent(value: unknown, field = 'intent'): ProfileMaintenanceTransitionIntent {
  exactKeys(value, field, ['participant', 'operationId', 'sourceSha256', 'intentSha256', 'visibilityMode'])
  const record = value as Record<string, unknown>
  const visibilityMode = record['visibilityMode']
  if (visibilityMode !== 'central' && visibilityMode !== 'external-wal') {
    throw new ProfileMaintenanceValidationError(`${field}.visibilityMode`, 'must be "central" or "external-wal"')
  }
  return {
    participant: parseProfileMaintenanceParticipant(record['participant'], `${field}.participant`),
    operationId: boundedIdentifier(record['operationId'], `${field}.operationId`),
    sourceSha256: digest(record['sourceSha256'], `${field}.sourceSha256`),
    intentSha256: digest(record['intentSha256'], `${field}.intentSha256`),
    visibilityMode
  }
}

export function parseProfileMaintenanceReceipt(value: unknown, field = 'receipt'): ProfileMaintenanceTransitionReceipt {
  exactKeys(value, field, ['id', 'migrationId', 'ownerStage', 'epoch', 'participant', 'operationId', 'sourceSha256', 'intentSha256', 'visibilityMode', 'state', 'externalVisibility', 'localVisibleRevision', 'localVisibleEvidenceSha256', 'revision'])
  const record = value as Record<string, unknown>
  const visibilityMode = record['visibilityMode']
  if (visibilityMode !== 'central' && visibilityMode !== 'external-wal') {
    throw new ProfileMaintenanceValidationError(`${field}.visibilityMode`, 'must be "central" or "external-wal"')
  }
  const state = record['state']
  if (state !== 'prepared' && state !== 'completed') {
    throw new ProfileMaintenanceValidationError(`${field}.state`, 'must be "prepared" or "completed"')
  }
  const externalVisibility = record['externalVisibility']
  if (externalVisibility !== 'not-required' && externalVisibility !== 'pending' && externalVisibility !== 'acknowledged') {
    throw new ProfileMaintenanceValidationError(`${field}.externalVisibility`, 'must be "not-required", "pending", or "acknowledged"')
  }
  return {
    id: boundedIdentifier(record['id'], `${field}.id`),
    migrationId: boundedIdentifier(record['migrationId'], `${field}.migrationId`),
    ownerStage: parseProfileMaintenanceOwnerStage(record['ownerStage'], `${field}.ownerStage`),
    epoch: positiveInteger(record['epoch'], `${field}.epoch`),
    participant: parseProfileMaintenanceParticipant(record['participant'], `${field}.participant`),
    operationId: boundedIdentifier(record['operationId'], `${field}.operationId`),
    sourceSha256: digest(record['sourceSha256'], `${field}.sourceSha256`),
    intentSha256: digest(record['intentSha256'], `${field}.intentSha256`),
    visibilityMode,
    state,
    externalVisibility,
    localVisibleRevision: record['localVisibleRevision'] === null ? null : boundedIdentifier(record['localVisibleRevision'], `${field}.localVisibleRevision`),
    localVisibleEvidenceSha256: record['localVisibleEvidenceSha256'] === null ? null : digest(record['localVisibleEvidenceSha256'], `${field}.localVisibleEvidenceSha256`),
    revision: positiveInteger(record['revision'], `${field}.revision`)
  }
}

export function parseProfileMaintenanceObservations(value: unknown, field = 'observations'): ProfileMaintenanceAdmissionObservation[] {
  if (!Array.isArray(value) || value.length > PROFILE_MAINTENANCE_MAX_BATCH) {
    throw new ProfileMaintenanceValidationError(field, `must be an array of at most ${PROFILE_MAINTENANCE_MAX_BATCH} observations`)
  }
  const observations = value.map((entry, index) => {
    exactKeys(entry, `${field}[${index}]`, ['operationId', 'epoch', 'outcome', 'evidenceSha256'])
    const record = entry as Record<string, unknown>
    const outcome = record['outcome']
    if (outcome !== 'completed' && outcome !== 'cancelled' && outcome !== 'active' && outcome !== 'indeterminate') {
      throw new ProfileMaintenanceValidationError(`${field}[${index}].outcome`, 'must be a known admission outcome')
    }
    const parsed: ProfileMaintenanceAdmissionObservation = {
      operationId: boundedIdentifier(record['operationId'], `${field}[${index}].operationId`),
      epoch: positiveInteger(record['epoch'], `${field}[${index}].epoch`),
      outcome,
      evidenceSha256: digest(record['evidenceSha256'], `${field}[${index}].evidenceSha256`)
    }
    return parsed
  })
  const seen = new Set<string>()
  for (const observation of observations) {
    // A duplicated operation/epoch observation is not evidence about the set.
    if (seen.has(observation.operationId)) {
      throw new ProfileMaintenanceValidationError(field, `duplicates operation "${observation.operationId}"`)
    }
    seen.add(observation.operationId)
  }
  return observations
}

export function parseProfileMaintenanceFailure(value: unknown, field = 'failure'): ProfileMaintenanceFailure {
  exactKeys(value, field, ['code', 'evidenceSha256'])
  const record = value as Record<string, unknown>
  const code = record['code']
  if (typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(code)) {
    throw new ProfileMaintenanceValidationError(`${field}.code`, 'must be an uppercase bounded code')
  }
  return { code, evidenceSha256: digest(record['evidenceSha256'], `${field}.evidenceSha256`) }
}

export function parseProfileMaintenanceResumeInput(value: unknown, field = 'input'): ProfileMaintenanceResumeInput {
  exactKeys(value, field, ['migrationId', 'expectedRevision', 'expectedSourceSetSha256'])
  const record = value as Record<string, unknown>
  return {
    migrationId: boundedIdentifier(record['migrationId'], `${field}.migrationId`),
    expectedRevision: positiveInteger(record['expectedRevision'], `${field}.expectedRevision`),
    expectedSourceSetSha256: digest(record['expectedSourceSetSha256'], `${field}.expectedSourceSetSha256`)
  }
}

export function parseProfileMaintenanceAbortInput(value: unknown, field = 'input'): ProfileMaintenanceAbortInput {
  exactKeys(value, field, ['migrationId', 'expectedRevision', 'observedSourceSetSha256'])
  const record = value as Record<string, unknown>
  return {
    migrationId: boundedIdentifier(record['migrationId'], `${field}.migrationId`),
    expectedRevision: positiveInteger(record['expectedRevision'], `${field}.expectedRevision`),
    observedSourceSetSha256: digest(record['observedSourceSetSha256'], `${field}.observedSourceSetSha256`)
  }
}

export function parseProfileMaintenanceRetirement(value: unknown, field = 'retirement'): { participant: ProfileMaintenanceParticipant; retiredPath: string; fenceReceiptSha256: string; fsynced: boolean } {
  exactKeys(value, field, ['participant', 'retiredPath', 'fenceReceiptSha256', 'fsynced'])
  const record = value as Record<string, unknown>
  if (typeof record['fsynced'] !== 'boolean') {
    throw new ProfileMaintenanceValidationError(`${field}.fsynced`, 'must be a boolean')
  }
  return {
    participant: parseProfileMaintenanceParticipant(record['participant'], `${field}.participant`),
    retiredPath: boundedPath(record['retiredPath'], `${field}.retiredPath`),
    fenceReceiptSha256: digest(record['fenceReceiptSha256'], `${field}.fenceReceiptSha256`),
    fsynced: record['fsynced']
  }
}

/**
 * Deterministic digest of the frozen source set.
 *
 * Derived from persisted transition receipts — never supplied by a caller — so
 * a fail/resume cycle compares the exact sources the migration froze, and a
 * later receipt change cannot silently satisfy a resume.
 */
export function frozenSourceSetSha256(
  participants: readonly ProfileMaintenanceParticipant[],
  receipts: readonly Pick<ProfileMaintenanceTransitionReceipt, 'participant' | 'operationId' | 'sourceSha256' | 'intentSha256' | 'visibilityMode'>[]
): string {
  const orderedParticipants = [...participants].sort()
  const orderedReceipts = receipts
    .map(receipt => [receipt.participant, receipt.operationId, receipt.sourceSha256, receipt.intentSha256, receipt.visibilityMode] as const)
    .sort((left, right) => (left[0] === right[0] ? (left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0) : left[0] < right[0] ? -1 : 1))
  return createDigest(JSON.stringify({ participants: orderedParticipants, receipts: orderedReceipts }))
}

/** Deterministic digest over an exact ordered list of (kind, path, sha256) source records. */
export function sourceSetSha256(sources: readonly Readonly<{ kind: string; path: string; sha256: string }>[]): string {
  const ordered = sources
    .map(source => [source.kind, source.path, source.sha256] as const)
    .sort((left, right) => (left[1] === right[1] ? (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0) : left[1] < right[1] ? -1 : 1))
  return createDigest(JSON.stringify(ordered))
}

function createDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
