import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isObject } from '../shared/command-catalog.js'
import { observeRuntimeOwnerReadOnly, RuntimeOwnershipError, RuntimeOwnershipStore } from '../shared/runtime-ownership.js'
import { localRuntimePaths, readRuntimeRecord } from '../main/local-runtime.js'
import { canonicalPrivateDirectory } from '../shared/runtime-file-security.js'
export type RpcEnvelope = { id: string; ok: boolean; result?: unknown; error?: string; code?: string; _meta: { ts: number; method: string } }
export class CliFailure extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'CliFailure' }
}

export function defaultUserData(platform = process.platform, env = process.env, home = homedir()): string {
  if (env.DONWELLS_USER_DATA) return env.DONWELLS_USER_DATA
  const root = platform === 'darwin' ? join(home, 'Library', 'Application Support') : platform === 'win32' ? env.APPDATA ?? join(home, 'AppData', 'Roaming') : env.XDG_CONFIG_HOME ?? join(home, '.config')
  return join(root, 'donwells.ai')
}

type RuntimeOwnerKind = 'app' | 'terminal'

function runtimeOwner(userData: string, kind: RuntimeOwnerKind = 'app'): { socketPath: string; authToken: string; legacy: boolean } {
  const ownerKind = kind === 'app' ? 'donwells-app' : 'terminal-daemon'
  const paths = localRuntimePaths(canonicalPrivateDirectory(userData, { requireCanonical: true }), kind)
  const locator = readRuntimeRecord(paths.runtimeFile)
  if (locator.status === 'missing') throw new CliFailure('RUNTIME_UNAVAILABLE', 'Runtime discovery is unavailable at ' + paths.runtimeFile + '; is donwells.ai running?')
  if (locator.status === 'invalid') throw new CliFailure('RUNTIME_INVALID', 'Invalid runtime discovery file: ' + locator.reason)
  if (locator.status === 'legacy') {
    let authority
    try {
      authority = observeRuntimeOwnerReadOnly(paths.ownershipDatabasePath, ownerKind)
    } catch (error) {
      if (error instanceof RuntimeOwnershipError) throw new CliFailure('RUNTIME_OWNER_' + error.code, error.message)
      throw new CliFailure('RUNTIME_OWNER_UNAVAILABLE', error instanceof Error ? error.message : String(error))
    }
    if (authority.status !== 'vacant') {
      throw new CliFailure('OWNER_MISMATCH', 'Legacy runtime locator conflicts with the recorded authority owner')
    }
    return { socketPath: locator.record.socketPath, authToken: locator.record.authToken, legacy: true }
  }
  let store: RuntimeOwnershipStore
  try {
    store = new RuntimeOwnershipStore(paths.ownershipDatabasePath, { readOnly: true })
  } catch (error) {
    if (error instanceof RuntimeOwnershipError) throw new CliFailure('RUNTIME_OWNER_' + error.code, error.message)
    throw new CliFailure('RUNTIME_OWNER_UNAVAILABLE', error instanceof Error ? error.message : String(error))
  }
  try {
    const owner = store.resolveActive(ownerKind, locator.record, locator.sha256)
    return { socketPath: owner.endpoint, authToken: owner.authToken, legacy: false }
  } catch (error) {
    if (error instanceof RuntimeOwnershipError) throw new CliFailure(error.code, error.message)
    throw new CliFailure('RUNTIME_OWNER_UNAVAILABLE', error instanceof Error ? error.message : String(error))
  } finally {
    store.close()
  }
}

export function callRuntime(method: string, params: Record<string, unknown>, userData: string, timeoutMs: number): Promise<RpcEnvelope> {
  const runtime = runtimeOwner(userData)
  const id = randomUUID()
  const helloId = randomUUID()
  const request = JSON.stringify({ id, method, params }) + '\n'
  if (Buffer.byteLength(request) > 8 * 1024 * 1024) throw new CliFailure('REQUEST_TOO_LARGE', 'Command exceeds the 8 MiB request limit')
  return new Promise((resolve, reject) => {
    const socket = createConnection(runtime.socketPath)
    socket.setEncoding('utf8')
    let buffer = ''
    let searchFrom = 0
    let bufferBytes = 0
    let authenticated = false
    let settled = false
    const finish = (error?: Error, envelope?: RpcEnvelope): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeAllListeners()
      socket.destroy()
      if (error) reject(error)
      else if (envelope) resolve(envelope)
    }
    const timer = setTimeout(() => finish(new CliFailure('TIMEOUT', 'Timed out waiting for ' + method + '; no retry was attempted')), timeoutMs)
    socket.on('connect', () => socket.write(JSON.stringify({ id: helloId, method: 'auth.hello', authToken: runtime.authToken }) + '\n'))
    socket.on('error', error => finish(new CliFailure(runtime.legacy ? 'RECOVERY_REQUIRED' : 'CONNECTION_FAILED', runtime.legacy ? 'Legacy runtime contact failed; explicit recovery is required' : error.message)))
    socket.on('close', () => finish(new CliFailure(runtime.legacy ? 'RECOVERY_REQUIRED' : 'CONNECTION_CLOSED', runtime.legacy ? 'Legacy runtime contact closed; explicit recovery is required' : (authenticated ? 'Connection closed before the command completed' : 'Connection closed during authentication'))))
    socket.on('data', (chunk: string) => {
      buffer += chunk
      bufferBytes += Buffer.byteLength(chunk)
      if (bufferBytes > 8 * 1024 * 1024) { finish(new CliFailure('RESPONSE_TOO_LARGE', 'Response exceeded the 8 MiB limit')); return }
      let newline: number
      while ((newline = buffer.indexOf('\n', searchFrom)) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        searchFrom = 0
        bufferBytes = Buffer.byteLength(buffer)
        if (!line.trim()) continue
        let message: unknown
        try { message = JSON.parse(line) } catch { finish(new CliFailure('PROTOCOL_ERROR', 'Runtime sent invalid JSON')); return }
        if (!isObject(message)) { finish(new CliFailure('PROTOCOL_ERROR', 'Runtime sent an invalid envelope')); return }
        if (message.id !== (authenticated ? id : helloId)) continue
        if (!authenticated) {
          if (message.ok !== true) { finish(new CliFailure(runtime.legacy ? 'RECOVERY_REQUIRED' : 'AUTH_FAILED', runtime.legacy ? 'Legacy runtime authentication failed; explicit recovery is required' : 'Runtime authentication failed')); return }
          authenticated = true
          socket.write(request)
          continue
        }
        if (typeof message.ok !== 'boolean') { finish(new CliFailure('PROTOCOL_ERROR', 'Runtime omitted the command outcome')); return }
        finish(undefined, { id, ok: message.ok, ...(message.ok ? { result: message.result } : { error: String(message.error ?? 'Command failed'), code: typeof message.code === 'string' ? message.code : 'COMMAND_FAILED' }), _meta: { ts: Date.now(), method } })
        return
      }
      searchFrom = buffer.length
    })
  })
}

/**
 * Calls one typed command on the detached terminal daemon. The daemon wire is
 * `hello` authentication followed by flat `op` frames. Worker commands
 * forward the daemon-issued per-session credential through this call; when no
 * explicit credential is supplied and `issueForProject` is set, a credential
 * is issued on the same authenticated connection before the worker command so
 * the daemon can bind it to the connection and reject payload impersonation.
 */
export function callTerminalDaemon(
  op: string,
  params: Record<string, unknown>,
  userData: string,
  timeoutMs: number,
  credential?: { credentialId: string; token: string },
  issueForProject?: string
): Promise<RpcEnvelope> {
  const runtime = runtimeOwner(userData, 'terminal')
  const id = randomUUID()
  const helloId = randomUUID()
  const issueId = randomUUID()
  const needsIssue = credential === undefined && issueForProject !== undefined
  const mainFrame = (workerCredential: { credentialId: string; token: string } | undefined): Record<string, unknown> => ({
    id,
    op,
    ...params,
    ...(workerCredential === undefined ? {} : { credential: { credentialId: workerCredential.credentialId, token: workerCredential.token } })
  })
  if (Buffer.byteLength(JSON.stringify(mainFrame(credential))) > 8 * 1024 * 1024) throw new CliFailure('REQUEST_TOO_LARGE', 'Command exceeds the 8 MiB request limit')
  return new Promise((resolve, reject) => {
    const socket = createConnection(runtime.socketPath)
    socket.setEncoding('utf8')
    let buffer = ''
    let searchFrom = 0
    let bufferBytes = 0
    let phase: 'hello' | 'issue' | 'main' = 'hello'
    let settled = false
    const finish = (error?: Error, envelope?: RpcEnvelope): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeAllListeners()
      socket.destroy()
      if (error) reject(error)
      else if (envelope) resolve(envelope)
    }
    const failReply = (message: Record<string, unknown>): void => {
      finish(undefined, { id, ok: false, error: String(message['error'] ?? 'Command failed'), code: typeof message['code'] === 'string' ? message['code'] : 'COMMAND_FAILED', _meta: { ts: Date.now(), method: op } })
    }
    const succeedReply = (message: Record<string, unknown>): void => {
      const { id: _replyId, ok, ...rest } = message
      finish(undefined, { id, ok: true, result: rest, _meta: { ts: Date.now(), method: op } })
    }
    const timer = setTimeout(() => finish(new CliFailure('TIMEOUT', 'Timed out waiting for ' + op + '; no retry was attempted')), timeoutMs)
    socket.on('connect', () => socket.write(JSON.stringify({ id: helloId, op: 'hello', authToken: runtime.authToken }) + '\n'))
    socket.on('error', error => finish(new CliFailure(runtime.legacy ? 'RECOVERY_REQUIRED' : 'CONNECTION_FAILED', runtime.legacy ? 'Legacy daemon contact failed; explicit recovery is required' : error.message)))
    socket.on('close', () => finish(new CliFailure(runtime.legacy ? 'RECOVERY_REQUIRED' : 'CONNECTION_CLOSED', runtime.legacy ? 'Legacy daemon contact closed; explicit recovery is required' : (phase === 'main' ? 'Connection closed before the command completed' : 'Connection closed during authentication'))))
    socket.on('data', (chunk: string) => {
      buffer += chunk
      bufferBytes += Buffer.byteLength(chunk)
      if (bufferBytes > 8 * 1024 * 1024) { finish(new CliFailure('RESPONSE_TOO_LARGE', 'Response exceeded the 8 MiB limit')); return }
      let newline: number
      while ((newline = buffer.indexOf('\n', searchFrom)) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        searchFrom = 0
        bufferBytes = Buffer.byteLength(buffer)
        if (!line.trim()) continue
        let message: unknown
        try { message = JSON.parse(line) } catch { finish(new CliFailure('PROTOCOL_ERROR', 'Daemon sent invalid JSON')); return }
        if (!isObject(message)) { finish(new CliFailure('PROTOCOL_ERROR', 'Daemon sent an invalid envelope')); return }
        if (phase === 'hello') {
          if (String(message['id'] ?? '') !== helloId) continue
          if (message['ok'] !== true) { finish(new CliFailure(runtime.legacy ? 'RECOVERY_REQUIRED' : 'AUTH_FAILED', runtime.legacy ? 'Legacy daemon authentication failed; explicit recovery is required' : 'Daemon authentication failed')); return }
          phase = needsIssue ? 'issue' : 'main'
          socket.write(JSON.stringify(needsIssue ? { id: issueId, op: 'task.credential.issue', projectId: issueForProject } : mainFrame(credential)) + '\n')
          continue
        }
        if (phase === 'issue') {
          if (String(message['id'] ?? '') !== issueId) continue
          if (message['ok'] !== true) { failReply(message); return }
          const issued = message['credential']
          if (typeof issued !== 'object' || issued === null || typeof (issued as Record<string, unknown>)['credentialId'] !== 'string' || typeof (issued as Record<string, unknown>)['token'] !== 'string') {
            finish(new CliFailure('PROTOCOL_ERROR', 'Daemon returned an invalid task worker credential'))
            return
          }
          phase = 'main'
          socket.write(JSON.stringify(mainFrame({ credentialId: (issued as Record<string, unknown>)['credentialId'] as string, token: (issued as Record<string, unknown>)['token'] as string })) + '\n')
          continue
        }
        if (String(message['id'] ?? '') !== id) continue
        if (typeof message['ok'] !== 'boolean') { finish(new CliFailure('PROTOCOL_ERROR', 'Daemon omitted the command outcome')); return }
        if (message['ok']) succeedReply(message)
        else failReply(message)
        return
      }
      searchFrom = buffer.length
    })
  })
}
