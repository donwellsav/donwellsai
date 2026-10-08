// @vitest-environment node
import { spawn, spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ProcessIdentity } from './child-process/process-spec'
import { runtimeAuthorityLock, type RuntimeAuthorityLock, type RuntimeFileIdentityReader } from './runtime-file-security'
import { RuntimeOwnershipStore, type RuntimeOwner } from './runtime-ownership'

const identity: ProcessIdentity = {
  pid: 100,
  bootId: 'boot-a',
  startedAt: 'birth-a',
  executablePath: '/opt/donwells',
  family: 'donwells-app',
  capturedAt: '2026-09-13T00:00:00.000Z'
}

function candidate(ownerId: string, endpoint = '/tmp/donwells-owner.sock', generation = 1): Omit<RuntimeOwner, 'generation' | 'state' | 'locatorSha256' | 'endpointFileIdentity'> {
  return {
    kind: 'donwells-app',
    ownerId,
    identity: { ...identity, generation: ownerId + ':' + generation },
    endpoint,
    authToken: 'token-' + ownerId
  }
}

function stale(identityValue = identity): { status: 'stale'; reason: 'not-found' | 'pid-reused' | 'executable-mismatch' } {
  return { status: 'stale', reason: identityValue === identity ? 'not-found' : 'pid-reused' }
}
function rewriteAuthority(path: string, mutate: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(path)
  try { mutate(db) } finally { db.close() }
}

describe('compare-bound runtime ownership', () => {
  it('reports a missing read-only authority without creating filesystem evidence', () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-ownership-read-only-missing-')))
    const databasePath = join(directory, 'runtime-owners.sqlite')
    try {
      expect(() => new RuntimeOwnershipStore(databasePath, { readOnly: true })).toThrowError(expect.objectContaining({ code: 'not-found' }))
      expect(existsSync(databasePath)).toBe(false)
      expect(readdirSync(directory)).toEqual([])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it.runIf(process.platform !== 'win32')('reads a valid authority from a 0500 directory without mutating it', () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-ownership-read-only-private-')))
    const databasePath = join(directory, 'runtime-owners.sqlite')
    const writer = new RuntimeOwnershipStore(databasePath)
    const preparing = writer.prepareClaim(candidate('12121212-1212-4212-8212-121212121212'), writer.observe('donwells-app'), null)
    writer.close()
    const snapshot = (): Array<[string, Buffer]> => readdirSync(directory).sort().map(name => [name, readFileSync(join(directory, name))])
    const before = snapshot()
    const beforeMtime = statSync(directory, { bigint: true }).mtimeNs
    chmodSync(directory, 0o500)
    try {
      const reader = new RuntimeOwnershipStore(databasePath, { readOnly: true })
      try { expect(reader.observe('donwells-app')).toMatchObject({ status: 'present', owner: preparing }) } finally { reader.close() }
      expect(snapshot()).toEqual(before)
      expect(statSync(directory, { bigint: true }).mtimeNs).toBe(beforeMtime)
    } finally {
      chmodSync(directory, 0o700)
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('creates a private authority database and advances vacant -> preparing -> active', () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-ownership-')))
    const store = new RuntimeOwnershipStore(join(directory, 'runtime-owners.sqlite'))
    try {
      const observed = store.observe('donwells-app')
      expect(observed).toEqual({ status: 'vacant', lastGeneration: 0 })
      const preparing = store.prepareClaim(candidate('11111111-1111-4111-8111-111111111111'), observed, null)
      expect(preparing).toMatchObject({ generation: 1, state: 'preparing' })
      expect(store.observe('donwells-app')).toMatchObject({ status: 'present', owner: preparing })
      const bound = store.recordBoundEndpoint(preparing, { platform: 'posix', device: '42', inode: '99' })
      expect(store.observe('donwells-app')).toMatchObject({ status: 'present', owner: { endpointFileIdentity: { platform: 'posix', device: '42', inode: '99' } } })
      const active = store.activate(bound, 'a'.repeat(64))
      expect(active).toMatchObject({ generation: 1, state: 'active', locatorSha256: 'a'.repeat(64), endpointFileIdentity: { platform: 'posix', device: '42', inode: '99' } })
      expect(store.resolveActive('donwells-app', {
        version: 2,
        ownerId: active.ownerId,
        ownerGeneration: active.generation,
        socketPath: active.endpoint,
        authToken: active.authToken,
        processIdentity: active.identity
      }, 'a'.repeat(64))).toEqual(active)
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('persists endpoint cleanup intent before filesystem displacement and completes it idempotently', () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-cleanup-journal-')))
    const databasePath = join(directory, 'runtime-owners.sqlite')
    let store = new RuntimeOwnershipStore(databasePath)
    try {
      const firstPrepared = store.prepareClaim(candidate('12121212-1212-4121-8121-121212121212', '/tmp/cleanup-predecessor.sock'), store.observe('donwells-app'), null)
      const firstBound = store.recordBoundEndpoint(firstPrepared, { platform: 'posix', device: '12', inode: '34' })
      const first = store.activate(firstBound, '1'.repeat(64))
      const secondPrepared = store.prepareClaim(candidate('34343434-3434-4343-8343-343434343434', '/tmp/cleanup-successor.sock', 2), store.observe('donwells-app'), stale())
      const second = store.activate(secondPrepared, '2'.repeat(64))
      if (first.endpointFileIdentity === null) throw new Error('bound predecessor identity missing')
      const cleanup = store.beginEndpointCleanup(second, { ownerId: first.ownerId, generation: first.generation, endpoint: first.endpoint, endpointFileIdentity: first.endpointFileIdentity })
      expect(cleanup).toMatchObject({ kind: 'donwells-app', successorOwnerId: second.ownerId, successorGeneration: 2, predecessorOwnerId: first.ownerId, predecessorGeneration: 1, endpoint: first.endpoint, expectedFileIdentity: first.endpointFileIdentity })
      expect(cleanup.quarantinePath).toBe(first.endpoint + '.cleanup-' + cleanup.id)
      store.close()
      store = new RuntimeOwnershipStore(databasePath)
      expect(store.listEndpointCleanups('donwells-app')).toEqual([cleanup])
      expect(store.completeEndpointCleanup(cleanup)).toBe(true)
      expect(store.completeEndpointCleanup(cleanup)).toBe(false)
      expect(store.listEndpointCleanups('donwells-app')).toEqual([])
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects a stale observation after another store claims, without applying X to Y', () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-ownership-race-')))
    const first = new RuntimeOwnershipStore(join(directory, 'runtime-owners.sqlite'))
    const second = new RuntimeOwnershipStore(join(directory, 'runtime-owners.sqlite'))
    try {
      const x = first.observe('donwells-app')
      const y = second.observe('donwells-app')
      first.prepareClaim(candidate('22222222-2222-4222-8222-222222222222'), x, null)
      expect(() => second.prepareClaim(candidate('33333333-3333-4333-8333-333333333333'), y, null)).toThrowError(expect.objectContaining({ code: 'OWNER_CHANGED' }))
      expect(first.observe('donwells-app')).toMatchObject({ status: 'present', owner: { ownerId: '22222222-2222-4222-8222-222222222222' } })
    } finally {
      first.close()
      second.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('increments exactly once and prevents an old release from deleting its successor', () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-ownership-successor-')))
    const store = new RuntimeOwnershipStore(join(directory, 'runtime-owners.sqlite'))
    let old: RuntimeOwner | undefined
    try {
      const preparing = store.prepareClaim(candidate('44444444-4444-4444-8444-444444444444'), store.observe('donwells-app'), null)
      old = store.activate(preparing, 'b'.repeat(64))
      const successor = store.prepareClaim(candidate('55555555-5555-4555-8555-555555555555', '/tmp/next.sock', 2), store.observe('donwells-app'), stale())
      expect(successor.generation).toBe(2)
      expect(store.release(old)).toBe(false)
      expect(store.observe('donwells-app')).toMatchObject({ status: 'present', owner: { ownerId: successor.ownerId, generation: 2 } })
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('never reuses a released generation and binds identity generation to its owner row', () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-ownership-generation-')))
    let store = new RuntimeOwnershipStore(join(directory, 'runtime-owners.sqlite'))
    try {
      const firstId = '88888888-8888-4888-8888-888888888888'
      const first = store.activate(store.prepareClaim(candidate(firstId), store.observe('donwells-app'), null), 'd'.repeat(64))
      expect(store.release(first)).toBe(true)
      store.close()
      store = new RuntimeOwnershipStore(join(directory, 'runtime-owners.sqlite'))
      const vacant = store.observe('donwells-app')
      expect(vacant).toEqual({ status: 'vacant', lastGeneration: 1 })
      const secondId = '99999999-9999-4999-8999-999999999999'
      expect(() => store.prepareClaim(candidate(secondId, '/tmp/second.sock', 1), vacant, null)).toThrowError(expect.objectContaining({ code: 'OWNER_MISMATCH' }))
      const second = store.prepareClaim(candidate(secondId, '/tmp/second.sock', 2), vacant, null)
      expect(second).toMatchObject({ generation: 2, identity: { generation: secondId + ':2' } })
      const terminalFirstId = '12121212-1212-4212-8212-121212121212'
      const terminalFirst = store.prepareClaim({ ...candidate(terminalFirstId, '/tmp/terminal-one.sock', 1), kind: 'terminal-daemon', identity: { ...identity, family: 'terminal-daemon', generation: terminalFirstId + ':1' } }, store.observe('terminal-daemon'), null)
      expect(store.release(terminalFirst)).toBe(true)
      expect(() => store.prepareClaim({ ...candidate(secondId, '/tmp/terminal-two.sock', 2), kind: 'terminal-daemon', identity: { ...identity, family: 'terminal-daemon', generation: secondId + ':2' } }, store.observe('terminal-daemon'), null)).toThrow(/UNIQUE/)
    } finally {
      try { store.close() } catch {}
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('fails closed when persisted authority rows contain unknown kinds or malformed fields', () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-ownership-corrupt-')))
    const databasePath = join(directory, 'runtime-owners.sqlite')
    const store = new RuntimeOwnershipStore(databasePath)
    const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    store.prepareClaim(candidate(ownerId), store.observe('donwells-app'), null)
    store.close()
    rewriteAuthority(databasePath, database => {
      database.prepare('UPDATE runtime_owners SET kind = ? WHERE owner_id = ?').run('unknown-runtime', ownerId)
    })
    expect(() => new RuntimeOwnershipStore(databasePath)).toThrowError(expect.objectContaining({ code: 'OWNER_CORRUPT' }))

    const secondPath = join(directory, 'malformed.sqlite')
    const second = new RuntimeOwnershipStore(secondPath)
    const secondId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    second.prepareClaim(candidate(secondId), second.observe('donwells-app'), null)
    second.close()
    rewriteAuthority(secondPath, malformed => {
      malformed.prepare('UPDATE runtime_owners SET auth_token = ? WHERE owner_id = ?').run('', secondId)
    })
    try {
      expect(() => new RuntimeOwnershipStore(secondPath)).toThrowError(expect.objectContaining({ code: 'OWNER_CORRUPT' }))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform !== 'win32')('rejects symlink authority files and noncanonical profile paths', () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-ownership-path-')))
    const target = join(directory, 'target.sqlite')
    const link = join(directory, 'linked.sqlite')
    writeFileSync(target, Buffer.alloc(0), { mode: 0o600 })
    symlinkSync(target, link)
    expect(() => new RuntimeOwnershipStore(link)).toThrowError(expect.objectContaining({ code: 'native-error' }))

    const profile = join(directory, 'profile')
    const profileAlias = join(directory, 'profile-alias')
    mkdirSync(profile, { mode: 0o700 })
    symlinkSync(profile, profileAlias)
    expect(() => new RuntimeOwnershipStore(join(profileAlias, 'runtime-owners.sqlite'))).toThrowError(expect.objectContaining({ code: 'access-denied' }))
    rmSync(directory, { recursive: true, force: true })
  })

  it.runIf(process.platform !== 'win32')('fails closed when the authority pathname changes after opening', () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-ownership-live-swap-')))
    const databasePath = join(directory, 'runtime-owners.sqlite')
    const displaced = join(directory, 'displaced.sqlite')
    const store = new RuntimeOwnershipStore(databasePath)
    try {
      renameSync(databasePath, displaced)
      writeFileSync(databasePath, Buffer.alloc(0), { mode: 0o600 })
      expect(() => store.observe('donwells-app')).toThrowError(expect.objectContaining({ code: 'DATABASE_CHANGED' }))
    } finally {
      try { store.close() } catch {}
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('rejects a portable Windows authority identity change between operations', () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-ownership-win-contract-')))
    let reads = 0
    const changingIdentity: RuntimeFileIdentityReader = () => ({
      platform: 'win32', volumeSerial: 'volume', fileId: reads++ < 5 ? 'first' : 'second'
    })
    const store = new RuntimeOwnershipStore(join(directory, 'runtime-owners.sqlite'), { identityReader: changingIdentity })
    try {
      expect(() => store.observe('donwells-app')).toThrowError(expect.objectContaining({ code: 'DATABASE_CHANGED' }))
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('refuses indeterminate prior identity and locator mismatches', () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-ownership-indeterminate-')))
    const store = new RuntimeOwnershipStore(join(directory, 'runtime-owners.sqlite'))
    try {
      const prepared = store.prepareClaim(candidate('66666666-6666-4666-8666-666666666666'), store.observe('donwells-app'), null)
      const active = store.activate(prepared, 'c'.repeat(64))
      expect(() => store.prepareClaim(candidate('77777777-7777-4777-8777-777777777777'), store.observe('donwells-app'), {
        status: 'indeterminate', reason: 'native-error', detail: 'access unavailable'
      })).toThrowError(expect.objectContaining({ code: 'OWNER_INDETERMINATE' }))
      expect(() => store.resolveActive('donwells-app', {
        version: 2, ownerId: active.ownerId, ownerGeneration: active.generation,
        socketPath: '/tmp/wrong.sock', authToken: active.authToken, processIdentity: active.identity
      }, 'c'.repeat(64))).toThrowError(expect.objectContaining({ code: 'OWNER_MISMATCH' }))
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('rejects endpoint reuse after a prior owner generation is released', () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-ownership-endpoint-history-')))
    const store = new RuntimeOwnershipStore(join(directory, 'runtime-owners.sqlite'))
    const endpoint = '/tmp/donwells-history.sock'
    try {
      const firstId = 'abababab-abab-4aba-8aba-abababababab'
      const first = store.activate(store.prepareClaim(candidate(firstId, endpoint), store.observe('donwells-app'), null), 'f'.repeat(64))
      expect(store.release(first)).toBe(true)
      const observed = store.observe('donwells-app')
      const secondId = 'cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd'
      expect(() => store.prepareClaim(candidate(secondId, endpoint, 2), observed, null)).toThrowError(expect.objectContaining({ code: 'ENDPOINT_REUSED' }))
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('recovers a committed mutation after a reader blocks its WAL checkpoint', () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-ownership-checkpoint-busy-')))
    const databasePath = join(directory, 'runtime-owners.sqlite')
    const nativeLock = runtimeAuthorityLock()
    let holdReader = false
    const reader: { database?: DatabaseSync } = {}
    const blockingLock: RuntimeAuthorityLock = (path, callback, options) => nativeLock(path, stablePath => {
      if (!holdReader) return callback(stablePath)
      holdReader = false
      reader.database = new DatabaseSync(stablePath, { readOnly: true })
      reader.database.exec('BEGIN')
      reader.database.prepare('SELECT COUNT(*) AS count FROM runtime_owners').get()
      return callback(stablePath)
    }, options)
    const store = new RuntimeOwnershipStore(databasePath, { authorityLock: blockingLock })
    try {
      const observed = store.observe('donwells-app')
      const ownerId = '34343434-3434-4434-8434-343434343434'
      holdReader = true
      expect(() => store.prepareClaim(candidate(ownerId), observed, null)).toThrowError(expect.objectContaining({ code: 'DATABASE_UNSAFE' }))
      reader.database?.exec('ROLLBACK')
      reader.database?.close()
      delete reader.database
      store.close()
      const recovered = new RuntimeOwnershipStore(databasePath)
      try {
        const committed = recovered.observe('donwells-app')
        expect(committed.status).toBe('present')
        if (committed.status !== 'present') throw new Error('committed preparing owner was not recovered')
        expect(committed.owner).toMatchObject({ ownerId, generation: 1, state: 'preparing' })
      } finally { recovered.close() }
      expect(readdirSync(directory).some(name => name.includes('.donwells-alias-'))).toBe(false)
    } finally {
      try { reader.database?.close() } catch {}
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it.runIf(process.platform !== 'win32')('rejects a cross-process A-to-B-to-A swap before writer commit', () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-ownership-cross-process-swap-')))
    const databasePath = join(directory, 'runtime-owners.sqlite')
    const displacedPath = join(directory, 'runtime-owners.sqlite.displaced')
    const readyPath = join(directory, 'swap.ready')
    const restorePath = join(directory, 'swap.restore')
    const donePath = join(directory, 'swap.done')
    const nativeLock = runtimeAuthorityLock()
    let attack = false
    const swapScript = [
      "const { existsSync, renameSync, rmSync, writeFileSync } = require('node:fs')",
      'const [database, displaced, ready, restore, done] = process.argv.slice(1)',
      'renameSync(database, displaced)',
      "writeFileSync(database, Buffer.from('replacement B'), { mode: 0o600 })",
      "writeFileSync(ready, 'ready')",
      'while (!existsSync(restore)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)',
      'rmSync(database, { force: true })',
      'renameSync(displaced, database)',
      "writeFileSync(done, 'done')"
    ].join(';')
    const authorityLock = <T>(path: string, callback: (stablePath: string) => T): T => nativeLock(path, stablePath => {
      if (!attack) return callback(stablePath)
      attack = false
      const child = spawn(process.execPath, ['-e', swapScript, path, displacedPath, readyPath, restorePath, donePath], { stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
      const wait = (predicate: () => boolean): void => {
        const deadline = Date.now() + 2_000
        while (!predicate()) {
          if (Date.now() > deadline) throw new Error('timed out waiting for adversarial swap child')
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
        }
      }
      try {
        wait(() => existsSync(readyPath))
        return callback(stablePath)
      } finally {
        writeFileSync(restorePath, 'restore')
        wait(() => existsSync(donePath))
        child.kill()
      }
    })
    const store = new RuntimeOwnershipStore(databasePath, { authorityLock })
    try {
      const observed = store.observe('donwells-app')
      attack = true
      expect(() => store.prepareClaim(candidate('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'), observed, null)).toThrowError(expect.objectContaining({ code: 'DATABASE_CHANGED' }))
    } finally {
      store.close()
      const recovered = new RuntimeOwnershipStore(databasePath, { readOnly: true })
      try { expect(recovered.observe('donwells-app')).toEqual({ status: 'vacant', lastGeneration: 0 }) } finally { recovered.close() }
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
  it('keeps the authority in WAL mode without a write-count lifetime cap', () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-ownership-sqlite-')))
    const databasePath = join(directory, 'runtime-owners.sqlite')
    try {
      for (let index = 0; index < 220; index += 1) {
        const store = new RuntimeOwnershipStore(databasePath)
        expect(store.observe('donwells-app')).toEqual({ status: 'vacant', lastGeneration: 0 })
        store.close()
      }
      expect(readFileSync(databasePath).subarray(0, 16).toString('utf8')).toBe('SQLite format 3\0')
      const database = new DatabaseSync(databasePath, { readOnly: true })
      try {
        expect(database.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
      } finally {
        database.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('recovers a committed crash-left WAL before accepting the next write', () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-ownership-wal-recovery-')))
    const databasePath = join(directory, 'runtime-owners.sqlite')
    const addonPath = join(import.meta.dirname, '../../resources/native/runtime-identity.node')
    const initial = new RuntimeOwnershipStore(databasePath)
    initial.close()
    try {
      const script = [
        "const { DatabaseSync } = require('node:sqlite')",
        "const addon = require(process.argv[1])",
        "addon.withRuntimeAuthorityLock(process.argv[2], stablePath => {",
        "const db = new DatabaseSync(stablePath)",
        "db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA synchronous=FULL; BEGIN IMMEDIATE')",
        "db.prepare('INSERT INTO runtime_owner_generations(kind,last_generation) VALUES(?,?)').run('donwells-app', 99)",
        "db.exec('COMMIT')",
        "process.exit(0)",
        "})"
      ].join(';')
      const interrupted = spawnSync(process.execPath, ['-e', script, addonPath, databasePath], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
      expect(interrupted.status).toBe(0)
      expect(readdirSync(directory).some(name => name.includes('.donwells-alias-') && name.endsWith('-wal'))).toBe(true)
      const store = new RuntimeOwnershipStore(databasePath)
      try {
        const observed = store.observe('donwells-app')
        expect(observed).toEqual({ status: 'vacant', lastGeneration: 99 })
        const ownerId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
        const preparing = store.prepareClaim(candidate(ownerId, '/tmp/donwells-owner.sock', 100), observed, null)
        expect(preparing.generation).toBe(100)
      } finally {
        store.close()
      }
      const migrated = new DatabaseSync(databasePath, { readOnly: true })
      try { expect(migrated.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' }) } finally { migrated.close() }
      expect(readdirSync(directory).some(name => name.includes('.donwells-alias-'))).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
