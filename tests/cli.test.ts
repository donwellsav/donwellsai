import { createServer, type Server, type Socket } from 'node:net'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseCliArguments } from '../src/cli/arguments'
import { callRuntime } from '../src/cli/rpc-client'
import { validateCommandParams } from '../src/shared/command-catalog'

type DisposableRuntime = {
  directory: string
  server: Server
  socketPath: string
  token: string
}

const runtimes: DisposableRuntime[] = []

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(({ directory, server }) => new Promise<void>((done) => {
    server.close(() => {
      rmSync(directory, { recursive: true, force: true })
      done()
    })
  })))
})

async function disposableRuntime(onConnection: (socket: Socket) => void): Promise<DisposableRuntime> {
  const directory = mkdtempSync(join(tmpdir(), 'donwells-cli-'))
  const socketPath = join(directory, 'runtime.sock')
  const token = 'disposable-runtime-token'
  const server = createServer(onConnection)
  await new Promise<void>((done, reject) => {
    server.once('error', reject)
    server.listen(socketPath, done)
  })
  const runtimeFile = join(directory, 'donwells-runtime.json')
  writeFileSync(runtimeFile, JSON.stringify({ socketPath, authToken: token, pid: process.pid }), { mode: 0o600 })
  if (process.platform !== 'win32') chmodSync(runtimeFile, 0o600)
  const runtime = { directory, server, socketPath, token }
  runtimes.push(runtime)
  return runtime
}

function authenticatedHandler(onRequest: (socket: Socket, message: Record<string, unknown>) => void): (socket: Socket) => void {
  return (socket) => {
    let buffer = ''
    let authenticated = false
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        const message = JSON.parse(line) as Record<string, unknown>
        if (!authenticated) {
          authenticated = true
          socket.write(`${JSON.stringify({ id: message.id, ok: true, version: 'rpc-v1' })}\n`)
        } else {
          onRequest(socket, message)
        }
      }
    })
  }
}

describe('CLI argument contract', () => {
  it('preserves caller-relative paths, Windows paths, trailing lists, empty content, and literal separators', () => {
    expect(parseCliArguments(['file-create', 'workspace', 'empty.txt', '--content=']).params).toEqual({
      workspacePath: resolve('workspace'),
      path: 'empty.txt',
      content: ''
    })
    expect(parseCliArguments(['file-list', 'C:\\repo']).params.workspacePath).toBe('C:\\repo')
    expect(parseCliArguments(['file-list', '\\\\server\\share']).params.workspacePath).toBe('\\\\server\\share')
    expect(parseCliArguments(['git-stage', '.', '--', 'src/a.ts', '--literal-name']).params).toEqual({
      worktreePath: resolve('.'),
      paths: ['src/a.ts', '--literal-name']
    })
  })

  it('rejects duplicate or unknown arguments and validates settings against the shared schema', () => {
    expect(() => parseCliArguments(['file-list', '.', '--hidden', '--hidden'])).toThrow('Duplicate flag')
    expect(() => parseCliArguments(['settings-set', '{"theme":"dark","theme":"light"}'])).toThrow('Duplicate JSON key')
    expect(() => parseCliArguments(['settings-set', '{"notASetting":true}'])).toThrow('Unknown setting')
    expect(() => parseCliArguments(['settings-reset', '{"keys":["notASetting"]}'])).toThrow('Unknown reset key')
    expect(() => parseCliArguments(['git-status', '.', 'extra'])).toThrow('Too many arguments')
  })

  it('parses object fields, resolves only local operational roots, and requires delivery confirmation', () => {
    const scheduled = parseCliArguments([
      'scheduled-save',
      JSON.stringify({
        name: 'Local',
        target: { kind: 'local', root: '.', label: 'workspace' },
        command: 'echo ok',
        schedule: { kind: 'interval', minutes: 5 }
      })
    ])
    expect(scheduled.params.input).toMatchObject({ target: { root: resolve('.') } })

    const parallel = parseCliArguments([
      'parallel-start',
      JSON.stringify({
        name: 'Mixed',
        command: 'echo ok',
        concurrency: 2,
        targets: [
          { kind: 'local', root: 'local', label: 'local' },
          { kind: 'remote', connectionId: 'server', root: '/srv/repo', label: 'remote' }
        ]
      })
    ])
    expect(parallel.params.input).toMatchObject({
      targets: [{ root: resolve('local') }, { root: '/srv/repo' }]
    })

    expect(() => parseCliArguments([
      'agent-deliver', 'session', '.', 'diff-review', 'Review', 'Body'
    ])).toThrow('Missing parameter: confirmed')
    expect(() => parseCliArguments([
      'agent-deliver', 'session', '.', 'diff-review', 'Review', 'Body', '--confirm=false'
    ])).toThrow('requires explicit --confirm')
    expect(parseCliArguments([
      'agent-deliver', 'session', '.', 'diff-review', 'Review', 'Body', '--confirm', '--submit=false'
    ]).params).toMatchObject({ confirmed: true, submit: false })
  })

  it('accepts the Agents supervision section and rejects unknown run sections', () => {
    expect(validateCommandParams('ui.runs.open', { section: 'agents' })).toEqual({ section: 'agents' })
    expect(() => validateCommandParams('ui.runs.open', { section: 'activity' })).toThrow()
  })

  it('accepts empty optional memory tags for both create and replacement', () => {
    const params = { workspacePath: '/project', kind: 'decision', title: 'Choice', content: 'Use shared memory', tags: [], attribution: { harness: 'omp' } }
    expect(validateCommandParams('memory.create', params).tags).toEqual([])
    expect(validateCommandParams('memory.update', { ...params, id: 'entry', expectedRevision: 1 }).tags).toEqual([])
    expect(() => validateCommandParams('parallel.retry', { id: 'run', taskIds: [] })).toThrow('Invalid string list')
  })

  it('bounds nested object parameters and rejects duplicate list values', () => {
    let nested: Record<string, unknown> = {}
    for (let index = 0; index < 40; index += 1) nested = { nested }
    expect(() => validateCommandParams('scheduled.save', { input: nested })).toThrow('excessively nested')
    expect(() => validateCommandParams('parallel.retry', { id: 'run', taskIds: ['one', 'one'] })).toThrow('Duplicate value')
  })
})

describe('CLI runtime transport', () => {
  it('cancels its socket on timeout and never retries the command', async () => {
    let requests = 0
    const disconnected = Promise.withResolvers<void>()
    const runtime = await disposableRuntime(authenticatedHandler((socket) => {
      requests += 1
      socket.once('close', () => disconnected.resolve())
    }))

    await expect(callRuntime('meta.get', {}, runtime.directory, 100)).rejects.toMatchObject({ code: 'TIMEOUT' })
    await disconnected.promise
    expect(requests).toBe(1)
  })

  it('fails closed when a runtime reply exceeds the frame limit', async () => {
    const runtime = await disposableRuntime(authenticatedHandler((socket, message) => {
      socket.write(JSON.stringify({ id: message.id, ok: true, result: 'x'.repeat(8 * 1024 * 1024) }))
    }))

    await expect(callRuntime('meta.get', {}, runtime.directory, 2_000)).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE'
    })
  })

  it('rejects oversized requests before opening the runtime endpoint', async () => {
    const runtime = await disposableRuntime(() => {
      throw new Error('oversized request must not connect')
    })
    let failure: unknown
    try {
      void callRuntime('settings.set', { value: 'x'.repeat(8 * 1024 * 1024) }, runtime.directory, 2_000)
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ code: 'REQUEST_TOO_LARGE' })
  })
})
