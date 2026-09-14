// @vitest-environment node
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { localRuntimePaths, writeRuntimeRecord, type LocalRuntimeRecord } from './local-runtime'
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
