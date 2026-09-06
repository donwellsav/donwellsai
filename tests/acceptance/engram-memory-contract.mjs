// Isolated candidate probe; never points at the user's Engram profile.
// node tests/acceptance/engram-memory-contract.mjs /absolute/engram /absolute/new-evidence.json
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'

const [executable, evidence] = process.argv.slice(2)
assert(executable && evidence && isAbsolute(executable) && isAbsolute(evidence), 'Pass absolute executable and new evidence paths')
const root = await mkdtemp(join(tmpdir(), 'donwells-engram-contract-'))
const receipt = { executable, executableSha256: createHash('sha256').update(await readFile(executable)).digest('hex'), processes: [], calls: [] }
const started = performance.now()

function start(project) {
  const child = spawn(executable, ['mcp', '--tools=all', '--project', project], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: root, ENGRAM_DATA_DIR: join(root, 'data') },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  receipt.processes.push(child.pid)
  let sequence = 0
  let diagnostic = ''
  child.stderr.on('data', data => { diagnostic = (diagnostic + data).slice(-8000) })
  const pending = new Map()
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    try {
      const message = JSON.parse(line)
      pending.get(message.id)?.resolve(message)
    } catch { /* Candidate stdout diagnostics are not RPC responses. */ }
  })
  const exited = new Promise(resolve => child.once('exit', (code, signal) => {
    for (const request of pending.values()) request.reject(new Error(`Candidate exited: ${code}/${signal}: ${diagnostic}`))
    resolve({ code, signal })
  }))
  child.on('error', error => { for (const request of pending.values()) request.reject(error) })
  async function request(method, params = {}) {
    const id = ++sequence
    let timer
    try {
      const response = await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        timer = setTimeout(() => reject(new Error(`Timed out: ${method}: ${diagnostic}`)), 15000)
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })
      assert(!response.error, JSON.stringify(response.error))
      if (method === 'initialize') child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
      return response.result
    } finally { clearTimeout(timer); pending.delete(id) }
  }
  return {
    request,
    async call(name, args) {
      const result = await request('tools/call', { name, arguments: args })
      receipt.calls.push({ project, name, arguments: args, result })
      return result
    },
    async stop() {
      child.stdin.end()
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
      try { await exited } finally { clearTimeout(timer); lines.close() }
    }
  }
}

let client
try {
  client = start('donwells-contract-a')
  const initialization = await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'donwells-contract', version: '1' } })
  receipt.server = { protocolVersion: initialization.protocolVersion, serverInfo: initialization.serverInfo }
  const { tools } = await client.request('tools/list')
  const update = tools.find(tool => tool.name === 'mem_update')
  assert(update, 'Candidate must expose its update API')
  receipt.updateSchema = update.inputSchema
  receipt.historyToolNames = tools.filter(tool => /history|revision/.test(tool.name)).map(tool => tool.name)
  const saved = await client.call('mem_save', { title: 'Contract decision', content: 'original fixture decision', type: 'decision', capture_prompt: false })
  assert(!saved.isError, JSON.stringify(saved))
  const id = JSON.parse(saved.content.find(item => item.type === 'text').text).id
  assert(Number.isSafeInteger(id) && id > 0, 'Saved observation must contain its integer ID')
  const first = await client.call('mem_update', { id, content: 'first writer decision', expectedRevision: 1 })
  assert(!first.isError, JSON.stringify(first))
  const stale = await client.call('mem_update', { id, content: 'stale writer decision', expectedRevision: 1 })
  receipt.staleWriteAccepted = !stale.isError
  await client.stop()
  client = start('donwells-contract-a')
  await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'donwells-contract-reader', version: '1' } })
  const recalled = await client.call('mem_get_observation', { id })
  receipt.staleWriteSurvivesRestart = JSON.stringify(recalled).includes('stale writer decision')
  assert(receipt.staleWriteAccepted && receipt.staleWriteSurvivesRestart, 'Candidate behavior changed: reconsider the recorded incompatibility')
  receipt.authorityDecision = 'Reject this candidate API as the authoritative backend: stale expectedRevision is ignored and overwrites newer content.'
} finally {
  if (client) await client.stop()
  receipt.durationMs = Math.round(performance.now() - started)
  await rm(root, { recursive: true, force: true })
  receipt.disposableProfileRemoved = true
  await writeFile(evidence, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
}
console.log(receipt.authorityDecision)
