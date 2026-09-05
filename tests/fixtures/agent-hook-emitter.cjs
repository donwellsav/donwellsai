'use strict'

const { connect } = require('node:net')
const { StringDecoder } = require('node:string_decoder')

const socketPath = process.env.DONWELLS_AGENT_HOOK_SOCKET
const runId = process.env.DONWELLS_AGENT_HOOK_RUN_ID
const sessionId = process.env.DONWELLS_AGENT_HOOK_SESSION_ID
const hookToken = process.env.DONWELLS_AGENT_HOOK_TOKEN
const kind = process.argv[2]
const detail = process.argv[3]

if (!socketPath || !runId || !sessionId || !hookToken || !kind) {
  console.error('missing scoped hook binding')
  process.exitCode = 2
} else {
  const socket = connect(socketPath)
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  let authenticated = false
  let settled = false

  const finish = (code, message) => {
    if (settled) return
    settled = true
    if (message) console.error(message)
    socket.destroy()
    process.exitCode = code
  }

  socket.setTimeout(2_000, () => finish(3, 'hook response timed out'))
  socket.on('error', (error) => finish(3, error.message))
  socket.on('connect', () => {
    socket.write(JSON.stringify({
      id: 'hello',
      op: 'hook.hello',
      runId,
      sessionId,
      hookToken
    }) + '\n')
  })
  socket.on('close', () => finish(4, 'hook connection closed before acknowledgement'))
  socket.on('data', (chunk) => {
    buffer += decoder.write(chunk)
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line.trim()) continue
      let frame
      try {
        frame = JSON.parse(line)
      } catch {
        finish(3, 'invalid hook response')
        return
      }
      if (!authenticated) {
        if (frame.id !== 'hello' || frame.ok !== true) {
          finish(4, 'hook authentication failed')
          return
        }
        authenticated = true
        socket.write(JSON.stringify({ id: 'emit', op: 'hook.emit', kind, detail }) + '\n')
        continue
      }
      if (frame.id === 'emit') {
        finish(frame.ok === true ? 0 : 5, frame.ok === true ? undefined : 'hook event rejected')
        return
      }
    }
  })
}
