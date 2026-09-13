// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection, type Socket } from 'node:net'
import { describe, expect, it } from 'vitest'
import { RuntimeOwnershipStore } from '@shared/runtime-ownership'
import { localRuntimePaths, readRuntimeRecord, writeRuntimeRecord } from './local-runtime'
import { RuntimeRpcServer, type RpcDeps } from './runtime-rpc'

function readFrame(socket: Socket): Promise<Record<string, unknown>> {
  const completion = Promise.withResolvers<Record<string, unknown>>()
  let buffer = ''
  const finish = (error?: Error): void => {
    socket.removeListener('data', onData)
    socket.removeListener('error', onError)
    if (error) completion.reject(error)
  }
  const onError = (error: Error): void => finish(error)
  const onData = (chunk: string | Buffer): void => {
    buffer += chunk.toString()
    const newline = buffer.indexOf('\n')
    if (newline < 0) return
    try {
      const frame = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      completion.resolve(frame)
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  }
  socket.on('data', onData)
  socket.once('error', onError)
  return completion.promise
}

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
  it('authenticates a real app runtime socket with the published identity', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-rpc-auth-')))
    const paths = localRuntimePaths(directory, 'app')
    const token = 'rpc-auth-token-123456'
    const server = new RuntimeRpcServer(paths.socketPath, paths.runtimeFile, token, {} as RpcDeps)
    let socket: Socket | undefined
    try {
      await server.start()
      const locator = readRuntimeRecord(paths.runtimeFile)
      if (locator.status !== 'current') throw new Error('runtime RPC did not publish an app locator')
      socket = createConnection(locator.record.socketPath)
      socket.setEncoding('utf8')
      const frame = readFrame(socket)
      await new Promise<void>((resolve, reject) => {
        socket!.once('connect', () => {
          socket!.write(JSON.stringify({ id: 'auth', method: 'auth.hello', authToken: token }) + '\n')
          resolve()
        })
        socket!.once('error', reject)
      })
      await expect(frame).resolves.toMatchObject({ id: 'auth', ok: true, runtimeIdentityContractVersion: 1, ownerId: locator.record.ownerId, generation: locator.record.ownerGeneration })
    } finally {
      socket?.destroy()
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
      const afterFailure = new RuntimeOwnershipStore(paths.ownershipDatabasePath, { readOnly: true })
      expect(afterFailure.observe('donwells-app')).toMatchObject({ status: 'vacant' })
      afterFailure.close()
    } finally {
      server.stop()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('retains its preparing identity when socket directory setup fails and retries the same instance', async () => {
    const directory = realpathSync.native(mkdtempSync('/tmp/runtime-rpc-setup-retry-'))
    const paths = localRuntimePaths(directory, 'app')
    const socketDirectory = join(directory, 'socket-parent')
    const socketPath = join(socketDirectory, 'runtime.sock')
    writeFileSync(socketDirectory, 'not a directory')
    const server = new RuntimeRpcServer(socketPath, paths.runtimeFile, 'rpc-setup-retry-token-123456', {} as RpcDeps)
    try {
      await expect(server.start()).rejects.toThrow()
      expect(server.isReady()).toBe(false)
      expect(readRuntimeRecord(paths.runtimeFile).status).toBe('missing')
      const afterFailure = new RuntimeOwnershipStore(paths.ownershipDatabasePath, { readOnly: true })
      let preparing
      try {
        const observed = afterFailure.observe('donwells-app')
        expect(observed).toMatchObject({ status: 'present', owner: { state: 'preparing' } })
        if (observed.status !== 'present') throw new Error('failed setup did not retain preparing ownership')
        preparing = observed.owner
      } finally {
        afterFailure.close()
      }
      rmSync(socketDirectory)
      mkdirSync(socketDirectory, { mode: 0o700 })
      await server.start()
      const locator = readRuntimeRecord(paths.runtimeFile)
      expect(locator.status).toBe('current')
      if (locator.status !== 'current') throw new Error('retried runtime RPC did not publish its locator')
      expect(locator.record).toMatchObject({ ownerId: preparing.ownerId, ownerGeneration: preparing.generation, socketPath: preparing.endpoint })
      expect(server.isReady()).toBe(true)
    } finally {
      server.stop()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('retains locator evidence after app shutdown', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-rpc-cleanup-retry-')))
    const paths = localRuntimePaths(directory, 'app')
    const server = new RuntimeRpcServer(paths.socketPath, paths.runtimeFile, 'rpc-cleanup-token-123456', {} as RpcDeps)
    try {
      await server.start()
      expect(server.stop()).toBe('released')
      expect(readRuntimeRecord(paths.runtimeFile).status).toBe('current')
      const store = new RuntimeOwnershipStore(paths.ownershipDatabasePath, { readOnly: true })
      try { expect(store.observe('donwells-app')).toMatchObject({ status: 'vacant' }) } finally { store.close() }
    } finally {
      server.stop()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it.runIf(process.platform !== 'win32')('stays ready when predecessor cleanup refuses a regular file', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'runtime-rpc-predecessor-cleanup-')))
    const paths = localRuntimePaths(directory, 'app')
    const predecessorEndpoint = join(directory, 'stale-predecessor')
    writeFileSync(predecessorEndpoint, 'replacement', { mode: 0o600 })
    const store = new RuntimeOwnershipStore(paths.ownershipDatabasePath)
    const ownerId = '44444444-4444-4444-8444-444444444444'
    const processIdentity = { pid: 2_147_483_647, bootId: 'stale-boot', startedAt: 'stale-start', executablePath: process.execPath, family: 'donwells-app' as const, capturedAt: '2026-09-13T00:00:00.000Z', generation: ownerId + ':1' }
    const prepared = store.prepareClaim({ kind: 'donwells-app', ownerId, identity: processIdentity, endpoint: predecessorEndpoint, authToken: 'stale-predecessor-token-123456' }, store.observe('donwells-app'), null)
    const predecessorLocator = { version: 2 as const, ownerId, ownerGeneration: prepared.generation, socketPath: predecessorEndpoint, authToken: prepared.authToken, processIdentity }
    writeRuntimeRecord(paths.runtimeFile, predecessorLocator)
    const written = readRuntimeRecord(paths.runtimeFile)
    if (written.status !== 'current') throw new Error('predecessor locator was not published')
    store.activate(prepared, written.sha256)
    store.close()

    const server = new RuntimeRpcServer(paths.socketPath, paths.runtimeFile, 'rpc-successor-token-123456', {} as RpcDeps)
    try {
      await server.start()
      expect(server.isReady()).toBe(true)
      expect(readFileSync(predecessorEndpoint, 'utf8')).toBe('replacement')
      const locator = readRuntimeRecord(paths.runtimeFile)
      if (locator.status !== 'current') throw new Error('successor locator was not published')
      const activeStore = new RuntimeOwnershipStore(paths.ownershipDatabasePath, { readOnly: true })
      try {
        expect(activeStore.resolveActive('donwells-app', locator.record, locator.sha256)).toMatchObject({ ownerId: locator.record.ownerId, state: 'active' })
      } finally {
        activeStore.close()
      }
    } finally {
      server.stop()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
