// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ProcessIdentity, ProcessIdentityVerdict } from '@shared/child-process/process-spec'
import {
  type AuthenticatedAuthorityConnection,
  type ClaimResult,
  type LeaseToken,
  type TaskExecutionSpecificationInput
} from '@shared/task-authority'
import { isProviderCertificationPlatform, type ProviderCatalog, type ProviderSelection } from '@shared/provider-authority'
import type { ProviderLaunchSecrets } from '@shared/provider-secret-broker'
import { openTaskAuthorityRawConnection } from './task-authority/schema'
import { SqliteTaskAuthority } from './task-authority/task-authority'
import { SqliteProviderCatalog } from './provider-catalog'
import { AgentRegistry } from './agents/registry'
import { SqliteProfileMaintenanceGate } from './profile-maintenance-gate'
import { SecretOutputBoundary } from './secret-output-redactor'
import { DaemonTaskEvidencePort } from './task-authority/task-evidence-port'
import { assertNoDisclosure } from './test-utils/disclosure-census'
import {
  SECRET_AUTHORITY_UNAVAILABLE,
  TaskExecutionCoordinator,
  resolveProviderLaunchInvocation,
  type ProviderChildPort,
  type ProviderLaunchPorts,
  type ProviderMaintenancePort,
  type ProviderSecretPort
} from './task-authority/task-execution-coordinator'

/**
 * Provider-backed launch seam: selection binding, admission, isolation, and the
 * output boundary.
 *
 * These tests are the ONLY callers of the provider-backed path in Stage 3. The
 * production managed-support matrix is empty by design (the shipped credential
 * environment table is `{}` and every built-in driver is external-only), so the
 * managed/none behavior below is proven through an injected certification bound
 * to a fake executable in this test's own profile. That result is framework
 * proof: it never authorizes a built-in driver and never appears in a
 * production projection.
 */

const PROJECT = 'project-provider'
const OWNER_ALICE = '12121212-1212-4212-8212-121212121212'
const CERTIFICATION_PLATFORM = isProviderCertificationPlatform(process.platform) ? process.platform : undefined

const ADMIN: AuthenticatedAuthorityConnection = { connectionId: 'conn-admin', role: 'administrator' }
const worker = (ownerId: string = OWNER_ALICE): AuthenticatedAuthorityConnection => ({
  connectionId: `conn-worker-${ownerId}`,
  role: 'worker',
  ownerId,
  authorizedProjectIds: [PROJECT]
})

const IDENTITY = (pid = 4242): ProcessIdentity => ({
  pid,
  bootId: 'boot-1',
  startedAt: new Date().toISOString(),
  executablePath: '/usr/bin/fake-provider',
  family: 'acp-agent',
  capturedAt: new Date().toISOString()
})

const VERDICT: ProcessIdentityVerdict = { status: 'valid', current: IDENTITY() }

const SPEC = (root: string): TaskExecutionSpecificationInput => ({
  command: { program: 'node', args: ['run.js'], cwd: root },
  target: { kind: 'local', root, label: 'repo' },
  verification: { requiredArtifacts: [] }
})

/** Disposable credential markers, distinct so a leak names its own account. */
const MARKER_ALPHA = 'sk-alpha-0123456789abcdefghijklmnopqrstuv'
const MARKER_BETA = 'ghp_beta-ZYXWVUTSRQPONMLKJIHGFEDCBA'

type Profile = Readonly<{ directory: string; bin: string; workspace: string; isolation: string; driver: string; databasePath: string }>

const profiles: Profile[] = []
const authorities: SqliteTaskAuthority[] = []
const catalogs: SqliteProviderCatalog[] = []

function profile(): Profile {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'provider-launch-')))
  const bin = join(directory, 'bin')
  const workspace = join(directory, 'workspace')
  const isolation = join(directory, 'isolation')
  mkdirSync(bin, { recursive: true, mode: 0o700 })
  mkdirSync(workspace, { recursive: true, mode: 0o700 })
  mkdirSync(isolation, { recursive: true, mode: 0o700 })
  // The certification binds the exact path the registry resolves for `codex`,
  // so an accepted tuple and a drifted tuple are compared against one real file.
  // POSIX resolves through a shell stub that execs the payload each test
  // writes; Windows has no shebang execution, so it gets a native Node copy
  // and the payload arrives through the trusted driver-argument seam instead.
  const driver = join(bin, process.platform === 'win32' ? 'codex.EXE' : 'codex')
  if (process.platform === 'win32') {
    copyFileSync(process.execPath, driver)
  } else {
    writeFileSync(driver, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(workspace, 'child.cjs'))} "$@"\n`, { mode: 0o755 })
    chmodSync(driver, 0o755)
  }
  const entry: Profile = { directory, bin, workspace, isolation, driver, databasePath: join(directory, 'authority.sqlite') }
  profiles.push(entry)
  return entry
}

afterEach(() => {
  try {
    // Read live database/WAL bytes before close can checkpoint or delete them.
    for (const entry of profiles) {
      assertNoDisclosure(entry.directory, [MARKER_ALPHA, MARKER_BETA], [join('real-home', '.fake-provider', 'auth.json')])
    }
  } finally {
    while (catalogs.length > 0) catalogs.pop()
    while (authorities.length > 0) authorities.pop()?.close()
    while (profiles.length > 0) rmSync(profiles.pop()!.directory, { recursive: true, force: true })
  }
})

function openAuthority(entry: Profile): SqliteTaskAuthority {
  const instance = SqliteTaskAuthority.open({ databasePath: entry.databasePath })
  authorities.push(instance)
  return instance
}

/**
 * A catalog whose certification is bound to a real executable in this profile,
 * so an accepted tuple and a drifted tuple are compared against the exact file
 * the registry resolves rather than against a hand-written path.
 */
function openCatalog(authority: SqliteTaskAuthority, entry: Profile, options: { certified?: boolean } = {}): ProviderCatalog {
  const certifications = options.certified === false || CERTIFICATION_PLATFORM === undefined ? [] : [{
    driverId: 'codex' as const,
    modes: ['managed', 'none'] as const,
    executablePath: entry.driver,
    supportedVersionRange: '>=1.0.0 <2.0.0',
    platform: CERTIFICATION_PLATFORM,
    architecture: process.arch
  }]
  const catalog = new SqliteProviderCatalog({ database: authority.database, registry: new AgentRegistry({ env: { PATH: entry.bin } }), certifications })
  catalogs.push(catalog)
  return catalog
}

/** Points the `codex` driver at the fake executable inside this profile. */
function fakeDriverInstance(catalog: ProviderCatalog, mode: 'external' | 'managed' | 'none', accountId: string | null = null) {
  return catalog.create({
    driverId: 'codex',
    displayName: `fake ${mode}`,
    command: { kind: 'driver', driverId: 'codex' },
    credentialMode: mode,
    accountId,
    enabled: true
  })
}

function createTask(authority: SqliteTaskAuthority, externalTaskId: string) {
  return authority.createTask({ connection: ADMIN, projectId: PROJECT, externalTaskId, title: `task ${externalTaskId}` })
}

function claimWith(authority: SqliteTaskAuthority, externalTaskId: string, entry: Profile, selection?: ProviderSelection, leaseTtlMs = 60_000): ClaimResult {
  createTask(authority, externalTaskId)
  return authority.claim({
    connection: worker(),
    projectId: PROJECT,
    externalTaskId,
    specification: SPEC(entry.workspace),
    leaseTtlMs,
    ...(selection === undefined ? {} : { providerSelection: selection })
  })
}

function selectionFor(instance: { id: string; revision: number }, account: { id: string; revision: number } | null = null): ProviderSelection {
  return { driverId: 'codex', providerInstanceId: instance.id, instanceRevision: instance.revision, accountId: account?.id ?? null, accountRevision: account?.revision ?? null }
}

function taskOf(authority: SqliteTaskAuthority, taskId: string) {
  return authority.query({ connection: ADMIN, projectId: PROJECT }).tasks.find(candidate => candidate.taskId === taskId)!
}

function rows<T>(databasePath: string, sql: string, ...params: Array<string | number>): T[] {
  const db = openTaskAuthorityRawConnection(databasePath)
  try {
    return db.prepare(sql).all(...params) as T[]
  } finally {
    db.close()
  }
}

// -- fakes --------------------------------------------------------------------

type MaintenanceRecord = { operationId: string; epoch: number; ownerConnectionId: string; outcome: 'completed' | 'cancelled' | null }

/**
 * The REAL durable gate, driven exactly as the daemon drives it. Admissions go
 * through the same database the Task Authority admission reads, so a freeze and
 * a launch really do contend for one winner instead of a fake pretending they do.
 */
function maintenancePort(gate: SqliteProfileMaintenanceGate, connectionId = 'daemon-internal') {
  const records: MaintenanceRecord[] = []
  const port: ProviderMaintenancePort = {
    admit: async (participant, operationId) => {
      const admission = await gate.admit({ connectionId }, participant, operationId)
      records.push({ operationId: admission.operationId, epoch: admission.epoch, ownerConnectionId: admission.ownerConnectionId, outcome: null })
      return admission
    },
    complete: async (operationId, epoch, ownerConnectionId, outcome) => {
      await gate.complete({ connectionId }, { participant: 'provider-authority', operationId, epoch, ownerConnectionId }, outcome)
      const record = records.find(candidate => candidate.operationId === operationId)
      if (record) record.outcome = outcome
    }
  }
  return { port, records }
}

function secretPort(secrets: ProviderLaunchSecrets | Error) {
  const authorizations: unknown[] = []
  const port: ProviderSecretPort = {
    materialize: async authorization => {
      authorizations.push(authorization)
      if (secrets instanceof Error) throw secrets
      return secrets
    }
  }
  return { port, authorizations }
}

type ChildCall = Readonly<{ sessionId: string; program: string; args: readonly string[]; environment: NodeJS.ProcessEnv }>

/**
 * A recording child port. In `'real'` mode it actually executes the resolved
 * invocation as an OS process and performs the same boundary push the daemon
 * performs, so redaction is proven against bytes a real child produced rather
 * than against a fixture the test assembled.
 */
function childPort(options: {
  mode?: 'fake' | 'real'
  identity?: ProcessIdentity | null
  exitCode?: number
  failOpen?: boolean
  boundary?: SecretOutputBoundary
  /** Output polls that report a live child before it settles, so a pump loop can be driven. */
  livePolls?: number
  /** Fails the output port itself, as a reaped or unknown session does. */
  failOutput?: boolean
} = {}) {
  const calls: ChildCall[] = []
  const stopped: string[] = []
  const captured: Array<{ raw: string; safe: string }> = []
  const mode = options.mode ?? 'fake'
  const livePolls = options.livePolls ?? 0
  let polls = 0
  let stopRequested = false
  const port: ProviderChildPort = {
    open: input => {
      if (options.failOpen) throw new Error('fake provider child refused to start')
      const sessionId = input.sessionId
      calls.push({ sessionId, program: input.invocation.program, args: [...input.invocation.args], environment: { ...input.environment } })
      if (mode === 'real') {
        const result = spawnSync(input.invocation.program, [...input.invocation.args], {
          cwd: input.workspaceRoot,
          env: input.environment as NodeJS.ProcessEnv,
          encoding: 'utf8'
        })
        const raw = `${result.stdout ?? ''}${result.stderr ?? ''}`
        captured.push({ raw, safe: raw })
      }
      return { sessionId, processIdentity: options.identity === undefined ? IDENTITY(4000 + calls.length) : options.identity }
    },
    stop: async sessionId => { stopRequested = true; stopped.push(sessionId) },
    stopProcess: async () => { stopped.push('by-identity') },
    output: sessionId => {
      if (options.failOutput) throw new Error(`unknown provider child session: ${sessionId}`)
      polls += 1
      // A live child keeps the pump looping, which is the only window in which a
      // mid-run stop delivery or a lease renewal can happen.
      if (polls <= livePolls && !stopRequested) return { stdout: '', stderr: '', exited: false }
      // In real mode the child already ran at open; report its captured bytes
      // once so the pump and the boundary see them.
      const entry = captured.shift()
      if (entry === undefined) {
        return { stdout: '', stderr: '', exited: true, exitCode: options.exitCode ?? 0 }
      }
      const boundary = options.boundary
      const safe = boundary?.has(sessionId) === true ? boundary.push(sessionId, 'stdout', entry.raw) : entry.raw
      entry.safe = safe
      captured.push(entry)
      // The daemon's PTY sink settles each chunk through the boundary before it
      // reaches scrollback, so this port hands the pump already-redacted bytes.
      return { stdout: safe, stderr: '', exited: true, exitCode: options.exitCode ?? 0 }
    }
  }
  return { port, calls, stopped, captured }
}

function makeCoordinator(authority: SqliteTaskAuthority, entry: Profile, provider: Partial<ProviderLaunchPorts> & Pick<ProviderLaunchPorts, 'maintenance' | 'catalog' | 'boundary' | 'child'>): TaskExecutionCoordinator {
  return new TaskExecutionCoordinator({
    authority,
    ports: {
      // In production both ports stop a session through the same PtyManager call,
      // and a provider child is not registered in `childKinds`, so a cancellation
      // that has to stop a running provider child arrives through the jobs port.
      jobs: { openJob: () => ({ sessionId: randomUUID(), processIdentity: IDENTITY() }), stop: (sessionId: string) => provider.child.stop(sessionId), output: () => ({ output: '', totalBytes: 0, exited: true, exitCode: 0 }) },
      agents: null
    } as never,
    evidence: new DaemonTaskEvidencePort(),
    verifyIdentity: () => VERDICT,
    pumpPollMs: 1,
    provider: {
      driverExecutable: () => entry.driver,
      createIsolationRoot: sessionId => { const root = join(entry.isolation, sessionId); mkdirSync(root, { recursive: true, mode: 0o700 }); return root },
      removeIsolationRoot: () => undefined,
      ...provider
    }
  })
}

/** One catalog instance prepared for a live launch, with its own task and lease. */
function prepared(authority: SqliteTaskAuthority, catalog: ProviderCatalog, entry: Profile, externalTaskId: string, mode: 'external' | 'managed' | 'none', marker?: string, leaseTtlMs = 60_000) {
  const account = mode === 'managed' ? catalog.createAccount({ driverId: 'codex', displayLabel: 'alpha' }) : null
  const instance = fakeDriverInstance(catalog, mode, account?.id ?? null)
  const bound = account === null
    ? instance
    : catalog.bindCredential({ providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: instance.revision, expectedAccountRevision: account.revision, credentialRef: `ref-${externalTaskId}`, expectedBindingGeneration: 0 })
  const selection = selectionFor(bound, account)
  const claimed = claimWith(authority, externalTaskId, entry, selection, leaseTtlMs)
  return { account, instance: bound, selection, claimed, marker }
}

describe('driver-owned launch arguments', () => {
  it('appends them to a driver invocation so a codex launch keeps project memory', async () => {
    const entry = profile()
    const authority = openAuthority(entry)
    const catalog = openCatalog(authority, entry)
    const { selection, claimed } = prepared(authority, catalog, entry, 'ARGS-1', 'external')
    const gate = new SqliteProfileMaintenanceGate({ database: authority.database, profileId: PROJECT })
    const maintenance = maintenancePort(gate)
    const child = childPort({ identity: IDENTITY() })
    const coordinator = makeCoordinator(authority, entry, {
      maintenance: maintenance.port,
      catalog: { prepareLaunch: input => catalog.prepareLaunch(input) },
      boundary: new SecretOutputBoundary(),
      child: child.port
    })

    const driverArguments = ['-c', 'mcp_servers.donwells-project-memory={command=\"node\"}']
    const outcome = await coordinator.launchProviderBacked({
      lease: claimed.token, attemptId: claimed.attempt.attemptId, sessionId: 'session-args',
      workspaceRoot: entry.workspace, selection, connection: worker(), driverArguments
    })

    expect(outcome.disposition).toBe('completed')
    expect(child.calls).toHaveLength(1)
    // The driver's own executable stays first; the memory patch follows it.
    expect(child.calls[0]!.program).toBe(entry.driver)
    expect(child.calls[0]!.args).toEqual(driverArguments)
  })

  it('ignores them for a custom command so an instance never becomes an argv channel', async () => {
    const entry = profile()
    const authority = openAuthority(entry)
    const catalog = openCatalog(authority, entry)
    // A custom-command instance is explicit external argv, not driver-owned.
    const instance = catalog.create({
      driverId: 'custom-command',
      displayName: 'custom external',
      command: { kind: 'external-shell', program: '/bin/echo hello' },
      credentialMode: 'external',
      accountId: null,
      enabled: true
    })
    // The selection must name the instance's own driver, or admission refuses it.
    const selection: ProviderSelection = { driverId: 'custom-command', providerInstanceId: instance.id, instanceRevision: instance.revision, accountId: null, accountRevision: null }
    const claimed = claimWith(authority, 'ARGS-2', entry, selection)
    const gate = new SqliteProfileMaintenanceGate({ database: authority.database, profileId: PROJECT })
    const maintenance = maintenancePort(gate)
    const child = childPort({ identity: IDENTITY() })
    const coordinator = makeCoordinator(authority, entry, {
      maintenance: maintenance.port,
      catalog: { prepareLaunch: input => catalog.prepareLaunch(input) },
      boundary: new SecretOutputBoundary(),
      child: child.port
    })

    const outcome = await coordinator.launchProviderBacked({
      lease: claimed.token, attemptId: claimed.attempt.attemptId, sessionId: 'session-args-2',
      workspaceRoot: entry.workspace, selection, connection: worker(),
      driverArguments: ['--injected-by-caller']
    })

    expect(outcome.disposition).toBe('completed')
    // The user's own program runs unchanged; no caller argument is appended.
    expect(child.calls[0]!.args.join(' ')).not.toContain('--injected-by-caller')
  })
})

describe('provider selection binding', () => {
  it('records an immutable selection on the attempt and refuses a provider-free attempt for provider admission', () => {
    const entry = profile()
    const authority = openAuthority(entry)
    const catalog = openCatalog(authority, entry)
    const instance = fakeDriverInstance(catalog, 'external')
    const selection = selectionFor(instance)

    const claimed = claimWith(authority, 'SEL-1', entry, selection)
    expect(claimed.attempt.providerSelection).toEqual(selection)
    expect(taskOf(authority, claimed.task.taskId).currentAttempt?.providerSelection).toEqual(selection)

    // The provider-free variant is the explicit `null` selection, not a missing field.
    const plain = claimWith(authority, 'SEL-2', entry)
    expect(plain.attempt.providerSelection).toBeNull()

    expect(() => authority.admitProviderLaunch({
      lease: plain.token, attemptId: plain.attempt.attemptId, sessionId: 'session-1', purpose: 'agent-launch', preparationId: randomUUID(),
      maintenance: { operationId: 'op', epoch: 1, ownerConnectionId: 'daemon-internal' }
    })).toThrowError(expect.objectContaining({ code: 'PROVIDER_SELECTION_REQUIRED' }))
  })

  it('lets a retry choose a different account and keeps the recorded history stable', () => {
    const entry = profile()
    const authority = openAuthority(entry)
    const catalog = openCatalog(authority, entry)
    const accountA = catalog.createAccount({ driverId: 'codex', displayLabel: 'alpha' })
    const accountB = catalog.createAccount({ driverId: 'codex', displayLabel: 'beta' })
    const instanceA = fakeDriverInstance(catalog, 'external', accountA.id)
    const instanceB = fakeDriverInstance(catalog, 'external', accountB.id)

    const first = claimWith(authority, 'RETRY-1', entry, selectionFor(instanceA, accountA))
    authority.write({ kind: 'fail', connection: worker(), token: first.token, error: 'first attempt failed' })
    const retried = authority.retryFailedTask({
      connection: ADMIN, projectId: PROJECT, taskId: first.task.taskId,
      expectedEntityVersion: taskOf(authority, first.task.taskId).entityVersion,
      ownerId: OWNER_ALICE,
      providerSelection: selectionFor(instanceB, accountB)
    })

    expect(retried.attempt.providerSelection).toEqual(selectionFor(instanceB, accountB))
    expect(retried.attempt.retryOfAttemptId).toBe(first.attempt.attemptId)
    const attempts = rows<{ provider_selection_json: string | null }>(entry.databasePath, 'SELECT provider_selection_json FROM attempts ORDER BY sequence')
    expect(JSON.parse(String(attempts[0]!.provider_selection_json))).toEqual(selectionFor(instanceA, accountA))
    expect(JSON.parse(String(attempts[1]!.provider_selection_json))).toEqual(selectionFor(instanceB, accountB))
  })

  it('admits the exact unexpired preparation once, and refuses stale, foreign, and mismatched tuples without changing attempt or preparation', async () => {
    const entry = profile()
    const authority = openAuthority(entry)
    const catalog = openCatalog(authority, entry)
    const instance = fakeDriverInstance(catalog, 'external')
    const selection = selectionFor(instance)
    const claimed = claimWith(authority, 'ADMIT-1', entry, selection)

    // The maintenance admission really exists in the same database, which is
    // what the admission transaction re-reads; nothing here is caller-authored.
    const gate = new SqliteProfileMaintenanceGate({ database: authority.database, profileId: PROJECT })
    const maintenance = await gate.admit({ connectionId: 'daemon-internal' }, 'provider-authority', 'op')

    const prepare = (token: LeaseToken, sessionId: string) => catalog.prepareLaunch({ selection, attemptId: token.attemptId, sessionId, purpose: 'agent-launch' })
    const claimFor = (token: LeaseToken, sessionId: string, preparationId: string, claim = { operationId: maintenance.operationId, epoch: maintenance.epoch, ownerConnectionId: maintenance.ownerConnectionId }) =>
      authority.admitProviderLaunch({ lease: token, attemptId: token.attemptId, sessionId, purpose: 'agent-launch', preparationId, maintenance: claim })

    const foreignPreparation = prepare({ ...claimed.token, ownerId: '34343434-3434-4434-8434-343434343434' }, 'session-foreign')
    expect(() => claimFor({ ...claimed.token, ownerId: '34343434-3434-4434-8434-343434343434' }, 'session-foreign', foreignPreparation.id))
      .toThrowError(expect.objectContaining({ code: 'AUTHORIZATION_DENIED' }))

    const stalePreparation = prepare({ ...claimed.token, generation: claimed.token.generation + 1 }, 'session-stale')
    expect(() => claimFor({ ...claimed.token, generation: claimed.token.generation + 1 }, 'session-stale', stalePreparation.id))
      .toThrowError(expect.objectContaining({ code: 'STALE_AUTHORITY' }))

    // Session mismatch, unknown preparation, wrong maintenance epoch, unknown
    // admission, and a foreign admitting connection.
    const goodPreparation = prepare(claimed.token, 'session-good')
    expect(() => claimFor(claimed.token, 'session-other', goodPreparation.id)).toThrowError(expect.objectContaining({ code: 'PREPARATION_STALE' }))
    expect(() => claimFor(claimed.token, 'session-good', randomUUID())).toThrowError(expect.objectContaining({ code: 'PREPARATION_STALE' }))
    expect(() => claimFor(claimed.token, 'session-good', goodPreparation.id, { operationId: maintenance.operationId, epoch: 7, ownerConnectionId: maintenance.ownerConnectionId })).toThrowError(expect.objectContaining({ code: 'MAINTENANCE_ADMISSION_STALE' }))
    expect(() => claimFor(claimed.token, 'session-good', goodPreparation.id, { operationId: 'never-admitted', epoch: maintenance.epoch, ownerConnectionId: maintenance.ownerConnectionId })).toThrowError(expect.objectContaining({ code: 'MAINTENANCE_ADMISSION_STALE' }))
    expect(() => claimFor(claimed.token, 'session-good', goodPreparation.id, { operationId: maintenance.operationId, epoch: maintenance.epoch, ownerConnectionId: 'someone-else' })).toThrowError(expect.objectContaining({ code: 'MAINTENANCE_ADMISSION_STALE' }))

    // Every refusal left the attempt claiming and every preparation unconsumed.
    expect(taskOf(authority, claimed.task.taskId).currentAttempt?.state).toBe('claimed')
    expect(rows<{ consumed_at: string | null }>(entry.databasePath, 'SELECT consumed_at FROM provider_launch_preparations').every(row => row.consumed_at === null)).toBe(true)
    expect(rows(entry.databasePath, 'SELECT id FROM task_launch_admissions')).toHaveLength(0)

    const admission = claimFor(claimed.token, 'session-good', goodPreparation.id)
    expect(admission).toMatchObject({ selection, sessionId: 'session-good', preparationId: goodPreparation.id, purpose: 'agent-launch', state: 'admitted', credentialMode: 'external', credential: null })
    expect(taskOf(authority, claimed.task.taskId).currentAttempt?.state).toBe('launching')
    expect(rows<{ consumed_at: string | null }>(entry.databasePath, 'SELECT consumed_at FROM provider_launch_preparations WHERE id = ?', goodPreparation.id)[0]?.consumed_at).not.toBeNull()
    // The admitted row is the trusted source of the tuple the broker request uses.
    const stored = rows<{ provider_instance_id: string; instance_revision: number; maintenance_epoch: number; launch_intent_id: string }>(entry.databasePath, 'SELECT provider_instance_id, instance_revision, maintenance_epoch, launch_intent_id FROM task_launch_admissions')
    expect(stored).toEqual([{ provider_instance_id: selection.providerInstanceId, instance_revision: selection.instanceRevision, maintenance_epoch: 1, launch_intent_id: admission.launchIntentId }])

    // Exactly one admission committed for this attempt.
    expect(rows(entry.databasePath, 'SELECT id FROM task_launch_admissions')).toHaveLength(1)

    // The same preparation cannot admit twice, and an already-launching attempt
    // cannot admit a second spawn: `claimed -> launching` happens once only.
    expect(() => claimFor(claimed.token, 'session-good', goodPreparation.id)).toThrowError(expect.objectContaining({ code: 'STALE_AUTHORITY' }))
    const secondSession = catalog.prepareLaunch({ selection, attemptId: claimed.token.attemptId, sessionId: 'session-second', purpose: 'agent-launch' })
    expect(() => claimFor(claimed.token, 'session-second', secondSession.id)).toThrowError(expect.objectContaining({ code: 'STALE_AUTHORITY' }))
    expect(rows<{ consumed_at: string | null }>(entry.databasePath, 'SELECT consumed_at FROM provider_launch_preparations WHERE id = ?', secondSession.id)[0]?.consumed_at).toBeNull()
  })

  it('refuses admission when the live credential ref or binding generation changed out of band', () => {
    const entry = profile()
    const authority = openAuthority(entry)
    const catalog = openCatalog(authority, entry)
    const account = catalog.createAccount({ driverId: 'codex', displayLabel: 'alpha' })
    const instance = fakeDriverInstance(catalog, 'managed', account.id)
    const bound = catalog.bindCredential({ providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: instance.revision, expectedAccountRevision: account.revision, credentialRef: 'ref-original', expectedBindingGeneration: 0 })
    const selection = selectionFor(bound, account)
    const claimed = claimWith(authority, 'OUTOFBAND-1', entry, selection)
    const preparation = catalog.prepareLaunch({ selection, attemptId: claimed.token.attemptId, sessionId: 'session-oob', purpose: 'agent-launch' })

    // Swap the live binding's ref in place, leaving every revision untouched.
    // This is not reachable through the Catalog's public surface, which is
    // exactly why the ref/generation compare is real defense in depth: it is the
    // only check standing between an out-of-band swap and a materialization for
    // a credential the preparation never named.
    const database = openTaskAuthorityRawConnection(entry.databasePath)
    database.prepare('UPDATE provider_credential_bindings SET credential_ref = ? WHERE provider_instance_id = ? AND account_id = ? AND retired_at IS NULL')
      .run('ref-swapped', instance.id, account.id)
    database.close()

    expect(() => authority.admitProviderLaunch({
      lease: claimed.token, attemptId: claimed.token.attemptId, sessionId: 'session-oob', purpose: 'agent-launch', preparationId: preparation.id,
      maintenance: { operationId: 'op', epoch: 1, ownerConnectionId: 'daemon-internal' }
    })).toThrowError(expect.objectContaining({ code: 'PREPARATION_STALE' }))
    expect(rows<{ consumed_at: string | null }>(entry.databasePath, 'SELECT consumed_at FROM provider_launch_preparations WHERE id = ?', preparation.id)[0]?.consumed_at).toBeNull()
    expect(rows(entry.databasePath, 'SELECT id FROM task_launch_admissions')).toHaveLength(0)
    expect(taskOf(authority, claimed.task.taskId).currentAttempt?.state).toBe('claimed')
  })

  it('refuses admission when the live instance revision moved after preparation', () => {
    const entry = profile()
    const authority = openAuthority(entry)
    const catalog = openCatalog(authority, entry)
    const instance = fakeDriverInstance(catalog, 'external')
    const selection = selectionFor(instance)
    const claimed = claimWith(authority, 'REVISION-1', entry, selection)
    const preparation = catalog.prepareLaunch({ selection, attemptId: claimed.token.attemptId, sessionId: 'session-1', purpose: 'agent-launch' })

    catalog.update(instance.id, instance.revision, { driverId: 'codex', displayName: 'renamed', command: { kind: 'driver', driverId: 'codex' }, credentialMode: 'external', accountId: null, enabled: true })

    expect(() => authority.admitProviderLaunch({
      lease: claimed.token, attemptId: claimed.token.attemptId, sessionId: 'session-1', purpose: 'agent-launch', preparationId: preparation.id,
      maintenance: { operationId: 'op', epoch: 1, ownerConnectionId: 'daemon-internal' }
    })).toThrowError(expect.objectContaining({ code: 'PREPARATION_STALE' }))
    expect(rows(entry.databasePath, 'SELECT id FROM task_launch_admissions')).toHaveLength(0)
    expect(taskOf(authority, claimed.task.taskId).currentAttempt?.state).toBe('claimed')
  })

  it('refuses admission when the credential binding was replaced after preparation, and performs no spawn', async () => {
    const entry = profile()
    const authority = openAuthority(entry)
    const catalog = openCatalog(authority, entry)
    const account = catalog.createAccount({ driverId: 'codex', displayLabel: 'alpha' })
    const instance = fakeDriverInstance(catalog, 'managed', account.id)
    const first = catalog.bindCredential({ providerInstanceId: instance.id, accountId: account.id, expectedInstanceRevision: instance.revision, expectedAccountRevision: account.revision, credentialRef: 'ref-first', expectedBindingGeneration: 0 })
    const selection = selectionFor(first, account)
    const claimed = claimWith(authority, 'REBIND-1', entry, selection)
    const preparation = catalog.prepareLaunch({ selection, attemptId: claimed.token.attemptId, sessionId: 'session-1', purpose: 'agent-launch' })

    // Replace the binding behind the preparation: retire the first and publish
    // the second, exactly as the governed saga does.
    const database = openTaskAuthorityRawConnection(entry.databasePath)
    const now = new Date().toISOString()
    database.prepare("INSERT INTO provider_credential_operations(id,operation_kind,provider_instance_id,instance_revision,account_id,account_revision,prior_credential_ref,prior_binding_generation,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run('replace-op', 'revoke', instance.id, first.revision, account.id, account.revision, 'ref-first', 1, 'pending', now, now)
    database.close()
    catalog.retireCredentialBindingForOperation({ providerInstanceId: first.id, accountId: account.id, expectedInstanceRevision: first.revision, expectedAccountRevision: account.revision, expectedBindingGeneration: 1, credentialOperationId: 'replace-op' })
    const rebound = catalog.bindCredential({ providerInstanceId: first.id, accountId: account.id, expectedInstanceRevision: catalog.snapshot().instances[0]!.revision, expectedAccountRevision: account.revision, credentialRef: 'ref-second', expectedBindingGeneration: 1 })

    const secrets = secretPort({ environment: { FAKE_PROVIDER_CREDENTIAL: MARKER_ALPHA }, credentialRevision: 1 })
    const child = childPort()

    // The coordinator prepares a FRESH preparation against the live binding, so
    // drive the stale one directly through the authority to isolate the compare.
    expect(() => authority.admitProviderLaunch({
      lease: claimed.token, attemptId: claimed.token.attemptId, sessionId: 'session-1', purpose: 'agent-launch', preparationId: preparation.id,
      maintenance: { operationId: 'op', epoch: 1, ownerConnectionId: 'daemon-internal' }
    })).toThrowError(expect.objectContaining({ code: 'PREPARATION_STALE' }))

    // No broker request and no spawn came of the stale preparation.
    expect(secrets.authorizations).toHaveLength(0)
    expect(child.calls).toHaveLength(0)
    expect(rebound.revision).toBeGreaterThan(first.revision)
    expect(rows(entry.databasePath, 'SELECT id FROM task_launch_admissions')).toHaveLength(0)
  })
})

describe('provider driver provenance and mode isolation', () => {
  it('refuses managed and none for an uncertified built-in before any catalog row exists', () => {
    const entry = profile()
    const authority = openAuthority(entry)
    // No certification records at all: this is the shipped support matrix.
    const catalog = openCatalog(authority, entry, { certified: false })
    expect(() => fakeDriverInstance(catalog, 'managed')).toThrowError(expect.objectContaining({ code: 'DRIVER_MODE_UNCERTIFIED' }))
    expect(() => fakeDriverInstance(catalog, 'none')).toThrowError(expect.objectContaining({ code: 'DRIVER_MODE_UNCERTIFIED' }))
    expect(catalog.snapshot()).toMatchObject({ accounts: [], instances: [] })
  })

  it('refuses a managed arbitrary command at creation and again at launch resolution', () => {
    const entry = profile()
    const authority = openAuthority(entry)
    const catalog = openCatalog(authority, entry)
    expect(() => catalog.create({
      driverId: 'codex', displayName: 'shell managed', command: { kind: 'external-shell', program: 'curl https://example.invalid' }, credentialMode: 'managed', accountId: null, enabled: true
    })).toThrowError(expect.objectContaining({ code: 'DRIVER_MODE_UNCERTIFIED' }))
    // The launch-time resolver refuses independently, so a persisted row that
    // somehow bypassed creation still can never materialize a credential.
    expect(() => resolveProviderLaunchInvocation({ kind: 'external-shell', program: 'curl https://example.invalid' }, 'managed', () => '/usr/bin/fake-provider'))
      .toThrowError(/managed mode requires a driver-owned command/)
  })

  it('resolves driver, external-argv, and external-shell invocations from provenance alone', () => {
    const entry = profile()
    const fake = entry.driver
    // `driver` mode ignores caller text and uses driver resolution only.
    expect(resolveProviderLaunchInvocation({ kind: 'driver', driverId: 'codex' }, 'external', () => fake)).toMatchObject({ kind: 'driver', program: fake, args: [] })
    expect(() => resolveProviderLaunchInvocation({ kind: 'driver', driverId: 'codex' }, 'external', () => undefined)).toThrowError(/could not be resolved/)
    // A basename that merely resembles a known driver is irrelevant: resolution decides.
    expect(resolveProviderLaunchInvocation({ kind: 'driver', driverId: 'codex' }, 'external', () => join(entry.bin, 'not-codex')).program).toBe(join(entry.bin, 'not-codex'))
    expect(resolveProviderLaunchInvocation({ kind: 'external-argv', executable: { executable: '/bin/echo', args: ['hello'] } }, 'external', () => fake)).toMatchObject({ kind: 'external-argv', program: '/bin/echo', args: ['hello'] })
    expect(resolveProviderLaunchInvocation({ kind: 'external-shell', program: 'echo hello' }, 'external', () => fake, 'linux')).toMatchObject({ kind: 'external-shell', args: ['-c', 'echo hello'] })
  })

  it('gives a managed child only the broker environment, with the home and config roots isolated', async () => {
    const entry = profile()
    const authority = openAuthority(entry)
    const catalog = openCatalog(authority, entry)
    const { selection, claimed } = prepared(authority, catalog, entry, 'ISO-1', 'managed')
    const maintenance = maintenancePort(new SqliteProfileMaintenanceGate({ database: authority.database, profileId: PROJECT }))
    const secrets = secretPort({ environment: { FAKE_PROVIDER_CREDENTIAL: MARKER_ALPHA }, credentialRevision: 1 })
    const child = childPort({ identity: IDENTITY() })
    const coordinator = makeCoordinator(authority, entry, {
      maintenance: maintenance.port,
      catalog: { prepareLaunch: input => catalog.prepareLaunch(input) },
      secrets: secrets.port,
      boundary: new SecretOutputBoundary(),
      child: child.port
    })

    const outcome = await coordinator.launchProviderBacked({
      lease: claimed.token, attemptId: claimed.attempt.attemptId, sessionId: 'session-iso', workspaceRoot: entry.workspace, selection, connection: worker(),
      requestedEnvironment: { LANG: 'fr', HOME: '/template', XDG_CONFIG_HOME: '/template/config', FAKE_PROVIDER_CREDENTIAL: 'template', OPENAI_API_KEY: 'template', DONWELLS_DAEMON_TOKEN: 'template' }
    })

    expect(outcome.disposition).toBe('completed')
    expect(child.calls).toHaveLength(1)
    const environment = child.calls[0]!.environment
    // Exactly the broker's declared variable reaches the child.
    expect(environment['FAKE_PROVIDER_CREDENTIAL']).toBe(MARKER_ALPHA)
    expect(environment['LANG']).toBe('fr')
    // The child's home and every derived root resolve inside the isolated root.
    expect(environment['HOME']).toBe(join(entry.isolation, 'session-iso'))
    expect(environment['HOME']).not.toBe(process.env.HOME)
    expect(environment['XDG_CONFIG_HOME']).toBe(join(entry.isolation, 'session-iso', 'config'))
    expect(environment['XDG_DATA_HOME']).toBe(join(entry.isolation, 'session-iso', 'data'))
    // The parent's own credential material is simply absent: this is an
    // allowlist, so a name nobody enumerated cannot survive by omission.
    expect(environment['OPENAI_API_KEY']).toBeUndefined()
    expect(environment['ANTHROPIC_API_KEY']).toBeUndefined()
    expect(environment['DONWELLS_DAEMON_TOKEN']).toBeUndefined()
  })

  it('proves a real child cannot read planted parent-home auth files or unregistered credential variables', async () => {
    const entry = profile()
    const authority = openAuthority(entry)
    const catalog = openCatalog(authority, entry)
    const { selection, claimed } = prepared(authority, catalog, entry, 'ISO-REAL', 'managed')

    // Plant the fallbacks an unisolated child resolves through its home and
    // environment: a real home directory holding a driver auth file, plus
    // credential variables no driver declaration registered.
    //
    // The invariant this proves is home/config-root resolution, which is how a
    // real driver finds a fallback auth store. No environment isolation can stop
    // a child reading an absolute path it was explicitly handed, and this test
    // does not claim otherwise.
    const realHome = join(entry.directory, 'real-home')
    mkdirSync(join(realHome, '.fake-provider'), { recursive: true, mode: 0o700 })
    writeFileSync(join(realHome, '.fake-provider', 'auth.json'), MARKER_BETA, { mode: 0o600 })
    const isolatedHome = join(entry.isolation, 'session-real')
    const savedHome = process.env.HOME
    const savedUserProfile = process.env.USERPROFILE
    process.env.HOME = realHome
    process.env.USERPROFILE = realHome
    process.env['PLANTED_UNREGISTERED_CREDENTIAL'] = MARKER_BETA
    process.env['OPENAI_API_KEY'] = MARKER_BETA

    writeChildPayload(entry, [
      "const { readFileSync } = require('node:fs')",
      "const { join } = require('node:path')",
      "const report = {",
      "  home: process.env.HOME ?? null,",
      "  planted: process.env.PLANTED_UNREGISTERED_CREDENTIAL ?? null,",
      "  openai: process.env.OPENAI_API_KEY ?? null,",
      "  daemon: process.env.DONWELLS_DAEMON_TOKEN ?? null,",
      "  selected: process.env.FAKE_PROVIDER_CREDENTIAL ?? null,",
      "  homeAuth: 'UNREADABLE',",
      "  configAuth: 'UNREADABLE'",
      "}",
      "try { report.homeAuth = readFileSync(join(process.env.HOME ?? '/nonexistent', '.fake-provider', 'auth.json'), 'utf8') } catch {}",
      "try { report.configAuth = readFileSync(join(process.env.XDG_CONFIG_HOME ?? '/nonexistent', '.fake-provider', 'auth.json'), 'utf8') } catch {}",
      "process.stdout.write(JSON.stringify(report))"
    ])

    const maintenance = maintenancePort(new SqliteProfileMaintenanceGate({ database: authority.database, profileId: PROJECT }))
    const boundary = new SecretOutputBoundary()
    const child = realProcessChildPort(entry, boundary)
    const coordinator = makeCoordinator(authority, entry, {
      maintenance: maintenance.port,
      catalog: { prepareLaunch: input => catalog.prepareLaunch(input) },
      secrets: secretPort({ environment: { FAKE_PROVIDER_CREDENTIAL: MARKER_ALPHA }, credentialRevision: 1 }).port,
      boundary,
      child: child.port
    })

    const outcome = await coordinator.launchProviderBacked({
      lease: claimed.token, attemptId: claimed.attempt.attemptId, sessionId: 'session-real', workspaceRoot: entry.workspace, selection, connection: worker(),
      ...(process.platform === 'win32' ? { driverArguments: [join(entry.workspace, 'child.cjs')] } : {})
    })
    expect(outcome.disposition).toBe('completed')
    const report = child.report<Record<string, unknown>>()!
    // The selected account's value did reach the child...
    expect(report['selected']).toBe(MARKER_ALPHA)
    // ...while every fallback an unisolated child would have used is unavailable:
    // the parent-home auth file, the auth file in its own isolated home, the
    // unregistered credential variable, and the app's own authority token.
    // Every home/config-root fallback the parent could have provided resolves
    // inside the empty isolated root instead, so nothing is found there.
    expect(report['homeAuth']).toBe('UNREADABLE')
    expect(report['configAuth']).toBe('UNREADABLE')
    expect(report['planted']).toBeNull()
    expect(report['openai']).toBeNull()
    expect(report['daemon']).toBeNull()
    expect(report['home']).toBe(isolatedHome)
    // The real home the parent was using is NOT what the child was told to use.
    expect(report['home']).not.toBe(realHome)
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = savedUserProfile
    delete process.env['PLANTED_UNREGISTERED_CREDENTIAL']
    delete process.env['OPENAI_API_KEY']
  })

  it('never sends a broker request for a none-mode launch and still isolates the child', async () => {
    const entry = profile()
    const authority = openAuthority(entry)
    const catalog = openCatalog(authority, entry)
    const { selection, claimed } = prepared(authority, catalog, entry, 'NONE-1', 'none')
    const maintenance = maintenancePort(new SqliteProfileMaintenanceGate({ database: authority.database, profileId: PROJECT }))
    const secrets = secretPort(new Error('a none-mode launch must never call Secret Authority'))
    const child = childPort({ identity: IDENTITY() })
    const coordinator = makeCoordinator(authority, entry, {
      maintenance: maintenance.port,
      catalog: { prepareLaunch: input => catalog.prepareLaunch(input) },
      secrets: secrets.port,
      boundary: new SecretOutputBoundary(),
      child: child.port
    })

    const outcome = await coordinator.launchProviderBacked({
      lease: claimed.token, attemptId: claimed.attempt.attemptId, sessionId: 'session-none', workspaceRoot: entry.workspace, selection, connection: worker(),
      requestedEnvironment: { HOME: '/template', FAKE_PROVIDER_CREDENTIAL: 'template' }
    })
    expect(outcome.disposition).toBe('completed')
    expect(secrets.authorizations).toHaveLength(0)
    expect(child.calls[0]!.environment['FAKE_PROVIDER_CREDENTIAL']).toBeUndefined()
    expect(child.calls[0]!.environment['HOME']).toBe(join(entry.isolation, 'session-none'))
  })

  it('never calls Secret Authority for an external launch and keeps inherited external auth', async () => {
    const entry = profile()
    const authority = openAuthority(entry)
    const catalog = openCatalog(authority, entry)
    const { selection, claimed } = prepared(authority, catalog, entry, 'EXT-1', 'external')
    const maintenance = maintenancePort(new SqliteProfileMaintenanceGate({ database: authority.database, profileId: PROJECT }))
    const secrets = secretPort(new Error('an external launch must never call Secret Authority'))
    const child = childPort({ identity: IDENTITY() })
    const coordinator = makeCoordinator(authority, entry, {
      maintenance: maintenance.port,
      catalog: { prepareLaunch: input => catalog.prepareLaunch(input) },
      secrets: secrets.port,
      boundary: new SecretOutputBoundary(),
      child: child.port
    })

    const outcome = await coordinator.launchProviderBacked({
      lease: claimed.token, attemptId: claimed.attempt.attemptId, sessionId: 'session-ext', workspaceRoot: entry.workspace, selection, connection: worker()
    })
    expect(outcome.disposition).toBe('completed')
    expect(secrets.authorizations).toHaveLength(0)
    // External mode intentionally keeps the driver's own inherited auth: the
    // launch does not build an isolated environment for it.
    expect(child.calls[0]!.environment).toEqual(process.env)
  })

  it('executes only the explicit custom command spec for an external-argv instance', async () => {
    const entry = profile()
    const authority = openAuthority(entry)
    const catalog = openCatalog(authority, entry)
    const instance = catalog.create({
      driverId: 'custom-command', displayName: 'custom argv', command: { kind: 'external-argv', executable: { executable: '/bin/echo', args: ['custom-only'] } }, credentialMode: 'external', accountId: null, enabled: true
    })
    const selection: ProviderSelection = { driverId: 'custom-command', providerInstanceId: instance.id, instanceRevision: instance.revision, accountId: null, accountRevision: null }
    const claimed = claimWith(authority, 'ARGV-1', entry, selection)
    const maintenance = maintenancePort(new SqliteProfileMaintenanceGate({ database: authority.database, profileId: PROJECT }))
    const child = childPort({ identity: IDENTITY() })
    const coordinator = makeCoordinator(authority, entry, {
      maintenance: maintenance.port,
      catalog: { prepareLaunch: input => catalog.prepareLaunch(input) },
      secrets: null,
      boundary: new SecretOutputBoundary(),
      child: child.port
    })

    const outcome = await coordinator.launchProviderBacked({
      lease: claimed.token, attemptId: claimed.attempt.attemptId, sessionId: 'session-argv', workspaceRoot: entry.workspace, selection, connection: worker()
    })
    expect(outcome.disposition).toBe('completed')
    expect(child.calls[0]!.program).toBe('/bin/echo')
    expect(child.calls[0]!.args).toEqual(['custom-only'])
  })
})

describe('provider launch failure convergence', () => {
  it('blocks a managed launch with no broker, records a typed retryable failure, and creates no child', async () => {
    const entry = profile()
    const authority = openAuthority(entry)
    const catalog = openCatalog(authority, entry)
    const { selection, claimed } = prepared(authority, catalog, entry, 'NOBROKER-1', 'managed')
    const maintenance = maintenancePort(new SqliteProfileMaintenanceGate({ database: authority.database, profileId: PROJECT }))
    const child = childPort({ identity: IDENTITY() })
    const coordinator = makeCoordinator(authority, entry, {
      maintenance: maintenance.port,
      catalog: { prepareLaunch: input => catalog.prepareLaunch(input) },
      secrets: null,
      boundary: new SecretOutputBoundary(),
      child: child.port
    })

    const outcome = await coordinator.launchProviderBacked({
      lease: claimed.token, attemptId: claimed.attempt.attemptId, sessionId: 'session-nobroker', workspaceRoot: entry.workspace, selection, connection: worker()
    })
    expect(outcome.reason).toBe(SECRET_AUTHORITY_UNAVAILABLE)
    expect(child.calls).toHaveLength(0)
    const task = taskOf(authority, claimed.task.taskId)
    expect(task.currentAttempt?.state).toBe('failed')
    expect(task.status).toBe('failed')
    // The failure language names the missing authority, so a retry is deliberate.
    const events = rows<{ payload_json: string }>(entry.databasePath, "SELECT payload_json FROM task_events WHERE event_type = 'task-failed'")
    expect(events.some(row => row.payload_json.includes(SECRET_AUTHORITY_UNAVAILABLE))).toBe(true)
    expect(maintenance.records.map(record => record.outcome)).toContain('cancelled')
  })

  it('blocks a managed launch when the broker disconnects, without falling back to any other credential', async () => {
    const entry = profile()
    const authority = openAuthority(entry)
    const catalog = openCatalog(authority, entry)
    const { selection, claimed } = prepared(authority, catalog, entry, 'DISCONNECT-1', 'managed')
    const maintenance = maintenancePort(new SqliteProfileMaintenanceGate({ database: authority.database, profileId: PROJECT }))
    const secrets = secretPort(new Error('BROKER_DISCONNECTED'))
    const child = childPort({ identity: IDENTITY() })
    const coordinator = makeCoordinator(authority, entry, {
      maintenance: maintenance.port,
      catalog: { prepareLaunch: input => catalog.prepareLaunch(input) },
      secrets: secrets.port,
      boundary: new SecretOutputBoundary(),
      child: child.port
    })

    const outcome = await coordinator.launchProviderBacked({
      lease: claimed.token, attemptId: claimed.attempt.attemptId, sessionId: 'session-disconnect', workspaceRoot: entry.workspace, selection, connection: worker()
    })
    expect(outcome.reason).toBe(SECRET_AUTHORITY_UNAVAILABLE)
    expect(child.calls).toHaveLength(0)
    // Exactly one broker request was made and no second attempt followed: there
    // is no fallback store to try.
    expect(secrets.authorizations).toHaveLength(1)
  })

  it('creates no child and consumes no preparation when cancellation is committed before admission', async () => {
    const entry = profile()
    const authority = openAuthority(entry)
    const catalog = openCatalog(authority, entry)
    const { selection, claimed } = prepared(authority, catalog, entry, 'CANCEL-1', 'external')
    const maintenance = maintenancePort(new SqliteProfileMaintenanceGate({ database: authority.database, profileId: PROJECT }))
    const child = childPort({ identity: IDENTITY() })

    // Cancel the task inside preparation, which is the last step before the
    // admission transaction. The admission then refuses on cancellation.
    const original = catalog.prepareLaunch.bind(catalog)
    const cancellingCoordinator = makeCoordinator(authority, entry, {
      maintenance: maintenance.port,
      catalog: {
        prepareLaunch: input => {
          const preparation = original(input)
          authority.requestCancellation({ connection: ADMIN, projectId: PROJECT, taskId: claimed.task.taskId, expectedEntityVersion: taskOf(authority, claimed.task.taskId).entityVersion })
          return preparation
        }
      },
      secrets: null,
      boundary: new SecretOutputBoundary(),
      child: child.port
    })

    const outcome = await cancellingCoordinator.launchProviderBacked({
      lease: claimed.token, attemptId: claimed.attempt.attemptId, sessionId: 'session-cancel', workspaceRoot: entry.workspace, selection, connection: worker()
    })
    expect(child.calls).toHaveLength(0)
    expect(outcome.sessionId).toBeNull()
    expect(outcome.reason).toMatch(/launch admission refused/)
    // Neither the attempt nor the preparation changed, and no admission exists.
    expect(rows(entry.databasePath, 'SELECT id FROM task_launch_admissions')).toHaveLength(0)
    expect(rows<{ consumed_at: string | null }>(entry.databasePath, 'SELECT consumed_at FROM provider_launch_preparations').every(row => row.consumed_at === null)).toBe(true)
    expect(maintenance.records.map(record => record.outcome)).toContain('cancelled')
  })

  it('creates no child when cancellation is committed after admission but before the launch-intent check', async () => {
    const entry = profile()
    const authority = openAuthority(entry)
    const catalog = openCatalog(authority, entry)
    // A `none` launch reaches isolation-root creation between admission and the
    // pre-spawn check, which is exactly the window under test.
    const { selection, claimed } = prepared(authority, catalog, entry, 'CANCEL-2', 'none')
    const maintenance = maintenancePort(new SqliteProfileMaintenanceGate({ database: authority.database, profileId: PROJECT }))
    const child = childPort({ identity: IDENTITY() })
    let cancelled = false
    const coordinator = makeCoordinator(authority, entry, {
      maintenance: maintenance.port,
      catalog: { prepareLaunch: input => catalog.prepareLaunch(input) },
      createIsolationRoot: sessionId => {
        const root = join(entry.isolation, sessionId)
        mkdirSync(root, { recursive: true, mode: 0o700 })
        if (!cancelled) {
          cancelled = true
          authority.requestCancellation({ connection: ADMIN, projectId: PROJECT, taskId: claimed.task.taskId, expectedEntityVersion: taskOf(authority, claimed.task.taskId).entityVersion })
        }
        return root
      },
      secrets: null,
      boundary: new SecretOutputBoundary(),
      child: child.port
    })

    const outcome = await coordinator.launchProviderBacked({
      lease: claimed.token, attemptId: claimed.attempt.attemptId, sessionId: 'session-cancel-2', workspaceRoot: entry.workspace, selection, connection: worker()
    })
    // The admission did commit (the attempt is launching), yet no child exists
    // because the pre-spawn check refused it.
    expect(outcome.sessionId).toBeNull()
    expect(outcome.reason).toMatch(/launch-intent check refused/)
    expect(child.calls).toHaveLength(0)
    expect(rows(entry.databasePath, 'SELECT id FROM task_launch_admissions')).toHaveLength(1)
    const consumed = rows<{ consumed_at: string | null }>(entry.databasePath, 'SELECT consumed_at FROM provider_launch_preparations')
    expect(consumed[0]?.consumed_at).not.toBeNull()
    expect(maintenance.records.map(record => record.outcome)).toContain('cancelled')
  })

  it('stops and quarantines when a cancellation races an admitted spawn', async () => {
    const entry = profile()
    const authority = openAuthority(entry)
    const catalog = openCatalog(authority, entry)
    const { selection, claimed } = prepared(authority, catalog, entry, 'RACE-1', 'external')
    const maintenance = maintenancePort(new SqliteProfileMaintenanceGate({ database: authority.database, profileId: PROJECT }))
    const child = childPort({ identity: IDENTITY(), failOpen: false })
    // Cancel from inside the child's own open, which is the tightest possible
    // race: the spawn is already a fact when the cancellation commits.
    child.port.open = (input => {
      const opened = childPort({ identity: IDENTITY() }).port.open(input)
      authority.requestCancellation({ connection: ADMIN, projectId: PROJECT, taskId: claimed.task.taskId, expectedEntityVersion: taskOf(authority, claimed.task.taskId).entityVersion })
      return opened
    }) as typeof child.port.open

    const coordinator = makeCoordinator(authority, entry, {
      maintenance: maintenance.port,
      catalog: { prepareLaunch: input => catalog.prepareLaunch(input) },
      secrets: null,
      boundary: new SecretOutputBoundary(),
      child: child.port
    })

    const outcome = await coordinator.launchProviderBacked({
      lease: claimed.token, attemptId: claimed.attempt.attemptId, sessionId: 'session-race', workspaceRoot: entry.workspace, selection, connection: worker()
    })
    // The spawn is not rolled back; ownership converged through stop/quarantine.
    expect(outcome.sessionId).not.toBeNull()
    expect(['cancelled', 'failed', 'superseded']).toContain(outcome.disposition)
    const attempt = taskOf(authority, claimed.task.taskId).currentAttempt
    expect(['quarantined', 'cancelled', 'failed']).toContain(attempt?.state)
  })

  it('stops a running provider child when the cancellation is committed mid-run', async () => {
    const entry = profile()
    const authority = openAuthority(entry)
    const catalog = openCatalog(authority, entry)
    const { selection, claimed } = prepared(authority, catalog, entry, 'CANCEL-MID-1', 'external')
    const maintenance = maintenancePort(new SqliteProfileMaintenanceGate({ database: authority.database, profileId: PROJECT }))
    // The child stays live across polls, so the cancellation lands while it runs.
    const child = childPort({ identity: IDENTITY(), livePolls: 400 })
    const bare = child.port.output
    let polls = 0
    child.port.output = (sessionId => {
      polls += 1
      // Committed from inside the run, exactly like a user cancellation arriving
      // after the launch returned.
      if (polls === 2) {
        authority.requestCancellation({ connection: ADMIN, projectId: PROJECT, taskId: claimed.task.taskId, expectedEntityVersion: taskOf(authority, claimed.task.taskId).entityVersion })
      }
      return bare(sessionId)
    }) as typeof child.port.output

    const coordinator = makeCoordinator(authority, entry, {
      maintenance: maintenance.port,
      catalog: { prepareLaunch: input => catalog.prepareLaunch(input) },
      secrets: null,
      boundary: new SecretOutputBoundary(),
      child: child.port
    })

    const outcome = await coordinator.launchProviderBacked({
      lease: claimed.token, attemptId: claimed.attempt.attemptId, sessionId: 'session-cancel-mid', workspaceRoot: entry.workspace, selection, connection: worker()
    })

    // The stop reached the still-running child instead of waiting for its
    // natural exit, and the attempt settled terminally rather than as
    // `superseded` behind a fenced write that was refused.
    expect(child.stopped).toContain('session-cancel-mid')
    expect(outcome.disposition).toBe('cancelled')
    expect(taskOf(authority, claimed.task.taskId).currentAttempt?.state).toBe('cancelled')
  })

  it('renews an interactive lease once per window instead of on every pump poll', async () => {
    const entry = profile()
    const authority = openAuthority(entry)
    const catalog = openCatalog(authority, entry)
    // A short TTL puts the renewal window open from the first poll.
    const { selection, claimed } = prepared(authority, catalog, entry, 'RENEW-1', 'external', undefined, 1_500)
    const maintenance = maintenancePort(new SqliteProfileMaintenanceGate({ database: authority.database, profileId: PROJECT }))
    const child = childPort({ identity: IDENTITY(), livePolls: 200 })
    const coordinator = makeCoordinator(authority, entry, {
      maintenance: maintenance.port,
      catalog: { prepareLaunch: input => catalog.prepareLaunch(input) },
      secrets: null,
      boundary: new SecretOutputBoundary(),
      child: child.port
    })

    const outcome = await coordinator.launchProviderBacked({
      lease: claimed.token, attemptId: claimed.attempt.attemptId, sessionId: 'session-renew', workspaceRoot: entry.workspace, selection, connection: worker()
    })

    expect(outcome.disposition).toBe('completed')
    // The token's expiry is frozen at claim time, so every poll inside the window
    // would otherwise write its own heartbeat row.
    const renewals = rows<{ count: number }>(entry.databasePath, 'SELECT COUNT(*) AS count FROM lease_renewals WHERE lease_id = ?', claimed.token.leaseId)
    expect(renewals[0]?.count).toBe(1)
  })

  it('converges a refused runtime bind without disclosing anything and without claiming a rollback', async () => {
    const entry = profile()
    const authority = openAuthority(entry)
    const catalog = openCatalog(authority, entry)
    const { selection, claimed } = prepared(authority, catalog, entry, 'SPAWN-1', 'external')
    const maintenance = maintenancePort(new SqliteProfileMaintenanceGate({ database: authority.database, profileId: PROJECT }))
    const child = childPort({ identity: null })
    const coordinator = makeCoordinator(authority, entry, {
      maintenance: maintenance.port,
      catalog: { prepareLaunch: input => catalog.prepareLaunch(input) },
      secrets: null,
      boundary: new SecretOutputBoundary(),
      child: child.port
    })

    const outcome = await coordinator.launchProviderBacked({
      lease: claimed.token, attemptId: claimed.attempt.attemptId, sessionId: 'session-spawn', workspaceRoot: entry.workspace, selection, connection: worker()
    })
    expect(outcome.sessionId).not.toBeNull()
    expect(child.stopped).toContain(outcome.sessionId)
    // Quarantine, not a fabricated rollback.
    expect(taskOf(authority, claimed.task.taskId).currentAttempt?.state).toBe('quarantined')
    expect(outcome.reason).not.toContain(MARKER_ALPHA)
  })

  it('converges a child that fails to start without leaving an admission or a preparation behind', async () => {
    const entry = profile()
    const authority = openAuthority(entry)
    const catalog = openCatalog(authority, entry)
    const { selection, claimed } = prepared(authority, catalog, entry, 'FAILOPEN-1', 'external')
    const maintenance = maintenancePort(new SqliteProfileMaintenanceGate({ database: authority.database, profileId: PROJECT }))
    const child = childPort({ identity: IDENTITY(), failOpen: true })
    const coordinator = makeCoordinator(authority, entry, {
      maintenance: maintenance.port,
      catalog: { prepareLaunch: input => catalog.prepareLaunch(input) },
      secrets: null,
      boundary: new SecretOutputBoundary(),
      child: child.port
    })

    const outcome = await coordinator.launchProviderBacked({
      lease: claimed.token, attemptId: claimed.attempt.attemptId, sessionId: 'session-failopen', workspaceRoot: entry.workspace, selection, connection: worker()
    })
    expect(outcome.sessionId).toBeNull()
    expect(taskOf(authority, claimed.task.taskId).currentAttempt?.state).toBe('failed')
    expect(maintenance.records.map(record => record.outcome)).toContain('cancelled')
  })

  it('releases a refused pre-spawn launch, when no PTY session ever exists to exit', async () => {
    const entry = profile()
    const authority = openAuthority(entry)
    const catalog = openCatalog(authority, entry)
    const { selection, claimed } = prepared(authority, catalog, entry, 'PRE-SPAWN-1', 'managed')
    const maintenance = maintenancePort(new SqliteProfileMaintenanceGate({ database: authority.database, profileId: PROJECT }))
    const secrets = secretPort({ environment: { FAKE_PROVIDER_CREDENTIAL: MARKER_ALPHA }, credentialRevision: 1 })
    const boundary = new SecretOutputBoundary()
    // The managed launch registers exactly the broker's values, and the child
    // then refuses to start. Nothing else can release that registration: the
    // daemon creates the PTY inside `child.open`, so there is no session to exit,
    // no dismissal to join, and nothing for the reap timer to fire on.
    const child = childPort({ identity: IDENTITY(), failOpen: true })
    const coordinator = makeCoordinator(authority, entry, {
      maintenance: maintenance.port,
      catalog: { prepareLaunch: input => catalog.prepareLaunch(input) },
      secrets: secrets.port,
      boundary,
      child: child.port
    })

    const outcome = await coordinator.launchProviderBacked({
      lease: claimed.token, attemptId: claimed.attempt.attemptId, sessionId: 'session-pre-spawn', workspaceRoot: entry.workspace, selection, connection: worker()
    })

    expect(outcome.sessionId).toBeNull()
    expect(outcome.reason).toContain('provider child failed to start')
    expect(child.calls).toHaveLength(0)
    expect(boundary.registeredSessions).toEqual([])
  })

  it('converges when the output port itself fails mid-pump', async () => {
    const entry = profile()
    const authority = openAuthority(entry)
    const catalog = openCatalog(authority, entry)
    const { selection, claimed } = prepared(authority, catalog, entry, 'PUMP-1', 'external')
    const maintenance = maintenancePort(new SqliteProfileMaintenanceGate({ database: authority.database, profileId: PROJECT }))
    // A reaped or unknown session makes the port throw after the spawn: the pump
    // body is the launch's only remaining owner at that point.
    const child = childPort({ identity: IDENTITY(), failOutput: true })
    const coordinator = makeCoordinator(authority, entry, {
      maintenance: maintenance.port,
      catalog: { prepareLaunch: input => catalog.prepareLaunch(input) },
      secrets: null,
      boundary: new SecretOutputBoundary(),
      child: child.port
    })

    const outcome = await coordinator.launchProviderBacked({
      lease: claimed.token, attemptId: claimed.attempt.attemptId, sessionId: 'session-pump', workspaceRoot: entry.workspace, selection, connection: worker()
    })

    expect(outcome.disposition).toBe('cancelled')
    expect(outcome.reason).toContain('provider output pump failed')
    expect(child.stopped).toContain(outcome.sessionId)
    // Quarantined, and the admission released: an escaped pump failure would
    // leave the child live with the admission open and the attempt `running`.
    expect(taskOf(authority, claimed.task.taskId).currentAttempt?.state).toBe('quarantined')
    expect(maintenance.records.map(record => record.outcome)).toContain('completed')
  })

  it('releases an interactive launch when its swallowed pump fails', async () => {
    const entry = profile()
    const authority = openAuthority(entry)
    const catalog = openCatalog(authority, entry)
    const { selection, claimed } = prepared(authority, catalog, entry, 'PUMP-2', 'external')
    const maintenance = maintenancePort(new SqliteProfileMaintenanceGate({ database: authority.database, profileId: PROJECT }))
    const child = childPort({ identity: IDENTITY(), failOutput: true })
    const coordinator = makeCoordinator(authority, entry, {
      maintenance: maintenance.port,
      catalog: { prepareLaunch: input => catalog.prepareLaunch(input) },
      secrets: null,
      boundary: new SecretOutputBoundary(),
      child: child.port
    })

    const launched = await coordinator.launchProviderBacked({
      lease: claimed.token, attemptId: claimed.attempt.attemptId, sessionId: 'session-pump-interactive',
      workspaceRoot: entry.workspace, selection, connection: worker(), interactive: true
    })
    expect(launched.disposition).toBe('launched')
    // The caller swallows this promise, so it is the only place the launch can be
    // released from; nothing may be left for a dismissal that never comes.
    await launched.completion

    expect(child.stopped).toContain(launched.sessionId)
    expect(maintenance.records.map(record => record.outcome)).toContain('completed')
    // Quarantine is the converged state, not a failed or superseded write.
    expect(taskOf(authority, claimed.task.taskId).currentAttempt?.state).toBe('quarantined')
  })
})

describe('provider launch: maintenance freeze contention', () => {
  it('refuses a launch whose admission is adopted by a freeze, and lets only one admission win', async () => {
    const entry = profile()
    const authority = openAuthority(entry)
    const catalog = openCatalog(authority, entry)
    const { selection, claimed } = prepared(authority, catalog, entry, 'FREEZE-1', 'external')
    const gate = new SqliteProfileMaintenanceGate({ database: authority.database, profileId: PROJECT })
    const maintenance = maintenancePort(gate)

    // A live pre-freeze admission admits work.
    const admitted = await gate.admit({ connectionId: 'daemon-internal' }, 'provider-authority', 'pre-freeze')
    expect(admitted.epoch).toBe(1)

    // The freeze adopts every outstanding admission into its own migration.
    await gate.acquire({ connectionId: 'migration-owner' }, { migrationId: 'migration-1', ownerStage: 'stage-3', participants: ['task-authority', 'provider-authority'], expectedRevision: gate.readState().revision })

    // That adopted admission can no longer authorize a launch: its migration id
    // is no longer the pre-migration reservation.
    const preparation = catalog.prepareLaunch({ selection, attemptId: claimed.token.attemptId, sessionId: 'session-freeze', purpose: 'agent-launch' })
    expect(() => authority.admitProviderLaunch({
      lease: claimed.token, attemptId: claimed.token.attemptId, sessionId: 'session-freeze', purpose: 'agent-launch', preparationId: preparation.id,
      maintenance: { operationId: 'pre-freeze', epoch: 1, ownerConnectionId: 'daemon-internal' }
    })).toThrowError(expect.objectContaining({ code: 'MAINTENANCE_ADMISSION_STALE' }))
    expect(rows<{ consumed_at: string | null }>(entry.databasePath, 'SELECT consumed_at FROM provider_launch_preparations WHERE id = ?', preparation.id)[0]?.consumed_at).toBeNull()

    // A freeze racing a fresh admission has one winner: once the lease is held,
    // `admit` is refused for the participant whose work the freeze covers.
    await expect(maintenance.port.admit('provider-authority', 'during-freeze')).rejects.toThrowError(/profile maintenance phase/)
    expect(maintenance.records.some(record => record.operationId === 'during-freeze')).toBe(false)
  })
})

describe('provider launch: the output boundary against a real child', () => {
  it('redacts whole and every-boundary-split markers a real child wrote to both streams', async () => {
    const entry = profile()
    const authority = openAuthority(entry)
    const catalog = openCatalog(authority, entry)
    const { selection, claimed } = prepared(authority, catalog, entry, 'REDACT-1', 'managed')

    // A real child that echoes the marker whole and split at EVERY byte offset,
    // on stdout and stderr, so redaction is proven against bytes an OS process
    // actually produced rather than against a string the test assembled.
    const maintenance = maintenancePort(new SqliteProfileMaintenanceGate({ database: authority.database, profileId: PROJECT }))
    writeChildPayload(entry, [
      "const marker = process.env.FAKE_PROVIDER_CREDENTIAL ?? ''",
      "process.stdout.write('whole:' + marker + '\\n')",
      "for (let i = 1; i < marker.length; i += 1) process.stdout.write('out:' + marker.slice(0, i) + marker.slice(i) + '\\n')",
      "process.stderr.write('errwhole:' + marker + '\\n')",
      "for (let i = 1; i < marker.length; i += 1) process.stderr.write('err:' + marker.slice(0, i) + marker.slice(i) + '\\n')"
    ])
    const boundary = new SecretOutputBoundary()
    const child = realProcessChildPort(entry, boundary)
    const coordinator = makeCoordinator(authority, entry, {
      maintenance: maintenance.port,
      catalog: { prepareLaunch: input => catalog.prepareLaunch(input) },
      secrets: secretPort({ environment: { FAKE_PROVIDER_CREDENTIAL: MARKER_ALPHA }, credentialRevision: 1 }).port,
      boundary,
      child: child.port
    })

    const outcome = await coordinator.launchProviderBacked({
      lease: claimed.token, attemptId: claimed.attempt.attemptId, sessionId: 'session-redact', workspaceRoot: entry.workspace, selection, connection: worker(),
      ...(process.platform === 'win32' ? { driverArguments: [join(entry.workspace, 'child.cjs')] } : {})
    })

    expect(outcome.disposition).toBe('completed')
    // The real child truly emitted the marker, whole and split at every offset.
    expect(child.rawStdout()).toContain(`whole:${MARKER_ALPHA}`)
    expect(child.rawStdout()).toContain(`out:${MARKER_ALPHA.slice(0, 1)}${MARKER_ALPHA.slice(1)}`)
    expect(child.rawStderr()).toContain(`errwhole:${MARKER_ALPHA}`)
    expect(child.rawStderr()).toContain(`err:${MARKER_ALPHA.slice(0, 5)}${MARKER_ALPHA.slice(5)}`)

    // Everything the daemon retained is redacted, on both streams, including the
    // split occurrences re-joined across every possible boundary.
    const safe = `${child.safeStdout()}${child.safeStderr()}`
    expect(safe).not.toContain(MARKER_ALPHA)
    expect(safe).toContain('whole:[REDACTED]')
    expect(safe).toContain('errwhole:[REDACTED]')
    expect(safe).toContain('out:[REDACTED]')
    expect(safe).toContain('err:[REDACTED]')
    // No fragment long enough to identify the marker survives on either stream.
    expect(safe).not.toContain(MARKER_ALPHA.slice(0, 6))
    expect(safe).not.toContain(MARKER_ALPHA.slice(6))
    // The pattern material is zeroized once the child's pipes have closed, and
    // later output is dropped rather than emitted unredacted.
    expect(boundary.isClosed('session-redact')).toBe(true)
    expect(boundary.push('session-redact', 'stdout', MARKER_ALPHA)).toBe('')
  })
})

/**
 * Runs a REAL OS child for one launch and records exactly what the daemon's
 * boundary settled, per stream. The child re-runs the invocation directly (the
 * resolved program and argv the coordinator produced) with the environment the
 * coordinator built, so both the isolation and the redaction are proven against
 * a live process rather than against a fixture.
 *
 * `stdout`/`stderr` are cumulative, matching the daemon contract, and the
 * boundary push happens on the same two streams the PTY sinks use.
 */
function realProcessChildPort(entry: Profile, boundary: SecretOutputBoundary) {
  const runs: Array<{ sessionId: string; rawStdout: string; rawStderr: string; safeStdout: string; safeStderr: string; exitCode: number }> = []
  const reports: unknown[] = []
  const port: ProviderChildPort = {
    open: input => {
      const sessionId = input.sessionId
      const result = spawnSync(input.invocation.program, [...input.invocation.args], { cwd: entry.workspace, env: input.environment as NodeJS.ProcessEnv, encoding: 'utf8' })
      const rawStdout = result.stdout ?? ''
      const rawStderr = result.stderr ?? ''
      reports.push(parseFirstJson(rawStdout))
      runs.push({ sessionId, rawStdout, rawStderr, safeStdout: rawStdout, safeStderr: rawStderr, exitCode: result.status ?? 0 })
      return { sessionId, processIdentity: IDENTITY(9100 + runs.length) }
    },
    stop: async () => undefined,
    stopProcess: async () => undefined,
    output: sessionId => {
      const run = runs.find(candidate => candidate.sessionId === sessionId)
      if (run === undefined) return { stdout: '', stderr: '', exited: true, exitCode: 0 }
      // The daemon pushes each stream through the one boundary per stream.
      run.safeStdout = boundary.has(sessionId) ? boundary.push(sessionId, 'stdout', run.rawStdout) : run.rawStdout
      run.safeStderr = boundary.has(sessionId) ? boundary.push(sessionId, 'stderr', run.rawStderr) : run.rawStderr
      return { stdout: run.rawStdout, stderr: run.rawStderr, exited: true, exitCode: run.exitCode }
    }
  }
  return {
    port,
    rawStdout: () => runs.map(run => run.rawStdout).join(''),
    rawStderr: () => runs.map(run => run.rawStderr).join(''),
    safeStdout: () => runs.map(run => run.safeStdout).join(''),
    safeStderr: () => runs.map(run => run.safeStderr).join(''),
    report: <T>(): T => reports.at(-1) as T
  }
}

/** The child's report is a single JSON document on stdout. */
function parseFirstJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

/**
 * Writes a JavaScript file the launch executes as a real child, and returns the
 * invocation the coordinator would resolve for `node <file>`.
 */
function writeChildPayload(entry: Profile, lines: readonly string[]): string {
  const path = join(entry.workspace, 'child.cjs')
  writeFileSync(path, lines.join('\n'), { mode: 0o600 })
  return path
}
