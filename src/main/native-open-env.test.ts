// @vitest-environment node
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { localRuntimePaths, readRuntimeRecord } from './local-runtime'
import { TerminalDaemon } from './terminal-daemon'

const directories: string[] = []
const daemons: TerminalDaemon[] = []

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stopIfIdle().catch(() => undefined)
  while (directories.length > 0) rmSync(directories.pop() as string, { recursive: true, force: true })
})

/** One raw wire round trip on a freshly authenticated connection. */
function callWireOp(socketPath: string, authToken: string, op: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const completion = Promise.withResolvers<Record<string, unknown>>()
  const socket = createConnection(socketPath)
  let buffer = ''
  let greeted = false
  let settled = false
  let timer: NodeJS.Timeout | undefined
  const finish = (error?: Error, message?: Record<string, unknown>): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    socket.removeAllListeners()
    socket.destroy()
    if (error) completion.reject(error)
    else completion.resolve(message as Record<string, unknown>)
  }
  socket.once('error', error => finish(error))
  socket.once('connect', () => socket.write(JSON.stringify({ id: 'hello', op: 'hello', authToken }) + '\n'))
  socket.on('data', chunk => {
    buffer += chunk
    let newline: number
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line.trim()) continue
      let message: Record<string, unknown>
      try { message = JSON.parse(line) as Record<string, unknown> } catch { continue }
      if (!greeted && message['capabilities'] !== undefined) {
        greeted = true
        socket.write(JSON.stringify({ id: 'probe', op, ...params }) + '\n')
        continue
      }
      if (greeted && message['id'] === 'probe') finish(undefined, message)
    }
  })
  timer = setTimeout(() => finish(new Error(`no reply to ${op}`)), 20_000)
  return completion.promise
}

it('applies the wire env to a native-open child', async () => {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'native-open-env-')))
  directories.push(directory)
  mkdirSync(join(directory, 'terminal-daemon'), { recursive: true, mode: 0o700 })
  const workspace = realpathSync.native(mkdtempSync(join(tmpdir(), 'native-open-ws-')))
  directories.push(workspace)
  const token = 'native-open-env-token-123456'
  const daemon = new TerminalDaemon({
    userDataDir: directory,
    authToken: token,
    projectRegistry: async () => [{ projectId: 'project-native', repositoryId: 'repo-native', workspaceRoot: workspace }]
  })
  daemons.push(daemon)
  await daemon.start()
  const locator = readRuntimeRecord(localRuntimePaths(directory, 'terminal').runtimeFile)
  if (locator.status !== 'current') throw new Error('terminal locator was not published')

  const markerFile = join(workspace, 'marker.out')
  const script = join(workspace, 'child.cjs')
  writeFileSync(script, `require('fs').writeFileSync(process.argv[2], String(process.env.TEMPLATE_MARKER ?? 'missing'))`, { mode: 0o600 })

  const result = await callWireOp(locator.record.socketPath, token, 'agent.native.open', {
    cwd: workspace,
    launch: { executable: process.execPath, args: [script, markerFile] },
    env: { TEMPLATE_MARKER: 'applied' }
  })
  if (result['ok'] !== true) throw new Error('native open refused: ' + JSON.stringify(result))

  // The child must observe the caller-supplied environment. The PTY merges
  // additions over the daemon's inherited environment, so the marker proves
  // the wire env actually reached the child rather than being dropped.
  let observed: string | null = null
  for (let attempt = 0; attempt < 100 && observed === null; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 50))
    try { observed = readFileSync(markerFile, 'utf8') } catch { /* child has not run yet */ }
  }
  expect(observed).toBe('applied')
})
