import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

/** One newline-delimited request per connection to the guest computer controller; failures are never retried. */
export function remoteComputerRequest(socketPath: string, operation: string, args: Record<string, unknown>, id = randomUUID(), timeoutMs = 30000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath), decoder = new StringDecoder('utf8')
    let buffer = '', settled = false
    const finish = (error?: Error, result?: unknown) => { if (settled) return; settled = true; socket.destroy(); error ? reject(new Error(error.message + ' (computer operation ' + id + ')')) : resolve(result) }
    socket.setTimeout(timeoutMs, () => finish(new Error('Remote computer controller disconnected or timed out; the operation outcome may be uncertain and was not retried')))
    socket.on('error', error => finish(error))
    socket.on('close', () => { if (!settled) finish(new Error('Remote computer controller disconnected; request was not retried')) })
    socket.on('connect', () => socket.write(JSON.stringify({ id, operation, arguments: args }) + '\n'))
    socket.on('data', chunk => {
      buffer += decoder.write(chunk)
      if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) return finish(new Error('Computer response exceeded limit'))
      if (!buffer.includes('\n')) return
      try {
        const response = JSON.parse(buffer.slice(0, buffer.indexOf('\n')))
        if (response.id !== id || typeof response.ok !== 'boolean') throw new Error('Computer controller response mismatch')
        if (!response.ok) throw new Error(response.error)
        finish(undefined, response.result)
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
    })
  })
}
