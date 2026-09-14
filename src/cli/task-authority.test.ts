// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProcessIdentity } from '@shared/child-process/process-spec'
import { RuntimeOwnershipStore } from '@shared/runtime-ownership'
import { localRuntimePaths, writeRuntimeRecord, type LocalRuntimeRecord } from '../main/local-runtime'
import { runCli } from './index'

const identity: ProcessIdentity = {
  pid: process.pid,
  bootId: 'boot-task-cli',
  startedAt: 'birth-task-cli',
  executablePath: process.execPath,
  family: 'terminal-daemon',
  capturedAt: '2026-09-13T00:00:00.000Z'
}

const OWNER_ID = '99999999-9999-4999-8999-999999999999'
const SPECIFICATION = JSON.stringify({
  command: { program: 'node', args: ['run.js'] },
  target: { kind: 'local', root: '/repo', label: 'repo' },
  verification: { requiredArtifacts: [] }
})

const directories: string[] = []
const servers: Server[] = []

function tempDirectory(): string {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'task-authority-cli-')))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()!
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  while (directories.length > 0) rmSync(directories.pop() as string, { recursive: true, force: true })
})

async function listen(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, resolve)
  })
}

type FakeTaskDaemon = {
  server: Server
  credentials: Map<string, { token: string; connectionKey: string; projectIds: string[] }>
  restart: () => void
  lastClaimCredentials: Array<unknown>
}

function startFakeTaskDaemon(endpoint: string, token: string): FakeTaskDaemon {
  const credentials = new Map<string, { token: string; connectionKey: string; projectIds: string[] }>()
  const lastClaimCredentials: Array<unknown> = []
  const server = createServer((socket: Socket) => {
    const connectionKey = randomUUID()
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue
        const message = JSON.parse(line) as Record<string, unknown>
        const id = String(message['id'] ?? '')
        if (message['op'] === 'hello') {
          const ok = message['authToken'] === token
          socket.write(JSON.stringify(ok
            ? { id, ok: true, protocolVersion: 3, runtimeIdentityContractVersion: 1, capabilities: ['task-authority-v1'], ownerId: OWNER_ID, generation: 1, processIdentity: identity }
            : { id, ok: false }) + '\n')
          continue
        }
        const reply = (payload: Record<string, unknown>): void => socket.write(JSON.stringify({ id, ...payload }) + '\n')
        const bindWorker = (): { credentialId: string } | { error: string; code: string } => {
          const rawCredential = message['credential']
          if (typeof rawCredential !== 'object' || rawCredential === null) return { error: 'a daemon-issued task worker credential is required', code: 'AUTHORIZATION_DENIED' }
          const credential = rawCredential as Record<string, unknown>
          const credentialId = String(credential['credentialId'] ?? '')
          const supplied = String(credential['token'] ?? '')
          const binding = credentials.get(credentialId)
          if (!binding || binding.token !== supplied) return { error: 'task worker credential is missing, stale, or invalid', code: 'AUTHORIZATION_DENIED' }
          if (binding.connectionKey !== connectionKey) return { error: 'task worker credential belongs to a different authenticated session', code: 'AUTHORIZATION_DENIED' }
          const projectId = String(message['projectId'] ?? (message['token'] as Record<string, unknown> | undefined)?.['projectId'] ?? '')
          if (!binding.projectIds.includes(projectId)) return { error: 'task worker credential is not authorized for this project', code: 'PROJECT_SCOPE_MISMATCH' }
          return { credentialId }
        }
        if (message['op'] === 'task.credential.issue') {
          const credentialId = randomUUID()
          credentials.set(credentialId, { token: 'worker-' + randomUUID(), connectionKey, projectIds: [String(message['projectId'])] })
          const binding = credentials.get(credentialId)!
          reply({ ok: true, credential: { credentialId, ownerId: randomUUID(), token: binding.token } })
          continue
        }
        if (message['op'] === 'task.claim') {
          lastClaimCredentials.push(message['credential'] ?? null)
          const bound = bindWorker()
          if ('error' in bound) { reply({ ok: false, error: bound.error, code: bound.code }); continue }
          reply({
            ok: true,
            task: { projectId: 'project-cli', taskId: randomUUID(), externalTaskId: message['externalTaskId'] ?? 'none', title: 'task', body: '', status: 'in-progress', priority: 0, dependencies: [], dependencyBlocked: false, runnable: false, cancelState: 'none', currentAttempt: null, entityVersion: 2, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
            attempt: { projectId: 'project-cli', taskId: randomUUID(), attemptId: randomUUID(), sequence: 1, retryOfAttemptId: null, provenance: 'native', state: 'claimed', specificationId: randomUUID(), currentLease: null, runtime: null, reservation: null, lastProgress: null, startedAt: new Date().toISOString(), finishedAt: null },
            token: { projectId: 'project-cli', taskId: randomUUID(), attemptId: randomUUID(), ownerId: randomUUID(), leaseId: randomUUID(), generation: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() }
          })
          continue
        }
        if (message['op'] === 'task.write') {
          const bound = bindWorker()
          if ('error' in bound) { reply({ ok: false, error: bound.error, code: bound.code }); continue }
          reply({ ok: true, task: { projectId: 'project-cli', taskId: randomUUID(), externalTaskId: 'none', title: 'task', body: '', status: 'in-progress', priority: 0, dependencies: [], dependencyBlocked: false, runnable: false, cancelState: 'none', currentAttempt: null, entityVersion: 3, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } })
          continue
        }
        if (message['op'] === 'task.create') {
          if (message['credential'] !== undefined) { reply({ ok: false, error: 'administrator task commands do not accept a worker credential', code: 'AUTHORIZATION_DENIED' }); continue }
          reply({ ok: true, task: { projectId: String(message['projectId']), taskId: randomUUID(), externalTaskId: String(message['externalTaskId']), title: String(message['title']), body: '', status: 'todo', priority: 0, dependencies: [], dependencyBlocked: false, runnable: true, cancelState: 'none', currentAttempt: null, entityVersion: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } })
          continue
        }
        reply({ ok: false, error: `unknown op: ${String(message['op'])}`, code: 'COMMAND_FAILED' })
      }
    })
  })
  servers.push(server)
  return { server, credentials, restart: () => credentials.clear(), lastClaimCredentials }
}

async function prepareTerminalRuntime(directory: string): Promise<{ endpoint: string; token: string }> {
  const paths = localRuntimePaths(directory, 'terminal')
  mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 })
  const store = new RuntimeOwnershipStore(paths.ownershipDatabasePath)
  const endpoint = paths.socketPath
  const token = 'task-cli-daemon-token-123456'
  const candidate = {
    kind: 'terminal-daemon' as const,
    ownerId: OWNER_ID,
    identity: { ...identity, generation: OWNER_ID + ':1' },
    endpoint,
    authToken: token
  }
  const active = store.activate(store.prepareClaim(candidate, store.observe('terminal-daemon'), null), createHash('sha256').update(JSON.stringify(candidate)).digest('hex').slice(0, 64))
  const locator: LocalRuntimeRecord = { version: 2, ownerId: active.ownerId, ownerGeneration: active.generation, socketPath: endpoint, authToken: token, processIdentity: active.identity }
  writeRuntimeRecord(paths.runtimeFile, locator)
  store.republishActive(active, createHash('sha256').update(JSON.stringify(candidate)).digest('hex').slice(0, 64), createHash('sha256').update(JSON.stringify(locator)).digest('hex'))
  store.close()
  return { endpoint, token }
}

async function runCliCaptured(argv: string[]): Promise<{ code: number; json: Record<string, unknown> }> {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '))
  let code = 0
  try {
    code = await runCli(argv)
  } finally {
    console.log = original
  }
  return { code, json: JSON.parse(lines.join('\n')) as Record<string, unknown> }
}

async function issueCredential(userData: string): Promise<{ credentialId: string; ownerId: string; token: string }> {
  const { code, json } = await runCliCaptured(['task.credential.issue', '--project', 'project-cli', '--user-data', userData])
  expect(code).toBe(0)
  return (json['result'] as Record<string, unknown>)['credential'] as { credentialId: string; ownerId: string; token: string }
}

describe('CLI task authority credentials', () => {
  it('auto-issues a same-session credential for worker commands without --credential', async () => {
    const directory = tempDirectory()
    const { endpoint, token } = await prepareTerminalRuntime(directory)
    const fake = startFakeTaskDaemon(endpoint, token)
    await listen(fake.server, endpoint)
    const { code, json } = await runCliCaptured(['task.claim', '--project', 'project-cli', '--external-id', 'DW-1', '--specification', SPECIFICATION, '--user-data', directory])
    expect(code).toBe(0)
    expect((json['result'] as Record<string, unknown>)['token']).toBeDefined()
    expect(fake.lastClaimCredentials[0]).not.toBeNull()
  })

  it('rejects a missing (never-issued) worker credential', async () => {
    const directory = tempDirectory()
    const { endpoint, token } = await prepareTerminalRuntime(directory)
    const fake = startFakeTaskDaemon(endpoint, token)
    await listen(fake.server, endpoint)
    const bogus = { credentialId: randomUUID(), token: 'worker-never-issued' }
    const { code, json } = await runCliCaptured(['task.claim', '--project', 'project-cli', '--external-id', 'DW-2', '--specification', SPECIFICATION, '--credential', JSON.stringify(bogus), '--user-data', directory])
    expect(code).toBe(1)
    expect(json['code']).toBe('AUTHORIZATION_DENIED')
    expect(String(json['error'])).toMatch(/missing, stale, or invalid/)
  })

  it('rejects a credential from a different authenticated session', async () => {
    const directory = tempDirectory()
    const { endpoint, token } = await prepareTerminalRuntime(directory)
    const fake = startFakeTaskDaemon(endpoint, token)
    await listen(fake.server, endpoint)
    const issued = await issueCredential(directory)
    const { code, json } = await runCliCaptured(['task.claim', '--project', 'project-cli', '--external-id', 'DW-3', '--specification', SPECIFICATION, '--credential', JSON.stringify(issued), '--user-data', directory])
    expect(code).toBe(1)
    expect(json['code']).toBe('AUTHORIZATION_DENIED')
    expect(String(json['error'])).toMatch(/different authenticated session/)
  })

  it('rejects a stale credential after the daemon restarts and clears its registry', async () => {
    const directory = tempDirectory()
    const { endpoint, token } = await prepareTerminalRuntime(directory)
    const fake = startFakeTaskDaemon(endpoint, token)
    await listen(fake.server, endpoint)
    const issued = await issueCredential(directory)
    fake.restart()
    const { code, json } = await runCliCaptured(['task.claim', '--project', 'project-cli', '--external-id', 'DW-4', '--specification', SPECIFICATION, '--credential', JSON.stringify(issued), '--user-data', directory])
    expect(code).toBe(1)
    expect(json['code']).toBe('AUTHORIZATION_DENIED')
    expect(String(json['error'])).toMatch(/missing, stale, or invalid/)
  })

  it('rejects a worker credential presented on an administrator command', async () => {
    const directory = tempDirectory()
    const { endpoint, token } = await prepareTerminalRuntime(directory)
    const fake = startFakeTaskDaemon(endpoint, token)
    await listen(fake.server, endpoint)
    const issued = await issueCredential(directory)
    const { code, json } = await runCliCaptured(['task.create', '--project', 'project-cli', '--external-id', 'DW-5', '--title', 'task', '--credential', JSON.stringify(issued), '--user-data', directory])
    expect(code).toBe(1)
    expect(json['code']).toBe('AUTHORIZATION_DENIED')
    expect(String(json['error'])).toMatch(/administrator task commands do not accept/)
  })
})
