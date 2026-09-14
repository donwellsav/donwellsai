import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  frozenSourceSetSha256,
  parseProfileMaintenanceParticipantSet,
  PROFILE_MAINTENANCE_PARTICIPANTS,
  ProfileMaintenanceError,
  type AuthenticatedAdministratorContext,
  type AuthenticatedCallerContext,
  type AuthenticatedProfileMaintenanceMigrationContext,
  type AuthenticatedProfileMaintenanceParticipantContext,
  type ProfileMaintenanceLease,
  type ProfileMaintenanceParticipant,
  type ProfileMaintenanceTransitionIntent
} from '@shared/profile-maintenance'
import { openTaskAuthorityDatabase, type TaskAuthorityDatabase } from './task-authority/schema'
import type { RuntimeAuthorityLock } from '@shared/runtime-file-security'
import { SqliteProfileMaintenanceGate } from './profile-maintenance-gate'

const PROFILE = 'profile-main'
const COORDINATOR: AuthenticatedAdministratorContext = { connectionId: 'conn-coordinator', ownerStage: 'stage-2' }
const OTHER_STAGE_COORDINATOR: AuthenticatedAdministratorContext = { connectionId: 'conn-stage-4', ownerStage: 'stage-4' }
const MIGRATION_OWNER: AuthenticatedProfileMaintenanceMigrationContext = { connectionId: 'conn-coordinator', ownerStage: 'stage-2' }

const participant = (name: ProfileMaintenanceParticipant, connectionId = `conn-${name}`): AuthenticatedProfileMaintenanceParticipantContext =>
  ({ connectionId, participant: name })
const caller = (connectionId: string, name?: ProfileMaintenanceParticipant): AuthenticatedCallerContext =>
  name === undefined ? { connectionId } : { connectionId, participant: name }

const SHA = (digit: string): string => digit.repeat(64)
/** Two gate instances on one file must arbitrate through BEGIN IMMEDIATE alone. */
const passThroughLock: RuntimeAuthorityLock = (path, callback) => callback(path)

const directories: string[] = []
const databases: TaskAuthorityDatabase[] = []
const discarded: string[] = []

function openGate(profileId = PROFILE, onDiscard?: (migrationId: string) => void): SqliteProfileMaintenanceGate {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'profile-gate-')))
  directories.push(directory)
  const database = openTaskAuthorityDatabase({ databasePath: join(directory, 'task-authority.sqlite'), authorityLock: passThroughLock })
  databases.push(database)
  return new SqliteProfileMaintenanceGate({ database, profileId, onDiscardCandidateState: onDiscard ?? (migrationId => { discarded.push(migrationId) }) })
}

function onSameDatabase(): SqliteProfileMaintenanceGate {
  const database = databases[0]
  if (!database) throw new Error('expected an open database')
  return new SqliteProfileMaintenanceGate({ database, profileId: PROFILE })
}

beforeEach(() => { discarded.length = 0 })

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close()
  while (directories.length > 0) rmSync(directories.pop() as string, { recursive: true, force: true })
})

async function acquired(gate: SqliteProfileMaintenanceGate, participants: readonly ProfileMaintenanceParticipant[] = ['task-authority']): Promise<ProfileMaintenanceLease> {
  const lease = await gate.acquire(COORDINATOR, { migrationId: 'migration-1', ownerStage: 'stage-2', participants: parseProfileMaintenanceParticipantSet([...participants]), expectedRevision: 1 })
  await gate.freeze(COORDINATOR, lease)
  return lease
}

async function acknowledged(gate: SqliteProfileMaintenanceGate, lease: ProfileMaintenanceLease, participants: readonly ProfileMaintenanceParticipant[]): Promise<void> {
  for (const name of participants) await gate.acknowledgeDrained(participant(name), lease.migrationId)
}

describe('profile maintenance admission', () => {
  it('fails closed outside open and never lets caller-supplied identity substitute for the authenticated connection', async () => {
    const gate = openGate()
    expect(gate.readState()).toMatchObject({ phase: 'open', lease: null, participants: [] })

    const admission = await gate.admit(caller('conn-a'), 'task-authority', 'op-1')
    expect(admission).toEqual({ participant: 'task-authority', operationId: 'op-1', epoch: 1, ownerConnectionId: 'conn-a' })
    await expect(gate.complete(caller('conn-b'), admission, 'completed')).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' })
    await gate.complete(caller('conn-a'), admission, 'completed')

    // A participant-bound connection may only admit its own participant's work.
    await expect(gate.admit(caller('conn-a', 'task-authority'), 'derived-knowledge', 'op-2')).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' })
    expect(await gate.admit(caller('conn-a', 'task-authority'), 'task-authority', 'op-3')).toMatchObject({ participant: 'task-authority' })

    const lease = await acquired(gate)
    await expect(gate.admit(caller('conn-a'), 'task-authority', 'op-4')).rejects.toMatchObject({ code: 'GATE_NOT_OPEN' })
    await expect(gate.acquire(COORDINATOR, { migrationId: 'migration-2', ownerStage: 'stage-2', participants: ['task-authority'], expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'GATE_LEASED' })
    void lease
  })

  it('adopts outstanding pre-migration admissions into the new migration as its drain set', async () => {
    const gate = openGate()
    const before = await gate.admit(caller('conn-a'), 'task-authority', 'op-before')
    const lease = await acquired(gate)

    await expect(gate.acknowledgeDrained(participant('task-authority', 'conn-a'), lease.migrationId))
      .rejects.toMatchObject({ code: 'GATE_ADMISSION_UNRESOLVED' })
    await gate.complete(caller('conn-a'), before, 'completed')
    await acknowledged(gate, lease, ['task-authority'])
    await expect(gate.beginCutover(COORDINATOR, lease)).resolves.toBeUndefined()
  })

  it('marks a disconnected connection indeterminate and lets only that participant connection reconcile it', async () => {
    const gate = openGate()
    await gate.admit(caller('conn-a'), 'task-authority', 'op-live')
    await gate.markConnectionDisconnected('conn-a')
    // The lease adopts the outstanding admission into its own migration.
    const lease = await acquired(gate)

    const owned = await gate.listOwnedAdmissions(participant('task-authority', 'conn-a'), lease.migrationId)
    expect(owned).toEqual([{ participant: 'task-authority', operationId: 'op-live', epoch: lease.epoch, ownerConnectionId: 'conn-a' }])
    // Another connection, and another participant on the same connection, see nothing of that set.
    expect(await gate.listOwnedAdmissions(participant('task-authority', 'conn-b'), lease.migrationId)).toEqual([])
    expect(await gate.listOwnedAdmissions(participant('derived-knowledge', 'conn-a'), lease.migrationId)).toEqual([])

    await expect(gate.reconcileOwnedAdmissions(participant('task-authority', 'conn-a'), lease.migrationId, []))
      .rejects.toMatchObject({ code: 'GATE_CONFLICT' })
    await expect(gate.reconcileOwnedAdmissions(participant('task-authority', 'conn-a'), lease.migrationId, [
      { operationId: 'op-live', epoch: lease.epoch, outcome: 'active', evidenceSha256: SHA('a') },
      { operationId: 'op-ghost', epoch: lease.epoch, outcome: 'completed', evidenceSha256: SHA('b') }
    ])).rejects.toMatchObject({ code: 'GATE_CONFLICT' })
    await expect(gate.reconcileOwnedAdmissions(participant('task-authority', 'conn-a'), lease.migrationId, [
      { operationId: 'op-live', epoch: lease.epoch + 1, outcome: 'active', evidenceSha256: SHA('a') }
    ])).rejects.toMatchObject({ code: 'GATE_CONFLICT' })
    await expect(gate.reconcileOwnedAdmissions(participant('task-authority', 'conn-a'), lease.migrationId, [
      { operationId: 'op-live', epoch: lease.epoch, outcome: 'active', evidenceSha256: SHA('a') },
      { operationId: 'op-live', epoch: lease.epoch, outcome: 'active', evidenceSha256: SHA('a') }
    ])).rejects.toBeInstanceOf(Error)

    await gate.reconcileOwnedAdmissions(participant('task-authority', 'conn-a'), lease.migrationId, [
      { operationId: 'op-live', epoch: lease.epoch, outcome: 'indeterminate', evidenceSha256: SHA('a') }
    ])
    expect(await gate.listOwnedAdmissions(participant('task-authority', 'conn-a'), lease.migrationId)).toHaveLength(1)
    await gate.reconcileOwnedAdmissions(participant('task-authority', 'conn-a'), lease.migrationId, [
      { operationId: 'op-live', epoch: lease.epoch, outcome: 'completed', evidenceSha256: SHA('c') }
    ])
    expect(await gate.listOwnedAdmissions(participant('task-authority', 'conn-a'), lease.migrationId)).toEqual([])
  })

  it('races two connections on one profile to exactly one lease', async () => {
    const gate = openGate()
    const input = { migrationId: 'migration-1', ownerStage: 'stage-2' as const, participants: parseProfileMaintenanceParticipantSet(['task-authority']), expectedRevision: 1 }
    const results = await Promise.allSettled([gate.acquire(COORDINATOR, input), onSameDatabase().acquire(COORDINATOR, input)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(gate.readState().phase).toBe('freezing')
  })

  it('requires every frozen participant to acknowledge the current epoch before cutover', async () => {
    const gate = openGate()
    const lease = await acquired(gate, ['task-authority', 'derived-knowledge'])
    await acknowledged(gate, lease, ['task-authority'])
    await expect(gate.beginCutover(COORDINATOR, lease)).rejects.toMatchObject({ code: 'GATE_ADMISSION_UNRESOLVED' })
    await expect(gate.acknowledgeDrained(participant('provider-authority'), lease.migrationId))
      .rejects.toMatchObject({ code: 'GATE_PARTICIPANT_MISMATCH' })
    await acknowledged(gate, lease, ['derived-knowledge'])
    await gate.beginCutover(COORDINATOR, lease)
    expect(gate.readState().phase).toBe('cutting-over')
  })

  it('binds every admin call to the exact owner stage, migration, epoch, and revision', async () => {
    const gate = openGate()
    const lease = await acquired(gate)
    await acknowledged(gate, lease, ['task-authority'])

    await expect(gate.beginCutover(OTHER_STAGE_COORDINATOR, lease)).rejects.toMatchObject({ code: 'GATE_STAGE_UNAUTHORIZED' })
    await expect(gate.beginCutover(COORDINATOR, { ...lease, revision: lease.revision + 5 })).rejects.toMatchObject({ code: 'GATE_STALE' })
    await expect(gate.beginCutover(COORDINATOR, { ...lease, migrationId: 'migration-other' })).rejects.toMatchObject({ code: 'GATE_NOT_LEASED' })
    await expect(gate.beginCutover(COORDINATOR, { ...lease, epoch: lease.epoch + 1 })).rejects.toMatchObject({ code: 'GATE_STALE' })
    // Two independent gate instances share the same durable state.
    await expect(onSameDatabase().beginCutover(COORDINATOR, { ...lease, migrationId: 'migration-other' })).rejects.toMatchObject({ code: 'GATE_NOT_LEASED' })
    await gate.beginCutover(COORDINATOR, lease)
  })

  it('rejects malformed participant sets and unknown keys before any durable change', async () => {
    const gate = openGate()
    expect(() => parseProfileMaintenanceParticipantSet(['task-authority', 'task-authority'])).toThrow()
    expect(() => parseProfileMaintenanceParticipantSet([])).toThrow()
    expect(() => parseProfileMaintenanceParticipantSet(['not-a-participant'])).toThrow()
    expect(parseProfileMaintenanceParticipantSet(PROFILE_MAINTENANCE_PARTICIPANTS)).toHaveLength(PROFILE_MAINTENANCE_PARTICIPANTS.length)
    await expect(gate.acquire(COORDINATOR, { migrationId: 'migration-1', ownerStage: 'stage-2', participants: ['task-authority', 'task-authority'], expectedRevision: 1 }))
      .rejects.toBeInstanceOf(Error)
    await expect(gate.acquire(COORDINATOR, { migrationId: 'migration-1', ownerStage: 'stage-2', participants: ['task-authority'], expectedRevision: 1, extra: true } as never))
      .rejects.toBeInstanceOf(Error)
    // The reserved pre-migration id cannot be leased.
    await expect(gate.acquire(COORDINATOR, { migrationId: 'unmigrated', ownerStage: 'stage-2', participants: ['task-authority'], expectedRevision: 1 }))
      .rejects.toBeInstanceOf(Error)
    expect(gate.readState()).toMatchObject({ phase: 'open', lease: null })
  })
})

const CENTRAL: ProfileMaintenanceTransitionIntent = { participant: 'task-authority', operationId: 'transition-central', sourceSha256: SHA('1'), intentSha256: SHA('2'), visibilityMode: 'central' }
const EXTERNAL: ProfileMaintenanceTransitionIntent = { participant: 'derived-knowledge', operationId: 'transition-external', sourceSha256: SHA('3'), intentSha256: SHA('4'), visibilityMode: 'external-wal' }

describe('profile maintenance migration transitions', () => {
  it('completes central transitions and keeps external receipts pending until visibility is acknowledged', async () => {
    const gate = openGate()
    const lease = await acquired(gate, ['task-authority', 'derived-knowledge'])
    await acknowledged(gate, lease, ['task-authority', 'derived-knowledge'])
    await gate.beginCutover(COORDINATOR, lease)

    await expect(gate.release(COORDINATOR, lease, 'active')).rejects.toMatchObject({ code: 'GATE_TRANSITION_INCOMPLETE' })

    const prepared = await gate.prepareMigrationTransition(MIGRATION_OWNER, lease, CENTRAL)
    expect(prepared).toMatchObject({ state: 'prepared', externalVisibility: 'not-required', revision: 1 })
    expect(await gate.prepareMigrationTransition(MIGRATION_OWNER, lease, CENTRAL)).toEqual(prepared)
    await expect(gate.prepareMigrationTransition(MIGRATION_OWNER, lease, { ...CENTRAL, intentSha256: SHA('9') }))
      .rejects.toMatchObject({ code: 'GATE_CONFLICT' })

    const completed = await gate.completeMigrationTransition(MIGRATION_OWNER, prepared, SHA('5'))
    expect(completed).toMatchObject({ state: 'completed', externalVisibility: 'not-required', revision: 2 })
    expect(await gate.completeMigrationTransition(MIGRATION_OWNER, completed, SHA('5'))).toEqual(completed)
    await expect(gate.completeMigrationTransition(MIGRATION_OWNER, completed, SHA('6'))).rejects.toMatchObject({ code: 'GATE_CONFLICT' })
    await expect(gate.release(COORDINATOR, lease, 'active')).rejects.toMatchObject({ code: 'GATE_TRANSITION_INCOMPLETE' })

    const external = await gate.prepareMigrationTransition(MIGRATION_OWNER, lease, EXTERNAL)
    expect(await gate.listMigrationTransitions(MIGRATION_OWNER, lease)).toHaveLength(2)
    const externalDone = await gate.completeMigrationTransition(MIGRATION_OWNER, external, SHA('6'))
    expect(externalDone.externalVisibility).toBe('pending')
    // Central-complete/local-pending must not reopen admissions or handlers.
    await expect(gate.release(COORDINATOR, lease, 'active')).rejects.toMatchObject({ code: 'GATE_VISIBILITY_PENDING' })
    await expect(gate.admit(caller('conn-a'), 'task-authority', 'op-late')).rejects.toMatchObject({ code: 'GATE_NOT_OPEN' })
    const visibility = { expectedRevision: externalDone.revision, localVisibleRevision: 'rev-9', localVisibleEvidenceSha256: SHA('7') }
    const acknowledgedReceipt = await gate.acknowledgeExternalVisibility(MIGRATION_OWNER, externalDone, visibility)
    expect(acknowledgedReceipt).toMatchObject({ externalVisibility: 'acknowledged', localVisibleRevision: 'rev-9', revision: 3 })
    expect(await gate.acknowledgeExternalVisibility(MIGRATION_OWNER, acknowledgedReceipt, visibility)).toEqual(acknowledgedReceipt)
    await expect(gate.acknowledgeExternalVisibility(MIGRATION_OWNER, acknowledgedReceipt, { ...visibility, localVisibleRevision: 'rev-10' }))
      .rejects.toMatchObject({ code: 'GATE_CONFLICT' })

    await gate.release(COORDINATOR, lease, 'active')
    expect(gate.readState()).toMatchObject({ phase: 'open', lease: null })
    await expect(gate.admit(caller('conn-a'), 'task-authority', 'op-after')).resolves.toBeDefined()
  })

  it('refuses visibility acknowledgement before completion and binds owner stage and revision', async () => {
    const gate = openGate()
    const lease = await acquired(gate, ['task-authority', 'derived-knowledge'])
    await acknowledged(gate, lease, ['task-authority', 'derived-knowledge'])
    await gate.beginCutover(COORDINATOR, lease)

    await expect(gate.prepareMigrationTransition(MIGRATION_OWNER, lease, CENTRAL)).resolves.toBeDefined()
    await expect(gate.prepareMigrationTransition(MIGRATION_OWNER, lease, { ...CENTRAL, participant: 'provider-authority' }))
      .rejects.toMatchObject({ code: 'GATE_PARTICIPANT_MISMATCH' })
    await expect(gate.prepareMigrationTransition({ connectionId: 'conn-stage-4', ownerStage: 'stage-4' }, lease, CENTRAL))
      .rejects.toMatchObject({ code: 'GATE_STAGE_UNAUTHORIZED' })

    const prepared = await gate.prepareMigrationTransition(MIGRATION_OWNER, lease, EXTERNAL)
    await expect(gate.acknowledgeExternalVisibility(MIGRATION_OWNER, prepared, { expectedRevision: 1, localVisibleRevision: 'rev-1', localVisibleEvidenceSha256: SHA('7') }))
      .rejects.toMatchObject({ code: 'GATE_TRANSITION_INCOMPLETE' })

    const completed = await gate.completeMigrationTransition(MIGRATION_OWNER, prepared, SHA('8'))
    await expect(gate.acknowledgeExternalVisibility(MIGRATION_OWNER, completed, { expectedRevision: 1, localVisibleRevision: 'rev-1', localVisibleEvidenceSha256: SHA('7') }))
      .rejects.toMatchObject({ code: 'GATE_STALE' })
    // A stale receipt copy is rejected: the caller must re-read the receipt.
    await expect(gate.completeMigrationTransition(MIGRATION_OWNER, { ...prepared, revision: 99 }, SHA('8')))
      .rejects.toMatchObject({ code: 'GATE_STALE' })
    await expect(gate.acknowledgeExternalVisibility(MIGRATION_OWNER, completed, { expectedRevision: completed.revision, localVisibleRevision: 'rev-1', localVisibleEvidenceSha256: SHA('7') }))
      .resolves.toBeDefined()
  })

  it('refuses post-drain work outside the migration-owner seam', async () => {
    const gate = openGate()
    const lease = await acquired(gate, ['task-authority', 'derived-knowledge'])
    await acknowledged(gate, lease, ['task-authority', 'derived-knowledge'])
    await expect(gate.prepareMigrationTransition(MIGRATION_OWNER, lease, CENTRAL)).rejects.toMatchObject({ code: 'GATE_PHASE_INVALID' })
    await gate.beginCutover(COORDINATOR, lease)
    await expect(gate.prepareMigrationTransition(MIGRATION_OWNER, lease, { ...CENTRAL, participant: 'project-tools' }))
      .rejects.toMatchObject({ code: 'GATE_PARTICIPANT_MISMATCH' })
    await expect(gate.admit(caller('conn-a'), 'task-authority', 'op-late')).rejects.toMatchObject({ code: 'GATE_NOT_OPEN' })
  })
})

describe('profile maintenance failure, resume, and abort', () => {
  it('keeps a failed gate non-open across reopen and resumes only with the exact frozen digest on the owning stage', async () => {
    const gate = openGate()
    const lease = await acquired(gate)
    await acknowledged(gate, lease, ['task-authority'])

    const failed = await gate.fail(COORDINATOR, lease, { code: 'MIGRATION_INTERRUPTED', evidenceSha256: SHA('a') })
    expect(failed.revision).toBeGreaterThan(lease.revision)
    expect(gate.readState()).toMatchObject({ phase: 'failed', safePhase: 'draining', failureCode: 'MIGRATION_INTERRUPTED', irreversible: false })
    // A restart re-reads the durable phase: still non-open, no affected handler work.
    expect(onSameDatabase().readState().phase).toBe('failed')
    await expect(gate.admit(caller('conn-a'), 'task-authority', 'op-during-failure')).rejects.toMatchObject({ code: 'GATE_NOT_OPEN' })

    const expected = frozenSourceSetSha256(['task-authority'], [])
    await expect(gate.resume(OTHER_STAGE_COORDINATOR, { migrationId: 'migration-1', expectedRevision: failed.revision, expectedSourceSetSha256: expected }))
      .rejects.toMatchObject({ code: 'GATE_STAGE_UNAUTHORIZED' })
    await expect(gate.resume(COORDINATOR, { migrationId: 'migration-1', expectedRevision: failed.revision + 1, expectedSourceSetSha256: expected }))
      .rejects.toMatchObject({ code: 'GATE_STALE' })
    await expect(gate.resume(COORDINATOR, { migrationId: 'migration-other', expectedRevision: failed.revision, expectedSourceSetSha256: expected }))
      .rejects.toMatchObject({ code: 'GATE_NOT_LEASED' })
    await expect(gate.resume(COORDINATOR, { migrationId: 'migration-1', expectedRevision: failed.revision, expectedSourceSetSha256: SHA('f') }))
      .rejects.toMatchObject({ code: 'GATE_SOURCE_SET_MISMATCH' })
    // A mismatch is never accepted as the old snapshot.
    expect(gate.readState()).toMatchObject({ phase: 'failed' })

    const resumed = await gate.resume(COORDINATOR, { migrationId: 'migration-1', expectedRevision: failed.revision, expectedSourceSetSha256: expected })
    expect(resumed).toMatchObject({ migrationId: lease.migrationId, ownerStage: 'stage-2', epoch: lease.epoch + 1 })
    // Old acknowledgements are cleared: the new epoch needs its own.
    await expect(gate.beginCutover(COORDINATOR, resumed)).rejects.toMatchObject({ code: 'GATE_ADMISSION_UNRESOLVED' })
    await acknowledged(gate, resumed, ['task-authority'])
    await expect(gate.beginCutover(COORDINATOR, resumed)).resolves.toBeUndefined()
  })

  it('recomputes the frozen digest from persisted transitions, so changed evidence blocks resume', async () => {
    const gate = openGate()
    const lease = await acquired(gate, ['task-authority', 'derived-knowledge'])
    await acknowledged(gate, lease, ['task-authority', 'derived-knowledge'])
    await gate.beginCutover(COORDINATOR, lease)
    const prepared = await gate.prepareMigrationTransition(MIGRATION_OWNER, lease, CENTRAL)
    const completed = await gate.completeMigrationTransition(MIGRATION_OWNER, prepared, SHA('5'))
    const failed = await gate.fail(COORDINATOR, lease, { code: 'MIGRATION_INTERRUPTED', evidenceSha256: SHA('a') })

    const expected = frozenSourceSetSha256(['derived-knowledge', 'task-authority'], [completed])
    await expect(gate.resume(COORDINATOR, { migrationId: 'migration-1', expectedRevision: failed.revision, expectedSourceSetSha256: expected }))
      .resolves.toMatchObject({ epoch: lease.epoch + 1 })
  })

  it('fails from every leased phase, records the safe phase, and replays resume idempotently', async () => {
    for (const at of ['freezing', 'draining', 'cutting-over'] as const) {
      const gate = openGate()
      const lease = await acquired(gate)
      if (at !== 'freezing') await acknowledged(gate, lease, ['task-authority'])
      if (at === 'cutting-over') await gate.beginCutover(COORDINATOR, lease)

      const current = gate.readState().lease
      if (!current) throw new Error('expected a held lease')
      const failed = await gate.fail(COORDINATOR, current, { code: 'MIGRATION_INTERRUPTED', evidenceSha256: SHA('b') })
      expect(gate.readState().safePhase).toBe(at)
      await expect(gate.fail(COORDINATOR, failed, { code: 'MIGRATION_INTERRUPTED', evidenceSha256: SHA('c') }))
        .rejects.toMatchObject({ code: 'GATE_PHASE_INVALID' })

      const resumed = await gate.resume(COORDINATOR, { migrationId: 'migration-1', expectedRevision: failed.revision, expectedSourceSetSha256: frozenSourceSetSha256(['task-authority'], []) })
      expect(gate.readState()).toMatchObject({ phase: at, lease: { epoch: 2 } })
      expect(resumed.epoch).toBe(2)
      await expect(gate.resume(COORDINATOR, { migrationId: 'migration-1', expectedRevision: failed.revision, expectedSourceSetSha256: frozenSourceSetSha256(['task-authority'], []) }))
        .rejects.toMatchObject({ code: 'GATE_PHASE_INVALID' })
      await acknowledged(gate, resumed, ['task-authority'])
      await expect(gate.beginCutover(COORDINATOR, resumed)).resolves.toBeUndefined()
      // A replayed cutover is idempotent on the current lease.
      await expect(gate.beginCutover(COORDINATOR, resumed)).resolves.toBeUndefined()
    }
  })

  it('aborts to legacy writers only before irreversibility and only with zero unresolved admissions', async () => {
    const gate = openGate()
    // Work admitted before the lease is adopted by it, so it must be resolved
    // before legacy writers may be restored.
    const live = await gate.admit(caller('conn-a'), 'task-authority', 'op-live')
    const lease = await acquired(gate)
    await expect(gate.abort(COORDINATOR, { migrationId: 'migration-1', expectedRevision: lease.revision, observedSourceSetSha256: SHA('1') }))
      .rejects.toMatchObject({ code: 'GATE_ADMISSION_UNRESOLVED' })
    await gate.complete(caller('conn-a'), live, 'cancelled')
    await expect(gate.abort(COORDINATOR, { migrationId: 'migration-1', expectedRevision: lease.revision + 3, observedSourceSetSha256: SHA('1') }))
      .rejects.toMatchObject({ code: 'GATE_STALE' })
    await expect(gate.abort(OTHER_STAGE_COORDINATOR, { migrationId: 'migration-1', expectedRevision: lease.revision, observedSourceSetSha256: SHA('1') }))
      .rejects.toMatchObject({ code: 'GATE_STAGE_UNAUTHORIZED' })

    await gate.abort(COORDINATOR, { migrationId: 'migration-1', expectedRevision: lease.revision, observedSourceSetSha256: SHA('1') })
    expect(gate.readState()).toMatchObject({ phase: 'open', lease: null, failureCode: 'ABORTED' })
    expect(discarded).toEqual(['migration-1'])
    // Legacy writers are live again, and the same migration id may be re-leased.
    await expect(gate.admit(caller('conn-a'), 'task-authority', 'op-after-abort')).resolves.toBeDefined()
    const released = gate.readState().revision
    await expect(gate.acquire(COORDINATOR, { migrationId: 'migration-1', ownerStage: 'stage-2', participants: ['task-authority'], expectedRevision: released }))
      .resolves.toMatchObject({ migrationId: 'migration-1' })
  })

  it('forbids abort once a retirement/fence receipt has published', async () => {
    const gate = openGate()
    const lease = await acquired(gate)
    await acknowledged(gate, lease, ['task-authority'])
    await gate.beginCutover(COORDINATOR, lease)

    const fence = await gate.recordRetirementFence(MIGRATION_OWNER, lease, { participant: 'task-authority', retiredPath: '/profile/orchestrations.json', fenceReceiptSha256: SHA('e'), fsynced: true })
    expect(fence).toMatchObject({ fsynced: true, retiredPath: '/profile/orchestrations.json' })
    expect(await gate.listRetirementFences({ migrationId: 'migration-1' })).toHaveLength(1)
    expect(await gate.recordRetirementFence(MIGRATION_OWNER, lease, { participant: 'task-authority', retiredPath: '/profile/orchestrations.json', fenceReceiptSha256: SHA('e'), fsynced: true })).toEqual(fence)
    await expect(gate.recordRetirementFence(MIGRATION_OWNER, lease, { participant: 'task-authority', retiredPath: '/profile/orchestrations.json', fenceReceiptSha256: SHA('f'), fsynced: true }))
      .rejects.toMatchObject({ code: 'GATE_CONFLICT' })
    expect(gate.readState().irreversible).toBe(true)

    const current = gate.readState().lease
    if (!current) throw new Error('expected a held lease')
    await expect(gate.abort(COORDINATOR, { migrationId: 'migration-1', expectedRevision: current.revision, observedSourceSetSha256: SHA('1') }))
      .rejects.toMatchObject({ code: 'GATE_IRREVERSIBLE' })
    const failed = await gate.fail(COORDINATOR, current, { code: 'MIGRATION_INTERRUPTED', evidenceSha256: SHA('d') })
    expect(gate.readState().irreversible).toBe(true)
    await expect(gate.abort(COORDINATOR, { migrationId: 'migration-1', expectedRevision: failed.revision, observedSourceSetSha256: SHA('1') }))
      .rejects.toMatchObject({ code: 'GATE_IRREVERSIBLE' })
    // Exact-source resume is still the only way forward.
    await expect(gate.resume(COORDINATOR, { migrationId: 'migration-1', expectedRevision: failed.revision, expectedSourceSetSha256: frozenSourceSetSha256(['task-authority'], []) }))
      .resolves.toMatchObject({ epoch: 2 })
  })

  it('exposes typed codes a caller can branch on', async () => {
    const gate = openGate()
    await expect(gate.beginCutover(COORDINATOR, { migrationId: 'migration-1', ownerStage: 'stage-2', epoch: 1, revision: 1 }))
      .rejects.toBeInstanceOf(ProfileMaintenanceError)
  })
})
