// @vitest-environment node
import type { ChildProcess } from 'node:child_process'
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpServer, PromptResponse } from '@agentclientprotocol/sdk'
import type { AcpAgentSnapshot, AgentModeSwitchReceipt } from '@shared/agent-runtime'
import type {
  ProcessIdentity,
  ProcessIdentityVerdict,
  RuntimeExpectation,
  RuntimeIdentityAuthority
} from '@shared/child-process/process-spec'
import { AcpAgent, type AcpAgentOwner, type AcpAgentOwnerFactory } from './acp'
import { AcpSessions } from './acp-sessions'
import { TerminalDaemon } from '../terminal-daemon'

vi.mock('@agentclientprotocol/sdk', () => {
  class ClientSideConnection {
    readonly closed = new Promise<void>(() => {})
    initialize(): Promise<{ protocolVersion: number; agentCapabilities: { loadSession: boolean } }> {
      return Promise.resolve({ protocolVersion: 1, agentCapabilities: { loadSession: true } })
    }
    newSession(): Promise<{ sessionId: string }> { return Promise.resolve({ sessionId: 'protocol-history-new' }) }
    loadSession(): Promise<Record<string, never>> { return Promise.resolve({}) }
    prompt(): Promise<{ stopReason: 'end_turn' }> { return Promise.resolve({ stopReason: 'end_turn' }) }
    cancel(): Promise<Record<string, never>> { return Promise.resolve({}) }
  }
  return { ClientSideConnection, ndJsonStream: () => ({}) }
})

const terminationControl = vi.hoisted(() => ({ override: null as null | ((child: ChildProcess) => Promise<boolean>) }))

vi.mock('@shared/child-process/process-tree-termination', async importOriginal => {
  const actual = await importOriginal<typeof import('@shared/child-process/process-tree-termination')>()
  return {
    ...actual,
    forceTerminateProcessTree: (child: ChildProcess) => terminationControl.override?.(child) ?? actual.forceTerminateProcessTree(child)
  }
})

type VerdictKind = 'valid' | 'not-found' | 'pid-reused' | 'executable-mismatch' | 'access-denied' | 'native-error'
type ControlledAuthority = {
  authority: RuntimeIdentityAuthority
  setVerdict: (verdict: VerdictKind) => void
}
type FakeOwnerHarness = {
  factory: AcpAgentOwnerFactory
  snapshot: () => AcpAgentSnapshot
  setState: (state: AcpAgentSnapshot['state']) => void
  setProcessIdentity: (identity: ProcessIdentity | null) => void
  setStopFailure: (error: Error | undefined) => void
  token: () => string | undefined
}

type ModeSwitchAcp = {
  hasOwnedSessions: () => boolean
  observe: () => { snapshot: AcpAgentSnapshot }
  control: () => Promise<AcpAgentSnapshot>
  switchMode: (
    workspacePath: string,
    sessionId: string,
    requestId: string,
    target: 'native' | 'acp',
    context: string | undefined,
    execute: () => Promise<unknown>
  ) => AgentModeSwitchReceipt
}
type ModeSwitchProbe = {
  acp: ModeSwitchAcp
  openNativeTerminal: (...args: unknown[]) => unknown
  handleOp: (socket: Socket, message: Record<string, unknown>) => Promise<void>
}

const directories: string[] = []
const childScript = 'process.stdin.resume()'

function temporaryDirectory(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  directories.push(directory)
  return directory
}

function processIdentity(pid = 4101, marker = 'valid'): ProcessIdentity {
  return {
    pid,
    bootId: `boot-${marker}`,
    startedAt: `started-${marker}`,
    executablePath: process.execPath,
    family: 'acp-agent',
    capturedAt: '2026-09-13T00:00:00.000Z'
  }
}

function controlledAuthority(initial: VerdictKind): ControlledAuthority {
  let currentVerdict = initial
  const authority: RuntimeIdentityAuthority = {
    capture(pid: number, expected: RuntimeExpectation): ProcessIdentity {
      return {
        ...processIdentity(pid, 'captured'),
        family: expected.family,
        ...(expected.generation === undefined ? {} : { generation: expected.generation })
      }
    },
    verify(recorded: ProcessIdentity | null): ProcessIdentityVerdict {
      if (recorded === null) {
        return { status: 'indeterminate', reason: 'legacy-record', detail: 'process identity was not recorded' }
      }
      if (currentVerdict === 'valid') return { status: 'valid', current: recorded }
      if (currentVerdict === 'not-found' || currentVerdict === 'pid-reused' || currentVerdict === 'executable-mismatch') {
        return { status: 'stale', reason: currentVerdict }
      }
      return { status: 'indeterminate', reason: currentVerdict, detail: `${currentVerdict} while reading process identity` }
    }
  }
  return { authority, setVerdict: verdict => { currentVerdict = verdict } }
}

function snapshot(overrides: Partial<AcpAgentSnapshot> = {}): AcpAgentSnapshot {
  return {
    mode: 'acp',
    id: 'run-one',
    workspacePath: '/tmp/acp-workspace',
    protocolSessionId: 'protocol-history-one',
    processIdentity: processIdentity(),
    state: 'uncertain',
    capabilities: {},
    permissions: [],
    ...overrides
  }
}

function journalPath(directory: string): string { return join(directory, 'acp-sessions.sqlite') }

function writeVersionOneJournal(directory: string): void {
  const path = journalPath(directory)
  writeFileSync(path, '', { mode: 0o600 })
  chmodSync(path, 0o600)
  const db = new DatabaseSync(path)
  try {
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, launch_hash TEXT NOT NULL, snapshot TEXT NOT NULL, dismissed INTEGER NOT NULL DEFAULT 0); CREATE TABLE requests (run_id TEXT NOT NULL, id TEXT NOT NULL, payload_hash TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY (run_id,id)); PRAGMA user_version=1')
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?,0)').run('legacy-live', directory, 'launch-live', JSON.stringify({
      mode: 'acp', id: 'legacy-live', workspacePath: directory, protocolSessionId: 'history-live', pid: 99999,
      state: 'working', capabilities: {}, permissions: [{ id: 'permission-one', request: { sessionId: 'history-live' } }]
    }))
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?,0)').run('legacy-exited', directory, 'launch-exited', JSON.stringify({
      mode: 'acp', id: 'legacy-exited', workspacePath: directory, protocolSessionId: 'history-exited', pid: 88888,
      state: 'exited', capabilities: {}, permissions: [{ id: 'permission-two', request: { sessionId: 'history-exited' } }], detail: 'finished'
    }))
    db.prepare('INSERT INTO requests VALUES (?,?,?,?)').run('legacy-live', 'request-one', 'payload', JSON.stringify({ requestId: 'request-one', state: 'accepted' }))
  } finally {
    db.close()
  }
}

function insertSnapshot(directory: string, value: AcpAgentSnapshot, dismissed = false): void {
  const db = new DatabaseSync(journalPath(directory))
  try {
    db.prepare('INSERT INTO sessions (id,workspace,launch_hash,snapshot,dismissed) VALUES (?,?,?,?,?)').run(
      value.id,
      value.workspacePath,
      `launch-${value.id}`,
      JSON.stringify(value),
      dismissed ? 1 : 0
    )
  } finally {
    db.close()
  }
}

function readJournal(directory: string, id: string): { snapshot: Record<string, unknown>; dismissed: number } {
  const db = new DatabaseSync(journalPath(directory))
  try {
    const row = db.prepare('SELECT snapshot,dismissed FROM sessions WHERE id=?').get(id)
    if (!row) throw new Error('journal fixture disappeared')
    return { snapshot: JSON.parse(String(row.snapshot)) as Record<string, unknown>, dismissed: Number(row.dismissed) }
  } finally {
    db.close()
  }
}

function journalVersion(directory: string): number {
  const db = new DatabaseSync(journalPath(directory))
  try { return Number(db.prepare('PRAGMA user_version').get()!.user_version) }
  finally { db.close() }
}

function fakeOwnerHarness(): FakeOwnerHarness {
  let current = snapshot({ id: 'not-started' })
  let hookToken: string | undefined
  let stopFailure: Error | undefined
  let nextPid = 5100
  const factory: AcpAgentOwnerFactory = options => {
    for (const server of options.mcpServers) {
      if (server.name !== 'donwells-project-memory' || !('env' in server) || !Array.isArray(server.env)) continue
      hookToken = server.env.find(item => item.name === 'DONWELLS_AGENT_HOOK_TOKEN')?.value
    }
    const identity = options.identity.capture(++nextPid, { family: 'acp-agent' })
    current = snapshot({
      id: options.id,
      workspacePath: options.workspacePath,
      protocolSessionId: options.loadSessionId ?? 'protocol-history-new',
      processIdentity: identity,
      state: 'ready'
    })
    options.onChange(structuredClone(current))
    const owner: AcpAgentOwner = {
      get: () => structuredClone(current),
      observe: () => ({ snapshot: structuredClone(current), sequence: 0, truncated: false, updates: [] }),
      prompt: async (): Promise<PromptResponse> => ({ stopReason: 'end_turn' }),
      cancel: async () => {},
      stop: async () => { if (stopFailure) throw stopFailure; current = { ...current, state: 'exited', permissions: [] }; options.onChange(structuredClone(current)) },
      answerPermission: () => {}
    }
    return Promise.resolve(owner)
  }
  return {
    factory,
    snapshot: () => structuredClone(current),
    setState: state => { current = { ...current, state } },
    setProcessIdentity: identity => { current = { ...current, processIdentity: identity } },
    setStopFailure: error => { stopFailure = error },
    token: () => hookToken
  }
}

async function settleSessionStart(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

async function stoppedModeSwitch(verdict: VerdictKind): Promise<unknown> {
  const directory = temporaryDirectory(`acp-mode-switch-${verdict}-`)
  const controlled = controlledAuthority(verdict)
  const stopped = snapshot({ id: 'mode-switch-run', workspacePath: directory, state: 'exited' })
  const execution = Promise.withResolvers<unknown>()
  const replies: string[] = []
  const daemon = new TerminalDaemon({
    userDataDir: directory,
    authToken: 'terminal-test-token-123456789',
    identity: controlled.authority
  })
  const probe = daemon as unknown as ModeSwitchProbe
  probe.acp = {
    hasOwnedSessions: () => false,
    observe: () => ({ snapshot: { ...stopped, state: 'ready' } }),
    control: () => Promise.resolve(stopped),
    switchMode: (workspacePath, sessionId, requestId, target, _context, execute) => {
      void execute().then(execution.resolve, execution.reject)
      return { requestId, workspacePath, sessionId, target, state: 'accepted', continuity: 'same-history' }
    }
  }
  probe.openNativeTerminal = () => ({ created: 'native-owner' })
  const socket = {
    destroyed: false,
    writableLength: 0,
    write: (value: Buffer) => { replies.push(value.toString('utf8')); return true }
  } as unknown as Socket
  await probe.handleOp(socket, {
    id: 'switch-request',
    op: 'agent.switch',
    workspacePath: directory,
    sessionId: 'mode-switch-run',
    requestId: `switch-${verdict}`,
    target: 'native',
    executable: 'opencode',
    mcpServers: []
  })
  expect(replies).toHaveLength(1)
  return execution.promise
}

afterEach(() => {
  vi.restoreAllMocks()
  terminationControl.override = null
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true })
})

describe('ACP journal identity migration', () => {
  it('migrates v1 snapshots and request outcomes atomically to version 2', () => {
    const directory = temporaryDirectory('acp-journal-v1-')
    writeVersionOneJournal(directory)
    const controlled = controlledAuthority('valid')
    new AcpSessions(directory, { changed: () => {}, identity: controlled.authority, ownerFactory: fakeOwnerHarness().factory })

    expect(journalVersion(directory)).toBe(2)
    const live = readJournal(directory, 'legacy-live').snapshot
    expect(live).not.toHaveProperty('pid')
    expect(live).toMatchObject({
      processIdentity: null,
      state: 'uncertain',
      permissions: [],
      detail: 'Legacy ACP process identity is unavailable. Previous work was not adopted or replayed.'
    })
    const exited = readJournal(directory, 'legacy-exited').snapshot
    expect(exited).not.toHaveProperty('pid')
    expect(exited).toMatchObject({ processIdentity: null, state: 'exited', permissions: [], detail: 'finished' })

    const db = new DatabaseSync(journalPath(directory))
    try {
      const request = db.prepare('SELECT record FROM requests WHERE run_id=? AND id=?').get('legacy-live', 'request-one')
      expect(JSON.parse(String(request!.record))).toMatchObject({ state: 'uncertain', error: 'Daemon restarted before the outcome was recorded' })
    } finally { db.close() }
  })
})

describe('new ACP process identity publication', () => {
  it('captures complete identity before publishing starting or ready state', async () => {
    const directory = temporaryDirectory('acp-capture-success-')
    const controlled = controlledAuthority('valid')
    const changes: AcpAgentSnapshot[] = []
    const owner = await AcpAgent.start({
      id: 'capture-success',
      workspacePath: directory,
      launch: { executable: process.execPath, args: ['-e', childScript] },
      mcpServers: [],
      identity: controlled.authority,
      onChange: value => changes.push(value)
    })
    try {
      expect(changes[0]).toMatchObject({ state: 'starting', processIdentity: { family: 'acp-agent' } })
      expect(changes.at(-1)).toMatchObject({ state: 'ready', processIdentity: { family: 'acp-agent' } })
      expect(changes.every(change => change.processIdentity !== null)).toBe(true)
    } finally {
      await owner.stop()
    }
  })

  it('handles a missing executable spawn error without an uncaught child event', async () => {
    const directory = temporaryDirectory('acp-spawn-error-')
    const capture = vi.fn<RuntimeIdentityAuthority['capture']>()
    await expect(AcpAgent.start({
      id: 'spawn-error',
      workspacePath: directory,
      launch: { executable: join(directory, 'missing-acp-agent'), args: [] },
      mcpServers: [],
      identity: {
        capture,
        verify: () => ({ status: 'indeterminate', reason: 'legacy-record', detail: 'process identity was not recorded' })
      },
      onChange: () => {}
    })).rejects.toThrow(/ENOENT/)
    await settleSessionStart()
    expect(capture).not.toHaveBeenCalled()
  })

  it('terminates a child and publishes only uncertainty when capture fails', async () => {
    const directory = temporaryDirectory('acp-capture-failure-')
    let childPid = 0
    const authority: RuntimeIdentityAuthority = {
      capture: pid => { childPid = pid; throw new Error('capture unavailable') },
      verify: () => ({ status: 'indeterminate', reason: 'legacy-record', detail: 'process identity was not recorded' })
    }
    const changes: AcpAgentSnapshot[] = []
    await expect(AcpAgent.start({
      id: 'capture-failure',
      workspacePath: directory,
      launch: { executable: process.execPath, args: ['-e', childScript] },
      mcpServers: [],
      identity: authority,
      onChange: value => changes.push(value)
    })).rejects.toThrow(/capture unavailable/)
    expect(childPid).toBeGreaterThan(0)
    expect(processExists(childPid)).toBe(false)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ state: 'uncertain', processIdentity: null })
    expect(changes[0]!.detail).toContain('capture unavailable')
    expect(changes.some(change => change.state === 'ready')).toBe(false)
  })

  it('retains startup ownership until an unidentified child really exits', async () => {
    const directory = temporaryDirectory('acp-capture-unverified-')
    let childPid = 0
    let spawnedChild: ChildProcess | undefined
    terminationControl.override = async child => { spawnedChild = child; return false }
    const authority: RuntimeIdentityAuthority = {
      capture: pid => { childPid = pid; throw new Error('capture unavailable') },
      verify: value => value === null
        ? { status: 'indeterminate', reason: 'legacy-record', detail: 'process identity was not recorded' }
        : { status: 'valid', current: value }
    }
    const sessions = new AcpSessions(directory, { changed: () => {}, identity: authority })
    sessions.start(directory, 'capture-unverified', { executable: process.execPath, args: ['-e', childScript] }, [])
    try {
      await settleSessionStart()
      expect(childPid).toBeGreaterThan(0)
      expect(processExists(childPid)).toBe(true)
      expect(sessions.hasOwnedSessions()).toBe(true)
      expect(sessions.list(directory)).toContainEqual(expect.objectContaining({ state: 'starting', processIdentity: null }))
    } finally {
      if (spawnedChild && childPid > 0 && processExists(childPid)) {
        const exited = Promise.withResolvers<void>()
        spawnedChild.once('exit', () => exited.resolve())
        process.kill(childPid, 'SIGKILL')
        await exited.promise
      }
    }
    for (let turn = 0; turn < 5 && sessions.hasOwnedSessions(); turn += 1) await settleSessionStart()
    expect(sessions.hasOwnedSessions()).toBe(false)
    expect(sessions.list(directory)).toContainEqual(expect.objectContaining({ state: 'exited', processIdentity: null }))
  })

  it('retries unverified startup termination until the child exits', async () => {
    const directory = temporaryDirectory('acp-capture-retry-exit-')
    let childPid = 0
    let terminationAttempts = 0
    terminationControl.override = async child => {
      terminationAttempts += 1
      if (terminationAttempts >= 2 && child.pid) process.kill(child.pid, 'SIGKILL')
      return false
    }
    const authority: RuntimeIdentityAuthority = {
      capture: pid => { childPid = pid; throw new Error('capture unavailable') },
      verify: () => ({ status: 'indeterminate', reason: 'legacy-record', detail: 'process identity was not recorded' })
    }
    const changes: AcpAgentSnapshot[] = []
    await expect(AcpAgent.start({
      id: 'capture-retry-exit',
      workspacePath: directory,
      launch: { executable: process.execPath, args: ['-e', childScript] },
      mcpServers: [],
      identity: authority,
      onChange: value => changes.push(value)
    })).rejects.toThrow(/capture unavailable/)
    expect(childPid).toBeGreaterThan(0)
    expect(terminationAttempts).toBeGreaterThanOrEqual(2)
    expect(processExists(childPid)).toBe(false)
    expect(changes.at(-1)).toMatchObject({ state: 'exited', processIdentity: null })
  })

  it('verifies child termination before rejecting the first snapshot callback', async () => {
    const directory = temporaryDirectory('acp-first-publish-failure-')
    let childPid = 0
    const authority: RuntimeIdentityAuthority = {
      capture: pid => { childPid = pid; return processIdentity(pid) },
      verify: value => value === null
        ? { status: 'indeterminate', reason: 'legacy-record', detail: 'process identity was not recorded' }
        : { status: 'valid', current: value }
    }
    try {
      await expect(AcpAgent.start({
        id: 'first-publish-failure',
        workspacePath: directory,
        launch: { executable: process.execPath, args: ['-e', childScript] },
        mcpServers: [],
        identity: authority,
        onChange: () => { throw new Error('snapshot sink unavailable') }
      })).rejects.toThrow(/snapshot sink unavailable/)
      expect(childPid).toBeGreaterThan(0)
      expect(processExists(childPid)).toBe(false)
    } finally {
      if (childPid > 0 && processExists(childPid)) process.kill(childPid, 'SIGKILL')
    }
  })
})

describe('ACP persisted ownership classification', () => {
  it('retains valid uncertain ownership and blocks duplicate protocol history', () => {
    const directory = temporaryDirectory('acp-valid-owner-')
    const controlled = controlledAuthority('valid')
    const sessions = new AcpSessions(directory, { changed: () => {}, identity: controlled.authority, ownerFactory: fakeOwnerHarness().factory })
    insertSnapshot(directory, snapshot({ id: 'valid-prior', workspacePath: directory }))

    expect(sessions.hasOwnedSessions()).toBe(true)
    expect(sessions.ownsHistory(directory, 'protocol-history-one')).toBe(true)
    expect(() => sessions.start(directory, 'valid-successor', { executable: process.execPath, args: [] }, [], 'valid-prior')).toThrow(/verified stopped/)
  })

  it.each(['not-found', 'pid-reused', 'executable-mismatch'] as const)('reconciles and dismisses stale %s without signaling a PID', async reason => {
    const directory = temporaryDirectory(`acp-stale-${reason}-`)
    const controlled = controlledAuthority(reason)
    const sessions = new AcpSessions(directory, { changed: () => {}, identity: controlled.authority, ownerFactory: fakeOwnerHarness().factory })
    insertSnapshot(directory, snapshot({ id: `stale-${reason}`, workspacePath: directory }))
    const kill = vi.spyOn(process, 'kill')

    expect(sessions.hasOwnedSessions()).toBe(false)
    const stopped = await sessions.control(directory, `stale-${reason}`, 'stop')
    expect(stopped.state).toBe('exited')
    await expect(sessions.control(directory, `stale-${reason}`, 'dismiss')).resolves.toMatchObject({ state: 'exited' })
    expect(readJournal(directory, `stale-${reason}`).dismissed).toBe(1)
    expect(kill).not.toHaveBeenCalled()
  })

  it.each(['access-denied', 'native-error'] as const)('preserves %s uncertainty and blocks history reuse and dismissal without signaling', async reason => {
    const directory = temporaryDirectory(`acp-indeterminate-${reason}-`)
    const controlled = controlledAuthority(reason)
    const sessions = new AcpSessions(directory, { changed: () => {}, identity: controlled.authority, ownerFactory: fakeOwnerHarness().factory })
    insertSnapshot(directory, snapshot({ id: `indeterminate-${reason}`, workspacePath: directory }))
    const kill = vi.spyOn(process, 'kill')

    expect(sessions.hasOwnedSessions()).toBe(true)
    expect(sessions.ownsHistory(directory, 'protocol-history-one')).toBe(true)
    expect(() => sessions.start(directory, `successor-${reason}`, { executable: process.execPath, args: [] }, [], `indeterminate-${reason}`)).toThrow(/verified stopped/)
    await expect(sessions.control(directory, `indeterminate-${reason}`, 'stop')).resolves.toMatchObject({ state: 'uncertain' })
    await expect(sessions.control(directory, `indeterminate-${reason}`, 'dismiss')).rejects.toThrow(/live or unverifiable/)
    expect(kill).not.toHaveBeenCalled()
  })

  it.each(['not-found', 'pid-reused', 'executable-mismatch'] as const)('accepts stale %s after the in-memory owner stop rejects', async reason => {
    const directory = temporaryDirectory(`acp-stop-rejected-stale-${reason}-`)
    const controlled = controlledAuthority('valid')
    const owner = fakeOwnerHarness()
    const sessions = new AcpSessions(directory, { changed: () => {}, identity: controlled.authority, ownerFactory: owner.factory })
    sessions.start(directory, `stop-rejected-${reason}`, { executable: process.execPath, args: [] }, [])
    await settleSessionStart()
    owner.setStopFailure(new Error('owner stop rejected'))
    controlled.setVerdict(reason)
    await settleSessionStart()

    await expect(sessions.control(directory, `stop-rejected-${reason}`, 'stop')).resolves.toMatchObject({ state: 'exited' })
    expect(sessions.hasOwnedSessions()).toBe(false)
  })

  it.each(['valid', 'access-denied', 'native-error'] as const)('preserves %s ownership and rejects when the in-memory owner stop rejects', async reason => {
    const directory = temporaryDirectory(`acp-stop-rejected-${reason}-`)
    const controlled = controlledAuthority('valid')
    const owner = fakeOwnerHarness()
    const sessions = new AcpSessions(directory, { changed: () => {}, identity: controlled.authority, ownerFactory: owner.factory })
    sessions.start(directory, `stop-rejected-${reason}`, { executable: process.execPath, args: [] }, [])
    await settleSessionStart()
    owner.setStopFailure(new Error('owner stop rejected'))
    controlled.setVerdict(reason)
    await settleSessionStart()

    await expect(sessions.control(directory, `stop-rejected-${reason}`, 'stop')).rejects.toThrow(/owner stop rejected/)
    expect(sessions.hasOwnedSessions()).toBe(true)
    expect(sessions.list(directory)).toContainEqual(expect.objectContaining({ state: 'uncertain', processIdentity: expect.objectContaining({ family: 'acp-agent' }) }))
  })

  it('allows only journal dismissal to release legacy protocol history', async () => {
    const directory = temporaryDirectory('acp-legacy-history-')
    const controlled = controlledAuthority('valid')
    const owner = fakeOwnerHarness()
    const sessions = new AcpSessions(directory, { changed: () => {}, identity: controlled.authority, ownerFactory: owner.factory })
    insertSnapshot(directory, snapshot({ id: 'legacy-prior', workspacePath: directory, processIdentity: null }))
    const kill = vi.spyOn(process, 'kill')

    expect(sessions.hasOwnedSessions()).toBe(false)
    expect(sessions.ownsHistory(directory, 'protocol-history-one')).toBe(true)
    expect(() => sessions.start(directory, 'legacy-successor-before', { executable: process.execPath, args: [] }, [], 'legacy-prior')).toThrow(/verified stopped/)
    await expect(sessions.control(directory, 'legacy-prior', 'stop')).resolves.toMatchObject({ state: 'uncertain', processIdentity: null })
    await expect(sessions.control(directory, 'legacy-prior', 'dismiss')).resolves.toMatchObject({ processIdentity: null })
    expect(sessions.ownsHistory(directory, 'protocol-history-one')).toBe(false)

    expect(sessions.start(directory, 'legacy-successor-after', { executable: process.execPath, args: [] }, [], 'legacy-prior')).toMatchObject({
      state: 'starting',
      protocolSessionId: 'protocol-history-one'
    })
    await settleSessionStart()
    expect(sessions.observe(directory, 'legacy-successor-after').snapshot).toMatchObject({ state: 'ready', protocolSessionId: 'protocol-history-one' })
    expect(kill).not.toHaveBeenCalled()
  })
})

describe('ACP authentication authority', () => {
  it('requires the token, in-memory owner, acceptable state, and valid exact identity', async () => {
    const directory = temporaryDirectory('acp-authentication-')
    const controlled = controlledAuthority('valid')
    const owner = fakeOwnerHarness()
    const sessions = new AcpSessions(directory, { changed: () => {}, identity: controlled.authority, ownerFactory: owner.factory })
    const memoryServer = { name: 'donwells-project-memory', command: process.execPath, args: [], env: [] } satisfies McpServer
    sessions.start(directory, 'authenticated-run', { executable: process.execPath, args: [] }, [memoryServer])
    await settleSessionStart()
    const token = owner.token()
    if (!token) throw new Error('fake owner did not receive its hook token')

    for (const state of ['ready', 'working', 'permission'] as const) {
      owner.setState(state)
      expect(sessions.authenticate('authenticated-run', 'authenticated-run', token)).toMatchObject({ liveness: 'live', mode: 'acp' })
    }
    expect(sessions.authenticate('authenticated-run', 'another-session', token)).toBeUndefined()
    expect(sessions.authenticate('authenticated-run', 'authenticated-run', `${token}x`)).toBeUndefined()
    owner.setState('starting')
    expect(sessions.authenticate('authenticated-run', 'authenticated-run', token)).toBeUndefined()
    owner.setState('ready')
    controlled.setVerdict('pid-reused')
    expect(sessions.authenticate('authenticated-run', 'authenticated-run', token)).toBeUndefined()
    controlled.setVerdict('valid')
    owner.setProcessIdentity(null)
    expect(sessions.authenticate('authenticated-run', 'authenticated-run', token)).toBeUndefined()
  })
})

describe('ACP mode-switch post-stop identity guard', () => {
  it.each(['not-found', 'pid-reused', 'executable-mismatch'] as const)('accepts stale %s as verified stop evidence', async reason => {
    await expect(stoppedModeSwitch(reason)).resolves.toEqual({ native: { created: 'native-owner' } })
  })

  it.each(['valid', 'access-denied', 'native-error'] as const)('rejects %s as post-stop evidence', async verdict => {
    await expect(stoppedModeSwitch(verdict)).rejects.toThrow(/stop could not be verified/)
  })
})
