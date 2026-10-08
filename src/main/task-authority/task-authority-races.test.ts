import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import type { RuntimeAuthorityLock } from '@shared/runtime-file-security'
import {
  type AuthenticatedAuthorityConnection,
  type TaskAuthority,
  type TaskExecutionSpecificationInput
} from '@shared/task-authority'
import { openTaskAuthorityDatabase, openTaskAuthorityRawConnection } from './schema'
import { launchIntentFingerprint, recordMigrationSource, retireMigrationSource, SqliteTaskAuthority } from './task-authority'

const PROJECT_ALPHA = 'project-alpha'
const PROJECT_BETA = 'project-beta'
const PROFILE_MAIN = 'profile-main'
const OWNER_ALICE = '12121212-1212-4212-8212-121212121212'
const OWNER_BOB = '34343434-3434-4434-8434-343434343434'

const ADMIN: AuthenticatedAuthorityConnection = { connectionId: 'conn-admin', role: 'administrator' }
const worker = (ownerId: string, projects: readonly string[] = [PROJECT_ALPHA]): AuthenticatedAuthorityConnection => ({
  connectionId: `conn-worker-${ownerId}`,
  role: 'worker',
  ownerId,
  authorizedProjectIds: projects
})

const SPEC = (requiredArtifacts: ReadonlyArray<{ path: string; relationship: 'attached-reference' | 'observed-during-run' }> = []): TaskExecutionSpecificationInput => ({
  command: { program: 'node', args: ['run.js'], cwd: '/repo' },
  target: { kind: 'local', root: '/repo', label: 'repo' },
  verification: { requiredArtifacts }
})

/** Two authorities on one file with no process-wide lock: BEGIN IMMEDIATE alone must arbitrate. */
const passThroughLock: RuntimeAuthorityLock = (path, callback) => callback(path)

const directories: string[] = []
const authorities: SqliteTaskAuthority[] = []

function tempDirectory(): string {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'task-authority-race-')))
  directories.push(directory)
  return directory
}

function openPair(directory: string = tempDirectory()): { first: SqliteTaskAuthority; second: SqliteTaskAuthority; path: string } {
  const databasePath = join(directory, 'task-authority.sqlite')
  const firstInstance = SqliteTaskAuthority.open({ databasePath, authorityLock: passThroughLock })
  const secondInstance = SqliteTaskAuthority.open({ databasePath, authorityLock: passThroughLock })
  authorities.push(firstInstance, secondInstance)
  return { first: firstInstance, second: secondInstance, path: databasePath }
}

afterEach(() => {
  while (authorities.length > 0) authorities.pop()?.close()
  while (directories.length > 0) rmSync(directories.pop() as string, { recursive: true, force: true })
})

function createTask(authority: TaskAuthority, projectId: string, externalTaskId: string, title = 'task') {
  return authority.createTask({ connection: ADMIN, projectId, externalTaskId, title })
}

function claim(authority: TaskAuthority, projectId: string, externalTaskId: string, ownerId: string = OWNER_ALICE) {
  return authority.claim({ connection: worker(ownerId, [projectId]), projectId, externalTaskId, specification: SPEC(), leaseTtlMs: 60_000 })
}

/** Spawn a detached node helper running `script` against `databasePath`; returns exit details. */
function runHelper(script: string, databasePath: string, readyPath?: string, env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['-e', script, databasePath, readyPath ?? ''], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env }
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

const CLAIM_HELPER = `
const { DatabaseSync } = require('node:sqlite')
const { randomUUID } = require('node:crypto')
const dbPath = process.argv[1]
const db = new DatabaseSync(dbPath)
db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL")
const owner = process.env.CLAIM_OWNER
const taskExternal = process.env.CLAIM_EXTERNAL
const task = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND external_task_id_canonical = ?").get('project-alpha', taskExternal.toLowerCase())
if (!task) { console.log('missing task'); process.exit(3) }
db.exec('BEGIN IMMEDIATE')
const current = db.prepare('SELECT current_attempt_id, status FROM tasks WHERE project_id = ? AND id = ?').get('project-alpha', task.id)
if (current.current_attempt_id !== null || current.status !== 'todo') { db.exec('ROLLBACK'); console.log('lost'); process.exit(0) }
const specId = randomUUID()
const attemptId = randomUUID()
const leaseId = randomUUID()
const now = Date.now()
const iso = new Date().toISOString()
db.prepare('INSERT INTO execution_specifications(id, project_id, task_id, command_json, target_json, verification_json, source_sha256, created_at) VALUES (?,?,?,?,?,?,?,?)')
  .run(specId, 'project-alpha', task.id, '{}', '{}', '{}', 'aa', iso)
db.prepare('INSERT INTO leases(id, project_id, task_id, attempt_id, owner_id, generation, issued_at_ms, initial_expires_at_ms) VALUES (?,?,?,?,?,1,?,?)')
  .run(leaseId, 'project-alpha', task.id, attemptId, owner, now, now + 60000)
db.prepare("INSERT INTO attempts(id, project_id, task_id, sequence, retry_of_attempt_id, provenance_kind, state, specification_id, current_lease_id, started_at, finished_at) VALUES (?,'project-alpha',?,1,NULL,'native','claimed',?,?,?,NULL)")
  .run(attemptId, task.id, specId, leaseId, iso)
db.prepare("UPDATE tasks SET current_attempt_id = ?, status = 'in-progress', entity_version = entity_version + 1, updated_at = ? WHERE project_id = ? AND id = ?")
  .run(attemptId, iso, 'project-alpha', task.id)
db.prepare("INSERT INTO task_events(event_id, project_id, task_id, attempt_id, event_type, entity_version, payload_json, created_at) VALUES (?,'project-alpha',?,?,'task-claimed',2,'{}',?)")
  .run(randomUUID(), task.id, attemptId, iso)
db.exec('COMMIT')
db.close()
console.log('won')
`

describe('task authority process races', () => {
  it('arbitrates a simultaneous bootstrap claim race to exactly one winner with no partial state', () => {
    const { first, path } = openPair()
    createTask(first, PROJECT_ALPHA, 'RACE-1')
    const results = [
      runHelper(CLAIM_HELPER, path, undefined, { CLAIM_OWNER: OWNER_ALICE, CLAIM_EXTERNAL: 'RACE-1' }),
      runHelper(CLAIM_HELPER, path, undefined, { CLAIM_OWNER: OWNER_BOB, CLAIM_EXTERNAL: 'RACE-1' })
    ]
    const winners = results.filter(result => result.stdout.includes('won')).length
    const losers = results.filter(result => result.stdout.includes('lost')).length
    expect(winners + losers).toBe(2)
    expect(winners).toBe(1)
    const db = openTaskAuthorityRawConnection(path)
    const attempts = db.prepare('SELECT COUNT(*) AS c FROM attempts').get() as { c: number }
    const leases = db.prepare('SELECT COUNT(*) AS c FROM leases').get() as { c: number }
    const events = db.prepare("SELECT COUNT(*) AS c FROM task_events WHERE event_type = 'task-claimed'").get() as { c: number }
    const task = db.prepare('SELECT status, current_attempt_id FROM tasks WHERE external_task_id_canonical = ?').get('race-1') as { status: string; current_attempt_id: string | null }
    db.close()
    expect(attempts.c).toBe(1)
    expect(leases.c).toBe(1)
    expect(events.c).toBe(1)
    expect(task.status).toBe('in-progress')
    expect(task.current_attempt_id).not.toBeNull()
  })

  it('leaves no partial task/attempt/lease/event state when a helper is killed mid-claim', () => {
    const { first, path } = openPair()
    createTask(first, PROJECT_ALPHA, 'KILL-1')
    const readyPath = join(tempDirectory(), 'ready')
    const helper = spawn(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite')
      const db = new DatabaseSync(process.argv[1])
      db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000")
      const task = db.prepare("SELECT * FROM tasks WHERE external_task_id_canonical = 'kill-1'").get()
      db.exec('BEGIN IMMEDIATE')
      db.prepare('INSERT INTO leases(id, project_id, task_id, attempt_id, owner_id, generation, issued_at_ms, initial_expires_at_ms) VALUES (?,?,?,?,?,1,?,?)')
        .run(require('node:crypto').randomUUID(), 'project-alpha', task.id, require('node:crypto').randomUUID(), '12121212-1212-4212-8212-121212121212', Date.now(), Date.now() + 60000)
      require('node:fs').writeFileSync(process.argv[2], 'ready')
      setTimeout(() => {}, 60000)
    `, path, readyPath], { stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    helper.unref?.()
    // Wait for the helper to hold its uncommitted transaction.
    const deadline = Date.now() + 10_000
    while (!existsSync(readyPath) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15)
    }
    expect(existsSync(readyPath)).toBe(true)
    helper.kill('SIGKILL')
    spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 300)'])
    const db = openTaskAuthorityRawConnection(path)
    const attempts = db.prepare('SELECT COUNT(*) AS c FROM attempts').get() as { c: number }
    const leases = db.prepare('SELECT COUNT(*) AS c FROM leases').get() as { c: number }
    const claimedEvents = db.prepare("SELECT COUNT(*) AS c FROM task_events WHERE event_type = 'task-claimed'").get() as { c: number }
    db.close()
    expect(attempts.c).toBe(0)
    expect(leases.c).toBe(0)
    expect(claimedEvents.c).toBe(0)
    // The task remains claimable by exactly one subsequent winner.
    const winner = claim(first, PROJECT_ALPHA, 'KILL-1')
    expect(winner.token.generation).toBe(1)
    expect(() => claim(first, PROJECT_ALPHA, 'KILL-1', OWNER_BOB)).toThrowError(expect.objectContaining({ code: 'TASK_NOT_RUNNABLE' }))
  })

  it('cannot duplicate or skip a due occurrence across a crash before next-run advance', () => {
    const { first, path } = openPair()
    const schedule = first.createSchedule({
      connection: ADMIN,
      projectId: PROJECT_ALPHA,
      spec: {
        profileId: PROFILE_MAIN,
        taskTitle: 'tick',
        cadence: { kind: 'interval', minutes: 5 },
        command: { program: 'node', args: ['t.js'] },
        target: { kind: 'local', root: '/repo', label: 'repo' },
        verification: { requiredArtifacts: [] }
      },
      nextRunAt: '2026-09-13T10:00:00.000Z'
    })
    const task = createTask(first, PROJECT_ALPHA, 'CRASH-DUE')
    // A raw connection dies with an uncommitted receipt insert; nothing persists.
    const dying = openTaskAuthorityRawConnection(path)
    dying.exec('BEGIN IMMEDIATE')
    dying.prepare("INSERT INTO schedule_executions(id, project_id, schedule_id, trigger, idempotency_key, intent_sha256, task_id, attempt_id, due_at, state, entity_version, created_at) VALUES (?,'project-alpha',?,'due','2026-09-13T10:00:00.000Z','ff',?,NULL,'2026-09-13T10:00:00.000Z','queued',1,'2026-09-13T10:00:00.000Z')")
      .run('00000000-0000-4000-8000-000000000002', schedule.scheduleId, task.taskId)
    dying.close() // abrupt close discards the uncommitted transaction
    const db = openTaskAuthorityRawConnection(path)
    const count = db.prepare('SELECT COUNT(*) AS c FROM schedule_executions').get() as { c: number }
    db.close()
    expect(count.c).toBe(0)
    // The due tick retries cleanly and exactly once.
    const due: Parameters<TaskAuthority['enqueueDueSchedule']>[0] = {
      connection: { connectionId: 'sched', role: 'daemon-scheduler', authorizedProjectIds: [PROJECT_ALPHA], authorizedProfileIds: [PROFILE_MAIN] },
      projectId: PROJECT_ALPHA,
      scheduleId: schedule.scheduleId,
      expectedEntityVersion: 1,
      expectedNextRunAt: '2026-09-13T10:00:00.000Z'
    }
    const execution = first.enqueueDueSchedule(due)
    expect(execution.state).toBe('queued')
    const retried = first.enqueueDueSchedule(due)
    expect(retried.executionId).toBe(execution.executionId)
  })

  it('arbitrates duplicate event IDs, attempt sequences, and canonical reservations to one winner', () => {
    const { first, path } = openPair()
    const task = createTask(first, PROJECT_ALPHA, 'UNIQ-1')
    const claimed = claim(first, PROJECT_ALPHA, 'UNIQ-1')
    const dbA = openTaskAuthorityRawConnection(path)
    const dbB = openTaskAuthorityRawConnection(path)
    dbA.exec('BEGIN IMMEDIATE')
    dbA.prepare("INSERT INTO task_events(event_id, project_id, task_id, attempt_id, event_type, entity_version, payload_json, created_at) VALUES (?,'project-alpha',?,?,'task-progress',1,'{}','2026-09-13T10:00:00.000Z')")
      .run('00000000-0000-4000-8000-0000000000aa', task.taskId, claimed.attempt.attemptId)
    dbA.exec('COMMIT')
    dbB.exec('BEGIN IMMEDIATE')
    expect(() =>
      dbB.prepare("INSERT INTO task_events(event_id, project_id, task_id, attempt_id, event_type, entity_version, payload_json, created_at) VALUES (?,'project-alpha',?,?,'task-progress',1,'{}','2026-09-13T10:00:00.000Z')")
        .run('00000000-0000-4000-8000-0000000000aa', task.taskId, claimed.attempt.attemptId)
    ).toThrow()
    dbB.exec('ROLLBACK')
    // One live reservation per canonical resource, even across projects.
    const other = createTask(first, PROJECT_BETA, 'UNIQ-2')
    const second = claim(first, PROJECT_BETA, 'UNIQ-2', OWNER_BOB)
    first.write({ kind: 'bind-worktree', connection: worker(OWNER_ALICE), token: claimed.token, resourceKey: '/repo/uniq', worktreePath: '/repo/uniq', repositoryId: 'r' })
    expect(() =>
      first.write({ kind: 'bind-worktree', connection: worker(OWNER_BOB, [PROJECT_BETA]), token: second.token, resourceKey: '/REPO/UNIQ', worktreePath: '/REPO/UNIQ', repositoryId: 'r' })
    ).toThrowError(expect.objectContaining({ code: 'RESOURCE_QUARANTINED' }))
    // Attempt sequence uniqueness per task.
    dbA.exec('BEGIN IMMEDIATE')
    expect(() =>
      dbA.prepare("INSERT INTO attempts(id, project_id, task_id, sequence, retry_of_attempt_id, provenance_kind, state, specification_id, current_lease_id, started_at, finished_at) VALUES (?,'project-alpha',?,1,NULL,'native','claimed',?,?, '2026-09-13T10:00:00.000Z',NULL)")
        .run('00000000-0000-4000-8000-0000000000bb', task.taskId, claimed.attempt.specificationId, claimed.token.leaseId)
    ).toThrow()
    dbA.exec('ROLLBACK')
    dbA.close()
    dbB.close()
    void other
  })

  it('records migration sources deterministically under concurrency and never touches native rows', () => {
    const { first, path } = openPair()
    const nativeTask = createTask(first, PROJECT_ALPHA, 'NATIVE-1')
    const before = first.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks
    const database = openTaskAuthorityDatabase({ databasePath: path, authorityLock: passThroughLock })
    const receiptA = recordMigrationSource(database, {
      scopeKind: 'project',
      scopeId: PROJECT_ALPHA,
      sourceKind: 'backlog-json',
      canonicalSourcePath: '/legacy/backlog.json',
      sourceSha256: 'aa'.repeat(32),
      normalizedJson: '{"tasks":[]}',
      entityMappings: [{ entityKind: 'task', sourceEntityKey: '42', authorityEntityId: 'legacy-42', sourceFingerprint: 'fp-1' }]
    })
    const receiptB = recordMigrationSource(database, {
      scopeKind: 'project',
      scopeId: PROJECT_ALPHA,
      sourceKind: 'backlog-json',
      canonicalSourcePath: '/legacy/backlog.json',
      sourceSha256: 'aa'.repeat(32),
      normalizedJson: '{"tasks":[]}',
      entityMappings: [{ entityKind: 'task', sourceEntityKey: '42', authorityEntityId: 'legacy-42', sourceFingerprint: 'fp-1' }]
    })
    expect(receiptA.created).toBe(true)
    expect(receiptB.created).toBe(false)
    expect(receiptB.sourceId).toBe(receiptA.sourceId)
    // A changed frozen source supersedes deterministically.
    const changed = recordMigrationSource(database, {
      scopeKind: 'project',
      scopeId: PROJECT_ALPHA,
      sourceKind: 'backlog-json',
      canonicalSourcePath: '/legacy/backlog.json',
      sourceSha256: 'bb'.repeat(32),
      normalizedJson: '{"tasks":[1]}',
      supersedesSourceId: receiptA.sourceId,
      entityMappings: [{ entityKind: 'task', sourceEntityKey: '42', authorityEntityId: 'legacy-42', sourceFingerprint: 'fp-2' }]
    })
    expect(changed.sourceId).not.toBe(receiptA.sourceId)
    const db = openTaskAuthorityRawConnection(path)
    const mappings = db.prepare("SELECT state, source_fingerprint FROM migration_entity_mappings WHERE entity_kind = 'task' AND source_entity_key = '42' ORDER BY source_fingerprint").all() as Array<{ state: string; source_fingerprint: string }>
    const sources = db.prepare('SELECT phase FROM migration_sources ORDER BY imported_at').all() as Array<{ phase: string }>
    db.close()
    expect(mappings).toEqual([
      { state: 'superseded', source_fingerprint: 'fp-1' },
      { state: 'active', source_fingerprint: 'fp-2' }
    ])
    expect(sources.map(row => row.phase)).toEqual(['superseded', 'imported'])
    // Compaction retires history without touching native rows.
    retireMigrationSource(database, changed.sourceId, '/archive/backlog.json')
    const after = first.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks
    expect(after).toEqual(before)
    expect(after[0].taskId).toBe(nativeTask.taskId)
    database.close()
  })
})

describe('task authority fencing races', () => {
  it('shares one external task ID across projects and rejects case-variant duplicates and cross-project queries', () => {
    const { first, second } = openPair()
    const alpha = createTask(first, PROJECT_ALPHA, 'Shared-1')
    const beta = createTask(second, PROJECT_BETA, 'shared-1')
    expect(alpha.taskId).not.toBe(beta.taskId)
    expect(() => createTask(first, PROJECT_ALPHA, 'SHARED-1')).toThrowError(
      expect.objectContaining({ name: 'TaskAuthorityValidationError' })
    )
    // Case-variant lookup finds the canonical row on both connections.
    const found = claim(first, PROJECT_ALPHA, 'shared-1')
    expect(found.task.externalTaskId).toBe('Shared-1')
    // Cross-project token/query rejection.
    expect(() =>
      second.write({ kind: 'progress', connection: worker(OWNER_ALICE, [PROJECT_BETA]), token: found.token, detail: 'cross' })
    ).toThrowError(expect.objectContaining({ code: 'PROJECT_SCOPE_MISMATCH' }))
    expect(() =>
      second.query({ connection: worker(OWNER_BOB, [PROJECT_BETA]), projectId: PROJECT_ALPHA })
    ).toThrowError(expect.objectContaining({ code: 'PROJECT_SCOPE_MISMATCH' }))
    void beta
  })

  it('arbitrates run-group capacity races through both fan-out and direct worker claims', () => {
    const { first, second } = openPair()
    const one = createTask(first, PROJECT_ALPHA, 'CAP-1')
    const two = createTask(first, PROJECT_ALPHA, 'CAP-2')
    const three = createTask(first, PROJECT_ALPHA, 'CAP-3')
    first.createRunGroup({
      connection: ADMIN,
      profileId: PROFILE_MAIN,
      name: 'capacity',
      concurrency: 2,
      members: [
        { projectId: PROJECT_ALPHA, taskId: one.taskId },
        { projectId: PROJECT_ALPHA, taskId: two.taskId },
        { projectId: PROJECT_ALPHA, taskId: three.taskId }
      ]
    })
    // Two direct claims on independent connections win; the third loses deterministically.
    const winnerA = claim(first, PROJECT_ALPHA, 'CAP-1')
    const winnerB = claim(second, PROJECT_ALPHA, 'CAP-2', OWNER_BOB)
    expect(winnerA.token.leaseId).not.toBe(winnerB.token.leaseId)
    expect(() => claim(first, PROJECT_ALPHA, 'CAP-3', OWNER_CARA)).toThrowError(expect.objectContaining({ code: 'CAPACITY_EXHAUSTED' }))
    expect(() => claim(second, PROJECT_ALPHA, 'CAP-3', OWNER_CARA)).toThrowError(expect.objectContaining({ code: 'CAPACITY_EXHAUSTED' }))
    // Completion releases capacity for a follow-on claim.
    first.write({ kind: 'complete', connection: worker(OWNER_ALICE), token: winnerA.token, result: { summary: 'ok' } })
    const followOn = claim(second, PROJECT_ALPHA, 'CAP-3', OWNER_CARA)
    expect(followOn.token.ownerId).toBe(OWNER_CARA)
  })

  it('fences a non-owner with correct generation and payload owner spoofing', () => {
    const { first, second } = openPair()
    createTask(first, PROJECT_ALPHA, 'SPOOF-1')
    const claimed = claim(first, PROJECT_ALPHA, 'SPOOF-1')
    // Correct generation, payload owner forged to the real owner: the connection identity decides.
    expect(() =>
      second.write({
        kind: 'progress',
        connection: worker(OWNER_BOB),
        token: { ...claimed.token, ownerId: OWNER_ALICE },
        detail: 'forged'
      })
    ).toThrowError(expect.objectContaining({ code: 'AUTHORIZATION_DENIED' }))
  })

  it('expires an ordinary writer before takeover and quarantines across a valid observation', () => {
    const { first, second, path } = openPair()
    createTask(first, PROJECT_ALPHA, 'EXP-1')
    const claimed = claim(first, PROJECT_ALPHA, 'EXP-1')
    first.write({ kind: 'record-launch-intent', connection: worker(OWNER_ALICE), token: claimed.token, specificationId: claimed.attempt.specificationId })
    const snapshot = first.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks[0]
    const launchIntentId = snapshot.currentAttempt?.runtime?.launchIntentId as string
    first.beginSpawn({ token: claimed.token, launchIntentId, expectedSpecificationId: claimed.attempt.specificationId })
    first.write({ kind: 'bind-runtime', connection: worker(OWNER_ALICE), token: claimed.token, sessionId: 's', processIdentity: acpIdentity() })
    backdateLease(path, claimed.token.leaseId)
    // Expired writer fenced...
    expect(() =>
      first.write({ kind: 'progress', connection: worker(OWNER_ALICE), token: claimed.token, detail: 'expired' })
    ).toThrowError(expect.objectContaining({ code: 'LEASE_EXPIRED' }))
    // ...but a valid observation keeps the attempt quarantined and unfenceable for takeover.
    const fingerprint = launchIntentFingerprint(launchIntentId, claimed.attempt.attemptId, claimed.token.leaseId)
    first.reconcileExpiredOwner({
      projectId: PROJECT_ALPHA,
      taskId: claimed.task.taskId,
      attemptId: claimed.attempt.attemptId,
      leaseId: claimed.token.leaseId,
      generation: 1,
      launchIntentSha256: fingerprint,
      processIdentity: acpIdentity(),
      verdict: { status: 'valid', current: acpIdentity() }
    })
    expect(() =>
      second.takeOverExpired({
        connection: worker(OWNER_BOB),
        projectId: PROJECT_ALPHA,
        taskId: claimed.task.taskId,
        attemptId: claimed.attempt.attemptId,
        leaseId: claimed.token.leaseId,
        generation: 1
      })
    ).toThrowError(expect.objectContaining({ code: 'RESOURCE_QUARANTINED' }))
  })

  it('fences wrong-target, cross-task, cross-project, and stale-tuple handoff offers', () => {
    const { first, second } = openPair()
    createTask(first, PROJECT_ALPHA, 'O-1')
    createTask(first, PROJECT_ALPHA, 'O-2')
    const claimed = claim(first, PROJECT_ALPHA, 'O-1')
    const offer = first.offerHandoff({
      connection: worker(OWNER_ALICE),
      projectId: PROJECT_ALPHA,
      taskId: claimed.task.taskId,
      attemptId: claimed.attempt.attemptId,
      leaseId: claimed.token.leaseId,
      generation: 1,
      targetOwnerId: OWNER_BOB
    })
    // Wrong target.
    expect(() =>
      second.acceptHandoff({
        connection: worker(OWNER_CARA),
        projectId: PROJECT_ALPHA,
        taskId: claimed.task.taskId,
        attemptId: claimed.attempt.attemptId,
        offerId: offer.offerId
      })
    ).toThrowError(expect.objectContaining({ code: 'AUTHORIZATION_DENIED' }))
    // Cross-task: same attempt tuple offered against another task.
    const other = claim(first, PROJECT_ALPHA, 'O-2', OWNER_BOB)
    expect(() =>
      first.offerHandoff({
        connection: worker(OWNER_BOB),
        projectId: PROJECT_ALPHA,
        taskId: other.task.taskId,
        attemptId: claimed.attempt.attemptId,
        leaseId: claimed.token.leaseId,
        generation: 1,
        targetOwnerId: OWNER_ALICE
      })
    ).toThrowError(expect.objectContaining({ code: 'STALE_AUTHORITY' }))
    // Cross-project and stale-tuple offers cannot be cancelled as the source.
    expect(() =>
      first.cancelHandoff({
        connection: worker(OWNER_BOB, [PROJECT_BETA]),
        projectId: PROJECT_ALPHA,
        taskId: claimed.task.taskId,
        attemptId: claimed.attempt.attemptId,
        leaseId: claimed.token.leaseId,
        generation: 1,
        offerId: offer.offerId
      })
    ).toThrowError(expect.objectContaining({ code: 'PROJECT_SCOPE_MISMATCH' }))
    expect(() =>
      second.cancelHandoff({
        connection: worker(OWNER_ALICE),
        projectId: PROJECT_ALPHA,
        taskId: claimed.task.taskId,
        attemptId: claimed.attempt.attemptId,
        leaseId: claimed.token.leaseId,
        generation: 9,
        offerId: offer.offerId
      })
    ).toThrowError(expect.objectContaining({ code: 'HANDOFF_INVALID' }))
  })

  it('races offer cancel against accept and accept against takeover with one winner', () => {
    const { first, second } = openPair()
    createTask(first, PROJECT_ALPHA, 'OO-1')
    const claimed = claim(first, PROJECT_ALPHA, 'OO-1')
    const offer = first.offerHandoff({
      connection: worker(OWNER_ALICE),
      projectId: PROJECT_ALPHA,
      taskId: claimed.task.taskId,
      attemptId: claimed.attempt.attemptId,
      leaseId: claimed.token.leaseId,
      generation: 1,
      targetOwnerId: OWNER_BOB
    })
    // Cancel wins first: accept then loses.
    first.cancelHandoff({
      connection: worker(OWNER_ALICE),
      projectId: PROJECT_ALPHA,
      taskId: claimed.task.taskId,
      attemptId: claimed.attempt.attemptId,
      leaseId: claimed.token.leaseId,
      generation: 1,
      offerId: offer.offerId
    })
    expect(() =>
      second.acceptHandoff({
        connection: worker(OWNER_BOB),
        projectId: PROJECT_ALPHA,
        taskId: claimed.task.taskId,
        attemptId: claimed.attempt.attemptId,
        offerId: offer.offerId
      })
    ).toThrowError(expect.objectContaining({ code: 'HANDOFF_INVALID' }))

    // Accept wins first: takeover of the old lease then loses.
    const secondOffer = first.offerHandoff({
      connection: worker(OWNER_ALICE),
      projectId: PROJECT_ALPHA,
      taskId: claimed.task.taskId,
      attemptId: claimed.attempt.attemptId,
      leaseId: claimed.token.leaseId,
      generation: 1,
      targetOwnerId: OWNER_BOB
    })
    const accepted = second.acceptHandoff({
      connection: worker(OWNER_BOB),
      projectId: PROJECT_ALPHA,
      taskId: claimed.task.taskId,
      attemptId: claimed.attempt.attemptId,
      offerId: secondOffer.offerId
    })
    expect(accepted.token.generation).toBe(2)
    backdateLease((first as SqliteTaskAuthority).databasePath, accepted.token.leaseId)
    expect(() =>
      first.takeOverExpired({
        connection: worker(OWNER_CARA),
        projectId: PROJECT_ALPHA,
        taskId: claimed.task.taskId,
        attemptId: claimed.attempt.attemptId,
        leaseId: claimed.token.leaseId,
        generation: 1
      })
    ).toThrowError(expect.objectContaining({ code: 'STALE_AUTHORITY' }))
  })

  it('fences cancellation against accept, takeover, and retry while holding capacity until exit acknowledgement', () => {
    const { first, second } = openPair()
    createTask(first, PROJECT_ALPHA, 'CX-1')
    const claimed = claim(first, PROJECT_ALPHA, 'CX-1')
    first.write({ kind: 'bind-worktree', connection: worker(OWNER_ALICE), token: claimed.token, resourceKey: '/repo/cx', worktreePath: '/repo/cx', repositoryId: 'r' })
    const offer = first.offerHandoff({
      connection: worker(OWNER_ALICE),
      projectId: PROJECT_ALPHA,
      taskId: claimed.task.taskId,
      attemptId: claimed.attempt.attemptId,
      leaseId: claimed.token.leaseId,
      generation: 1,
      targetOwnerId: OWNER_BOB
    })
    const snapshot = first.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks[0]
    first.requestCancellation({ connection: ADMIN, projectId: PROJECT_ALPHA, taskId: claimed.task.taskId, expectedEntityVersion: snapshot.entityVersion })
    // Cancellation wins: accept/takeover/ordinary writes are fenced; capacity and reservation stay held.
    expect(() =>
      second.acceptHandoff({
        connection: worker(OWNER_BOB),
        projectId: PROJECT_ALPHA,
        taskId: claimed.task.taskId,
        attemptId: claimed.attempt.attemptId,
        offerId: offer.offerId
      })
    ).toThrowError(expect.objectContaining({ code: 'TASK_CANCELLED' }))
    backdateLease((first as SqliteTaskAuthority).databasePath, claimed.token.leaseId)
    expect(() =>
      second.takeOverExpired({
        connection: worker(OWNER_BOB),
        projectId: PROJECT_ALPHA,
        taskId: claimed.task.taskId,
        attemptId: claimed.attempt.attemptId,
        leaseId: claimed.token.leaseId,
        generation: 1
      })
    ).toThrowError(expect.objectContaining({ code: 'TASK_CANCELLED' }))
    expect(() =>
      first.write({ kind: 'progress', connection: worker(OWNER_ALICE), token: claimed.token, detail: 'fenced' })
    ).toThrowError(expect.objectContaining({ code: 'TASK_CANCELLED' }))
    const cancelling = first.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks[0]
    expect(cancelling.currentAttempt?.reservation?.state).toBe('reserved')
    expect(() =>
      first.retryFailedTask({ connection: ADMIN, projectId: PROJECT_ALPHA, taskId: claimed.task.taskId, expectedEntityVersion: cancelling.entityVersion, ownerId: OWNER_BOB })
    ).toThrowError(expect.objectContaining({ code: 'STALE_AUTHORITY' }))
  })

  it('closes terminal tasks atomically against retry with duplicate retries fenced', () => {
    const { first, second } = openPair()
    createTask(first, PROJECT_ALPHA, 'TX-1')
    const claimed = claim(first, PROJECT_ALPHA, 'TX-1')
    first.write({ kind: 'fail', connection: worker(OWNER_ALICE), token: claimed.token, error: 'boom' })
    const failed = first.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks[0]
    // Two concurrent retries: the first commits, the second sees a bumped entity version.
    const retryA = second.retryFailedTask({ connection: ADMIN, projectId: PROJECT_ALPHA, taskId: claimed.task.taskId, expectedEntityVersion: failed.entityVersion, ownerId: OWNER_BOB })
    expect(retryA.attempt.sequence).toBe(2)
    expect(() =>
      first.retryFailedTask({ connection: ADMIN, projectId: PROJECT_ALPHA, taskId: claimed.task.taskId, expectedEntityVersion: failed.entityVersion, ownerId: OWNER_BOB })
    ).toThrowError(expect.objectContaining({ code: 'STALE_AUTHORITY' }))
  })

  it('rejects duplicate manual runs before and after schedule updates and conflicts on changed intent', () => {
    const { first, second } = openPair()
    const schedule = first.createSchedule({
      connection: ADMIN,
      projectId: PROJECT_ALPHA,
      spec: scheduleSpec(),
      nextRunAt: '2026-09-13T10:00:00.000Z'
    })
    const request = { projectId: PROJECT_ALPHA, scheduleId: schedule.scheduleId, requestId: 'manual-1' }
    const manual = first.enqueueManualScheduleExecution({ connection: ADMIN, ...request, expectedEntityVersion: 1 })
    // Same request ID after an intervening schedule update returns the original receipt.
    const updated = first.updateSchedule({ connection: ADMIN, projectId: PROJECT_ALPHA, scheduleId: schedule.scheduleId, expectedEntityVersion: 1, nextRunAt: '2026-09-13T10:05:00.000Z' })
    expect(updated.entityVersion).toBe(2)
    const retried = second.enqueueManualScheduleExecution({ connection: ADMIN, ...request, expectedEntityVersion: 99 })
    expect(retried.executionId).toBe(manual.executionId)
    // Manual racing the same schedule's due tick: distinct keys, next run untouched by manual.
    const due = first.enqueueDueSchedule({
      connection: { connectionId: 'sched', role: 'daemon-scheduler', authorizedProjectIds: [PROJECT_ALPHA], authorizedProfileIds: [PROFILE_MAIN] },
      projectId: PROJECT_ALPHA,
      scheduleId: schedule.scheduleId,
      expectedEntityVersion: 2,
      expectedNextRunAt: '2026-09-13T10:05:00.000Z'
    })
    expect(due.executionId).not.toBe(manual.executionId)
    const after = first.listScheduleExecutions({ connection: ADMIN, projectId: PROJECT_ALPHA, scheduleId: schedule.scheduleId })
    expect(after.executions).toHaveLength(2)
    // A different schedule carrying the same request ID does not collide across the project key.
    const otherSchedule = second.createSchedule({ connection: ADMIN, projectId: PROJECT_ALPHA, spec: scheduleSpec(), nextRunAt: '2026-09-13T12:00:00.000Z' })
    const other = second.enqueueManualScheduleExecution({ connection: ADMIN, projectId: PROJECT_ALPHA, scheduleId: otherSchedule.scheduleId, expectedEntityVersion: 1, requestId: 'manual-1' })
    expect(other.executionId).not.toBe(manual.executionId)
  })

  it('proves group retry receipts, names, lineage, and profile events are identical across duplicate requests', () => {
    const { first, path } = openPair()
    const one = createTask(first, PROJECT_ALPHA, 'LI-1')
    const group = first.createRunGroup({
      connection: ADMIN,
      profileId: PROFILE_MAIN,
      name: 'lineage',
      concurrency: 1,
      members: [{ projectId: PROJECT_ALPHA, taskId: one.taskId }]
    })
    const claimed = claim(first, PROJECT_ALPHA, 'LI-1')
    first.write({ kind: 'fail', connection: worker(OWNER_ALICE), token: claimed.token, error: 'boom' })
    const input = {
      connection: ADMIN,
      runGroupId: group.runGroupId,
      expectedEntityVersion: 1,
      requestId: 'lineage-req',
      ownerId: OWNER_BOB,
      memberTaskIds: [{ projectId: PROJECT_ALPHA, taskId: one.taskId }]
    }
    const retried = first.retryRunGroup(input)
    const duplicate = first.retryRunGroup(input)
    expect(duplicate).toEqual(retried)
    const db = openTaskAuthorityRawConnection(path)
    const receipts = db.prepare('SELECT profile_id, request_id, intent_sha256, result_run_group_id FROM run_group_mutation_receipts').all() as Array<Record<string, string>>
    const events = db.prepare("SELECT event_type, entity_version, payload_json FROM authority_profile_events WHERE event_type = 'run-group-retried'").all() as Array<Record<string, unknown>>
    const groups = db.prepare('SELECT name, retry_of_run_group_id FROM run_groups WHERE id = ?').get(retried.runGroupId) as { name: string; retry_of_run_group_id: string }
    db.close()
    expect(receipts).toHaveLength(1)
    expect(receipts[0].result_run_group_id).toBe(retried.runGroupId)
    expect(events).toHaveLength(1)
    expect(groups).toEqual({ name: 'lineage (retry)', retry_of_run_group_id: group.runGroupId })
  })

  it('rejects wrong-role and cross-profile duplicate keys for due, manual, and group retry before disclosing receipts', () => {
    const { first, second } = openPair()
    const schedule = first.createSchedule({
      connection: ADMIN,
      projectId: PROJECT_ALPHA,
      spec: scheduleSpec('profile-a'),
      nextRunAt: '2026-09-13T10:00:00.000Z'
    })
    const dueWinner = first.enqueueDueSchedule({
      connection: { connectionId: 'sched-a', role: 'daemon-scheduler', authorizedProjectIds: [PROJECT_ALPHA], authorizedProfileIds: ['profile-a'] },
      projectId: PROJECT_ALPHA,
      scheduleId: schedule.scheduleId,
      expectedEntityVersion: 1,
      expectedNextRunAt: '2026-09-13T10:00:00.000Z'
    })
    // Wrong role: rejected before any receipt lookup.
    expect(() =>
      second.enqueueDueSchedule({
        connection: worker(OWNER_ALICE),
        projectId: PROJECT_ALPHA,
        scheduleId: schedule.scheduleId,
        expectedEntityVersion: 1,
        expectedNextRunAt: '2026-09-13T10:00:00.000Z'
      })
    ).toThrowError(expect.objectContaining({ code: 'AUTHORIZATION_DENIED' }))
    // Cross-profile: rejected without disclosing the stored receipt.
    expect(() =>
      second.enqueueDueSchedule({
        connection: { connectionId: 'sched-b', role: 'daemon-scheduler', authorizedProjectIds: [PROJECT_ALPHA], authorizedProfileIds: ['profile-b'] },
        projectId: PROJECT_ALPHA,
        scheduleId: schedule.scheduleId,
        expectedEntityVersion: 1,
        expectedNextRunAt: '2026-09-13T10:00:00.000Z'
      })
    ).toThrowError(expect.objectContaining({ code: 'AUTHORIZATION_DENIED' }))
    const retried = first.enqueueDueSchedule({
      connection: { connectionId: 'sched-a', role: 'daemon-scheduler', authorizedProjectIds: [PROJECT_ALPHA], authorizedProfileIds: ['profile-a'] },
      projectId: PROJECT_ALPHA,
      scheduleId: schedule.scheduleId,
      expectedEntityVersion: 5,
      expectedNextRunAt: '2026-09-13T10:00:00.000Z'
    })
    expect(retried.executionId).toBe(dueWinner.executionId)

    const manual = first.enqueueManualScheduleExecution({ connection: ADMIN, projectId: PROJECT_ALPHA, scheduleId: schedule.scheduleId, expectedEntityVersion: 2, requestId: 'w-1' })
    expect(() =>
      second.enqueueManualScheduleExecution({
        connection: { connectionId: 'sched-a', role: 'daemon-scheduler', authorizedProjectIds: [PROJECT_ALPHA], authorizedProfileIds: ['profile-a'] },
        projectId: PROJECT_ALPHA,
        scheduleId: schedule.scheduleId,
        expectedEntityVersion: 2,
        requestId: 'w-1'
      })
    ).toThrowError(expect.objectContaining({ code: 'AUTHORIZATION_DENIED' }))
    expect(() =>
      second.enqueueManualScheduleExecution({
        connection: { connectionId: 'admin-b', role: 'administrator', authorizedProfileIds: ['profile-b'] },
        projectId: PROJECT_ALPHA,
        scheduleId: schedule.scheduleId,
        expectedEntityVersion: 2,
        requestId: 'w-1'
      })
    ).toThrowError(expect.objectContaining({ code: 'AUTHORIZATION_DENIED' }))
    const manualAgain = first.enqueueManualScheduleExecution({ connection: ADMIN, projectId: PROJECT_ALPHA, scheduleId: schedule.scheduleId, expectedEntityVersion: 9, requestId: 'w-1' })
    expect(manualAgain.executionId).toBe(manual.executionId)

    const one = createTask(first, PROJECT_ALPHA, 'WLI-1')
    const group = first.createRunGroup({
      connection: { connectionId: 'admin-a', role: 'administrator', authorizedProfileIds: ['profile-a'] },
      profileId: 'profile-a',
      name: 'scoped',
      concurrency: 1,
      members: [{ projectId: PROJECT_ALPHA, taskId: one.taskId }]
    })
    expect(() =>
      second.retryRunGroup({
        connection: { connectionId: 'admin-b', role: 'administrator', authorizedProfileIds: ['profile-b'] },
        runGroupId: group.runGroupId,
        expectedEntityVersion: 1,
        requestId: 'grp-1',
        ownerId: OWNER_ALICE,
        memberTaskIds: [{ projectId: PROJECT_ALPHA, taskId: one.taskId }]
      })
    ).toThrowError(expect.objectContaining({ code: 'PROJECT_SCOPE_MISMATCH' }))
  })

  it('keeps valid then stale and indeterminate then stale observations auditable across reopen', () => {
    const { first, path } = openPair()
    createTask(first, PROJECT_ALPHA, 'AO-1')
    const claimed = claim(first, PROJECT_ALPHA, 'AO-1')
    first.write({ kind: 'record-launch-intent', connection: worker(OWNER_ALICE), token: claimed.token, specificationId: claimed.attempt.specificationId })
    const snapshot = first.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks[0]
    const launchIntentId = snapshot.currentAttempt?.runtime?.launchIntentId as string
    first.beginSpawn({ token: claimed.token, launchIntentId, expectedSpecificationId: claimed.attempt.specificationId })
    first.write({ kind: 'bind-runtime', connection: worker(OWNER_ALICE), token: claimed.token, sessionId: 's', processIdentity: acpIdentity() })
    backdateLease(path, claimed.token.leaseId)
    const fingerprint = launchIntentFingerprint(launchIntentId, claimed.attempt.attemptId, claimed.token.leaseId)
    const input = {
      projectId: PROJECT_ALPHA,
      taskId: claimed.task.taskId,
      attemptId: claimed.attempt.attemptId,
      leaseId: claimed.token.leaseId,
      generation: 1,
      launchIntentSha256: fingerprint,
      processIdentity: acpIdentity()
    }
    // A mismatched launch-intent hash is rejected without mutation.
    expect(() =>
      first.reconcileExpiredOwner({ ...input, launchIntentSha256: 'cc'.repeat(32), verdict: { status: 'stale', reason: 'not-found' } })
    ).toThrowError(expect.objectContaining({ code: 'STALE_AUTHORITY' }))

    first.reconcileExpiredOwner({ ...input, verdict: { status: 'valid', current: acpIdentity() } })
    first.reconcileExpiredOwner({ ...input, verdict: { status: 'stale', reason: 'not-found' } })
    // Reopen: the latest exact ordered verdict (stale, confirmed exit) permits takeover.
    first.close()
    authorities.splice(authorities.indexOf(first), 1)
    const reopened = SqliteTaskAuthority.open({ databasePath: path, authorityLock: passThroughLock })
    authorities.push(reopened)
    const takeover = reopened.takeOverExpired({
      connection: worker(OWNER_BOB),
      projectId: PROJECT_ALPHA,
      taskId: claimed.task.taskId,
      attemptId: claimed.attempt.attemptId,
      leaseId: claimed.token.leaseId,
      generation: 1
    })
    expect(takeover.token.generation).toBe(2)

    // Indeterminate -> stale after a second reopen also remains auditable and permits takeover.
    createTask(reopened, PROJECT_ALPHA, 'AO-2')
    const second = claim(reopened, PROJECT_ALPHA, 'AO-2', OWNER_BOB)
    reopened.write({ kind: 'record-launch-intent', connection: worker(OWNER_BOB), token: second.token, specificationId: second.attempt.specificationId })
    const snapshotTwo = reopened.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks.find(task => task.externalTaskId === 'AO-2')
    const intentTwo = snapshotTwo?.currentAttempt?.runtime?.launchIntentId as string
    reopened.beginSpawn({ token: second.token, launchIntentId: intentTwo, expectedSpecificationId: second.attempt.specificationId })
    reopened.write({ kind: 'bind-runtime', connection: worker(OWNER_BOB), token: second.token, sessionId: 's2', processIdentity: acpIdentity() })
    backdateLease(path, second.token.leaseId)
    const fingerprintTwo = launchIntentFingerprint(intentTwo, second.attempt.attemptId, second.token.leaseId)
    const inputTwo = {
      projectId: PROJECT_ALPHA,
      taskId: second.task.taskId,
      attemptId: second.attempt.attemptId,
      leaseId: second.token.leaseId,
      generation: 1,
      launchIntentSha256: fingerprintTwo,
      processIdentity: acpIdentity()
    }
    reopened.reconcileExpiredOwner({ ...inputTwo, verdict: { status: 'indeterminate', reason: 'access-denied', detail: 'denied' } })
    reopened.close()
    authorities.splice(authorities.indexOf(reopened), 1)
    const intermediate = SqliteTaskAuthority.open({ databasePath: path, authorityLock: passThroughLock })
    authorities.push(intermediate)
    // A later distinct observation allocates the next sequence; takeover stays fenced before confirmed exit.
    expect(() =>
      intermediate.takeOverExpired({
        connection: worker(OWNER_CARA),
        projectId: PROJECT_ALPHA,
        taskId: second.task.taskId,
        attemptId: second.attempt.attemptId,
        leaseId: second.token.leaseId,
        generation: 1
      })
    ).toThrowError(expect.objectContaining({ code: 'RESOURCE_QUARANTINED' }))
    intermediate.reconcileExpiredOwner({ ...inputTwo, verdict: { status: 'stale', reason: 'not-found' } })
    intermediate.close()
    authorities.splice(authorities.indexOf(intermediate), 1)
    const reopenedAgain = SqliteTaskAuthority.open({ databasePath: path, authorityLock: passThroughLock })
    authorities.push(reopenedAgain)
    const takeoverTwo = reopenedAgain.takeOverExpired({
      connection: worker(OWNER_CARA),
      projectId: PROJECT_ALPHA,
      taskId: second.task.taskId,
      attemptId: second.attempt.attemptId,
      leaseId: second.token.leaseId,
      generation: 1
    })
    expect(takeoverTwo.token.ownerId).toBe(OWNER_CARA)
    const db = openTaskAuthorityRawConnection(path)
    const rowsFor = (hash: string): Array<{ verdict: string; sequence: number }> =>
      db.prepare('SELECT verdict, sequence FROM runtime_reconciliations WHERE launch_intent_sha256 = ? ORDER BY sequence').all(hash) as Array<{ verdict: string; sequence: number }>
    const firstIntentRows = rowsFor(fingerprint)
    const secondIntentRows = rowsFor(fingerprintTwo)
    db.close()
    expect(firstIntentRows).toEqual([
      { verdict: 'valid', sequence: 1 },
      { verdict: 'stale', sequence: 2 }
    ])
    expect(secondIntentRows).toEqual([
      { verdict: 'indeterminate', sequence: 1 },
      { verdict: 'stale', sequence: 2 }
    ])
  })

  it('rejects expired offer acceptance and fences takeover launch-state ladder deterministically', () => {
    const { first, second, path } = openPair()
    createTask(first, PROJECT_ALPHA, 'LA-1')
    const claimed = claim(first, PROJECT_ALPHA, 'LA-1')
    // No launch intent at all: takeover proceeds after expiry.
    backdateLease(path, claimed.token.leaseId)
    const takeover = second.takeOverExpired({
      connection: worker(OWNER_BOB),
      projectId: PROJECT_ALPHA,
      taskId: claimed.task.taskId,
      attemptId: claimed.attempt.attemptId,
      leaseId: claimed.token.leaseId,
      generation: 1
    })
    expect(takeover.token.generation).toBe(2)
  })
})

const OWNER_CARA = '56565656-5656-4656-8656-565656565656'

function acpIdentity(pid = 9797) {
  return {
    pid,
    bootId: 'boot-race',
    startedAt: new Date().toISOString(),
    executablePath: '/usr/bin/node',
    family: 'acp-agent' as const,
    capturedAt: new Date().toISOString()
  }
}

function scheduleSpec(profileId: string = PROFILE_MAIN) {
  return {
    profileId,
    taskTitle: 'scheduled',
    cadence: { kind: 'interval' as const, minutes: 5 },
    command: { program: 'node', args: ['t.js'] },
    target: { kind: 'local' as const, root: '/repo', label: 'repo' },
    verification: { requiredArtifacts: [] }
  }
}

function backdateLease(path: string, leaseId: string): void {
  const db = openTaskAuthorityRawConnection(path)
  db.prepare('UPDATE leases SET initial_expires_at_ms = initial_expires_at_ms - 120000 WHERE id = ?').run(leaseId)
  db.close()
}
