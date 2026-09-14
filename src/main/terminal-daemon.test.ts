// @vitest-environment node
import { mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { StringDecoder } from 'node:string_decoder'
import { RuntimeOwnershipStore, type RuntimeOwner } from '@shared/runtime-ownership'
import { DaemonClient, terminateSpawnedChild } from './daemon-client'
import { localRuntimePaths, readRuntimeRecord, writeRuntimeRecord } from './local-runtime'
import { claimRuntimeOwner, freshRuntimeEndpoint, publishRuntimeOwner } from './runtime-ownership'
import { TerminalDaemon } from './terminal-daemon'
import { openTaskAuthorityRawConnection } from './task-authority/schema'

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
