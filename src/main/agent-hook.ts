import { randomUUID } from 'node:crypto'
import { createConnection, type Socket } from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import type { Readable } from 'node:stream'
import {
  AGENT_HOOK_INPUT_MAX_BYTES,
  normalizeAgentHookMessage,
  type AgentHookEventKind,
  type AgentHookMessage
} from '@shared/agent-runtime'
import { AGENT_HOOK_ENV } from './agents/provider-hooks'

const HOOK_EMIT_TIMEOUT_MS = 2_000
const MAX_HOOK_RESPONSE_BYTES = 64 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return normalized ? normalized.slice(0, 120) : undefined
}

/** Extract only lifecycle labels; provider prompts, tool input, and model output never leave the child. */
export function hookDetailFromProviderPayload(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  return boundedLabel(payload['detail'])
    ?? boundedLabel(payload['tool_name'])
    ?? boundedLabel(payload['hook_event_name'])
    ?? boundedLabel(payload['notification_type'])
    ?? boundedLabel(payload['type'])
}

async function readBoundedInput(stream: Readable): Promise<unknown> {
  const completion = Promise.withResolvers<string>()
  const decoder = new StringDecoder('utf8')
  let bytes = 0
  let input = ''
  const cleanup = (): void => {
    stream.removeListener('data', onData)
    stream.removeListener('end', onEnd)
    stream.removeListener('error', onError)
  }
  const onData = (chunk: Buffer | string): void => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > AGENT_HOOK_INPUT_MAX_BYTES) {
      cleanup()
      completion.reject(new Error('agent hook input exceeded limit'))
      return
    }
    input += decoder.write(buffer)
  }
  const onEnd = (): void => {
    input += decoder.end()
    cleanup()
    completion.resolve(input)
  }
  const onError = (error: Error): void => {
    cleanup()
    completion.reject(error)
  }
  stream.on('data', onData)
  stream.once('end', onEnd)
  stream.once('error', onError)
  const text = await completion.promise
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

function writeFrame(socket: Socket, frame: Record<string, unknown>): void {
  socket.write(`${JSON.stringify(frame)}\n`)
}

export async function emitAgentHook(options: {
  socketPath: string
  runId: string
  sessionId: string
  token: string
  message: AgentHookMessage
  timeoutMs?: number
}): Promise<void> {
  const normalized = normalizeAgentHookMessage(options.message)
  if (!normalized) throw new Error('invalid agent hook event')
  if (!options.socketPath || !options.runId || !options.sessionId || !options.token) {
    throw new Error('agent hook binding is incomplete')
  }

  const completion = Promise.withResolvers<void>()
  const socket = createConnection(options.socketPath)
  const decoder = new StringDecoder('utf8')
  const helloId = randomUUID()
  const emitId = randomUUID()
  let stage: 'hello' | 'emit' = 'hello'
  let buffer = ''
  let settled = false
  const cleanup = (): void => {
    clearTimeout(timer)
    socket.removeAllListeners()
    socket.destroy()
  }
  const finish = (error?: Error): void => {
    if (settled) return
    settled = true
    cleanup()
    if (error) completion.reject(error)
    else completion.resolve()
  }
  const drain = (): void => {
    let newline: number
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line.trim()) continue
      let response: Record<string, unknown>
      try {
        response = JSON.parse(line)
      } catch {
        continue
      }
      const expectedId = stage === 'hello' ? helloId : emitId
      if (response['id'] !== expectedId) continue
      if (response['ok'] !== true) {
        finish(new Error(String(response['error'] ?? 'agent hook rejected')))
        return
      }
      if (stage === 'hello') {
        stage = 'emit'
        writeFrame(socket, { id: emitId, op: 'hook.emit', ...normalized })
      } else {
        finish()
      }
    }
  }
  const timer = setTimeout(() => finish(new Error('agent hook channel timed out')), options.timeoutMs ?? HOOK_EMIT_TIMEOUT_MS)
  socket.once('connect', () => writeFrame(socket, {
    id: helloId,
    op: 'hook.hello',
    runId: options.runId,
    sessionId: options.sessionId,
    hookToken: options.token
  }))
  socket.on('data', (chunk: Buffer) => {
    buffer += decoder.write(chunk)
    if (Buffer.byteLength(buffer) > MAX_HOOK_RESPONSE_BYTES) {
      finish(new Error('agent hook response exceeded limit'))
      return
    }
    drain()
  })
  socket.once('error', (error) => finish(new Error(`agent hook transport error: ${error.message}`)))
  socket.once('close', () => finish(new Error('agent hook transport closed before acknowledgement')))
  return completion.promise
}

export async function runAgentHookEmitterFromEnvironment(
  kind: AgentHookEventKind,
  input: Readable = process.stdin
): Promise<void> {
  const payload = await readBoundedInput(input)
  const message = normalizeAgentHookMessage({ kind, detail: hookDetailFromProviderPayload(payload) })
  if (!message) throw new Error('invalid agent hook event')
  await emitAgentHook({
    socketPath: process.env[AGENT_HOOK_ENV.socket] ?? '',
    runId: process.env[AGENT_HOOK_ENV.runId] ?? '',
    sessionId: process.env[AGENT_HOOK_ENV.sessionId] ?? '',
    token: process.env[AGENT_HOOK_ENV.token] ?? '',
    message
  })
}
