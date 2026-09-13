// @vitest-environment node
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RuntimeOwnershipStore } from '@shared/runtime-ownership'
import { localRuntimePaths, readRuntimeRecord, writeRuntimeRecord } from './local-runtime'
import { RuntimeRpcServer, type RpcDeps } from './runtime-rpc'

describe('runtime RPC publication lifecycle', () => {
  it('reports ready only after authenticated publication and releases its exact owner on stop', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-rpc-lifecycle-')))
    const paths = localRuntimePaths(directory, 'app')
    const server = new RuntimeRpcServer(paths.socketPath, paths.runtimeFile, 'rpc-test-token-123456', {} as RpcDeps)
    try {
      expect(server.isReady()).toBe(false)
      await server.start()
      expect(server.isReady()).toBe(true)
      const locator = readRuntimeRecord(paths.runtimeFile)
      expect(locator.status).toBe('current')
      if (locator.status !== 'current') throw new Error('runtime RPC did not publish a current locator')
      const store = new RuntimeOwnershipStore(paths.ownershipDatabasePath, { readOnly: true })
      try {
        expect(store.resolveActive('donwells-app', locator.record, locator.sha256).ownerId).toBe(locator.record.ownerId)
      } finally {
        store.close()
      }
      server.stop()
      expect(server.isReady()).toBe(false)
      const afterStop = new RuntimeOwnershipStore(paths.ownershipDatabasePath, { readOnly: true })
      try {
        expect(afterStop.observe('donwells-app')).toMatchObject({ status: 'vacant' })
      } finally {
        afterStop.close()
      }
    } finally {
      server.stop()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('cancels a pending startup when app shutdown races reconciliation', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-rpc-shutdown-race-')))
    const paths = localRuntimePaths(directory, 'app')
    writeRuntimeRecord(paths.runtimeFile, {
      version: 2,
      ownerId: '33333333-3333-4333-8333-333333333333',
      ownerGeneration: 1,
      socketPath: '/tmp/donwells-rpc-reconcile-missing.sock',
      authToken: 'stale-rpc-token-123456',
      processIdentity: {
        pid: 2_147_483_647,
        bootId: 'stale-boot',
        startedAt: 'stale-start',
        executablePath: process.execPath,
        family: 'donwells-app',
        capturedAt: '2026-09-13T00:00:00.000Z',
        generation: '33333333-3333-4333-8333-333333333333:1'
      }
    })
    const current = readRuntimeRecord(paths.runtimeFile)
    if (current.status !== 'current') throw new Error('runtime RPC race fixture was not current')
    const evidencePath = join(directory, 'orphan-v2.evidence')
    writeFileSync(evidencePath, readFileSync(paths.runtimeFile), { mode: 0o600 })
    const evidence = readRuntimeRecord(evidencePath)
    if (evidence.status !== 'current') throw new Error('runtime RPC race evidence was not current')
    const recoveryStore = new RuntimeOwnershipStore(paths.ownershipDatabasePath)
    recoveryStore.recordLegacyRecovery({
      kind: 'donwells-app', expectedFingerprint: current.sha256, fileIdentity: current.fileIdentity,
      evidencePath, evidenceFileIdentity: evidence.fileIdentity, endpoint: current.record.socketPath, recordType: 'orphan-v2'
    })
    recoveryStore.close()
    const server = new RuntimeRpcServer(paths.socketPath, paths.runtimeFile, 'rpc-race-token-123456', {} as RpcDeps)
    try {
      const starting = server.start()
      server.stop()
      await expect(starting).rejects.toThrow(/cancelled/)
      expect(server.isReady()).toBe(false)
    } finally {
      server.stop()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
