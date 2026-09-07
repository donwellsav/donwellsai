import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { runProjectMemoryMcp } from '../cli/project-memory-mcp'

export function remoteMemoryRequest(socketPath: string, method: string, params: Record<string, unknown>, credential: Record<string, string>, requestId = randomUUID(), timeoutMs = 30000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath), decoder = new StringDecoder('utf8')
    let buffer = '', settled = false
    const finish = (error?: Error, result?: unknown) => { if (settled) return; settled = true; socket.destroy(); error ? reject(new Error(error.message + ' (memory operation ' + requestId + ')')) : resolve(result) }
    socket.setTimeout(timeoutMs, () => finish(new Error('Project memory disconnected or timed out; mutation outcome may be uncertain and was not retried')))
    socket.on('error', error => finish(error))
    socket.on('close', () => { if (!settled) finish(new Error('Project memory bridge disconnected; request was not retried')) })
    socket.on('connect', () => socket.write(JSON.stringify({ requestId, method, params, credential }) + '\n'))
    socket.on('data', chunk => {
      buffer += decoder.write(chunk)
      if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) return finish(new Error('Memory response exceeded limit'))
      if (!buffer.includes('\n')) return
      try {
        const response = JSON.parse(buffer.slice(0, buffer.indexOf('\n')))
        if (response.requestId !== requestId || typeof response.ok !== 'boolean') throw new Error('Memory bridge response mismatch')
        if (!response.ok) throw new Error(response.error)
        finish(undefined, response.result)
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
    })
  })
}

if (require.main === module) {
  const env = process.env, socket = env.DONWELLS_REMOTE_MEMORY_SOCKET, workspacePath = env.DONWELLS_REMOTE_MEMORY_ROOT
  const credential = { runId: env.DONWELLS_AGENT_HOOK_RUN_ID ?? '', sessionId: env.DONWELLS_AGENT_HOOK_SESSION_ID ?? '', token: env.DONWELLS_AGENT_HOOK_TOKEN ?? '' }
  if (!socket || !workspacePath || !credential.runId || !credential.token) throw new Error('Remote memory requires its daemon-owned agent session')
  void runProjectMemoryMcp({ workspacePath, harness: 'opencode', memoryOnly: true, invoke: (method, params) => remoteMemoryRequest(socket, method, params, credential) }).catch(error => { console.error(String(error)); process.exitCode = 1 })
}
