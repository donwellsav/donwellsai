// Native-process transport fixture: inherited session credential, actual packaged MCP and RPC.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
const [executable, cli, profile, workspace, requestPath, resultPath] = process.argv.slice(2)
assert(resultPath)
const deadline = Date.now() + 60000
while (!existsSync(requestPath)) { assert(Date.now() < deadline, 'No handoff request'); await delay(50) }
const request = JSON.parse(readFileSync(requestPath, 'utf8'))
const child = spawn(executable, [cli, 'memory-mcp', '--workspace', workspace, '--harness', 'custom', '--user-data', profile], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
const pending = new Map()
const reader = createInterface({ input: child.stdout })
reader.on('line', line => { const response = JSON.parse(line); const call = pending.get(response.id); if (call) { pending.delete(response.id); call.resolve(response) } })
child.once('error', error => { for (const call of pending.values()) call.reject(error) })
child.once('exit', () => { for (const call of pending.values()) call.reject(new Error('MCP exited before response')) })
// Do not copy environment credentials or native stderr into acceptance receipts.
child.stderr.resume()
let id = 0
async function rpc(method, params) {
  const next = ++id, call = Promise.withResolvers(); pending.set(next, call)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: next, method, params }) + '\n')
  let timer
  try { return await Promise.race([call.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('MCP timed out')), 10000) })]) }
  finally { clearTimeout(timer); pending.delete(next) }
}
async function tool(name, args) {
  const response = await rpc('tools/call', { name, arguments: args })
  assert(!response.error && !response.result.isError, JSON.stringify(response))
  return JSON.parse(response.result.content[0].text)
}
try {
  assert((await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'handoff-fixture', version: '1' } })).result)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const received = await tool('handoff_receive', request)
  assert.equal(received.delivery, 'uncertain')
  assert.equal(received.acceptedBySessionId, process.env.DONWELLS_AGENT_HOOK_SESSION_ID)
  assert.equal(received.summary, 'Controls belong in side panels.')
  const confirmed = await tool('handoff_acknowledge', { id: received.id, expectedRevision: received.revision })
  assert.equal(confirmed.delivery, 'confirmed')
  assert.deepEqual(await tool('handoff_acknowledge', { id: received.id, expectedRevision: received.revision }), confirmed)
  writeFileSync(resultPath + '.tmp', JSON.stringify({ receivedRevision: received.revision, confirmedRevision: confirmed.revision, sessionId: confirmed.acceptedBySessionId, pid: process.pid, mcpPid: child.pid, acknowledgmentReplay: true }), { mode: 0o600 })
  renameSync(resultPath + '.tmp', resultPath)
} finally { child.stdin.end(); child.kill(); reader.close() }
