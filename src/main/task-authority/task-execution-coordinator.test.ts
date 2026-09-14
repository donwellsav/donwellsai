import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ProcessIdentity, ProcessIdentityVerdict } from '@shared/child-process/process-spec'
import {
  type AuthenticatedAuthorityConnection,
  type ClaimResult,
  type TaskExecutionSpecificationInput
} from '@shared/task-authority'
import { openTaskAuthorityRawConnection } from './schema'
import { SqliteTaskAuthority } from './task-authority'
import { DaemonTaskEvidencePort } from './task-evidence-port'
import {
  TaskExecutionCoordinator,
  TaskSchedulerPump,
  type TaskChildOwnerPort,
  type TaskLaunchPorts
} from './task-execution-coordinator'

const PROJECT = 'project-coordinator'
const OWNER_ALICE = '12121212-1212-4212-8212-121212121212'
const OWNER_BOB = '34343434-3434-4434-8434-343434343434'

const ADMIN: AuthenticatedAuthorityConnection = { connectionId: 'conn-admin', role: 'administrator' }
const worker = (ownerId: string, projectId: string = PROJECT): AuthenticatedAuthorityConnection => ({
  connectionId: `conn-worker-${ownerId}`,
  role: 'worker',
  ownerId,
  authorizedProjectIds: [projectId]
})

const IDENTITY = (pid = 4242): ProcessIdentity => ({
  pid,
  bootId: 'boot-1',
  startedAt: new Date().toISOString(),
  executablePath: '/usr/bin/node',
  family: 'acp-agent',
  capturedAt: new Date().toISOString()
})

const VERDICTS: Record<'valid' | 'stale' | 'indeterminate', ProcessIdentityVerdict> = {
  valid: { status: 'valid', current: IDENTITY() },
  stale: { status: 'stale', reason: 'not-found' },
  indeterminate: { status: 'indeterminate', reason: 'access-denied', detail: 'native observer denied' }
}

const SPEC = (root: string, requiredArtifacts: ReadonlyArray<{ path: string; relationship: 'attached-reference' | 'observed-during-run' }> = []): TaskExecutionSpecificationInput => ({
  command: { program: 'node', args: ['run.js'], cwd: root },
  target: { kind: 'local', root, label: 'repo' },
  verification: { requiredArtifacts }
})

const directories: string[] = []
const authorities: SqliteTaskAuthority[] = []
function tempDirectory(): string {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'task-coordinator-')))
  directories.push(directory)
  return directory
}
function openAuthority(directory: string = tempDirectory()): { authority: SqliteTaskAuthority; path: string; directory: string } {
  const databasePath = join(directory, 'task-authority.sqlite')
  const instance = SqliteTaskAuthority.open({ databasePath })
  authorities.push(instance)
  return { authority: instance, path: databasePath, directory }
}
afterEach(() => {
  while (authorities.length > 0) authorities.pop()?.close()
  while (directories.length > 0) rmSync(directories.pop() as string, { recursive: true, force: true })
})

function eventTypes(path: string, projectId: string, taskId: string): Array<{ type: string; payload: Record<string, unknown> }> {
  const db = openTaskAuthorityRawConnection(path)
  try {
    const rows = db.prepare('SELECT event_type, payload_json FROM task_events WHERE project_id = ? AND task_id = ? ORDER BY sequence').all(projectId, taskId) as Array<Record<string, unknown>>
    return rows.map(row => ({ type: String(row['event_type']), payload: JSON.parse(String(row['payload_json'])) as Record<string, unknown> }))
  } finally {
    db.close()
  }
}

function createTask(authority: SqliteTaskAuthority, externalTaskId: string) {
  return authority.createTask({ connection: ADMIN, projectId: PROJECT, externalTaskId, title: `task ${externalTaskId}` })
}

function claim(authority: SqliteTaskAuthority, externalTaskId: string, ownerId: string = OWNER_ALICE, specification: TaskExecutionSpecificationInput = SPEC('/repo'), leaseTtlMs?: number): ClaimResult {
  return authority.claim({ connection: worker(ownerId), projectId: PROJECT, externalTaskId, specification, ...(leaseTtlMs === undefined ? {} : { leaseTtlMs }) })
}

function taskOf(authority: SqliteTaskAuthority, taskId: string) {
  return authority.query({ connection: ADMIN, projectId: PROJECT }).tasks.find(candidate => candidate.taskId === taskId)!
}

// -- fake finite-job / agent-open ports ---------------------------------------

type FakeStep = Readonly<{ output: string; exited: boolean; exitCode?: number; run?: () => void }>

type FakeOpenContext = Readonly<{ authority: SqliteTaskAuthority; projectId: string; taskId: string; sessionId: string }>

type FakePortOptions = Readonly<{
  identity?: ProcessIdentity | null
  script?: readonly FakeStep[]
  onOpenJob?: (context: FakeOpenContext) => void
  onOpenAgent?: (context: FakeOpenContext) => void
  stopFailures?: number
}>

function fakePorts(authority: SqliteTaskAuthority, options: FakePortOptions = {}) {
  const calls = { jobOpens: 0, agentOpens: 0, stopAttempts: 0, processStops: 0 }
  const scripts = new Map<string, { steps: readonly FakeStep[]; index: number; runOnce: Set<number> }>()
  let stopFailuresLeft = options.stopFailures ?? 0

  const open = (kind: 'job' | 'agent', onOpen: ((context: FakeOpenContext) => void) | undefined, projectId: string, taskId: string) => {
    const sessionId = randomUUID()
    scripts.set(sessionId, { steps: options.script ?? [{ output: '', exited: true, exitCode: 0 }], index: 0, runOnce: new Set() })
    if (kind === 'job') calls.jobOpens += 1
    else calls.agentOpens += 1
    onOpen?.({ authority, projectId, taskId, sessionId })
    return { sessionId, processIdentity: options.identity === undefined ? IDENTITY() : options.identity }
  }

  const owner = (kind: 'job' | 'agent'): TaskChildOwnerPort => ({
    stop: async (sessionId: string) => {
      if (kind === 'job') {
        calls.stopAttempts += 1
        if (!scripts.has(sessionId)) throw new Error('unknown session: ' + sessionId)
        if (stopFailuresLeft > 0) {
          stopFailuresLeft -= 1
          throw new Error('transient stop failure')
        }
      }
    },
    stopProcess: async () => {
      calls.processStops += 1
      if (stopFailuresLeft > 0) {
        stopFailuresLeft -= 1
        throw new Error('transient process stop failure')
      }
    },
    output: (sessionId: string, afterOffset: number) => {
      const script = scripts.get(sessionId)
      if (!script) return { output: '', totalBytes: afterOffset, exited: true, exitCode: 0 }
      const stepIndex = Math.min(script.index, script.steps.length - 1)
      const step = script.steps[stepIndex]!
      if (step.run && !script.runOnce.has(stepIndex)) {
        script.runOnce.add(stepIndex)
        step.run()
      }
      if (script.index < script.steps.length - 1) script.index += 1
      return { output: step.output, totalBytes: afterOffset + step.output.length, exited: step.exited, exitCode: step.exitCode }
    }
  })

  let pendingProjectId = ''
  let pendingTaskId = ''
  const ports: TaskLaunchPorts = {
    jobs: {
      openJob: () => open('job', options.onOpenJob, pendingProjectId, pendingTaskId),
      ...owner('job')
    },
    agents: {
      openAgent: () => open('agent', options.onOpenAgent, pendingProjectId, pendingTaskId),
      ...owner('agent')
    }
  }
  const setPending = (claimResult: ClaimResult) => {
    pendingProjectId = claimResult.task.projectId
    pendingTaskId = claimResult.task.taskId
  }
  return { ports, calls, setPending }
}

function makeCoordinator(
  authority: SqliteTaskAuthority,
  ports: TaskLaunchPorts,
  verifyIdentity?: (identity: ProcessIdentity) => ProcessIdentityVerdict
): TaskExecutionCoordinator {
  return new TaskExecutionCoordinator({
    authority,
    ports,
    evidence: new DaemonTaskEvidencePort(),
    ...(verifyIdentity === undefined ? {} : { verifyIdentity }),
    pumpPollMs: 1
  })
}

/** Real-time integration tests: the authority's clock is SQLite unixepoch, which cannot be faked from a worker. */
const integration = it

describe('task execution coordinator', () => {
  integration('persists specification, canonical reservation, and planned intent before creating the child', async () => {
    const { authority, path, directory } = openAuthority()
    const workspace = join(directory, 'work')
    mkdirSync(workspace)
    const specification = SPEC(workspace)
    createTask(authority, 'DW-1')
    const claimed = claim(authority, 'DW-1', OWNER_ALICE, specification)
    const { ports, calls, setPending } = fakePorts(authority, {
      script: [{ output: 'first line\nsecond line\n', exited: true, exitCode: 0 }],
      onOpenJob: ({ authority: a, projectId, taskId }) => {
        const attempt = taskOf(a, taskId).currentAttempt!
        if (attempt.reservation?.state !== 'reserved') throw new Error('reservation was not committed before the child')
        if (attempt.runtime?.launchState !== 'spawning') throw new Error('launch intent was not admitted before the child')
        if (attempt.specificationId !== claimed.attempt.specificationId) throw new Error('specification was not persisted at claim time')
        void projectId
      }
    })
    const coordinator = makeCoordinator(authority, ports)
    setPending(claimed)
    const outcome = await coordinator.launch(claimed, specification, worker(OWNER_ALICE))
    expect(calls.jobOpens).toBe(1)
    expect(outcome.disposition).toBe('completed')
    expect(outcome.exitCode).toBe(0)
    expect(outcome.output).toBe('first line\nsecond line\n')
    expect(outcome.task.status).toBe('done')
    expect(outcome.attempt.state).toBe('completed')
    const types = eventTypes(path, PROJECT, claimed.task.taskId).map(event => event.type)
    expect(types).toContain('worktree-bound')
    expect(types).toContain('launch-intent-recorded')
    expect(types.indexOf('spawn-admitted')).toBeGreaterThan(types.indexOf('launch-intent-recorded'))
    expect(types.indexOf('runtime-facts-recorded')).toBeGreaterThan(types.indexOf('spawn-admitted'))
    expect(types.indexOf('runtime-bound')).toBeGreaterThan(types.indexOf('runtime-facts-recorded'))
    expect(types).toContain('task-progress')
    expect(types[types.length - 1]).toBe('task-completed')
    expect(taskOf(authority, claimed.task.taskId).currentAttempt?.reservation?.state ?? 'released').not.toBe('reserved')
  })

  integration('treats a planned launch intent as no spawn admission', async () => {
    const { authority, directory } = openAuthority()
    const workspace = join(directory, 'work')
    mkdirSync(workspace)
    createTask(authority, 'DW-2')
    const claimed = claim(authority, 'DW-2', OWNER_ALICE, SPEC(workspace))
    const { ports, calls, setPending } = fakePorts(authority)
    const coordinator = makeCoordinator(authority, ports)
    setPending(claimed)
    const prepared = coordinator.prepareLaunch(claimed, SPEC(workspace), worker(OWNER_ALICE))
    expect(prepared.launchIntentId.length).toBe(36)
    expect(() =>
      authority.write({ kind: 'bind-runtime', connection: worker(OWNER_ALICE), token: claimed.token, sessionId: 'early-session', processIdentity: IDENTITY() })
    ).toThrowError(expect.objectContaining({ code: 'STALE_AUTHORITY' }))
    expect(calls.jobOpens).toBe(0)
  })

  integration('runs task-linked agent.open through the same fencing', async () => {
    const { authority, path, directory } = openAuthority()
    const workspace = join(directory, 'work')
    mkdirSync(workspace)
    createTask(authority, 'DW-3')
    const claimed = claim(authority, 'DW-3', OWNER_ALICE, SPEC(workspace))
    const { ports, calls, setPending } = fakePorts(authority)
    const coordinator = makeCoordinator(authority, ports)
    setPending(claimed)
    const outcome = await coordinator.launch(claimed, SPEC(workspace), worker(OWNER_ALICE), 'acp-agent')
    expect(calls.agentOpens).toBe(1)
    expect(calls.jobOpens).toBe(0)
    expect(outcome.disposition).toBe('completed')
    const types = eventTypes(path, PROJECT, claimed.task.taskId).map(event => event.type)
    expect(types.indexOf('spawn-admitted')).toBeGreaterThan(-1)
    expect(eventTypes(path, PROJECT, claimed.task.taskId).filter(event => event.type === 'runtime-facts-recorded')).toHaveLength(1)
  })

  integration('prevents openJob and agent.open when cancellation commits before the planned -> spawning admission', async () => {
    const { authority, path, directory } = openAuthority()
    const workspace = join(directory, 'work')
    mkdirSync(workspace)
    createTask(authority, 'DW-4')
    const claimed = claim(authority, 'DW-4', OWNER_ALICE, SPEC(workspace))
    const { ports, calls, setPending } = fakePorts(authority)
    const coordinator = makeCoordinator(authority, ports)
    setPending(claimed)
    const prepared = coordinator.prepareLaunch(claimed, SPEC(workspace), worker(OWNER_ALICE))
    authority.requestCancellation({ connection: ADMIN, projectId: PROJECT, taskId: claimed.task.taskId, expectedEntityVersion: taskOf(authority, claimed.task.taskId).entityVersion })
    const outcome = await coordinator.continueLaunch(prepared, SPEC(workspace), worker(OWNER_ALICE))
    expect(calls.jobOpens).toBe(0)
    expect(calls.agentOpens).toBe(0)
    expect(outcome.disposition).toBe('cancelled')
    expect(outcome.attempt.state).toBe('cancelling')
    expect(eventTypes(path, PROJECT, claimed.task.taskId).map(event => event.type)).not.toContain('spawn-admitted')
    expect(() => claim(authority, 'DW-4', OWNER_BOB, SPEC(workspace))).toThrowError(expect.objectContaining({ code: 'TASK_CANCELLED' }))
  })

  integration('persists the returned identity, stops once through the original owner, and acknowledges exit when cancellation wins after spawning', async () => {
    const { authority, directory } = openAuthority()
    const workspace = join(directory, 'work')
    mkdirSync(workspace)
    const identity = IDENTITY(7777)
    createTask(authority, 'DW-5')
    const claimed = claim(authority, 'DW-5', OWNER_ALICE, SPEC(workspace))
    const { ports, calls, setPending } = fakePorts(authority, {
      identity,
      onOpenJob: ({ authority: a, projectId, taskId }) => {
        a.requestCancellation({ connection: ADMIN, projectId, taskId, expectedEntityVersion: taskOf(a, taskId).entityVersion })
      }
    })
    const coordinator = makeCoordinator(authority, ports)
    setPending(claimed)
    const outcome = await coordinator.launch(claimed, SPEC(workspace), worker(OWNER_ALICE))
    expect(outcome.disposition).toBe('cancelled')
    expect(outcome.task.status).toBe('cancelled')
    expect(calls.jobOpens).toBe(1)
    expect(calls.stopAttempts).toBe(1)
    expect(outcome.attempt.runtime?.processIdentity).toEqual(identity)
    expect(outcome.attempt.reservation?.state ?? 'released').not.toBe('quarantined')
    const attempt = taskOf(authority, claimed.task.taskId).currentAttempt!
    await coordinator.deliverStop(claimed.token, attempt)
    expect(calls.stopAttempts).toBe(1)
  })

  integration('blocks a successor after expiry wins and lets a takeover reclaim the attempt', async () => {
    const { authority, directory } = openAuthority()
    const workspace = join(directory, 'work')
    mkdirSync(workspace)
    createTask(authority, 'DW-6')
    const claimed = claim(authority, 'DW-6', OWNER_ALICE, SPEC(workspace), 1000)
    const startedAt = Date.now()
    const { ports, calls, setPending } = fakePorts(authority, {
      onOpenJob: () => {
        while (Date.now() < startedAt + 1150) { /* real authority-time lease expiry; unixepoch cannot be faked from a worker */ }
      }
    })
    const coordinator = makeCoordinator(authority, ports, () => ({ status: 'stale', reason: 'not-found' }))
    setPending(claimed)
    const prepared = coordinator.prepareLaunch(claimed, SPEC(workspace), worker(OWNER_ALICE))
    const outcome = await coordinator.continueLaunch(prepared, SPEC(workspace), worker(OWNER_ALICE))
    expect(outcome.disposition).toBe('reconciled')
    expect(calls.jobOpens).toBe(1)
    expect(calls.stopAttempts).toBe(1)
    const midAttempt = taskOf(authority, claimed.task.taskId).currentAttempt!
    expect(midAttempt.state).toBe('launching')
    expect(midAttempt.runtime?.stopState).toBe('exited')
    expect(midAttempt.reservation?.state).toBe('reserved')
    expect(() =>
      authority.write({ kind: 'progress', connection: worker(OWNER_ALICE), token: claimed.token, detail: 'too late' })
    ).toThrowError(expect.objectContaining({ code: 'LEASE_EXPIRED' }))
    const taken = authority.takeOverExpired({ connection: worker(OWNER_BOB), projectId: PROJECT, taskId: claimed.task.taskId, attemptId: claimed.attempt.attemptId, leaseId: claimed.token.leaseId, generation: claimed.token.generation })
    expect(taken.token.generation).toBe(2)
    authority.write({ kind: 'progress', connection: worker(OWNER_BOB), token: taken.token, detail: 'successor progress' })
  })

  integration('keeps late output and exit from a stale generation audit-visible without completing the task', async () => {
    const { authority, path, directory } = openAuthority()
    const workspace = join(directory, 'work')
    mkdirSync(workspace)
    createTask(authority, 'DW-7')
    const claimed = claim(authority, 'DW-7', OWNER_ALICE, SPEC(workspace))
    const { ports, setPending } = fakePorts(authority, {
      script: [
        {
          output: 'late work',
          exited: false,
          run: () => {
            const offer = authority.offerHandoff({
              connection: worker(OWNER_ALICE),
              projectId: PROJECT,
              taskId: claimed.task.taskId,
              attemptId: claimed.attempt.attemptId,
              leaseId: claimed.token.leaseId,
              generation: claimed.token.generation,
              targetOwnerId: OWNER_BOB,
              ttlMs: 60_000
            })
            authority.acceptHandoff({ connection: worker(OWNER_BOB), projectId: PROJECT, taskId: claimed.task.taskId, attemptId: claimed.attempt.attemptId, offerId: offer.offerId })
          }
        },
        { output: '', exited: true, exitCode: 0 }
      ]
    })
    const coordinator = makeCoordinator(authority, ports)
    setPending(claimed)
    const outcome = await coordinator.launch(claimed, SPEC(workspace), worker(OWNER_ALICE))
    expect(outcome.disposition).toBe('superseded')
    const task = taskOf(authority, claimed.task.taskId)
    expect(task.status).not.toBe('done')
    const staleExit = eventTypes(path, PROJECT, claimed.task.taskId).filter(event => event.type === 'stale-generation-exit')
    expect(staleExit).toHaveLength(1)
    expect(staleExit[0]!.payload['generation']).toBe(1)
    expect(task.currentAttempt?.currentLease?.generation).toBe(2)
  })

  integration('delivers the cancellation stop mid-run, retries after a transient failure, and confirms exit', async () => {
    const { authority, directory } = openAuthority()
    const workspace = join(directory, 'work')
    mkdirSync(workspace)
    createTask(authority, 'DW-8')
    const claimed = claim(authority, 'DW-8', OWNER_ALICE, SPEC(workspace))
    const { ports, calls, setPending } = fakePorts(authority, {
      stopFailures: 2,
      script: [
        {
          output: 'working',
          exited: false,
          run: () => {
            authority.requestCancellation({ connection: ADMIN, projectId: PROJECT, taskId: claimed.task.taskId, expectedEntityVersion: taskOf(authority, claimed.task.taskId).entityVersion })
          }
        },
        { output: 'still running', exited: false },
        { output: '', exited: true, exitCode: 0 }
      ]
    })
    const coordinator = new TaskExecutionCoordinator({
      authority,
      ports,
      evidence: new DaemonTaskEvidencePort(),
      pumpPollMs: 1,
      cancelCheckMs: 1
    })
    setPending(claimed)
    const outcome = await coordinator.launch(claimed, SPEC(workspace), worker(OWNER_ALICE))
    await new Promise(resolve => setImmediate(resolve))
    expect(outcome.disposition).toBe('cancelled')
    expect(outcome.task.status).toBe('cancelled')
    expect(outcome.attempt.state).toBe('cancelled')
    // Transient failures retried exactly once across the session stop and its identity fallback.
    expect(calls.stopAttempts).toBe(2)
    expect(calls.processStops).toBe(1)
    const attempt = taskOf(authority, claimed.task.taskId).currentAttempt!
    await coordinator.deliverStop(claimed.token, attempt)
    expect(calls.stopAttempts).toBe(2)
  })

  integration('re-delivers a fully failed mid-run stop on the next cancel check instead of latching', async () => {
    const { authority, directory } = openAuthority()
    const workspace = join(directory, 'work')
    mkdirSync(workspace)
    createTask(authority, 'DW-17')
    const claimed = claim(authority, 'DW-17', OWNER_ALICE, SPEC(workspace))
    const { ports, calls, setPending } = fakePorts(authority, {
      // Exhaust the whole first delivery (both session stops and both identity fallbacks).
      stopFailures: 4,
      script: [
        {
          output: 'working',
          exited: false,
          run: () => {
            authority.requestCancellation({ connection: ADMIN, projectId: PROJECT, taskId: claimed.task.taskId, expectedEntityVersion: taskOf(authority, claimed.task.taskId).entityVersion })
          }
        },
        { output: 'still running', exited: false },
        { output: '', exited: true, exitCode: 0 }
      ]
    })
    const coordinator = new TaskExecutionCoordinator({
      authority,
      ports,
      evidence: new DaemonTaskEvidencePort(),
      pumpPollMs: 1,
      cancelCheckMs: 1
    })
    setPending(claimed)
    const outcome = await coordinator.launch(claimed, SPEC(workspace), worker(OWNER_ALICE))
    expect(outcome.disposition).toBe('cancelled')
    expect(taskOf(authority, claimed.task.taskId).status).toBe('cancelled')
    // First delivery failed entirely (2 session stops + 2 fallbacks); the unlatched
    // next check re-delivered and the second session stop succeeded.
    expect(calls.stopAttempts).toBe(3)
    expect(calls.processStops).toBe(2)
  })

  integration('cannot complete a successful exit until daemon-owned evidence satisfies the specification', async () => {
    const { authority, directory } = openAuthority()
    const workspace = join(directory, 'work')
    mkdirSync(workspace)
    const spec = SPEC(workspace, [{ path: 'report.txt', relationship: 'observed-during-run' }])
    createTask(authority, 'DW-9')
    const claimed = claim(authority, 'DW-9', OWNER_ALICE, spec)
    const { ports, setPending } = fakePorts(authority, { script: [{ output: 'done', exited: true, exitCode: 0 }] })
    const coordinator = makeCoordinator(authority, ports)
    setPending(claimed)
    const outcome = await coordinator.launch(claimed, spec, worker(OWNER_ALICE))
    expect(outcome.disposition).toBe('failed')
    expect(outcome.task.status).toBe('failed')
    expect(outcome.attempt.state).toBe('failed')

    writeFileSync(join(workspace, 'report.txt'), 'report body')
    const claimedAgain = authority.retryFailedTask({ connection: ADMIN, projectId: PROJECT, taskId: claimed.task.taskId, expectedEntityVersion: outcome.task.entityVersion, ownerId: OWNER_ALICE })
    const { ports: ports2, setPending: setPending2 } = fakePorts(authority, { script: [{ output: 'done', exited: true, exitCode: 0 }] })
    const coordinator2 = makeCoordinator(authority, ports2)
    setPending2(claimedAgain)
    const retryOutcome = await coordinator2.launch(claimedAgain, spec, worker(OWNER_ALICE))
    expect(retryOutcome.disposition).toBe('completed')
    expect(retryOutcome.task.status).toBe('done')
    expect(retryOutcome.attempt.retryOfAttemptId).toBe(claimed.attempt.attemptId)
  })

  integration('records a failed exit on the current attempt and one atomic retry creates a linked attempt', async () => {
    const { authority, directory } = openAuthority()
    const workspace = join(directory, 'work')
    mkdirSync(workspace)
    createTask(authority, 'DW-10')
    const claimed = claim(authority, 'DW-10', OWNER_ALICE, SPEC(workspace))
    const { ports, setPending } = fakePorts(authority, { script: [{ output: 'boom', exited: true, exitCode: 3 }] })
    const coordinator = makeCoordinator(authority, ports)
    setPending(claimed)
    const outcome = await coordinator.launch(claimed, SPEC(workspace), worker(OWNER_ALICE))
    expect(outcome.disposition).toBe('failed')
    expect(outcome.attempt.state).toBe('failed')
    expect(outcome.task.status).toBe('failed')
    const retried = authority.retryFailedTask({ connection: ADMIN, projectId: PROJECT, taskId: claimed.task.taskId, expectedEntityVersion: outcome.task.entityVersion, ownerId: OWNER_ALICE })
    expect(retried.attempt.retryOfAttemptId).toBe(claimed.attempt.attemptId)
    expect(retried.attempt.sequence).toBe(2)
  })

  integration('restart reconciliation preserves valid bindings, closes stale, quarantines indeterminate, and closes wrong families', async () => {
    const { authority, directory } = openAuthority()
    const workspace = join(directory, 'work')
    mkdirSync(workspace)
    createTask(authority, 'DW-11a')
    const claimedValid = claim(authority, 'DW-11a', OWNER_ALICE, SPEC(workspace))
    createTask(authority, 'DW-11b')
    const claimedStale = claim(authority, 'DW-11b', OWNER_ALICE, SPEC(workspace))
    createTask(authority, 'DW-11c')
    const claimedIndeterminate = claim(authority, 'DW-11c', OWNER_ALICE, SPEC(workspace))
    createTask(authority, 'DW-11d')
    const claimedWrongFamily = claim(authority, 'DW-11d', OWNER_ALICE, SPEC(workspace))
    const seeded: Array<[ClaimResult, ProcessIdentity]> = [
      [claimedValid, IDENTITY(11)],
      [claimedStale, IDENTITY(22)],
      [claimedIndeterminate, IDENTITY(33)],
      [claimedWrongFamily, { ...IDENTITY(44), family: 'terminal-daemon' }]
    ]
    for (const [claimedResult, identity] of seeded) {
      authority.beginSpawn({ token: claimedResult.token, launchIntentId: randomUUID(), expectedSpecificationId: claimedResult.attempt.specificationId })
      authority.recordReturnedIdentity({ projectId: PROJECT, taskId: claimedResult.task.taskId, attemptId: claimedResult.attempt.attemptId, sessionId: `session-${identity.pid}`, processIdentity: identity })
    }
    const verdictByPid = new Map<number, ProcessIdentityVerdict>([
      [11, VERDICTS.valid],
      [22, VERDICTS.stale],
      [33, VERDICTS.indeterminate],
      [44, VERDICTS.valid]
    ])
    const { ports } = fakePorts(authority)
    const coordinator = makeCoordinator(authority, ports, identity => verdictByPid.get(identity.pid) ?? VERDICTS.valid)
    const events = await coordinator.reconcileStartup(identity => verdictByPid.get(identity.pid) ?? VERDICTS.valid)
    const actionOf = (claimedResult: ClaimResult) => events.find(event => event.attemptId === claimedResult.attempt.attemptId)?.action
    expect(actionOf(claimedValid)).toBe('preserved')
    expect(actionOf(claimedStale)).toBe('closed-stale')
    expect(actionOf(claimedIndeterminate)).toBe('quarantined-indeterminate')
    expect(actionOf(claimedWrongFamily)).toBe('wrong-family-closed')
    const stateOf = (claimedResult: ClaimResult) => taskOf(authority, claimedResult.task.taskId).currentAttempt!.state
    expect(stateOf(claimedValid)).toBe('launching')
    expect(stateOf(claimedStale)).toBe('failed')
    expect(stateOf(claimedIndeterminate)).toBe('quarantined')
    expect(stateOf(claimedWrongFamily)).toBe('failed')
  })

  integration('acknowledges exit at startup for cancelling attempts whose runtime is confirmed exited', async () => {
    const { authority, directory } = openAuthority()
    const workspace = join(directory, 'work')
    mkdirSync(workspace)
    createTask(authority, 'DW-12')
    const claimed = claim(authority, 'DW-12', OWNER_ALICE, SPEC(workspace))
    authority.beginSpawn({ token: claimed.token, launchIntentId: randomUUID(), expectedSpecificationId: claimed.attempt.specificationId })
    authority.recordReturnedIdentity({ projectId: PROJECT, taskId: claimed.task.taskId, attemptId: claimed.attempt.attemptId, sessionId: 'session-dw-12', processIdentity: IDENTITY(4242) })
    authority.requestCancellation({ connection: ADMIN, projectId: PROJECT, taskId: claimed.task.taskId, expectedEntityVersion: taskOf(authority, claimed.task.taskId).entityVersion })
    const { ports } = fakePorts(authority)
    const coordinator = makeCoordinator(authority, ports, () => VERDICTS.stale)
    const events = await coordinator.reconcileStartup(() => VERDICTS.stale)
    expect(events.map(event => event.action)).toContain('exit-acknowledged')
    expect(taskOf(authority, claimed.task.taskId).status).toBe('cancelled')
    expect(taskOf(authority, claimed.task.taskId).currentAttempt?.state).toBe('cancelled')
  })

  integration('re-delivers committed cancellation stops at startup, falling back to the recorded identity stop', async () => {
    const { authority, directory } = openAuthority()
    const workspace = join(directory, 'work')
    mkdirSync(workspace)
    createTask(authority, 'DW-14')
    const claimed = claim(authority, 'DW-14', OWNER_ALICE, SPEC(workspace))
    authority.beginSpawn({ token: claimed.token, launchIntentId: randomUUID(), expectedSpecificationId: claimed.attempt.specificationId })
    authority.recordReturnedIdentity({ projectId: PROJECT, taskId: claimed.task.taskId, attemptId: claimed.attempt.attemptId, sessionId: 'session-dw-14', processIdentity: IDENTITY(4242) })
    authority.requestCancellation({ connection: ADMIN, projectId: PROJECT, taskId: claimed.task.taskId, expectedEntityVersion: taskOf(authority, claimed.task.taskId).entityVersion })
    const { ports, calls } = fakePorts(authority)
    const coordinator = makeCoordinator(authority, ports, () => VERDICTS.valid)
    const events = await coordinator.reconcileStartup(() => VERDICTS.valid)
    expect(events.map(event => event.action)).toContain('stop-retried')
    // The restarted daemon does not own the old session; the stop falls back to the recorded identity.
    expect(calls.stopAttempts).toBe(1)
    expect(calls.processStops).toBe(1)
    expect(taskOf(authority, claimed.task.taskId).status).toBe('cancelled')
    expect(taskOf(authority, claimed.task.taskId).currentAttempt?.state).toBe('cancelled')
  })

  integration('refuses to double-reserve one canonical worktree through aliases', async () => {
    const { authority, directory } = openAuthority()
    const workspace = join(directory, 'work')
    mkdirSync(workspace)
    const aliasDirectory = tempDirectory()
    const alias = join(aliasDirectory, 'alias-link')
    symlinkSync(workspace, alias)
    createTask(authority, 'DW-13a')
    createTask(authority, 'DW-13b')
    const first = claim(authority, 'DW-13a', OWNER_ALICE, SPEC(workspace))
    const second = claim(authority, 'DW-13b', OWNER_ALICE, SPEC(workspace))
    const { ports, setPending } = fakePorts(authority)
    const coordinator = makeCoordinator(authority, ports)
    setPending(first)
    const prepared = coordinator.prepareLaunch(first, SPEC(workspace), worker(OWNER_ALICE))
    expect(prepared.canonicalResourceKey).toBe(workspace.toLowerCase())
    setPending(second)
    expect(() => coordinator.prepareLaunch(second, SPEC(alias), worker(OWNER_ALICE))).toThrowError(expect.objectContaining({ code: 'RESOURCE_QUARANTINED' }))
  })
})

describe('task scheduler pump', () => {
  it('enqueues one due occurrence once and claims with authority-enforced capacity with no client connected', () => {
    const { authority, directory } = openAuthority()
    const workspace = join(directory, 'work')
    mkdirSync(workspace)
    const past = new Date(Date.now() - 60_000).toISOString()
    const schedule = authority.createSchedule({
      connection: ADMIN,
      projectId: PROJECT,
      spec: {
        profileId: 'profile-main',
        taskTitle: 'scheduled tick',
        cadence: { kind: 'interval', minutes: 5 },
        command: { program: 'node', args: ['tick.js'] },
        target: { kind: 'local', root: workspace, label: 'repo' },
        verification: { requiredArtifacts: [] }
      },
      enabled: true,
      nextRunAt: past
    })
    const pump = new TaskSchedulerPump(authority, OWNER_ALICE, { now: () => Date.now() })
    const first = pump.tick()
    expect(first.enqueued).toHaveLength(1)
    expect(first.enqueued[0]!.scheduleId).toBe(schedule.scheduleId)
    expect(first.enqueued[0]!.trigger).toBe('due')
    expect(first.claimed).toHaveLength(1)
    expect(first.claimed[0]!.claim.task.externalTaskId).toBe(`${schedule.scheduleId}:${past}`)
    const second = pump.tick()
    expect(second.enqueued).toHaveLength(0)
    expect(second.claimed).toHaveLength(0)
    expect(second.failures).toEqual([])
    const executions = authority.listScheduleExecutions({ connection: ADMIN, projectId: PROJECT })
    expect(executions.executions.filter(execution => execution.trigger === 'due')).toHaveLength(1)

    const memberA = authority.createTask({ connection: ADMIN, projectId: PROJECT, externalTaskId: 'DW-15a', title: 'member a' })
    const memberB = authority.createTask({ connection: ADMIN, projectId: PROJECT, externalTaskId: 'DW-15b', title: 'member b' })
    authority.createRunGroup({
      connection: ADMIN,
      profileId: 'profile-main',
      name: 'fan-out',
      concurrency: 1,
      members: [
        { projectId: PROJECT, taskId: memberA.taskId },
        { projectId: PROJECT, taskId: memberB.taskId }
      ]
    })
    const claimA = authority.claim({ connection: worker(OWNER_BOB), projectId: PROJECT, taskId: memberA.taskId, specification: SPEC(workspace) })
    expect(claimA.task.taskId).toBe(memberA.taskId)
    expect(() => authority.claim({ connection: worker(OWNER_BOB), projectId: PROJECT, taskId: memberB.taskId, specification: SPEC(workspace) }))
      .toThrowError(expect.objectContaining({ code: 'CAPACITY_EXHAUSTED' }))
  })

  it('claims queued manual schedule executions even though they never appear in the due list', () => {
    const { authority, directory } = openAuthority()
    const workspace = join(directory, 'work')
    mkdirSync(workspace)
    const schedule = authority.createSchedule({
      connection: ADMIN,
      projectId: PROJECT,
      spec: {
        profileId: 'profile-main',
        taskTitle: 'manual-only schedule',
        cadence: { kind: 'interval', minutes: 60 },
        command: { program: 'node', args: ['manual.js'] },
        target: { kind: 'local', root: workspace, label: 'repo' },
        verification: { requiredArtifacts: [] }
      },
      enabled: true
    })
    const manual = authority.enqueueManualScheduleExecution({
      connection: ADMIN,
      projectId: PROJECT,
      scheduleId: schedule.scheduleId,
      expectedEntityVersion: schedule.entityVersion,
      requestId: 'manual-request-1'
    })
    expect(manual.state).toBe('queued')
    // Manual executions never advance next_run_at, so the schedule is never due;
    // the pump must still claim the queued execution from its committed schedule state.
    const pump = new TaskSchedulerPump(authority, OWNER_ALICE, { now: () => Date.now() + 10 * 365 * 24 * 60 * 60 * 1000 })
    const ticked = pump.tick()
    expect(ticked.enqueued).toHaveLength(0)
    expect(ticked.claimed).toHaveLength(1)
    expect(ticked.claimed[0]!.claim.task.taskId).toBe(manual.taskId)
    expect(ticked.claimed[0]!.specification.command.program).toBe('node')
    expect(ticked.failures).toEqual([])
  })

  it('retries a queued execution whose claim failed on a later tick once capacity frees', () => {
    const { authority, directory } = openAuthority()
    const workspace = join(directory, 'work')
    mkdirSync(workspace)
    const past = new Date(Date.now() - 60_000).toISOString()
    const schedule = authority.createSchedule({
      connection: ADMIN,
      projectId: PROJECT,
      spec: {
        profileId: 'profile-main',
        taskTitle: 'retry tick',
        cadence: { kind: 'interval', minutes: 5 },
        command: { program: 'node', args: ['tick.js'] },
        target: { kind: 'local', root: workspace, label: 'repo' },
        verification: { requiredArtifacts: [] }
      },
      enabled: true,
      nextRunAt: past
    })
    const enqueued = authority.enqueueDueSchedule({
      connection: { connectionId: 'conn-scheduler', role: 'daemon-scheduler', authorizedProjectIds: [PROJECT], authorizedProfileIds: ['profile-main'] },
      projectId: PROJECT,
      scheduleId: schedule.scheduleId,
      expectedEntityVersion: schedule.entityVersion,
      expectedNextRunAt: past
    })
    const scheduledTaskId = enqueued.taskId

    // A run group with full capacity blocks the pump claim; the execution stays queued.
    const blocker = authority.createTask({ connection: ADMIN, projectId: PROJECT, externalTaskId: 'DW-blocker', title: 'blocker' })
    authority.createRunGroup({
      connection: ADMIN,
      profileId: 'profile-main',
      name: 'capacity-block',
      concurrency: 1,
      members: [
        { projectId: PROJECT, taskId: scheduledTaskId },
        { projectId: PROJECT, taskId: blocker.taskId }
      ]
    })
    const blockerClaim = authority.claim({ connection: worker(OWNER_BOB), projectId: PROJECT, taskId: blocker.taskId, specification: SPEC(workspace) })
    const pump = new TaskSchedulerPump(authority, OWNER_ALICE, { now: () => Date.now() })
    const blocked = pump.tick()
    expect(blocked.claimed).toHaveLength(0)
    expect(blocked.failures.some(failure => failure.scope === `execution:${enqueued.executionId}`)).toBe(true)
    expect(authority.listScheduleExecutions({ connection: ADMIN, projectId: PROJECT }).executions.find(execution => execution.executionId === enqueued.executionId)!.state).toBe('queued')

    // Capacity frees; the next tick claims the stranded execution from its schedule state.
    const failedBlocker = authority.write({ kind: 'fail', connection: worker(OWNER_BOB), token: blockerClaim.token, error: 'blocker done' })
    expect(failedBlocker.status).toBe('failed')
    const retried = pump.tick()
    expect(retried.claimed).toHaveLength(1)
    expect(retried.claimed[0]!.claim.task.taskId).toBe(scheduledTaskId)
  })

  it('fans out queued run-group members with committed specifications under authority capacity with no client connected', () => {
    const { authority, directory } = openAuthority()
    const workspace = join(directory, 'work')
    mkdirSync(workspace)
    const memberA = authority.createTask({ connection: ADMIN, projectId: PROJECT, externalTaskId: 'DW-F1', title: 'fan a' })
    const memberB = authority.createTask({ connection: ADMIN, projectId: PROJECT, externalTaskId: 'DW-F2', title: 'fan b' })
    const specA = SPEC(workspace)
    authority.createRunGroup({
      connection: ADMIN,
      profileId: 'profile-main',
      name: 'daemon fan-out',
      concurrency: 1,
      members: [
        { projectId: PROJECT, taskId: memberA.taskId, specification: specA },
        { projectId: PROJECT, taskId: memberB.taskId, specification: SPEC(workspace, [{ path: 'b.txt', relationship: 'observed-during-run' }]) }
      ]
    })
    const pump = new TaskSchedulerPump(authority, OWNER_ALICE, { now: () => Date.now() })
    const first = pump.tick()
    // Capacity 1: only the first member is claimed. The capacity rejection is
    // expected scheduling state: reported once as a bounded diagnostic, the rest
    // of the group is skipped for this tick, and repeat ticks stay quiet.
    expect(first.claimed).toHaveLength(1)
    expect(first.claimed[0]!.claim.task.taskId).toBe(memberA.taskId)
    expect(first.claimed[0]!.specification).toEqual(specA)
    expect(first.failures).toHaveLength(1)
    expect(first.failures[0]!.scope).toBe(`run-member:${PROJECT}:${memberB.taskId}`)
    expect(authority.query({ connection: ADMIN, projectId: PROJECT }).tasks.find(task => task.taskId === memberB.taskId)!.currentAttempt).toBeNull()
    // The next tick retries the blocked member silently.
    const quiet = pump.tick()
    expect(quiet.claimed).toHaveLength(0)
    expect(quiet.failures).toEqual([])

    // Finish member A; the next tick fans out member B from its committed specification.
    const finishedA = authority.write({ kind: 'complete', connection: worker(OWNER_ALICE), token: first.claimed[0]!.claim.token, result: { summary: 'a done' } })
    expect(finishedA.status).toBe('done')
    const second = pump.tick()
    expect(second.claimed).toHaveLength(1)
    expect(second.claimed[0]!.claim.task.taskId).toBe(memberB.taskId)
    expect(second.claimed[0]!.specification.verification.requiredArtifacts).toEqual([{ path: 'b.txt', relationship: 'observed-during-run' }])
  })

  it('leaves queued run-group members without a committed specification for external workers', () => {
    const { authority, directory } = openAuthority()
    const workspace = join(directory, 'work')
    mkdirSync(workspace)
    const member = authority.createTask({ connection: ADMIN, projectId: PROJECT, externalTaskId: 'DW-F3', title: 'external member' })
    authority.createRunGroup({
      connection: ADMIN,
      profileId: 'profile-main',
      name: 'external fan-out',
      concurrency: 1,
      members: [{ projectId: PROJECT, taskId: member.taskId }]
    })
    const pump = new TaskSchedulerPump(authority, OWNER_ALICE, { now: () => Date.now() })
    const ticked = pump.tick()
    expect(ticked.claimed).toHaveLength(0)
    expect(ticked.failures).toEqual([])
    expect(authority.query({ connection: ADMIN, projectId: PROJECT }).tasks.find(task => task.taskId === member.taskId)!.currentAttempt).toBeNull()
  })

  it('claims a todo sibling when an ordinal-0 member is blocked, reporting the blocked member once', () => {
    const { authority, directory } = openAuthority()
    const workspace = join(directory, 'work')
    mkdirSync(workspace)
    const blockedMember = authority.createTask({ connection: ADMIN, projectId: PROJECT, externalTaskId: 'DW-B0', title: 'blocked ordinal zero', status: 'blocked' })
    const todoSibling = authority.createTask({ connection: ADMIN, projectId: PROJECT, externalTaskId: 'DW-B1', title: 'todo sibling' })
    authority.createRunGroup({
      connection: ADMIN,
      profileId: 'profile-main',
      name: 'blocked fan-out',
      concurrency: 2,
      members: [
        { projectId: PROJECT, taskId: blockedMember.taskId, specification: SPEC(workspace) },
        { projectId: PROJECT, taskId: todoSibling.taskId, specification: SPEC(workspace) }
      ]
    })
    const pump = new TaskSchedulerPump(authority, OWNER_ALICE, { now: () => Date.now() })
    const first = pump.tick()
    // The blocked ordinal-0 member is reported as a failure but does NOT starve
    // the group: capacity skip applies only to CAPACITY_EXHAUSTED, so the todo
    // sibling at ordinal 1 is still claimed.
    expect(first.claimed.map(entry => entry.claim.task.taskId)).toEqual([todoSibling.taskId])
    expect(first.failures).toHaveLength(1)
    expect(first.failures[0]!.scope).toBe(`run-member:${PROJECT}:${blockedMember.taskId}`)

    // Repeat ticks stay quiet for the same blocked scope (bounded diagnostic).
    const second = pump.tick()
    expect(second.claimed).toHaveLength(0)
    expect(second.failures).toEqual([])

    // Unblocking the member restores dispatch on the next tick.
    const version = authority.query({ connection: ADMIN, projectId: PROJECT }).tasks.find(task => task.taskId === blockedMember.taskId)!.entityVersion
    authority.updateTask({ connection: ADMIN, projectId: PROJECT, taskId: blockedMember.taskId, expectedEntityVersion: version, status: 'todo' })
    const third = pump.tick()
    expect(third.claimed.map(entry => entry.claim.task.taskId)).toEqual([blockedMember.taskId])
    expect(third.failures).toEqual([])
  })

  it('reports a dependency-blocked member once and claims it once the dependency finishes', () => {
    const { authority, directory } = openAuthority()
    const workspace = join(directory, 'work')
    mkdirSync(workspace)
    const dependency = authority.createTask({ connection: ADMIN, projectId: PROJECT, externalTaskId: 'DW-DEP', title: 'dependency' })
    const dependent = authority.createTask({ connection: ADMIN, projectId: PROJECT, externalTaskId: 'DW-DEPENDENT', title: 'dependent' })
    authority.setDependencies({
      connection: ADMIN,
      projectId: PROJECT,
      taskId: dependent.taskId,
      expectedEntityVersion: authority.query({ connection: ADMIN, projectId: PROJECT }).tasks.find(task => task.taskId === dependent.taskId)!.entityVersion,
      dependsOnTaskIds: [dependency.taskId]
    })
    authority.createRunGroup({
      connection: ADMIN,
      profileId: 'profile-main',
      name: 'dependency fan-out',
      concurrency: 1,
      members: [{ projectId: PROJECT, taskId: dependent.taskId, specification: SPEC(workspace) }]
    })
    const pump = new TaskSchedulerPump(authority, OWNER_ALICE, { now: () => Date.now() })
    const blocked = pump.tick()
    expect(blocked.claimed).toHaveLength(0)
    expect(blocked.failures).toHaveLength(1)
    expect(blocked.failures[0]!.scope).toBe(`run-member:${PROJECT}:${dependent.taskId}`)
    // The next tick is quiet while the dependency remains unfinished.
    expect(pump.tick().failures).toEqual([])

    // Finishing the dependency releases the member to the pump.
    const depClaim = authority.claim({ connection: worker(OWNER_BOB), projectId: PROJECT, taskId: dependency.taskId, specification: SPEC(workspace) })
    authority.write({ kind: 'complete', connection: worker(OWNER_BOB), token: depClaim.token, result: { summary: 'dep done' } })
    const released = pump.tick()
    expect(released.claimed.map(entry => entry.claim.task.taskId)).toEqual([dependent.taskId])
  })

  it('preserves member specifications across run-group retry and fans the retried member out', () => {
    const { authority, directory } = openAuthority()
    const workspace = join(directory, 'work')
    mkdirSync(workspace)
    const member = authority.createTask({ connection: ADMIN, projectId: PROJECT, externalTaskId: 'DW-F4', title: 'retry member' })
    const spec = SPEC(workspace, [{ path: 'retry.txt', relationship: 'attached-reference' }])
    const group = authority.createRunGroup({
      connection: ADMIN,
      profileId: 'profile-main',
      name: 'retry fan-out',
      concurrency: 1,
      members: [{ projectId: PROJECT, taskId: member.taskId, specification: spec }]
    })
    const pump = new TaskSchedulerPump(authority, OWNER_ALICE, { now: () => Date.now() })
    const claimedEntry = pump.tick().claimed[0]!
    expect(claimedEntry.claim.task.taskId).toBe(member.taskId)
    authority.write({ kind: 'fail', connection: worker(OWNER_ALICE), token: claimedEntry.claim.token, error: 'member failed' })

    const retriedGroup = authority.retryRunGroup({
      connection: ADMIN,
      runGroupId: group.runGroupId,
      expectedEntityVersion: group.entityVersion,
      requestId: 'retry-request-1',
      ownerId: OWNER_ALICE,
      memberTaskIds: [{ projectId: PROJECT, taskId: member.taskId }]
    })
    expect(retriedGroup.retryOfRunGroupId).toBe(group.runGroupId)
    const retried = pump.tick()
    expect(retried.claimed).toHaveLength(1)
    expect(retried.claimed[0]!.claim.task.taskId).toBe(member.taskId)
    expect(retried.claimed[0]!.specification).toEqual(spec)
  })
})
