import { afterEach, expect, it } from 'vitest'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { emitAgentHook } from '../src/main/agent-hook'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function channel(response: unknown) {
  const directory = mkdtempSync(join(tmpdir(), 'donwells-capabilities-'))
  const path = join(directory, 'hook.sock'), received: string[] = []
  const server = createServer(socket => {
    let buffer = ''
    socket.on('data', bytes => {
      buffer += bytes.toString()
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
        received.push(request.op)
        if (response === 'disconnect') { socket.destroy(); return }
        socket.write(JSON.stringify(response === null ? null : { id: request.id, ok: true, ...(request.op === 'hook.hello' ? { capabilities: response } : {}) }) + '\n')
      }
    })
  })
  await new Promise<void>(resolve => server.listen(path, resolve))
  cleanups.push(async () => { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true }) })
  return { received, emit: () => emitAgentHook({ socketPath: path, runId: 'run', sessionId: 'session', token: 'fixture', message: { kind: 'permission' } }) }
}

it.each([undefined, [], ['agent-hook-events-v2'], 'agent-hook-events-v1', null])('does not send a status operation without a valid negotiated capability: %j', async value => {
  const test = await channel(value)
  await expect(test.emit()).rejects.toThrow(/capability|invalid/)
  expect(test.received).toEqual(['hook.hello'])
})

it('accepts partial supported capabilities and renegotiates on every connection', async () => {
  const test = await channel(['future-unrelated-capability', 'agent-hook-events-v1'])
  await test.emit(); await test.emit()
  expect(test.received).toEqual(['hook.hello', 'hook.emit', 'hook.hello', 'hook.emit'])
})

it('rejects a disconnected negotiation without replaying the permission event', async () => {
  const test = await channel('disconnect')
  await expect(test.emit()).rejects.toThrow()
  expect(test.received).toEqual(['hook.hello'])
})
