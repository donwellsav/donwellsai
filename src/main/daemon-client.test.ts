// @vitest-environment node
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { localRuntimePaths } from './local-runtime'
import { DaemonClient, type DaemonEvents } from './daemon-client'
import { RuntimeOwnershipStore } from '@shared/runtime-ownership'

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
