// @vitest-environment node
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { afterEach, describe, expect, it } from 'vitest'
import { localRuntimePaths, readRuntimeRecord } from './local-runtime'
import { TerminalDaemon } from './terminal-daemon'

/**
 * The production provider-instance launch (Task 4, step 4).
 *
 * The renderer names a workspace and an instance and nothing else. Everything
 * else — the authenticated worker identity, the launch's own task, the lease,
 * the Catalog preparation, the maintenance admission, and the spawn — is derived
 * by the daemon. These drive the real wire op against a real daemon and a real
 * child process.
 */

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
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  let greeted = false
  let settled = false
  let timer: NodeJS.Timeout | undefined
  const requestId = `probe-${op}`
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
    buffer += decoder.write(chunk)
    let newline: number
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line.trim()) continue
      let message: Record<string, unknown>
      try { message = JSON.parse(line) as Record<string, unknown> } catch { continue }
      // The daemon greets with its capability list; the op is only sent after
      // that handshake, which is what the established probe does.
      if (!greeted && message['capabilities'] !== undefined) {
        greeted = true
        socket.write(JSON.stringify({ id: requestId, op, ...params }) + '\n')
        continue
      }
      if (greeted && message['id'] === requestId) finish(undefined, message)
    }
  })
  timer = setTimeout(() => finish(new Error(`no reply to ${op}`)), 20_000)
  return completion.promise
}

/** The instance ids a catalog snapshot reply carried. */
function instanceIds(snapshot: unknown): string[] {
  if (typeof snapshot !== 'object' || snapshot === null) return []
  const instances = (snapshot as Record<string, unknown>)['instances']
  if (!Array.isArray(instances)) return []
  return instances.flatMap(entry => {
    if (typeof entry !== 'object' || entry === null) return []
    const id = (entry as Record<string, unknown>)['id']
    return typeof id === 'string' ? [id] : []
  })
}

/** A daemon over an isolated profile whose registry publishes one workspace. */
async function startDaemon(projects: readonly { projectId: string; repositoryId: string; workspaceRoot: string }[]): Promise<{ socketPath: string; token: string }> {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'provider-launch-')))
  directories.push(directory)
  // The daemon validates this directory before it publishes runtime files.
  mkdirSync(join(directory, 'terminal-daemon'), { recursive: true, mode: 0o700 })
  const token = 'provider-launch-token-1234567890'
  const daemon = new TerminalDaemon({
    userDataDir: directory,
    authToken: token,
    projectRegistry: async () => projects
  })
  daemons.push(daemon)
  await daemon.start()
  const locator = readRuntimeRecord(localRuntimePaths(directory, 'terminal').runtimeFile)
  if (locator.status !== 'current') throw new Error('terminal locator was not published')
  return { socketPath: locator.record.socketPath, token }
}

/** A workspace directory plus the project registry entry naming it. */
function workspace(): { root: string; project: { projectId: string; repositoryId: string; workspaceRoot: string } } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'provider-workspace-')))
  directories.push(root)
  return { root, project: { projectId: 'project-provider', repositoryId: 'repo-provider', workspaceRoot: root } }
}

/** Creates one external custom-command instance and returns its id. */
async function createInstance(started: { socketPath: string; token: string }, input: Record<string, unknown>): Promise<string> {
  const created = await callWireOp(started.socketPath, started.token, 'agent.providers.create', { input })
  if (created['ok'] !== true) throw new Error('create failed: ' + JSON.stringify(created))
  const id = instanceIds(created['snapshot'])[0]
  if (id === undefined) throw new Error('no instance was created')
  return id
}

describe('provider instance launch over the daemon wire', () => {
  it('launches an external instance as a real child with instance provenance', async () => {
    const { root, project } = workspace()
    // An external shell program: no credential and no broker, so this proves the
    // lease/preparation/admission/spawn path without Secret Authority.
    const script = join(root, 'child.cjs')
    writeFileSync(script, 'setTimeout(() => {}, 5000)', { mode: 0o600 })
    const started = await startDaemon([project])
    const instanceId = await createInstance(started, {
      driverId: 'custom-command',
      displayName: 'Explicit child',
      command: { kind: 'external-shell', program: `${process.execPath} ${script}` },
      credentialMode: 'external',
      accountId: null,
      enabled: true
    })

    const launched = await callWireOp(started.socketPath, started.token, 'agent.providers.launch', {
      workspacePath: root,
      providerInstanceId: instanceId
    })

    if (launched['ok'] !== true) throw new Error('launch refused: ' + JSON.stringify({ error: launched['error'], code: launched['code'] }))
    const run = launched['run'] as Record<string, unknown>
    const provider = run['provider'] as Record<string, unknown>
    // The run names the exact admitted instance, never a command family.
    expect(provider).toMatchObject({ providerInstanceId: instanceId, driverId: 'custom-command' })
    // Identity and display facts only: no credential material crosses the wire.
    expect(provider).not.toHaveProperty('credentialRef')
    expect(provider).not.toHaveProperty('bindingGeneration')
    expect(run['liveness']).toBe('live')
  })

  it('refuses a launch naming an instance that does not exist, creating no child', async () => {
    const { root, project } = workspace()
    const started = await startDaemon([project])

    const launched = await callWireOp(started.socketPath, started.token, 'agent.providers.launch', {
      workspacePath: root,
      providerInstanceId: 'inst-does-not-exist'
    })

    expect(launched['ok']).toBe(false)
    expect(String(launched['error'])).toMatch(/not found|no longer exists/i)
  })

  it('refuses a launch in a workspace that is not a registered project', async () => {
    const { project } = workspace()
    const other = realpathSync.native(mkdtempSync(join(tmpdir(), 'provider-unregistered-')))
    directories.push(other)
    const started = await startDaemon([project])
    const instanceId = await createInstance(started, {
      driverId: 'custom-command',
      displayName: 'Child',
      command: { kind: 'external-shell', program: process.execPath },
      credentialMode: 'external',
      accountId: null,
      enabled: true
    })

    const launched = await callWireOp(started.socketPath, started.token, 'agent.providers.launch', {
      workspacePath: other,
      providerInstanceId: instanceId
    })

    // An unregistered workspace is never an admitted provider target.
    expect(launched['ok']).toBe(false)
    expect(String(launched['error'])).toMatch(/registered project/i)
  })

  it('refuses a disabled instance rather than silently falling back to another', async () => {
    const { root, project } = workspace()
    const started = await startDaemon([project])
    const instanceId = await createInstance(started, {
      driverId: 'custom-command',
      displayName: 'Disabled child',
      command: { kind: 'external-shell', program: process.execPath },
      credentialMode: 'external',
      accountId: null,
      enabled: false
    })

    const launched = await callWireOp(started.socketPath, started.token, 'agent.providers.launch', {
      workspacePath: root,
      providerInstanceId: instanceId
    })

    expect(launched['ok']).toBe(false)
    expect(String(launched['error'])).toMatch(/disabled/i)
  })
})
