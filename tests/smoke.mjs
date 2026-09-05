// Headless smoke test: builds are run by `pnpm smoke` (build first, then this).
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const electronBinary = join(
  root,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'darwin'
    ? 'Electron.app/Contents/MacOS/Electron'
    : process.platform === 'win32'
      ? 'electron.exe'
      : 'electron'
)
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const userData = mkdtempSync(join(tmpdir(), 'donwells-smoke-'))

function appendTail(current, chunk) {
  const combined = current + String(chunk)
  if (Buffer.byteLength(combined) <= MAX_OUTPUT_BYTES) return combined
  return Buffer.from(combined).subarray(-MAX_OUTPUT_BYTES).toString('utf8')
}

function delay(ms) {
  const result = Promise.withResolvers()
  setTimeout(result.resolve, ms)
  return result.promise
}

function localPidLiveness(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'unverifiable'
  try {
    process.kill(pid, 0)
    return 'live'
  } catch (error) {
    if (error?.code === 'ESRCH') return 'exited'
    if (error?.code === 'EPERM') return 'live'
    return 'unverifiable'
  }
}

async function connectDaemon(runtime) {
  const socket = createConnection(runtime.socketPath)
  let buffer = ''
  const pending = new Map()
  const closed = Promise.withResolvers()
  socket.on('data', (chunk) => {
    buffer = appendTail(buffer, chunk)
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line.trim()) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      const waiter = pending.get(String(message.id ?? ''))
      if (!waiter) continue
      pending.delete(String(message.id ?? ''))
      if (message.ok === true) waiter.resolve(message)
      else waiter.reject(new Error(String(message.error ?? 'daemon error')))
    }
  })
  socket.on('error', (error) => {
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
    closed.resolve()
  })
  socket.on('close', () => closed.resolve())
  const connected = Promise.withResolvers()
  const onConnect = () => {
    socket.removeListener('error', onConnectError)
    connected.resolve()
  }
  const onConnectError = (error) => {
    socket.removeListener('connect', onConnect)
    connected.reject(error)
  }
  socket.once('connect', onConnect)
  socket.once('error', onConnectError)
  await connected.promise
  const request = (op, params = {}) => {
    const id = randomUUID()
    const result = Promise.withResolvers()
    const timer = setTimeout(() => {
      if (!pending.delete(id)) return
      result.reject(new Error('daemon request timed out: ' + op))
    }, 2000)
    result.promise.finally(() => clearTimeout(timer)).catch(() => {})
    pending.set(id, result)
    socket.write(JSON.stringify({ id, op, ...params }) + '\n')
    return result.promise
  }
  await request('hello', { authToken: runtime.authToken })
  return { socket, request, closed: closed.promise }
}

async function cleanupOwnedSmokeDaemon(profile) {
  const runtimeFile = join(profile, 'terminal-daemon', 'runtime.json')
  if (!existsSync(runtimeFile)) return true
  let runtime
  try {
    runtime = JSON.parse(readFileSync(runtimeFile, 'utf8'))
  } catch {
    return false
  }
  if (typeof runtime.socketPath !== 'string' || typeof runtime.authToken !== 'string') return false
  let client
  try {
    client = await connectDaemon(runtime)
  } catch {
    return localPidLiveness(runtime.pid) === 'exited'
  }
  try {
    const status = await client.request('daemon.status')
    if (status.idle !== true || status.sessionCount !== 0 || status.liveSessionCount !== 0) return false
    const stopped = await client.request('daemon.shutdown')
    if (stopped.stopped !== true) return false
    await Promise.race([
      client.closed,
      delay(2000)
    ])
    const deadline = Date.now() + 5000
    while (Date.now() <= deadline) {
      if (localPidLiveness(Number(status.pid)) === 'exited') return true
      await delay(50)
    }
    return false
  } finally {
    client.socket.destroy()
  }
}

const exitResult = Promise.withResolvers()
const app = spawn(electronBinary, [root], {
  env: { ...process.env, DONWELLS_USER_DATA: userData, DONWELLS_SMOKE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,
  windowsHide: true
})
let out = ''
app.stdout.on('data', (chunk) => { out = appendTail(out, chunk) })
app.stderr.on('data', (chunk) => { out = appendTail(out, chunk) })
const appTimer = setTimeout(() => {
  console.error('smoke: timeout — no exit after 60s\n' + out.slice(-2000))
  app.kill()
  exitResult.resolve(1)
}, 60000)
app.once('error', (error) => {
  clearTimeout(appTimer)
  console.error('smoke: app spawn failed: ' + error.message)
  exitResult.resolve(1)
})
app.once('exit', (code) => {
  clearTimeout(appTimer)
  const hasReady = out.includes('smoke:ready')
  const ok = out.includes('smoke:ok')
  const fail = out.match(/smoke:fail (.*)/)
  console.log(out.trim())
  if (code !== 0 || !hasReady || !ok) {
    if (fail) console.error('\nSMOKE FAILED: ' + fail[1])
    else if (!hasReady) console.error('\nSMOKE FAILED: app never reached ready')
    exitResult.resolve(1)
  } else {
    exitResult.resolve(0)
  }
})
const exit = await exitResult.promise

const safeToRemoveProfile = await cleanupOwnedSmokeDaemon(userData)
if (safeToRemoveProfile) {
  rmSync(userData, { recursive: true, force: true })
} else {
  console.error('smoke: cleanup refused; daemon ownership or idleness was not proven: ' + userData)
}
process.exit(exit === 0 && safeToRemoveProfile ? 0 : 1)
