import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server, type Socket } from 'node:net'
import { DaemonClient, type DaemonEvents } from '../src/main/daemon-client'
import { localRuntimePaths } from '../src/main/local-runtime'

const directories: string[] = []
const servers: Server[] = []
const sockets = new Set<Socket>()

afterEach(() => {
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  for (const server of servers.splice(0)) server.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function fakeDaemon(
  onMessage: (socket: Socket, message: Record<string, unknown>) => void
): Promise<{ userData: string; socketPath: string }> {
  const userData = mkdtempSync(join(tmpdir(), 'donwells-daemon-client-'))
  directories.push(userData)
  const paths = localRuntimePaths(userData, 'terminal')
  mkdirSync(paths.runtimeDir, { recursive: true })
  mkdirSync(paths.socketDir, { recursive: true })
  const socketPath = paths.socketPath
  const server = createServer((socket) => {
    sockets.add(socket)
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim()) onMessage(socket, JSON.parse(line))
      }
    })
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  writeFileSync(
    paths.runtimeFile,
    JSON.stringify({ socketPath, authToken: 'token', pid: process.pid }),
    'utf8'
  )
  return { userData, socketPath }
}

function client(userData: string, requestTimeoutMs = 100): DaemonClient {
  return new DaemonClient(
    userData,
    {
      data: () => {},
      exit: () => {},
      title: () => {},
      agent: () => {},
      agentDismissed: () => {}
    },
    join(userData, 'not-used.js'),
    { requestTimeoutMs, handshakeTimeoutMs: 100 }
  )
}

describe('DaemonClient transport lifecycle', () => {
  it('parses a fragmented hello frame and preserves normal request framing', async () => {
    const { userData } = await fakeDaemon((socket, message) => {
      if (message['op'] === 'hello') {
        const frame = JSON.stringify({
          id: message['id'],
          ok: true,
          protocolVersion: 2,
          capabilities: ['sequenced-output', 'oneshot-jobs']
        })
        socket.write(frame.slice(0, 7))
        setImmediate(() => socket.write(frame.slice(7) + '\n'))
      } else if (message['op'] === 'ping') {
        socket.write(JSON.stringify({ id: message['id'], ok: true, pong: 1 }) + '\n')
      }
    })
    const daemon = client(userData)
    await daemon.connect()
    await expect(daemon.ping()).resolves.toBe(true)
  })

  it('preserves a multibyte event split across transport chunks', async () => {
    const expectedTitle = '终端 ✓'
    const { userData } = await fakeDaemon((socket, message) => {
      if (message['op'] !== 'hello') return
      socket.write(JSON.stringify({
        id: message['id'],
        ok: true,
        protocolVersion: 3,
        capabilities: ['sequenced-output']
      }) + '\n')
      setImmediate(() => {
        const frame = Buffer.from(JSON.stringify({
          event: 'title',
          sessionId: 'utf8-session',
          title: expectedTitle
        }) + '\n')
        const split = frame.indexOf(Buffer.from('终')) + 1
        socket.write(frame.subarray(0, split))
        setImmediate(() => socket.write(frame.subarray(split)))
      })
    })
    const titleSeen = Promise.withResolvers<string>()
    const events: DaemonEvents = {
      data: () => {},
      exit: () => {},
      title: (_sessionId, title) => titleSeen.resolve(title),
      agent: () => {},
      agentDismissed: () => {}
    }
    const daemon = new DaemonClient(userData, events, join(userData, 'not-used.js'))

    await daemon.connect()
    await expect(titleSeen.promise).resolves.toBe(expectedTitle)
  })

  it('reuses an authenticated legacy runtime record that has no PID field', async () => {
    const { userData, socketPath } = await fakeDaemon((socket, message) => {
      if (message['op'] === 'hello') {
        socket.write(JSON.stringify({
          id: message['id'],
          ok: true,
          capabilities: ['sequenced-output', 'oneshot-jobs']
        }) + '\n')
      } else if (message['op'] === 'ping') {
        socket.write(JSON.stringify({ id: message['id'], ok: true }) + '\n')
      }
    })
    rmSync(localRuntimePaths(userData, 'terminal').runtimeFile)
    writeFileSync(
      join(userData, 'terminal-runtime.json'),
      JSON.stringify({ socketPath, authToken: 'token' }),
      'utf8'
    )

    await expect(client(userData).ping()).resolves.toBe(true)
  })

  it('rejects every pending request immediately when the transport closes', async () => {
    const { userData } = await fakeDaemon((socket, message) => {
      if (message['op'] === 'hello') {
        socket.write(
          JSON.stringify({ id: message['id'], ok: true, capabilities: ['sequenced-output', 'oneshot-jobs'] }) + '\n'
        )
      } else if (message['op'] === 'session.close') {
        socket.destroy()
      }
    })
    const daemon = client(userData, 2000)
    await expect(daemon.close('owned-session')).rejects.toThrow(/transport closed/)
  })

  it('times out unanswered requests instead of retaining them forever', async () => {
    const { userData } = await fakeDaemon((socket, message) => {
      if (message['op'] === 'hello') {
        socket.write(
          JSON.stringify({ id: message['id'], ok: true, capabilities: ['sequenced-output', 'oneshot-jobs'] }) + '\n'
        )
      }
    })
    const daemon = client(userData, 30)
    await expect(daemon.close('owned-session')).rejects.toThrow(/request timed out: session.close/)
  })

  it('leaves an old unsequenced daemon alive and fails capability-dependent work clearly', async () => {
    const operations: string[] = []
    const { userData } = await fakeDaemon((socket, message) => {
      operations.push(String(message['op']))
      if (message['op'] === 'hello') {
        socket.write(JSON.stringify({ id: message['id'], ok: true }) + '\n')
      }
    })
    const daemon = client(userData)
    await expect(daemon.open('/tmp')).rejects.toThrow(/upgrade required.*left running/)
    await expect(daemon.startAgent('/tmp', 'codex', 'codex')).rejects.toThrow(/upgrade required.*left running/)
    await expect(daemon.startAgent('/tmp', 'codex', 'codex', { executable: '/bin/codex', args: [] })).rejects.toThrow(/upgrade required.*left running/)
    await expect(daemon.writeAgent('owned-session', 'payload')).rejects.toThrow(/upgrade required.*left running/)
    await expect(daemon.attentionInboxList()).resolves.toEqual({
      available: false,
      reason: 'daemon-upgrade-required'
    })
    await expect(daemon.attentionInboxAcknowledge({ eventId: 'event-1', eventVersion: 1 })).resolves.toEqual({
      available: false,
      reason: 'daemon-upgrade-required'
    })
    expect(operations).toEqual(['hello'])
    expect([...sockets].every((socket) => !socket.destroyed)).toBe(true)
  })

  it('does not replace a live recorded daemon when its socket is missing', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'donwells-daemon-client-lost-'))
    directories.push(userData)
    const paths = localRuntimePaths(userData, 'terminal')
    mkdirSync(paths.runtimeDir, { recursive: true })
    writeFileSync(paths.runtimeFile, JSON.stringify({
      socketPath: paths.socketPath,
      authToken: 'lost-token',
      pid: process.pid
    }))

    await expect(client(userData).connect()).rejects.toThrow(/live after contact was lost; it was not replaced/)
  })

  it('refuses idle cleanup when the authenticated daemon reports owned sessions', async () => {
    const operations: string[] = []
    const { userData } = await fakeDaemon((socket, message) => {
      operations.push(String(message['op']))
      if (message['op'] === 'hello') {
        socket.write(JSON.stringify({
          id: message['id'],
          ok: true,
          capabilities: ['daemon-status', 'idle-shutdown']
        }) + '\n')
      } else if (message['op'] === 'daemon.status') {
        socket.write(JSON.stringify({
          id: message['id'],
          ok: true,
          pid: process.pid,
          idle: false,
          sessionCount: 1,
          liveSessionCount: 1
        }) + '\n')
      }
    })
    await expect(client(userData).shutdownIfIdle()).resolves.toBe(false)
    expect(operations).toEqual(['hello', 'daemon.status'])
  })
})
