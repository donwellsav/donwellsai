// @vitest-environment node
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { StringDecoder } from 'node:string_decoder'
import { RuntimeOwnershipStore, type RuntimeOwner } from '@shared/runtime-ownership'
import { DaemonClient, terminateSpawnedChild } from './daemon-client'
import { localRuntimePaths, readRuntimeRecord, writeRuntimeRecord } from './local-runtime'
import { claimRuntimeOwner, freshRuntimeEndpoint, publishRuntimeOwner } from './runtime-ownership'
import { TerminalDaemon } from './terminal-daemon'
import { openTaskAuthorityRawConnection } from './task-authority/schema'
import { SqliteProfileMaintenanceGate } from './profile-maintenance-gate'
import { REDACTED_SUBSTITUTE, SecretOutputBoundary } from './secret-output-redactor'

/**
 * Sends one raw wire frame on a freshly authenticated connection and reads the
 * single reply. Used to prove the daemon's maintenance/migration op surface
 * without going through the typed client.
 */
function callWireOp(socketPath: string, authToken: string, op: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const completion = Promise.withResolvers<Record<string, unknown>>()
  const socket = createConnection(socketPath)
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  let greeted = false
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const finish = (error?: Error, message?: Record<string, unknown>): void => {
    if (settled) return
    settled = true
    if (timer) clearTimeout(timer)
    socket.removeAllListeners()
    socket.destroy()
    if (error) completion.reject(error)
    else completion.resolve(message as Record<string, unknown>)
  }
  const requestId = `probe-${op}`
  socket.once('error', error => finish(error))
  socket.once('connect', () => socket.write(JSON.stringify({ id: 'hello', op: 'hello', authToken }) + '\n'))
  socket.on('data', chunk => {
    buffer += decoder.write(chunk)
    let newline: number
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line.trim()) continue
      let message: Record<string, unknown>
      try {
        message = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (!greeted && message['capabilities'] !== undefined) {
        greeted = true
        socket.write(JSON.stringify({ id: requestId, op, ...params }) + '\n')
        continue
      }
      if (greeted && message['id'] === requestId) finish(undefined, message)
    }
  })
  timer = setTimeout(() => finish(new Error(`no reply to maintenance op ${op}`)), 5_000)
  return completion.promise
}

type DaemonLifecycleProbe = { activePublication: () => { owner: RuntimeOwner; store: { release: (owner: RuntimeOwner) => boolean } } | null }
/** The daemon's own data sink, for driving chunk boundaries a PTY will not force. */
type DaemonSinkProbe = { handlePtyData: (sessionId: string, data: string) => void }
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

  it('repairs Electron profile permissions before connecting to the private daemon runtime', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'terminal-electron-profile-')))
    const daemon = new TerminalDaemon({ userDataDir: directory, authToken: 'terminal-profile-token-123456789' })
    const client = new DaemonClient(directory, events, process.execPath)
    try {
      await daemon.start()
      // Electron commonly creates its Application Support profile as 0755. The
      // daemon client runs before the app runtime writer, so it must establish
      // the existing private-profile policy instead of rejecting the profile.
      chmodSync(directory, 0o755)
      await client.connect()
      expect(statSync(directory).mode & 0o077).toBe(0)
    } finally {
      chmodSync(directory, 0o700)
      client.disconnect()
      await daemon.stopIfIdle()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('waits for connection bookkeeping before shutdown completes', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'terminal-disconnect-drain-')))
    const daemon = new TerminalDaemon({ userDataDir: directory, authToken: 'terminal-drain-token-123456789' })
    const client = new DaemonClient(directory, events, process.execPath)
    const release = Promise.withResolvers<void>()
    const original = SqliteProfileMaintenanceGate.prototype.markConnectionDisconnected
    const bookkeeping = vi.spyOn(SqliteProfileMaintenanceGate.prototype, 'markConnectionDisconnected').mockImplementation(async function (this: SqliteProfileMaintenanceGate, connectionId) {
      await release.promise
      await original.call(this, connectionId)
    })
    let stopping: Promise<boolean> | undefined
    try {
      await daemon.start()
      await client.connect()
      let stopped = false
      stopping = daemon.stopIfIdle().then(result => { stopped = true; return result })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(stopped).toBe(false)
      release.resolve()
      expect(await stopping).toBe(true)
      expect(bookkeeping).toHaveBeenCalled()
    } finally {
      release.resolve()
      await stopping
      client.disconnect()
      await daemon.stopIfIdle()
      bookkeeping.mockRestore()
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
      const afterFailure = new RuntimeOwnershipStore(paths.ownershipDatabasePath, { readOnly: true })
      expect(afterFailure.observe('terminal-daemon')).toMatchObject({ status: 'vacant' })
      afterFailure.close()
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
  it.runIf(process.platform !== 'win32')('leaves locator evidence after shutdown', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'terminal-cleanup-retry-')))
    const daemon = new TerminalDaemon({ userDataDir: directory, authToken: 'terminal-cleanup-token-123456789' })
    const paths = localRuntimePaths(directory, 'terminal')
    try {
      await daemon.start()
      await expect(daemon.stopIfIdle()).resolves.toBe(true)
      expect(readRuntimeRecord(paths.runtimeFile).status).toBe('current')
      const store = new RuntimeOwnershipStore(paths.ownershipDatabasePath, { readOnly: true })
      try { expect(store.observe('terminal-daemon')).toMatchObject({ status: 'vacant' }) } finally { store.close() }
    } finally {
      await daemon.stopIfIdle().catch(() => false)
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('ACP daemon wire compatibility', () => {
  type AcpClientProbe = {
    capabilities: Set<string>
    connect: () => Promise<void>
    request: (operation: string) => Promise<Record<string, unknown>>
    dispatchEvent: (message: Record<string, unknown>) => void
  }

  const legacySnapshot = {
    mode: 'acp',
    id: 'legacy-wire-run',
    workspacePath: '/tmp/legacy-wire',
    protocolSessionId: 'legacy-protocol-session',
    pid: 4242,
    state: 'ready',
    capabilities: {},
    permissions: []
  }

  function clientProbe(capabilities: string[], response: (operation: string) => Record<string, unknown>, onAcp?: () => void): { client: DaemonClient; probe: AcpClientProbe } {
    const client = new DaemonClient('/tmp', { ...events, ...(onAcp ? { acp: onAcp } : {}) }, process.execPath)
    const probe = client as unknown as AcpClientProbe
    probe.capabilities = new Set(capabilities)
    probe.connect = async () => {}
    probe.request = async operation => response(operation)
    return { client, probe }
  }

  it.runIf(process.platform !== 'win32')('refuses ACP requests after a real ACP-v1-only daemon handshake', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'acp-v1-handshake-')))
    const socketPath = join(directory, 'base-daemon.sock')
    const authToken = 'base-daemon-auth-token-123456789'
    const processIdentity = { pid: process.pid, bootId: 'base-boot', startedAt: 'base-start', executablePath: process.execPath, family: 'terminal-daemon', capturedAt: '2026-09-13T00:00:00.000Z' }
    const expected = { ownerId: '11111111-1111-4111-8111-111111111111', ownerGeneration: 1, socketPath, authToken, processIdentity }
    const server = createServer(socket => {
      socket.once('data', chunk => {
        const request = JSON.parse(chunk.toString('utf8')) as Record<string, unknown>
        socket.write(JSON.stringify({ id: request['id'], ok: true, protocolVersion: 3, runtimeIdentityContractVersion: 1, ownerId: expected.ownerId, generation: expected.ownerGeneration, processIdentity, capabilities: ['agent-acp-v1'] }) + '\n')
      })
    })
    const client = new DaemonClient(directory, events, process.execPath)
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
      const connectProbe = client as unknown as DaemonConnectProbe
      await expect(connectProbe.tryConnect.call(client, socketPath, authToken, expected)).resolves.toBe(true)
      await expect(client.listAcp('/tmp/workspace')).rejects.toThrow(/upgrade required/)
    } finally {
      client.disconnect()
      await new Promise<void>(resolve => server.close(() => resolve()))
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects pid-shaped snapshots at every ACP response and event boundary', async () => {
    let acpEvents = 0
    const { client, probe } = clientProbe(['agent-acp-v2'], operation => {
      if (operation === 'acp.list') return { sessions: [legacySnapshot] }
      if (operation === 'acp.observe') return { snapshot: legacySnapshot, sequence: 0, truncated: false, updates: [], requests: [] }
      if (operation === 'agent.switch' || operation === 'agent.switch.get') {
        return { receipt: { requestId: 'switch-one', workspacePath: '/tmp/workspace', sessionId: 'run-one', target: 'acp', state: 'completed', continuity: 'new-session', acp: legacySnapshot } }
      }
      return { snapshot: legacySnapshot }
    }, () => { acpEvents += 1 })

    await expect(client.startAcp('/tmp/workspace', 'run-one', { executable: 'opencode', args: [] }, [])).rejects.toThrow(/invalid ACP snapshot/)
    await expect(client.listAcp('/tmp/workspace')).rejects.toThrow(/invalid ACP snapshot/)
    await expect(client.observeAcp('/tmp/workspace', 'run-one')).rejects.toThrow(/invalid ACP snapshot/)
    await expect(client.controlAcp('/tmp/workspace', 'run-one', 'stop')).rejects.toThrow(/invalid ACP snapshot/)
    await expect(client.switchMode('/tmp/workspace', 'run-one', 'acp', 'switch-one', 'opencode', [])).rejects.toThrow(/invalid ACP snapshot/)
    await expect(client.modeSwitchResult('/tmp/workspace', 'switch-one')).rejects.toThrow(/invalid ACP snapshot/)
    probe.dispatchEvent({ event: 'acp', snapshot: legacySnapshot })
    expect(acpEvents).toBe(0)
  })
})

describe('terminal daemon maintenance and migration wire surface', () => {
  /**
   * Starts a real daemon on an isolated profile and returns its endpoint.
   * Every maintenance/migration op is exercised over the wire because the
   * daemon is the only thing that may construct authenticated principal
   * contexts.
   */
  async function startDaemon(): Promise<{ directory: string; socketPath: string; token: string; daemon: TerminalDaemon }> {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'terminal-maintenance-')))
    const token = 'terminal-maintenance-token-123456789'
    const daemon = new TerminalDaemon({ userDataDir: directory, authToken: token })
    await daemon.start()
    const locator = readRuntimeRecord(localRuntimePaths(directory, 'terminal').runtimeFile)
    if (locator.status !== 'current') {
      await daemon.stopIfIdle()
      throw new Error('terminal locator was not published')
    }
    return { directory, socketPath: locator.record.socketPath, token, daemon }
  }

  it('serves every maintenance op that carries neither a participant nor an owner stage', async () => {
    const started = await startDaemon()
    try {
      // Ops that send no participant and no owner stage must not be rejected by
      // eager context parsing.
      const state = await callWireOp(started.socketPath, started.token, 'maintenance.state', {})
      if (state['ok'] !== true) throw new Error('maintenance.state failed: ' + JSON.stringify(state))
      expect(state).toMatchObject({ ok: true })
      expect(state['state']).toMatchObject({ phase: 'open', lease: null, participants: [] })

      const migrationStatus = await callWireOp(started.socketPath, started.token, 'task.migration.status', {})
      expect(migrationStatus).toMatchObject({ ok: true })
      expect(migrationStatus['status']).toMatchObject({ state: 'legacy' })

      const imported = await callWireOp(started.socketPath, started.token, 'task.migration.import', {})
      expect(imported).toMatchObject({ ok: true })

      const shadow = await callWireOp(started.socketPath, started.token, 'task.migration.shadow', {})
      expect(shadow).toMatchObject({ ok: true })
      expect(shadow['report']).toMatchObject({ clean: true })

      // The migration is activated over the wire, then the scoped export runs.
      const leaseReply = await callWireOp(started.socketPath, started.token, 'maintenance.acquire', {
        migrationId: 'migration-wire',
        ownerStage: 'stage-2',
        participants: ['task-authority'],
        expectedRevision: 1
      })
      if (leaseReply['ok'] !== true) throw new Error('maintenance.acquire failed: ' + JSON.stringify(leaseReply))
      const lease = leaseReply['lease'] as Record<string, unknown>

      const frozen = await callWireOp(started.socketPath, started.token, 'maintenance.freeze', { lease, ownerStage: 'stage-2' })
      if (frozen['ok'] !== true) throw new Error('maintenance.freeze failed: ' + JSON.stringify(frozen))
      await expect(callWireOp(started.socketPath, started.token, 'maintenance.drained', { migrationId: 'migration-wire', participant: 'task-authority', ownerStage: 'stage-2' })).resolves.toMatchObject({ ok: true })
      await expect(callWireOp(started.socketPath, started.token, 'maintenance.cutover', { lease, ownerStage: 'stage-2' })).resolves.toMatchObject({ ok: true })

      const prepared = await callWireOp(started.socketPath, started.token, 'maintenance.transition.prepare', {
        lease,
        ownerStage: 'stage-2',
        intent: { participant: 'task-authority', operationId: 'cutover-1', sourceSha256: 'a'.repeat(64), intentSha256: 'b'.repeat(64), visibilityMode: 'central' }
      })
      expect(prepared).toMatchObject({ ok: true })
      const receipt = prepared['receipt'] as Record<string, unknown>

      const completed = await callWireOp(started.socketPath, started.token, 'maintenance.transition.complete', {
        lease,
        ownerStage: 'stage-2',
        receipt,
        evidenceSha256: 'c'.repeat(64)
      })
      expect(completed).toMatchObject({ ok: true })
      expect(completed['receipt']).toMatchObject({ state: 'completed' })

      const transitions = await callWireOp(started.socketPath, started.token, 'maintenance.transitions', { lease, ownerStage: 'stage-2' })
      expect(transitions).toMatchObject({ ok: true })
      expect(transitions['receipts']).toHaveLength(1)

      // The export is an active-authority surface: before release it refuses
      // rather than writing a projection for a migration that is mid-cutover.
      const exported = await callWireOp(started.socketPath, started.token, 'task.migration.export', {})
      expect(exported).toMatchObject({ ok: false })
    } finally {
      await started.daemon.stopIfIdle().catch(() => undefined)
      rmSync(started.directory, { recursive: true, force: true })
    }
  })

  it('serves fail, resume, abort, fence, and release ops with their exact payloads', async () => {
    const started = await startDaemon()
    try {
      const acquire = async (migrationId: string) => {
        const state = await callWireOp(started.socketPath, started.token, 'maintenance.state', {})
        const revision = (state['state'] as Record<string, unknown>)['revision'] as number
        const reply = await callWireOp(started.socketPath, started.token, 'maintenance.acquire', {
          migrationId, ownerStage: 'stage-2', participants: ['task-authority'], expectedRevision: revision
        })
        if (reply['ok'] !== true) throw new Error(`acquire failed: ${JSON.stringify(reply)}`)
        return reply['lease'] as Record<string, unknown>
      }

      // fail -> resume: a failed migration is durable, and resume takes the
      // exact frozen digest recomputed by the gate.
      const first = await acquire('migration-fail')
      const failed = await callWireOp(started.socketPath, started.token, 'maintenance.fail', {
        lease: first, ownerStage: 'stage-2', failure: { code: 'WIRE_TEST', evidenceSha256: 'd'.repeat(64) }
      })
      expect(failed).toMatchObject({ ok: true })
      const failedLease = failed['lease'] as Record<string, unknown>
      const resumed = await callWireOp(started.socketPath, started.token, 'maintenance.resume', {
        ownerStage: 'stage-2',
        input: { migrationId: 'migration-fail', expectedRevision: failedLease['revision'], expectedSourceSetSha256: 'e'.repeat(64) }
      })
      // A wrong digest stays failed rather than being accepted as the snapshot.
      expect(resumed).toMatchObject({ ok: false })

      const abort = await callWireOp(started.socketPath, started.token, 'maintenance.abort', {
        ownerStage: 'stage-2',
        input: { migrationId: 'migration-fail', expectedRevision: failedLease['revision'], observedSourceSetSha256: 'e'.repeat(64) }
      })
      expect(abort).toMatchObject({ ok: true, aborted: true })
      await expect(callWireOp(started.socketPath, started.token, 'maintenance.state', {})).resolves.toMatchObject({ state: { phase: 'open' } })

      // A complete cutover path with a fence and a release.
      const second = await acquire('migration-release')
      await callWireOp(started.socketPath, started.token, 'maintenance.drained', { migrationId: 'migration-release', participant: 'task-authority', ownerStage: 'stage-2' })
      await callWireOp(started.socketPath, started.token, 'maintenance.cutover', { lease: second, ownerStage: 'stage-2' })
      const fence = await callWireOp(started.socketPath, started.token, 'maintenance.fence', {
        lease: second,
        ownerStage: 'stage-2',
        retirement: { participant: 'task-authority', retiredPath: '/profile/orchestrations.json', fenceReceiptSha256: 'f'.repeat(64), fsynced: true }
      })
      expect(fence).toMatchObject({ ok: true })
      expect(fence['receipt']).toMatchObject({ fsynced: true })

      const prepared = await callWireOp(started.socketPath, started.token, 'maintenance.transition.prepare', {
        lease: second,
        ownerStage: 'stage-2',
        intent: { participant: 'task-authority', operationId: 'release-1', sourceSha256: 'a'.repeat(64), intentSha256: 'b'.repeat(64), visibilityMode: 'central' }
      })
      const receipt = prepared['receipt'] as Record<string, unknown>
      const completed = await callWireOp(started.socketPath, started.token, 'maintenance.transition.complete', { lease: second, ownerStage: 'stage-2', receipt, evidenceSha256: 'c'.repeat(64) })
      const release = await callWireOp(started.socketPath, started.token, 'maintenance.release', { lease: second, ownerStage: 'stage-2', outcome: 'active' })
      expect(release).toMatchObject({ ok: true, released: true })
      expect(completed['receipt']).toMatchObject({ state: 'completed' })
    } finally {
      await started.daemon.stopIfIdle().catch(() => undefined)
      rmSync(started.directory, { recursive: true, force: true })
    }
  })

  it('aborts on the operator path after discarding the candidate rows and returning to legacy', async () => {
    // A profile with real importable sources, so the abort has candidate rows
    // to discard rather than an empty migration.
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'terminal-abort-')))
    const users = join(directory, 'user-data')
    const token = 'terminal-abort-token-123456789'
    // A registered project with one Backlog task, so the import produces real
    // candidate rows that the operator abort must discard.
    const backlogTask = { id: 'DW-OP', title: 'operator task', body: '', status: 'todo', priority: 1, dependencies: [], }
    const daemon = new TerminalDaemon({
      userDataDir: directory,
      authToken: token,
      projectRegistry: async () => [{ projectId: 'project-operator', repositoryId: 'repo-operator', workspaceRoot: join(directory, 'workspace') }],
      backlogPort: () => ({
        run: async (_identity, args) => {
          if (args[0] === 'task' && args[1] === 'list') return { schemaVersion: 1, kind: 'task-list', tasks: [{ id: backlogTask.id, title: backlogTask.title, status: backlogTask.status }] }
          return { schemaVersion: 1, kind: 'task-view', task: { ...backlogTask, path: `.backlog/tasks/${backlogTask.id}.md` } }
        },
        readWorkspaceFile: async () => ({ bytes: Buffer.from('operator task source\n', 'utf8'), truncated: false, binary: false })
      })
    })
    try {
      writeFileSync(join(directory, 'orchestrations.json'), JSON.stringify({ schemaVersion: 1, parallelRuns: [] }), { mode: 0o600 })
      void users
      await daemon.start()
      const locator = readRuntimeRecord(localRuntimePaths(directory, 'terminal').runtimeFile)
      if (locator.status !== 'current') throw new Error('terminal locator was not published')
      const socketPath = locator.record.socketPath

      // Import real candidate rows, then abort through the authenticated wire.
      await expect(callWireOp(socketPath, token, 'task.migration.import', {})).resolves.toMatchObject({ ok: true })
      const migrate = await callWireOp(socketPath, token, 'task.migration.status', {})
      expect(migrate['status']).toMatchObject({ state: 'preparing' })
      expect(Number((migrate['status'] as Record<string, unknown>)['entityMappings'])).toBeGreaterThan(0)

      const state = await callWireOp(socketPath, token, 'maintenance.state', {})
      const revision = (state['state'] as Record<string, unknown>)['revision'] as number
      const acquired = await callWireOp(socketPath, token, 'maintenance.acquire', {
        migrationId: 'migration-operator-abort', ownerStage: 'stage-2', participants: ['task-authority'], expectedRevision: revision
      })
      const lease = acquired['lease'] as Record<string, unknown>

      const aborted = await callWireOp(socketPath, token, 'maintenance.abort', {
        ownerStage: 'stage-2',
        input: { migrationId: 'migration-operator-abort', expectedRevision: lease['revision'], observedSourceSetSha256: 'a'.repeat(64) }
      })
      expect(aborted).toMatchObject({ ok: true, aborted: true })

      // The gate released the lease *and* the migration returned to legacy with
      // its candidate rows discarded — the operator abort is the whole job.
      await expect(callWireOp(socketPath, token, 'maintenance.state', {})).resolves.toMatchObject({ state: { phase: 'open', lease: null } })
      const after = await callWireOp(socketPath, token, 'task.migration.status', {})
      expect(after['status']).toMatchObject({ state: 'legacy', entityMappings: 0, sources: [] })

      // No orphan FK rows remain: every table the import wrote is empty, and
      // the profile-event residue is gone with it.
      const db = openTaskAuthorityRawConnection(join(directory, 'terminal-daemon', 'task-authority.sqlite'))
      try {
        for (const [table, clause] of [
          ['tasks', '1 = 1'],
          ['attempts', '1 = 1'],
          ['execution_specifications', '1 = 1'],
          ['task_dependencies', '1 = 1'],
          ['task_events', '1 = 1'],
          ['verification_artifacts', '1 = 1'],
          ['run_members', '1 = 1'],
          ['run_groups', '1 = 1'],
          ['schedule_executions', '1 = 1'],
          ['migration_sources', '1 = 1'],
          ['migration_entity_mappings', '1 = 1'],
          ['authority_profile_events', "event_type = 'legacy-schedule-imported'"]
        ] as const) {
          const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${clause}`).get() as Record<string, number>
          expect({ table, count: Number(row.count) }).toEqual({ table, count: 0 })
        }
        // The migration state row records the operator abort, not a silent open.
        const stateRow = db.prepare("SELECT state FROM task_authority_migration_state WHERE profile_id = ?").get(directory) as Record<string, string>
        expect(stateRow.state).toBe('legacy')
      } finally {
        db.close()
      }

      // New affected work is admitted again, proving legacy writers reopened.
      const admitted = await callWireOp(socketPath, token, 'maintenance.admit.affected', { operationId: 'post-abort-launch' })
      expect(admitted).toMatchObject({ ok: true })
    } finally {
      await daemon.stopIfIdle().catch(() => undefined)
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('reports a coded failure for malformed gate input and still serves later ops', async () => {
    const started = await startDaemon()
    try {
      const malformed = await callWireOp(started.socketPath, started.token, 'maintenance.acquire', { migrationId: 'm', ownerStage: 'stage-9', participants: ['task-authority'], expectedRevision: 1 })
      expect(malformed).toMatchObject({ ok: false, code: 'GATE_INPUT_INVALID' })
      // The connection remains usable: one bad op does not break the surface.
      await expect(callWireOp(started.socketPath, started.token, 'maintenance.state', {})).resolves.toMatchObject({ ok: true })
    } finally {
      await started.daemon.stopIfIdle().catch(() => undefined)
      rmSync(started.directory, { recursive: true, force: true })
    }
  })

  it('admits and closes affected work on the authenticated connection only', async () => {
    const started = await startDaemon()
    try {
      // While the gate is open, the daemon skips admission entirely: the wire
      // form is reserved and refuses a directly-issued participant.
      const reserved = await callWireOp(started.socketPath, started.token, 'maintenance.admit', { participant: 'task-authority', operationId: 'direct' })
      expect(reserved).toMatchObject({ ok: false, code: 'AUTHORIZATION_DENIED' })

      const leaseReply = await callWireOp(started.socketPath, started.token, 'maintenance.acquire', {
        migrationId: 'migration-admit', ownerStage: 'stage-2', participants: ['task-authority'], expectedRevision: 1
      })
      const lease = leaseReply['lease'] as Record<string, unknown>
      // New affected work is refused while frozen...
      const refused = await callWireOp(started.socketPath, started.token, 'maintenance.admit.affected', { operationId: 'launch-1' })
      expect(refused).toMatchObject({ ok: false, code: 'GATE_NOT_OPEN' })
      void lease
    } finally {
      await started.daemon.stopIfIdle().catch(() => undefined)
      rmSync(started.directory, { recursive: true, force: true })
    }
  })
  it('rejects the removed due-schedule wire operation', async () => {
    const started = await startDaemon()
    try {
      await expect(callWireOp(started.socketPath, started.token, 'task.schedule.execution.enqueue-due')).resolves.toMatchObject({
        ok: false,
        error: 'unknown op: task.schedule.execution.enqueue-due'
      })
    } finally {
      await started.daemon.stopIfIdle().catch(() => undefined)
      rmSync(started.directory, { recursive: true, force: true })
    }
  })
})

describe('terminal daemon provider catalog wire surface', () => {
  async function startDaemon(): Promise<{ directory: string; socketPath: string; token: string; daemon: TerminalDaemon }> {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'terminal-providers-')))
    const token = 'terminal-providers-token-123456789'
    const daemon = new TerminalDaemon({ userDataDir: directory, authToken: token })
    await daemon.start()
    const locator = readRuntimeRecord(localRuntimePaths(directory, 'terminal').runtimeFile)
    if (locator.status !== 'current') {
      await daemon.stopIfIdle()
      throw new Error('terminal locator was not published')
    }
    return { directory, socketPath: locator.record.socketPath, token, daemon }
  }
  const instance = { driverId: 'codex', displayName: 'Wire codex', command: { kind: 'driver', driverId: 'codex' }, credentialMode: 'external', accountId: null, enabled: true }

  it('advertises the provider catalog capability and serves a sanitized read', async () => {
    const started = await startDaemon()
    try {
      const hello = await readHello(started.socketPath, started.token)
      expect(hello['capabilities']).toContain('provider-catalog-v1')
      const reply = await callWireOp(started.socketPath, started.token, 'agent.providers')
      expect(reply).toMatchObject({ ok: true })
      const snapshot = reply['snapshot'] as Record<string, unknown>
      expect(snapshot).toMatchObject({ defaultInstanceId: null, accounts: [], instances: [] })
      // Driver projections carry declarative capability facts, never credentials.
      const drivers = snapshot['drivers'] as Array<Record<string, unknown>>
      expect(drivers.some(driver => driver['kind'] === 'known' && driver['id'] === 'codex')).toBe(true)
      expect(JSON.stringify(snapshot)).not.toMatch(/credentialRef|bindingGeneration|credentialRevision|authFile/)
    } finally {
      await started.daemon.stopIfIdle().catch(() => undefined)
      rmSync(started.directory, { recursive: true, force: true })
    }
  })

  it('serves governed create, default, update, and remove without returning secrets', async () => {
    const started = await startDaemon()
    try {
      const created = await callWireOp(started.socketPath, started.token, 'agent.providers.create', { input: instance })
      expect(created).toMatchObject({ ok: true })
      const createdSnapshot = created['snapshot'] as Record<string, unknown>
      const record = (createdSnapshot['instances'] as Array<Record<string, unknown>>)[0]!
      expect(record).toMatchObject({ displayName: 'Wire codex', revision: 1, availability: 'available' })

      const defaulted = await callWireOp(started.socketPath, started.token, 'agent.providers.default', { instanceId: record['id'], expectedRevision: Number(createdSnapshot['revision']) })
      expect(defaulted['snapshot']).toMatchObject({ defaultInstanceId: record['id'] })

      const updated = await callWireOp(started.socketPath, started.token, 'agent.providers.update', { instanceId: record['id'], expectedRevision: 1, input: { ...instance, displayName: 'Wire codex updated' } })
      expect((updated['snapshot'] as Record<string, unknown>)['instances']).toMatchObject([{ displayName: 'Wire codex updated', revision: 2 }])

      const removed = await callWireOp(started.socketPath, started.token, 'agent.providers.remove', { instanceId: record['id'], expectedRevision: 2 })
      expect(removed['snapshot']).toMatchObject({ defaultInstanceId: null, instances: [] })
    } finally {
      await started.daemon.stopIfIdle().catch(() => undefined)
      rmSync(started.directory, { recursive: true, force: true })
    }
  })

  it('serves account create, update, and remove with revision fencing', async () => {
    const started = await startDaemon()
    try {
      const created = await callWireOp(started.socketPath, started.token, 'agent.providers.account.create', { input: { driverId: 'codex', displayLabel: 'Wire account' } })
      expect(created).toMatchObject({ ok: true })
      const account = ((created['snapshot'] as Record<string, unknown>)['accounts'] as Array<Record<string, unknown>>)[0]!

      const updated = await callWireOp(started.socketPath, started.token, 'agent.providers.account.update', { input: { id: account['id'], expectedRevision: 1, displayLabel: 'Wire account renamed' } })
      expect((updated['snapshot'] as Record<string, unknown>)['accounts']).toMatchObject([{ displayLabel: 'Wire account renamed', revision: 2 }])

      const removed = await callWireOp(started.socketPath, started.token, 'agent.providers.account.remove', { input: { id: account['id'], expectedRevision: 2 } })
      expect(removed['snapshot']).toMatchObject({ accounts: [] })
    } finally {
      await started.daemon.stopIfIdle().catch(() => undefined)
      rmSync(started.directory, { recursive: true, force: true })
    }
  })

  it('migrates the legacy agent command at startup before serving provider reads', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'terminal-provider-migration-')))
    const token = 'terminal-provider-migration-token-123456'
    const daemon = new TerminalDaemon({
      userDataDir: directory,
      authToken: token,
      legacyAgentCommand: () => [{ command: 'codex', displayName: 'Codex' }]
    })
    try {
      await daemon.start()
      const locator = readRuntimeRecord(localRuntimePaths(directory, 'terminal').runtimeFile)
      if (locator.status !== 'current') throw new Error('terminal locator was not published')

      // The startup cutover ran before the daemon served anything, so the very
      // first provider read already reports the migrated instance and default.
      const snapshot = (await callWireOp(locator.record.socketPath, token, 'agent.providers'))['snapshot'] as Record<string, unknown>
      const instances = snapshot['instances'] as Array<Record<string, unknown>>
      expect(instances).toHaveLength(1)
      expect(instances[0]).toMatchObject({ credentialMode: 'external', availability: 'available' })
      expect(snapshot['defaultInstanceId']).toBe(instances[0]?.['id'])
      // The migration is external-only: no account or credential appears.
      expect(snapshot['accounts']).toEqual([])
    } finally {
      await daemon.stopIfIdle().catch(() => undefined)
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('migrates the legacy agent command from the profile settings file when no port is injected', async () => {
    // This is the production path: the daemon reads donwells-data.json itself,
    // because the entry process injects no port. A constructor fallback of
    // "no commands" would record an empty migration and strand the user's real
    // agent command forever, so the default must be the file reader.
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'terminal-provider-file-')))
    writeFileSync(join(directory, 'donwells-data.json'), JSON.stringify({ schemaVersion: 2, repos: [], settings: { agentCommand: 'claude --print' } }), { mode: 0o600 })
    const token = 'terminal-provider-file-token-1234567'
    const daemon = new TerminalDaemon({ userDataDir: directory, authToken: token })
    try {
      await daemon.start()
      const locator = readRuntimeRecord(localRuntimePaths(directory, 'terminal').runtimeFile)
      if (locator.status !== 'current') throw new Error('terminal locator was not published')

      const snapshot = (await callWireOp(locator.record.socketPath, token, 'agent.providers'))['snapshot'] as Record<string, unknown>
      const instances = snapshot['instances'] as Array<Record<string, unknown>>
      expect(instances).toHaveLength(1)
      // An argument-bearing command is never a basename-derived driver.
      expect(instances[0]).toMatchObject({
        credentialMode: 'external',
        command: { kind: 'external-shell', program: 'claude --print' }
      })
      expect(snapshot['defaultInstanceId']).toBe(instances[0]?.['id'])
    } finally {
      await daemon.stopIfIdle().catch(() => undefined)
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('leaves a profile without a legacy command unmigrated', async () => {
    const started = await startDaemon()
    try {
      // No legacy command port was supplied, so startup must not invent an
      // instance, a default, or a maintenance lease.
      const snapshot = (await callWireOp(started.socketPath, started.token, 'agent.providers'))['snapshot'] as Record<string, unknown>
      expect(snapshot).toMatchObject({ defaultInstanceId: null, instances: [], accounts: [] })
    } finally {
      await started.daemon.stopIfIdle().catch(() => undefined)
      rmSync(started.directory, { recursive: true, force: true })
    }
  })

  it('returns typed codes for stale revisions and malformed frames', async () => {
    const started = await startDaemon()
    try {
      await callWireOp(started.socketPath, started.token, 'agent.providers.create', { input: instance })
      // A stale revision is a coded conflict, not a message the caller parses.
      const stale = await callWireOp(started.socketPath, started.token, 'agent.providers.update', { instanceId: 'missing', expectedRevision: 1, input: instance })
      expect(stale).toMatchObject({ ok: false, code: 'INSTANCE_NOT_FOUND' })
      // Bounded frame validation still runs before the catalog sees anything.
      const malformed = await callWireOp(started.socketPath, started.token, 'agent.providers.create', { input: { ...instance, credentialRef: 'stolen' } })
      expect(malformed).toMatchObject({ ok: false })
      const unknownDriver = await callWireOp(started.socketPath, started.token, 'agent.providers.account.create', { input: { driverId: 'not-a-driver', displayLabel: 'x' } })
      expect(unknownDriver).toMatchObject({ ok: false })
    } finally {
      await started.daemon.stopIfIdle().catch(() => undefined)
      rmSync(started.directory, { recursive: true, force: true })
    }
  })
})

/**
 * The managed-output sink contract (plan 13 Steps 3 and 5: a managed launch's
 * exact credential values are settled before every PTY, event, log, error,
 * crash, and support sink).
 *
 * The PTY sink is the only place that can honour that: it writes scrollback,
 * the replay buffer, and the live `data` event every client shares, so a
 * redaction left to the task-output pump would only ever be a post-hoc copy.
 * These prove the whole path over a real daemon, a real PTY, and a real child:
 *
 * - the value is split across two PTY chunks, so only the carry can catch it;
 * - its tail is shorter than the retain window, so only the exit-time flush can
 *   release it;
 * - the value also reaches the sinks inside an OSC title sequence, which is a
 *   discrete string settled through its own stream.
 *
 * Nothing waits on a duration: the child emits each half only after the test's
 * own acknowledged keystroke, and every assertion runs behind the daemon's exit
 * event, which node-pty defers until trailing data is complete.
 */
describe('terminal daemon managed output sinks', () => {
  it('settles an exact credential out of scrollback, the live stream, and the title event', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'terminal-sink-redaction-')))
    const value = 'SECRET-VALUE'
    const script = join(directory, 'halves.cjs')
    // The child prints the value in two halves, and its own escape bytes are
    // built from char codes so this fixture stays plain ASCII.
    writeFileSync(script, [
      "process.stdin.setEncoding('utf8')",
      'let phase = 0',
      "process.stdin.on('data', () => {",
      '  phase += 1',
      '  if (phase === 1) { process.stdout.write("SECRET-"); return }',
      '  process.stdout.write("VALUE")',
      '  process.stdout.write(String.fromCharCode(27) + "]0;SECRET-VALUE" + String.fromCharCode(7))',
      '  process.stdout.write("AFTER")',
      '  process.stdin.destroy()',
      '  process.exitCode = 0',
      '})',
      ''
    ].join('\n'), { mode: 0o600 })

    const boundary = new SecretOutputBoundary()
    const chunks: string[] = []
    const titles: string[] = []
    const exited = Promise.withResolvers<number>()
    const client = new DaemonClient(directory, {
      data: (_sessionId, data) => chunks.push(data),
      exit: (_sessionId, exitCode) => exited.resolve(exitCode ?? 0),
      title: (_sessionId, title) => titles.push(title),
      agent: () => {},
      agentDismissed: () => {}
    }, process.execPath)
    const daemon = new TerminalDaemon({
      userDataDir: directory,
      authToken: 'terminal-sink-token-123456789',
      providerBoundary: boundary
    })
    try {
      await daemon.start()
      await client.connect()
      const session = await client.openJob(directory, `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`)
      // The child emits nothing until its first keystroke, so the redactor is
      // registered before any output exists to settle.
      boundary.register(session.id, [value])

      // The first half is short: without the carry it would reach the sinks the
      // moment the daemon read it.
      await client.writeAcknowledged(session.id, 'one\n')
      await client.writeAcknowledged(session.id, 'two\n')
      expect(await exited.promise).toBe(0)

      const stream = chunks.join('')
      expect(stream).toContain(REDACTED_SUBSTITUTE)
      // Only the exit-time flush can release a tail this short.
      expect(stream).toContain('AFTER')
      expect(stream.indexOf(REDACTED_SUBSTITUTE)).toBeLessThan(stream.indexOf('AFTER'))
      // Neither half nor the whole value ever reached the live stream...
      expect(stream).not.toContain('SECRET-')
      expect(stream).not.toContain('VALUE')
      expect(stream).not.toContain(value)
      // ...and scrollback and replay ARE that same settled stream, not a second
      // copy settled elsewhere.
      const attached = await client.attach(session.id)
      expect(attached.scrollback).toBe(stream)
      expect(attached.replay?.map(chunk => chunk.data).join('')).toBe(stream)
      // The title is a discrete string, settled before it is stored: the record
      // `session.list`/`session.attach` serve must not keep a raw copy of what
      // the event redacted.
      expect(titles.join('')).not.toContain(value)
      expect(titles.some(title => title.includes(REDACTED_SUBSTITUTE))).toBe(true)
      const recordTitle = (await client.list()).find(candidate => candidate.id === session.id)?.title ?? ''
      expect(recordTitle).not.toContain(value)
      expect(recordTitle).toContain(REDACTED_SUBSTITUTE)

      // The carry is proven at the daemon's own sink rather than by hoping the
      // PTY split the child's writes: a chunk boundary the test cannot force
      // would let a coalesced write redact in a single push. Feeding the two
      // halves here reaches the real sinks (scrollback, replay, broadcast).
      const probe = daemon as unknown as DaemonSinkProbe
      const before = (await client.attach(session.id)).scrollback
      probe.handlePtyData(session.id, value.slice(0, 7))
      expect((await client.attach(session.id)).scrollback).toBe(before)
      probe.handlePtyData(session.id, value.slice(7))
      expect((await client.attach(session.id)).scrollback.slice(before.length)).toBe(REDACTED_SUBSTITUTE)
      await client.close(session.id)
    } finally {
      client.disconnect()
      await daemon.stopIfIdle().catch(() => undefined)
      rmSync(directory, { recursive: true, force: true })
    }
  })

  /**
   * A provider session is the one session kind whose teardown is not
   * `session.close`: its launch retains a lifecycle pump that reads the PTY's
   * settled exit and final output, and releasing the PTY first would record a
   * clean exit as a failure with its trailing output dropped. The wire op is
   * therefore split by liveness — refused while the child is live, and routed
   * through the same dismissal (which joins that pump) once it has exited.
   */
  it('refuses to close a live provider session and dismisses an exited one', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'terminal-provider-close-')))
    const workspace = join(directory, 'workspace')
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    // A child that stays alive until the daemon stops it, so the close refusal
    // is exercised against a genuinely live run.
    const script = join(directory, 'lingering.cjs')
    writeFileSync(script, 'setInterval(() => {}, 1_000)\n', { mode: 0o600 })

    let launchedSessionId = ''
    const exited = Promise.withResolvers<void>()
    const boundary = new SecretOutputBoundary()
    const client = new DaemonClient(directory, {
      ...events,
      agent: run => {
        if (run.sessionId === launchedSessionId && run.liveness === 'exited') exited.resolve()
      }
    }, process.execPath)
    const daemon = new TerminalDaemon({
      userDataDir: directory,
      authToken: 'terminal-provider-close-token-1234',
      providerBoundary: boundary,
      projectRegistry: async () => [{ projectId: 'project-close', repositoryId: 'repo-close', workspaceRoot: workspace }]
    })
    try {
      await daemon.start()
      await client.connect()
      const created = await client.providerCatalogCreate({
        driverId: 'custom-command',
        displayName: 'Lingering child',
        command: { kind: 'external-argv', executable: { executable: process.execPath, args: [script] } },
        credentialMode: 'external',
        accountId: null,
        enabled: true
      })
      const instanceId = created.instances[0]?.id
      if (instanceId === undefined) throw new Error('provider catalog created no instance')

      const launched = await client.providerInstanceLaunch(workspace, instanceId)
      launchedSessionId = launched.sessionId
      expect(launched.liveness).toBe('live')

      // Live: the pump still owns the child, so the session cannot be closed.
      await expect(client.close(launched.sessionId)).rejects.toThrow(/agent\.stop/)
      expect((await client.list()).some(session => session.id === launched.sessionId)).toBe(true)

      await client.stopAgent(launched.sessionId)
      await exited.promise
      // The pump has already settled, which closed the boundary — exactly the
      // production order — so this proves the dismissal drops a *closed*
      // registration instead of only zeroizing it.
      boundary.register(launched.sessionId, ['SECRET-VALUE'])
      expect(boundary.registeredSessions).toEqual([launched.sessionId])

      // Exited: the same teardown the UI's dismiss uses, pump joined.
      await client.close(launched.sessionId)
      expect((await client.list()).some(session => session.id === launched.sessionId)).toBe(false)
      // Dismissal is the terminal teardown: the launch's registration is
      // released there, so nothing accumulates for the daemon's life.
      expect(boundary.registeredSessions).toEqual([])
      await expect(client.agentStatus(launched.sessionId)).rejects.toThrow(/unknown agent session/)
    } finally {
      client.disconnect()
      await daemon.stopIfIdle().catch(() => undefined)
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
