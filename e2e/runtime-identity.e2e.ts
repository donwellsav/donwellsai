import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { _electron as electron, expect, test } from '@playwright/test'

const ROOT = join(__dirname, '..')
const APP_ENTRY = join(ROOT, 'out/main/index.js')
const TERMINAL_ENTRY = join(ROOT, 'out/main/terminal-daemon-entry.js')
const CLI_ENTRY = join(ROOT, 'cli/donwells.mjs')

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for built runtime state')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

function locatorAt(userData: string, kind: 'app' | 'terminal'): string {
  return kind === 'app' ? join(userData, 'donwells-runtime.json') : join(userData, 'terminal-daemon', 'runtime.json')
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>(resolve => server.close(() => resolve()))
}

async function readLine(socket: Socket): Promise<Record<string, unknown>> {
  socket.setEncoding('utf8')
  let buffered = ''
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for terminal handshake')), 3_000)
    const onData = (chunk: string): void => {
      buffered += chunk
      const newline = buffered.indexOf('\n')
      if (newline < 0) return
      clearTimeout(timer)
      socket.removeListener('data', onData)
      resolve(JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>)
    }
    socket.on('data', onData)
    socket.once('error', reject)
  })
}

type BuiltRuntimeModules = {
  RuntimeOwnershipStore: new (path: string, options?: { readOnly?: boolean }) => {
    observe(kind: string): { status: string; lastGeneration?: number }
    prepareClaim(candidate: unknown, observed: unknown, stale: unknown): unknown
    activate(preparing: unknown, locatorSha256: string): unknown
    close(): void
  }
  localRuntimePaths: (userData: string, kind: 'app' | 'terminal') => {
    runtimeFile: string
    socketPath: string
    socketDir: string
    ownershipDatabasePath: string
  }
  writeRuntimeRecord: (path: string, record: unknown) => void
}

async function readBuiltRuntimeModules(): Promise<BuiltRuntimeModules> {
  // These runtime-selected imports intentionally load emitted artifacts so this suite tests built output, not source aliases.
  const ownership = await import(pathToFileURL(join(ROOT, 'dist-cli/shared/runtime-ownership.js')).href)
  const local = await import(pathToFileURL(join(ROOT, 'dist-cli/main/local-runtime.js')).href)
  return {
    RuntimeOwnershipStore: ownership.RuntimeOwnershipStore,
    localRuntimePaths: local.localRuntimePaths,
    writeRuntimeRecord: local.writeRuntimeRecord
  }
}

test('built app publishes identity, exits cleanly, and retains its locator evidence', async () => {
  const userData = realpathSync.native(mkdtempSync(join(tmpdir(), 'donwells-app-built-e2e-')))
  const runtimeFile = locatorAt(userData, 'app')
  const app = await electron.launch({
    args: [APP_ENTRY],
    cwd: ROOT,
    env: { ...process.env, DONWELLS_USER_DATA: userData, DONWELLS_LOG_LEVEL: 'error' }
  })
  try {
    await app.firstWindow()
    await waitFor(() => existsSync(runtimeFile))
    const locator = JSON.parse(readFileSync(runtimeFile, 'utf8')) as { version: number; ownerId: string; ownerGeneration: number }
    expect(locator.version).toBe(2)
    expect(locator.ownerId).toEqual(expect.any(String))
    expect(locator.ownerGeneration).toBeGreaterThan(0)
    await app.close()
    await waitFor(() => existsSync(runtimeFile))
    expect(JSON.parse(readFileSync(runtimeFile, 'utf8'))).toMatchObject(locator)
    const { RuntimeOwnershipStore } = await readBuiltRuntimeModules()
    const store = new RuntimeOwnershipStore(join(userData, 'runtime-owners.sqlite'), { readOnly: true })
    try { expect(store.observe('donwells-app').status).toBe('vacant') } finally { store.close() }
  } finally {
    await app.close().catch(() => undefined)
    rmSync(userData, { recursive: true, force: true })
  }
})

test('built terminal daemon entry publishes, handshakes, and retains evidence on stop', async () => {
  const userData = realpathSync.native(mkdtempSync(join(tmpdir(), 'donwells-terminal-built-e2e-')))
  const runtimeFile = locatorAt(userData, 'terminal')
  const child = spawn(process.execPath, [TERMINAL_ENTRY, userData], {
    cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DONWELLS_DAEMON_TOKEN: 'built-terminal-e2e-token-123456' },
    stdio: ['ignore', 'ignore', 'pipe']
  })
  child.stderr.resume()
  let socket: Socket | undefined
  try {
    await waitFor(() => existsSync(runtimeFile))
    const locator = JSON.parse(readFileSync(runtimeFile, 'utf8')) as { socketPath: string; authToken: string; ownerId: string; ownerGeneration: number }
    socket = createConnection(locator.socketPath)
    await once(socket, 'connect')
    socket.write(JSON.stringify({ id: 'hello', op: 'hello', authToken: locator.authToken }) + '\n')
    const hello = await readLine(socket)
    expect(hello).toMatchObject({ id: 'hello', ok: true, ownerId: locator.ownerId, generation: locator.ownerGeneration })
    socket.destroy()
    socket = undefined
    await stopChild(child)
    await waitFor(() => existsSync(runtimeFile))
    expect(JSON.parse(readFileSync(runtimeFile, 'utf8'))).toMatchObject(locator)
    const { RuntimeOwnershipStore } = await readBuiltRuntimeModules()
    const store = new RuntimeOwnershipStore(join(userData, 'runtime-owners.sqlite'), { readOnly: true })
    try { expect(store.observe('terminal-daemon').status).toBe('vacant') } finally { store.close() }
  } finally {
    socket?.destroy()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    rmSync(userData, { recursive: true, force: true })
  }
})

test('built ordinary CLI entry authenticates and returns an endpoint response', async () => {
  const userData = realpathSync.native(mkdtempSync(join(tmpdir(), 'donwells-cli-built-e2e-')))
  const { RuntimeOwnershipStore, localRuntimePaths, writeRuntimeRecord } = await readBuiltRuntimeModules()
  const paths = localRuntimePaths(userData, 'app')
  const ownerId = 'e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1'
  const authToken = 'ordinary-cli-built-token-123456'
  const identity = { pid: process.pid, bootId: 'cli-built-boot', startedAt: 'cli-built-start', executablePath: process.execPath, family: 'donwells-app', capturedAt: new Date().toISOString(), generation: ownerId + ':1' }
  const locator = { version: 2, ownerId, ownerGeneration: 1, socketPath: paths.socketPath, authToken, processIdentity: identity }
  const store = new RuntimeOwnershipStore(paths.ownershipDatabasePath)
  const methods: string[] = []
  let connections = 0
  const server = createServer(socket => {
    connections += 1
    socket.setEncoding('utf8')
    let buffered = ''
    socket.on('data', (chunk: string) => {
      buffered += chunk
      let newline: number
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        if (!line) continue
        const frame = JSON.parse(line) as { id: string; method: string; authToken?: string; params?: unknown }
        methods.push(frame.method)
        if (frame.method === 'auth.hello') {
          socket.write(JSON.stringify({ id: frame.id, ok: frame.authToken === authToken }) + '\n')
        } else {
          socket.write(JSON.stringify({ id: frame.id, ok: true, result: { source: 'built-ordinary-entry', panes: [] } }) + '\n')
        }
      }
    })
  })
  let child: ChildProcessWithoutNullStreams | undefined
  try {
    mkdirSync(paths.socketDir, { recursive: true, mode: 0o700 })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(paths.socketPath, resolve) })
    const preparing = store.prepareClaim({ kind: 'donwells-app', ownerId, identity, endpoint: paths.socketPath, authToken }, store.observe('donwells-app'), null)
    writeRuntimeRecord(paths.runtimeFile, locator)
    store.activate(preparing, createHash('sha256').update(JSON.stringify(locator)).digest('hex'))
    child = spawn(process.execPath, [CLI_ENTRY, 'browser-list', '--user-data', userData], {
      cwd: ROOT,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    child.stdin.end()
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const [exitCode] = await once(child, 'exit') as [number | null]
    expect(exitCode, stderr).toBe(0)
    expect(connections).toBe(1)
    expect(methods).toEqual(['auth.hello', 'browser.list'])
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, result: { source: 'built-ordinary-entry', panes: [] } })
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closeServer(server)
    store.close()
    rmSync(userData, { recursive: true, force: true })
  }
})
test('built memory MCP line protocol rejects locator/authority mismatch before endpoint connection', async () => {
  const userData = realpathSync.native(mkdtempSync(join(tmpdir(), 'donwells-memory-mcp-built-e2e-')))
  const { RuntimeOwnershipStore, localRuntimePaths, writeRuntimeRecord } = await readBuiltRuntimeModules()
  const paths = localRuntimePaths(userData, 'app')
  const store = new RuntimeOwnershipStore(paths.ownershipDatabasePath)
  const ownerId = 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0'
  const rowToken = 'authority-token-123456'
  const identity = { pid: process.pid, bootId: 'mcp-built-boot', startedAt: 'mcp-built-start', executablePath: process.execPath, family: 'donwells-app', capturedAt: new Date().toISOString(), generation: ownerId + ':1' }
  const candidate = { kind: 'donwells-app', ownerId, identity, endpoint: paths.socketPath, authToken: rowToken }
  const preparing = store.prepareClaim(candidate, store.observe('donwells-app'), null)
  const locator = { version: 2, ownerId, ownerGeneration: 1, socketPath: paths.socketPath, authToken: 'wrong-locator-token-123456', processIdentity: identity }
  const hash = createHash('sha256').update(JSON.stringify(locator)).digest('hex')
  store.activate(preparing, hash)
  writeRuntimeRecord(paths.runtimeFile, locator)
  let connections = 0
  const server = createServer(() => { connections += 1 })
  let child: ChildProcessWithoutNullStreams | undefined
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(paths.socketPath, resolve) })
    child = spawn(process.execPath, [CLI_ENTRY, 'memory-mcp', '--workspace', userData, '--harness', 'opencode', '--user-data', userData], {
      cwd: ROOT,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    child.stderr.resume()
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'built-e2e', version: '1' } } }) + '\n')
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n')
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'mismatch' } } }) + '\n')
    child.stdin.end()
    const [exitCode] = await once(child, 'exit') as [number | null]
    expect(exitCode).toBe(0)
    expect(connections).toBe(0)
    expect(stdout).toContain('OWNER_MISMATCH')
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closeServer(server)
    store.close()
    rmSync(userData, { recursive: true, force: true })
  }
})
