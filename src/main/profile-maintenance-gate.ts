import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  frozenSourceSetSha256,
  parseAuthenticatedAdministratorContext,
  parseAuthenticatedCallerContext,
  parseAuthenticatedMigrationContext,
  parseAuthenticatedParticipantContext,
  parseProfileMaintenanceAbortInput,
  parseProfileMaintenanceAdmission,
  parseProfileMaintenanceFailure,
  parseProfileMaintenanceLease,
  parseProfileMaintenanceObservations,
  parseProfileMaintenanceOwnerStage,
  parseProfileMaintenanceParticipant,
  parseProfileMaintenanceParticipantSet,
  parseProfileMaintenanceReceipt,
  parseProfileMaintenanceResumeInput,
  parseProfileMaintenanceRetirement,
  parseProfileMaintenanceTransitionIntent,
  ProfileMaintenanceError,
  ProfileMaintenanceValidationError,
  PROFILE_MAINTENANCE_MAX_BATCH,
  PROFILE_MAINTENANCE_MAX_IDENTIFIER,
  PROFILE_MAINTENANCE_MAX_PATH,
  PROFILE_MAINTENANCE_UNMIGRATED,
  type AuthenticatedAdministratorContext,
  type AuthenticatedCallerContext,
  type AuthenticatedProfileMaintenanceMigrationContext,
  type AuthenticatedProfileMaintenanceParticipantContext,
  type ProfileMaintenanceAdmission,
  type ProfileMaintenanceAdmissionObservation,
  type ProfileMaintenanceFailure,
  type ProfileMaintenanceFenceReceipt,
  type ProfileMaintenanceGate,
  type ProfileMaintenanceGateInternal,
  type ProfileMaintenanceLease,
  type ProfileMaintenanceOwnerStage,
  type ProfileMaintenanceParticipant,
  type ProfileMaintenancePhase,
  type ProfileMaintenanceResumeInput,
  type ProfileMaintenanceAbortInput,
  type ProfileMaintenanceState,
  type ProfileMaintenanceTransitionIntent,
  type ProfileMaintenanceTransitionReceipt
} from '@shared/profile-maintenance'
import type { TaskAuthorityDatabase } from './task-authority/schema'

type Row = Record<string, unknown>

const PHASES: Record<string, true> = { open: true, freezing: true, draining: true, 'cutting-over': true, failed: true }
const ACTIVE_ADMISSION: Record<string, true> = { active: true, indeterminate: true }

/**
 * Durable stage-neutral profile maintenance gate (Stage 2 kernel for Stages 2-5).
 *
 * Persistence lives in the one central daemon database — never a second
 * connection, file, or SQLite `ATTACH`. Every method is one `BEGIN IMMEDIATE`
 * transaction (or a read) that validates authenticated context, the persisted
 * lease epoch, and the persisted phase before touching durable state.
 *
 * Phase machine: `open` (no lease) → `acquire` → `freezing` → first
 * `acknowledgeDrained` → `draining` → `beginCutover` → `cutting-over` →
 * `release` → `open`. `fail` is reachable from every leased phase and is the
 * only durable non-open terminal for an interrupted migration; it records the
 * safe phase and the frozen source-set digest so `resume` can compare-and-set
 * exactly, and so `abort` can still return to legacy writers while rollback is
 * reversible.
 *
 * Phase `open` and "no lease" are the same fact: a lease always closes
 * admissions (`admit` fails closed outside `open`), so `acquire` records phase
 * `freezing` in the same transaction that installs the lease.
 */
export class SqliteProfileMaintenanceGate implements ProfileMaintenanceGateInternal {
  private readonly database: TaskAuthorityDatabase
  private readonly profileId: string
  private readonly onDiscardCandidateState: (migrationId: string) => void

  constructor(options: Readonly<{
    database: TaskAuthorityDatabase
    profileId: string
    onDiscardCandidateState?: (migrationId: string) => void
  }>) {
    if (typeof options.profileId !== 'string' || options.profileId.length === 0 || options.profileId.length > PROFILE_MAINTENANCE_MAX_IDENTIFIER || options.profileId.includes('\0')) {
      throw new ProfileMaintenanceValidationError('profileId', `must be a non-empty string of at most ${PROFILE_MAINTENANCE_MAX_IDENTIFIER} characters`)
    }
    this.database = options.database
    this.profileId = options.profileId
    this.onDiscardCandidateState = options.onDiscardCandidateState ?? (() => undefined)
  }

  // -- durable state --------------------------------------------------------

  readState(): ProfileMaintenanceState {
    return this.database.withReadOnly(db => this.loadState(db))
  }

  /**
   * The persisted epoch of one live admission.
   *
   * Completing work uses this rather than a caller-supplied epoch, so a client
   * cannot close an admission recorded under a superseded epoch.
   */
  admissionEpoch(participant: ProfileMaintenanceParticipant, operationId: string): number {
    const name = parseProfileMaintenanceParticipant(participant)
    const operation = boundedIdentifier(operationId, 'operationId')
    return this.database.withReadOnly(db => {
      const row = db.prepare("SELECT epoch FROM profile_maintenance_admissions WHERE profile_id = ? AND participant = ? AND operation_id = ?")
        .get(this.profileId, name, operation) as Row | undefined
      if (row === undefined) throw new ProfileMaintenanceError('GATE_CONFLICT', `admission ${operation} was not found for participant ${name}`)
      return int(row['epoch'])
    })
  }

  private loadState(db: DatabaseSync): ProfileMaintenanceState {
    const row = db.prepare('SELECT * FROM profile_maintenance_state WHERE profile_id = ?').get(this.profileId) as Row | undefined
    if (!row) {
      return { phase: 'open', lease: null, revision: 1, participants: [], frozenSourceSetSha256: null, safePhase: null, irreversible: false, failureCode: null }
    }
    const phase = text(row['phase'])
    if (PHASES[phase] !== true) throw new ProfileMaintenanceError('GATE_PHASE_INVALID', `persisted profile maintenance phase "${phase}" was unrecognized`)
    const migrationId = textOrNull(row['migration_id'])
    const ownerStage = textOrNull(row['owner_stage'])
    const participants = parseParticipants(text(row['participants_json']))
    return {
      phase: phase as ProfileMaintenancePhase,
      lease: migrationId === null || ownerStage === null
        ? null
        : { migrationId, ownerStage: parseProfileMaintenanceOwnerStage(ownerStage, 'owner_stage'), epoch: int(row['epoch']), revision: int(row['revision']) },
      revision: int(row['revision']),
      participants,
      frozenSourceSetSha256: textOrNull(row['frozen_source_set_sha256']),
      safePhase: safePhaseOf(row['safe_phase']),
      irreversible: bool(row['irreversible']),
      failureCode: textOrNull(row['failure_code'])
    }
  }

  /** Installs the profile row on first use; every later call is a pure read. */
  private ensureState(db: DatabaseSync): Row {
    const row = db.prepare('SELECT * FROM profile_maintenance_state WHERE profile_id = ?').get(this.profileId) as Row | undefined
    if (row) return row
    db.prepare("INSERT INTO profile_maintenance_state(profile_id, phase, migration_id, owner_stage, epoch, revision, participants_json, frozen_source_set_sha256, safe_phase, irreversible, failure_code, updated_at) VALUES (?,'open',NULL,NULL,0,1,'[]',NULL,NULL,0,NULL,?)")
      .run(this.profileId, nowIso())
    return db.prepare('SELECT * FROM profile_maintenance_state WHERE profile_id = ?').get(this.profileId) as Row
  }

  // -- ordinary affected work ----------------------------------------------

  async admit(context: AuthenticatedCallerContext, participant: ProfileMaintenanceParticipant, operationId: string): Promise<ProfileMaintenanceAdmission> {
    const caller = parseAuthenticatedCallerContext(context)
    const requested = parseProfileMaintenanceParticipant(participant)
    // Caller-supplied identity never substitutes for the authenticated
    // connection: a participant-bound connection may only admit its own work.
    if (caller.participant !== undefined && caller.participant !== requested) {
      throw new ProfileMaintenanceError('AUTHORIZATION_DENIED', `authenticated participant "${caller.participant}" may not admit work for "${requested}"`)
    }
    const boundedOperation = boundedIdentifier(operationId, 'operationId')
    return this.database.withImmediate(db => {
      const state = this.ensureState(db)
      const phase = text(state['phase'])
      if (phase !== 'open') {
        throw new ProfileMaintenanceError('GATE_NOT_OPEN', `profile maintenance phase "${phase}" rejects new affected work`)
      }
      const stored = this.loadState(db)
      const migrationId = stored.lease?.migrationId ?? PROFILE_MAINTENANCE_UNMIGRATED
      const epoch = stored.lease?.epoch ?? 1
      const existing = db.prepare('SELECT * FROM profile_maintenance_admissions WHERE profile_id = ? AND migration_id = ? AND participant = ? AND operation_id = ?')
        .get(this.profileId, migrationId, requested, boundedOperation) as Row | undefined
      if (existing) {
        if (text(existing['owner_connection_id']) !== caller.connectionId) {
          throw new ProfileMaintenanceError('GATE_CONFLICT', `operation "${boundedOperation}" is already admitted by another authenticated connection`)
        }
        if (ACTIVE_ADMISSION[text(existing['state'])] !== true) {
          throw new ProfileMaintenanceError('GATE_CONFLICT', `operation "${boundedOperation}" already finished and cannot be re-admitted`)
        }
        return admissionSnapshot(existing)
      }
      const live = db.prepare("SELECT COUNT(*) AS count FROM profile_maintenance_admissions WHERE profile_id = ? AND state IN ('active','indeterminate')").get(this.profileId) as Row
      if (int(live['count']) >= PROFILE_MAINTENANCE_MAX_BATCH * PROFILE_MAINTENANCE_MAX_BATCH) {
        throw new ProfileMaintenanceError('GATE_CONFLICT', 'too many live profile maintenance admissions')
      }
      db.prepare("INSERT INTO profile_maintenance_admissions(profile_id, migration_id, epoch, participant, operation_id, owner_connection_id, state, evidence_sha256, created_at, updated_at) VALUES (?,?,?,?,?,?,'active',NULL,?,?)")
        .run(this.profileId, migrationId, epoch, requested, boundedOperation, caller.connectionId, nowIso(), nowIso())
      return { participant: requested, operationId: boundedOperation, epoch, ownerConnectionId: caller.connectionId }
    })
  }

  async complete(context: AuthenticatedCallerContext, admission: ProfileMaintenanceAdmission, outcome: 'completed' | 'cancelled' | 'indeterminate'): Promise<void> {
    const caller = parseAuthenticatedCallerContext(context)
    const target = parseProfileMaintenanceAdmission(admission)
    if (outcome !== 'completed' && outcome !== 'cancelled' && outcome !== 'indeterminate') {
      throw new ProfileMaintenanceValidationError('outcome', 'must be completed, cancelled, or indeterminate')
    }
    if (caller.participant !== undefined && caller.participant !== target.participant) {
      throw new ProfileMaintenanceError('AUTHORIZATION_DENIED', `authenticated participant "${caller.participant}" may not complete work for "${target.participant}"`)
    }
    if (caller.connectionId !== target.ownerConnectionId) {
      throw new ProfileMaintenanceError('AUTHORIZATION_DENIED', 'only the admitting authenticated connection may complete this admission')
    }
    this.database.withImmediate(db => {
      const row = db.prepare('SELECT * FROM profile_maintenance_admissions WHERE profile_id = ? AND participant = ? AND operation_id = ?')
        .get(this.profileId, target.participant, target.operationId) as Row | undefined
      if (!row || text(row['owner_connection_id']) !== caller.connectionId) {
        throw new ProfileMaintenanceError('GATE_CONFLICT', `admission ${target.operationId} was not found for this connection`)
      }
      const current = text(row['state'])
      if (ACTIVE_ADMISSION[current] !== true && current !== outcome) {
        throw new ProfileMaintenanceError('GATE_CONFLICT', `admission ${target.operationId} is already ${current}`)
      }
      db.prepare('UPDATE profile_maintenance_admissions SET state = ?, updated_at = ? WHERE profile_id = ? AND migration_id = ? AND participant = ? AND operation_id = ?')
        .run(outcome, nowIso(), this.profileId, text(row['migration_id']), target.participant, target.operationId)
    })
  }

  /**
   * Every still-unresolved admission this authenticated participant owns for
   * the migration — the exact set `reconcileOwnedAdmissions` must cover.
   * Prior-epoch admissions stay visible so a resumed migration reconciles the
   * work admitted under the previous epoch.
   */
  async listOwnedAdmissions(context: AuthenticatedProfileMaintenanceParticipantContext, migrationId: string): Promise<ProfileMaintenanceAdmission[]> {
    const caller = parseAuthenticatedParticipantContext(context)
    const migration = boundedIdentifier(migrationId, 'migrationId')
    return this.database.withReadOnly(db => {
      const rows = db.prepare("SELECT * FROM profile_maintenance_admissions WHERE profile_id = ? AND migration_id = ? AND participant = ? AND owner_connection_id = ? AND state IN ('active','indeterminate') ORDER BY operation_id")
        .all(this.profileId, migration, caller.participant, caller.connectionId) as Row[]
      return rows.map(admissionSnapshot)
    })
  }

  async reconcileOwnedAdmissions(context: AuthenticatedProfileMaintenanceParticipantContext, migrationId: string, observations: ProfileMaintenanceAdmissionObservation[]): Promise<void> {
    const caller = parseAuthenticatedParticipantContext(context)
    const migration = boundedIdentifier(migrationId, 'migrationId')
    const parsed = parseProfileMaintenanceObservations(observations)
    this.database.withImmediate(db => {
      const rows = db.prepare("SELECT * FROM profile_maintenance_admissions WHERE profile_id = ? AND migration_id = ? AND participant = ? AND owner_connection_id = ? AND state IN ('active','indeterminate') ORDER BY operation_id")
        .all(this.profileId, migration, caller.participant, caller.connectionId) as Row[]
      // Exact set: a missing observation leaves work unresolved, and an
      // unknown, wrong-epoch, or duplicated observation is not evidence.
      if (rows.length !== parsed.length) {
        throw new ProfileMaintenanceError('GATE_CONFLICT', `reconciliation covered ${parsed.length} of ${rows.length} unresolved admissions`)
      }
      for (const row of rows) {
        const operationId = text(row['operation_id'])
        const observation = parsed.find(candidate => candidate.operationId === operationId)
        if (!observation) throw new ProfileMaintenanceError('GATE_CONFLICT', `reconciliation omitted admission ${operationId}`)
        if (observation.epoch !== int(row['epoch'])) {
          throw new ProfileMaintenanceError('GATE_CONFLICT', `reconciliation epoch for admission ${operationId} did not match the admitted epoch`)
        }
        db.prepare('UPDATE profile_maintenance_admissions SET state = ?, evidence_sha256 = ?, updated_at = ? WHERE profile_id = ? AND migration_id = ? AND participant = ? AND operation_id = ?')
          .run(observation.outcome, observation.evidenceSha256, nowIso(), this.profileId, migration, caller.participant, operationId)
      }
    })
  }

  async markConnectionDisconnected(connectionId: string): Promise<void> {
    const connection = boundedIdentifier(connectionId, 'connectionId')
    this.database.withImmediate(db => {
      db.prepare("UPDATE profile_maintenance_admissions SET state = 'indeterminate', updated_at = ? WHERE profile_id = ? AND owner_connection_id = ? AND state = 'active'")
        .run(nowIso(), this.profileId, connection)
    })
  }

  // -- migration owner -------------------------------------------------------

  async acquire(context: AuthenticatedAdministratorContext, input: { migrationId: string; ownerStage: ProfileMaintenanceOwnerStage; participants: ProfileMaintenanceParticipant[]; expectedRevision: number }): Promise<ProfileMaintenanceLease> {
    const caller = parseAuthenticatedAdministratorContext(context)
    if (typeof input !== 'object' || input === null) throw new ProfileMaintenanceValidationError('input', 'must be an object')
    for (const key of Object.keys(input)) {
      if (!['migrationId', 'ownerStage', 'participants', 'expectedRevision'].includes(key)) {
        throw new ProfileMaintenanceValidationError('input', `unknown key "${key}"`)
      }
    }
    const migrationId = boundedIdentifier(input.migrationId, 'migrationId')
    if (migrationId === PROFILE_MAINTENANCE_UNMIGRATED) {
      throw new ProfileMaintenanceValidationError('migrationId', 'is reserved for pre-migration admissions')
    }
    const ownerStage = parseProfileMaintenanceOwnerStage(input.ownerStage)
    const participants = parseProfileMaintenanceParticipantSet(input.participants)
    if (caller.ownerStage !== undefined && caller.ownerStage !== ownerStage) {
      throw new ProfileMaintenanceError('GATE_STAGE_UNAUTHORIZED', `authenticated migration coordinator owns ${caller.ownerStage} and may not lease ${ownerStage}`)
    }
    requireAdminRevision(input.expectedRevision)
    return this.database.withImmediate(db => {
      const state = this.loadState(db)
      if (state.phase !== 'open' || state.lease !== null) {
        throw new ProfileMaintenanceError('GATE_LEASED', `only one migration lease may exist profile-wide; phase is "${state.phase}"`)
      }
      if (input.expectedRevision !== this.storedRevision(db)) {
        throw new ProfileMaintenanceError('GATE_STALE', `expected revision ${input.expectedRevision} did not match the persisted profile revision`)
      }
      const epoch = 1
      // Outstanding pre-migration work becomes this migration's drain set: it
      // ran against the sources the migration is about to freeze.
      db.prepare('UPDATE profile_maintenance_admissions SET migration_id = ?, epoch = ?, updated_at = ? WHERE profile_id = ? AND migration_id = ?')
        .run(migrationId, epoch, nowIso(), this.profileId, PROFILE_MAINTENANCE_UNMIGRATED)
      const revision = this.nextRevision(db)
      db.prepare("UPDATE profile_maintenance_state SET phase = 'freezing', migration_id = ?, owner_stage = ?, epoch = ?, revision = ?, participants_json = ?, frozen_source_set_sha256 = NULL, safe_phase = NULL, irreversible = 0, failure_code = NULL, updated_at = ? WHERE profile_id = ?")
        .run(migrationId, ownerStage, epoch, revision, JSON.stringify([...participants].sort()), nowIso(), this.profileId)
      return { migrationId, ownerStage, epoch, revision }
    })
  }

  async freeze(context: AuthenticatedAdministratorContext, lease: ProfileMaintenanceLease): Promise<void> {
    const caller = parseAuthenticatedAdministratorContext(context)
    const target = parseProfileMaintenanceLease(lease)
    this.database.withImmediate(db => {
      this.requireOwnedLease(db, caller, target)
      const state = this.loadState(db)
      // `acquire` already closed admissions; freeze is the explicit durable
      // confirmation and is idempotent while the phase is still draining.
      if (state.phase !== 'freezing' && state.phase !== 'draining') {
        throw new ProfileMaintenanceError('GATE_PHASE_INVALID', `phase "${state.phase}" cannot be frozen`)
      }
    })
  }

  async acknowledgeDrained(context: AuthenticatedProfileMaintenanceParticipantContext, migrationId: string): Promise<void> {
    const caller = parseAuthenticatedParticipantContext(context)
    const migration = boundedIdentifier(migrationId, 'migrationId')
    this.database.withImmediate(db => {
      const state = this.loadState(db)
      if (state.lease === null || state.lease.migrationId !== migration) {
        throw new ProfileMaintenanceError('GATE_NOT_LEASED', `migration ${migration} does not hold the profile maintenance lease`)
      }
      if (state.phase !== 'freezing' && state.phase !== 'draining' && state.phase !== 'cutting-over') {
        throw new ProfileMaintenanceError('GATE_PHASE_INVALID', `phase "${state.phase}" does not accept drain acknowledgements`)
      }
      if (!state.participants.includes(caller.participant)) {
        throw new ProfileMaintenanceError('GATE_PARTICIPANT_MISMATCH', `participant "${caller.participant}" is not in the frozen participant set`)
      }
      const live = db.prepare("SELECT COUNT(*) AS count FROM profile_maintenance_admissions WHERE profile_id = ? AND migration_id = ? AND participant = ? AND state IN ('active','indeterminate')")
        .get(this.profileId, migration, caller.participant) as Row
      if (int(live['count']) > 0) {
        throw new ProfileMaintenanceError('GATE_ADMISSION_UNRESOLVED', `participant "${caller.participant}" still owns ${int(live['count'])} unresolved admission(s)`)
      }
      db.prepare('INSERT INTO profile_maintenance_acknowledgements(profile_id, migration_id, epoch, participant, acknowledged_at) VALUES (?,?,?,?,?) ON CONFLICT(profile_id, migration_id, epoch, participant) DO NOTHING')
        .run(this.profileId, migration, state.lease.epoch, caller.participant, nowIso())
      if (state.phase === 'freezing') {
        db.prepare("UPDATE profile_maintenance_state SET phase = 'draining', updated_at = ? WHERE profile_id = ?").run(nowIso(), this.profileId)
      }
    })
  }

  async beginCutover(context: AuthenticatedAdministratorContext, lease: ProfileMaintenanceLease): Promise<void> {
    const caller = parseAuthenticatedAdministratorContext(context)
    const target = parseProfileMaintenanceLease(lease)
    this.database.withImmediate(db => {
      this.requireOwnedLease(db, caller, target)
      const state = this.loadState(db)
      // Idempotent while the cutover is still in progress: a caller replaying
      // an interrupted cutover must not need a new revision.
      if (state.phase === 'cutting-over') return
      if (state.phase !== 'freezing' && state.phase !== 'draining') {
        throw new ProfileMaintenanceError('GATE_PHASE_INVALID', `phase "${state.phase}" cannot begin cutover`)
      }
      const acknowledged = db.prepare('SELECT participant FROM profile_maintenance_acknowledgements WHERE profile_id = ? AND migration_id = ? AND epoch = ? ORDER BY participant')
        .all(this.profileId, target.migrationId, target.epoch) as Row[]
      const acknowledgedSet = acknowledged.map(row => text(row['participant'])).sort()
      if (acknowledgedSet.length !== state.participants.length || acknowledgedSet.some((participant, index) => participant !== [...state.participants].sort()[index])) {
        throw new ProfileMaintenanceError('GATE_ADMISSION_UNRESOLVED', 'cutover requires an acknowledgement from every frozen participant at the current epoch')
      }
      const live = db.prepare("SELECT COUNT(*) AS count FROM profile_maintenance_admissions WHERE profile_id = ? AND migration_id = ? AND state IN ('active','indeterminate')")
        .get(this.profileId, target.migrationId) as Row
      if (int(live['count']) > 0) {
        throw new ProfileMaintenanceError('GATE_ADMISSION_UNRESOLVED', `cutover requires zero live admissions; ${int(live['count'])} remain`)
      }
      db.prepare("UPDATE profile_maintenance_state SET phase = 'cutting-over', updated_at = ? WHERE profile_id = ?").run(nowIso(), this.profileId)
    })
  }

  async prepareMigrationTransition(context: AuthenticatedProfileMaintenanceMigrationContext, lease: ProfileMaintenanceLease, intent: ProfileMaintenanceTransitionIntent): Promise<ProfileMaintenanceTransitionReceipt> {
    const caller = parseAuthenticatedMigrationContext(context)
    const target = parseProfileMaintenanceLease(lease)
    const parsed = parseProfileMaintenanceTransitionIntent(intent)
    return this.database.withImmediate(db => {
      this.requireOwnedLease(db, caller, target)
      const state = this.loadState(db)
      if (state.phase !== 'cutting-over') {
        throw new ProfileMaintenanceError('GATE_PHASE_INVALID', `phase "${state.phase}" cannot prepare a migration transition`)
      }
      if (!state.participants.includes(parsed.participant)) {
        throw new ProfileMaintenanceError('GATE_PARTICIPANT_MISMATCH', `participant "${parsed.participant}" is not in the frozen participant set`)
      }
      const existing = db.prepare('SELECT * FROM profile_maintenance_transitions WHERE profile_id = ? AND migration_id = ? AND epoch = ? AND participant = ? AND operation_id = ?')
        .get(this.profileId, target.migrationId, target.epoch, parsed.participant, parsed.operationId) as Row | undefined
      if (existing) {
        if (text(existing['intent_sha256']) !== parsed.intentSha256 || text(existing['source_sha256']) !== parsed.sourceSha256
          || text(existing['visibility_mode']) !== parsed.visibilityMode) {
          throw new ProfileMaintenanceError('GATE_CONFLICT', `transition ${parsed.operationId} was already prepared with a different source, intent, or visibility mode`)
        }
        return receiptSnapshot(existing)
      }
      const id = randomUUID()
      const revision = 1
      db.prepare("INSERT INTO profile_maintenance_transitions(id, profile_id, migration_id, owner_stage, epoch, participant, operation_id, source_sha256, intent_sha256, visibility_mode, state, external_visibility, local_visible_revision, local_visible_evidence_sha256, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'prepared','not-required',NULL,NULL,?,?,?)")
        .run(id, this.profileId, target.migrationId, target.ownerStage, target.epoch, parsed.participant, parsed.operationId, parsed.sourceSha256, parsed.intentSha256, parsed.visibilityMode, revision, nowIso(), nowIso())
      return {
        id,
        migrationId: target.migrationId,
        ownerStage: target.ownerStage,
        epoch: target.epoch,
        participant: parsed.participant,
        operationId: parsed.operationId,
        sourceSha256: parsed.sourceSha256,
        intentSha256: parsed.intentSha256,
        visibilityMode: parsed.visibilityMode,
        state: 'prepared',
        externalVisibility: 'not-required',
        localVisibleRevision: null,
        localVisibleEvidenceSha256: null,
        revision
      }
    })
  }

  async completeMigrationTransition(context: AuthenticatedProfileMaintenanceMigrationContext, receipt: ProfileMaintenanceTransitionReceipt, evidenceSha256: string): Promise<ProfileMaintenanceTransitionReceipt> {
    const caller = parseAuthenticatedMigrationContext(context)
    const target = parseProfileMaintenanceReceipt(receipt)
    const evidence = boundedDigest(evidenceSha256, 'evidenceSha256')
    return this.database.withImmediate(db => {
      const row = this.requireTransition(db, caller, target)
      if (text(row['state']) === 'completed') {
        if (textOrNull(row['evidence_sha256']) === evidence) return receiptSnapshot(row)
        throw new ProfileMaintenanceError('GATE_CONFLICT', `transition ${target.operationId} was already completed with different evidence`)
      }
      // External-WAL owners stage invisibly first: completion is what makes
      // local visibility required, so the receipt moves to pending here.
      const visibility = text(row['visibility_mode']) === 'external-wal' ? 'pending' : 'not-required'
      db.prepare("UPDATE profile_maintenance_transitions SET state = 'completed', external_visibility = ?, evidence_sha256 = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
        .run(visibility, evidence, nowIso(), text(row['id']))
      return receiptSnapshot(db.prepare('SELECT * FROM profile_maintenance_transitions WHERE id = ?').get(text(row['id'])) as Row)
    })
  }

  async acknowledgeExternalVisibility(context: AuthenticatedProfileMaintenanceMigrationContext, receipt: ProfileMaintenanceTransitionReceipt, input: { expectedRevision: number; localVisibleRevision: string; localVisibleEvidenceSha256: string }): Promise<ProfileMaintenanceTransitionReceipt> {
    const caller = parseAuthenticatedMigrationContext(context)
    const target = parseProfileMaintenanceReceipt(receipt)
    if (typeof input !== 'object' || input === null) throw new ProfileMaintenanceValidationError('input', 'must be an object')
    for (const key of Object.keys(input)) {
      if (!['expectedRevision', 'localVisibleRevision', 'localVisibleEvidenceSha256'].includes(key)) {
        throw new ProfileMaintenanceValidationError('input', `unknown key "${key}"`)
      }
    }
    requireAdminRevision(input.expectedRevision)
    const localVisibleRevision = boundedIdentifier(input.localVisibleRevision, 'localVisibleRevision')
    const localVisibleEvidence = boundedDigest(input.localVisibleEvidenceSha256, 'localVisibleEvidenceSha256')
    return this.database.withImmediate(db => {
      const row = this.requireTransition(db, caller, target)
      const state = text(row['state'])
      const visibility = text(row['external_visibility'])
      if (state === 'completed' && visibility === 'acknowledged') {
        if (text(row['local_visible_revision']) === localVisibleRevision && text(row['local_visible_evidence_sha256']) === localVisibleEvidence) {
          return receiptSnapshot(row)
        }
        throw new ProfileMaintenanceError('GATE_CONFLICT', 'transition was already acknowledged with different visible revision or evidence')
      }
      if (text(row['visibility_mode']) !== 'external-wal') {
        throw new ProfileMaintenanceError('GATE_PHASE_INVALID', 'only external-wal transitions require a visibility acknowledgement')
      }
      if (state !== 'completed' || visibility !== 'pending') {
        throw new ProfileMaintenanceError('GATE_TRANSITION_INCOMPLETE', 'external visibility may only be acknowledged after central completion')
      }
      if (int(row['revision']) !== input.expectedRevision) {
        throw new ProfileMaintenanceError('GATE_STALE', `expected transition revision ${input.expectedRevision} did not match ${int(row['revision'])}`)
      }
      db.prepare("UPDATE profile_maintenance_transitions SET external_visibility = 'acknowledged', local_visible_revision = ?, local_visible_evidence_sha256 = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
        .run(localVisibleRevision, localVisibleEvidence, nowIso(), text(row['id']))
      return receiptSnapshot(db.prepare('SELECT * FROM profile_maintenance_transitions WHERE id = ?').get(text(row['id'])) as Row)
    })
  }

  async listMigrationTransitions(context: AuthenticatedProfileMaintenanceMigrationContext, lease: ProfileMaintenanceLease): Promise<ProfileMaintenanceTransitionReceipt[]> {
    const caller = parseAuthenticatedMigrationContext(context)
    const target = parseProfileMaintenanceLease(lease)
    return this.database.withImmediate(db => {
      this.requireOwnedLease(db, caller, target)
      return this.loadReceipts(db, target.migrationId)
    })
  }

  async recordRetirementFence(context: AuthenticatedProfileMaintenanceMigrationContext, lease: ProfileMaintenanceLease, input: { participant: ProfileMaintenanceParticipant; retiredPath: string; fenceReceiptSha256: string; fsynced: boolean }): Promise<ProfileMaintenanceFenceReceipt> {
    const caller = parseAuthenticatedMigrationContext(context)
    const target = parseProfileMaintenanceLease(lease)
    const parsed = parseProfileMaintenanceRetirement(input)
    return this.database.withImmediate(db => {
      this.requireOwnedLease(db, caller, target)
      const state = this.loadState(db)
      if (state.phase !== 'cutting-over') {
        throw new ProfileMaintenanceError('GATE_PHASE_INVALID', `phase "${state.phase}" cannot publish a retirement/fence receipt`)
      }
      const existing = db.prepare('SELECT * FROM profile_maintenance_retirements WHERE profile_id = ? AND migration_id = ? AND participant = ? AND retired_path = ?')
        .get(this.profileId, target.migrationId, parsed.participant, parsed.retiredPath) as Row | undefined
      if (existing) {
        if (text(existing['fence_receipt_sha256']) !== parsed.fenceReceiptSha256) {
          throw new ProfileMaintenanceError('GATE_CONFLICT', `retirement of ${parsed.retiredPath} was already recorded with different evidence`)
        }
        return fenceSnapshot(existing)
      }
      const id = randomUUID()
      db.prepare('INSERT INTO profile_maintenance_retirements(id, profile_id, migration_id, owner_stage, epoch, participant, retired_path, fence_receipt_sha256, fsynced, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id, this.profileId, target.migrationId, target.ownerStage, target.epoch, parsed.participant, parsed.retiredPath, parsed.fenceReceiptSha256, parsed.fsynced ? 1 : 0, nowIso())
      db.prepare('UPDATE profile_maintenance_state SET irreversible = 1, updated_at = ? WHERE profile_id = ?').run(nowIso(), this.profileId)
      return { id, migrationId: target.migrationId, ownerStage: target.ownerStage, epoch: target.epoch, participant: parsed.participant, retiredPath: parsed.retiredPath, fenceReceiptSha256: parsed.fenceReceiptSha256, fsynced: parsed.fsynced }
    })
  }

  async listRetirementFences(lease: { migrationId: string }): Promise<ProfileMaintenanceFenceReceipt[]> {
    const migrationId = boundedIdentifier(lease?.migrationId, 'migrationId')
    return this.database.withReadOnly(db => {
      const rows = db.prepare('SELECT * FROM profile_maintenance_retirements WHERE profile_id = ? AND migration_id = ? ORDER BY participant, retired_path')
        .all(this.profileId, migrationId) as Row[]
      return rows.map(fenceSnapshot)
    })
  }

  // -- failure, resume, abort, release --------------------------------------

  /**
   * Durable non-open transition. The caller supplies only a bounded code and
   * evidence digest; the gate derives the last safe phase, freezes the
   * source-set digest from persisted transitions and retirements, and records
   * whether any retirement/fence receipt already made rollback irreversible.
   * The lease stays held so `resume`/`abort` can compare-and-set it.
   */
  async fail(context: AuthenticatedAdministratorContext, lease: ProfileMaintenanceLease, failure: ProfileMaintenanceFailure): Promise<ProfileMaintenanceLease> {
    const caller = parseAuthenticatedAdministratorContext(context)
    const target = parseProfileMaintenanceLease(lease)
    const parsed = parseProfileMaintenanceFailure(failure)
    return this.database.withImmediate(db => {
      this.requireOwnedLease(db, caller, target)
      const state = this.loadState(db)
      if (state.phase === 'open' || state.phase === 'failed') {
        throw new ProfileMaintenanceError('GATE_PHASE_INVALID', `phase "${state.phase}" cannot fail`)
      }
      const fences = this.loadFences(db, target.migrationId)
      const receipts = this.loadReceipts(db, target.migrationId)
      const frozen = frozenSourceSetSha256(state.participants, receipts)
      const revision = this.nextRevision(db)
      db.prepare("UPDATE profile_maintenance_state SET phase = 'failed', revision = ?, frozen_source_set_sha256 = ?, safe_phase = ?, irreversible = ?, failure_code = ?, updated_at = ? WHERE profile_id = ?")
        .run(revision, frozen, state.phase, fences.length > 0 ? 1 : 0, parsed.code, nowIso(), this.profileId)
      return { migrationId: target.migrationId, ownerStage: target.ownerStage, epoch: target.epoch, revision }
    })
  }

  async resume(context: AuthenticatedAdministratorContext, input: ProfileMaintenanceResumeInput): Promise<ProfileMaintenanceLease> {
    const caller = parseAuthenticatedAdministratorContext(context)
    const parsed = parseProfileMaintenanceResumeInput(input)
    return this.database.withImmediate(db => {
      const state = this.loadState(db)
      if (state.phase !== 'failed' || state.lease === null) {
        throw new ProfileMaintenanceError('GATE_PHASE_INVALID', `only a failed migration can resume; phase is "${state.phase}"`)
      }
      this.authorizeOwnerStage(caller, state.lease.ownerStage)
      if (state.lease.migrationId !== parsed.migrationId) {
        throw new ProfileMaintenanceError('GATE_NOT_LEASED', `migration ${parsed.migrationId} does not hold the profile maintenance lease`)
      }
      if (state.lease.revision !== parsed.expectedRevision) {
        throw new ProfileMaintenanceError('GATE_STALE', `expected revision ${parsed.expectedRevision} did not match the persisted ${state.lease.revision}`)
      }
      // The frozen source set is recomputed from persisted evidence only: a
      // caller that re-hashed different sources can never satisfy the resume.
      const recomputed = frozenSourceSetSha256(state.participants, this.loadReceipts(db, parsed.migrationId))
      if (recomputed !== parsed.expectedSourceSetSha256) {
        throw new ProfileMaintenanceError('GATE_SOURCE_SET_MISMATCH', 'recomputed frozen source-set digest did not match the persisted snapshot')
      }
      const epoch = state.lease.epoch + 1
      const revision = this.nextRevision(db)
      db.prepare('DELETE FROM profile_maintenance_acknowledgements WHERE profile_id = ? AND migration_id = ?').run(this.profileId, parsed.migrationId)
      // Admissions stay frozen: prior-epoch work is reconciled against the new
      // epoch before participants acknowledge it.
      db.prepare('UPDATE profile_maintenance_state SET phase = ?, epoch = ?, revision = ?, failure_code = NULL, updated_at = ? WHERE profile_id = ?')
        .run(state.safePhase ?? 'freezing', epoch, revision, nowIso(), this.profileId)
      return { migrationId: parsed.migrationId, ownerStage: state.lease.ownerStage, epoch, revision }
    })
  }

  async abort(context: AuthenticatedAdministratorContext, input: ProfileMaintenanceAbortInput): Promise<void> {
    const caller = parseAuthenticatedAdministratorContext(context)
    const parsed = parseProfileMaintenanceAbortInput(input)
    this.database.withImmediate(db => {
      const state = this.loadState(db)
      if (state.phase === 'open' || state.lease === null) {
        throw new ProfileMaintenanceError('GATE_NOT_LEASED', 'there is no migration lease to abort')
      }
      this.authorizeOwnerStage(caller, state.lease.ownerStage)
      if (state.lease.migrationId !== parsed.migrationId) {
        throw new ProfileMaintenanceError('GATE_NOT_LEASED', `migration ${parsed.migrationId} does not hold the profile maintenance lease`)
      }
      if (state.lease.revision !== parsed.expectedRevision) {
        throw new ProfileMaintenanceError('GATE_STALE', `expected revision ${parsed.expectedRevision} did not match the persisted ${state.lease.revision}`)
      }
      if (state.irreversible || this.loadFences(db, parsed.migrationId).length > 0) {
        throw new ProfileMaintenanceError('GATE_IRREVERSIBLE', 'published retirement/fence receipts make rollback irreversible; resume with the exact source set or restore explicitly')
      }
      const live = db.prepare("SELECT COUNT(*) AS count FROM profile_maintenance_admissions WHERE profile_id = ? AND migration_id = ? AND state IN ('active','indeterminate')")
        .get(this.profileId, parsed.migrationId) as Row
      if (int(live['count']) > 0) {
        throw new ProfileMaintenanceError('GATE_ADMISSION_UNRESOLVED', `abort requires zero live admissions; ${int(live['count'])} remain`)
      }
      // The observed digest is audit evidence only: it never changes the phase
      // decision, and the candidate rows are discarded through owner APIs.
      const revision = this.nextRevision(db)
      db.prepare("UPDATE profile_maintenance_state SET phase = 'open', migration_id = NULL, owner_stage = NULL, epoch = 0, revision = ?, participants_json = '[]', frozen_source_set_sha256 = ?, safe_phase = NULL, irreversible = 0, failure_code = 'ABORTED', updated_at = ? WHERE profile_id = ?")
        .run(revision, parsed.observedSourceSetSha256, nowIso(), this.profileId)
    })
    this.onDiscardCandidateState(parsed.migrationId)
  }

  /** `release(..., 'active')` opens admissions on the new authority. */
  async release(context: AuthenticatedAdministratorContext, lease: ProfileMaintenanceLease, outcome: 'active'): Promise<void> {
    const caller = parseAuthenticatedAdministratorContext(context)
    const target = parseProfileMaintenanceLease(lease)
    if (outcome !== 'active') throw new ProfileMaintenanceValidationError('outcome', 'must be "active"')
    this.database.withImmediate(db => {
      this.requireOwnedLease(db, caller, target)
      const state = this.loadState(db)
      if (state.phase !== 'cutting-over') {
        throw new ProfileMaintenanceError('GATE_PHASE_INVALID', `release requires a completed cutover; phase is "${state.phase}"`)
      }
      const live = db.prepare("SELECT COUNT(*) AS count FROM profile_maintenance_admissions WHERE profile_id = ? AND migration_id = ? AND state IN ('active','indeterminate')")
        .get(this.profileId, target.migrationId) as Row
      if (int(live['count']) > 0) {
        throw new ProfileMaintenanceError('GATE_ADMISSION_UNRESOLVED', `release requires zero live admissions; ${int(live['count'])} remain`)
      }
      const receipts = this.loadReceipts(db, target.migrationId)
      // Every frozen participant must have committed its cutover transition:
      // a partial set would reopen admissions with sources still unwritten.
      for (const name of state.participants) {
        if (!receipts.some(receipt => receipt.participant === name && receipt.state === 'completed')) {
          throw new ProfileMaintenanceError('GATE_TRANSITION_INCOMPLETE', `participant "${name}" has no completed migration transition`)
        }
      }
      if (receipts.some(receipt => receipt.externalVisibility === 'pending')) {
        throw new ProfileMaintenanceError('GATE_VISIBILITY_PENDING', 'release requires every external-WAL transition to acknowledge local visibility')
      }
      const revision = this.nextRevision(db)
      db.prepare("UPDATE profile_maintenance_state SET phase = 'open', migration_id = NULL, owner_stage = NULL, epoch = 0, revision = ?, participants_json = '[]', frozen_source_set_sha256 = NULL, safe_phase = NULL, irreversible = 0, failure_code = NULL, updated_at = ? WHERE profile_id = ?")
        .run(revision, nowIso(), this.profileId)
    })
  }

  // -- internal validation ---------------------------------------------------

  private storedRevision(db: DatabaseSync): number {
    const row = this.ensureState(db)
    return int(row['revision'])
  }

  private nextRevision(db: DatabaseSync): number {
    const current = this.storedRevision(db)
    const revision = current + 1
    if (!Number.isSafeInteger(revision)) throw new ProfileMaintenanceError('GATE_CONFLICT', 'profile maintenance revision overflowed')
    return revision
  }

  private authorizeOwnerStage(caller: AuthenticatedAdministratorContext, ownerStage: ProfileMaintenanceOwnerStage): void {
    if (caller.ownerStage !== undefined && caller.ownerStage !== ownerStage) {
      throw new ProfileMaintenanceError('GATE_STAGE_UNAUTHORIZED', `authenticated migration coordinator owns ${caller.ownerStage} and may not act on a ${ownerStage} migration`)
    }
  }

  private requireOwnedLease(db: DatabaseSync, caller: AuthenticatedAdministratorContext, lease: ProfileMaintenanceLease): void {
    const state = this.loadState(db)
    if (state.lease === null || state.phase === 'open') {
      throw new ProfileMaintenanceError('GATE_NOT_LEASED', 'no profile maintenance lease is held')
    }
    this.authorizeOwnerStage(caller, state.lease.ownerStage)
    if (state.lease.migrationId !== lease.migrationId || state.lease.ownerStage !== lease.ownerStage) {
      throw new ProfileMaintenanceError('GATE_NOT_LEASED', `migration ${lease.migrationId} does not hold the profile maintenance lease`)
    }
    if (state.lease.epoch !== lease.epoch || state.lease.revision !== lease.revision) {
      throw new ProfileMaintenanceError('GATE_STALE', `lease epoch ${lease.epoch} revision ${lease.revision} did not match the persisted epoch ${state.lease.epoch} revision ${state.lease.revision}`)
    }
  }

  private requireTransition(db: DatabaseSync, caller: AuthenticatedProfileMaintenanceMigrationContext, receipt: ProfileMaintenanceTransitionReceipt): Row {
    const state = this.loadState(db)
    if (state.lease === null || state.phase === 'open') {
      throw new ProfileMaintenanceError('GATE_NOT_LEASED', 'no profile maintenance lease is held')
    }
    this.authorizeOwnerStage(caller, state.lease.ownerStage)
    const row = db.prepare('SELECT * FROM profile_maintenance_transitions WHERE id = ? AND profile_id = ?').get(receipt.id, this.profileId) as Row | undefined
    if (!row || text(row['migration_id']) !== receipt.migrationId) {
      throw new ProfileMaintenanceError('GATE_NOT_LEASED', `transition ${receipt.id} does not belong to migration ${receipt.migrationId}`)
    }
    if (text(row['owner_stage']) !== state.lease.ownerStage) {
      throw new ProfileMaintenanceError('GATE_STAGE_UNAUTHORIZED', `transition ${receipt.id} belongs to owner stage ${text(row['owner_stage'])}`)
    }
    if (int(row['epoch']) !== receipt.epoch || int(row['revision']) !== receipt.revision) {
      throw new ProfileMaintenanceError('GATE_STALE', `transition ${receipt.id} revision changed; re-read the receipt before acting`)
    }
    return row
  }

  private loadReceipts(db: DatabaseSync, migrationId: string): ProfileMaintenanceTransitionReceipt[] {
    const rows = db.prepare('SELECT * FROM profile_maintenance_transitions WHERE profile_id = ? AND migration_id = ?').all(this.profileId, migrationId) as Row[]
    return rows.map(receiptSnapshot)
  }

  private loadFences(db: DatabaseSync, migrationId: string): ProfileMaintenanceFenceReceipt[] {
    const rows = db.prepare('SELECT * FROM profile_maintenance_retirements WHERE profile_id = ? AND migration_id = ?').all(this.profileId, migrationId) as Row[]
    return rows.map(fenceSnapshot)
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function text(value: unknown): string {
  return String(value)
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function int(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new ProfileMaintenanceError('GATE_CONFLICT', 'persisted profile maintenance value was not a safe integer')
  return parsed
}

function bool(value: unknown): boolean {
  return value === 1 || value === true
}

function boundedIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > PROFILE_MAINTENANCE_MAX_IDENTIFIER || value.includes('\0')) {
    throw new ProfileMaintenanceValidationError(field, `must be a non-empty string of at most ${PROFILE_MAINTENANCE_MAX_IDENTIFIER} characters`)
  }
  return value
}

function boundedDigest(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new ProfileMaintenanceValidationError(field, 'must be a lowercase hex sha256 digest')
  }
  return value
}

function requireAdminRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new ProfileMaintenanceValidationError('expectedRevision', 'must be a positive integer')
  }
  return value
}

function safePhaseOf(value: unknown): ProfileMaintenancePhase | null {
  if (value === null || value === undefined) return null
  const phase = String(value)
  if (PHASES[phase] !== true || phase === 'open' || phase === 'failed') {
    throw new ProfileMaintenanceError('GATE_PHASE_INVALID', `persisted safe phase "${phase}" was unrecognized`)
  }
  return phase as ProfileMaintenancePhase
}

function parseParticipants(value: string): ProfileMaintenanceParticipant[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new ProfileMaintenanceError('GATE_CONFLICT', 'persisted participant set was not valid JSON')
  }
  if (!Array.isArray(parsed)) throw new ProfileMaintenanceError('GATE_CONFLICT', 'persisted participant set was not an array')
  const participants = parsed.map(entry => parseProfileMaintenanceParticipant(entry, 'participants'))
  return participants
}

function admissionSnapshot(row: Row): ProfileMaintenanceAdmission {
  return {
    participant: parseProfileMaintenanceParticipant(text(row['participant'])),
    operationId: text(row['operation_id']),
    epoch: int(row['epoch']),
    ownerConnectionId: text(row['owner_connection_id'])
  }
}

function receiptSnapshot(row: Row): ProfileMaintenanceTransitionReceipt {
  const visibilityMode = text(row['visibility_mode'])
  if (visibilityMode !== 'central' && visibilityMode !== 'external-wal') {
    throw new ProfileMaintenanceError('GATE_CONFLICT', 'persisted transition visibility mode was unrecognized')
  }
  return {
    id: text(row['id']),
    migrationId: text(row['migration_id']),
    ownerStage: parseProfileMaintenanceOwnerStage(text(row['owner_stage'])),
    epoch: int(row['epoch']),
    participant: parseProfileMaintenanceParticipant(text(row['participant'])),
    operationId: text(row['operation_id']),
    sourceSha256: text(row['source_sha256']),
    intentSha256: text(row['intent_sha256']),
    visibilityMode,
    state: text(row['state']) === 'completed' ? 'completed' : 'prepared',
    externalVisibility: externalVisibilityOf(text(row['external_visibility'])),
    localVisibleRevision: textOrNull(row['local_visible_revision']),
    localVisibleEvidenceSha256: textOrNull(row['local_visible_evidence_sha256']),
    revision: int(row['revision'])
  }
}

function externalVisibilityOf(value: string): ProfileMaintenanceTransitionReceipt['externalVisibility'] {
  if (value === 'not-required' || value === 'pending' || value === 'acknowledged') return value
  throw new ProfileMaintenanceError('GATE_CONFLICT', 'persisted external visibility was unrecognized')
}

function fenceSnapshot(row: Row): ProfileMaintenanceFenceReceipt {
  return {
    id: text(row['id']),
    migrationId: text(row['migration_id']),
    ownerStage: parseProfileMaintenanceOwnerStage(text(row['owner_stage'])),
    epoch: int(row['epoch']),
    participant: parseProfileMaintenanceParticipant(text(row['participant'])),
    retiredPath: boundedPathValue(text(row['retired_path'])),
    fenceReceiptSha256: text(row['fence_receipt_sha256']),
    fsynced: bool(row['fsynced'])
  }
}

function boundedPathValue(value: string): string {
  if (value.length === 0 || value.length > PROFILE_MAINTENANCE_MAX_PATH) {
    throw new ProfileMaintenanceError('GATE_CONFLICT', 'persisted retired path was out of bounds')
  }
  return value
}
