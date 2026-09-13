// @vitest-environment node
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { localRuntimePaths } from './local-runtime'
import { DaemonClient, type DaemonEvents } from './daemon-client'

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
})
