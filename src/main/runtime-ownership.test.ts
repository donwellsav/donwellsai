// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RuntimeIdentityAuthority } from '@shared/child-process/process-spec'
import { readRuntimeRecord } from './local-runtime'
import { claimRuntimeOwner, freshRuntimeEndpoint, publishRuntimeOwner, releaseRuntimeOwner } from './runtime-ownership'

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
    const directory = mkdtempSync(join(tmpdir(), 'runtime-publication-'))
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

  it('leaves successor ownership intact when the predecessor releases late', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'runtime-publication-successor-'))
    const first = claimRuntimeOwner({ userDataDir: directory, kind: 'donwells-app', endpoint: freshRuntimeEndpoint(join(directory, 'donwells-app-runtime.sock')), authToken: 'first-token-123456', captureIdentity: generation => authority.capture(process.pid, { family: 'donwells-app', executablePath: process.execPath, generation }), authority })
    await publishRuntimeOwner(first, () => undefined)
    const staleAuthority: RuntimeIdentityAuthority = { ...authority, verify: () => ({ status: 'stale', reason: 'not-found' }) }
    const second = claimRuntimeOwner({ userDataDir: directory, kind: 'donwells-app', endpoint: freshRuntimeEndpoint(join(directory, 'donwells-app-runtime.sock')), authToken: 'second-token-123456', captureIdentity: generation => authority.capture(process.pid, { family: 'donwells-app', executablePath: process.execPath, generation }), authority: staleAuthority, store: first.store })
    try {
      await expect(publishRuntimeOwner(second, () => undefined)).resolves.toMatchObject({ generation: 2, state: 'active' })
      expect(releaseRuntimeOwner(first)).toBe(false)
      expect(first.store.observe('donwells-app')).toMatchObject({ status: 'present', owner: { ownerId: second.owner.ownerId, generation: 2 } })
    } finally {
      first.store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
