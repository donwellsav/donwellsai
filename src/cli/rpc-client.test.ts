// @vitest-environment node
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:net'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
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
})
