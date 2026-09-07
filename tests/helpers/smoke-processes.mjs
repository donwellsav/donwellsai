// Shared cleanup for disposable acceptance profiles. Never stop a daemon owning sessions.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
export function appendTail(current, chunk) {
  const combined = current + String(chunk)
  if (Buffer.byteLength(combined) <= MAX_OUTPUT_BYTES) return combined
  return Buffer.from(combined).subarray(-MAX_OUTPUT_BYTES).toString('utf8')
}

export function delay(ms) {
  const result = Promise.withResolvers()
  setTimeout(result.resolve, ms)
  return result.promise
}

// A disconnected Chromium context can make ElectronApplication.close() a no-op.
// Call only after closing this disposable profile's sessions and owned tools.
export async function closeOwnedSmokeApp(app, child = app.process()) {
  const exited = () => child.exitCode !== null || child.signalCode !== null
  let timer, closeError, forcedTermination = false
  try {
    await Promise.race([app.close(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('App shutdown timed out')), 10000)
    })])
  } catch (error) { closeError = String(error) }
  finally { clearTimeout(timer) }
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (exited()) break
    forcedTermination = true
    child.kill(signal)
    const deadline = Date.now() + 5000
    while (!exited() && Date.now() < deadline) await delay(50)
  }
  if (!exited()) throw new Error('Owned app process termination could not be verified')
  return { forcedTermination, exitCode: child.exitCode, signal: child.signalCode, ...(closeError ? { closeError } : {}) }
}

export function cleanSmokeAppShutdown(result) {
  return result.forcedTermination === false && result.exitCode === 0 && result.signal === null && !result.closeError
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

export async function connectDaemon(runtime, onEvent = () => {}) {
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
      if (message.event) { onEvent(message); continue }
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

export async function cleanupOwnedSmokeDaemon(profile) {
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
