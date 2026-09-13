// @vitest-environment node
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createServer, type Server } from 'node:net'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ProcessIdentity } from '@shared/child-process/process-spec'
import { RuntimeOwnershipStore } from '@shared/runtime-ownership'
import { localRuntimePaths, writeRuntimeRecord, type LocalRuntimeRecord } from '../main/local-runtime'
import { callRuntime } from './rpc-client'

const identity: ProcessIdentity = {
  pid: process.pid,
  bootId: 'boot-cli',
  startedAt: 'birth-cli',
  executablePath: process.execPath,
  family: 'donwells-app',
  capturedAt: '2026-09-13T00:00:00.000Z'
}

async function listen(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, resolve)
  })
}

describe('CLI runtime resolution', () => {
  it.each(['ordinary', 'memory-mcp'])('calls %s only after exact active-owner resolution', async mode => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'rpc-client-owner-')))
    const paths = localRuntimePaths(directory, 'app')
    const store = new RuntimeOwnershipStore(paths.ownershipDatabasePath)
    const endpoint = paths.socketPath
    const token = 'cli-token-' + mode + '-123456'
    const candidate = { kind: 'donwells-app' as const, ownerId: '88888888-8888-4888-8888-888888888888', identity: { ...identity, generation: '88888888-8888-4888-8888-888888888888:1' }, endpoint, authToken: token }
    const active = store.activate(store.prepareClaim(candidate, store.observe('donwells-app'), null), 'd'.repeat(64))
    const locator: LocalRuntimeRecord = { version: 2, ownerId: active.ownerId, ownerGeneration: active.generation, socketPath: endpoint, authToken: token, processIdentity: active.identity }
    writeRuntimeRecord(paths.runtimeFile, locator)
        store.republishActive(active, 'd'.repeat(64), createHash('sha256').update(JSON.stringify(locator)).digest('hex'))
    let requests = 0
    const server = createServer(socket => {
      let buffer = ''
      socket.setEncoding('utf8')
      socket.on('data', chunk => {
        buffer += chunk
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          const message = JSON.parse(line) as { id: string; method: string }
          if (message.method === 'auth.hello') socket.write(JSON.stringify({ id: message.id, ok: true }) + '\n')
          else { requests += 1; socket.write(JSON.stringify({ id: message.id, ok: true, result: { mode } }) + '\n') }
        }
      })
    })
    try {
      await listen(server, endpoint)
      const result = await callRuntime(mode === 'memory-mcp' ? 'memory-mcp' : 'worktree.list', {}, directory, 1000)
      expect(result).toMatchObject({ ok: true, result: { mode } })
      expect(requests).toBe(1)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('calls an authenticated reachable legacy runtime without an ownership row', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'rpc-client-legacy-')))
    const paths = localRuntimePaths(directory, 'app')
    const endpoint = paths.socketPath
    const token = 'legacy-cli-token-123456'
    writeFileSync(paths.runtimeFile, JSON.stringify({ socketPath: endpoint, authToken: token }), { mode: 0o600 })
    let requests = 0
    const server = createServer(socket => {
      let buffer = ''
      socket.setEncoding('utf8')
      socket.on('data', chunk => {
        buffer += chunk
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const message = JSON.parse(buffer.slice(0, newline)) as { id: string; method: string; authToken?: string }
          buffer = buffer.slice(newline + 1)
          if (message.method === 'auth.hello') socket.write(JSON.stringify({ id: message.id, ok: message.authToken === token }) + '\n')
          else { requests += 1; socket.write(JSON.stringify({ id: message.id, ok: true, result: { legacy: true } }) + '\n') }
        }
      })
    })
    try {
      expect(existsSync(paths.ownershipDatabasePath)).toBe(false)
      expect(readdirSync(directory).filter(name => name.startsWith('runtime-owners.sqlite'))).toEqual([])
      await listen(server, endpoint)
      await expect(callRuntime('worktree.list', {}, directory, 1000)).resolves.toMatchObject({ ok: true, result: { legacy: true } })
      expect(requests).toBe(1)
      expect(existsSync(paths.ownershipDatabasePath)).toBe(false)
      expect(readdirSync(directory).filter(name => name.startsWith('runtime-owners.sqlite'))).toEqual([])
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('observes a supported older authority schema without migrating or creating sidecars', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'rpc-client-legacy-readonly-')))
    const paths = localRuntimePaths(directory, 'app')
    const endpoint = paths.socketPath
    const token = 'legacy-cli-readonly-token-123456'
    writeFileSync(paths.runtimeFile, JSON.stringify({ socketPath: endpoint, authToken: token }), { mode: 0o600 })
    const database = new DatabaseSync(paths.ownershipDatabasePath)
    database.exec(`
      CREATE TABLE runtime_owners (kind TEXT PRIMARY KEY, owner_id TEXT NOT NULL, generation INTEGER NOT NULL, state TEXT NOT NULL, identity_json TEXT NOT NULL, endpoint TEXT NOT NULL, auth_token TEXT NOT NULL, locator_sha256 TEXT, claimed_at TEXT NOT NULL, activated_at TEXT);
      CREATE TABLE runtime_owner_generations (kind TEXT PRIMARY KEY, last_generation INTEGER NOT NULL);
      PRAGMA user_version=3;
    `)
    database.close()
    chmodSync(paths.ownershipDatabasePath, 0o600)
    const beforeBytes = readFileSync(paths.ownershipDatabasePath)
    const beforeEntries = readdirSync(directory).sort()
    const server = createServer(socket => {
      let buffer = ''
      socket.setEncoding('utf8')
      socket.on('data', chunk => {
        buffer += chunk
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const message = JSON.parse(buffer.slice(0, newline)) as { id: string; method: string; authToken?: string }
          buffer = buffer.slice(newline + 1)
          socket.write(JSON.stringify(message.method === 'auth.hello'
            ? { id: message.id, ok: message.authToken === token }
            : { id: message.id, ok: true, result: { legacy: true } }) + '\n')
        }
      })
    })
    try {
      await listen(server, endpoint)
      await expect(callRuntime('worktree.list', {}, directory, 1000)).resolves.toMatchObject({ ok: true, result: { legacy: true } })
      const verifier = new DatabaseSync(paths.ownershipDatabasePath, { readOnly: true })
      expect((verifier.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3)
      verifier.close()
      expect(readFileSync(paths.ownershipDatabasePath)).toEqual(beforeBytes)
      expect(readdirSync(directory).sort()).toEqual(beforeEntries)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('rejects locator/row mismatch before opening the endpoint', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'rpc-client-mismatch-')))
    const paths = localRuntimePaths(directory, 'app')
    const store = new RuntimeOwnershipStore(paths.ownershipDatabasePath)
    const endpoint = paths.socketPath
    const ownerId = '99999999-9999-4999-8999-999999999999'
    const active = store.activate(store.prepareClaim({ kind: 'donwells-app', ownerId, identity: { ...identity, generation: ownerId + ':1' }, endpoint, authToken: 'row-token-123456' }, store.observe('donwells-app'), null), 'e'.repeat(64))
    const mismatchedLocator = { version: 2 as const, ownerId: active.ownerId, ownerGeneration: active.generation, socketPath: endpoint, authToken: 'wrong-token-123456', processIdentity: active.identity }
        writeRuntimeRecord(paths.runtimeFile, mismatchedLocator)
        store.republishActive(active, 'e'.repeat(64), createHash('sha256').update(JSON.stringify(mismatchedLocator)).digest('hex'))
    let connections = 0
    const server = createServer(() => { connections += 1 })
    try {
      await listen(server, endpoint)
      expect(() => callRuntime('worktree.list', {}, directory, 1000)).toThrowError(expect.objectContaining({ code: 'OWNER_MISMATCH' }))
      expect(connections).toBe(0)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('refuses a reachable legacy locator when an active authority row exists', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'rpc-client-legacy-mismatch-')))
    const paths = localRuntimePaths(directory, 'app')
    const endpoint = paths.socketPath
    const token = 'legacy-cli-mismatch-token-123456'
    const store = new RuntimeOwnershipStore(paths.ownershipDatabasePath)
    const ownerId = '99999999-9999-4999-8999-999999999999'
    const prepared = store.prepareClaim({
      kind: 'donwells-app',
      ownerId,
      identity: { ...identity, generation: ownerId + ':1' },
      endpoint: join(directory, 'authoritative.sock'),
      authToken: 'authoritative-cli-token-123456'
    }, store.observe('donwells-app'), null)
    store.activate(prepared, 'a'.repeat(64))
    writeFileSync(paths.runtimeFile, JSON.stringify({ socketPath: endpoint, authToken: token }), { mode: 0o600 })
    let connections = 0
    const server = createServer(socket => {
      connections += 1
      let buffer = ''
      socket.setEncoding('utf8')
      socket.on('data', chunk => {
        buffer += chunk
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const message = JSON.parse(buffer.slice(0, newline)) as { id: string; method: string; authToken?: string }
          buffer = buffer.slice(newline + 1)
          socket.write(JSON.stringify(message.method === 'auth.hello'
            ? { id: message.id, ok: message.authToken === token, version: 'rpc-v1' }
            : { id: message.id, ok: true, result: { unsafe: true } }) + '\n')
        }
      })
    })
    try {
      await listen(server, endpoint)
      expect(() => callRuntime('state.get', {}, directory, 250)).toThrowError(expect.objectContaining({ code: 'OWNER_MISMATCH' }))
      expect(connections).toBe(0)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
