import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import { emitAgentHook, hookDetailFromProviderPayload } from '../src/main/agent-hook'

const directories: string[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    const closed = Promise.withResolvers<void>()
    server.close(() => closed.resolve())
    await closed.promise
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('agent hook emitter', () => {
  it('authenticates before emitting the bounded lifecycle event', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'donwells-hook-emitter-'))
    directories.push(directory)
    const socketPath = join(directory, 'hook.sock')
    const received: Array<Record<string, unknown>> = []
    const server = createServer((socket) => {
      const decoder = new StringDecoder('utf8')
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += decoder.write(chunk)
        let newline: number
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          if (!line.trim()) continue
          const message: Record<string, unknown> = JSON.parse(line)
          received.push(message)
          socket.write(`${JSON.stringify({ id: message['id'], ok: true, capabilities: ['agent-hook-events-v1'] })}\n`)
        }
      })
    })
    servers.push(server)
    const listening = Promise.withResolvers<void>()
    server.listen(socketPath, () => listening.resolve())
    await listening.promise

    await emitAgentHook({
      socketPath,
      runId: 'run-bound',
      sessionId: 'session-bound',
      token: 'least-authority-token',
      message: { kind: 'permission', detail: 'Approve tool ✓' }
    })

    expect(received).toEqual([
      expect.objectContaining({
        op: 'hook.hello',
        runId: 'run-bound',
        sessionId: 'session-bound',
        hookToken: 'least-authority-token'
      }),
      expect.objectContaining({ op: 'hook.emit', kind: 'permission', detail: 'Approve tool ✓' })
    ])
  })

  it('forwards lifecycle labels without disclosing prompts or tool input', () => {
    expect(hookDetailFromProviderPayload({
      tool_name: 'Shell',
      prompt: 'private user prompt',
      tool_input: { command: 'private command' }
    })).toBe('Shell')
    expect(hookDetailFromProviderPayload({
      prompt: 'private user prompt',
      tool_input: { command: 'private command' }
    })).toBeUndefined()
  })
})
