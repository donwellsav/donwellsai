import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProviderCatalog, ProviderInstanceInput } from '@shared/provider-authority'
import { ProviderCatalogError, SqliteProviderCatalog } from './provider-catalog'
import type { TaskAuthorityDatabase } from './task-authority/schema'
import { openTaskAuthorityDatabase } from './task-authority/schema'

const directories: string[] = []
const databases: TaskAuthorityDatabase[] = []
const external = (id: 'codex' | 'claude' = 'codex'): ProviderInstanceInput => ({
  driverId: id,
  displayName: id + ' account',
  command: { kind: 'driver', driverId: id },
  credentialMode: 'external',
  accountId: null,
  enabled: true
})
function catalog(): ProviderCatalog {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'provider-catalog-')))
  directories.push(directory)
  const database = openTaskAuthorityDatabase({ databasePath: join(directory, 'authority.sqlite') })
  databases.push(database)
  return new SqliteProviderCatalog({ database })
}
afterEach(() => {
  while (databases.length) databases.pop()?.close()
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true })
})

describe('ProviderCatalog', () => {
  it('persists exact accounts, instances, and revisions when reopened', () => {
    const first = catalog()
    const account = first.createAccount({ driverId: 'codex', displayLabel: 'Personal' })
    const instance = first.create({ ...external(), accountId: account.id })
    const path = (first as SqliteProviderCatalog).databasePath
    const reopenedDatabase = openTaskAuthorityDatabase({ databasePath: path })
    databases.push(reopenedDatabase)
    const reopened = new SqliteProviderCatalog({ database: reopenedDatabase })
    expect(reopened.snapshot()).toMatchObject({ revision: 3, accounts: [account], instances: [instance] })
  })

  it('preserves an unknown persisted driver as unavailable instead of remapping it', () => {
    const first = catalog()
    const path = (first as SqliteProviderCatalog).databasePath
    const raw = new DatabaseSync(path)
    raw.prepare("INSERT INTO provider_instances(id,driver_id,display_name,command_spec_json,credential_mode,account_id,enabled,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run('legacy', 'removed-driver', 'Legacy', '{"kind":"driver","driverId":"removed-driver"}', 'external', null, 1, 1, new Date().toISOString(), new Date().toISOString())
    raw.close()
    const snapshot = first.snapshot()
    expect(snapshot.instances[0]).toMatchObject({ id: 'legacy', availability: 'unavailable', driver: { kind: 'unknown', rawDriverId: 'removed-driver' } })
  })

  it('rejects managed and none for uncertified built-in drivers before account work', () => {
    const catalogInstance = catalog()
    expect(() => catalogInstance.create({ ...external(), credentialMode: 'managed' })).toThrowError(expect.objectContaining({ code: 'DRIVER_MODE_UNCERTIFIED' }))
    expect(() => catalogInstance.create({ ...external(), credentialMode: 'none' })).toThrowError(expect.objectContaining({ code: 'DRIVER_MODE_UNCERTIFIED' }))
  })

  it('rejects preparing a disabled instance', () => {
    const catalogInstance = catalog()
    const created = catalogInstance.create({ ...external(), enabled: false })
    expect(() => catalogInstance.prepareLaunch({ selection: { driverId: 'codex', providerInstanceId: created.id, instanceRevision: created.revision, accountId: null, accountRevision: null }, attemptId: 'attempt', sessionId: 'session', purpose: 'agent-launch' })).toThrowError(expect.objectContaining({ code: 'INSTANCE_DISABLED' }))
  })

  it('does not serialize opaque credential binding metadata in projections', () => {
    const catalogInstance = catalog()
    const created = catalogInstance.create(external())
    const account = catalogInstance.createAccount({ driverId: 'codex', displayLabel: 'External' })
    const bound = catalogInstance.bindCredential({ providerInstanceId: created.id, accountId: account.id, expectedInstanceRevision: created.revision, expectedAccountRevision: account.revision, credentialRef: 'secret-ref', expectedBindingGeneration: 0 })
    expect(JSON.stringify(bound)).not.toContain('credentialRef')
    expect(JSON.stringify(bound)).not.toContain('secret-ref')
    expect(JSON.stringify(catalogInstance.snapshot())).not.toMatch(/generation|auth-file|environment|credentialRef/)
  })
})
