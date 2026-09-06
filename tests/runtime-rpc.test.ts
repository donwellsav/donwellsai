import { createConnection } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RuntimeRpcServer, type RpcDeps } from '../src/main/runtime-rpc'

function dependencies(directory: string): RpcDeps {
  return {
    store: undefined,
    git: undefined,
    terminals: undefined,
    meta: async () => ({ version: 'test', shell: '/bin/sh', userDataDir: directory }),
    onChanged: () => {},
    onSettingsChanged: () => {},
    browser: { command: async () => ({}) },
    ui: { command: async () => ({}) }
  } as unknown as RpcDeps
}

async function request(socketPath: string, token: string, method: string, params: unknown): Promise<Record<string, unknown>> {
  const result = Promise.withResolvers<Record<string, unknown>>()
  const socket = createConnection(socketPath)
  socket.setEncoding('utf8')
  let buffer = ''
  socket.on('error', result.reject)
  socket.on('close', () => result.reject(new Error('RPC disconnected before replying')))
  socket.on('data', (chunk) => {
    buffer += chunk
    let newline: number
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const reply = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>
      buffer = buffer.slice(newline + 1)
      if (reply.id === 'request') result.resolve(reply)
    }
  })
  socket.on('connect', () => {
    socket.write(JSON.stringify({ id: 'auth', method: 'auth.hello', authToken: token }) + '\n')
    socket.write(JSON.stringify({ id: 'request', method, params }) + '\n')
  })
  try { return await result.promise } finally { socket.destroy() }
}

describe('local RPC authority', () => {
  it('refuses a live owner without stealing its endpoint or discovery token', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'donwells-rpc-owner-'))
    const socketPath = join(directory, 'runtime.sock')
    const runtimeFile = join(directory, 'runtime.json')
    const owner = new RuntimeRpcServer(socketPath, runtimeFile, 'owner', dependencies(directory))
    const contender = new RuntimeRpcServer(socketPath, runtimeFile, 'contender', dependencies(directory))
    try {
      await owner.start()
      const discovery = readFileSync(runtimeFile, 'utf8')
      await expect(contender.start()).rejects.toThrow()
      expect(readFileSync(runtimeFile, 'utf8')).toBe(discovery)
      expect(await request(socketPath, 'owner', 'meta.get', {})).toMatchObject({ ok: true })
    } finally {
      contender.stop()
      owner.stop()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects undeclared parameters instead of silently accepting a mistyped command', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'donwells-rpc-arguments-'))
    const socketPath = join(directory, 'runtime.sock')
    const server = new RuntimeRpcServer(socketPath, join(directory, 'runtime.json'), 'token', dependencies(directory))
    try {
      await server.start()
      expect(await request(socketPath, 'token', 'meta.get', { unexpected: true })).toMatchObject({
        ok: false, code: 'INVALID_ARGUMENTS'
      })
    } finally {
      server.stop()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('routes guarded domain inputs through their native service contracts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'donwells-rpc-domains-'))
    const socketPath = join(directory, 'runtime.sock')
    const observed: Record<string, unknown> = {}
    const deps = {
      store: {
        resetSettings: (value: unknown) => { observed.settingsReset = value; return { theme: 'system' } }
      },
      git: {
        listWorkspaceDirectory: async (_path: string, value: unknown) => { observed.fileList = value; return value },
        writeFile: async (...args: unknown[]) => { observed.fileWrite = args; return { revision: 'next' } }
      },
      terminals: undefined,
      agents: {
        listAgents: () => [{ id: 'codex', available: true }]
      },
      deliverAgentAttachment: async (value: unknown) => { observed.delivery = value; return { submitted: false } },
      skills: {
        prepare: async (value: unknown) => { observed.skillPrepare = value; return value }
      },
      runs: {
        scheduledRunSave: async (value: unknown) => { observed.scheduledSave = value; return value },
        scheduledRunCancel: async (executionId: string) => { observed.scheduledCancel = executionId; return { executionId } },
        parallelRunCancel: async (id: string) => { observed.parallelCancel = id; return { id } }
      },
      projectTools: {
        list: async (workspacePath: string) => { observed.toolList = workspacePath; return [] },
        start: async (...args: unknown[]) => { observed.toolStart = args; return { status: 'ready' } },
        stop: async (...args: unknown[]) => { observed.toolStop = args },
        call: async (...args: unknown[]) => { observed.toolCall = args; return { content: [] } }
      },
      browserHistory: {
        list: () => [{ url: 'https://example.test/' }]
      },
      diffReview: {
        list: async (value: unknown) => { observed.diffList = value; return { target: value, notes: [] } }
      },
      meta: async () => ({ version: 'test', shell: '/bin/sh', userDataDir: directory }),
      onChanged: () => {},
      onSettingsChanged: (value: unknown) => { observed.settingsChanged = value },
      browser: { command: async () => ({}) },
      ui: { command: async () => ({}) }
    } as unknown as RpcDeps
    const server = new RuntimeRpcServer(socketPath, join(directory, 'runtime.json'), 'token', deps)
    try {
      await server.start()
      expect(await request(socketPath, 'token', 'tool.list', { workspacePath: directory })).toMatchObject({ ok: true, result: [] })
      expect(await request(socketPath, 'token', 'tool.start', { workspacePath: directory, id: 'fixture', program: '/bin/sh' })).toMatchObject({ ok: false, code: 'INVALID_ARGUMENTS' })
      expect(await request(socketPath, 'token', 'tool.call', { workspacePath: directory, id: 'fixture', operation: 'search', arguments: { query: 'hello' } })).toMatchObject({ ok: true })
      expect(observed.toolCall).toEqual([directory, 'fixture', 'search', { query: 'hello' }])

      expect(await request(socketPath, 'token', 'file.list', { workspacePath: directory })).toMatchObject({ ok: true })
      expect(observed.fileList).toEqual({ directory: '', showHidden: false, includeIgnored: false })

      expect(await request(socketPath, 'token', 'file.write', {
        workspacePath: directory, relPath: 'a.txt', content: 'next'
      })).toMatchObject({ ok: false, code: 'INVALID_ARGUMENTS' })
      expect(await request(socketPath, 'token', 'file.write', {
        workspacePath: directory, relPath: 'a.txt', content: '', expectedRevision: 'revision-1'
      })).toMatchObject({ ok: true })
      expect(observed.fileWrite).toEqual([directory, 'a.txt', '', 'revision-1'])

      expect(await request(socketPath, 'token', 'settings.reset', { keys: ['theme', 'theme'] })).toMatchObject({ ok: true })
      expect(observed.settingsReset).toEqual({ keys: ['theme'] })
      expect(observed.settingsChanged).toEqual({ theme: 'system' })

      const delivery = {
        sessionId: 'agent-1',
        workspacePath: directory,
        kind: 'diff-review',
        title: 'Review',
        text: 'Please inspect this.',
        submit: false,
        confirmed: true
      }
      expect(await request(socketPath, 'token', 'agent.deliver', { ...delivery, confirmed: false })).toMatchObject({
        ok: false, code: 'INVALID_ARGUMENTS'
      })
      expect(await request(socketPath, 'token', 'agent.deliver', delivery)).toMatchObject({ ok: true })
      expect(observed.delivery).toEqual({
        sessionId: 'agent-1',
        attachment: {
          kind: 'diff-review', workspacePath: directory, title: 'Review', text: 'Please inspect this.'
        },
        submit: false
      })
      expect(await request(socketPath, 'token', 'agent.providers', {})).toMatchObject({
        ok: true, result: { providers: [{ id: 'codex', available: true }] }
      })

      expect(await request(socketPath, 'token', 'skill.prepare', {
        workspacePath: directory,
        providerId: 'codex',
        localSource: directory
      })).toMatchObject({ ok: true })
      expect(observed.skillPrepare).toEqual({
        workspacePath: directory,
        providerId: 'codex',
        source: { kind: 'local', path: directory }
      })

      const scheduledInput = {
        name: 'Audit',
        target: { kind: 'local', root: directory, label: 'workspace' },
        command: 'echo ok',
        schedule: { kind: 'interval', minutes: 5 }
      }
      expect(await request(socketPath, 'token', 'scheduled.save', { input: scheduledInput })).toMatchObject({ ok: true })
      expect(observed.scheduledSave).toEqual(scheduledInput)
      expect(await request(socketPath, 'token', 'scheduled.save', { input: { name: 'incomplete' } })).toMatchObject({
        ok: false, code: 'INVALID_ARGUMENTS'
      })
      expect(await request(socketPath, 'token', 'scheduled.cancel', { executionId: 'scheduled-execution' })).toMatchObject({ ok: true })
      expect(observed.scheduledCancel).toBe('scheduled-execution')
      expect(await request(socketPath, 'token', 'parallel.cancel', { id: 'parallel-run' })).toMatchObject({ ok: true })
      expect(observed.parallelCancel).toBe('parallel-run')

      expect(await request(socketPath, 'token', 'diffReview.list', {
        workspacePath: directory, filePath: '/escape.ts', comparison: 'working'
      })).toMatchObject({ ok: false, code: 'INVALID_ARGUMENTS' })
      expect(await request(socketPath, 'token', 'diffReview.list', {
        workspacePath: directory, filePath: 'src/a.ts', comparison: 'working'
      })).toMatchObject({ ok: true })
      expect(observed.diffList).toEqual({ workspacePath: directory, filePath: 'src/a.ts', comparison: 'working' })

      expect(await request(socketPath, 'token', 'browser.history.list', {})).toMatchObject({
        ok: true, result: { entries: [{ url: 'https://example.test/' }] }
      })
    } finally {
      server.stop()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('returns a bounded structured error instead of writing an oversized reply', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'donwells-rpc-reply-limit-'))
    const socketPath = join(directory, 'runtime.sock')
    const deps = dependencies(directory)
    deps.meta = async () => ({
      version: 'x'.repeat(8 * 1024 * 1024), shell: '/bin/sh', userDataDir: directory
    })
    const server = new RuntimeRpcServer(socketPath, join(directory, 'runtime.json'), 'token', deps)
    try {
      await server.start()
      expect(await request(socketPath, 'token', 'meta.get', {})).toEqual({
        id: 'request',
        ok: false,
        code: 'RESPONSE_TOO_LARGE',
        error: 'Runtime result exceeds the 8 MiB response limit'
      })
    } finally {
      server.stop()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
