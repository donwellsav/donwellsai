// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ProcessIdentity } from './child-process/process-spec'
import { RuntimeOwnershipStore, type RuntimeOwner, type RuntimeOwnerObservation } from './runtime-ownership'

const identity: ProcessIdentity = {
  pid: 100,
  bootId: 'boot-a',
  startedAt: 'birth-a',
  executablePath: '/opt/donwells',
  family: 'donwells-app',
  capturedAt: '2026-09-13T00:00:00.000Z'
}

function candidate(ownerId: string, endpoint = '/tmp/donwells-owner.sock'): Omit<RuntimeOwner, 'generation' | 'state' | 'locatorSha256'> {
  return {
    kind: 'donwells-app',
    ownerId,
    identity,
    endpoint,
    authToken: 'token-' + ownerId
  }
}

function stale(identityValue = identity): { status: 'stale'; reason: 'not-found' | 'pid-reused' | 'executable-mismatch' } {
  return { status: 'stale', reason: identityValue === identity ? 'not-found' : 'pid-reused' }
}

describe('compare-bound runtime ownership', () => {
  it('creates a private authority database and advances vacant -> preparing -> active', () => {
    const directory = mkdtempSync(join(tmpdir(), 'runtime-ownership-'))
    const store = new RuntimeOwnershipStore(join(directory, 'runtime-owners.sqlite'))
    try {
      const observed = store.observe('donwells-app')
      expect(observed).toEqual({ status: 'vacant' })
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
    const directory = mkdtempSync(join(tmpdir(), 'runtime-ownership-race-'))
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
    const directory = mkdtempSync(join(tmpdir(), 'runtime-ownership-successor-'))
    const store = new RuntimeOwnershipStore(join(directory, 'runtime-owners.sqlite'))
    let old: RuntimeOwner | undefined
    try {
      const preparing = store.prepareClaim(candidate('44444444-4444-4444-8444-444444444444'), store.observe('donwells-app'), null)
      old = store.activate(preparing, 'b'.repeat(64))
      const successor = store.prepareClaim(candidate('55555555-5555-4555-8555-555555555555', '/tmp/next.sock'), store.observe('donwells-app'), stale())
      expect(successor.generation).toBe(2)
      expect(store.release(old)).toBe(false)
      expect(store.observe('donwells-app')).toMatchObject({ status: 'present', owner: { ownerId: successor.ownerId, generation: 2 } })
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('refuses indeterminate prior identity and locator mismatches', () => {
    const directory = mkdtempSync(join(tmpdir(), 'runtime-ownership-indeterminate-'))
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
