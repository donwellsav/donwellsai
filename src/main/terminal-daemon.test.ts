// @vitest-environment node
import { chmodSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RuntimeOwnershipStore, type RuntimeOwner } from '@shared/runtime-ownership'
import { DaemonClient, terminateSpawnedChild } from './daemon-client'
import { localRuntimePaths, readRuntimeRecord, writeRuntimeRecord } from './local-runtime'
import { claimRuntimeOwner, freshRuntimeEndpoint, publishRuntimeOwner } from './runtime-ownership'
import { TerminalDaemon } from './terminal-daemon'

type DaemonLifecycleProbe = { activePublication: () => { owner: RuntimeOwner; store: { release: (owner: RuntimeOwner) => boolean } } | null }
type DaemonConnectProbe = { tryConnect: (socketPath: string, authToken: string, expected: { ownerId: string; ownerGeneration: number; socketPath: string; authToken: string; processIdentity: unknown }) => Promise<boolean> }

const events = {
  data: () => {},
  exit: () => {},
  title: () => {},
  agent: () => {},
  agentDismissed: () => {}
}
function readHello(socketPath: string, authToken: string): Promise<Record<string, unknown>> {
  const completion = Promise.withResolvers<Record<string, unknown>>()
  const socket = createConnection(socketPath)
  let buffer = ''
  const finish = (error?: Error, message?: Record<string, unknown>): void => {
    socket.removeAllListeners()
    socket.destroy()
    if (error) completion.reject(error)
    else if (message) completion.resolve(message)
  }
  socket.once('error', error => finish(error))
  socket.on('data', chunk => {
    buffer += chunk.toString('utf8')
    const newline = buffer.indexOf('\n')
    if (newline < 0) return
    try {
      const message = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>
      finish(undefined, message)
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
  socket.once('connect', () => socket.write(JSON.stringify({ id: 'hello', op: 'hello', authToken }) + '\n'))
  return completion.promise
}

function expectHelloClosed(socketPath: string, authToken: string): Promise<void> {
  const completion = Promise.withResolvers<void>()
  const socket = createConnection(socketPath)
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const finish = (error?: Error): void => {
    if (settled) return
    settled = true
    if (timer) clearTimeout(timer)
    socket.removeAllListeners()
    socket.destroy()
    if (error) completion.reject(error)
    else completion.resolve()
  }
  socket.once('connect', () => socket.write(JSON.stringify({ id: 'hello', op: 'hello', authToken }) + '\n'))
  socket.once('error', () => finish())
  socket.once('close', () => finish())
  timer = setTimeout(() => finish(new Error('inactive owner accepted hello')), 1_000)
  return completion.promise
}


describe('terminal runtime identity lifecycle', () => {
  it('does not resolve a preparing owner and publishes exact identity in hello', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'terminal-identity-')))
    const daemon = new TerminalDaemon({ userDataDir: directory, authToken: 'terminal-test-token-123456789' })
    try {
      const privateDaemon = daemon as unknown as DaemonLifecycleProbe
      expect(privateDaemon.activePublication()).toBeNull()
      await daemon.start()
      expect(privateDaemon.activePublication()).not.toBeNull()
      const locator = readRuntimeRecord(localRuntimePaths(directory, 'terminal').runtimeFile)
      expect(locator.status).toBe('current')
      if (locator.status !== 'current') throw new Error('terminal locator was not published')
      const hello = await readHello(locator.record.socketPath, locator.record.authToken)
      expect(hello).toMatchObject({
        id: 'hello',
        ok: true,
        protocolVersion: 3,
        runtimeIdentityContractVersion: 1,
        ownerId: locator.record.ownerId,
        generation: locator.record.ownerGeneration,
        processIdentity: locator.record.processIdentity
      })
      expect(hello.capabilities).toContain('runtime-identity-v1')
    } finally {
      await daemon.stopIfIdle()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('accepts a live owner before offline identity verification and rejects mismatched hello identity', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'terminal-client-identity-')))
    const daemon = new TerminalDaemon({ userDataDir: directory, authToken: 'terminal-client-token-123456789' })
    const client = new DaemonClient(directory, events, process.execPath)
    try {
      await daemon.start()
      await client.connect()
      client.disconnect()
      const locator = readRuntimeRecord(localRuntimePaths(directory, 'terminal').runtimeFile)
      expect(locator.status).toBe('current')
      if (locator.status !== 'current') throw new Error('terminal locator was not published')
      const connectProbe = client as unknown as DaemonConnectProbe
      const tryConnect = connectProbe.tryConnect
      await expect(tryConnect.call(client, locator.record.socketPath, locator.record.authToken, locator.record)).resolves.toBe(true)
      client.disconnect()
      const mismatch = { ...locator.record, ownerId: '11111111-1111-4111-8111-111111111111' }
      await expect(tryConnect.call(client, locator.record.socketPath, locator.record.authToken, mismatch)).resolves.toBe(false)
    } finally {
      client.disconnect()
      await daemon.stopIfIdle()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('rejects authenticated hello when the ownership row is no longer active', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'terminal-inactive-owner-')))
    const daemon = new TerminalDaemon({ userDataDir: directory, authToken: 'terminal-inactive-token-123456789' })
    try {
      await daemon.start()
      const privateDaemon = daemon as unknown as DaemonLifecycleProbe
      const publication = privateDaemon.activePublication()
      expect(publication).not.toBeNull()
      if (!publication) throw new Error('terminal owner was not active after start')
      expect(publication.store.release(publication.owner)).toBe(true)
      expect(privateDaemon.activePublication()).toBeNull()
      const locator = readRuntimeRecord(localRuntimePaths(directory, 'terminal').runtimeFile)
      expect(locator.status).toBe('current')
      if (locator.status !== 'current') throw new Error('terminal locator was not published')
      await expectHelloClosed(locator.record.socketPath, locator.record.authToken)
    } finally {
      await daemon.stopIfIdle()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform !== 'win32')('does not unlink an endpoint pathname replaced after bind', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'terminal-endpoint-replacement-')))
    const daemon = new TerminalDaemon({ userDataDir: directory, authToken: 'terminal-endpoint-token-123456789' })
    try {
      await daemon.start()
      const record = readRuntimeRecord(localRuntimePaths(directory, 'terminal').runtimeFile)
      if (record.status !== 'current') throw new Error('daemon did not publish its endpoint')
      const displaced = record.record.socketPath + '.displaced'
      const preserved = record.record.socketPath + '.preserved'
      renameSync(record.record.socketPath, displaced)
      writeFileSync(record.record.socketPath, 'replacement', { mode: 0o600 })
      await expect(daemon.stopIfIdle()).rejects.toThrow(/endpoint path changed/)
      expect(readFileSync(record.record.socketPath, 'utf8')).toBe('replacement')
      renameSync(record.record.socketPath, preserved)
      renameSync(displaced, record.record.socketPath)
      await expect(daemon.stopIfIdle()).resolves.toBe(true)
      expect(readFileSync(preserved, 'utf8')).toBe('replacement')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('verifies termination of a real detached child', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { detached: true, stdio: 'ignore' })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    expect(await terminateSpawnedChild(child)).toBe(true)
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  })
  it('reports an unverifiable cleanup result instead of treating a close event as termination', async () => {
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { pid: 1, exitCode: null, signalCode: null })
    const cleanup = terminateSpawnedChild(child)
    setImmediate(() => child.emit('close'))
    await expect(cleanup).resolves.toBe(false)
  })
  it('cancels a pending startup when shutdown races reconciliation', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'terminal-shutdown-race-')))
    const daemon = new TerminalDaemon({ userDataDir: directory, authToken: 'terminal-race-token-123456789' })
    const paths = localRuntimePaths(directory, 'terminal')
    writeRuntimeRecord(paths.runtimeFile, {
      version: 2,
      ownerId: '44444444-4444-4444-8444-444444444444',
      ownerGeneration: 1,
      socketPath: '/tmp/donwells-terminal-reconcile-missing.sock',
      authToken: 'stale-terminal-token-123456',
      processIdentity: {
        pid: 2_147_483_647,
        bootId: 'stale-boot',
        startedAt: 'stale-start',
        executablePath: process.execPath,
        family: 'terminal-daemon',
        capturedAt: '2026-09-13T00:00:00.000Z',
        generation: '44444444-4444-4444-8444-444444444444:1'
      }
    })
    const current = readRuntimeRecord(paths.runtimeFile)
    if (current.status !== 'current') throw new Error('terminal shutdown race fixture was not current')
    const evidencePath = join(directory, 'orphan-v2.evidence')
    writeFileSync(evidencePath, readFileSync(paths.runtimeFile), { mode: 0o600 })
    const evidence = readRuntimeRecord(evidencePath)
    if (evidence.status !== 'current') throw new Error('terminal shutdown race evidence was not current')
    const recoveryStore = new RuntimeOwnershipStore(paths.ownershipDatabasePath)
    recoveryStore.recordLegacyRecovery({
      kind: 'terminal-daemon', expectedFingerprint: current.sha256, fileIdentity: current.fileIdentity,
      evidencePath, evidenceFileIdentity: evidence.fileIdentity, endpoint: current.record.socketPath, recordType: 'orphan-v2'
    })
    recoveryStore.close()
    try {
      const starting = daemon.start()
      await daemon.stopIfIdle()
      await expect(starting).rejects.toThrow(/cancelled/)
      expect(daemon.isReady()).toBe(false)
    } finally {
      await daemon.stopIfIdle()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('hands a stale locator mismatch to the spawned daemon for reconciliation', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'terminal-client-recovery-')))
    const ownerId = '22222222-2222-4222-8222-222222222222'
    const authority = {
      capture: (_pid: number, options: { generation?: string }) => ({
        pid: 2_147_483_647,
        bootId: 'stale-boot',
        startedAt: 'stale-start',
        executablePath: process.execPath,
        family: 'terminal-daemon' as const,
        capturedAt: '2026-09-13T00:00:00.000Z',
        generation: options.generation
      }),
      verify: () => ({ status: 'stale' as const, reason: 'not-found' as const })
    }
    const publication = claimRuntimeOwner({
      userDataDir: directory,
      kind: 'terminal-daemon',
      endpoint: freshRuntimeEndpoint('/tmp/donwells-client-recovery.sock', ownerId),
      authToken: 'stale-owner-token-123456',
      captureIdentity: generation => authority.capture(process.pid, { generation }),
      authority
    })
    const entry = join(directory, 'exit-daemon.js')
    writeFileSync(entry, 'process.exit(0)\n', { mode: 0o700 })
    await publishRuntimeOwner(publication, () => undefined)
    writeRuntimeRecord(publication.paths.runtimeFile, { ...publication.locator, authToken: 'stale-locator-token-123456' })
    const mismatched = readRuntimeRecord(publication.paths.runtimeFile)
    if (mismatched.status !== 'current') throw new Error('stale locator fixture was not current')
    const evidencePath = join(directory, 'orphan-v2.evidence')
    writeFileSync(evidencePath, readFileSync(publication.paths.runtimeFile), { mode: 0o600 })
    const evidence = readRuntimeRecord(evidencePath)
    if (evidence.status !== 'current') throw new Error('stale locator evidence was not current')
    publication.store.recordLegacyRecovery({
      kind: 'terminal-daemon', expectedFingerprint: mismatched.sha256, fileIdentity: mismatched.fileIdentity,
      evidencePath, evidenceFileIdentity: evidence.fileIdentity, endpoint: mismatched.record.socketPath, recordType: 'orphan-v2'
    })
    const client = new DaemonClient(directory, events, entry, { handshakeTimeoutMs: 50 })
    try {
      await expect(client.connect()).rejects.toThrow(/exited during startup/)
    } finally {
      client.disconnect()
      publication.store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it.runIf(process.platform !== 'win32')('retains its owner so failed cleanup can be retried', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'terminal-cleanup-retry-')))
    const daemon = new TerminalDaemon({ userDataDir: directory, authToken: 'terminal-cleanup-token-123456789' })
    const paths = localRuntimePaths(directory, 'terminal')
    try {
      await daemon.start()
      chmodSync(dirname(paths.runtimeFile), 0o500)
      await expect(daemon.stopIfIdle()).rejects.toThrow(/could not verify ownership cleanup/)
      chmodSync(dirname(paths.runtimeFile), 0o700)
      await expect(daemon.stopIfIdle()).resolves.toBe(true)
      const store = new RuntimeOwnershipStore(paths.ownershipDatabasePath, { readOnly: true })
      try { expect(store.observe('terminal-daemon')).toMatchObject({ status: 'vacant' }) } finally { store.close() }
    } finally {
      chmodSync(dirname(paths.runtimeFile), 0o700)
      await daemon.stopIfIdle().catch(() => false)
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
