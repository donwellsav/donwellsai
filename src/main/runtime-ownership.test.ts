// @vitest-environment node
import { createServer } from 'node:net'
import { lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RuntimeIdentityAuthority } from '@shared/child-process/process-spec'
import { RuntimeOwnershipStore } from '@shared/runtime-ownership'
import { localRuntimePaths, readRuntimeRecord, writeRuntimeRecord, type LocalRuntimeRecord } from './local-runtime'
import { claimRuntimeOwner, freshRuntimeEndpoint, publishRuntimeOwner, reconcileRuntimeOwner, releaseRuntimeOwner, republishRuntimeOwner } from './runtime-ownership'

const identity = {
  pid: process.pid,
  bootId: 'boot-publication',
  startedAt: 'birth-publication',
  executablePath: process.execPath,
  family: 'donwells-app' as const,
  capturedAt: '2026-09-13T00:00:00.000Z'
}

const authority: RuntimeIdentityAuthority = {
  capture: (_pid, options) => ({ ...identity, generation: options.generation }),
  verify: value => value ? { status: 'valid', current: value } : { status: 'indeterminate', reason: 'legacy-record', detail: 'missing' }
}

describe('runtime publication state machine', () => {
  it('does not expose a preparing locator and activates only after endpoint bind and publish', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-publication-')))
    const endpoint = freshRuntimeEndpoint(join(directory, 'donwells-app-runtime.sock'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    const publication = claimRuntimeOwner({ userDataDir: directory, kind: 'donwells-app', endpoint, authToken: 'publication-token-123456', captureIdentity: generation => authority.capture(process.pid, { family: 'donwells-app', executablePath: process.execPath, generation }), authority })
    try {
      expect(readRuntimeRecord(publication.paths.runtimeFile, () => { throw Object.assign(new Error('missing'), { code: 'not-found' }) })).toEqual({ status: 'missing' })
      expect(publication.store.observe('donwells-app')).toMatchObject({ status: 'present', owner: { state: 'preparing' } })
      let bindCompleted = false
      await publishRuntimeOwner(publication, () => {
        expect(readRuntimeRecord(publication.paths.runtimeFile, () => { throw Object.assign(new Error('missing'), { code: 'not-found' }) })).toEqual({ status: 'missing' })
        bindCompleted = true
      })
      expect(bindCompleted).toBe(true)
      const locator = readRuntimeRecord(publication.paths.runtimeFile)
      expect(locator).toMatchObject({ status: 'current', record: { ownerId: publication.owner.ownerId, ownerGeneration: 1, socketPath: publication.owner.endpoint } })
      expect(publication.store.resolveActive('donwells-app', locator.status === 'current' ? locator.record : (() => { throw new Error('not current') })(), locator.status === 'current' ? locator.sha256 : '')).toEqual(publication.owner)
    } finally {
      publication.store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('preserves an interrupted preparing claim as recovery evidence', () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-publication-interrupted-')))
    const publication = claimRuntimeOwner({ userDataDir: directory, kind: 'donwells-app', endpoint: freshRuntimeEndpoint(join('/tmp', 'donwells-app-runtime.sock')), authToken: 'interrupted-token-123456', captureIdentity: generation => authority.capture(process.pid, { family: 'donwells-app', executablePath: process.execPath, generation }), authority })
    try {
      expect(publication.owner.state).toBe('preparing')
      expect(releaseRuntimeOwner(publication)).toBe('not-owned')
      expect(publication.store.observe('donwells-app')).toMatchObject({ status: 'present', owner: { ownerId: publication.owner.ownerId, state: 'preparing' } })
    } finally {
      publication.store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('leaves successor ownership intact when the predecessor releases late', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-publication-successor-')))
    const first = claimRuntimeOwner({ userDataDir: directory, kind: 'donwells-app', endpoint: freshRuntimeEndpoint(join('/tmp', 'donwells-app-runtime.sock')), authToken: 'first-token-123456', captureIdentity: generation => authority.capture(process.pid, { family: 'donwells-app', executablePath: process.execPath, generation }), authority })
    await publishRuntimeOwner(first, () => undefined)
    const staleAuthority: RuntimeIdentityAuthority = { ...authority, verify: () => ({ status: 'stale', reason: 'not-found' }) }
    const second = claimRuntimeOwner({ userDataDir: directory, kind: 'donwells-app', endpoint: freshRuntimeEndpoint(join('/tmp', 'donwells-app-runtime.sock')), authToken: 'second-token-123456', captureIdentity: generation => authority.capture(process.pid, { family: 'donwells-app', executablePath: process.execPath, generation }), authority: staleAuthority, store: first.store })
    try {
      await expect(publishRuntimeOwner(second, () => undefined)).resolves.toMatchObject({ generation: 2, state: 'active' })
      expect(releaseRuntimeOwner(first)).toBe('not-owned')
      expect(first.store.observe('donwells-app')).toMatchObject({ status: 'present', owner: { ownerId: second.owner.ownerId, generation: 2 } })
    } finally {
      first.store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('removes the displaced endpoint only after successor activation', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-publication-cleanup-')))
    const firstEndpoint = freshRuntimeEndpoint(join('/tmp', 'donwells-first.sock'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    const secondEndpoint = freshRuntimeEndpoint(join('/tmp', 'donwells-second.sock'), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    const first = claimRuntimeOwner({ userDataDir: directory, kind: 'donwells-app', endpoint: firstEndpoint, authToken: 'first-cleanup-token-123456', captureIdentity: generation => authority.capture(process.pid, { family: 'donwells-app', executablePath: process.execPath, generation }), authority })
    const endpointServer = createServer(() => {})
    await new Promise<void>((resolve, reject) => { endpointServer.once('error', reject); endpointServer.listen(first.owner.endpoint, resolve) })
    const staleAuthority: RuntimeIdentityAuthority = { ...authority, verify: () => ({ status: 'stale', reason: 'not-found' }) }
    try {
      await publishRuntimeOwner(first, () => undefined)
      const second = claimRuntimeOwner({ userDataDir: directory, kind: 'donwells-app', endpoint: secondEndpoint, authToken: 'second-cleanup-token-123456', captureIdentity: generation => authority.capture(process.pid, { family: 'donwells-app', executablePath: process.execPath, generation }), authority: staleAuthority, store: first.store })
      await publishRuntimeOwner(second, () => undefined)
      expect(() => lstatSync(first.owner.endpoint)).toThrow()
      expect(first.store.observe('donwells-app')).toMatchObject({ status: 'present', owner: { ownerId: second.owner.ownerId, generation: 2, state: 'active' } })
    } finally {
      await new Promise<void>(resolve => endpointServer.close(() => resolve()))
      first.store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not remove a predecessor endpoint that was replaced before activation', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-publication-cleanup-replaced-')))
    const firstEndpoint = freshRuntimeEndpoint(join('/tmp', 'donwells-replaced-first.sock'), 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')
    const secondEndpoint = freshRuntimeEndpoint(join('/tmp', 'donwells-replaced-second.sock'), 'dddddddd-dddd-4ddd-8ddd-dddddddddddd')
    const first = claimRuntimeOwner({ userDataDir: directory, kind: 'donwells-app', endpoint: firstEndpoint, authToken: 'first-replaced-token-123456', captureIdentity: generation => authority.capture(process.pid, { family: 'donwells-app', executablePath: process.execPath, generation }), authority })
    const originalServer = createServer(() => {})
    const replacementServer = createServer(() => {})
    await new Promise<void>((resolve, reject) => { originalServer.once('error', reject); originalServer.listen(first.owner.endpoint, resolve) })
    const staleAuthority: RuntimeIdentityAuthority = { ...authority, verify: () => ({ status: 'stale', reason: 'not-found' }) }
    let second: ReturnType<typeof claimRuntimeOwner> | undefined
    try {
      await publishRuntimeOwner(first, () => undefined)
      second = claimRuntimeOwner({ userDataDir: directory, kind: 'donwells-app', endpoint: secondEndpoint, authToken: 'second-replaced-token-123456', captureIdentity: generation => authority.capture(process.pid, { family: 'donwells-app', executablePath: process.execPath, generation }), authority: staleAuthority, store: first.store })
      const originalIdentity = lstatSync(first.owner.endpoint)
      await new Promise<void>(resolve => originalServer.close(() => resolve()))
      await new Promise<void>((resolve, reject) => { replacementServer.once('error', reject); replacementServer.listen(first.owner.endpoint, resolve) })
      const replacementIdentity = lstatSync(first.owner.endpoint)
      expect({ device: String(replacementIdentity.dev), inode: String(replacementIdentity.ino) }).not.toEqual({ device: String(originalIdentity.dev), inode: String(originalIdentity.ino) })
      await publishRuntimeOwner(second, () => undefined)
      expect(lstatSync(first.owner.endpoint).isSocket()).toBe(true)
    } finally {
      await new Promise<void>(resolve => originalServer.close(() => resolve()))
      await new Promise<void>(resolve => replacementServer.close(() => resolve()))
      first.store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('cleans a stale preparing predecessor only after successor activation', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-publication-cleanup-preparing-')))
    const firstEndpoint = freshRuntimeEndpoint(join('/tmp', 'donwells-preparing-first.sock'), 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')
    const secondEndpoint = freshRuntimeEndpoint(join('/tmp', 'donwells-preparing-second.sock'), 'ffffffff-ffff-4fff-8fff-ffffffffffff')
    const staleAuthority: RuntimeIdentityAuthority = { ...authority, verify: () => ({ status: 'stale', reason: 'not-found' }) }
    const first = claimRuntimeOwner({ userDataDir: directory, kind: 'donwells-app', endpoint: firstEndpoint, authToken: 'first-preparing-token-123456', captureIdentity: generation => authority.capture(process.pid, { family: 'donwells-app', executablePath: process.execPath, generation }), authority: staleAuthority })
    const endpointServer = createServer(() => {})
    await new Promise<void>((resolve, reject) => { endpointServer.once('error', reject); endpointServer.listen(first.owner.endpoint, resolve) })
    try {
      const second = claimRuntimeOwner({ userDataDir: directory, kind: 'donwells-app', endpoint: secondEndpoint, authToken: 'second-preparing-token-123456', captureIdentity: generation => authority.capture(process.pid, { family: 'donwells-app', executablePath: process.execPath, generation }), authority: staleAuthority, store: first.store })
      await publishRuntimeOwner(second, () => undefined)
      expect(() => lstatSync(first.owner.endpoint)).toThrow()
      expect(first.store.observe('donwells-app')).toMatchObject({ status: 'present', owner: { ownerId: second.owner.ownerId, generation: 2, state: 'active' } })
    } finally {
      await new Promise<void>(resolve => endpointServer.close(() => resolve()))
      first.store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('returns claim for a stale preparing crash and keeps generation compare-bound', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-reconcile-preparing-')))
    const staleAuthority: RuntimeIdentityAuthority = { ...authority, verify: () => ({ status: 'stale', reason: 'not-found' }) }
    const first = claimRuntimeOwner({ userDataDir: directory, kind: 'donwells-app', endpoint: freshRuntimeEndpoint(join('/tmp', 'donwells-first.sock')), authToken: 'first-reconcile-token', captureIdentity: generation => authority.capture(process.pid, { family: 'donwells-app', executablePath: process.execPath, generation }), authority: staleAuthority })
    try {
      await expect(reconcileRuntimeOwner({
        userDataDir: directory,
        kind: 'donwells-app',
        authority: staleAuthority,
        store: first.store,
        contact: async () => ({ status: 'unreachable', detail: 'crashed before bind' })
      })).resolves.toEqual({ action: 'claim' })
      const successor = claimRuntimeOwner({ userDataDir: directory, kind: 'donwells-app', endpoint: freshRuntimeEndpoint(join('/tmp', 'donwells-second.sock')), authToken: 'second-reconcile-token', captureIdentity: generation => authority.capture(process.pid, { family: 'donwells-app', executablePath: process.execPath, generation }), authority: staleAuthority, store: first.store })
      expect(successor.owner.generation).toBe(2)
      expect(first.store.observe('donwells-app')).toMatchObject({ status: 'present', owner: { ownerId: successor.owner.ownerId, state: 'preparing' } })
    } finally {
      first.store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('lets only the exact in-memory candidate finish its preparing publication', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-reconcile-finish-')))
    const first = claimRuntimeOwner({ userDataDir: directory, kind: 'donwells-app', endpoint: freshRuntimeEndpoint(join('/tmp', 'donwells-first.sock')), authToken: 'finish-reconcile-token', captureIdentity: generation => authority.capture(process.pid, { family: 'donwells-app', executablePath: process.execPath, generation }), authority })
    try {
      const result = await reconcileRuntimeOwner({ userDataDir: directory, kind: 'donwells-app', authority, store: first.store, candidate: first, contact: async () => { throw new Error('owned preparing candidate must not contact itself') } })
      expect(result).toEqual({ action: 'finish-preparing', publication: first })
      if (result.action !== 'finish-preparing') throw new Error('expected owned preparing action')
      expect(first.store.observe('donwells-app')).toMatchObject({ status: 'present', owner: { state: 'preparing' } })
      await publishRuntimeOwner(result.publication, () => undefined)
      expect(first.store.observe('donwells-app')).toMatchObject({ status: 'present', owner: { state: 'active', ownerId: first.owner.ownerId } })
    } finally {
      first.store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('never finishes another process preparing row from authenticated contact alone', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-reconcile-foreign-')))
    const first = claimRuntimeOwner({ userDataDir: directory, kind: 'donwells-app', endpoint: freshRuntimeEndpoint(join('/tmp', 'donwells-first.sock')), authToken: 'foreign-reconcile-token', captureIdentity: generation => authority.capture(process.pid, { family: 'donwells-app', executablePath: process.execPath, generation }), authority })
    try {
      await expect(reconcileRuntimeOwner({ userDataDir: directory, kind: 'donwells-app', authority, store: first.store, contact: async record => 'version' in record ? { status: 'exact', ownerId: record.ownerId, generation: record.ownerGeneration, processIdentity: record.processIdentity } : { status: 'legacy' } })).rejects.toMatchObject({ code: 'OWNER_LIVE' })
      expect(first.store.observe('donwells-app')).toMatchObject({ status: 'present', owner: { state: 'preparing' } })
    } finally {
      first.store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('lets only the exact in-memory active candidate republish its locator', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-reconcile-republish-')))
    const first = claimRuntimeOwner({ userDataDir: directory, kind: 'donwells-app', endpoint: freshRuntimeEndpoint(join('/tmp', 'donwells-first.sock')), authToken: 'republish-reconcile-token', captureIdentity: generation => authority.capture(process.pid, { family: 'donwells-app', executablePath: process.execPath, generation }), authority })
    await publishRuntimeOwner(first, () => undefined)
    const wrong: LocalRuntimeRecord = { ...first.locator, authToken: 'wrong-reconcile-token' }
    writeRuntimeRecord(first.paths.runtimeFile, wrong)
    try {
      const before = first.store.observe('donwells-app')
      const result = await reconcileRuntimeOwner({ userDataDir: directory, kind: 'donwells-app', authority, store: first.store, candidate: first, contact: async () => { throw new Error('owned active candidate must not contact itself') } })
      expect(result).toEqual({ action: 'republish-active', publication: first })
      if (result.action !== 'republish-active') throw new Error('expected owned active action')
      expect(first.store.observe('donwells-app')).toEqual(before)
      republishRuntimeOwner(result.publication, first.owner.locatorSha256)
      expect(readRuntimeRecord(first.paths.runtimeFile)).toMatchObject({ status: 'current', record: first.locator })
    } finally {
      first.store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('fails closed when an active identity is valid but authenticated contact is not exact', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-reconcile-fail-closed-')))
    const first = claimRuntimeOwner({ userDataDir: directory, kind: 'donwells-app', endpoint: freshRuntimeEndpoint(join('/tmp', 'donwells-first.sock')), authToken: 'fail-closed-token', captureIdentity: generation => authority.capture(process.pid, { family: 'donwells-app', executablePath: process.execPath, generation }), authority })
    await publishRuntimeOwner(first, () => undefined)
    try {
      await expect(reconcileRuntimeOwner({ userDataDir: directory, kind: 'donwells-app', authority, store: first.store, contact: async () => ({ status: 'unreachable', detail: 'no response' }) })).rejects.toMatchObject({ code: 'OWNER_LIVE' })
      const indeterminate: RuntimeIdentityAuthority = { ...authority, verify: () => ({ status: 'indeterminate', reason: 'access-denied', detail: 'probe denied' }) }
      await expect(reconcileRuntimeOwner({ userDataDir: directory, kind: 'donwells-app', authority: indeterminate, store: first.store, contact: async () => ({ status: 'unreachable', detail: 'no response' }) })).rejects.toMatchObject({ code: 'OWNER_INDETERMINATE' })
    } finally {
      first.store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('takes over when both a mismatched v2 locator and its recorded owner are proven stale', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-reconcile-stale-mismatch-')))
    const first = claimRuntimeOwner({ userDataDir: directory, kind: 'donwells-app', endpoint: freshRuntimeEndpoint(join('/tmp', 'donwells-owner.sock')), authToken: 'owner-stale-token', captureIdentity: generation => authority.capture(process.pid, { family: 'donwells-app', executablePath: process.execPath, generation }), authority })
    await publishRuntimeOwner(first, () => undefined)
    const mismatched: LocalRuntimeRecord = { ...first.locator, socketPath: freshRuntimeEndpoint(join('/tmp', 'donwells-stale.sock')), authToken: 'stale-locator-token' }
    writeRuntimeRecord(first.paths.runtimeFile, mismatched)
    const orphan = readRuntimeRecord(first.paths.runtimeFile)
    if (orphan.status !== 'current') throw new Error('orphan fixture was not readable')
    const evidencePath = join(directory, 'orphan-v2.evidence')
    writeFileSync(evidencePath, JSON.stringify(mismatched), { mode: 0o600 })
    const evidence = readRuntimeRecord(evidencePath)
    if (evidence.status !== 'current') throw new Error('orphan evidence was not readable')
    first.store.recordLegacyRecovery({ kind: 'donwells-app', expectedFingerprint: orphan.sha256, fileIdentity: orphan.fileIdentity, evidencePath, evidenceFileIdentity: evidence.fileIdentity, endpoint: orphan.record.socketPath, recordType: 'orphan-v2' })
    const staleAuthority: RuntimeIdentityAuthority = { ...authority, verify: () => ({ status: 'stale', reason: 'not-found' }) }
    try {
      await expect(reconcileRuntimeOwner({
        userDataDir: directory,
        kind: 'donwells-app',
        authority: staleAuthority,
        store: first.store,
        contact: async () => ({ status: 'unreachable', detail: 'proven unreachable' })
      })).resolves.toEqual({ action: 'claim' })
    } finally {
      first.store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('preserves a reachable authenticated legacy runtime without committed recovery', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-reconcile-live-legacy-')) )
    const paths = localRuntimePaths(directory, 'app')
    const legacy = { socketPath: join(directory, 'legacy.sock'), authToken: 'legacy-live-token-123456' }
    writeFileSync(paths.runtimeFile, JSON.stringify(legacy), { mode: 0o600 })
    const store = new RuntimeOwnershipStore(paths.ownershipDatabasePath)
    try {
      await expect(reconcileRuntimeOwner({
        userDataDir: directory,
        kind: 'donwells-app',
        authority,
        store,
        contact: async record => record.socketPath === legacy.socketPath ? { status: 'legacy' } : { status: 'mismatch', detail: 'wrong locator' }
      })).resolves.toEqual({ action: 'reconnect-legacy', record: legacy })
      expect(store.observe('donwells-app')).toEqual({ status: 'vacant', lastGeneration: 0 })
      expect(readRuntimeRecord(paths.runtimeFile)).toMatchObject({ status: 'legacy', record: legacy })
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('allows a legacy locator only when its fresh bytes match committed recovery', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-reconcile-recovery-')))
    const paths = localRuntimePaths(directory, 'app')
    const legacy = { socketPath: '/tmp/legacy-reconcile.sock', authToken: 'legacy-reconcile-token' }
    writeFileSync(paths.runtimeFile, JSON.stringify(legacy), { mode: 0o600 })
    const observed = readRuntimeRecord(paths.runtimeFile)
    const store = new RuntimeOwnershipStore(join(directory, 'runtime-owners.sqlite'))
    try {
      if (observed.status !== 'legacy') throw new Error('legacy fixture was not readable')
      const evidencePath = join(directory, 'legacy.evidence')
      writeFileSync(evidencePath, JSON.stringify(legacy), { mode: 0o600 })
      const evidence = readRuntimeRecord(evidencePath)
      if (evidence.status !== 'legacy') throw new Error('legacy evidence was not readable')
      store.recordLegacyRecovery({ kind: 'donwells-app', expectedFingerprint: observed.sha256, fileIdentity: observed.fileIdentity, evidencePath, evidenceFileIdentity: evidence.fileIdentity, endpoint: observed.record.socketPath, recordType: 'legacy' })
      const result = await reconcileRuntimeOwner({ userDataDir: directory, kind: 'donwells-app', authority, store, contact: async () => { throw new Error('recovery should not contact legacy endpoint') } })
      expect(result).toEqual({ action: 'claim' })
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('rejects endpoint reuse after a prior generation releases', () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-endpoint-history-')))
    const store = new RuntimeOwnershipStore(join(directory, 'runtime-owners.sqlite'))
    const endpoint = join(directory, 'same.sock')
    const firstId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const secondId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const candidate = (ownerId: string, generation: number) => ({
      kind: 'donwells-app' as const,
      ownerId,
      identity: { ...identity, generation: ownerId + ':' + generation },
      endpoint,
      authToken: ownerId + '-token'
    })
    try {
      const first = store.prepareClaim(candidate(firstId, 1), store.observe('donwells-app'), null)
      expect(store.abandonPreparing(first)).toBe(true)
      const observed = store.observe('donwells-app')
      expect(observed).toMatchObject({ status: 'vacant', lastGeneration: 1 })
      expect(() => store.prepareClaim(candidate(secondId, 2), observed, null)).toThrowError(expect.objectContaining({ code: 'ENDPOINT_REUSED' }))
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
