// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_PROVIDER_DEFINITIONS } from '@shared/agent-runtime'
import { isProviderCertificationPlatform, parseProviderCatalogSnapshot, parseProviderInstanceInput, type ProviderCatalog, type ProviderInstanceInput } from '@shared/provider-authority'
import { AgentRegistry } from './agents/registry'
import type { ProviderCertification } from './agents/provider-certifications'
import { ProviderCatalogError, SqliteProviderCatalog } from './provider-catalog'
import type { TaskAuthorityDatabase } from './task-authority/schema'
import { openTaskAuthorityDatabase } from './task-authority/schema'

const STUB_EXTENSION = process.platform === 'win32' ? '.CMD' : ''
const STUB_CONTENT = process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n'
const STUB_SHA256 = createHash('sha256').update(STUB_CONTENT).digest('hex')
const CERTIFICATION_PLATFORM = isProviderCertificationPlatform(process.platform) ? process.platform : undefined

const directories: string[] = []
const databases: TaskAuthorityDatabase[] = []

/** One isolated profile with a PATH-local executable stub for each test driver. */
function profile(prefix: string): { directory: string; bin: string } {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
  directories.push(directory)
  const bin = join(directory, 'bin')
  mkdirSync(bin, { recursive: true, mode: 0o700 })
  for (const driver of ['codex', 'claude']) writeFileSync(join(bin, driver + STUB_EXTENSION), STUB_CONTENT, { mode: 0o755 })
  return { directory, bin }
}
/**
 * A catalog whose certifications are built from its OWN profile's executable
 * paths, so an accepted tuple and a drifted tuple are compared against the very
 * same executable the registry resolves.
 */
function catalog(options: { certifications?: (bin: string) => readonly ProviderCertification[]; now?: () => Date } = {}): ProviderCatalog {
  const { directory, bin } = profile('provider-catalog-')
  const database = openTaskAuthorityDatabase({ databasePath: join(directory, 'authority.sqlite') })
  databases.push(database)
  return new SqliteProviderCatalog({
    database,
    registry: new AgentRegistry({ env: { PATH: bin } }),
    certifications: options.certifications?.(bin) ?? [],
    ...(options.now === undefined ? {} : { now: options.now })
  })
}
function databasePathOf(catalogInstance: ProviderCatalog): string {
  if (!(catalogInstance instanceof SqliteProviderCatalog)) throw new Error('expected the SQLite catalog')
  return catalogInstance.databasePath
}
/** The discovery PATH of a profile, so a reopened catalog resolves the same executables. */
function binPathOf(catalogInstance: ProviderCatalog): string {
  return join(dirname(databasePathOf(catalogInstance)), 'bin')
}
function rowCount(databasePath: string, table: string, clause = '1 = 1'): number {
  const connection = new DatabaseSync(databasePath)
  try {
    const row = connection.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${clause}`).get() as { count: number }
    return Number(row.count)
  } finally {
    connection.close()
  }
}
afterEach(() => {
  while (databases.length) databases.pop()?.close()
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true })
})

const external = (id: 'codex' | 'claude' = 'codex'): ProviderInstanceInput => ({
  driverId: id,
  displayName: id + ' account',
  command: { kind: 'driver', driverId: id },
  credentialMode: 'external',
  accountId: null,
  enabled: true
})
/** A reviewed certification bound to one stub executable in a profile. */
function certificationForStub(bin: string, driverId: 'codex' | 'claude', overrides: Partial<ProviderCertification> = {}): ProviderCertification {
  if (CERTIFICATION_PLATFORM === undefined) throw new Error('certification tests require a reviewed host platform')
  return Object.freeze({
    driverId,
    modes: ['managed', 'none'] as const,
    executablePath: join(bin, driverId + STUB_EXTENSION),
    supportedVersionRange: '>=1.0.0 <2.0.0',
    platform: CERTIFICATION_PLATFORM,
    architecture: process.arch,
    ...overrides
  })
}
function failureCode(operation: () => unknown): string | undefined {
  try {
    operation()
    return undefined
  } catch (error) {
    return error instanceof ProviderCatalogError ? error.code : String(error)
  }
}
function selectionFor(instance: { id: string; revision: number }, account: { id: string; revision: number } | null = null) {
  return { driverId: 'codex' as const, providerInstanceId: instance.id, instanceRevision: instance.revision, accountId: account?.id ?? null, accountRevision: account?.revision ?? null }
}
/** Retires the single active binding through the exact live destructive operation. */
function retireOnlyBinding(catalogInstance: ProviderCatalog, instance: { id: string; revision: number }, account: { id: string; revision: number }, credentialRef: string) {
  const bound = catalogInstance.bindCredential({ providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: instance.revision, expectedAccountRevision: account.revision, credentialRef, expectedBindingGeneration: 0 })
  const connection = new DatabaseSync(databasePathOf(catalogInstance))
  connection.prepare("INSERT INTO provider_credential_operations(id,operation_kind,provider_instance_id,instance_revision,account_id,account_revision,prior_credential_ref,prior_binding_generation,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run('op-1', 'revoke', instance.id, bound.revision, account.id, account.revision, credentialRef, 1, 'pending', new Date().toISOString(), new Date().toISOString())
  connection.close()
  return catalogInstance.retireCredentialBindingForOperation({ providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: bound.revision, expectedAccountRevision: account.revision, expectedBindingGeneration: 1, credentialOperationId: 'op-1' })
}

describe('ProviderCatalog', () => {
  it('persists exact accounts, instances, and revisions when reopened', () => {
    const first = catalog()
    const account = first.createAccount({ driverId: 'codex', displayLabel: 'Personal' })
    const instance = first.create({ ...external(), accountId: account.id })
    const reopenedDatabase = openTaskAuthorityDatabase({ databasePath: databasePathOf(first) })
    databases.push(reopenedDatabase)
    const reopened = new SqliteProviderCatalog({ database: reopenedDatabase, registry: new AgentRegistry({ env: { PATH: binPathOf(first) } }) })
    expect(reopened.snapshot()).toMatchObject({ revision: 3, accounts: [account], instances: [instance] })
  })

  it('preserves an unknown persisted driver as unavailable instead of remapping it', () => {
    const catalogInstance = catalog()
    const connection = new DatabaseSync(databasePathOf(catalogInstance))
    connection.prepare("INSERT INTO provider_instances(id,driver_id,display_name,command_spec_json,credential_mode,account_id,enabled,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run('legacy', 'removed-driver', 'Legacy', '{"kind":"driver","driverId":"removed-driver"}', 'external', null, 1, 1, new Date().toISOString(), new Date().toISOString())
    connection.close()
    const snapshot = catalogInstance.snapshot()
    expect(snapshot.instances[0]).toMatchObject({ id: 'legacy', availability: 'unavailable', driver: { kind: 'unknown', rawDriverId: 'removed-driver' } })
    // The unavailable projection must survive the sanitized decode unchanged:
    // an unknown persisted driver is a legitimate catalog state, not corruption.
    expect(parseProviderCatalogSnapshot(snapshot)).toEqual(snapshot)
  })

  it('keeps a snapshot decodable when an unknown-driver instance is present alongside known ones', () => {
    const catalogInstance = catalog()
    const known = catalogInstance.create(external())
    const connection = new DatabaseSync(databasePathOf(catalogInstance))
    const now = new Date().toISOString()
    connection.prepare("INSERT INTO provider_instances(id,driver_id,display_name,command_spec_json,credential_mode,account_id,enabled,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run('legacy', 'removed-driver', 'Legacy', '{"kind":"driver","driverId":"removed-driver"}', 'external', null, 1, 1, now, now)
    connection.prepare("INSERT INTO provider_instances(id,driver_id,display_name,command_spec_json,credential_mode,account_id,enabled,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run('legacy-argv', 'removed-driver', 'Legacy argv', '{"kind":"external-argv","executable":{"executable":"/usr/bin/legacy","args":[]}}', 'external', null, 0, 1, now, now)
    connection.prepare("INSERT INTO provider_instances(id,driver_id,display_name,command_spec_json,credential_mode,account_id,enabled,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run('legacy-shell', 'removed-driver', 'Legacy shell', '{"kind":"external-shell","program":"legacy --flag"}', 'external', null, 1, 1, now, now)
    connection.close()
    const snapshot = catalogInstance.snapshot()
    // Every instance, including the three unavailable ones, decodes: one legacy
    // row must not blank out the whole catalog for every reader.
    const decoded = parseProviderCatalogSnapshot(snapshot)
    expect(decoded).toEqual(snapshot)
    expect(decoded.instances.map(instance => instance.id).sort()).toEqual(['legacy', 'legacy-argv', 'legacy-shell', known.id].sort())
    expect(decoded.instances.filter(instance => instance.driver.kind === 'unknown')).toHaveLength(3)
  })

  it('still refuses a structurally malformed command on an unavailable instance', () => {
    const catalogInstance = catalog()
    const connection = new DatabaseSync(databasePathOf(catalogInstance))
    connection.prepare("INSERT INTO provider_instances(id,driver_id,display_name,command_spec_json,credential_mode,account_id,enabled,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run('legacy', 'removed-driver', 'Legacy', '{"kind":"not-a-command-kind"}', 'external', null, 1, 1, new Date().toISOString(), new Date().toISOString())
    connection.close()
    // Tolerance is scoped to an unknown driver id, not to structure: skipping
    // command decoding wholesale for unavailable rows would let arbitrary
    // malformed commands through.
    expect(failureCode(() => catalogInstance.snapshot())).toBe('CORRUPT_CATALOG')
  })

  it('accepts every declaratively registered driver and rejects an unregistered one', () => {
    for (const definition of AGENT_PROVIDER_DEFINITIONS) {
      expect(parseProviderInstanceInput({ ...external(), driverId: definition.id }).driverId).toBe(definition.id)
    }
    expect(parseProviderInstanceInput({ ...external(), driverId: 'custom-command' }).driverId).toBe('custom-command')
    expect(() => parseProviderInstanceInput({ ...external(), driverId: 'not-a-driver' })).toThrowError()
  })

  it('rejects managed and none for uncertified built-in drivers before account work', () => {
    const catalogInstance = catalog()
    expect(failureCode(() => catalogInstance.create({ ...external(), credentialMode: 'managed' }))).toBe('DRIVER_MODE_UNCERTIFIED')
    expect(failureCode(() => catalogInstance.create({ ...external(), credentialMode: 'none' }))).toBe('DRIVER_MODE_UNCERTIFIED')
    // No account, binding, or instance row was created ahead of the refusal.
    expect(catalogInstance.snapshot()).toMatchObject({ accounts: [], instances: [] })
  })

  it('rejects preparing a disabled instance', () => {
    const catalogInstance = catalog()
    const created = catalogInstance.create({ ...external(), enabled: false })
    expect(failureCode(() => catalogInstance.prepareLaunch({ selection: selectionFor(created), attemptId: 'attempt', sessionId: 'session', purpose: 'agent-launch' }))).toBe('INSTANCE_DISABLED')
  })

  it('does not serialize opaque credential binding metadata in projections', () => {
    const catalogInstance = catalog()
    const instance = catalogInstance.create(external())
    const account = catalogInstance.createAccount({ driverId: 'codex', displayLabel: 'External' })
    const bound = catalogInstance.bindCredential({ providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: instance.revision, expectedAccountRevision: account.revision, credentialRef: 'secret-ref', expectedBindingGeneration: 0 })
    expect(JSON.stringify(bound)).not.toContain('credentialRef')
    expect(JSON.stringify(bound)).not.toContain('secret-ref')
    const snapshot = catalogInstance.snapshot()
    expect(JSON.stringify(snapshot)).not.toMatch(/credentialRef|bindingGeneration|credentialRevision|authFile/)
    expect(JSON.stringify(snapshot)).not.toContain('secret-ref')
    // The projection is also a valid sanitized wire document, field for field.
    expect(parseProviderCatalogSnapshot(snapshot)).toEqual(snapshot)
  })

  it('clears the default pointer before removing the default instance', () => {
    const catalogInstance = catalog()
    const created = catalogInstance.create(external())
    const sibling = catalogInstance.create(external('claude'))
    const snapshot = catalogInstance.setDefault(created.id, catalogInstance.snapshot().revision)
    catalogInstance.remove(created.id, created.revision)
    // The pointer is cleared, never silently re-pointed at the survivor.
    expect(catalogInstance.snapshot()).toMatchObject({ defaultInstanceId: null, revision: snapshot.revision + 1 })
    expect(catalogInstance.snapshot().instances.map(instance => instance.id)).toEqual([sibling.id])
  })

  it('updates in place, preserving creation history for a default instance with retired bindings and a preparation', () => {
    const catalogInstance = catalog()
    const account = catalogInstance.createAccount({ driverId: 'codex', displayLabel: 'Account' })
    const created = catalogInstance.create({ ...external(), accountId: account.id })
    catalogInstance.setDefault(created.id, catalogInstance.snapshot().revision)
    const retired = retireOnlyBinding(catalogInstance, created, account, 'opaque-ref')
    const preparation = catalogInstance.prepareLaunch({ selection: selectionFor(retired, account), attemptId: 'attempt', sessionId: 'session', purpose: 'agent-launch' })
    const databasePath = databasePathOf(catalogInstance)
    const before = new DatabaseSync(databasePath)
    const createdAtBefore = before.prepare('SELECT created_at FROM provider_instances WHERE id=?').get(created.id) as { created_at: string }
    before.close()
    const updated = catalogInstance.update(created.id, retired.revision, { ...external(), accountId: account.id, displayName: 'Updated' })
    const after = new DatabaseSync(databasePath)
    const instanceRow = after.prepare('SELECT created_at FROM provider_instances WHERE id=?').get(created.id) as { created_at: string }
    const preparationRow = after.prepare('SELECT instance_revision,consumed_at FROM provider_launch_preparations WHERE id=?').get(preparation.id) as { instance_revision: number; consumed_at: string | null }
    after.close()
    expect(updated).toMatchObject({ id: created.id, displayName: 'Updated', revision: retired.revision + 1 })
    expect(instanceRow.created_at).toBe(createdAtBefore.created_at)
    // The live preparation keeps its original revision and stays unconsumed, so a
    // later admission against it is stale by construction, not silently re-based.
    expect(preparationRow).toEqual({ instance_revision: retired.revision, consumed_at: null })
    expect(catalogInstance.snapshot().defaultInstanceId).toBe(created.id)
  })

  it('purges an expired preparation so it cannot block an instance edit', () => {
    let current = new Date('2026-01-01T00:00:00.000Z')
    const catalogInstance = catalog({ now: () => current })
    const created = catalogInstance.create(external())
    catalogInstance.prepareLaunch({ selection: selectionFor(created), attemptId: 'attempt', sessionId: 'session', purpose: 'agent-launch' })
    const databasePath = databasePathOf(catalogInstance)
    expect(rowCount(databasePath, 'provider_launch_preparations')).toBe(1)
    current = new Date(current.getTime() + 60_000)
    expect(catalogInstance.update(created.id, created.revision, { ...external(), displayName: 'After expiry' }).displayName).toBe('After expiry')
    // Expired launch intent is transient: it cannot pin the row or accumulate.
    expect(rowCount(databasePath, 'provider_launch_preparations')).toBe(0)
    expect(rowCount(databasePath, 'task_launch_admissions')).toBe(0)
  })

  it('leaves a live preparation row untouched while the instance updates', () => {
    const catalogInstance = catalog()
    const created = catalogInstance.create(external())
    const preparation = catalogInstance.prepareLaunch({ selection: selectionFor(created), attemptId: 'attempt', sessionId: 'session', purpose: 'agent-launch' })
    const databasePath = databasePathOf(catalogInstance)
    const before = new DatabaseSync(databasePath)
    const beforeRow = before.prepare('SELECT * FROM provider_launch_preparations WHERE id=?').get(preparation.id)
    before.close()
    catalogInstance.update(created.id, created.revision, { ...external(), displayName: 'Updated' })
    const after = new DatabaseSync(databasePath)
    const afterRow = after.prepare('SELECT * FROM provider_launch_preparations WHERE id=?').get(preparation.id)
    after.close()
    expect(afterRow).toEqual(beforeRow)
  })

  it('refuses to remove an instance that a live launch preparation still names', () => {
    const catalogInstance = catalog()
    const created = catalogInstance.create(external())
    catalogInstance.prepareLaunch({ selection: selectionFor(created), attemptId: 'attempt', sessionId: 'session', purpose: 'agent-launch' })
    expect(failureCode(() => catalogInstance.remove(created.id, created.revision))).toBe('PREPARATION_ACTIVE')
    expect(catalogInstance.snapshot().instances.map(instance => instance.id)).toEqual([created.id])
  })

  it('removes an account after retired binding history without leaking a foreign-key error', () => {
    const catalogInstance = catalog()
    const account = catalogInstance.createAccount({ driverId: 'codex', displayLabel: 'Account' })
    const instance = catalogInstance.create({ ...external(), accountId: account.id })
    const retired = retireOnlyBinding(catalogInstance, instance, account, 'opaque-ref')
    catalogInstance.remove(retired.id, retired.revision)
    expect(() => catalogInstance.removeAccount({ id: account.id, expectedRevision: account.revision })).not.toThrow()
    expect(catalogInstance.snapshot()).toMatchObject({ accounts: [], instances: [] })
    expect(rowCount(databasePathOf(catalogInstance), 'provider_credential_bindings')).toBe(0)
  })

  /**
   * A retired binding row keeps its generation inside the primary key, so the
   * next binding for the tuple must be allocated above it. Deriving the
   * generation from the live row alone reuses a retired generation, which the
   * primary key refuses: revoke-then-bind is a normal user path, so this would
   * brick the account permanently after its first revocation.
   */
  it('allocates a fresh generation across a retired binding instead of reusing one', () => {
    const catalogInstance = catalog()
    const account = catalogInstance.createAccount({ driverId: 'codex', displayLabel: 'Account' })
    const instance = catalogInstance.create({ ...external(), accountId: account.id })
    const retired = retireOnlyBinding(catalogInstance, instance, account, 'first-ref')

    // The post-revoke caller has no live binding to read a generation from, so it
    // arrives with the zero seed. Honouring that seed reuses generation 1, which
    // the retired row already owns.
    const rebound = catalogInstance.bindCredential({ providerInstanceId: retired.id, accountId: account.id, expectedInstanceRevision: retired.revision, expectedAccountRevision: account.revision, credentialRef: 'second-ref', expectedBindingGeneration: 0 })
    const binding = catalogInstance.credentialBinding(rebound.id, account.id)
    expect(binding).toMatchObject({ credentialRef: 'second-ref', bindingGeneration: 2 })
    // Both generations stay durable: the retired one is history, not a free slot.
    expect(rowCount(databasePathOf(catalogInstance), 'provider_credential_bindings')).toBe(2)
  })

  /**
   * The wire seam and the in-process seam must report the same thing. Task 2
   * parked this asymmetry here: the wire facade discarded the projection the
   * Catalog returns, so a caller over the daemon saw `void` while a caller
   * holding the Catalog saw the retired binding's instance projection.
   */
  it('reports the retired-instance projection as a decodable sanitized document', () => {
    const catalogInstance = catalog()
    const account = catalogInstance.createAccount({ driverId: 'codex', displayLabel: 'Account' })
    const instance = catalogInstance.create({ ...external(), accountId: account.id })
    const bound = catalogInstance.bindCredential({ providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: instance.revision, expectedAccountRevision: account.revision, credentialRef: 'wire-ref', expectedBindingGeneration: 0 })
    const connection = new DatabaseSync(databasePathOf(catalogInstance))
    connection.prepare("INSERT INTO provider_credential_operations(id,operation_kind,provider_instance_id,instance_revision,account_id,account_revision,prior_credential_ref,prior_binding_generation,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run('op-wire', 'revoke', instance.id, bound.revision, account.id, account.revision, 'wire-ref', 1, 'pending', new Date().toISOString(), new Date().toISOString())
    connection.close()
    const projected = catalogInstance.retireCredentialBindingForOperation({
      providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: bound.revision, expectedAccountRevision: account.revision, expectedBindingGeneration: 1, credentialOperationId: 'op-wire'
    })
    // The in-process projection is a real instance projection for the exact
    // instance whose binding was retired, and it is the SAME projection the
    // snapshot reports: retiring a binding is a catalog-wide change, not an
    // instance-identity change, so the instance revision is unchanged.
    expect(projected.id).toBe(instance.id)
    expect(projected.revision).toBe(bound.revision)
    expect(catalogInstance.credentialBinding(instance.id, account.id)).toBeNull()
    // ...and it is the sanitized document the wire carries, so folding it through
    // the daemon seam cannot disagree with what a local caller observes.
    const snapshot = catalogInstance.snapshot()
    expect(parseProviderCatalogSnapshot({ revision: snapshot.revision, defaultInstanceId: null, drivers: snapshot.drivers, accounts: snapshot.accounts, instances: [projected] }).instances[0]).toMatchObject({ id: instance.id, revision: projected.revision })
    expect(JSON.stringify(projected)).not.toContain('wire-ref')
  })

  it('refuses to remove an account that an instance still references', () => {
    const catalogInstance = catalog()
    const account = catalogInstance.createAccount({ driverId: 'codex', displayLabel: 'Account' })
    catalogInstance.create({ ...external(), accountId: account.id })
    expect(failureCode(() => catalogInstance.removeAccount({ id: account.id, expectedRevision: account.revision }))).toBe('ACCOUNT_HAS_CREDENTIAL')
    expect(catalogInstance.snapshot().accounts.map(entry => entry.id)).toEqual([account.id])
  })

  it('purges consumed preparations and their admission receipts before instance removal', () => {
    const catalogInstance = catalog()
    const created = catalogInstance.create(external())
    const preparation = catalogInstance.prepareLaunch({ selection: selectionFor(created), attemptId: 'attempt', sessionId: 'session', purpose: 'agent-launch' })
    const databasePath = databasePathOf(catalogInstance)
    const connection = new DatabaseSync(databasePath)
    const now = new Date().toISOString()
    connection.prepare('UPDATE provider_launch_preparations SET consumed_at=? WHERE id=?').run(now, preparation.id)
    // The admission receipt is the trusted broker authorization tuple, so this
    // out-of-band row must satisfy its full v5 shape rather than the older
    // pointer-only one the purge used to carry.
    connection.prepare(
      "INSERT INTO task_launch_admissions(id,task_id,attempt_id,lease_id,lease_generation,session_id,preparation_id,purpose,driver_id,provider_instance_id,instance_revision,account_id,account_revision,credential_mode,credential_ref,binding_generation,command_spec_json,maintenance_operation_id,maintenance_epoch,launch_intent_id,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).run('admission', 'task', 'attempt', 'lease', 1, 'session', preparation.id, 'agent-launch', 'codex', created.id, created.revision, null, null, 'external', null, null, '{"kind":"driver","driverId":"codex"}', 'maintenance-op', 1, 'intent', 'admitted', now, now)
    connection.close()
    expect(() => catalogInstance.remove(created.id, created.revision)).not.toThrow()
    // The admission receipt references the preparation, so it is purged first.
    expect(rowCount(databasePath, 'provider_launch_preparations')).toBe(0)
    expect(rowCount(databasePath, 'task_launch_admissions')).toBe(0)
    expect(catalogInstance.snapshot()).toMatchObject({ instances: [] })
  })

  it('lets only one expected-revision writer win', () => {
    const first = catalog()
    const secondDatabase = openTaskAuthorityDatabase({ databasePath: databasePathOf(first) })
    databases.push(secondDatabase)
    const second = new SqliteProviderCatalog({ database: secondDatabase, registry: new AgentRegistry({ env: { PATH: binPathOf(first) } }) })
    const created = first.create(external())
    first.update(created.id, created.revision, { ...external(), displayName: 'Winner' })
    expect(failureCode(() => second.update(created.id, created.revision, { ...external(), displayName: 'Stale' }))).toBe('INSTANCE_CHANGED')
    expect(first.snapshot().instances[0]?.displayName).toBe('Winner')
  })

  it('reports a corrupt persisted row as a typed failure and leaves the database untouched', () => {
    const catalogInstance = catalog()
    catalogInstance.create(external())
    const databasePath = databasePathOf(catalogInstance)
    const connection = new DatabaseSync(databasePath)
    connection.prepare("INSERT INTO provider_instances(id,driver_id,display_name,command_spec_json,credential_mode,account_id,enabled,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run('corrupt', 'codex', 'Corrupt', 'not-json', 'external', null, 1, 1, new Date().toISOString(), new Date().toISOString())
    connection.close()
    const instancesBefore = rowCount(databasePath, 'provider_instances')
    expect(failureCode(() => catalogInstance.snapshot())).toBe('CORRUPT_CATALOG')
    expect(rowCount(databasePath, 'provider_instances')).toBe(instancesBefore)
  })

  it('requires a live destructive credential operation for binding retirement', () => {
    const catalogInstance = catalog()
    const account = catalogInstance.createAccount({ driverId: 'codex', displayLabel: 'Account' })
    const instance = catalogInstance.create({ ...external(), accountId: account.id })
    const bound = catalogInstance.bindCredential({ providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: instance.revision, expectedAccountRevision: account.revision, credentialRef: 'opaque-ref', expectedBindingGeneration: 0 })
    // No operation row and a fabricated one are both refused: there is no
    // free-standing unbind on the public surface.
    expect(failureCode(() => catalogInstance.retireCredentialBindingForOperation({ providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: bound.revision, expectedAccountRevision: account.revision, expectedBindingGeneration: 1, credentialOperationId: 'does-not-exist' }))).toBe('CREDENTIAL_REQUIRED')
    expect(rowCount(databasePathOf(catalogInstance), 'provider_credential_bindings', 'retired_at IS NULL')).toBe(1)
  })

  it('accepts an exact certification tuple and rejects every drift', () => {
    if (CERTIFICATION_PLATFORM === undefined) return
    const tuple: Partial<ProviderCertification> = { executableSha256: STUB_SHA256, version: '1.2.0', versionProbe: () => '1.2.0', allowedArgs: [], verify: () => true }
    const accepted = catalog({ certifications: bin => [certificationForStub(bin, 'codex', tuple)] })
    const account = accepted.createAccount({ driverId: 'codex', displayLabel: 'Managed' })
    expect(accepted.create({ ...external(), credentialMode: 'managed', accountId: account.id })).toMatchObject({ credentialMode: 'managed', availability: 'available' })
    expect(accepted.snapshot().drivers.find(driver => driver.kind === 'known' && driver.id === 'codex')).toMatchObject({ credentialModes: ['external', 'managed', 'none'], managedSupport: { kind: 'certified', modes: ['managed', 'none'], platform: CERTIFICATION_PLATFORM, architecture: process.arch } })

    const drift = (overrides: Partial<ProviderCertification>): string | undefined => {
      const drifted = catalog({ certifications: bin => [certificationForStub(bin, 'codex', { ...tuple, ...overrides })] })
      return failureCode(() => drifted.create({ ...external(), credentialMode: 'managed' }))
    }
    // Executable identity, version, exact argument policy, host tuple, and the
    // reviewer's verifier all participate; any mismatch fails closed and never
    // falls back to external mode.
    expect(drift({ executableSha256: 'b'.repeat(64) })).toBe('DRIVER_MODE_UNCERTIFIED')
    expect(drift({ version: '9.9.9' })).toBe('DRIVER_MODE_UNCERTIFIED')
    expect(drift({ allowedArgs: ['--isolated'] })).toBe('DRIVER_MODE_UNCERTIFIED')
    expect(drift({ verify: () => false })).toBe('DRIVER_MODE_UNCERTIFIED')
    expect(drift({ versionProbe: () => undefined })).toBe('DRIVER_MODE_UNCERTIFIED')
    expect(drift({ platform: 'plan9' as unknown as ProviderCertification['platform'] })).toBe('DRIVER_MODE_UNCERTIFIED')
    expect(drift({ architecture: 'not-this-architecture' })).toBe('DRIVER_MODE_UNCERTIFIED')
    expect(drift({ executablePath: '/nowhere/codex' })).toBe('DRIVER_MODE_UNCERTIFIED')
    // A driver with no certification entry at all stays external-only.
    expect(failureCode(() => catalog().create({ ...external('claude'), credentialMode: 'none' }))).toBe('DRIVER_MODE_UNCERTIFIED')
  })

  it('records a preparation with its exact selection, attempt, session, purpose, and bounded expiry', () => {
    const catalogInstance = catalog()
    const account = catalogInstance.createAccount({ driverId: 'codex', displayLabel: 'Account' })
    const instance = catalogInstance.create({ ...external(), accountId: account.id })
    const bound = catalogInstance.bindCredential({ providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: instance.revision, expectedAccountRevision: account.revision, credentialRef: 'opaque-ref', expectedBindingGeneration: 0 })
    const startedAt = Date.now()
    const preparation = catalogInstance.prepareLaunch({ selection: selectionFor(bound, account), attemptId: 'attempt-1', sessionId: 'session-1', purpose: 'agent-launch' })
    const finishedAt = Date.now()
    expect(preparation).toMatchObject({
      selection: { driverId: 'codex', providerInstanceId: instance.id, instanceRevision: bound.revision, accountId: account.id, accountRevision: account.revision },
      attemptId: 'attempt-1',
      sessionId: 'session-1',
      purpose: 'agent-launch',
      credentialMode: 'external',
      credentialRequest: { credentialRef: 'opaque-ref', bindingGeneration: 1, driverId: 'codex', providerInstanceId: instance.id, accountId: account.id, accountRevision: account.revision }
    })
    const expiresAt = Date.parse(preparation.expiresAt)
    // Bounded expiry: never before a pre-sample plus the TTL, never after a
    // post-sample plus the TTL.
    expect(expiresAt).toBeGreaterThanOrEqual(startedAt + 30_000)
    expect(expiresAt).toBeLessThanOrEqual(finishedAt + 30_000)
    const connection = new DatabaseSync(databasePathOf(catalogInstance))
    const row = connection.prepare('SELECT provider_instance_id,instance_revision,account_id,account_revision,credential_ref,binding_generation,attempt_id,session_id,purpose,expires_at,consumed_at FROM provider_launch_preparations WHERE id=?').get(preparation.id) as Record<string, unknown>
    connection.close()
    expect(row).toEqual({
      provider_instance_id: instance.id,
      instance_revision: bound.revision,
      account_id: account.id,
      account_revision: account.revision,
      credential_ref: 'opaque-ref',
      binding_generation: 1,
      attempt_id: 'attempt-1',
      session_id: 'session-1',
      purpose: 'agent-launch',
      expires_at: preparation.expiresAt,
      consumed_at: null
    })
  })
})
