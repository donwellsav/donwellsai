// @vitest-environment node
import { mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RuntimeOwner } from '@shared/runtime-ownership'
import { DaemonClient } from './daemon-client'
import { localRuntimePaths, readRuntimeRecord } from './local-runtime'
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
})
