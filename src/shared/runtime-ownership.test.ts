// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ProcessIdentity } from './child-process/process-spec'
import type { RuntimeFileIdentityReader } from './runtime-file-security'
import { RuntimeOwnershipStore, type RuntimeOwner, type RuntimeOwnerObservation } from './runtime-ownership'

const identity: ProcessIdentity = {
  pid: 100,
  bootId: 'boot-a',
  startedAt: 'birth-a',
  executablePath: '/opt/donwells',
  family: 'donwells-app',
  capturedAt: '2026-09-13T00:00:00.000Z'
}

function candidate(ownerId: string, endpoint = '/tmp/donwells-owner.sock', generation = 1): Omit<RuntimeOwner, 'generation' | 'state' | 'locatorSha256'> {
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
  it('creates a private authority database and advances vacant -> preparing -> active', () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-ownership-')))
    const store = new RuntimeOwnershipStore(join(directory, 'runtime-owners.sqlite'))
    try {
      const observed = store.observe('donwells-app')
      expect(observed).toEqual({ status: 'vacant', lastGeneration: 0 })
      const preparing = store.prepareClaim(candidate('11111111-1111-4111-8111-111111111111'), observed, null)
      expect(preparing).toMatchObject({ generation: 1, state: 'preparing' })
      expect(store.observe('donwells-app')).toMatchObject({ status: 'present', owner: preparing })
      const active = store.activate(preparing, 'a'.repeat(64))
      expect(active).toMatchObject({ generation: 1, state: 'active', locatorSha256: 'a'.repeat(64) })
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
      platform: 'win32', volumeSerial: 'volume', fileId: reads++ < 4 ? 'first' : 'second'
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
})
  it('keeps the authority as WAL SQLite without a write-count lifetime cap', () => {
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

  it('recovers an interrupted SQLite transaction and accepts the next write', () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-ownership-journal-')))
    const databasePath = join(directory, 'runtime-owners.sqlite')
    const initial = new RuntimeOwnershipStore(databasePath)
    initial.close()
    try {
      const script = [
        "const { DatabaseSync } = require('node:sqlite')",
        "const db = new DatabaseSync(process.argv[1])",
        "db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE')",
        "db.prepare('INSERT INTO runtime_owner_generations(kind,last_generation) VALUES(?,?)').run('donwells-app', 99)",
        "process.exit(0)"
      ].join(';')
      const interrupted = spawnSync(process.execPath, ['-e', script, databasePath], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
      expect(interrupted.status).toBe(0)
      const store = new RuntimeOwnershipStore(databasePath)
      try {
        const observed = store.observe('donwells-app')
        expect(observed).toEqual({ status: 'vacant', lastGeneration: 0 })
        const ownerId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
        const preparing = store.prepareClaim(candidate(ownerId), observed, null)
        expect(preparing.generation).toBe(1)
      } finally {
        store.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
