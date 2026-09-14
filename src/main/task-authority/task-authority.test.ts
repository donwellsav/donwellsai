import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, lstatSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ProcessIdentity, ProcessIdentityVerdict } from '@shared/child-process/process-spec'
import {
  TaskAuthorityValidationError,
  type AuthenticatedAuthorityConnection,
  type EnqueueDueScheduleInput,
  type TaskAuthority,
  type TaskExecutionSpecificationInput,
  type TaskScheduleSpec
} from '@shared/task-authority'
import { openTaskAuthorityRawConnection } from './schema'
import { launchIntentFingerprint, SqliteTaskAuthority } from './task-authority'

const PROJECT_ALPHA = 'project-alpha'
const PROJECT_BETA = 'project-beta'
const PROFILE_MAIN = 'profile-main'
const OWNER_ALICE = '12121212-1212-4212-8212-121212121212'
const OWNER_BOB = '34343434-3434-4434-8434-343434343434'
const OWNER_CARA = '56565656-5656-4656-8656-565656565656'

const ADMIN: AuthenticatedAuthorityConnection = { connectionId: 'conn-admin', role: 'administrator' }
const admin = (projects: string[] = []): AuthenticatedAuthorityConnection =>
  projects.length === 0 ? ADMIN : { connectionId: 'conn-admin', role: 'administrator', authorizedProjectIds: projects }
const worker = (ownerId: string, projects: readonly string[] = [PROJECT_ALPHA]): AuthenticatedAuthorityConnection => ({
  connectionId: `conn-worker-${ownerId}`,
  role: 'worker',
  ownerId,
  authorizedProjectIds: projects
})
const reviewer = (projects: readonly string[] = [PROJECT_ALPHA]): AuthenticatedAuthorityConnection => ({
  connectionId: 'conn-reviewer',
  role: 'reviewer',
  ownerId: '78787878-7878-4878-8878-787878787878',
  authorizedProjectIds: projects
})
const scheduler = (projects: readonly string[], profiles: readonly string[]): AuthenticatedAuthorityConnection => ({
  connectionId: 'conn-scheduler',
  role: 'daemon-scheduler',
  authorizedProjectIds: projects,
  authorizedProfileIds: profiles
})

const SPEC = (requiredArtifacts: ReadonlyArray<{ path: string; relationship: 'attached-reference' | 'observed-during-run' }> = []): TaskExecutionSpecificationInput => ({
  command: { program: 'node', args: ['run.js'], cwd: '/repo' },
  target: { kind: 'local', root: '/repo', label: 'repo' },
  verification: { requiredArtifacts }
})

const SCHEDULE_SPEC = (profileId: string = PROFILE_MAIN, taskTitle = 'scheduled task'): TaskScheduleSpec => ({
  profileId,
  taskTitle,
  cadence: { kind: 'interval', minutes: 5 },
  command: { program: 'node', args: ['tick.js'] },
  target: { kind: 'local', root: '/repo', label: 'repo' },
  verification: { requiredArtifacts: [] }
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

const SHA = (digit: string): string => digit.repeat(64)

const directories: string[] = []
const authorities: SqliteTaskAuthority[] = []

function tempDirectory(): string {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'task-authority-')))
  directories.push(directory)
  return directory
}

function openAuthority(directory: string = tempDirectory()): { authority: TaskAuthority; path: string; directory: string } {
  const databasePath = join(directory, 'task-authority.sqlite')
  const instance = SqliteTaskAuthority.open({ databasePath })
  authorities.push(instance)
  return { authority: instance, path: databasePath, directory }
}

function reopen(path: string): TaskAuthority {
  const instance = SqliteTaskAuthority.open({ databasePath: path })
  authorities.push(instance)
  return instance
}

afterEach(() => {
  while (authorities.length > 0) authorities.pop()?.close()
  while (directories.length > 0) rmSync(directories.pop() as string, { recursive: true, force: true })
})

function createTask(authority: TaskAuthority, projectId: string, externalTaskId: string, title = 'task', extra: Record<string, unknown> = {}) {
  return authority.createTask({ connection: ADMIN, projectId, externalTaskId, title, ...extra })
}

function claim(authority: TaskAuthority, projectId: string, externalTaskId: string, ownerId: string = OWNER_ALICE, specification = SPEC()) {
  return authority.claim({ connection: worker(ownerId, [projectId]), projectId, externalTaskId, specification, leaseTtlMs: 60_000 })
}

function taskAuthoritySchemaVersion(db: DatabaseSync): number {
  const row: unknown = db.prepare('PRAGMA user_version').get()
  if (typeof row !== 'object' || row === null || !('user_version' in row) || typeof row.user_version !== 'number') {
    throw new Error('task authority database reported no numeric user_version')
  }
  return row.user_version
}

describe('task authority schema security', () => {
  it('creates the database private to the current user and rejects links or permissive files', () => {
    const { path } = openAuthority()
    const stat = statSync(path)
    expect(stat.isFile()).toBe(true)
    expect(stat.mode & 0o777).toBe(0o600)

    const linkDirectory = tempDirectory()
    const linkPath = join(linkDirectory, 'authority-link.sqlite')
    symlinkSync(path, linkPath)
    expect(() => SqliteTaskAuthority.open({ databasePath: linkPath })).toThrowError(
      expect.objectContaining({ code: 'DATABASE_UNSAFE' })
    )

    const permissiveDirectory = tempDirectory()
    const permissivePath = join(permissiveDirectory, 'task-authority.sqlite')
    writeFileSync(permissivePath, Buffer.alloc(0), { mode: 0o644 })
    chmodSync(permissivePath, 0o644)
    expect(lstatSync(permissivePath).isFile()).toBe(true)
    expect(() => SqliteTaskAuthority.open({ databasePath: permissivePath })).toThrowError(expect.objectContaining({ code: 'DATABASE_UNSAFE' }))
  })

  it('fails closed on unsupported schema versions and unrecognized non-empty databases', () => {
    const versioned = tempDirectory()
    const versionedPath = join(versioned, 'task-authority.sqlite')
    const seeded = new DatabaseSync(versionedPath)
    seeded.exec('CREATE TABLE something_else(id TEXT); PRAGMA user_version=7;')
    seeded.close()
    chmodSync(versionedPath, 0o600)
    expect(() => SqliteTaskAuthority.open({ databasePath: versionedPath })).toThrowError(
      expect.objectContaining({ code: 'DAEMON_UPGRADE_REQUIRED' })
    )

    const foreign = tempDirectory()
    const foreignPath = join(foreign, 'task-authority.sqlite')
    const foreignDb = new DatabaseSync(foreignPath)
    foreignDb.exec('CREATE TABLE foreign_rows(id TEXT)')
    foreignDb.close()
    chmodSync(foreignPath, 0o600)
    expect(() => SqliteTaskAuthority.open({ databasePath: foreignPath })).toThrowError(
      expect.objectContaining({ code: 'MIGRATION_REQUIRED' })
    )
  })

  it('migrates a v1 database to v2 so run-group members carry committed specifications', () => {
    const { path } = openAuthority()
    const downgrade = openTaskAuthorityRawConnection(path)
    downgrade.exec('ALTER TABLE run_members DROP COLUMN specification_json')
    downgrade.exec('PRAGMA user_version=1')
    downgrade.close()

    const migrated = reopen(path)
    const db = openTaskAuthorityRawConnection(path)
    try {
      expect(taskAuthoritySchemaVersion(db)).toBe(2)
      const columns = db.prepare('PRAGMA table_info(run_members)').all()
      if (!Array.isArray(columns)) throw new Error('table_info returned no rows')
      expect(columns.some(column => typeof column === 'object' && column !== null && 'name' in column && column.name === 'specification_json')).toBe(true)
    } finally {
      db.close()
    }
    const task = migrated.createTask({ connection: ADMIN, projectId: PROJECT_ALPHA, externalTaskId: 'DW-M1', title: 'migration member' })
    const group = migrated.createRunGroup({
      connection: ADMIN,
      profileId: PROFILE_MAIN,
      name: 'migrated fan-out',
      concurrency: 1,
      members: [{ projectId: PROJECT_ALPHA, taskId: task.taskId, specification: SPEC() }]
    })
    expect(group.members).toHaveLength(1)
  })

  it('recovers an interrupted v1->v2 migration that already added the column', () => {
    const { path } = openAuthority()
    // Simulate the torn state a crash between ALTER and the version bump would
    // leave: the column exists but the database still declares version 1.
    const torn = openTaskAuthorityRawConnection(path)
    torn.exec('PRAGMA user_version=1')
    torn.close()

    const recovered = reopen(path)
    const task = recovered.createTask({ connection: ADMIN, projectId: PROJECT_ALPHA, externalTaskId: 'DW-M2', title: 'recovered member' })
    const group = recovered.createRunGroup({
      connection: ADMIN,
      profileId: PROFILE_MAIN,
      name: 'recovered fan-out',
      concurrency: 1,
      members: [{ projectId: PROJECT_ALPHA, taskId: task.taskId, specification: SPEC() }]
    })
    expect(group.members).toHaveLength(1)
    const db = openTaskAuthorityRawConnection(path)
    try {
      expect(taskAuthoritySchemaVersion(db)).toBe(2)
    } finally {
      db.close()
    }
  })

  it('rejects a swapped database identity while in use', () => {
    const directory = tempDirectory()
    const databasePath = join(directory, 'task-authority.sqlite')
    const instance = SqliteTaskAuthority.open({ databasePath })
    authorities.push(instance)
    const replacement = join(directory, 'replacement.sqlite')
    const seeded = new DatabaseSync(replacement)
    seeded.exec('CREATE TABLE y(id TEXT)')
    seeded.close()
    chmodSync(replacement, 0o600)
    rmSync(databasePath)
    renameSync(replacement, databasePath)
    expect(() => instance.query({ connection: ADMIN })).toThrowError(expect.objectContaining({ code: 'DATABASE_CHANGED' }))
  })
})

describe('task authority contract', () => {
  it('creates tasks with stable snapshots and scopes external task IDs per project', () => {
    const { authority, path } = openAuthority()
    const alpha = createTask(authority, PROJECT_ALPHA, 'DW-1', 'alpha task', { body: 'hello', priority: 3 })
    const beta = createTask(authority, PROJECT_BETA, 'dw-1', 'beta task')
    expect(alpha.taskId).not.toBe(beta.taskId)
    expect(alpha).toMatchObject({ projectId: PROJECT_ALPHA, externalTaskId: 'DW-1', title: 'alpha task', body: 'hello', status: 'todo', priority: 3, entityVersion: 1 })
    expect(beta).toMatchObject({ projectId: PROJECT_BETA, externalTaskId: 'dw-1' })
    expect(() => createTask(authority, PROJECT_ALPHA, 'dw-1')).toThrowError(TaskAuthorityValidationError)
    const reopened = reopen(path)
    expect(reopened.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks.map(task => task.externalTaskId)).toEqual(['DW-1'])
    expect(reopened.query({ connection: ADMIN, projectId: PROJECT_BETA }).tasks.map(task => task.externalTaskId)).toEqual(['dw-1'])
  })

  it('rejects dependency cycles and distinguishes explicit blocking from derived dependency-blocked projections', () => {
    const { authority } = openAuthority()
    const a = createTask(authority, PROJECT_ALPHA, 'A')
    const b = createTask(authority, PROJECT_ALPHA, 'B')
    const c = createTask(authority, PROJECT_ALPHA, 'C')
    authority.setDependencies({ connection: ADMIN, projectId: PROJECT_ALPHA, taskId: b.taskId, expectedEntityVersion: 1, dependsOnTaskIds: [a.taskId] })
    authority.setDependencies({ connection: ADMIN, projectId: PROJECT_ALPHA, taskId: c.taskId, expectedEntityVersion: 1, dependsOnTaskIds: [b.taskId] })
    expect(() =>
      authority.setDependencies({ connection: ADMIN, projectId: PROJECT_ALPHA, taskId: a.taskId, expectedEntityVersion: 1, dependsOnTaskIds: [c.taskId] })
    ).toThrowError(expect.objectContaining({ code: 'DEPENDENCY_BLOCKED' }))

    const projection = authority.query({ connection: ADMIN, projectId: PROJECT_ALPHA, runnableOnly: true })
    expect(projection.tasks.map(task => task.externalTaskId)).toEqual(['A'])
    const cSnapshot = authority.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks.find(task => task.taskId === c.taskId)
    expect(cSnapshot).toMatchObject({ status: 'todo', dependencyBlocked: true, runnable: false })
    expect(projection.tasks.find(task => task.taskId === c.taskId)).toBeUndefined()

    authority.updateTask({ connection: ADMIN, projectId: PROJECT_ALPHA, taskId: a.taskId, expectedEntityVersion: 1, status: 'blocked' })
    const blockedSnapshot = authority.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks.find(task => task.taskId === a.taskId)
    expect(blockedSnapshot).toMatchObject({ status: 'blocked', dependencyBlocked: false, runnable: false })
    authority.updateTask({ connection: ADMIN, projectId: PROJECT_ALPHA, taskId: a.taskId, expectedEntityVersion: 2, status: 'todo' })
    authority.updateTask({ connection: ADMIN, projectId: PROJECT_ALPHA, taskId: b.taskId, expectedEntityVersion: 2, status: 'blocked' })
    const derived = authority.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks.find(task => task.taskId === c.taskId)
    expect(derived).toMatchObject({ status: 'todo', dependencyBlocked: true })
  })

  it('orders runnable projections by priority, creation time, then task id', () => {
    const { authority } = openAuthority()
    createTask(authority, PROJECT_ALPHA, 'P2', 'second', { priority: 5 })
    createTask(authority, PROJECT_ALPHA, 'P1a', 'first-a', { priority: 1 })
    createTask(authority, PROJECT_ALPHA, 'P1b', 'first-b', { priority: 1 })
    createTask(authority, PROJECT_ALPHA, 'P3', 'blocked', { priority: 0, status: 'blocked' })
    const projection = authority.query({ connection: ADMIN, projectId: PROJECT_ALPHA, runnableOnly: true })
    expect(projection.tasks.map(task => task.externalTaskId)).toEqual(['P1a', 'P1b', 'P2'])
  })

  it('claims with a first-lease bootstrap, fences non-owners, and persists across reopen', () => {
    const { authority, path } = openAuthority()
    createTask(authority, PROJECT_ALPHA, 'CLAIM-1')
    const claimed = claim(authority, PROJECT_ALPHA, 'CLAIM-1')
    expect(claimed.token).toMatchObject({ projectId: PROJECT_ALPHA, ownerId: OWNER_ALICE, generation: 1 })
    expect(claimed.attempt).toMatchObject({ state: 'claimed', sequence: 1, provenance: 'native', retryOfAttemptId: null })
    expect(claimed.attempt.currentLease?.ownerId).toBe(OWNER_ALICE)
    expect(claimed.task).toMatchObject({ status: 'in-progress', currentAttempt: { attemptId: claimed.attempt.attemptId } })
    expect(() => claim(authority, PROJECT_ALPHA, 'CLAIM-1', OWNER_BOB)).toThrowError(expect.objectContaining({ code: 'TASK_NOT_RUNNABLE' }))

    const wrongOwner = worker(OWNER_BOB, [PROJECT_ALPHA])
    expect(() =>
      authority.write({ kind: 'progress', connection: wrongOwner, token: { ...claimed.token, ownerId: OWNER_BOB }, detail: 'spoofed' })
    ).toThrowError(expect.objectContaining({ code: 'AUTHORIZATION_DENIED' }))
    const crossProject = worker(OWNER_ALICE, [PROJECT_BETA])
    expect(() =>
      authority.write({ kind: 'progress', connection: crossProject, token: claimed.token, detail: 'cross' })
    ).toThrowError(expect.objectContaining({ code: 'PROJECT_SCOPE_MISMATCH' }))

    const reopened = reopen(path)
    const persisted = reopened.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks[0]
    expect(persisted.currentAttempt?.attemptId).toBe(claimed.attempt.attemptId)
    expect(persisted.currentAttempt?.currentLease?.generation).toBe(1)
  })

  it('bounds heartbeats, extends expiry from authority time, and rejects writes after expiry', async () => {
    const { authority } = openAuthority()
    createTask(authority, PROJECT_ALPHA, 'HB-1')
    createTask(authority, PROJECT_ALPHA, 'HB-2')
    const claimed = claim(authority, PROJECT_ALPHA, 'HB-1', OWNER_ALICE, SPEC())
    expect(() =>
      authority.write({ kind: 'heartbeat', connection: worker(OWNER_ALICE), token: claimed.token, ttlMs: 500 })
    ).toThrowError(TaskAuthorityValidationError)
    expect(() =>
      authority.write({ kind: 'heartbeat', connection: worker(OWNER_ALICE), token: claimed.token, ttlMs: 60 * 60_000 })
    ).toThrowError(TaskAuthorityValidationError)

    const heartbeat = authority.write({ kind: 'heartbeat', connection: worker(OWNER_ALICE), token: claimed.token, ttlMs: 60_000 })
    expect(heartbeat.currentAttempt?.currentLease?.expiresAtMs).toBeGreaterThan(claimed.attempt.currentLease?.expiresAtMs ?? 0)

    const fleeting = authority.claim({ connection: worker(OWNER_ALICE), projectId: PROJECT_ALPHA, externalTaskId: 'HB-2', specification: SPEC(), leaseTtlMs: 1_000 })
    await new Promise(resolve => setTimeout(resolve, 1_150))
    expect(() =>
      authority.write({ kind: 'progress', connection: worker(OWNER_ALICE), token: fleeting.token, detail: 'too late' })
    ).toThrowError(expect.objectContaining({ code: 'LEASE_EXPIRED' }))
  }, 20_000)

  it('records progress and binds only acp-agent runtime identities', () => {
    const { authority } = openAuthority()
    createTask(authority, PROJECT_ALPHA, 'RT-1')
    const claimed = claim(authority, PROJECT_ALPHA, 'RT-1')
    authority.write({ kind: 'progress', connection: worker(OWNER_ALICE), token: claimed.token, detail: 'halfway' })
    let snapshot = authority.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks[0]
    expect(snapshot.currentAttempt?.lastProgress).toBe('halfway')

    authority.write({ kind: 'record-launch-intent', connection: worker(OWNER_ALICE), token: claimed.token, specificationId: claimed.attempt.specificationId })
    snapshot = authority.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks[0]
    const launchIntentId = snapshot.currentAttempt?.runtime?.launchIntentId as string
    expect(launchIntentId).toBeTruthy()
    const admission = authority.beginSpawn({ token: claimed.token, launchIntentId, expectedSpecificationId: claimed.attempt.specificationId })
    expect(admission).toMatchObject({ attemptId: claimed.attempt.attemptId, leaseId: claimed.token.leaseId, launchIntentId })
    snapshot = authority.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks[0]
    expect(snapshot.currentAttempt?.state).toBe('launching')

    const terminalIdentity: ProcessIdentity = { ...IDENTITY(), family: 'terminal-daemon' }
    expect(() =>
      authority.write({ kind: 'bind-runtime', connection: worker(OWNER_ALICE), token: claimed.token, sessionId: 'session-1', processIdentity: terminalIdentity })
    ).toThrowError(expect.objectContaining({ code: 'AUTHORIZATION_DENIED' }))

    authority.write({ kind: 'bind-runtime', connection: worker(OWNER_ALICE), token: claimed.token, sessionId: 'session-1', processIdentity: IDENTITY() })
    snapshot = authority.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks[0]
    expect(snapshot.currentAttempt?.state).toBe('running')
    expect(snapshot.currentAttempt?.runtime?.processIdentity?.pid).toBe(4242)
  })

  it('binds canonical worktree reservations exclusively across aliases and projects', () => {
    const { authority } = openAuthority()
    createTask(authority, PROJECT_ALPHA, 'WT-1')
    createTask(authority, PROJECT_BETA, 'WT-2')
    const first = claim(authority, PROJECT_ALPHA, 'WT-1')
    const second = claim(authority, PROJECT_BETA, 'WT-2', OWNER_BOB)
    authority.write({ kind: 'bind-worktree', connection: worker(OWNER_ALICE), token: first.token, resourceKey: '/Repo/Alpha/', worktreePath: '/Repo/Alpha', repositoryId: 'repo-1' })
    expect(() =>
      authority.write({ kind: 'bind-worktree', connection: worker(OWNER_BOB, [PROJECT_BETA]), token: second.token, resourceKey: '/repo/alpha', worktreePath: '/repo/alpha', repositoryId: 'repo-1' })
    ).toThrowError(expect.objectContaining({ code: 'RESOURCE_QUARANTINED' }))
    authority.write({ kind: 'bind-worktree', connection: worker(OWNER_BOB, [PROJECT_BETA]), token: second.token, resourceKey: '/repo/beta', worktreePath: '/repo/beta', repositoryId: 'repo-1' })
    const beta = authority.query({ connection: ADMIN, projectId: PROJECT_BETA }).tasks[0]
    expect(beta.currentAttempt?.reservation?.canonicalResourceKey).toBe('/repo/beta')
  })
})

describe('task authority completion, recovery, and handoff', () => {
  it('enforces completion requirements and satisfies them through native artifacts', () => {
    const { authority } = openAuthority()
    createTask(authority, PROJECT_ALPHA, 'DONE-1')
    const claimed = claim(authority, PROJECT_ALPHA, 'DONE-1', OWNER_ALICE, SPEC([{ path: 'build/out.txt', relationship: 'attached-reference' }]))
    expect(() =>
      authority.write({ kind: 'complete', connection: worker(OWNER_ALICE), token: claimed.token, result: { summary: 'done' } })
    ).toThrowError(expect.objectContaining({ code: 'COMPLETION_REJECTED' }))
    authority.write({
      kind: 'attach-artifact',
      connection: worker(OWNER_ALICE),
      token: claimed.token,
      artifact: { path: 'build/out.txt', sha256: SHA('a'), bytes: 12, sourceFingerprint: null, relationship: 'attached-reference' }
    })
    const completed = authority.write({ kind: 'complete', connection: worker(OWNER_ALICE), token: claimed.token, result: { summary: 'done' } })
    expect(completed).toMatchObject({ status: 'done', currentAttempt: { state: 'completed' } })
  })

  it('satisfies completion for imported-legacy artifacts only through reviewed adoption', () => {
    const { authority, path } = openAuthority()
    createTask(authority, PROJECT_ALPHA, 'ADOPT-1')
    const claimed = claim(authority, PROJECT_ALPHA, 'ADOPT-1', OWNER_ALICE, SPEC([{ path: 'legacy.out', relationship: 'observed-during-run' }]))
    const db = openTaskAuthorityRawConnection(path)
    const artifactId = insertImportedArtifact(db, PROJECT_ALPHA, claimed.task.taskId, 'legacy.out')
    db.close()
    expect(() =>
      authority.write({ kind: 'complete', connection: worker(OWNER_ALICE), token: claimed.token, result: { summary: 'done' } })
    ).toThrowError(expect.objectContaining({ code: 'COMPLETION_REJECTED' }))
    authority.adoptArtifact({ connection: reviewer(), projectId: PROJECT_ALPHA, taskId: claimed.task.taskId, artifactId, reviewReceiptSha256: SHA('c') })
    const completed = authority.write({ kind: 'complete', connection: worker(OWNER_ALICE), token: claimed.token, result: { summary: 'done' } })
    expect(completed.status).toBe('done')
    const reopened = reopen(path)
    expect(reopened.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks[0].status).toBe('done')
  })

  it('creates atomic retry lineage from failed attempts and fences duplicate retries', () => {
    const { authority, path } = openAuthority()
    createTask(authority, PROJECT_ALPHA, 'RETRY-1')
    const claimed = claim(authority, PROJECT_ALPHA, 'RETRY-1')
    authority.write({ kind: 'fail', connection: worker(OWNER_ALICE), token: claimed.token, error: 'boom' })
    const snapshot = authority.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks[0]
    expect(snapshot).toMatchObject({ status: 'failed', currentAttempt: { state: 'failed', sequence: 1 } })
    const version = snapshot.entityVersion
    expect(() =>
      authority.retryFailedTask({ connection: admin(), projectId: PROJECT_ALPHA, taskId: claimed.task.taskId, expectedEntityVersion: version + 1, ownerId: OWNER_BOB })
    ).toThrowError(expect.objectContaining({ code: 'STALE_AUTHORITY' }))
    const retried = authority.retryFailedTask({ connection: admin(), projectId: PROJECT_ALPHA, taskId: claimed.task.taskId, expectedEntityVersion: version, ownerId: OWNER_BOB })
    expect(retried.attempt).toMatchObject({ sequence: 2, retryOfAttemptId: claimed.attempt.attemptId, state: 'claimed' })
    expect(retried.token.ownerId).toBe(OWNER_BOB)
    expect(retried.token.generation).toBe(1)
    expect(retried.task.currentAttempt?.attemptId).toBe(retried.attempt.attemptId)
    const reopened = reopen(path)
    const persisted = reopened.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks[0]
    expect(persisted.currentAttempt?.sequence).toBe(2)
    expect(persisted.currentAttempt?.retryOfAttemptId).toBe(claimed.attempt.attemptId)
  })

  it('moves cancellation intent through trusted exit acknowledgement without recording progress', () => {
    const { authority, path } = openAuthority()
    createTask(authority, PROJECT_ALPHA, 'CANCEL-1')
    const claimed = claim(authority, PROJECT_ALPHA, 'CANCEL-1')
    authority.write({ kind: 'bind-worktree', connection: worker(OWNER_ALICE), token: claimed.token, resourceKey: '/repo/cancel', worktreePath: '/repo/cancel', repositoryId: 'repo-1' })
    const snapshot = authority.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks[0]
    authority.requestCancellation({ connection: admin(), projectId: PROJECT_ALPHA, taskId: claimed.task.taskId, expectedEntityVersion: snapshot.entityVersion })
    const cancelling = authority.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks[0]
    expect(cancelling).toMatchObject({ status: 'cancelling', cancelState: 'requested', currentAttempt: { state: 'cancelling' } })
    expect(() =>
      authority.write({ kind: 'progress', connection: worker(OWNER_ALICE), token: claimed.token, detail: 'still working' })
    ).toThrowError(expect.objectContaining({ code: 'TASK_CANCELLED' }))
    expect(() =>
      authority.beginSpawn({ token: claimed.token, launchIntentId: '9f2f80b0-5c2d-4f08-9f2f-80b05c2d4f08', expectedSpecificationId: claimed.attempt.specificationId })
    ).toThrowError(expect.objectContaining({ code: 'TASK_CANCELLED' }))
    // capacity and reservations remain held while cancelling
    expect(cancelling.currentAttempt?.reservation?.state).toBe('reserved')

    const acknowledged = authority.acknowledgeExit({
      projectId: PROJECT_ALPHA,
      taskId: claimed.task.taskId,
      attemptId: claimed.attempt.attemptId,
      leaseId: claimed.token.leaseId,
      generation: 1
    })
    expect(acknowledged).toMatchObject({ status: 'cancelled', currentAttempt: { state: 'cancelled' } })
    expect(acknowledged.currentAttempt?.reservation).toBeNull()
    const reopened = reopen(path)
    const persisted = reopened.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks[0]
    expect(persisted.status).toBe('cancelled')
    expect(persisted.currentAttempt?.lastProgress).toBeNull()
  })

  it('acknowledges late exit only for cancelling attempts', () => {
    const { authority } = openAuthority()
    createTask(authority, PROJECT_ALPHA, 'LATE-1')
    const claimed = claim(authority, PROJECT_ALPHA, 'LATE-1')
    expect(() =>
      authority.acknowledgeExit({
        projectId: PROJECT_ALPHA,
        taskId: claimed.task.taskId,
        attemptId: claimed.attempt.attemptId,
        leaseId: claimed.token.leaseId,
        generation: 1
      })
    ).toThrowError(expect.objectContaining({ code: 'STALE_AUTHORITY' }))
  })

  it('offers, cancels, and accepts handoffs with exact tuple binding', () => {
    const { authority, path } = openAuthority()
    createTask(authority, PROJECT_ALPHA, 'HAND-1')
    const claimed = claim(authority, PROJECT_ALPHA, 'HAND-1')
    const offer = authority.offerHandoff({
      connection: worker(OWNER_ALICE),
      projectId: PROJECT_ALPHA,
      taskId: claimed.task.taskId,
      attemptId: claimed.attempt.attemptId,
      leaseId: claimed.token.leaseId,
      generation: 1,
      targetOwnerId: OWNER_BOB
    })
    expect(offer).toMatchObject({ status: 'pending', sourceOwnerId: OWNER_ALICE, targetOwnerId: OWNER_BOB })
    // A live offer fences source ordinary writes...
    expect(() =>
      authority.write({ kind: 'progress', connection: worker(OWNER_ALICE), token: claimed.token, detail: 'fenced' })
    ).toThrowError(expect.objectContaining({ code: 'HANDOFF_PENDING' }))
    // ...but the source may still cancel the exact tuple-bound offer.
    const cancelled = authority.cancelHandoff({
      connection: worker(OWNER_ALICE),
      projectId: PROJECT_ALPHA,
      taskId: claimed.task.taskId,
      attemptId: claimed.attempt.attemptId,
      leaseId: claimed.token.leaseId,
      generation: 1,
      offerId: offer.offerId
    })
    expect(cancelled.status).toBe('cancelled')
    const afterCancel = authority.write({ kind: 'progress', connection: worker(OWNER_ALICE), token: claimed.token, detail: 'resumed' })
    expect(afterCancel.currentAttempt?.lastProgress).toBe('resumed')

    const second = authority.offerHandoff({
      connection: worker(OWNER_ALICE),
      projectId: PROJECT_ALPHA,
      taskId: claimed.task.taskId,
      attemptId: claimed.attempt.attemptId,
      leaseId: claimed.token.leaseId,
      generation: 1,
      targetOwnerId: OWNER_BOB
    })
    const accepted = authority.acceptHandoff({
      connection: worker(OWNER_BOB),
      projectId: PROJECT_ALPHA,
      taskId: claimed.task.taskId,
      attemptId: claimed.attempt.attemptId,
      offerId: second.offerId
    })
    expect(accepted.token.ownerId).toBe(OWNER_BOB)
    expect(accepted.token.generation).toBe(2)
    expect(accepted.attempt.currentLease?.leaseId).toBe(accepted.token.leaseId)
    // stale writer after transfer
    expect(() =>
      authority.write({ kind: 'progress', connection: worker(OWNER_ALICE), token: claimed.token, detail: 'stale lease' })
    ).toThrowError(expect.objectContaining({ code: 'STALE_AUTHORITY' }))
    const reopened = reopen(path)
    const persisted = reopened.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks[0]
    expect(persisted.currentAttempt?.currentLease?.ownerId).toBe(OWNER_BOB)
    expect(persisted.currentAttempt?.currentLease?.generation).toBe(2)
  })
})

function insertImportedArtifact(db: DatabaseSync, projectId: string, taskId: string, path: string): string {
  const artifactId = globalThis.crypto.randomUUID()
  db.prepare("INSERT INTO verification_artifacts(id, project_id, task_id, attempt_id, lease_id, generation, provenance_kind, path, sha256, bytes, source_fingerprint, relationship, attached_at) VALUES (?,?,?,NULL,NULL,NULL,'imported-legacy',?,?,?,?,?,?)")
    .run(artifactId, projectId, taskId, path, SHA('a'), 10, null, 'observed-during-run', new Date().toISOString())
  return artifactId
}

describe('task authority takeover and reconciliation', () => {
  function expiredAttempt(authority: TaskAuthority, path: string, externalTaskId: string) {
    createTask(authority, PROJECT_ALPHA, externalTaskId)
    const claimed = claim(authority, PROJECT_ALPHA, externalTaskId)
    authority.write({ kind: 'record-launch-intent', connection: worker(OWNER_ALICE), token: claimed.token, specificationId: claimed.attempt.specificationId })
    const snapshot = authority.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks[0]
    const launchIntentId = snapshot.currentAttempt?.runtime?.launchIntentId as string
    authority.beginSpawn({ token: claimed.token, launchIntentId, expectedSpecificationId: claimed.attempt.specificationId })
    authority.write({ kind: 'bind-runtime', connection: worker(OWNER_ALICE), token: claimed.token, sessionId: 's-1', processIdentity: IDENTITY() })
    authority.write({ kind: 'bind-worktree', connection: worker(OWNER_ALICE), token: claimed.token, resourceKey: '/repo/expired', worktreePath: '/repo/expired', repositoryId: 'repo-1' })
    const db = openTaskAuthorityRawConnection(path)
    db.prepare('UPDATE leases SET initial_expires_at_ms = initial_expires_at_ms - 120000 WHERE id = ?').run(claimed.token.leaseId)
    db.close()
    return { claimed, launchIntentId }
  }

  it('requires an expired lease and ordered reconciliation receipts before takeover', () => {
    const { authority } = openAuthority()
    createTask(authority, PROJECT_ALPHA, 'TAKE-1')
    const live = claim(authority, PROJECT_ALPHA, 'TAKE-1')
    expect(() =>
      authority.takeOverExpired({
        connection: worker(OWNER_BOB),
        projectId: PROJECT_ALPHA,
        taskId: live.task.taskId,
        attemptId: live.attempt.attemptId,
        leaseId: live.token.leaseId,
        generation: 1
      })
    ).toThrowError(expect.objectContaining({ code: 'STALE_AUTHORITY' }))
  })

  it('quarantines on valid and indeterminate receipts and permits takeover only after confirmed exit', () => {
    const { authority, path } = openAuthority()
    const { claimed, launchIntentId } = expiredAttempt(authority, path, 'TAKE-2')
    const fingerprint = launchIntentFingerprint(launchIntentId, claimed.attempt.attemptId, claimed.token.leaseId)

    const reconcile = (verdict: ProcessIdentityVerdict) =>
      authority.reconcileExpiredOwner({
        projectId: PROJECT_ALPHA,
        taskId: claimed.task.taskId,
        attemptId: claimed.attempt.attemptId,
        leaseId: claimed.token.leaseId,
        generation: 1,
        launchIntentSha256: fingerprint,
        processIdentity: IDENTITY(),
        verdict
      })

    reconcile(VERDICTS.valid)
    let snapshot = authority.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks[0]
    expect(snapshot).toMatchObject({ status: 'quarantined', currentAttempt: { state: 'quarantined' } })
    expect(snapshot.currentAttempt?.reservation?.state).toBe('quarantined')
    expect(() =>
      authority.takeOverExpired({
        connection: worker(OWNER_BOB),
        projectId: PROJECT_ALPHA,
        taskId: claimed.task.taskId,
        attemptId: claimed.attempt.attemptId,
        leaseId: claimed.token.leaseId,
        generation: 1
      })
    ).toThrowError(expect.objectContaining({ code: 'RESOURCE_QUARANTINED' }))

    reconcile(VERDICTS.stale)
    snapshot = authority.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks[0]
    expect(snapshot.currentAttempt?.runtime?.stopState).toBe('exited')
    const takeover = authority.takeOverExpired({
      connection: worker(OWNER_BOB),
      projectId: PROJECT_ALPHA,
      taskId: claimed.task.taskId,
      attemptId: claimed.attempt.attemptId,
      leaseId: claimed.token.leaseId,
      generation: 1
    })
    expect(takeover.token).toMatchObject({ ownerId: OWNER_BOB, generation: 2 })
    expect(takeover.attempt.state).toBe('claimed')
    expect(takeover.attempt.reservation?.state).toBe('reserved')
  })

  it('returns the prior receipt for identical reconciliation retries and allocates sequences for distinct observations', () => {
    const { authority, path } = openAuthority()
    const { claimed, launchIntentId } = expiredAttempt(authority, path, 'TAKE-3')
    const fingerprint = launchIntentFingerprint(launchIntentId, claimed.attempt.attemptId, claimed.token.leaseId)
    const input = {
      projectId: PROJECT_ALPHA,
      taskId: claimed.task.taskId,
      attemptId: claimed.attempt.attemptId,
      leaseId: claimed.token.leaseId,
      generation: 1,
      launchIntentSha256: fingerprint,
      processIdentity: IDENTITY()
    }
    authority.reconcileExpiredOwner({ ...input, verdict: VERDICTS.indeterminate })
    authority.reconcileExpiredOwner({ ...input, verdict: VERDICTS.indeterminate })
    authority.reconcileExpiredOwner({ ...input, verdict: VERDICTS.stale })
    const db = openTaskAuthorityRawConnection(path)
    const rows = db.prepare('SELECT verdict, sequence FROM runtime_reconciliations ORDER BY sequence').all() as Array<{ verdict: string; sequence: number }>
    db.close()
    expect(rows).toEqual([
      { verdict: 'indeterminate', sequence: 1 },
      { verdict: 'stale', sequence: 2 }
    ])
    // An earlier stale receipt cannot override a later valid observation.
    authority.reconcileExpiredOwner({ ...input, verdict: VERDICTS.valid })
    expect(() =>
      authority.takeOverExpired({
        connection: worker(OWNER_BOB),
        projectId: PROJECT_ALPHA,
        taskId: claimed.task.taskId,
        attemptId: claimed.attempt.attemptId,
        leaseId: claimed.token.leaseId,
        generation: 1
      })
    ).toThrowError(expect.objectContaining({ code: 'RESOURCE_QUARANTINED' }))
  })

  it('reconciles a planned launch intent to reconciling-no-spawn and quarantines spawning without identity', () => {
    const { authority, path } = openAuthority()
    createTask(authority, PROJECT_ALPHA, 'TAKE-4')
    const claimed = claim(authority, PROJECT_ALPHA, 'TAKE-4')
    authority.write({ kind: 'record-launch-intent', connection: worker(OWNER_ALICE), token: claimed.token, specificationId: claimed.attempt.specificationId })
    const snapshot = authority.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks[0]
    const launchIntentId = snapshot.currentAttempt?.runtime?.launchIntentId as string
    authority.beginSpawn({ token: claimed.token, launchIntentId, expectedSpecificationId: claimed.attempt.specificationId })
    const db = openTaskAuthorityRawConnection(path)
    db.prepare('UPDATE leases SET initial_expires_at_ms = initial_expires_at_ms - 120000 WHERE id = ?').run(claimed.token.leaseId)
    db.prepare('UPDATE launch_intents SET process_identity_json = NULL WHERE id = ?').run(launchIntentId)
    db.close()
    expect(() =>
      authority.takeOverExpired({
        connection: worker(OWNER_BOB),
        projectId: PROJECT_ALPHA,
        taskId: claimed.task.taskId,
        attemptId: claimed.attempt.attemptId,
        leaseId: claimed.token.leaseId,
        generation: 1
      })
    ).toThrowError(expect.objectContaining({ code: 'RESOURCE_QUARANTINED' }))
    const quarantined = authority.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks[0]
    expect(quarantined.currentAttempt?.state).toBe('quarantined')
  })
})

describe('task authority schedules and executions', () => {
  it('enqueues due occurrences idempotently, advances next run, and survives reopen', () => {
    const { authority, path } = openAuthority()
    const schedule = authority.createSchedule({
      connection: admin(),
      projectId: PROJECT_ALPHA,
      spec: SCHEDULE_SPEC(),
      nextRunAt: '2026-09-13T10:00:00.000Z'
    })
    expect(schedule).toMatchObject({ entityVersion: 1, nextRunAt: '2026-09-13T10:00:00.000Z', enabled: true })
    const input: EnqueueDueScheduleInput = {
      connection: scheduler([PROJECT_ALPHA], [PROFILE_MAIN]),
      projectId: PROJECT_ALPHA,
      scheduleId: schedule.scheduleId,
      expectedEntityVersion: 1,
      expectedNextRunAt: '2026-09-13T10:00:00.000Z'
    }
    const first = authority.enqueueDueSchedule(input)
    expect(first).toMatchObject({ trigger: 'due', state: 'queued', dueAt: '2026-09-13T10:00:00.000Z' })
    // Retry after an intervening schedule update returns the prior receipt before current-state checks.
    authority.updateSchedule({
      connection: admin(),
      projectId: PROJECT_ALPHA,
      scheduleId: schedule.scheduleId,
      expectedEntityVersion: 2,
      nextRunAt: '2026-09-13T10:05:00.000Z'
    })
    const retried = authority.enqueueDueSchedule(input)
    expect(retried.executionId).toBe(first.executionId)

    const reopened = reopen(path)
    const listed = reopened.listScheduleExecutions({ connection: admin(), projectId: PROJECT_ALPHA, scheduleId: schedule.scheduleId })
    expect(listed.executions).toHaveLength(1)
    expect(listed.executions[0].executionId).toBe(first.executionId)
  })

  it('rejects due enqueue with stale entity versions and due mismatches, and fences wrong roles before receipt lookup', () => {
    const { authority } = openAuthority()
    const schedule = authority.createSchedule({
      connection: admin(),
      projectId: PROJECT_ALPHA,
      spec: SCHEDULE_SPEC(),
      nextRunAt: '2026-09-13T10:00:00.000Z'
    })
    const valid: EnqueueDueScheduleInput = {
      connection: scheduler([PROJECT_ALPHA], [PROFILE_MAIN]),
      projectId: PROJECT_ALPHA,
      scheduleId: schedule.scheduleId,
      expectedEntityVersion: 1,
      expectedNextRunAt: '2026-09-13T10:00:00.000Z'
    }
    expect(() =>
      authority.enqueueDueSchedule({ ...valid, expectedEntityVersion: 9 })
    ).toThrowError(expect.objectContaining({ code: 'STALE_AUTHORITY' }))
    expect(() =>
      authority.enqueueDueSchedule({ ...valid, expectedNextRunAt: '2026-09-13T11:00:00.000Z' })
    ).toThrowError(expect.objectContaining({ code: 'STALE_AUTHORITY' }))
    expect(() =>
      authority.enqueueDueSchedule({ ...valid, connection: worker(OWNER_ALICE) })
    ).toThrowError(expect.objectContaining({ code: 'AUTHORIZATION_DENIED' }))
    expect(() =>
      authority.enqueueDueSchedule({ ...valid, connection: scheduler([PROJECT_BETA], [PROFILE_MAIN]) })
    ).toThrowError(expect.objectContaining({ code: 'AUTHORIZATION_DENIED' }))
    expect(() =>
      authority.enqueueDueSchedule({ ...valid, connection: scheduler([PROJECT_ALPHA], ['profile-other']) })
    ).toThrowError(expect.objectContaining({ code: 'AUTHORIZATION_DENIED' }))
  })

  it('enqueues manual executions by request id without touching next run, conflicting on changed intent', () => {
    const { authority } = openAuthority()
    const schedule = authority.createSchedule({
      connection: admin(),
      projectId: PROJECT_ALPHA,
      spec: SCHEDULE_SPEC(),
      nextRunAt: '2026-09-13T10:00:00.000Z'
    })
    const manual = authority.enqueueManualScheduleExecution({
      connection: admin(),
      projectId: PROJECT_ALPHA,
      scheduleId: schedule.scheduleId,
      expectedEntityVersion: 1,
      requestId: 'manual-req-1'
    })
    expect(manual).toMatchObject({ trigger: 'manual', state: 'queued', dueAt: null })
    const same = authority.enqueueManualScheduleExecution({
      connection: admin(),
      projectId: PROJECT_ALPHA,
      scheduleId: schedule.scheduleId,
      expectedEntityVersion: 5,
      requestId: 'manual-req-1'
    })
    expect(same.executionId).toBe(manual.executionId)
    const executions = authority.listScheduleExecutions({ connection: admin(), projectId: PROJECT_ALPHA, scheduleId: schedule.scheduleId })
    expect(executions.executions).toHaveLength(1)
  })

  it('advances daily cadences across zone offsets', () => {
    const { authority } = openAuthority()
    const daily = authority.createSchedule({
      connection: admin(),
      projectId: PROJECT_ALPHA,
      spec: {
        profileId: PROFILE_MAIN,
        taskTitle: 'daily task',
        cadence: { kind: 'daily', time: '09:30', timeZone: 'America/New_York' },
        command: { program: 'node', args: ['daily.js'] },
        target: { kind: 'local', root: '/repo', label: 'repo' },
        verification: { requiredArtifacts: [] }
      },
      nextRunAt: '2026-09-13T13:30:00.000Z'
    })
    const execution = authority.enqueueDueSchedule({
      connection: scheduler([PROJECT_ALPHA], [PROFILE_MAIN]),
      projectId: PROJECT_ALPHA,
      scheduleId: daily.scheduleId,
      expectedEntityVersion: 1,
      expectedNextRunAt: '2026-09-13T13:30:00.000Z'
    })
    expect(execution.dueAt).toBe('2026-09-13T13:30:00.000Z')
    const db = openTaskAuthorityRawConnection((authority as SqliteTaskAuthority).databasePath)
    const row = db.prepare('SELECT next_run_at FROM schedules WHERE id = ?').get(daily.scheduleId) as { next_run_at: string }
    db.close()
    // 09:30 America/New_York on 2026-09-14 (EDT, UTC-4).
    expect(row.next_run_at).toBe('2026-09-14T13:30:00.000Z')
  })

  it('duplicates, updates, and deletes schedules as narrow entity-versioned intents', () => {
    const { authority } = openAuthority()
    const schedule = authority.createSchedule({ connection: admin(), projectId: PROJECT_ALPHA, spec: SCHEDULE_SPEC(), nextRunAt: '2026-09-13T10:00:00.000Z' })
    const duplicate = authority.duplicateSchedule({ connection: admin(), projectId: PROJECT_ALPHA, scheduleId: schedule.scheduleId, expectedEntityVersion: 1 })
    expect(duplicate.scheduleId).not.toBe(schedule.scheduleId)
    expect(duplicate.enabled).toBe(false)
    const updated = authority.updateSchedule({
      connection: admin(),
      projectId: PROJECT_ALPHA,
      scheduleId: duplicate.scheduleId,
      expectedEntityVersion: 1,
      enabled: true,
      spec: SCHEDULE_SPEC(PROFILE_MAIN, 'renamed task')
    })
    expect(updated).toMatchObject({ entityVersion: 2, enabled: true, taskTitle: 'renamed task' })
    const deleted = authority.deleteSchedule({ connection: admin(), projectId: PROJECT_ALPHA, scheduleId: duplicate.scheduleId, expectedEntityVersion: 2 })
    expect(deleted.scheduleId).toBe(duplicate.scheduleId)
    expect(() =>
      authority.deleteSchedule({ connection: admin(), projectId: PROJECT_ALPHA, scheduleId: duplicate.scheduleId, expectedEntityVersion: 2 })
    ).toThrowError(expect.objectContaining({ code: 'TASK_NOT_FOUND' }))
  })
})

describe('task authority run groups and mailbox', () => {
  it('enforces profile-wide capacity across mixed-repository members', () => {
    const { authority } = openAuthority()
    const alphaTask = createTask(authority, PROJECT_ALPHA, 'G-A1')
    const alphaTwo = createTask(authority, PROJECT_ALPHA, 'G-A2')
    const betaTask = createTask(authority, PROJECT_BETA, 'G-B1')
    const group = authority.createRunGroup({
      connection: admin(),
      profileId: PROFILE_MAIN,
      name: 'mixed group',
      concurrency: 2,
      members: [
        { projectId: PROJECT_ALPHA, taskId: alphaTask.taskId },
        { projectId: PROJECT_ALPHA, taskId: alphaTwo.taskId },
        { projectId: PROJECT_BETA, taskId: betaTask.taskId }
      ]
    })
    expect(group.members).toHaveLength(3)
    claim(authority, PROJECT_ALPHA, 'G-A1')
    claim(authority, PROJECT_BETA, 'G-B1', OWNER_BOB)
    expect(() => claim(authority, PROJECT_ALPHA, 'G-A2', OWNER_CARA)).toThrowError(expect.objectContaining({ code: 'TASK_NOT_RUNNABLE' }))
    // The projection still reports the task runnable; profile capacity is enforced atomically at claim.
    const snapshot = authority.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks.find(task => task.externalTaskId === 'G-A2')
    expect(snapshot?.runnable).toBe(true)
  })

  it('retries selected failed members into a new group with lineage and idempotent receipts', () => {
    const { authority } = openAuthority()
    const one = createTask(authority, PROJECT_ALPHA, 'GR-1')
    const two = createTask(authority, PROJECT_ALPHA, 'GR-2')
    const three = createTask(authority, PROJECT_ALPHA, 'GR-3')
    const group = authority.createRunGroup({
      connection: admin(),
      profileId: PROFILE_MAIN,
      name: 'retryable',
      concurrency: 3,
      members: [
        { projectId: PROJECT_ALPHA, taskId: one.taskId },
        { projectId: PROJECT_ALPHA, taskId: two.taskId },
        { projectId: PROJECT_ALPHA, taskId: three.taskId }
      ]
    })
    const first = claim(authority, PROJECT_ALPHA, 'GR-1')
    const second = claim(authority, PROJECT_ALPHA, 'GR-2', OWNER_BOB)
    authority.write({ kind: 'fail', connection: worker(OWNER_ALICE), token: first.token, error: 'boom' })
    authority.write({ kind: 'fail', connection: worker(OWNER_BOB), token: second.token, error: 'boom' })
    const retried = authority.retryRunGroup({
      connection: admin(),
      runGroupId: group.runGroupId,
      expectedEntityVersion: 1,
      requestId: 'retry-req-1',
      ownerId: OWNER_ALICE,
      memberTaskIds: [{ projectId: PROJECT_ALPHA, taskId: one.taskId }]
    })
    expect(retried).toMatchObject({ retryOfRunGroupId: group.runGroupId, name: 'retryable (retry)' })
    expect(retried.members).toHaveLength(1)
    expect(retried.members[0].attemptId).toBe(first.attempt.attemptId)
    const duplicate = authority.retryRunGroup({
      connection: admin(),
      runGroupId: group.runGroupId,
      expectedEntityVersion: 99,
      requestId: 'retry-req-1',
      ownerId: OWNER_ALICE,
      memberTaskIds: [{ projectId: PROJECT_ALPHA, taskId: one.taskId }]
    })
    expect(duplicate.runGroupId).toBe(retried.runGroupId)
    expect(() =>
      authority.retryRunGroup({
        connection: admin(),
        runGroupId: group.runGroupId,
        expectedEntityVersion: 99,
        requestId: 'retry-req-1',
        ownerId: OWNER_BOB,
        memberTaskIds: [{ projectId: PROJECT_ALPHA, taskId: two.taskId }]
      })
    ).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }))
    expect(() =>
      authority.retryRunGroup({
        connection: admin(),
        runGroupId: group.runGroupId,
        expectedEntityVersion: 1,
        requestId: 'retry-req-2',
        ownerId: OWNER_ALICE,
        memberTaskIds: [{ projectId: PROJECT_ALPHA, taskId: three.taskId }]
      })
    ).toThrowError(expect.objectContaining({ code: 'TASK_NOT_RUNNABLE' }))
  })

  it('cancels run groups atomically, fencing claims while holding capacity', () => {
    const { authority } = openAuthority()
    const one = createTask(authority, PROJECT_ALPHA, 'GC-1')
    const group = authority.createRunGroup({
      connection: admin(),
      profileId: PROFILE_MAIN,
      name: 'cancellable',
      concurrency: 1,
      members: [{ projectId: PROJECT_ALPHA, taskId: one.taskId }]
    })
    claim(authority, PROJECT_ALPHA, 'GC-1')
    const cancelled = authority.cancelRunGroup({ connection: admin(), profileId: PROFILE_MAIN, runGroupId: group.runGroupId, expectedEntityVersion: 1 })
    expect(cancelled.state).toBe('cancelling')
    const snapshot = authority.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks[0]
    expect(snapshot).toMatchObject({ status: 'cancelling', currentAttempt: { state: 'cancelling' } })
    expect(() => claim(authority, PROJECT_ALPHA, 'GC-1', OWNER_BOB)).toThrowError(expect.objectContaining({ code: 'TASK_CANCELLED' }))
    authority.acknowledgeExit({
      projectId: PROJECT_ALPHA,
      taskId: one.taskId,
      attemptId: snapshot.currentAttempt?.attemptId as string,
      leaseId: snapshot.currentAttempt?.currentLease?.leaseId as string,
      generation: 1
    })
    const done = authority.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks[0]
    expect(done.status).toBe('cancelled')
  })

  it('appends mailbox entries and acknowledges attention', () => {
    const { authority } = openAuthority()
    const task = createTask(authority, PROJECT_ALPHA, 'MB-1')
    const entry = authority.appendMailbox({
      connection: worker(OWNER_ALICE),
      projectId: PROJECT_ALPHA,
      taskId: task.taskId,
      kind: 'attention',
      payload: { reason: 'needs review' }
    })
    expect(entry).toMatchObject({ kind: 'attention', payload: { reason: 'needs review' }, acknowledgedAt: null })
    const acknowledged = authority.acknowledgeAttention({ connection: reviewer(), projectId: PROJECT_ALPHA, taskId: task.taskId, mailboxEntryId: entry.entryId })
    expect(acknowledged.acknowledgedAt).not.toBeNull()
    const again = authority.acknowledgeAttention({ connection: reviewer(), projectId: PROJECT_ALPHA, taskId: task.taskId, mailboxEntryId: entry.entryId })
    expect(again.acknowledgedAt).toBe(acknowledged.acknowledgedAt)
  })

  it('paginates projections deterministically', () => {
    const { authority } = openAuthority()
    for (let index = 0; index < 7; index += 1) {
      createTask(authority, PROJECT_ALPHA, `PG-${index}`, `page ${index}`, { priority: index % 3 })
    }
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = authority.query({ connection: ADMIN, projectId: PROJECT_ALPHA, limit: 3, ...(cursor === undefined ? {} : { cursor }) })
      seen.push(...page.tasks.map(task => task.externalTaskId))
      cursor = page.nextCursor ?? undefined
    } while (cursor !== undefined)
    expect(seen).toHaveLength(7)
    expect(new Set(seen).size).toBe(7)
    const ordered = authority.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks.map(task => task.externalTaskId)
    expect(seen).toEqual(ordered)
    expect(() => authority.query({ connection: ADMIN, projectId: PROJECT_ALPHA, limit: 501 })).toThrowError(TaskAuthorityValidationError)
  })
})

describe('task authority review regressions', () => {
  it('closes an attempt-less todo task cancellation directly to terminal cancelled', () => {
    const { authority, path } = openAuthority()
    const task = createTask(authority, PROJECT_ALPHA, 'NC-1')
    const cancelled = authority.requestCancellation({ connection: admin(), projectId: PROJECT_ALPHA, taskId: task.taskId, expectedEntityVersion: 1 })
    expect(cancelled).toMatchObject({ status: 'cancelled', cancelState: 'none', currentAttempt: null })
    expect(() => claim(authority, PROJECT_ALPHA, 'NC-1', OWNER_BOB)).toThrowError(expect.objectContaining({ code: 'TASK_CANCELLED' }))
    expect(() =>
      authority.updateTask({ connection: admin(), projectId: PROJECT_ALPHA, taskId: task.taskId, expectedEntityVersion: cancelled.entityVersion, title: 'nope' })
    ).toThrowError(expect.objectContaining({ code: 'STALE_AUTHORITY' }))
    const reopened = reopen(path)
    expect(reopened.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks[0].status).toBe('cancelled')
  })

  it('closes a queued schedule execution cancellation directly to terminal cancelled', () => {
    const { authority } = openAuthority()
    const schedule = authority.createSchedule({
      connection: admin(),
      projectId: PROJECT_ALPHA,
      spec: SCHEDULE_SPEC(),
      nextRunAt: '2026-09-13T10:00:00.000Z'
    })
    const due: EnqueueDueScheduleInput = {
      connection: scheduler([PROJECT_ALPHA], [PROFILE_MAIN]),
      projectId: PROJECT_ALPHA,
      scheduleId: schedule.scheduleId,
      expectedEntityVersion: 1,
      expectedNextRunAt: '2026-09-13T10:00:00.000Z'
    }
    const execution = authority.enqueueDueSchedule(due)
    const cancelled = authority.cancelScheduleExecution({
      connection: admin(),
      projectId: PROJECT_ALPHA,
      scheduleId: schedule.scheduleId,
      executionId: execution.executionId,
      expectedEntityVersion: 1
    })
    expect(cancelled.state).toBe('cancelled')
    const task = authority.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks[0]
    expect(task).toMatchObject({ status: 'cancelled', currentAttempt: null })
    expect(() =>
      authority.cancelScheduleExecution({
        connection: admin(),
        projectId: PROJECT_ALPHA,
        scheduleId: schedule.scheduleId,
        executionId: execution.executionId,
        expectedEntityVersion: 2
      })
    ).toThrowError(expect.objectContaining({ code: 'STALE_AUTHORITY' }))
  })

  it('closes a queued run-group cancellation directly to terminal and permits group deletion', () => {
    const { authority, path } = openAuthority()
    const one = createTask(authority, PROJECT_ALPHA, 'NG-1')
    const two = createTask(authority, PROJECT_ALPHA, 'NG-2')
    const group = authority.createRunGroup({
      connection: admin(),
      profileId: PROFILE_MAIN,
      name: 'queued group',
      concurrency: 2,
      members: [
        { projectId: PROJECT_ALPHA, taskId: one.taskId },
        { projectId: PROJECT_ALPHA, taskId: two.taskId }
      ]
    })
    const cancelled = authority.cancelRunGroup({ connection: admin(), profileId: PROFILE_MAIN, runGroupId: group.runGroupId, expectedEntityVersion: 1 })
    expect(cancelled.state).toBe('cancelled')
    expect(cancelled.members.map(member => member.state)).toEqual(['cancelled', 'cancelled'])
    const tasks = authority.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks
    expect(tasks.map(task => task.status)).toEqual(['cancelled', 'cancelled'])
    const deleted = authority.deleteRunGroup({ connection: admin(), profileId: PROFILE_MAIN, runGroupId: group.runGroupId, expectedEntityVersion: 2 })
    expect(deleted.runGroupId).toBe(group.runGroupId)
    const reopened = reopen(path)
    expect(reopened.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks).toHaveLength(2)
  })

  it('moves a run group to terminal cancelled when its last cancelling member exit is acknowledged', () => {
    const { authority } = openAuthority()
    const one = createTask(authority, PROJECT_ALPHA, 'AG-1')
    const group = authority.createRunGroup({
      connection: admin(),
      profileId: PROFILE_MAIN,
      name: 'awaiting ack',
      concurrency: 1,
      members: [{ projectId: PROJECT_ALPHA, taskId: one.taskId }]
    })
    const claimed = claim(authority, PROJECT_ALPHA, 'AG-1')
    authority.cancelRunGroup({ connection: admin(), profileId: PROFILE_MAIN, runGroupId: group.runGroupId, expectedEntityVersion: 1 })
    authority.acknowledgeExit({
      projectId: PROJECT_ALPHA,
      taskId: one.taskId,
      attemptId: claimed.attempt.attemptId,
      leaseId: claimed.token.leaseId,
      generation: 1
    })
    const db = openTaskAuthorityRawConnection((authority as SqliteTaskAuthority).databasePath)
    const row = db.prepare('SELECT state FROM run_groups WHERE id = ?').get(group.runGroupId) as { state: string }
    db.close()
    expect(row.state).toBe('cancelled')
  })

  it('rejects unknown keys on mutation inputs', () => {
    const { authority } = openAuthority()
    createTask(authority, PROJECT_ALPHA, 'UK-1')
    expect(() =>
      authority.createTask({ connection: ADMIN, projectId: PROJECT_ALPHA, externalTaskId: 'UK-2', title: 't', priorityy: 1 } as never)
    ).toThrowError(expect.objectContaining({ name: 'TaskAuthorityValidationError' }))
    expect(() =>
      authority.claim({ connection: worker(OWNER_ALICE), projectId: PROJECT_ALPHA, externalTaskId: 'UK-1', specification: SPEC(), leaseTtlMs: 60_000, extra: true } as never)
    ).toThrowError(expect.objectContaining({ name: 'TaskAuthorityValidationError' }))
    expect(() =>
      authority.write({ kind: 'progress', connection: worker(OWNER_ALICE), token: claim(authority, PROJECT_ALPHA, 'UK-1').token, detail: 'd', note: 'x' } as never)
    ).toThrowError(expect.objectContaining({ name: 'TaskAuthorityValidationError' }))
    expect(() =>
      authority.offerHandoff({
        connection: worker(OWNER_ALICE),
        projectId: PROJECT_ALPHA,
        taskId: '00000000-0000-4000-8000-000000000000',
        attemptId: '00000000-0000-4000-8000-000000000000',
        leaseId: '00000000-0000-4000-8000-000000000000',
        generation: 1,
        targetOwnerId: OWNER_BOB,
        ttl: 60_000
      } as never)
    ).toThrowError(expect.objectContaining({ name: 'TaskAuthorityValidationError' }))
    const schedule = authority.createSchedule({ connection: admin(), projectId: PROJECT_ALPHA, spec: SCHEDULE_SPEC(), nextRunAt: '2026-09-13T10:00:00.000Z' })
    expect(() =>
      authority.enqueueDueSchedule({
        connection: scheduler([PROJECT_ALPHA], [PROFILE_MAIN]),
        projectId: PROJECT_ALPHA,
        scheduleId: schedule.scheduleId,
        expectedEntityVersion: 1,
        expectedNextRunAt: '2026-09-13T10:00:00.000Z',
        dueKey: 'sneaky'
      } as never)
    ).toThrowError(expect.objectContaining({ name: 'TaskAuthorityValidationError' }))
    expect(() =>
      authority.requestCancellation({ connection: admin(), projectId: PROJECT_ALPHA, taskId: '00000000-0000-4000-8000-000000000000', expectedEntityVersion: 1, force: true } as never)
    ).toThrowError(expect.objectContaining({ name: 'TaskAuthorityValidationError' }))
    expect(() =>
      authority.retryFailedTask({ connection: admin(), projectId: PROJECT_ALPHA, taskId: '00000000-0000-4000-8000-000000000000', expectedEntityVersion: 1, ownerId: OWNER_BOB, spec: SPEC() } as never)
    ).toThrowError(expect.objectContaining({ name: 'TaskAuthorityValidationError' }))
  })
})
