// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { localRuntimePaths, readRuntimeRecord, writeRuntimeRecord, type LocalRuntimeRecord } from './local-runtime'
import { DaemonClient, DaemonUpgradeRequiredError, type DaemonEvents } from './daemon-client'
import { RuntimeOwnershipStore } from '@shared/runtime-ownership'
import type { ProcessIdentity } from '@shared/child-process/process-spec'

async function listen(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, resolve)
  })
}

const events: DaemonEvents = {
  data: () => undefined,
  exit: () => undefined,
  title: () => undefined,
  agent: () => undefined,
  agentDismissed: () => undefined
}

describe('daemon legacy reconnect', () => {
  it.runIf(process.platform !== 'win32')('uses an authenticated reachable legacy daemon without spawning a replacement', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'daemon-client-legacy-')))
    const paths = localRuntimePaths(directory, 'terminal')
    const endpoint = paths.socketPath
    const token = 'legacy-daemon-token-123456'
    mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 })
    writeFileSync(paths.runtimeFile, JSON.stringify({ socketPath: endpoint, authToken: token }), { mode: 0o600 })
    let requests = 0
    const server = createServer(socket => {
      let buffer = ''
      socket.setEncoding('utf8')
      socket.on('data', chunk => {
        buffer += chunk
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const message = JSON.parse(buffer.slice(0, newline)) as { id: string; op: string; authToken?: string }
          buffer = buffer.slice(newline + 1)
          if (message.op === 'hello') {
            socket.write(JSON.stringify({ id: message.id, ok: message.authToken === token, protocolVersion: 3, capabilities: ['sequenced-output'] }) + '\n')
          } else {
            requests += 1
            socket.write(JSON.stringify({ id: message.id, ok: true, sessions: [] }) + '\n')
          }
        }
      })
    })
    const client = new DaemonClient(directory, events, join(directory, 'must-not-spawn.js'), { handshakeTimeoutMs: 250, requestTimeoutMs: 250 })
    try {
      await listen(server, endpoint)
      await client.connect()
      await expect(client.list()).resolves.toEqual([])
      expect(requests).toBe(1)
    } finally {
      client.disconnect()
      await new Promise<void>(resolve => server.close(() => resolve()))
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform !== 'win32')('refuses a reachable legacy locator when an active authority row exists', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'daemon-client-legacy-mismatch-')))
    const paths = localRuntimePaths(directory, 'terminal')
    const endpoint = paths.socketPath
    const token = 'legacy-daemon-mismatch-token-123456'
    mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 })
    const store = new RuntimeOwnershipStore(paths.ownershipDatabasePath)
    const ownerId = '77777777-7777-4777-8777-777777777777'
    const prepared = store.prepareClaim({
      kind: 'terminal-daemon',
      ownerId,
      identity: { pid: process.pid, bootId: 'boot-daemon-mismatch', startedAt: 'birth-daemon-mismatch', executablePath: process.execPath, family: 'terminal-daemon', capturedAt: '2026-09-13T00:00:00.000Z', generation: ownerId + ':1' },
      endpoint: join(directory, 'authoritative.sock'),
      authToken: 'authoritative-daemon-token-123456'
    }, store.observe('terminal-daemon'), null)
    store.activate(prepared, 'a'.repeat(64))
    writeFileSync(paths.runtimeFile, JSON.stringify({ socketPath: endpoint, authToken: token }), { mode: 0o600 })
    let connections = 0
    const server = createServer(socket => {
      connections += 1
      socket.setEncoding('utf8')
      socket.once('data', chunk => {
        const message = JSON.parse(String(chunk).split('\n')[0]!) as { id: string; authToken?: string }
        socket.write(JSON.stringify({ id: message.id, ok: message.authToken === token, protocolVersion: 3, capabilities: ['sequenced-output'] }) + '\n')
      })
    })
    const client = new DaemonClient(directory, events, join(directory, 'must-not-spawn.js'), { handshakeTimeoutMs: 250, requestTimeoutMs: 250 })
    try {
      await listen(server, endpoint)
      await expect(client.connect()).rejects.toThrow(/legacy runtime locator.*authority/i)
      expect(connections).toBe(0)
    } finally {
      client.disconnect()
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform !== 'win32').each([
    ['unsupported protocol version', { protocolVersion: 999 }],
    ['declared identity contract', { protocolVersion: 3, runtimeIdentityContractVersion: 'invalid' }]
  ])('rejects a legacy handshake with %s', async (_description, declaration) => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'daemon-client-legacy-handshake-')))
    const paths = localRuntimePaths(directory, 'terminal')
    const endpoint = paths.socketPath
    const token = 'legacy-daemon-handshake-token-123456'
    mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 })
    writeFileSync(paths.runtimeFile, JSON.stringify({ socketPath: endpoint, authToken: token }), { mode: 0o600 })
    let operations = 0
    const server = createServer(socket => {
      let buffer = ''
      socket.setEncoding('utf8')
      socket.on('data', chunk => {
        buffer += chunk
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const message = JSON.parse(buffer.slice(0, newline)) as { id: string; op: string; authToken?: string }
          buffer = buffer.slice(newline + 1)
          if (message.op === 'hello') socket.write(JSON.stringify({ id: message.id, ok: message.authToken === token, ...declaration }) + '\n')
          else operations += 1
        }
      })
    })
    const client = new DaemonClient(directory, events, join(directory, 'must-not-spawn.js'), { handshakeTimeoutMs: 250, requestTimeoutMs: 250 })
    try {
      await listen(server, endpoint)
      await expect(client.connect()).rejects.toThrow(/recovery/i)
      expect(operations).toBe(0)
    } finally {
      client.disconnect()
      await new Promise<void>(resolve => server.close(() => resolve()))
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('daemon task client task methods', () => {
  const wireAttempt = (overrides: Record<string, unknown> = {}) => ({
    projectId: 'project-wire',
    taskId: '11111111-1111-4111-8111-111111111111',
    attemptId: '22222222-2222-4222-8222-222222222222',
    sequence: 1,
    retryOfAttemptId: null,
    provenance: 'native',
    state: 'claimed',
    specificationId: '33333333-3333-4333-8333-333333333333',
    currentLease: null,
    runtime: null,
    reservation: null,
    lastProgress: null,
    startedAt: '2026-09-13T00:00:00.000Z',
    finishedAt: null,
    ...overrides
  })
  const wireTask = (overrides: Record<string, unknown> = {}) => ({
    projectId: 'project-wire',
    taskId: '11111111-1111-4111-8111-111111111111',
    externalTaskId: 'DW-W1',
    title: 'wire task',
    body: '',
    status: 'in-progress',
    priority: 0,
    dependencies: [],
    dependencyBlocked: false,
    runnable: false,
    cancelState: 'none',
    currentAttempt: null,
    entityVersion: 2,
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:01.000Z',
    ...overrides
  })
  const wireToken = {
    projectId: 'project-wire',
    taskId: '11111111-1111-4111-8111-111111111111',
    attemptId: '22222222-2222-4222-8222-222222222222',
    ownerId: '66666666-6666-4666-8666-666666666666',
    leaseId: '77777777-7777-4777-8777-777777777777',
    generation: 1,
    expiresAt: '2026-09-13T00:01:00.000Z'
  }

  it.runIf(process.platform !== 'win32')('unwraps the claim field from the task.retry response', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'daemon-client-task-retry-')))
    const paths = localRuntimePaths(directory, 'terminal')
    mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 })
    const ownerId = '88888888-8888-4888-8888-888888888888'
    const token = 'task-retry-daemon-token-123456'
    const identity: ProcessIdentity = { pid: 2468, bootId: 'boot-wire', startedAt: 'birth-wire', executablePath: process.execPath, family: 'terminal-daemon', capturedAt: '2026-09-13T00:00:00.000Z', generation: ownerId + ':1' }
    const store = new RuntimeOwnershipStore(paths.ownershipDatabasePath)
    const candidate = { kind: 'terminal-daemon' as const, ownerId, identity, endpoint: paths.socketPath, authToken: token }
    const locator: LocalRuntimeRecord = { version: 2, ownerId, ownerGeneration: 1, socketPath: paths.socketPath, authToken: token, processIdentity: identity }
    store.activate(store.prepareClaim(candidate, store.observe('terminal-daemon'), null), createHash('sha256').update(JSON.stringify(locator)).digest('hex'))
    writeRuntimeRecord(paths.runtimeFile, locator)
    store.close()
    const server = createServer(socket => {
      socket.setEncoding('utf8')
      let buffer = ''
      socket.on('data', chunk => {
        buffer += chunk
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const message = JSON.parse(buffer.slice(0, newline)) as { id: string; op: string }
          buffer = buffer.slice(newline + 1)
          if (message.op === 'hello') {
            socket.write(JSON.stringify({ id: message.id, ok: true, protocolVersion: 3, runtimeIdentityContractVersion: 1, capabilities: ['task-authority-v1'], ownerId, generation: 1, processIdentity: identity }) + '\n')
            continue
          }
          if (message.op === 'task.retry') {
            socket.write(JSON.stringify({ id: message.id, ok: true, claim: { task: wireTask(), attempt: wireAttempt(), token: wireToken } }) + '\n')
            continue
          }
          socket.write(JSON.stringify({ id: message.id, ok: false, error: 'unknown op: ' + message.op }) + '\n')
        }
      })
    })
    const client = new DaemonClient(directory, events, join(directory, 'must-not-spawn.js'), { handshakeTimeoutMs: 250, requestTimeoutMs: 250 })
    try {
      await listen(server, paths.socketPath)
      await client.connect()
      const claim = await client.taskRetry({ projectId: 'project-wire', taskId: '11111111-1111-4111-8111-111111111111', expectedEntityVersion: 1, ownerId: '66666666-6666-4666-8666-666666666666' })
      expect(claim.token.leaseId).toBe('77777777-7777-4777-8777-777777777777')
      expect(claim.attempt.state).toBe('claimed')
      expect(claim.task.externalTaskId).toBe('DW-W1')
    } finally {
      client.disconnect()
      await new Promise<void>(resolve => server.close(() => resolve()))
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('daemon task authority upgrade negotiation', () => {
  const newIdentity: ProcessIdentity = {
    pid: 4321,
    bootId: 'boot-new-daemon',
    startedAt: 'birth-new-daemon',
    executablePath: process.execPath,
    family: 'terminal-daemon',
    capturedAt: '2026-09-13T00:00:00.000Z',
    generation: '55555555-5555-4555-8555-555555555555:2'
  }
  const NEW_OWNER_ID = '55555555-5555-4555-8555-555555555555'

  function oldDaemonServer(endpoint: string, token: string, status: { idle: boolean; sessionCount: number; liveSessionCount: number }, options: { onShutdown?: () => void; handshake?: Record<string, unknown>; legacy?: boolean } = {}) {
    const requests: string[] = []
    const server = createServer(socket => {
      socket.setEncoding('utf8')
      let buffer = ''
      socket.on('data', chunk => {
        buffer += chunk
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const message = JSON.parse(buffer.slice(0, newline)) as { id: string; op: string; authToken?: string }
          buffer = buffer.slice(newline + 1)
          if (message.op === 'hello') {
            const hello: Record<string, unknown> = { id: message.id, ok: message.authToken === token, protocolVersion: 3, capabilities: ['sequenced-output', 'daemon-status', 'idle-shutdown'], ...options.handshake }
            if (!options.legacy) hello['runtimeIdentityContractVersion'] = 1
            socket.write(JSON.stringify(hello) + '\n')
            continue
          }
          requests.push(message.op)
          if (message.op === 'daemon.status') socket.write(JSON.stringify({ id: message.id, ok: true, pid: 1234, ...status }) + '\n')
          else if (message.op === 'daemon.shutdown') {
            options.onShutdown?.()
            socket.write(JSON.stringify({ id: message.id, ok: true, stopped: true }) + '\n')
            socket.end()
          } else if (message.op === 'session.list') socket.write(JSON.stringify({ id: message.id, ok: true, sessions: [] }) + '\n')
          else socket.write(JSON.stringify({ id: message.id, ok: false, error: 'unknown op: ' + message.op }) + '\n')
        }
      })
    })
    return { server, requests }
  }

  function newDaemonServer(endpoint: string, token: string) {
    const requests: string[] = []
    const server = createServer(socket => {
      socket.setEncoding('utf8')
      let buffer = ''
      socket.on('data', chunk => {
        buffer += chunk
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const message = JSON.parse(buffer.slice(0, newline)) as { id: string; op: string; authToken?: string }
          buffer = buffer.slice(newline + 1)
          if (message.op === 'hello') {
            socket.write(JSON.stringify({
              id: message.id,
              ok: message.authToken === token,
              protocolVersion: 3,
              runtimeIdentityContractVersion: 1,
              capabilities: ['task-authority-v1', 'daemon-status'],
              ownerId: NEW_OWNER_ID,
              generation: 2,
              processIdentity: newIdentity
            }) + '\n')
            continue
          }
          requests.push(message.op)
          if (message.op === 'task.query') socket.write(JSON.stringify({ id: message.id, ok: true, tasks: [], nextCursor: null }) + '\n')
          else socket.write(JSON.stringify({ id: message.id, ok: false, error: 'unknown op: ' + message.op }) + '\n')
        }
      })
    })
    return { server, requests }
  }

  it.runIf(process.platform !== 'win32')('replaces a provably idle old daemon and reaches task-authority-v1', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'daemon-client-upgrade-idle-')))
    const paths = localRuntimePaths(directory, 'terminal')
    mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 })
    const oldIdentity: ProcessIdentity = {
      pid: 1111,
      bootId: 'boot-old-daemon',
      startedAt: 'birth-old-daemon',
      executablePath: process.execPath,
      family: 'terminal-daemon',
      capturedAt: '2026-09-13T00:00:00.000Z',
      generation: '44444444-4444-4444-8444-444444444444:1'
    }
    const OLD_OWNER_ID = '44444444-4444-4444-8444-444444444444'
    const oldToken = 'old-idle-daemon-token-123456'
    const newEndpoint = join('/tmp', `dw-upgrade-new-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`)
    const newToken = 'replacement-daemon-token-123456'
    const locatorB: LocalRuntimeRecord = { version: 2, ownerId: NEW_OWNER_ID, ownerGeneration: 2, socketPath: newEndpoint, authToken: newToken, processIdentity: newIdentity }
    const locatorA: LocalRuntimeRecord = { version: 2, ownerId: OLD_OWNER_ID, ownerGeneration: 1, socketPath: paths.socketPath, authToken: oldToken, processIdentity: oldIdentity }
    const store = new RuntimeOwnershipStore(paths.ownershipDatabasePath)
    const candidateA = { kind: 'terminal-daemon' as const, ownerId: OLD_OWNER_ID, identity: oldIdentity, endpoint: paths.socketPath, authToken: oldToken }
    const activeA = store.activate(store.prepareClaim(candidateA, store.observe('terminal-daemon'), null), createHash('sha256').update(JSON.stringify(locatorA)).digest('hex'))
    writeRuntimeRecord(paths.runtimeFile, locatorA)
    const transitionToReplacement = (): void => {
      const transitionStore = new RuntimeOwnershipStore(paths.ownershipDatabasePath)
      try {
        transitionStore.release(activeA)
        const candidateB = { kind: 'terminal-daemon' as const, ownerId: NEW_OWNER_ID, identity: newIdentity, endpoint: newEndpoint, authToken: newToken }
        const preparedB = transitionStore.prepareClaim(candidateB, transitionStore.observe('terminal-daemon'), null)
        if (preparedB.generation !== 2) throw new Error(`unexpected replacement generation ${preparedB.generation}`)
        transitionStore.activate(preparedB, createHash('sha256').update(JSON.stringify(locatorB)).digest('hex'))
        writeRuntimeRecord(paths.runtimeFile, locatorB)
      } finally {
        transitionStore.close()
      }
    }
    store.close()

    const oldDaemon = oldDaemonServer(paths.socketPath, oldToken, { idle: true, sessionCount: 0, liveSessionCount: 0 }, {
      onShutdown: transitionToReplacement,
      handshake: { ownerId: OLD_OWNER_ID, generation: 1, processIdentity: oldIdentity }
    })
    const newDaemon = newDaemonServer(newEndpoint, newToken)
    const client = new DaemonClient(directory, events, join(directory, 'must-not-spawn.js'), { handshakeTimeoutMs: 250, requestTimeoutMs: 250 })
    try {
      await listen(oldDaemon.server, paths.socketPath)
      await listen(newDaemon.server, newEndpoint)
      await client.connect()
      const projection = await client.taskQuery({})
      expect(projection.tasks).toEqual([])
      expect(oldDaemon.requests).toContain('daemon.status')
      expect(oldDaemon.requests).toContain('daemon.shutdown')
      expect(newDaemon.requests).toContain('task.query')
    } finally {
      client.disconnect()
      await new Promise<void>(resolve => oldDaemon.server.close(() => resolve()))
      await new Promise<void>(resolve => newDaemon.server.close(() => resolve()))
      rmSync(directory, { recursive: true, force: true })
    }
  })

  const PACKAGED_DAEMON_ENTRY = join(__dirname, '..', '..', 'out', 'main', 'terminal-daemon-entry.js')

  it.runIf(process.platform !== 'win32' && existsSync(PACKAGED_DAEMON_ENTRY))('spawns the packaged daemon when the idle old daemon preserves its v2 locator and releases only its owner row', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'daemon-client-upgrade-preserve-')))
    const paths = localRuntimePaths(directory, 'terminal')
    mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 })
    const oldIdentity: ProcessIdentity = {
      pid: 1111,
      bootId: 'boot-old-preserve',
      startedAt: 'birth-old-preserve',
      executablePath: process.execPath,
      family: 'terminal-daemon',
      capturedAt: '2026-09-13T00:00:00.000Z',
      generation: '44444444-4444-4444-8444-444444444444:1'
    }
    const OLD_OWNER_ID = '44444444-4444-4444-8444-444444444444'
    const oldToken = 'old-preserve-daemon-token-123456'
    const locatorA: LocalRuntimeRecord = { version: 2, ownerId: OLD_OWNER_ID, ownerGeneration: 1, socketPath: paths.socketPath, authToken: oldToken, processIdentity: oldIdentity }
    const store = new RuntimeOwnershipStore(paths.ownershipDatabasePath)
    const candidateA = { kind: 'terminal-daemon' as const, ownerId: OLD_OWNER_ID, identity: oldIdentity, endpoint: paths.socketPath, authToken: oldToken }
    const activeA = store.activate(store.prepareClaim(candidateA, store.observe('terminal-daemon'), null), createHash('sha256').update(JSON.stringify(locatorA)).digest('hex'))
    writeRuntimeRecord(paths.runtimeFile, locatorA)
    store.close()

    // Real v2 shutdown: preserve the locator for recovery (orphan-v2 evidence)
    // and release only the owner row.
    const releaseOnlyOwnerRow = (): void => {
      const current = readRuntimeRecord(paths.runtimeFile)
      if (current.status !== 'current') throw new Error('preserved locator was not current')
      const transitionStore = new RuntimeOwnershipStore(paths.ownershipDatabasePath)
      try {
        transitionStore.recordLegacyRecovery({
          kind: 'terminal-daemon',
          expectedFingerprint: current.sha256,
          fileIdentity: current.fileIdentity,
          evidencePath: paths.runtimeFile,
          evidenceFileIdentity: current.fileIdentity,
          endpoint: paths.socketPath,
          recordType: 'orphan-v2'
        })
        transitionStore.release(activeA)
      } finally {
        transitionStore.close()
      }
      rmSync(paths.socketPath, { force: true })
    }
    const oldDaemon = oldDaemonServer(paths.socketPath, oldToken, { idle: true, sessionCount: 0, liveSessionCount: 0 }, { onShutdown: releaseOnlyOwnerRow, handshake: { ownerId: OLD_OWNER_ID, generation: 1, processIdentity: oldIdentity } })
    const client = new DaemonClient(directory, events, PACKAGED_DAEMON_ENTRY, { handshakeTimeoutMs: 2_000, requestTimeoutMs: 5_000 })
    let daemonExited = false
    try {
      await listen(oldDaemon.server, paths.socketPath)
      await client.connect()
      const projection = await client.taskQuery({})
      expect(projection.tasks).toEqual([])
      expect(oldDaemon.requests).toContain('daemon.status')
      expect(oldDaemon.requests).toContain('daemon.shutdown')
      await client.shutdownIfIdle()
    } finally {
      client.disconnect()
      await new Promise<void>(resolve => oldDaemon.server.close(() => resolve()))
    }
    // Wait for the detached packaged daemon to exit before removing userData;
    // the daemon finalizes its WAL and locator during teardown.
    for (let attempt = 0; attempt < 50 && !daemonExited; attempt += 1) {
      try {
        execFileSync('pgrep', ['-f', `terminal-daemon-entry\\.js ${directory}`], { stdio: 'pipe' })
        await new Promise(resolve => setTimeout(resolve, 100))
      } catch {
        daemonExited = true
      }
    }
    rmSync(directory, { recursive: true, force: true })
    if (!daemonExited) throw new Error('packaged daemon process survived shutdownIfIdle teardown')
  }, 30_000)

  it.runIf(process.platform !== 'win32')('blocks activation with sanitized status while an old daemon owns live sessions', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'daemon-client-upgrade-live-')))
    const paths = localRuntimePaths(directory, 'terminal')
    mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 })
    const oldToken = 'old-live-daemon-token-123456'
    writeFileSync(paths.runtimeFile, JSON.stringify({ socketPath: paths.socketPath, authToken: oldToken }), { mode: 0o600 })
    const oldDaemon = oldDaemonServer(paths.socketPath, oldToken, { idle: false, sessionCount: 2, liveSessionCount: 1 }, { legacy: true })
    const client = new DaemonClient(directory, events, join(directory, 'must-not-spawn.js'), { handshakeTimeoutMs: 250, requestTimeoutMs: 250 })
    try {
      await listen(oldDaemon.server, paths.socketPath)
      await client.connect()
      const failure = await client.taskQuery({}).then(() => null, error => error)
      expect(failure).toBeInstanceOf(DaemonUpgradeRequiredError)
      expect(failure.code).toBe('DAEMON_UPGRADE_REQUIRED')
      expect(failure.status).toEqual({ pid: 1234, idle: false, sessionCount: 2, liveSessionCount: 1 })
      expect(oldDaemon.requests).toContain('daemon.status')
      expect(oldDaemon.requests).not.toContain('daemon.shutdown')
      // The old daemon was left running: plain terminal operations still work.
      await expect(client.list()).resolves.toEqual([])
      expect(oldDaemon.requests).toContain('session.list')
    } finally {
      client.disconnect()
      await new Promise<void>(resolve => oldDaemon.server.close(() => resolve()))
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
