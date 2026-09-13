// @vitest-environment node
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
      await publishRuntimeOwner(publication, () => undefined)
      const locator = readRuntimeRecord(publication.paths.runtimeFile)
      expect(locator).toMatchObject({ status: 'current', record: { ownerId: publication.owner.ownerId, ownerGeneration: 1, socketPath: endpoint } })
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
      expect(releaseRuntimeOwner(publication)).toBe(false)
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
      expect(releaseRuntimeOwner(first)).toBe(false)
      expect(first.store.observe('donwells-app')).toMatchObject({ status: 'present', owner: { ownerId: second.owner.ownerId, generation: 2 } })
    } finally {
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
  it('allows a legacy locator only when its fresh bytes match committed recovery', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-reconcile-recovery-')))
    const paths = localRuntimePaths(directory, 'app')
    const legacy = { socketPath: '/tmp/legacy-reconcile.sock', authToken: 'legacy-reconcile-token' }
    writeFileSync(paths.runtimeFile, JSON.stringify(legacy), { mode: 0o600 })
    const observed = readRuntimeRecord(paths.runtimeFile)
    const store = new RuntimeOwnershipStore(join(directory, 'runtime-owners.sqlite'))
    try {
      if (observed.status !== 'legacy') throw new Error('legacy fixture was not readable')
      store.recordLegacyRecovery({ kind: 'donwells-app', expectedFingerprint: observed.sha256, fileIdentity: observed.fileIdentity, evidencePath: join(directory, 'legacy.evidence'), endpoint: observed.record.socketPath })
      const result = await reconcileRuntimeOwner({ userDataDir: directory, kind: 'donwells-app', authority, store, contact: async () => { throw new Error('recovery should not contact legacy endpoint') } })
      expect(result).toEqual({ action: 'claim' })
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
