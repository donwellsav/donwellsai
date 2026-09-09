import { createConnection } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/shared/settings'
import { RuntimeRpcServer, type RpcDeps } from '../src/main/runtime-rpc'
import type { BrowserCommand, BrowserSnapshot, UiCommand } from '../src/shared/types'

describe('runtime RPC command routing', () => {
  it('browser.open acknowledges the snapshot returned by its exact completed open command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'donwells-browser-rpc-'))
    const socketPath = join(dir, 'runtime.sock')
    const runtimeFile = join(dir, 'runtime.json')
    const token = 'browser-test-token'
    const commands: BrowserCommand[] = []
    const loaded: BrowserSnapshot = {
      key: '/worktrees/two',
      url: 'https://two.test/target',
      title: 'Exact target',
      text: 'loaded target body'
    }
    const stale: BrowserSnapshot = {
      key: '/worktrees/two',
      url: 'https://stale.test/',
      title: 'Stale page',
      text: 'wrong document'
    }
    const deps = {
      store: { getSettings: () => DEFAULT_SETTINGS },
      git: undefined,
      terminals: undefined,
      meta: async () => ({ version: 'test', shell: '/bin/sh', userDataDir: dir }),
      onChanged: () => {},
      onSettingsChanged: () => {},
      browser: {
        command: async (command: BrowserCommand) => {
          commands.push(command)
          return command.op === 'open' ? loaded : stale
        }
      },
      ui: { command: async () => ({}) }
    } as unknown as RpcDeps
    const server = new RuntimeRpcServer(socketPath, runtimeFile, token, deps)

    try {
      await server.start()
      const replies = Promise.withResolvers<Array<Record<string, unknown>>>()
      const socket = createConnection(socketPath)
      const received: Array<Record<string, unknown>> = []
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          if (line) received.push(JSON.parse(line) as Record<string, unknown>)
          if (received.length === 2) replies.resolve(received)
          newline = buffer.indexOf('\n')
        }
      })
      socket.on('error', replies.reject)
      socket.on('connect', () => {
        socket.write(`${JSON.stringify({ id: 'auth', method: 'auth.hello', authToken: token })}\n`)
        socket.write(`${JSON.stringify({
          id: 'open',
          method: 'browser.open',
          params: { worktreePath: '/worktrees/two', url: 'https://two.test/target' }
        })}\n`)
      })

      const response = (await replies.promise).find((reply) => reply['id'] === 'open')
      socket.destroy()

      expect(response).toEqual({ id: 'open', ok: true, result: { snapshot: loaded } })
      expect(commands).toEqual([
        { op: 'open', key: '/worktrees/two', url: 'https://two.test/target' }
      ])
    } finally {
      server.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('routes runs separately and rejects legacy run sections sent to settings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'donwells-runs-rpc-'))
    const socketPath = join(dir, 'runtime.sock')
    const runtimeFile = join(dir, 'runtime.json')
    const token = 'runs-test-token'
    const commands: UiCommand[] = []
    const deps = {
      store: { getSettings: () => DEFAULT_SETTINGS },
      git: undefined,
      terminals: undefined,
      meta: async () => ({ version: 'test', shell: '/bin/sh', userDataDir: dir }),
      onChanged: () => {},
      onSettingsChanged: () => {},
      browser: { command: async () => ({}) },
      ui: {
        command: async (command: UiCommand) => {
          commands.push(command)
          return { routed: command.op }
        }
      }
    } as unknown as RpcDeps
    const server = new RuntimeRpcServer(socketPath, runtimeFile, token, deps)

    try {
      await server.start()
      const replies = Promise.withResolvers<Array<Record<string, unknown>>>()
      const socket = createConnection(socketPath)
      const received: Array<Record<string, unknown>> = []
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          if (line) received.push(JSON.parse(line) as Record<string, unknown>)
          if (received.length === 3) replies.resolve(received)
          newline = buffer.indexOf('\n')
        }
      })
      socket.on('error', replies.reject)
      socket.on('connect', () => {
        const requests = [
          { id: 'auth', method: 'auth.hello', authToken: token },
          { id: 'runs', method: 'ui.runs.open', params: { section: 'agents' } },
          { id: 'legacy', method: 'ui.settings.open', params: { section: 'automations' } }
        ]
        socket.write(requests.map((request) => JSON.stringify(request) + '\n').join(''))
      })

      const response = await replies.promise
      socket.destroy()
      expect(response.find((reply) => reply['id'] === 'runs')).toEqual({
        id: 'runs',
        ok: true,
        result: { routed: 'runs.open' }
      })
      expect(response.find((reply) => reply['id'] === 'legacy')).toMatchObject({
        id: 'legacy',
        ok: false,
        error: expect.stringContaining('use ui.runs.open')
      })
      expect(commands).toEqual([{ op: 'runs.open', section: 'agents' }])
    } finally {
      server.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
