import { afterEach, describe, expect, it } from 'vitest'
import { symlinkSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

describe('daemon-owned finite agent runs', () => {
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
    expect(stopping).toMatchObject({ liveness: 'live', activity: 'stopping' })
    await expect(second.writeAgent(started.run.sessionId, 'too late')).rejects.toThrow(/activity is stopping/)
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
