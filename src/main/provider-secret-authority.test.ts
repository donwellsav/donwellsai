// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SecretAuthorityError,
  asCredentialRef,
  type CredentialBackend,
  type CredentialStatus,
  type ProviderLaunchAuthorization,
  type ProviderLaunchSecrets,
  type ResolvedProviderCredentialPrincipal
} from '@shared/provider-secret-broker'
import { ProviderCatalogError, type ProviderCredentialCatalog, type ProviderCredentialOperation, type ProviderInstanceInput } from '@shared/provider-authority'
import { AgentRegistry } from './agents/registry'
import { SqliteProviderCatalog } from './provider-catalog'
import { ProviderCredentialAuthority, ProviderSecretAuthority, localProviderCredentialCatalog, type ProviderSecretEncryption } from './provider-secret-authority'
import { openTaskAuthorityDatabase, type TaskAuthorityDatabase } from './task-authority/schema'

const MARKER = 'disposable-provider-marker-0123456789'
const directories: string[] = []
const databases: TaskAuthorityDatabase[] = []

function profile(prefix: string): string {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
  directories.push(directory)
  return directory
}

/**
 * A reversible stand-in for the OS keychain. It is deliberately NOT encryption:
 * tests assert on file bytes, so the sealed form must be distinguishable from
 * plaintext while remaining fully controlled.
 */
class FakeEncryption implements ProviderSecretEncryption {
  sealed: string[] = []
  available_ = true
  backend_: CredentialBackend = 'keychain'
  rotateNext = false

  available(): Promise<boolean> { return Promise.resolve(this.available_) }
  backend(): CredentialBackend { return this.backend_ }
  encrypt(plaintext: string): Promise<Buffer> {
    this.sealed.push(plaintext)
    return Promise.resolve(Buffer.from('sealed:' + Buffer.from(plaintext, 'utf8').toString('base64'), 'utf8'))
  }
  decrypt(ciphertext: Buffer): Promise<{ plaintext: string; shouldReEncrypt: boolean }> {
    const text = ciphertext.toString('utf8')
    if (!text.startsWith('sealed:')) throw new Error('ciphertext is not sealed by this adapter')
    const rotate = this.rotateNext
    this.rotateNext = false
    return Promise.resolve({ plaintext: Buffer.from(text.slice('sealed:'.length), 'base64').toString('utf8'), shouldReEncrypt: rotate })
  }
}

function authority(directory: string, encryption: FakeEncryption, environments: Record<string, readonly string[]> = { codex: ['OPENAI_API_KEY'] }) {
  return new ProviderSecretAuthority({ userDataDir: directory, encryption, credentialEnvironments: environments })
}

function principal(overrides: Partial<ResolvedProviderCredentialPrincipal> = {}): ResolvedProviderCredentialPrincipal {
  return {
    driverId: 'codex',
    providerInstanceId: 'instance-1',
    instanceRevision: 1,
    accountId: 'account-1',
    accountRevision: 1,
    credentialRef: asCredentialRef('ref-1'),
    bindingGeneration: 1,
    ...overrides
  }
}

function authorization(overrides: Partial<ProviderLaunchAuthorization> = {}): ProviderLaunchAuthorization {
  return {
    launchAdmissionId: 'admission-1',
    preparationId: 'preparation-1',
    attemptId: 'attempt-1',
    sessionId: 'session-1',
    purpose: 'agent-launch',
    driverId: 'codex',
    providerInstanceId: 'instance-1',
    instanceRevision: 1,
    accountId: 'account-1',
    accountRevision: 1,
    credentialRef: asCredentialRef('ref-1'),
    bindingGeneration: 1,
    ...overrides
  }
}

function codeOf(error: unknown): string | undefined {
  return error instanceof SecretAuthorityError ? error.code : undefined
}

/** One sealed record as the store itself holds it. */
type StoredRecord = { ciphertext: string | null; revokedAt: string | null }

/**
 * The store's records map, read from the profile's own store file. A missing
 * store is a test failure: absence must never be silently read as "clean".
 */
function storeRecords(directory: string): Record<string, StoredRecord> {
  const storePath = join(directory, 'provider-secrets.enc.json')
  if (!existsSync(storePath)) throw new Error('the provider secret store must exist to observe its records')
  const parsed = JSON.parse(readFileSync(storePath, 'utf8')) as { records?: Record<string, StoredRecord> }
  if (!parsed.records) throw new Error('the provider secret store has no records map')
  return parsed.records
}

/** Refs whose sealed material still decrypts; a revoked ref is an inert tombstone. */
function liveRefs(directory: string): string[] {
  return Object.entries(storeRecords(directory)).filter(([, record]) => record.ciphertext !== null).map(([ref]) => ref).sort()
}

/** The records of one captured store document, for observing state while it is unreadable. */
function recordsOf(text: string): Record<string, StoredRecord> {
  return (JSON.parse(text) as { records: Record<string, StoredRecord> }).records
}

/** Every serialized file in the profile, so a plaintext leak cannot hide. */
function profileBytes(directory: string): string {
  let text = ''
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) walk(child)
      else text += readFileSync(child, 'latin1')
    }
  }
  walk(directory)
  return text
}

afterEach(() => {
  while (databases.length) databases.pop()?.close()
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true })
})

describe('ProviderSecretAuthority', () => {
  it('round-trips put -> inspect -> materialize without exposing plaintext', async () => {
    const directory = profile('provider-secrets-')
    const encryption = new FakeEncryption()
    const secrets = authority(directory, encryption)
    const status = await secrets.putProviderCredential({ operationId: 'op-1', principal: principal(), secret: MARKER })
    expect(status).toMatchObject({ state: 'present', revision: 1, backend: 'keychain' })
    expect(JSON.stringify(status)).not.toContain(MARKER)

    const inspected = await secrets.inspectProviderCredential({ principal: principal() })
    expect(inspected.state).toBe('present')
    expect(JSON.stringify(inspected)).not.toContain(MARKER)

    const launched = await secrets.materializeProviderLaunch(authorization())
    expect(launched).toEqual({ environment: { OPENAI_API_KEY: MARKER }, credentialRevision: 1 })

    // The marker exists on disk only inside the sealed blob.
    const bytes = profileBytes(directory)
    expect(bytes).not.toContain(MARKER)
    expect(encryption.sealed.join('')).toContain(MARKER)
  })

  it('refuses every mismatched principal, including a swapped record and a stale generation', async () => {
    const directory = profile('provider-secrets-mismatch-')
    const secrets = authority(directory, new FakeEncryption(), { codex: ['OPENAI_API_KEY'] })
    await secrets.putProviderCredential({ operationId: 'op-1', principal: principal(), secret: MARKER })
    await secrets.putProviderCredential({ operationId: 'op-2', principal: principal({ accountId: 'account-2', credentialRef: asCredentialRef('ref-2') }), secret: 'other-marker' })

    await expect(secrets.materializeProviderLaunch(authorization({ providerInstanceId: 'instance-9' }))).rejects.toMatchObject({ code: 'INSTANCE_MISMATCH' })
    await expect(secrets.materializeProviderLaunch(authorization({ accountId: 'account-9' }))).rejects.toMatchObject({ code: 'ACCOUNT_MISMATCH' })
    await expect(secrets.materializeProviderLaunch(authorization({ accountRevision: 2 }))).rejects.toMatchObject({ code: 'BINDING_CHANGED' })
    await expect(secrets.materializeProviderLaunch(authorization({ instanceRevision: 2 }))).rejects.toMatchObject({ code: 'BINDING_CHANGED' })
    await expect(secrets.materializeProviderLaunch(authorization({ bindingGeneration: 2 }))).rejects.toMatchObject({ code: 'BINDING_CHANGED' })
    await expect(secrets.materializeProviderLaunch(authorization({ credentialRef: asCredentialRef('absent-ref') }))).rejects.toMatchObject({ code: 'CREDENTIAL_ABSENT' })
    // Cross-account swap: account-1's ref can never return account-2's material.
    await expect(secrets.materializeProviderLaunch(authorization({ accountId: 'account-2', credentialRef: asCredentialRef('ref-1') }))).rejects.toMatchObject({ code: 'ACCOUNT_MISMATCH' })
  })

  it('denies a record copied under another key instead of retargeting it', async () => {
    const directory = profile('provider-secrets-copy-')
    const encryption = new FakeEncryption()
    const secrets = authority(directory, encryption)
    await secrets.putProviderCredential({ operationId: 'op-1', principal: principal(), secret: MARKER })
    const storePath = join(directory, 'provider-secrets.enc.json')
    const store = JSON.parse(readFileSync(storePath, 'utf8')) as { records: Record<string, unknown> }
    store.records['ref-2'] = store.records['ref-1']
    writeFileSync(storePath, JSON.stringify(store), { mode: 0o600 })

    await expect(secrets.materializeProviderLaunch(authorization({ credentialRef: asCredentialRef('ref-2') }))).rejects.toMatchObject({ code: 'CORRUPT_SECRET_STORE' })
  })

  it('serializes a revoke against materialization: revocation blocks every later call', async () => {
    const directory = profile('provider-secrets-race-')
    const secrets = authority(directory, new FakeEncryption())
    await secrets.putProviderCredential({ operationId: 'op-1', principal: principal(), secret: MARKER })
    const [revoked, launched] = await Promise.all([
      secrets.revokeProviderCredential({ principal: principal() }),
      secrets.materializeProviderLaunch(authorization()).then(() => 'materialized' as const, (error: unknown) => codeOf(error) ?? 'unknown')
    ])
    expect(revoked.state).toBe('revoked')
    // Exactly one serialized result: whichever order ran, the revoke wins and
    // every later materialization is refused.
    if (launched === 'materialized') {
      await expect(secrets.materializeProviderLaunch(authorization())).rejects.toMatchObject({ code: 'CREDENTIAL_REVOKED' })
    } else {
      expect(launched).toBe('CREDENTIAL_REVOKED')
    }
    await expect(secrets.materializeProviderLaunch(authorization())).rejects.toMatchObject({ code: 'CREDENTIAL_REVOKED' })
  })

  it('reports unavailable and preserves the original file when ciphertext is corrupt', async () => {
    const directory = profile('provider-secrets-corrupt-')
    const secrets = authority(directory, new FakeEncryption())
    await secrets.putProviderCredential({ operationId: 'op-1', principal: principal(), secret: MARKER })
    const storePath = join(directory, 'provider-secrets.enc.json')
    const before = readFileSync(storePath, 'utf8')
    writeFileSync(storePath, '{not json', { mode: 0o600 })
    const broken = readFileSync(storePath, 'utf8')
    expect(broken).toBe('{not json')
    await expect(secrets.materializeProviderLaunch(authorization())).rejects.toMatchObject({ code: 'CORRUPT_SECRET_STORE' })
    const inspected = await secrets.inspectProviderCredential({ principal: principal() })
    expect(['absent', 'unavailable']).toContain(inspected.state)
    expect(readFileSync(storePath, 'utf8')).toBe(broken)
    expect(before).not.toBe(broken)
  })

  it('re-encrypts an authenticated record atomically when the backend requests it', async () => {
    const directory = profile('provider-secrets-rotate-')
    const encryption = new FakeEncryption()
    const secrets = authority(directory, encryption)
    await secrets.putProviderCredential({ operationId: 'op-1', principal: principal(), secret: MARKER })
    const storePath = join(directory, 'provider-secrets.enc.json')
    const before = readFileSync(storePath, 'utf8')
    encryption.rotateNext = true
    const inspected = await secrets.inspectProviderCredential({ principal: principal() })
    expect(inspected.state).toBe('present')
    expect(readFileSync(storePath, 'utf8')).not.toBe(before)
    // The replacement is a valid complete store, not a partial write.
    const replaced = JSON.parse(readFileSync(storePath, 'utf8')) as { revision: number }
    expect(replaced.revision).toBeGreaterThan(1)
    const launched = await secrets.materializeProviderLaunch(authorization())
    expect(launched.environment['OPENAI_API_KEY']).toBe(MARKER)
  })

  it('refuses managed persistence on an unprotected backend without writing anything', async () => {
    const directory = profile('provider-secrets-basic-')
    const encryption = new FakeEncryption()
    encryption.backend_ = 'unprotected'
    const secrets = authority(directory, encryption)
    await expect(secrets.putProviderCredential({ operationId: 'op-1', principal: principal(), secret: MARKER })).rejects.toMatchObject({ code: 'BACKEND_UNPROTECTED' })
    expect(readdirSync(directory)).toEqual([])
  })

  it('never falls back to plaintext while the backend is temporarily unavailable', async () => {
    const directory = profile('provider-secrets-unavailable-')
    const encryption = new FakeEncryption()
    const secrets = authority(directory, encryption)
    await secrets.putProviderCredential({ operationId: 'op-1', principal: principal(), secret: MARKER })
    encryption.available_ = false
    await expect(secrets.putProviderCredential({ operationId: 'op-2', principal: principal({ credentialRef: asCredentialRef('ref-2') }), secret: 'second-marker' })).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' })
    await expect(secrets.materializeProviderLaunch(authorization())).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' })
    const status = await secrets.inspectProviderCredential({ principal: principal() })
    expect(status.state).toBe('unavailable')
    // The refused ref was never sealed, so it has no record; the byte scan is kept
    // only as a plaintext-leak guard.
    expect(storeRecords(directory)['ref-2']).toBeUndefined()
    expect(liveRefs(directory)).toEqual(['ref-1'])
    expect(profileBytes(directory)).not.toContain('second-marker')
  })

  it('leaves the previous complete store readable when a write is interrupted', async () => {
    const directory = profile('provider-secrets-interrupted-')
    const encryption = new FakeEncryption()
    const secrets = authority(directory, encryption)
    await secrets.putProviderCredential({ operationId: 'op-1', principal: principal(), secret: MARKER })
    const storePath = join(directory, 'provider-secrets.enc.json')
    const before = JSON.parse(readFileSync(storePath, 'utf8')) as { revision: number }

    class Interrupted extends FakeEncryption {
      encrypt(plaintext: string): Promise<Buffer> {
        if (plaintext.includes('second-marker')) throw new Error('simulated interruption')
        return super.encrypt(plaintext)
      }
    }
    const interrupted = authority(directory, new Interrupted())
    await expect(interrupted.putProviderCredential({ operationId: 'op-2', principal: principal({ credentialRef: asCredentialRef('ref-2') }), secret: 'second-marker' })).rejects.toThrowError()
    const after = JSON.parse(readFileSync(storePath, 'utf8')) as { revision: number }
    expect(after.revision).toBe(before.revision)
    expect(readdirSync(directory).filter(name => name.endsWith('.tmp'))).toEqual([])
    // The unaffected credential is still materializable.
    const launched = await secrets.materializeProviderLaunch(authorization())
    expect(launched.credentialRevision).toBe(1)
  })

  it('refuses a secret that is not a valid environment value or repeats a ref', async () => {
    const directory = profile('provider-secrets-shape-')
    const secrets = authority(directory, new FakeEncryption())
    await expect(secrets.putProviderCredential({ operationId: 'op-1', principal: principal(), secret: 'line\nbreak' })).rejects.toThrowError(/control/)
    await expect(secrets.putProviderCredential({ operationId: 'op-1', principal: principal(), secret: '' })).rejects.toThrowError(/non-empty/)
    await expect(secrets.putProviderCredential({ operationId: 'op-1', principal: principal(), secret: 'x'.repeat(5_000) })).rejects.toThrowError(/at most/)
    await secrets.putProviderCredential({ operationId: 'op-1', principal: principal(), secret: MARKER })
    // A different operation may not re-seal under an existing ref.
    await expect(secrets.putProviderCredential({ operationId: 'op-2', principal: principal(), secret: 'other-marker' })).rejects.toMatchObject({ code: 'BINDING_CHANGED' })
  })

  it('refuses materialization when the driver declares no managed environment', async () => {
    const directory = profile('provider-secrets-noenv-')
    const secrets = authority(directory, new FakeEncryption(), {})
    await secrets.putProviderCredential({ operationId: 'op-1', principal: principal(), secret: MARKER })
    await expect(secrets.materializeProviderLaunch(authorization())).rejects.toMatchObject({ code: 'AUTHORIZATION_INVALID' })
  })

  /**
   * Rotation on the materialize path must not consume the very plaintext it is
   * about to hand the launch, and a driver that declares no environment must
   * never cause a store mutation.
   */
  it('materializes non-empty environment values when the backend requests rotation', async () => {
    const directory = profile('provider-secrets-rotate-materialize-')
    const encryption = new FakeEncryption()
    const secrets = authority(directory, encryption)
    await secrets.putProviderCredential({ operationId: 'op-1', principal: principal(), secret: MARKER })
    const storePath = join(directory, 'provider-secrets.enc.json')
    const before = JSON.parse(readFileSync(storePath, 'utf8')) as { revision: number }

    encryption.rotateNext = true
    const launched = await secrets.materializeProviderLaunch(authorization())
    expect(launched.environment).toEqual({ OPENAI_API_KEY: MARKER })
    expect(launched.environment['OPENAI_API_KEY']).not.toBe('')
    expect(launched.credentialRevision).toBe(1)
    // The rotation actually happened, and the rotated record still decrypts.
    const after = JSON.parse(readFileSync(storePath, 'utf8')) as { revision: number }
    expect(after.revision).toBeGreaterThan(before.revision)
    expect((await secrets.materializeProviderLaunch(authorization())).environment['OPENAI_API_KEY']).toBe(MARKER)
  })

  it('does not mutate the store when rotation is requested but no environment is declared', async () => {
    const directory = profile('provider-secrets-rotate-noenv-')
    const encryption = new FakeEncryption()
    const secrets = authority(directory, encryption, {})
    await secrets.putProviderCredential({ operationId: 'op-1', principal: principal(), secret: MARKER })
    const storePath = join(directory, 'provider-secrets.enc.json')
    const before = JSON.parse(readFileSync(storePath, 'utf8')) as { revision: number }

    encryption.rotateNext = true
    await expect(secrets.materializeProviderLaunch(authorization())).rejects.toMatchObject({ code: 'AUTHORIZATION_INVALID' })
    // The refusal must precede the rotation write, so the store is untouched.
    expect((JSON.parse(readFileSync(storePath, 'utf8')) as { revision: number }).revision).toBe(before.revision)
  })
})

describe('ProviderCredentialAuthority', () => {
  /**
   * The shipped managed-support matrix is empty, so a managed instance needs a
   * reviewed certification bound to this profile's own stub executable. This
   * mirrors production: managed credentials exist only for certified tuples.
   */
  function catalogue(prefix: string) {
    const directory = profile(prefix)
    const bin = join(directory, 'bin')
    mkdirSync(bin, { recursive: true, mode: 0o700 })
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const database = openTaskAuthorityDatabase({ databasePath: join(directory, 'authority.sqlite') })
    databases.push(database)
    const catalog = new SqliteProviderCatalog({
      database,
      registry: new AgentRegistry({ env: { PATH: bin } }),
      certifications: [{
        driverId: 'codex',
        modes: ['managed', 'none'],
        executablePath: join(bin, 'codex'),
        supportedVersionRange: '>=1.0.0 <2.0.0',
        platform: process.platform as 'darwin' | 'linux' | 'win32',
        architecture: process.arch
      }]
    })
    return { directory, database, catalog }
  }

  const managed: ProviderInstanceInput = {
    driverId: 'codex',
    displayName: 'Codex',
    command: { kind: 'driver', driverId: 'codex' },
    credentialMode: 'managed',
    accountId: null,
    enabled: true
  }

  it('writes, reports, replaces, and revokes through the saga without leaking internals', async () => {
    const { directory, catalog } = catalogue('provider-saga-')
    const secrets = authority(directory, new FakeEncryption())
    const credentials = new ProviderCredentialAuthority({ catalog: localProviderCredentialCatalog(catalog), authority: secrets })
    const account = catalog.createAccount({ driverId: 'codex', displayLabel: 'Personal' })
    const instance = catalog.create({ ...managed, accountId: account.id })

    const written = await credentials.write({ providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: instance.revision, expectedAccountRevision: account.revision, secret: MARKER })
    expect(written.status.state).toBe('present')
    expect(JSON.stringify(written)).not.toContain(MARKER)
    expect(JSON.stringify(written)).not.toMatch(/credentialRef|bindingGeneration|credentialRevision/)

    const read = await credentials.status({ providerInstanceId: instance.id, accountId: account.id })
    expect(read.status.state).toBe('present')

    const current = catalog.snapshot().instances[0]!
    const replaced = await credentials.write({ providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: current.revision, expectedAccountRevision: account.revision, secret: 'replacement-marker' })
    expect(replaced.status.state).toBe('present')
    expect(replaced.status.revision).toBeGreaterThan(written.status.revision)
    // The superseded ref is revoked into an inert tombstone and the replacement is
    // the only live record; the byte scan is kept only as a plaintext-leak guard.
    expect(catalog.incompleteCredentialOperations()).toEqual([])
    expect(liveRefs(directory)).toHaveLength(1)
    expect(liveRefs(directory)[0]).toBe(catalog.credentialBinding(instance.id, account.id)!.credentialRef)
    expect(Object.values(storeRecords(directory)).filter(record => record.ciphertext === null)).toHaveLength(1)
    expect(profileBytes(directory)).not.toContain('replacement-marker')

    const revoked = await credentials.revoke({ providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: catalog.snapshot().instances[0]!.revision, expectedAccountRevision: account.revision })
    expect(revoked.status.state).toBe('revoked')
    expect(catalog.credentialBinding(instance.id, account.id)).toBeNull()
  })

  it('refuses a write whose expected revisions no longer match', async () => {
    const { directory, catalog } = catalogue('provider-saga-stale-')
    const credentials = new ProviderCredentialAuthority({ catalog: localProviderCredentialCatalog(catalog), authority: authority(directory, new FakeEncryption()) })
    const account = catalog.createAccount({ driverId: 'codex', displayLabel: 'Personal' })
    const instance = catalog.create({ ...managed, accountId: account.id })
    await expect(credentials.write({ providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: instance.revision + 5, expectedAccountRevision: account.revision, secret: MARKER })).rejects.toMatchObject({ code: 'BINDING_CHANGED' })
    expect(catalog.incompleteCredentialOperations()).toEqual([])
  })

  it('refuses a managed credential for an external-mode instance', async () => {
    const { directory, catalog } = catalogue('provider-saga-external-')
    const credentials = new ProviderCredentialAuthority({ catalog: localProviderCredentialCatalog(catalog), authority: authority(directory, new FakeEncryption()) })
    const account = catalog.createAccount({ driverId: 'codex', displayLabel: 'Personal' })
    const external = catalog.create({ ...managed, credentialMode: 'external', accountId: account.id })
    await expect(credentials.write({ providerInstanceId: external.id, accountId: account.id, expectedInstanceRevision: external.revision, expectedAccountRevision: account.revision, secret: MARKER })).rejects.toThrowError(/external providers/)
    expect(catalog.incompleteCredentialOperations()).toEqual([])
  })

  /**
   * Each variant stops the real saga at one crash boundary by driving its
   * durable steps directly and never closing the operation. Reconciliation must
   * then settle the tuple without guessing: exactly one ref stays active, every
   * staged or superseded ref ends revoked, and repeating it changes nothing.
   */
  const boundaries = [
    ['before the secret is sealed', false, false],
    ['after the secret commit but before the Catalog bind', true, false],
    ['after the Catalog compare-and-set', true, true]
  ] as const

  it.each(boundaries)('reconciles an interrupted create-replace (%s) to exactly one active ref', async (_label, seal, bind) => {
    const { directory, catalog } = catalogue('provider-saga-crash-')
    const encryption = new FakeEncryption()
    const secrets = authority(directory, encryption)
    const credentials = new ProviderCredentialAuthority({ catalog: localProviderCredentialCatalog(catalog), authority: secrets })
    const account = catalog.createAccount({ driverId: 'codex', displayLabel: 'Personal' })
    const instance = catalog.create({ ...managed, accountId: account.id })
    await credentials.write({ providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: instance.revision, expectedAccountRevision: account.revision, secret: MARKER })
    const before = catalog.credentialBinding(instance.id, account.id)!

    const staged = await secrets.reserveProviderCredentialRef()
    const revision = catalog.snapshot().instances[0]!.revision
    const operation = catalog.stageCredentialReplace({ operationId: 'interrupted-op', providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: revision, expectedAccountRevision: account.revision, stagedCredentialRef: staged })
    const target: ResolvedProviderCredentialPrincipal = { driverId: 'codex', providerInstanceId: instance.id, instanceRevision: revision, accountId: account.id, accountRevision: account.revision, credentialRef: staged, bindingGeneration: operation.targetBindingGeneration! }
    if (seal) await secrets.putProviderCredential({ operationId: operation.id, principal: target, secret: 'staged-marker' })
    if (bind) {
      expect(catalog.bindStagedCredential({ operationId: operation.id, providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: revision, expectedAccountRevision: account.revision, targetCredentialRef: staged, targetBindingGeneration: operation.targetBindingGeneration!, expectedBindingGeneration: operation.priorBindingGeneration ?? 0 })).toBe(true)
    }

    expect(await credentials.reconcile()).toEqual({ resolved: 1, blocked: [] })
    const after = catalog.credentialBinding(instance.id, account.id)
    expect(after).not.toBeNull()
    expect(catalog.incompleteCredentialOperations()).toEqual([])
    // A bind that landed is kept; a bind that did not is abandoned. Either way
    // exactly one ref is active and the staged ref is never left live-but-unbound.
    expect(after!.credentialRef).toBe(bind ? staged : before.credentialRef)
    // Exactly one record is live in every variant: never the staged ref left
    // live-but-unbound, and never a superseded ref left decryptable.
    expect(liveRefs(directory)).toEqual([after!.credentialRef])
    if (!seal) {
      // The staged material was never written, so its ref has no record at all.
      expect(storeRecords(directory)[staged]).toBeUndefined()
      expect(Object.keys(storeRecords(directory))).toEqual([after!.credentialRef])
    } else {
      // A sealed staged ref is accounted for as either the published target or an
      // inert revoked tombstone, never as orphaned live material; the superseded
      // prior ref is the other record and is always the tombstone in that pair.
      expect(storeRecords(directory)[staged]).toMatchObject({ ciphertext: bind ? expect.any(String) : null })
      expect(storeRecords(directory)[before.credentialRef]).toMatchObject({ ciphertext: bind ? null : expect.any(String) })
      expect(Object.keys(storeRecords(directory)).sort()).toEqual([staged, before.credentialRef].sort())
    }
    // Retained only as a plaintext-leak guard; the record-state checks above are
    // the discriminating ones.
    expect(profileBytes(directory)).not.toContain('staged-marker')
    expect(await credentials.reconcile()).toEqual({ resolved: 0, blocked: [] })
  })

  it('reconciles an interrupted revoke by revoking the exact ref and retiring it', async () => {
    const { directory, catalog } = catalogue('provider-saga-revoke-')
    const secrets = authority(directory, new FakeEncryption())
    const credentials = new ProviderCredentialAuthority({ catalog: localProviderCredentialCatalog(catalog), authority: secrets })
    const account = catalog.createAccount({ driverId: 'codex', displayLabel: 'Personal' })
    const instance = catalog.create({ ...managed, accountId: account.id })
    await credentials.write({ providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: instance.revision, expectedAccountRevision: account.revision, secret: MARKER })
    const binding = catalog.credentialBinding(instance.id, account.id)!

    // The revoke intent is durable, but the process died before revoking.
    catalog.stageCredentialRevoke({ operationId: 'interrupted-revoke', providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: catalog.snapshot().instances[0]!.revision, expectedAccountRevision: account.revision })
    expect(catalog.incompleteCredentialOperations()).toHaveLength(1)

    expect(await credentials.reconcile()).toEqual({ resolved: 1, blocked: [] })
    expect(catalog.credentialBinding(instance.id, account.id)).toBeNull()
    await expect(secrets.materializeProviderLaunch(authorization({ credentialRef: asCredentialRef(binding.credentialRef) }))).rejects.toMatchObject({ code: 'CREDENTIAL_REVOKED' })
    expect(await credentials.reconcile()).toEqual({ resolved: 0, blocked: [] })
  })

  /**
   * A completed revoke leaves the tuple with no live binding but with retired
   * history that still owns its generation. Reconciling the interrupted
   * retirement must close cleanly, and the user's next write must then succeed:
   * a generation allocated from the live row alone would reuse the retired
   * generation and be refused by the primary key, wedging the account after its
   * first revocation.
   */
  it('rebinds after an interrupted revoke instead of reusing the retired generation', async () => {
    const { directory, catalog } = catalogue('provider-saga-revoked-crash-')
    const secrets = authority(directory, new FakeEncryption())
    const credentials = new ProviderCredentialAuthority({ catalog: localProviderCredentialCatalog(catalog), authority: secrets })
    const account = catalog.createAccount({ driverId: 'codex', displayLabel: 'Personal' })
    const instance = catalog.create({ ...managed, accountId: account.id })
    await credentials.write({ providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: instance.revision, expectedAccountRevision: account.revision, secret: MARKER })
    const binding = catalog.credentialBinding(instance.id, account.id)!
    const intent = catalog.stageCredentialRevoke({ operationId: 'revoked-then-crashed', providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: catalog.snapshot().instances[0]!.revision, expectedAccountRevision: account.revision })
    // The Secret Authority revocation landed; the Catalog retirement never ran.
    await secrets.revokeProviderCredential({
      principal: { driverId: 'codex', providerInstanceId: instance.id, instanceRevision: catalog.snapshot().instances[0]!.revision, accountId: account.id, accountRevision: account.revision, credentialRef: asCredentialRef(intent.priorCredentialRef!), bindingGeneration: intent.priorBindingGeneration! }
    })
    expect(storeRecords(directory)[binding.credentialRef]).toMatchObject({ ciphertext: null })
    expect(catalog.credentialBinding(instance.id, account.id)?.credentialRef).toBe(binding.credentialRef)

    expect(await credentials.reconcile()).toEqual({ resolved: 1, blocked: [] })
    expect(catalog.credentialBinding(instance.id, account.id)).toBeNull()
    expect(catalog.incompleteCredentialOperations()).toEqual([])
    // The tuple is not wedged: the next saga must allocate a generation above the
    // retired one rather than colliding with it.
    const rewritten = await credentials.write({ providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: catalog.snapshot().instances[0]!.revision, expectedAccountRevision: account.revision, secret: 'replacement-marker' })
    expect(rewritten.status.state).toBe('present')
    expect(catalog.credentialBinding(instance.id, account.id)?.bindingGeneration).toBe(2)
  })

  /**
   * Reconciliation is the recovery authority for interrupted sagas, so a
   * revocation it cannot complete must leave the intent visible rather than
   * closing it to a terminal lie while decryptable material survives.
   */
  it('leaves a reconcilable operation incomplete when its revocation fails', async () => {
    const { directory, catalog } = catalogue('provider-saga-revoke-failure-')
    const encryption = new FakeEncryption()
    const secrets = authority(directory, encryption)
    const credentials = new ProviderCredentialAuthority({ catalog: localProviderCredentialCatalog(catalog), authority: secrets })
    const account = catalog.createAccount({ driverId: 'codex', displayLabel: 'Personal' })
    const instance = catalog.create({ ...managed, accountId: account.id })
    await credentials.write({ providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: instance.revision, expectedAccountRevision: account.revision, secret: MARKER })
    const binding = catalog.credentialBinding(instance.id, account.id)!
    catalog.stageCredentialRevoke({ operationId: 'failing-revoke', providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: catalog.snapshot().instances[0]!.revision, expectedAccountRevision: account.revision })

    // The store is made temporarily unreadable, then restored to its exact
    // bytes, so the revoked material is genuinely still durable while blind and
    // genuinely revoked afterwards.
    const storePath = join(directory, 'provider-secrets.enc.json')
    const intact = readFileSync(storePath, 'utf8')
    writeFileSync(storePath, '{corrupt', { mode: 0o600 })
    const reconciled = await credentials.reconcile()
    expect(reconciled.resolved).toBe(0)
    expect(reconciled.blocked).toEqual(['failing-revoke'])
    expect(catalog.incompleteCredentialOperations().map(operation => operation.id)).toEqual(['failing-revoke'])
    // The binding was not retired: revocation precedes retirement.
    expect(catalog.credentialBinding(instance.id, account.id)?.credentialRef).toBe(binding.credentialRef)

    // While blind, the target record is untouched and still decryptable.
    writeFileSync(storePath, intact, { mode: 0o600 })
    expect(liveRefs(directory)).toContain(binding.credentialRef)

    // Once the store is readable again, reconciliation revokes it and retires.
    expect(await credentials.reconcile()).toEqual({ resolved: 1, blocked: [] })
    expect(catalog.credentialBinding(instance.id, account.id)).toBeNull()
    // The ref survives as an inert tombstone: revoked, not deleted.
    expect(storeRecords(directory)[binding.credentialRef]).toMatchObject({ ciphertext: null })
    expect(liveRefs(directory)).not.toContain(binding.credentialRef)
  })

  it('leaves a catalog-bound operation incomplete when its superseded revoke fails', async () => {
    const { directory, catalog } = catalogue('provider-saga-bound-failure-')
    const encryption = new FakeEncryption()
    const secrets = authority(directory, encryption)
    const credentials = new ProviderCredentialAuthority({ catalog: localProviderCredentialCatalog(catalog), authority: secrets })
    const account = catalog.createAccount({ driverId: 'codex', displayLabel: 'Personal' })
    const instance = catalog.create({ ...managed, accountId: account.id })
    await credentials.write({ providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: instance.revision, expectedAccountRevision: account.revision, secret: MARKER })

    // Drive the real saga to its catalog-bound checkpoint, then corrupt the store
    // so the superseded-ref revocation cannot complete.
    const staged = await secrets.reserveProviderCredentialRef()
    const prior = catalog.credentialBinding(instance.id, account.id)!
    const revision = catalog.snapshot().instances[0]!.revision
    const operation = catalog.stageCredentialReplace({ operationId: 'bound-op', providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: revision, expectedAccountRevision: account.revision, stagedCredentialRef: staged })
    const target: ResolvedProviderCredentialPrincipal = { driverId: 'codex', providerInstanceId: instance.id, instanceRevision: revision + 1, accountId: account.id, accountRevision: account.revision, credentialRef: staged, bindingGeneration: operation.targetBindingGeneration! }
    await secrets.putProviderCredential({ operationId: 'bound-op', principal: target, secret: 'staged-marker' })
    expect(catalog.bindStagedCredential({ operationId: 'bound-op', providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: revision, expectedAccountRevision: account.revision, targetCredentialRef: staged, targetBindingGeneration: operation.targetBindingGeneration!, expectedBindingGeneration: operation.priorBindingGeneration ?? 0 })).toBe(true)
    expect(catalog.credentialOperation('bound-op')?.state).toBe('catalog-bound')

    const storePath = join(directory, 'provider-secrets.enc.json')
    const intact = readFileSync(storePath, 'utf8')
    writeFileSync(storePath, '{corrupt', { mode: 0o600 })
    const reconciled = await credentials.reconcile()
    expect(reconciled.resolved).toBe(0)
    expect(reconciled.blocked).toEqual(['bound-op'])
    // A bound saga is never rewritten to a terminal state it did not reach.
    expect(catalog.credentialOperation('bound-op')?.state).toBe('catalog-bound')

    writeFileSync(storePath, intact, { mode: 0o600 })
    expect(liveRefs(directory)).toContain(staged)
    expect(liveRefs(directory)).toContain(prior.credentialRef)
    expect(await credentials.reconcile()).toEqual({ resolved: 1, blocked: [] })
    expect(catalog.credentialOperation('bound-op')?.state).toBe('complete')
    // The superseded ref is the one revoked; the published target stays live.
    expect(storeRecords(directory)[prior.credentialRef]).toMatchObject({ ciphertext: null })
    expect(liveRefs(directory)).toEqual([staged])
  })

  it('keeps a failed revoke() recoverable instead of orphaning a revoked binding', async () => {
    const { directory, catalog } = catalogue('provider-saga-revoke-orphan-')
    const encryption = new FakeEncryption()
    const secrets = authority(directory, encryption)
    const credentials = new ProviderCredentialAuthority({ catalog: localProviderCredentialCatalog(catalog), authority: secrets })
    const account = catalog.createAccount({ driverId: 'codex', displayLabel: 'Personal' })
    const instance = catalog.create({ ...managed, accountId: account.id })
    await credentials.write({ providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: instance.revision, expectedAccountRevision: account.revision, secret: MARKER })
    const binding = catalog.credentialBinding(instance.id, account.id)!

    // The Catalog retirement fails after the secret is already revoked. The
    // pending intent must survive so reconciliation can finish the retirement.
    const failing = localProviderCredentialCatalog(catalog)
    const failingCredentials = new ProviderCredentialAuthority({ catalog: { ...failing, retireCredentialBindingForOperation: async () => { throw new Error('retirement unavailable') } }, authority: secrets })
    await expect(failingCredentials.revoke({ providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: catalog.snapshot().instances[0]!.revision, expectedAccountRevision: account.revision })).rejects.toThrowError(/retirement unavailable/)
    expect(catalog.incompleteCredentialOperations()).toHaveLength(1)
    expect(catalog.credentialBinding(instance.id, account.id)?.credentialRef).toBe(binding.credentialRef)

    // Reconciliation completes the exact revoke-then-retire path.
    expect(await credentials.reconcile()).toEqual({ resolved: 1, blocked: [] })
    expect(catalog.credentialBinding(instance.id, account.id)).toBeNull()
    expect(catalog.incompleteCredentialOperations()).toEqual([])
  })

  /**
   * An `aborted` row must never coexist with a live sealed staged record:
   * `incompleteCredentialOperations()` skips terminal rows, so a staged secret
   * whose saga was written off is never revoked by anyone. These cases drive the
   * two ways a write can fail after the staged ciphertext is already durable,
   * and they inject the failure at the Catalog seam rather than stubbing it.
   */
  /**
   * Replaces the live binding out-of-band, as a different process's completed
   * saga would, so the saga under test genuinely loses its compare-and-set.
   * Going through the saga API would be refused by design (one live intent per
   * tuple), which is why this writes the Catalog facts directly.
   */
  function loseRaceWithNewBinding(catalog: SqliteProviderCatalog, providerInstanceId: string, accountId: string, credentialRef: string): void {
    const connection = new DatabaseSync(catalog.databasePath)
    try {
      connection.exec('BEGIN IMMEDIATE')
      connection.prepare('UPDATE provider_credential_bindings SET retired_at=? WHERE provider_instance_id=? AND account_id=? AND retired_at IS NULL').run(new Date().toISOString(), providerInstanceId, accountId)
      connection.prepare('INSERT INTO provider_credential_bindings(provider_instance_id,account_id,account_revision,credential_ref,generation,created_at,retired_at) VALUES (?,?,?,?,?,?,NULL)').run(providerInstanceId, accountId, 1, credentialRef, 2, new Date().toISOString())
      connection.exec('COMMIT')
    } finally {
      connection.close()
    }
  }

  it('keeps a lost compare-and-set recoverable when the staged revoke fails', async () => {
    const { directory, catalog } = catalogue('provider-saga-lost-cas-')
    const secrets = authority(directory, new FakeEncryption())
    const credentials = new ProviderCredentialAuthority({ catalog: localProviderCredentialCatalog(catalog), authority: secrets })
    const account = catalog.createAccount({ driverId: 'codex', displayLabel: 'Personal' })
    const instance = catalog.create({ ...managed, accountId: account.id })
    await credentials.write({ providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: instance.revision, expectedAccountRevision: account.revision, secret: MARKER })

    const storePath = join(directory, 'provider-secrets.enc.json')
    // Captured at the corruption seam, i.e. after the staged material is already
    // sealed and persisted, so restoring it preserves the very evidence under test.
    let sealed = ''
    // The binding changes underneath the saga, and the store becomes unreadable at
    // the same seam, so its staged revoke cannot succeed either.
    const racing: ProviderCredentialCatalog = {
      ...localProviderCredentialCatalog(catalog),
      bindStagedCredential: async () => {
        loseRaceWithNewBinding(catalog, instance.id, account.id, 'third-ref')
        sealed = readFileSync(storePath, 'utf8')
        writeFileSync(storePath, '{corrupt', { mode: 0o600 })
        return false
      }
    }
    const racingCredentials = new ProviderCredentialAuthority({ catalog: racing, authority: secrets })
    await expect(racingCredentials.write({ providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: catalog.snapshot().instances[0]!.revision, expectedAccountRevision: account.revision, secret: 'staged-marker' })).rejects.toMatchObject({ code: 'BINDING_CHANGED' })
    expect(catalog.credentialBinding(instance.id, account.id)?.credentialRef).toBe('third-ref')

    // The unrevocable saga stays visible, and the staged material is exactly the
    // decryptable record the invariant forbids writing off.
    const blocked = await credentials.reconcile()
    expect(blocked.blocked).toHaveLength(1)
    expect(blocked.resolved).toBe(0)
    expect(catalog.credentialBinding(instance.id, account.id)?.credentialRef).toBe('third-ref')
    const staged = catalog.incompleteCredentialOperations()[0]!.stagedCredentialRef!
    writeFileSync(storePath, sealed, { mode: 0o600 })
    expect(liveRefs(directory)).toContain(staged)
    expect(storeRecords(directory)[staged]).toMatchObject({ ciphertext: expect.any(String), revokedAt: null })

    // While a third binding stands, the saga stays blocked even with a readable
    // store: the brief forbids guessing which binding the user meant.
    const stillBlocked = await credentials.reconcile()
    expect(stillBlocked.resolved).toBe(0)
    expect(stillBlocked.blocked).toHaveLength(1)
    expect(storeRecords(directory)[staged]).toMatchObject({ ciphertext: expect.any(String) })

    // Once the competing binding is gone the absent-binding case applies, so
    // reconciliation revokes the exact staged ref and closes the saga.
    const connection = new DatabaseSync(catalog.databasePath)
    connection.prepare('UPDATE provider_credential_bindings SET retired_at=? WHERE provider_instance_id=? AND account_id=? AND retired_at IS NULL').run(new Date().toISOString(), instance.id, account.id)
    connection.close()
    expect(await credentials.reconcile()).toEqual({ resolved: 1, blocked: [] })
    expect(catalog.incompleteCredentialOperations()).toEqual([])
    expect(catalog.credentialBinding(instance.id, account.id)).toBeNull()
    // Revoked into an inert tombstone, not deleted and not left live.
    expect(storeRecords(directory)[staged]).toMatchObject({ ciphertext: null })
    expect(liveRefs(directory)).not.toContain(staged)
  })

  it('aborts a lost compare-and-set once the staged ref is provably revoked', async () => {
    const { directory, catalog } = catalogue('provider-saga-lost-cas-ok-')
    const secrets = authority(directory, new FakeEncryption())
    const credentials = new ProviderCredentialAuthority({ catalog: localProviderCredentialCatalog(catalog), authority: secrets })
    const account = catalog.createAccount({ driverId: 'codex', displayLabel: 'Personal' })
    const instance = catalog.create({ ...managed, accountId: account.id })
    await credentials.write({ providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: instance.revision, expectedAccountRevision: account.revision, secret: MARKER })
    const before = liveRefs(directory)

    const racing: ProviderCredentialCatalog = {
      ...localProviderCredentialCatalog(catalog),
      bindStagedCredential: async () => {
        loseRaceWithNewBinding(catalog, instance.id, account.id, 'third-ref')
        return false
      }
    }
    const racingCredentials = new ProviderCredentialAuthority({ catalog: racing, authority: secrets })
    await expect(racingCredentials.write({ providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: catalog.snapshot().instances[0]!.revision, expectedAccountRevision: account.revision, secret: 'staged-marker' })).rejects.toMatchObject({ code: 'BINDING_CHANGED' })

    // The provable abort still terminates the saga, and the staged secret is
    // genuinely gone: revoked into a tombstone rather than left decryptable.
    expect(catalog.incompleteCredentialOperations()).toEqual([])
    expect(catalog.credentialBinding(instance.id, account.id)?.credentialRef).toBe('third-ref')
    expect(liveRefs(directory)).toEqual(before)
    expect(await credentials.reconcile()).toEqual({ resolved: 0, blocked: [] })
  })

  it('leaves no decryptable staged material when a throwing bind can still revoke', async () => {
    const { directory, catalog } = catalogue('provider-saga-bind-throw-')
    const secrets = authority(directory, new FakeEncryption())
    const credentials = new ProviderCredentialAuthority({ catalog: localProviderCredentialCatalog(catalog), authority: secrets })
    const account = catalog.createAccount({ driverId: 'codex', displayLabel: 'Personal' })
    const instance = catalog.create({ ...managed, accountId: account.id })
    await credentials.write({ providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: instance.revision, expectedAccountRevision: account.revision, secret: MARKER })
    const before = liveRefs(directory)

    // The bind throws after the staged ciphertext is durable. Reachable from the
    // real method through revision validation and foreign-key guarding.
    const throwing: ProviderCredentialCatalog = {
      ...localProviderCredentialCatalog(catalog),
      bindStagedCredential: async () => { throw new ProviderCatalogError('FOREIGN_KEY_CONFLICT', 'the target credential binding could not be published') }
    }
    const throwingCredentials = new ProviderCredentialAuthority({ catalog: throwing, authority: secrets })
    await expect(throwingCredentials.write({ providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: catalog.snapshot().instances[0]!.revision, expectedAccountRevision: account.revision, secret: 'staged-marker' })).rejects.toThrowError(/could not be published/)

    // Where the abort can revoke, it does: every live record is the one from the
    // prior successful write, so the staged secret did not survive.
    expect(catalog.incompleteCredentialOperations()).toEqual([])
    expect(liveRefs(directory)).toEqual(before)
    expect(await credentials.reconcile()).toEqual({ resolved: 0, blocked: [] })

    // The same failure with an unreadable store leaves the saga blocked. The store
    // is restored to its exact bytes, so the staged material is genuinely still
    // durable while blind and genuinely revoked after reconciliation.
    const storePath = join(directory, 'provider-secrets.enc.json')
    // Captured at the corruption seam, after the staged record is durable.
    let sealed = ''
    const unreadable: ProviderCredentialCatalog = {
      ...localProviderCredentialCatalog(catalog),
      bindStagedCredential: async () => {
        sealed = readFileSync(storePath, 'utf8')
        writeFileSync(storePath, '{corrupt', { mode: 0o600 })
        throw new ProviderCatalogError('FOREIGN_KEY_CONFLICT', 'the target credential binding could not be published')
      }
    }
    const blockedCredentials = new ProviderCredentialAuthority({ catalog: unreadable, authority: secrets })
    await expect(blockedCredentials.write({ providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: catalog.snapshot().instances[0]!.revision, expectedAccountRevision: account.revision, secret: 'third-staged-marker' })).rejects.toThrowError(/could not be published/)
    expect(catalog.incompleteCredentialOperations()).toHaveLength(1)
    const staged = catalog.incompleteCredentialOperations()[0]!.stagedCredentialRef!
    // While the store is unreadable the saga is blocked, not closed.
    const blind = await credentials.reconcile()
    expect(blind.resolved).toBe(0)
    expect(blind.blocked).toHaveLength(1)

    // Restoring the sealed bytes leaves the staged material genuinely durable.
    writeFileSync(storePath, sealed, { mode: 0o600 })
    expect(liveRefs(directory)).toContain(staged)

    // Now reconciliation actually revokes the surviving material and closes the saga.
    expect(await credentials.reconcile()).toEqual({ resolved: 1, blocked: [] })
    expect(catalog.incompleteCredentialOperations()).toEqual([])
    expect(storeRecords(directory)[staged]).toMatchObject({ ciphertext: null })
    expect(liveRefs(directory)).not.toContain(staged)
  })

  it('leaves a third-binding conflict blocked for explicit recovery', async () => {
    const { directory, catalog } = catalogue('provider-saga-blocked-')
    const secrets = authority(directory, new FakeEncryption())
    const credentials = new ProviderCredentialAuthority({ catalog: localProviderCredentialCatalog(catalog), authority: secrets })
    const account = catalog.createAccount({ driverId: 'codex', displayLabel: 'Personal' })
    const instance = catalog.create({ ...managed, accountId: account.id })
    const staged = await secrets.reserveProviderCredentialRef()
    catalog.stageCredentialReplace({ operationId: 'blocked-op', providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: instance.revision, expectedAccountRevision: account.revision, stagedCredentialRef: staged })
    // A different ref is bound by another path: neither the staged target nor
    // the recorded prior matches, so reconciliation must not guess.
    catalog.bindCredential({ providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: instance.revision, expectedAccountRevision: account.revision, credentialRef: 'third-ref', expectedBindingGeneration: 0 })
    const reconciled = await credentials.reconcile()
    expect(reconciled.resolved).toBe(0)
    expect(reconciled.blocked).toEqual(['blocked-op'])
    expect(catalog.incompleteCredentialOperations()).toHaveLength(1)
  })

  it('refuses identity mutations while a credential operation is live', async () => {
    const { directory, catalog } = catalogue('provider-saga-guard-')
    const secrets = authority(directory, new FakeEncryption())
    const credentials = new ProviderCredentialAuthority({ catalog: localProviderCredentialCatalog(catalog), authority: secrets })
    const account = catalog.createAccount({ driverId: 'codex', displayLabel: 'Personal' })
    const instance = catalog.create({ ...managed, accountId: account.id })
    await credentials.write({ providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: instance.revision, expectedAccountRevision: account.revision, secret: MARKER })
    catalog.stageCredentialRevoke({ operationId: 'live-op', providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: catalog.snapshot().instances[0]!.revision, expectedAccountRevision: account.revision })
    expect(() => catalog.updateAccount({ id: account.id, expectedRevision: account.revision, displayLabel: 'Renamed' })).toThrowError(/credential operation/)
    expect(() => catalog.removeAccount({ id: account.id, expectedRevision: account.revision })).toThrowError(/credential operation/)
    expect(() => catalog.update(instance.id, catalog.snapshot().instances[0]!.revision, { ...managed, accountId: account.id, displayName: 'Renamed' })).toThrowError(/credential operation/)
    expect(() => catalog.remove(instance.id, catalog.snapshot().instances[0]!.revision)).toThrowError(/credential operation/)
  })

  it('never reports a bound credential status as launch authority', async () => {
    const { directory, catalog } = catalogue('provider-saga-status-')
    const credentials = new ProviderCredentialAuthority({ catalog: localProviderCredentialCatalog(catalog), authority: authority(directory, new FakeEncryption()) })
    const account = catalog.createAccount({ driverId: 'codex', displayLabel: 'Personal' })
    const instance = catalog.create({ ...managed, accountId: account.id })
    const result = await credentials.status({ providerInstanceId: instance.id, accountId: account.id })
    expect(result.status).toMatchObject({ state: 'absent', revision: 0 })
    const status: CredentialStatus = result.status
    expect(Object.keys(status).sort()).toEqual(['backend', 'revision', 'state', 'updatedAt'])
  })

  it('reports no plaintext in the durable store after a full lifecycle', async () => {
    const { directory, catalog } = catalogue('provider-saga-bytes-')
    const credentials = new ProviderCredentialAuthority({ catalog: localProviderCredentialCatalog(catalog), authority: authority(directory, new FakeEncryption()) })
    const account = catalog.createAccount({ driverId: 'codex', displayLabel: 'Personal' })
    const instance = catalog.create({ ...managed, accountId: account.id })
    await credentials.write({ providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: instance.revision, expectedAccountRevision: account.revision, secret: MARKER })
    await credentials.revoke({ providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: catalog.snapshot().instances[0]!.revision, expectedAccountRevision: account.revision })
    const bytes = profileBytes(directory)
    expect(bytes).not.toContain(MARKER)
    // Revocation destroys the material: the revoked credential is gone from the
    // store, so status reports absence rather than a retained value, and there
    // is no path that returns the secret for that exact instance/account again.
    const after = await credentials.status({ providerInstanceId: instance.id, accountId: account.id })
    expect(after.status.state).toBe('absent')
    expect(JSON.stringify(after)).not.toContain(MARKER)
  })
})
