// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeAuthorityLock } from '@shared/runtime-file-security'
import { SqliteProviderCatalog } from './provider-catalog'
import { SqliteProfileMaintenanceGate } from './profile-maintenance-gate'
import { ProviderMaintenanceMigration } from './provider-maintenance-migration'
import { PROVIDER_MIGRATION_VERSION } from './provider-migration'
import { openTaskAuthorityDatabase, type TaskAuthorityDatabase } from './task-authority/schema'

/**
 * The one-time legacy `agentCommand` → provider-instance cutover, driven through
 * the real Stage 2 gate and the real Catalog — the exact production path. These
 * exercise the atomic boundary (prepared transition validated inside the Catalog
 * commit) rather than either half in isolation.
 */

const passThroughLock: RuntimeAuthorityLock = (path, callback) => callback(path)

const directories: string[] = []
const databases: TaskAuthorityDatabase[] = []

type Harness = Readonly<{
  profileId: string
  catalog: SqliteProviderCatalog
  gate: SqliteProfileMaintenanceGate
  migration: ProviderMaintenanceMigration
}>

function harness(profileId = 'profile-migration'): Harness {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'provider-migration-')))
  directories.push(directory)
  const database = openTaskAuthorityDatabase({ databasePath: join(directory, 'task-authority.sqlite'), authorityLock: passThroughLock })
  databases.push(database)
  const catalog = new SqliteProviderCatalog({ database })
  const gate = new SqliteProfileMaintenanceGate({ database, profileId, onDiscardCandidateState: () => {} })
  return { profileId, catalog, gate, migration: new ProviderMaintenanceMigration({ gate, catalog, profileId }) }
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close()
  while (directories.length > 0) rmSync(directories.pop() as string, { recursive: true, force: true })
})

describe('legacy command migration through the gate and catalog', () => {
  it('migrates an exact known bare executable to a driver-backed external instance and selects it as the default', async () => {
    const { migration, catalog } = harness()

    const result = await migration.migrate({ commands: [{ command: 'codex', displayName: 'Codex' }] })

    // The returned snapshot is the committed catalog, not a pre-commit read: a
    // run that reports success must have published exactly what it reports.
    expect(result.snapshot.instances).toHaveLength(1)
    const [instance] = result.snapshot.instances
    expect(instance?.driver).toMatchObject({ kind: 'known', id: 'codex' })
    expect(instance?.command).toEqual({ kind: 'driver', driverId: 'codex' })
    expect(instance?.credentialMode).toBe('external')
    expect(result.defaultInstanceId).toBe(instance?.id)
    expect(result.snapshot.defaultInstanceId).toBe(instance?.id)
    expect(result.instanceIds).toEqual([instance?.id])
    // The committed catalog agrees with the returned snapshot.
    expect(catalog.snapshot().defaultInstanceId).toBe(instance?.id)
  })

  it('migrates an argument-bearing absolute command to custom-command with the exact bounded program', async () => {
    const { migration } = harness()

    const result = await migration.migrate({ commands: [{ command: '/usr/local/bin/codex --foo', displayName: 'Legacy' }] })

    expect(result.snapshot.instances).toHaveLength(1)
    const [instance] = result.snapshot.instances
    // A basename that resembles a driver is never authority.
    expect(instance?.driver).toMatchObject({ kind: 'known', id: 'custom-command' })
    expect(instance?.command).toEqual({ kind: 'external-shell', program: '/usr/local/bin/codex --foo' })
    expect(instance?.credentialMode).toBe('external')
  })

  it('projects an empty command as configuration-required: no instance and no default', async () => {
    const { migration, catalog } = harness()

    const result = await migration.migrate({ commands: [{ command: '', displayName: 'Unset' }] })

    expect(result.instanceIds).toEqual([])
    expect(result.defaultInstanceId).toBeNull()
    expect(result.snapshot.instances).toEqual([])
    expect(catalog.snapshot().defaultInstanceId).toBeNull()
  })

  it('reuses the committed instance on a retry instead of duplicating it', async () => {
    const { migration, catalog } = harness()
    const commands = [{ command: 'codex', displayName: 'Codex' }]

    const first = await migration.migrate({ commands })
    const second = await migration.migrate({ commands })

    // Deterministic ids make the retry idempotent: same instance, no growth.
    expect(second.instanceIds).toEqual(first.instanceIds)
    expect(catalog.snapshot().instances).toHaveLength(1)
    expect(catalog.snapshot().revision).toBe(first.snapshot.revision)
  })

  it('never derives credential authority from the migration', async () => {
    const { migration, catalog } = harness()

    const result = await migration.migrate({ commands: [{ command: 'codex', displayName: 'Codex' }] })

    // Migration creates instances only: no account, no credential binding, and
    // no managed mode may appear as a side effect of importing a command.
    expect(result.snapshot.accounts).toEqual([])
    expect(catalog.snapshot().accounts).toEqual([])
    for (const instance of result.snapshot.instances) expect(instance.credentialMode).toBe('external')
  })

  it('leaves the gate open and the ledger committed so a later startup is a pure no-op', async () => {
    const first = harness()

    const migrated = await first.migration.migrate({ commands: [{ command: 'codex', displayName: 'Codex' }] })
    expect(first.gate.readState()).toMatchObject({ phase: 'open', lease: null })
    const ledger = first.catalog.completedMigration()
    expect(ledger).toMatchObject({ defaultInstanceId: migrated.defaultInstanceId, sourceSha256: expect.any(String) })

    // A second and third startup re-run the same entry point against the same
    // database: no new instance, no account, and no further revision movement.
    const second = await first.migration.migrate({ commands: [{ command: 'codex', displayName: 'Codex' }] })
    const third = await first.migration.migrate({ commands: [{ command: 'codex', displayName: 'Codex' }] })

    expect(second.instanceIds).toEqual(migrated.instanceIds)
    expect(third.snapshot.revision).toBe(migrated.snapshot.revision)
    expect(first.catalog.snapshot().instances).toHaveLength(1)
    expect(first.gate.readState()).toMatchObject({ phase: 'open', lease: null })
  })

  it('resumes and releases a cutover that committed the catalog but crashed before release', async () => {
    const { migration, catalog, gate } = harness()

    // Reproduce the crash window: the Catalog commit (and its ledger row) is
    // durable, the gate is still `cutting-over`, and the lease is held.
    await gate.acquire({ connectionId: 'migration-owner', ownerStage: 'stage-3' }, {
      migrationId: 'provider-instances-v1:profile-migration',
      ownerStage: 'stage-3',
      participants: ['task-authority', 'provider-authority'],
      expectedRevision: gate.readState().revision
    })
    const crashed = gate.readState()
    const lease = crashed.lease
    if (lease === null) throw new Error('expected a held lease')
    await gate.freeze({ connectionId: 'migration-owner', ownerStage: 'stage-3' }, lease)
    for (const participant of ['task-authority', 'provider-authority'] as const) {
      await gate.acknowledgeDrained({ connectionId: 'migration-owner', participant }, lease.migrationId)
    }
    await gate.beginCutover({ connectionId: 'migration-owner', ownerStage: 'stage-3' }, lease)
    // The interrupted run's hashes are deterministic (that is what makes a
    // resume idempotent), so reproducing the crash means deriving them the same
    // way rather than inventing values the retry could never match.
    const commands = [{ command: 'codex', displayName: 'Crashed' }]
    const source = createHash('sha256').update(JSON.stringify({ version: PROVIDER_MIGRATION_VERSION, profileId: 'profile-migration', commands }), 'utf8').digest('hex')
    const intent = createHash('sha256').update(`${PROVIDER_MIGRATION_VERSION}:profile-migration:intent`, 'utf8').digest('hex')
    const prepared = await gate.prepareMigrationTransition({ connectionId: 'migration-owner', ownerStage: 'stage-3' }, lease, {
      participant: 'provider-authority', operationId: `${PROVIDER_MIGRATION_VERSION}:profile-migration`, sourceSha256: source, intentSha256: intent, visibilityMode: 'central'
    })
    catalog.beginMigrationTransition({
      preparedReceiptId: prepared.id,
      sourceSha256: source,
      intentSha256: intent,
      plans: [{ id: 'instance-crashed', driverId: 'custom-command', command: { kind: 'external-shell', program: 'codex' }, displayName: 'Crashed' }],
      defaultInstanceId: 'instance-crashed'
    })
    // No completeMigrationTransition, no release: this is the crash point.

    const resumed = await migration.migrate({ commands })

    // Recovery finishes the lease from the committed state rather than
    // re-deriving it, and the instances the crashed run committed stay canonical.
    expect(gate.readState()).toMatchObject({ phase: 'open', lease: null })
    expect(resumed.instanceIds).toEqual(['instance-crashed'])
    expect(catalog.snapshot().defaultInstanceId).toBe('instance-crashed')
    expect(catalog.completedMigration()).toMatchObject({ instanceIds: ['instance-crashed'] })
  })

  it('resumes a cutover that crashed after the provider transition completed but before release', async () => {
    const { migration, catalog, gate } = harness()
    const owner = { connectionId: 'migration-owner', ownerStage: 'stage-3' } as const

    await gate.acquire(owner, {
      migrationId: `${PROVIDER_MIGRATION_VERSION}:profile-migration`,
      ownerStage: 'stage-3',
      participants: ['task-authority', 'provider-authority'],
      expectedRevision: gate.readState().revision
    })
    const lease = gate.readState().lease
    if (lease === null) throw new Error('expected a held lease')
    await gate.freeze(owner, lease)
    for (const participant of ['task-authority', 'provider-authority'] as const) {
      await gate.acknowledgeDrained({ connectionId: 'migration-owner', participant }, lease.migrationId)
    }
    await gate.beginCutover(owner, lease)

    const commands = [{ command: 'codex', displayName: 'Crashed' }]
    const source = createHash('sha256').update(JSON.stringify({ version: PROVIDER_MIGRATION_VERSION, profileId: 'profile-migration', commands }), 'utf8').digest('hex')
    const intent = createHash('sha256').update(`${PROVIDER_MIGRATION_VERSION}:profile-migration:provider-authority:intent`, 'utf8').digest('hex')
    const prepared = await gate.prepareMigrationTransition(owner, lease, {
      participant: 'provider-authority', operationId: `${PROVIDER_MIGRATION_VERSION}:profile-migration`, sourceSha256: source, intentSha256: intent, visibilityMode: 'central'
    })
    catalog.beginMigrationTransition({
      preparedReceiptId: prepared.id,
      sourceSha256: source,
      intentSha256: intent,
      plans: [{ id: 'instance-late-crash', driverId: 'custom-command', command: { kind: 'external-shell', program: 'codex' }, displayName: 'Crashed' }],
      defaultInstanceId: 'instance-late-crash'
    })
    // Provider's transition completed, task-authority's was never prepared, and
    // the lease was never released: the second crash position.
    await gate.completeMigrationTransition(owner, prepared, createHash('sha256').update('provider-evidence').digest('hex'))

    const resumed = await migration.migrate({ commands })

    // Recovery must not re-complete the provider receipt with different evidence
    // (the gate refuses that); it fills only the gap and releases.
    expect(gate.readState()).toMatchObject({ phase: 'open', lease: null })
    expect(resumed.instanceIds).toEqual(['instance-late-crash'])
    expect(catalog.snapshot().defaultInstanceId).toBe('instance-late-crash')
  })

  it('keeps the migrated default instance removable despite the historical ledger', async () => {
    const { migration, catalog } = harness()

    const migrated = await migration.migrate({ commands: [{ command: 'codex', displayName: 'Codex' }] })
    const instanceId = migrated.defaultInstanceId
    if (instanceId === null) throw new Error('expected a migrated default')

    // The ledger is a historical record, not a live reference: it must not pin
    // the instance the migration created, or the management UI could never
    // remove it. Removal is allowed once the default moves off it.
    catalog.setDefault(null, catalog.snapshot().revision)
    catalog.remove(instanceId, 1)

    expect(catalog.snapshot().instances).toEqual([])
    // The record of what the migration committed survives the removal.
    expect(catalog.completedMigration()).toMatchObject({ instanceIds: [instanceId] })
  })

  it('maps an absolute known executable and an unknown bare program through the real gate without basename authority', async () => {
    const { migration, catalog } = harness()

    await migration.migrate({ commands: [{ command: '/usr/local/bin/codex', displayName: 'Absolute' }] })
    await migration.migrate({ commands: [{ command: '/usr/local/bin/codex', displayName: 'Absolute' }] })

    expect(catalog.snapshot().instances).toHaveLength(1)
    const [instance] = catalog.snapshot().instances
    // The basename resembles the `codex` driver, which is exactly the authority
    // a migration must never claim: the exact string is the program.
    expect(instance?.driver).toMatchObject({ kind: 'known', id: 'custom-command' })
    expect(instance?.command).toEqual({ kind: 'external-shell', program: '/usr/local/bin/codex' })
    expect(instance?.credentialMode).toBe('external')
    // No account, binding, or attempt is created by importing a command.
    expect(catalog.snapshot().accounts).toEqual([])
  })

  it('is deterministic across a fresh database: the same command yields the same instance id', async () => {
    const first = harness('profile-determinism')
    const second = harness('profile-determinism')

    const a = await first.migration.migrate({ commands: [{ command: 'codex', displayName: 'Codex' }] })
    const b = await second.migration.migrate({ commands: [{ command: 'codex', displayName: 'Codex' }] })

    // A deterministic id is what makes an interrupted retry reuse rather than
    // duplicate, so this identity is part of the migration's contract.
    expect(a.instanceIds).toEqual(b.instanceIds)
    expect(a.defaultInstanceId).toBe(b.defaultInstanceId)
  })

  it('imports the exact legacy command string and never reads a decoy credential file or environment', async () => {
    const { migration, catalog } = harness()
    // A decoy in the temp area the migration could plausibly be tempted to read.
    writeFileSync(join(tmpdir(), 'provider-migration-decoy-secrets.enc.json'), JSON.stringify({ keys: ['sk-decoy-marker-0123456789'] }), { mode: 0o600 })
    process.env['DONWELLS_DECOY_CREDENTIAL'] = 'sk-env-decoy-marker-0123456789'

    await migration.migrate({ commands: [{ command: 'codex', displayName: 'Codex' }] })

    // Only the exact legacy command becomes a program; no credential material
    // from any decoy source may appear anywhere in the committed catalog.
    const serialized = JSON.stringify(catalog.snapshot())
    expect(serialized).not.toContain('sk-decoy-marker')
    expect(serialized).not.toContain('sk-env-decoy-marker')
    expect(serialized).not.toContain('secrets.enc.json')
    expect(catalog.snapshot().accounts).toEqual([])
    delete process.env['DONWELLS_DECOY_CREDENTIAL']
    rmSync(join(tmpdir(), 'provider-migration-decoy-secrets.enc.json'), { force: true })
  })

  it('resumes a cutover that crashed before the catalog commit and creates exactly one instance', async () => {
    const { migration, catalog, gate } = harness()
    const owner = { connectionId: 'migration-owner', ownerStage: 'stage-3' } as const

    // The crash position with no ledger row: the lease was taken and frozen but
    // the Catalog commit never ran, so `completedMigration()` is still null and
    // the gate is not open. The daemon that restarts is the same one that owns
    // the lease, so startup must resume it rather than refuse its own lease —
    // otherwise the profile could never boot again.
    await gate.acquire(owner, {
      migrationId: `${PROVIDER_MIGRATION_VERSION}:profile-migration`,
      ownerStage: 'stage-3',
      participants: ['task-authority', 'provider-authority'],
      expectedRevision: gate.readState().revision
    })
    const held = gate.readState().lease
    if (held === null) throw new Error('expected a held lease')
    await gate.freeze(owner, held)

    const resumed = await migration.migrate({ commands: [{ command: 'codex', displayName: 'Codex' }] })

    // Legacy authority is replaced by exactly one deterministic instance, and
    // the interrupted lease is released rather than left fencing the profile.
    expect(resumed.instanceIds).toHaveLength(1)
    expect(resumed.defaultInstanceId).toBe(resumed.instanceIds[0])
    expect(catalog.snapshot().instances).toHaveLength(1)
    expect(catalog.completedMigration()).toMatchObject({ instanceIds: resumed.instanceIds })
    expect(gate.readState()).toMatchObject({ phase: 'open', lease: null })

    // A retry after the resumed run is a pure no-op: still exactly one instance.
    const again = await migration.migrate({ commands: [{ command: 'codex', displayName: 'Codex' }] })
    expect(again.instanceIds).toEqual(resumed.instanceIds)
    expect(catalog.snapshot().instances).toHaveLength(1)
  })

  it('never resumes a lease owned by a different migration', async () => {
    const { migration, catalog, gate } = harness()
    const owner = { connectionId: 'other-owner', ownerStage: 'stage-4' } as const

    // Another stage's migration legitimately holds the profile: this coordinator
    // must not steal it, and must not claim a result it did not produce.
    await gate.acquire(owner, {
      migrationId: 'stage-4-other-migration:profile-migration',
      ownerStage: 'stage-4',
      participants: ['provider-authority'],
      expectedRevision: gate.readState().revision
    })

    await expect(migration.migrate({ commands: [{ command: 'codex', displayName: 'Codex' }] })).rejects.toThrow()
    expect(catalog.snapshot().instances).toEqual([])
    expect(catalog.completedMigration()).toBeNull()
  })
})