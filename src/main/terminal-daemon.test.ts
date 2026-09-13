// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DaemonClient } from './daemon-client'
import { localRuntimePaths, readRuntimeRecord } from './local-runtime'
import { TerminalDaemon } from './terminal-daemon'
type DaemonLifecycleProbe = { activePublication: () => unknown }
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

describe('terminal runtime identity lifecycle', () => {
  it('does not resolve a preparing owner and publishes exact identity in hello', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'terminal-identity-'))
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
    const directory = mkdtempSync(join(tmpdir(), 'terminal-client-identity-'))
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
})
