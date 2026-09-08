import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { createConnection, createServer, type Socket } from 'node:net'
import { once } from 'node:events'
import { isObject } from '@shared/command-catalog'
import { spawnProcess } from '@shared/child-process/run-process'
import { sanitizedProcessEnv } from '@shared/child-process/process-environment'
import { forceTerminateProcessTree } from '@shared/child-process/process-tree-termination'
import { createComputerToolDefinition } from './project-computer-tools'
import { readRemoteProjectMapping, type RemoteProjectMapping } from './project-remote-server'
import type { ProjectToolDefinition } from './project-tools'
import type { ProjectToolScope } from '@shared/project-tools'

const FRAME_LIMIT = 2 * 1024 * 1024

/** Detached per-environment computer controller: owns one admitted driver process and exposes it only over a private socket. */
export async function runRemoteComputerController(mapping: RemoteProjectMapping, definition: ProjectToolDefinition = createComputerToolDefinition(mapping.computerExecutable ?? '', 'ai.donwells.desktop')): Promise<void> {
  if (process.type !== undefined) throw new Error('Remote computer controller requires a compatible Node runtime, not GUI Electron')
  if (!mapping.computerExecutable) throw new Error('No administrator-paired computer-control executable')
  mkdirSync(mapping.stateDirectory, { recursive: true, mode: 0o700 })
  const directory = lstatSync(mapping.stateDirectory)
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o077 || process.getuid && directory.uid !== process.getuid()) throw new Error('Remote supervisor directory must be private and owned')
  const socketPath = join(mapping.stateDirectory, 'computer.sock')
  let stale
  try { stale = lstatSync(socketPath) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (stale) {
    if (!stale.isSocket() || stale.uid !== process.getuid?.()) throw new Error('Remote computer socket is not owned')
    await new Promise<void>((resolve, reject) => {
      const probe = createConnection(socketPath)
      probe.setTimeout(1000, () => { probe.destroy(); reject(new Error('Existing computer controller is unverifiable')) })
      probe.on('connect', () => { probe.destroy(); reject(new Error('A computer controller already owns this environment')) })
      probe.on('error', error => { probe.destroy(); if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') resolve(); else reject(error) })
    })
    const current = lstatSync(socketPath)
    if (current.ino !== stale.ino || current.dev !== stale.dev || !current.isSocket()) throw new Error('Computer socket changed while inspecting it')
    unlinkSync(socketPath)
  }
  const scope: ProjectToolScope = { projectKey: mapping.projectId, projectPath: mapping.root, checkoutPath: mapping.root, indexKey: mapping.environmentId }
  await definition.prepare?.(scope, new AbortController().signal)
  const launch = definition.launch(scope)
  const child = spawnProcess({ ...launch, cwd: mapping.root, env: sanitizedProcessEnv(process.env, launch.env), detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  let driverExited = false
  const failPending = (detail: string) => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(detail)) } pending.clear() }
  child.stderr?.on('data', () => {})
  child.stderr?.on('error', () => {})
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += decoder.write(chunk)
    if (Buffer.byteLength(buffer) > FRAME_LIMIT) { failPending('Computer driver response exceeded limit'); child.kill(); return }
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
      if (!line.trim()) continue
      try {
        const message: unknown = JSON.parse(line)
        if (!isObject(message) || message.jsonrpc !== '2.0') throw new Error()
        if (typeof message.method === 'string') {
          // No sampling, elicitation, filesystem roots or other callback authority is advertised.
          if (message.id !== undefined) child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client method unavailable' } }) + '\n')
          continue
        }
        const item = pending.get(String(message.id))
        if (!item) continue
        if (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error')) throw new Error()
        pending.delete(String(message.id)); clearTimeout(item.timer)
        if (message.error !== undefined) item.reject(new Error('Computer driver rejected request'))
        else item.resolve(message.result)
      } catch { failPending('Malformed computer driver response'); child.kill(); return }
    }
  })
  const mcpRequest = (method: string, params: unknown): Promise<unknown> => {
    if (driverExited) return Promise.reject(new Error('Computer driver is unavailable'))
    const id = randomUUID(), frame = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
    if (Buffer.byteLength(frame) > 64 * 1024) return Promise.reject(new Error('Computer driver request exceeded limit'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Computer driver response timed out')) }, 30000)
      pending.set(id, { resolve, reject, timer })
      child.stdin!.write(frame)
    })
  }
  const request = async (tool?: string, parameters?: Record<string, unknown>) => {
    const result = await mcpRequest('tools/call', { name: tool, arguments: parameters ?? {} })
    if (!isObject(result) || !Array.isArray(result.content)) throw new Error('Malformed computer driver result')
    return result
  }
  const server = createServer((socket: Socket) => {
    const input = new StringDecoder('utf8')
    let received = '', answered = false
    const answer = (response: Record<string, unknown>) => {
      if (answered) return
      answered = true
      let frame = JSON.stringify(response) + '\n'
      if (Buffer.byteLength(frame) > FRAME_LIMIT) frame = JSON.stringify({ id: response.id, ok: false, error: 'Computer-control result exceeds the remote frame limit' }) + '\n'
      socket.end(frame)
    }
    socket.on('data', chunk => {
      received += input.write(chunk)
      if (Buffer.byteLength(received) > FRAME_LIMIT) { socket.destroy(); return }
      const newline = received.indexOf('\n')
      if (newline < 0) return
      void (async () => {
        let id = ''
        try {
          const message: unknown = JSON.parse(received.slice(0, newline))
          if (!isObject(message) || typeof message.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(message.id)) throw new Error('Invalid computer request frame')
          id = message.id
          if (message.operation === 'stop') { answer({ id, ok: true, result: { pid: process.pid } }); server.close(); return }
          if (driverExited) throw new Error('Computer controller is stopped; start a fresh controller to resume')
          const operation = typeof message.operation === 'string' && Object.hasOwn(definition.operations, message.operation) ? definition.operations[message.operation]! : undefined
          if (!operation?.run) throw new Error('Unsupported computer operation')
          const rawArgs = message.arguments === undefined ? {} : message.arguments
          if (!isObject(rawArgs)) throw new Error('Invalid computer arguments')
          const args: Record<string, unknown> = {}
          for (const name of Object.keys(rawArgs)) if (!Object.hasOwn(operation.parameters, name)) throw new Error('Tool argument is not permitted: ' + name)
          for (const [name, parse] of Object.entries(operation.parameters)) args[name] = parse(rawArgs[name])
          answer({ id, ok: true, result: await operation.run(scope, request, args) })
        } catch (error) { answer({ id, ok: false, error: String(error).slice(0, 1024) }) }
      })()
    })
    socket.on('error', () => socket.destroy())
  })
  try {
    const initialized = await mcpRequest('initialize', { protocolVersion: definition.protocolVersion ?? '2025-11-25', capabilities: {}, clientInfo: { name: 'donwells-remote-computer', version: '1' } })
    if (!isObject(initialized) || initialized.protocolVersion !== (definition.protocolVersion ?? '2025-11-25') || !isObject(initialized.serverInfo) || initialized.serverInfo.version !== definition.version || !isObject(initialized.capabilities) || !isObject(initialized.capabilities.tools)) throw new Error('Computer driver version or capability mismatch')
    child.stdin!.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
    const catalog = await mcpRequest('tools/list', {})
    const tools = isObject(catalog) && Array.isArray(catalog.tools) ? catalog.tools : []
    if (!isObject(catalog) || catalog.nextCursor !== undefined || Object.values(definition.operations).some(operation => !tools.some((tool: unknown) => isObject(tool) && tool.name === operation.tool))) throw new Error('Required computer driver capabilities unavailable')
    server.listen(socketPath)
    await once(server, 'listening')
    chmodSync(socketPath, 0o600)
    await new Promise<void>((resolve, reject) => {
      server.once('close', () => resolve())
      child.once('close', () => reject(new Error('Computer driver process exited')))
    })
  } finally {
    driverExited = true
    failPending('Computer controller stopped')
    server.close()
    try { unlinkSync(socketPath) } catch {}
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin?.end()
      await forceTerminateProcessTree(child)
    }
    await definition.stopped?.(scope)
  }
}

if (require.main === module) {
  if (process.argv[2] !== '--mapping' || process.argv.length !== 4) throw new Error('Usage: project-remote-computer-entry --mapping /administrator/owned/project.json')
  void runRemoteComputerController(readRemoteProjectMapping(process.argv[3])).catch(error => { console.error(String(error)); process.exitCode = 1 })
}
