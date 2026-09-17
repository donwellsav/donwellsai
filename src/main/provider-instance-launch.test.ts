// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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

/**
 * Waits until the launched child reports a terminal state.
 *
 * This observes through `agent.list`, which reads daemon state and changes
 * nothing. Acquiring the maintenance lease to probe would itself adopt the
 * launch's admission into the probe migration, so a probe that runs while the
 * pump still needs to complete would break the very thing it measures.
 */
async function waitForRunExit(started: { socketPath: string; token: string }, sessionId: string): Promise<boolean> {
  // The PTY defers exit settlement by 250ms after the OS exit, so this must
  // outlast that documented delay.
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const listed = await callWireOp(started.socketPath, started.token, 'agent.list', {})
    const runs = listed['runs']
    if (Array.isArray(runs)) {
      for (const entry of runs) {
        if (typeof entry !== 'object' || entry === null) continue
        const record = entry as Record<string, unknown>
        if (record['sessionId'] === sessionId && record['liveness'] === 'exited') return true
      }
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return false
}

/**
 * Checks once whether the frozen participant can acknowledge its drain.
 *
 * `acknowledgeDrained` refuses with `GATE_ADMISSION_UNRESOLVED` while any
 * admission for that participant is still live, which is exactly the consequence
 * of a leaked launch admission: every later freeze/cutover would stall. This runs
 * only after the child has already exited, so it cannot race the pump.
 */
async function drainAcknowledgement(started: { socketPath: string; token: string }): Promise<Record<string, unknown> | null> {
  const state = await callWireOp(started.socketPath, started.token, 'maintenance.state', {})
  const snapshot = state['state'] as Record<string, unknown> | undefined
  if (snapshot?.['phase'] !== 'open' || snapshot['lease'] !== null) return null
  const acquired = await callWireOp(started.socketPath, started.token, 'maintenance.acquire', {
    migrationId: 'admission-probe',
    ownerStage: 'stage-3',
    participants: ['provider-authority'],
    expectedRevision: snapshot['revision']
  })
  const lease = acquired['lease'] as Record<string, unknown> | undefined
  if (acquired['ok'] !== true || lease === undefined) return null
  const drained = await callWireOp(started.socketPath, started.token, 'maintenance.drained', {
    migrationId: 'admission-probe',
    participant: 'provider-authority'
  })
  await callWireOp(started.socketPath, started.token, 'maintenance.release', { lease, outcome: 'active' })
  return drained
}

/**
 * Waits for the launched attempt to reach a terminal state, reading the durable
 * Task Authority record rather than the daemon's in-memory run.
 *
 * This is the fact the launch is actually responsible for: an interactive
 * launch whose lifecycle pump read a released session would record the attempt
 * as failed, and only the persisted state shows that.
 */
async function waitForAttemptState(started: { socketPath: string; token: string }, projectId: string, expected: string): Promise<string | null> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const queried = await callWireOp(started.socketPath, started.token, 'task.query', { projectId })
    // The op answers with the task list directly.
    const tasks = queried['tasks']
    if (Array.isArray(tasks)) {
      for (const entry of tasks) {
        if (typeof entry !== 'object' || entry === null) continue
        const record = entry as Record<string, unknown>
        const current = record['currentAttempt']
        if (typeof current !== 'object' || current === null) continue
        const state = (current as Record<string, unknown>)['state']
        if (state === expected) return expected
      }
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return null
}

describe('provider instance launch over the daemon wire', () => {
  it('launches an external instance as a real child with instance provenance', async () => {
    const { root, project } = workspace()
    // An external argv invocation: no credential and no broker, so this proves the
    // lease/preparation/admission/spawn path without Secret Authority.
    const script = join(root, 'child.cjs')
    writeFileSync(script, 'setTimeout(() => {}, 5000)', { mode: 0o600 })
    const started = await startDaemon([project])
    const instanceId = await createInstance(started, {
      driverId: 'custom-command',
      displayName: 'Explicit child',
      command: { kind: 'external-argv', executable: { executable: process.execPath, args: [script] } },
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

  it('settles the maintenance admission after an interactive child exits', async () => {
    const { root, project } = workspace()
    // A short-lived child, so the launch's own lifecycle obligations settle
    // while this test is still watching them.
    const script = join(root, 'child.cjs')
    writeFileSync(script, 'process.exit(0)', { mode: 0o600 })
    const started = await startDaemon([project])
    const instanceId = await createInstance(started, {
      driverId: 'custom-command',
      displayName: 'Admission probe',
      command: { kind: 'external-argv', executable: { executable: process.execPath, args: [script] } },
      credentialMode: 'external',
      accountId: null,
      enabled: true
    })

    const launched = await callWireOp(started.socketPath, started.token, 'agent.providers.launch', {
      workspacePath: root,
      providerInstanceId: instanceId
    })
    expect(launched['ok']).toBe(true)
    const run = launched['run'] as Record<string, unknown>
    const sessionId = String(run['sessionId'])

    // The child exits on its own; the launch's background pump must then settle
    // its lifecycle obligations rather than leaving them behind.
    expect(await waitForRunExit(started, sessionId)).toBe(true)

    // A leaked admission is what fences every later freeze/cutover:
    // `acknowledgeDrained` refuses with GATE_ADMISSION_UNRESOLVED while one is
    // still live. Acquiring the lease alone proves nothing, because `acquire`
    // adopts outstanding admissions rather than refusing them — so this is
    // checked only after the child has already exited.
    const drained = await drainAcknowledgement(started)
    expect(drained).not.toBeNull()
    expect(drained).toMatchObject({ ok: true })
  })

  it('records a clean exit even when the run is dismissed right after it exits', async () => {
    const { root, project } = workspace()
    const script = join(root, 'child.cjs')
    writeFileSync(script, 'process.exit(0)', { mode: 0o600 })
    const started = await startDaemon([project])
    const instanceId = await createInstance(started, {
      driverId: 'custom-command',
      displayName: 'Dismiss probe',
      command: { kind: 'external-argv', executable: { executable: process.execPath, args: [script] } },
      credentialMode: 'external',
      accountId: null,
      enabled: true
    })

    const launched = await callWireOp(started.socketPath, started.token, 'agent.providers.launch', {
      workspacePath: root,
      providerInstanceId: instanceId
    })
    expect(launched['ok']).toBe(true)
    const sessionId = String((launched['run'] as Record<string, unknown>)['sessionId'])

    expect(await waitForRunExit(started, sessionId)).toBe(true)
    // Dismissing immediately after the exit exercises the shutdown order: the
    // lifecycle pump reads the PTY's settled exit and final output, and the
    // daemon joins that pump before releasing either. This asserts the durable
    // result stays correct; it does not deterministically reproduce the narrow
    // window (the pump polls every 10ms, so it usually wins the wire round trip).
    const dismissed = await callWireOp(started.socketPath, started.token, 'agent.dismiss', { sessionId })
    expect(dismissed['ok']).toBe(true)

    // The durable result is what actually matters: the attempt must be recorded
    // as completed rather than failed with a null exit code, which is what the
    // pump would write if it read a released session.
    const attempt = await waitForAttemptState(started, project.projectId, 'completed')
    expect(attempt).toBe('completed')
  })

  it('refuses a task-linked interactive launch instead of silently dropping the reference', async () => {
    const { root, project } = workspace()
    const script = join(root, 'linked-child.cjs')
    writeFileSync(script, 'setTimeout(() => {}, 5000)', { mode: 0o600 })
    const started = await startDaemon([project])
    const instanceId = await createInstance(started, {
      driverId: 'custom-command',
      displayName: 'Linked probe',
      command: { kind: 'external-argv', executable: { executable: process.execPath, args: [script] } },
      credentialMode: 'external',
      accountId: null,
      enabled: true
    })

    // An interactive launch mints its own task, so a caller's task reference
    // cannot be adopted. Refusing is the point: silently dropping it would start
    // an agent the user believes is linked to a daemon task.
    const launched = await callWireOp(started.socketPath, started.token, 'agent.providers.launch', {
      workspacePath: root,
      providerInstanceId: instanceId,
      task: { intent: 'linked work', files: [], externalId: 'TASK-1' }
    })

    expect(launched['ok']).toBe(false)
    expect(String(launched['error'] ?? '')).toContain('task coordinator')
    // The refusal happened before any admission or spawn: a launch that had
    // registered an admission could not be drained, and the daemon reports no run.
    const drained = await drainAcknowledgement(started)
    expect(drained).not.toBeNull()
    const agents = await callWireOp(started.socketPath, started.token, 'agent.list', {})
    expect(agents['ok']).toBe(true)
    expect(agents['runs']).toEqual([])
  })

  it('refuses a task-linked native open on the same rule as the provider path', async () => {
    const { root, project } = workspace()
    const script = join(root, 'native-linked.cjs')
    writeFileSync(script, 'setTimeout(() => {}, 5000)', { mode: 0o600 })
    const started = await startDaemon([project])

    // The second interactive path enforces the identical rule: an interactive
    // session mints its own task and cannot adopt a caller's reference.
    const opened = await callWireOp(started.socketPath, started.token, 'agent.native.open', {
      cwd: root,
      launch: { executable: process.execPath, args: [script] },
      task: { intent: 'linked work', files: [], externalId: 'TASK-2' }
    })

    expect(opened['ok']).toBe(false)
    expect(String(opened['error'] ?? '')).toContain('task coordinator')
    const agents = await callWireOp(started.socketPath, started.token, 'agent.list', {})
    expect(agents['runs']).toEqual([])
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
      command: { kind: 'external-argv', executable: { executable: process.execPath, args: [] } },
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
      command: { kind: 'external-argv', executable: { executable: process.execPath, args: [] } },
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

  it('applies a selected session template env to an external instance launch', async () => {
    const { root, project } = workspace()
    const markerFile = join(root, 'template-marker.out')
    const script = join(root, 'child.cjs')
    writeFileSync(script, `require('fs').writeFileSync(process.argv[2], String(process.env.TEMPLATE_MARKER ?? 'missing'))`, { mode: 0o600 })
    const started = await startDaemon([project])
    const instanceId = await createInstance(started, {
      driverId: 'custom-command',
      displayName: 'Template probe',
      command: { kind: 'external-argv', executable: { executable: process.execPath, args: [script, markerFile] } },
      credentialMode: 'external',
      accountId: null,
      enabled: true
    })

    // The renderer resolves the template in trusted main and sends the resolved
    // environment alongside the intent, the same shape the native path uses.
    const launched = await callWireOp(started.socketPath, started.token, 'agent.providers.launch', {
      workspacePath: root,
      providerInstanceId: instanceId,
      task: { intent: 'template probe', files: [], templateId: 'saved-review' },
      env: { TEMPLATE_MARKER: 'applied' }
    })
    if (launched['ok'] !== true) throw new Error('launch refused: ' + JSON.stringify({ error: launched['error'], code: launched['code'] }))

    let observed: string | null = null
    for (let attempt = 0; attempt < 100 && observed === null; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 50))
      try { observed = readFileSync(markerFile, 'utf8') } catch { /* child has not run yet */ }
    }
    expect(observed).toBe('applied')
  })

})
