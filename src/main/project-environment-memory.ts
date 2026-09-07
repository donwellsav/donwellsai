import { randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { runProcess } from '@shared/child-process/run-process'
import { sanitizedProcessEnv } from '@shared/child-process/process-environment'
import type { AgentSessionCredential } from '@shared/agent-runtime'
import type { ProjectEnvironments } from './project-environments'
import { sshFailureMessage, sshProjectArguments, validateSshConfig } from './project-remote'

import type { EnvironmentMemoryState } from '@shared/project-environment'
type Bridge = { status: EnvironmentMemoryState; controller: AbortController; server: Server; sockets: Set<Socket>; directory: string; completion: Promise<void>; challenge: string }

/** One explicitly scoped Unix-socket forward; process lifecycle remains in runProcess. */
export class ProjectEnvironmentMemory {
  private readonly starting = new Map<string, AbortController>()
  private readonly bridges = new Map<string, Bridge>()
  constructor(private readonly environments: ProjectEnvironments, private readonly execute: typeof runProcess = runProcess) {}
  status(id: string): EnvironmentMemoryState { return this.bridges.get(id)?.status ?? { state: 'disconnected' } }
  async start(workspacePath: string, id: string, generation: number): Promise<EnvironmentMemoryState> {
    await this.environments.get(workspacePath, id, generation)
    if (this.starting.has(id)) return { state: 'connecting' }
    const controller = new AbortController(); this.starting.set(id, controller)
    try { return await this.startNow(workspacePath, id, generation, controller) } finally { if (this.starting.get(id) === controller) this.starting.delete(id) }
  }
  private async startNow(workspacePath: string, id: string, generation: number, controller: AbortController): Promise<EnvironmentMemoryState> {
    const environment = await this.environments.get(workspacePath, id, generation)
    if (environment.state !== 'ready') throw new Error('Connect the project environment first')
    const existing = this.bridges.get(id)
    if (existing && ['connected', 'connecting'].includes(existing.status.state)) return existing.status
    if (existing) await this.closeBridge(id, existing)
    const hello = await this.environments.request(workspacePath, id, generation, 'hello', {}, randomUUID(), controller.signal) as { memorySocket?: string }
    const remoteSocket = hello.memorySocket
    if (!remoteSocket || !remoteSocket.startsWith('/') || remoteSocket.length > 100 || /[:\0\r\n]/.test(remoteSocket)) throw new Error('Remote memory socket is not supported')
    await this.environments.request(workspacePath, id, generation, 'memory.prepare', {}, randomUUID(), controller.signal)
    if (controller.signal.aborted) throw new Error('Memory bridge start cancelled')
    const directory = mkdtempSync('/tmp/donwells-environment-memory-'), localSocket = join(directory, 'm.sock')
    const bridge: Bridge = { status: { state: 'connecting' }, controller, server: createServer(), sockets: new Set(), directory, completion: Promise.resolve(), challenge: randomUUID() }
    this.bridges.set(id, bridge)
    bridge.server.on('connection', socket => {
      if (bridge.sockets.size >= 8) { socket.destroy(); return }
      bridge.sockets.add(socket); socket.once('close', () => bridge.sockets.delete(socket)); socket.on('error', () => socket.destroy())
      socket.setTimeout(30000, () => socket.destroy())
      let buffer = '', dispatched = false
      const decoder = new StringDecoder('utf8')
      socket.on('data', chunk => {
        if (dispatched) return socket.destroy()
        buffer += decoder.write(chunk)
        if (Buffer.byteLength(buffer) > 1024 * 1024) return socket.destroy()
        if (!buffer.includes('\n')) return
        dispatched = true
        void (async () => {
          let requestId = ''
          try {
            const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n')))
            requestId = String(request.requestId)
            let result: unknown
            if (request.method === 'bridge.ping' && request.params?.challenge === bridge.challenge) result = { challenge: bridge.challenge }
            else {
              if (bridge.status.state !== 'connected') throw new Error('Shared memory bridge is not connected')
              result = await this.environments.invokeMemory(workspacePath, id, generation, requestId, request.method, request.params, request.credential as AgentSessionCredential)
            }
            const response = JSON.stringify({ requestId, ok: true, result }) + '\n'
            if (Buffer.byteLength(response) > 2 * 1024 * 1024) throw new Error('Memory response exceeds limit')
            socket.end(response)
          } catch (error) { socket.end(JSON.stringify({ requestId, ok: false, error: String(error).slice(0, 1024) }) + '\n') }
        })()
      })
    })
    try {
      await new Promise<void>((resolve, reject) => { bridge.server.once('error', reject); bridge.server.listen(localSocket, () => resolve()) })
      chmodSync(localSocket, 0o600)
      const args = sshProjectArguments(validateSshConfig(environment.config), this.environments.trustFile(id)).slice(0, -3)
      const clear = args.indexOf('ClearAllForwardings=yes'); args[clear] = 'ClearAllForwardings=no'
      args.push('-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', '-o', 'StreamLocalBindMask=0177', '-o', 'StreamLocalBindUnlink=no', '-R', remoteSocket + ':' + localSocket, '--', environment.config.username + '@' + environment.config.hostname)
      bridge.completion = this.execute({ program: '/usr/bin/ssh', args, env: sanitizedProcessEnv(process.env), timeoutMs: null, maxOutputBytes: 65536, signal: bridge.controller.signal, detached: true }).then(() => { bridge.status = { state: 'failed', detail: 'Memory forward disconnected' } }, error => { bridge.status = { state: 'failed', detail: (sshFailureMessage(error) ?? String(error)).slice(0, 1024) } })
      for (let attempt = 0; attempt < 10; attempt++) {
        if (bridge.status.state === 'failed') throw new Error(bridge.status.detail)
        try {
          const result = await this.environments.request(workspacePath, id, generation, 'memory.probe', { challenge: bridge.challenge }, randomUUID(), controller.signal) as { challenge?: string }
          if (result.challenge === bridge.challenge) { bridge.status = { state: 'connected' }; return bridge.status }
        } catch { /* Forward setup may still be in flight; each probe is read-only. */ }
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      throw new Error('Remote memory forward did not become reachable')
    } catch (error) { await this.stop(workspacePath, id, generation); throw error }
  }
  async stop(workspacePath: string, id: string, generation: number): Promise<EnvironmentMemoryState> {
    await this.environments.get(workspacePath, id, generation)
    this.starting.get(id)?.abort()
    const bridge = this.bridges.get(id)
    if (!bridge) return { state: 'disconnected' }
    await this.closeBridge(id, bridge)
    return { state: 'disconnected' }
  }
  private async closeBridge(id: string, bridge: Bridge): Promise<void> {
    bridge.status = { state: 'disconnected' }; bridge.controller.abort()
    await bridge.completion
    for (const socket of bridge.sockets) socket.destroy()
    if (bridge.server.listening) await new Promise<void>(resolve => bridge.server.close(() => resolve()))
    rmSync(bridge.directory, { recursive: true, force: true }); this.bridges.delete(id)
  }
  get active(): boolean { return this.bridges.size > 0 || this.starting.size > 0 }
  async close(): Promise<void> { for (const controller of this.starting.values()) controller.abort(); await Promise.all([...this.bridges].map(([id, bridge]) => this.closeBridge(id, bridge))) }
}
