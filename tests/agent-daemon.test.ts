import { afterEach, describe, expect, it } from 'vitest'
import { symlinkSync, existsSync, mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { once } from 'node:events'
import { localRuntimePaths } from '../src/main/local-runtime'
import { setTimeout as delay } from 'node:timers/promises'
import type { RunningAgent } from '../src/shared/agent-runtime'
import type { AttentionInboxEntry } from '../src/shared/attention-inbox'
import { DaemonClient, type DaemonEvents } from '../src/main/daemon-client'
import { TerminalDaemon } from '../src/main/terminal-daemon'

const directories: string[] = []
const clients: DaemonClient[] = []
const daemons: TerminalDaemon[] = []
const fixture = join(import.meta.dirname, 'fixtures', 'agent-job.cjs')

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function fixtureCommand(mode: string, ...args: string[]): string {
  return [process.execPath, fixture, mode, ...args].map(quoteShell).join(' ')
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('condition was not met before timeout')
    await delay(25)
  }
}

async function waitForAgent(
  client: DaemonClient,
  sessionId: string,
  check: (run: RunningAgent) => boolean,
  timeoutMs = 5_000
): Promise<RunningAgent> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const run = await client.agentStatus(sessionId)
    if (check(run)) return run
    await delay(25)
  }
  throw new Error('agent state was not reached before timeout')
}

function eventCapture(): {
  events: DaemonEvents
  runs: RunningAgent[]
  dismissed: string[]
  output: Map<string, string>
} {
  const runs: RunningAgent[] = []
  const dismissed: string[] = []
  const output = new Map<string, string>()
  return {
    runs,
    dismissed,
    output,
    events: {
      data: (sessionId, data) => output.set(sessionId, (output.get(sessionId) ?? '') + data),
      exit: () => {},
      title: () => {},
      agent: (run) => runs.push(run),
      agentDismissed: (sessionId) => dismissed.push(sessionId)
    }
  }
}

function daemonClient(userDataDir: string, events: DaemonEvents): DaemonClient {
  const client = new DaemonClient(userDataDir, events, join(userDataDir, 'unused-daemon-entry.js'))
  clients.push(client)
  return client
}

async function disposableDaemon(): Promise<{
  daemon: TerminalDaemon
  userDataDir: string
  workspacePath: string
}> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'donwells-agent-daemon-'))
  const workspacePath = join(userDataDir, 'workspace')
  mkdirSync(workspacePath)
  directories.push(userDataDir)
  const daemon = new TerminalDaemon({ userDataDir, authToken: 'fixture-daemon-token' })
  daemons.push(daemon)
  await daemon.start()
  return { daemon, userDataDir, workspacePath }
}

async function reconcileAndStop(daemon: TerminalDaemon, client: DaemonClient): Promise<void> {
  const runs = await client.listAgents().catch(() => [])
  for (const run of runs) {
    if (run.liveness !== 'exited') await client.interruptAgent(run.sessionId).catch(() => {})
  }
  for (const run of runs) {
    const exited = await waitForAgent(client, run.sessionId, (current) => current.liveness === 'exited', 3_000)
      .catch(() => undefined)
    if (exited) await client.dismissAgent(run.sessionId).catch(() => {})
  }
  await daemon.stopIfIdle()
}

afterEach(async () => {
  for (const daemon of daemons.splice(0)) {
    const userDataDir = directories.find((directory) => directory.includes('donwells-agent-daemon-'))
    if (userDataDir) {
      const cleanupClient = daemonClient(userDataDir, eventCapture().events)
      await reconcileAndStop(daemon, cleanupClient).catch(() => {})
    }
  }
  for (const client of clients.splice(0)) client.disconnect()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

it('stops native agent children that survive their parent and ignore hangup', async () => {
  const { userDataDir, workspacePath } = await disposableDaemon()
  const capture = eventCapture(), client = daemonClient(userDataDir, capture.events)
  const heartbeat = join(workspacePath, 'child-heartbeat')
  const childCode = `process.on('SIGHUP',()=>{}); const fs=require('node:fs'); setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'.'),25); setTimeout(()=>process.exit(),3000)`
  const code = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'inherit'}); setInterval(()=>{},1000)`
  const started = await client.startAgent(workspacePath, 'agent with child', undefined, { executable: process.execPath, args: ['-e', code] })
  await waitFor(() => existsSync(heartbeat))
  await client.stopAgent(started.session.id)
  const stopped = readFileSync(heartbeat, 'utf8')
  await delay(150)
  expect(readFileSync(heartbeat, 'utf8')).toBe(stopped)
})

it('stops a native TUI that consumes Ctrl-C and retains its output until dismissal', async () => {
  const { daemon, userDataDir, workspacePath } = await disposableDaemon()
  const capture = eventCapture()
  const client = daemonClient(userDataDir, capture.events)
  expect(typeof client.stopAgent).toBe('function')
  const launch = { executable: process.execPath, args: ['-e', 'process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on("data",()=>{}); process.on("SIGHUP",()=>{}); console.log("TUI_READY"); setTimeout(()=>process.exit(0),20000)'] }
  const started = await client.startAgent(workspacePath, 'native TUI fixture', undefined, launch)
  await waitFor(() => capture.output.get(started.session.id)?.includes('TUI_READY') ?? false)
  await client.interruptAgent(started.session.id)
  await delay(50)
  expect((await client.agentStatus(started.session.id)).liveness).toBe('live')
  const stopped = await client.stopAgent(started.session.id)
  expect(stopped.liveness).toBe('exited')
  await expect(client.writeAgent(started.session.id, 'late')).rejects.toThrow(/liveness is exited/)
  expect((await client.attach(started.session.id)).scrollback).toContain('TUI_READY')
  await client.dismissAgent(started.session.id)
  expect(await daemon.stopIfIdle()).toBe(true)
})

describe('daemon-owned finite agent runs', () => {
  it('authenticates the inherited session credential without exposing it in agent records', async () => {
    const { daemon, userDataDir, workspacePath } = await disposableDaemon()
    const client = daemonClient(userDataDir, eventCapture().events)
    const path = join(userDataDir, 'binding.json')
    const started = await client.startAgent(workspacePath, fixtureCommand('binding', path))
    await waitFor(() => existsSync(path))
    const binding = JSON.parse(readFileSync(path, 'utf8'))
    expect((await client.authenticateAgent(binding)).sessionId).toBe(started.run.sessionId)
    expect(JSON.stringify(await client.listAgents()).includes(binding.token)).toBe(false)
    await expect(client.authenticateAgent({ ...binding, token: 'wrong' })).rejects.toThrow('Invalid agent session credential')
    await expect(client.authenticateAgent({ ...binding, sessionId: 'another' })).rejects.toThrow('Invalid agent session credential')
    await client.stopAgent(started.run.sessionId)
    await waitForAgent(client, started.run.sessionId, run => run.liveness === 'exited')
    await expect(client.authenticateAgent(binding)).rejects.toThrow('Invalid agent session credential')
    await client.dismissAgent(started.run.sessionId)
    expect(await daemon.stopIfIdle()).toBe(true)
  })

  it('authenticates scoped hook events, rejects a wrong token, and never exposes daemon authority', async () => {
    const { daemon, userDataDir, workspacePath } = await disposableDaemon()
    const capture = eventCapture()
    const client = daemonClient(userDataDir, capture.events)

    const valid = await client.startAgent(workspacePath, fixtureCommand('hook'))
    const completed = await waitForAgent(client, valid.run.sessionId, (run) => run.liveness === 'exited')
    expect(completed).toMatchObject({ liveness: 'exited', activity: 'completed', exitCode: 0 })
    expect(capture.runs).toContainEqual(expect.objectContaining({
      sessionId: valid.run.sessionId,
      activity: 'permission',
      detail: 'fixture permission ✓',
      hook: expect.objectContaining({ connected: true })
    }))
    const successfulAttention = await client.attentionInboxList()
    expect(successfulAttention.available).toBe(true)
    if (!successfulAttention.available) throw new Error('attention capability unavailable in current daemon')
    expect(successfulAttention.snapshot.entries
      .filter((entry: AttentionInboxEntry) => entry.sessionId === valid.run.sessionId)
      .map((entry: AttentionInboxEntry) => entry.kind)).toEqual(['completed', 'permission'])
    const attached = await client.attach(valid.run.sessionId)
    expect(attached.scrollback).toContain('DAEMON_TOKEN_VISIBLE=no')
    await client.dismissAgent(valid.run.sessionId)

    const rejected = await client.startAgent(workspacePath, fixtureCommand('wrong-hook'))
    const failed = await waitForAgent(client, rejected.run.sessionId, (run) => run.liveness === 'exited')
    expect(failed).toMatchObject({ liveness: 'exited', activity: 'failed' })
    expect(failed.exitCode).not.toBe(0)
    expect(failed.hook.connected).toBe(false)
    await client.dismissAgent(rejected.run.sessionId)

    expect(await daemon.stopIfIdle()).toBe(true)
    daemons.splice(daemons.indexOf(daemon), 1)
  }, 15_000)

  it('admits input only to a live working owner and rejects permission, exited, and missing sessions', async () => {
    const { daemon, userDataDir, workspacePath } = await disposableDaemon()
    const capture = eventCapture()
    const client = daemonClient(userDataDir, capture.events)
    const started = await client.startAgent(workspacePath, fixtureCommand('input'))
    await waitFor(() => (capture.output.get(started.run.sessionId) ?? '').includes('AGENT_READY'))

    const paste = '\x1b[200~owner-bound payload\x1b[201~'
    await client.writeAgent(started.run.sessionId, paste)
    await delay(100)
    expect(capture.output.get(started.run.sessionId)).not.toContain('AGENT_INPUT=')
    await client.writeAgent(started.run.sessionId, '\r')
    await waitFor(() => (capture.output.get(started.run.sessionId) ?? '').includes('AGENT_INPUT='))
    await waitForAgent(client, started.run.sessionId, (run) => run.liveness === 'exited')
    await expect(client.writeAgent(started.run.sessionId, 'late')).rejects.toThrow(/liveness is exited/)
    await client.dismissAgent(started.run.sessionId)
    await expect(client.writeAgent(started.run.sessionId, 'missing')).rejects.toThrow(/unknown agent session/)

    const gated = await client.startAgent(workspacePath, fixtureCommand('permission-wait'))
    await waitForAgent(client, gated.run.sessionId, (run) => run.activity === 'permission')
    await expect(client.writeAgent(gated.run.sessionId, 'denied')).rejects.toThrow(/activity is permission/)
    await client.interruptAgent(gated.run.sessionId)
    await waitForAgent(client, gated.run.sessionId, (run) => run.liveness === 'exited')
    await client.dismissAgent(gated.run.sessionId)

    expect(await daemon.stopIfIdle()).toBe(true)
    daemons.splice(daemons.indexOf(daemon), 1)
  }, 15_000)

  it('survives client replacement, interrupts safely, proves exit, and dismisses explicitly', async () => {
    const { daemon, userDataDir, workspacePath } = await disposableDaemon()
    const marker = join(userDataDir, 'continued-marker')
    const firstCapture = eventCapture()
    const first = daemonClient(userDataDir, firstCapture.events)
    const started = await first.startAgent(workspacePath, fixtureCommand('wait', marker))
    await waitFor(() => (firstCapture.output.get(started.run.sessionId) ?? '').includes('AGENT_READY'))
    await expect(first.dismissAgent(started.run.sessionId)).rejects.toThrow(/still live or unverifiable/)

    first.disconnect()
    const secondCapture = eventCapture()
    const second = daemonClient(userDataDir, secondCapture.events)
    const restored = await second.listAgents()
    expect(restored).toMatchObject([{
      sessionId: started.run.sessionId,
      liveness: 'live',
      activity: 'working'
    }])

    const stopping = await second.interruptAgent(started.run.sessionId)
    expect(stopping).toMatchObject({ liveness: 'live', activity: 'working', detail: 'Interrupt sent; the native process may remain open.' })
    const exited = await waitForAgent(second, started.run.sessionId, (run) => run.liveness === 'exited')
    expect(exited).toMatchObject({
      liveness: 'exited',
      activity: 'completed',
      detail: 'Stopped by user',
      stopRequestedAt: expect.any(String)
    })
    await delay(1_700)
    expect(existsSync(marker)).toBe(false)

    const beforeRestart = await second.attentionInboxList()
    expect(beforeRestart.available).toBe(true)
    if (!beforeRestart.available) throw new Error('attention capability unavailable in current daemon')
    const retainedEvent = beforeRestart.snapshot.entries.find((entry: AttentionInboxEntry) => (
      entry.sessionId === started.run.sessionId && entry.kind === 'failed'
    ))
    if (!retainedEvent) throw new Error('missing retained attention event: ' + JSON.stringify(beforeRestart.snapshot.entries))
    expect(retainedEvent).toMatchObject({
      currentLiveness: 'exited',
      terminalAvailability: 'retained'
    })
    expect(retainedEvent.acknowledgedAt).toBeUndefined()

    second.disconnect()
    const thirdCapture = eventCapture()
    const third = daemonClient(userDataDir, thirdCapture.events)
    const afterRestart = await third.attentionInboxList()
    expect(afterRestart.available).toBe(true)
    if (!afterRestart.available || !retainedEvent) throw new Error('durable attention event unavailable after reconnect')
    expect(afterRestart.snapshot.entries.find((entry: AttentionInboxEntry) => entry.id === retainedEvent.id)).toEqual(retainedEvent)
    const acknowledgement = await third.attentionInboxAcknowledge({
      eventId: retainedEvent.id,
      eventVersion: retainedEvent.version
    })
    expect(acknowledgement).toMatchObject({ available: true, outcome: 'acknowledged' })
    if (!acknowledgement.available) throw new Error('attention acknowledgement unavailable')
    expect(acknowledgement.snapshot.unreadCount).toBe(0)

    await third.dismissAgent(started.run.sessionId)
    expect(await third.listAgents()).toEqual([])
    expect(thirdCapture.dismissed).toContain(started.run.sessionId)
    expect(await daemon.stopIfIdle()).toBe(true)
    daemons.splice(daemons.indexOf(daemon), 1)
  }, 15_000)
})

it('runs explicit executable arguments literally through a real PTY', async () => {
  const { daemon, userDataDir, workspacePath } = await disposableDaemon()
  const capture = eventCapture(), client = daemonClient(userDataDir, capture.events)
  const executable = join(workspacePath, 'native agent 节点')
  symlinkSync(process.execPath, executable)
  const sentinel = join(workspacePath, 'must-not-exist')
  const args = ['two words', '', `$(touch ${sentinel})`, '; punctuation', 'é 世界']
  const launch = { executable, args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...args] }
  const started = await client.startAgent(workspacePath, JSON.stringify(launch), undefined, launch)
  const run = await waitForAgent(client, started.run.sessionId, current => current.liveness === 'exited')
  expect(run.exitCode).toBe(0)
  const attached = await client.attach(started.run.sessionId)
  expect(attached.scrollback).toContain(JSON.stringify(args))
  expect(existsSync(sentinel)).toBe(false)
  await client.dismissAgent(started.run.sessionId)
  await daemon.stopIfIdle()
})

it('drops only paused output readers and reply readers while the PTY and healthy client survive', async () => {
  const { daemon, userDataDir, workspacePath } = await disposableDaemon()
  let outputBytes = 0, tail = ''
  const healthy = daemonClient(userDataDir, { data: (_id, data) => { outputBytes += Buffer.byteLength(data); tail = (tail + data).slice(-1024) }, exit: () => {}, title: () => {} })
  await healthy.list()
  const paused = async () => {
    const socket = connect(localRuntimePaths(userDataDir, 'terminal').socketPath)
    await once(socket, 'connect')
    const hello = once(socket, 'data')
    socket.write(JSON.stringify({ id: 'hello', op: 'hello', authToken: 'fixture-daemon-token' }) + '\n')
    expect(JSON.parse(String((await hello)[0])).ok).toBe(true)
    socket.on('error', () => {}) // A bounded server disconnect may surface as ECONNRESET.
    socket.pause()
    return socket
  }
  const slowOutput = await paused()
  let job: Awaited<ReturnType<DaemonClient['openJob']>> | undefined
  try {
    const code = "let n=0; const timer=setInterval(()=>{process.stdout.write('x'.repeat(65536));if(++n===512){clearInterval(timer);process.stdout.write('PRESSURE_DONE:'+process.pid+'\\n')}},2);process.stdin.on('data',()=>process.stdout.write('SAME_OWNER:'+process.pid+'\\n'))"
    job = await healthy.openJob(workspacePath, `${quoteShell(process.execPath)} -e ${quoteShell(code)}`)
    await waitFor(() => tail.includes('PRESSURE_DONE'), 15000)
    const pid = /PRESSURE_DONE:(\d+)/.exec(tail)?.[1]
    expect(pid).toBeTruthy()
    expect(outputBytes).toBeGreaterThan(32 * 1024 * 1024)
    // Resume only after pressure: a disconnected peer must observe EOF, not catch up indefinitely.
    let outputClosed = false
    slowOutput.on('close', () => { outputClosed = true }); slowOutput.resume()
    await waitFor(() => outputClosed)
    expect((await healthy.list()).find(session => session.id === job!.id)).toMatchObject({ id: job.id, createdAt: job.createdAt, exited: false })
    const replay = await healthy.attach(job.id)
    expect(replay.scrollback).toContain('PRESSURE_DONE'); expect(replay.truncated).toBe(true)
    const slowReplies = await paused()
    try {
      let replyClosed = false
      slowReplies.on('close', () => { replyClosed = true })
      slowReplies.write(Array.from({ length: 64 }, (_, n) => JSON.stringify({ id: `attach-${n}`, op: 'session.attach', sessionId: job!.id }) + '\n').join(''))
      await delay(250); slowReplies.resume()
      await waitFor(() => replyClosed)
      expect((await healthy.attach(job.id)).session.id).toBe(job.id)
    } finally { slowReplies.destroy() }
    const reconnected = daemonClient(userDataDir, { data: () => {}, exit: () => {}, title: () => {} })
    const attached = await reconnected.attach(job.id)
    expect(attached.session).toMatchObject({ id: job.id, createdAt: job.createdAt, exited: false })
    expect(attached.scrollback).toContain('PRESSURE_DONE')
    await reconnected.writeAcknowledged(job.id, 'still one owner\n')
    await waitFor(() => tail.includes(`SAME_OWNER:${pid}`))
    expect((await reconnected.list()).filter(session => session.id === job!.id)).toHaveLength(1)
  } finally {
    slowOutput.destroy()
    if (job) await healthy.close(job.id)
    expect(await daemon.stopIfIdle()).toBe(true)
    daemons.splice(daemons.indexOf(daemon), 1)
  }
}, 25000)
