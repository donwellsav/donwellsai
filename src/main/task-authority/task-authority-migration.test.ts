import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RuntimeAuthorityLock } from '@shared/runtime-file-security'
import { canonicalExternalTaskId } from '@shared/task-authority'
import { parseProfileMaintenanceParticipantSet, type ProfileMaintenanceLease } from '@shared/profile-maintenance'
import { openTaskAuthorityDatabase, openTaskAuthorityRawConnection } from './schema'
import { importLegacyEntities, SqliteTaskAuthority } from './task-authority'
import { SqliteProfileMaintenanceGate } from '../profile-maintenance-gate'
import { migrationSourceSetSha256, normalizeOperationalSnapshot, readLegacyOperationalFile, TaskAuthorityMigration, TaskAuthorityMigrationError, type LegacyShadowReaders, type MigrationSourceRecord } from './task-authority-migration'
import type { BacklogMigrationReadPort } from './backlog-migration-reader'

const PROFILE = 'profile-main'
const PROJECT_ALPHA = 'project-alpha'
const PROJECT_BETA = 'project-beta'
const COORDINATOR = { connectionId: 'conn-coordinator', ownerStage: 'stage-2' as const }
const MIGRATION_OWNER = { connectionId: 'conn-coordinator', ownerStage: 'stage-2' as const }
const ADMIN = { connectionId: 'conn-admin', role: 'administrator' as const }
const SHA = (digit: string): string => digit.repeat(64)
/** Two writers on one file must arbitrate through BEGIN IMMEDIATE alone. */
const passThroughLock: RuntimeAuthorityLock = (path, callback) => callback(path)

type BacklogTaskFixture = Record<string, { title: string; status: string; body?: string; priority?: number; dependencies?: string[] }>

type Harness = {
  directory: string
  databasePath: string
  authority: SqliteTaskAuthority
  gate: SqliteProfileMaintenanceGate
  migration: TaskAuthorityMigration
  backlogTasks: Record<string, BacklogTaskFixture>
  closed: boolean
}

const harnesses: Harness[] = []

function tempDirectory(): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), 'task-migration-')))
}

/**
 * A realistic bounded fixture: two registered projects with Backlog files and
 * the three profile-global operational snapshots. The Backlog port is bound to
 * the workspace identity it is handed, exactly like the production pinned CLI.
 */
function createHarness(options: Readonly<{ tasks?: Record<string, BacklogTaskFixture>; projects?: readonly string[]; operational?: Record<string, unknown> }> = {}): Harness {
  const directory = tempDirectory()
  const users = join(directory, 'user-data')
  const projects = options.projects ?? [PROJECT_ALPHA, PROJECT_BETA]
  const backlogTasks: Record<string, BacklogTaskFixture> = options.tasks ?? {
    [PROJECT_ALPHA]: { 'DW-1': { title: 'Alpha one', status: 'todo', body: 'first' }, 'DW-2': { title: 'Alpha two', status: 'in-progress' } },
    [PROJECT_BETA]: { 'DW-1': { title: 'Beta one', status: 'done' } }
  }

  const port: BacklogMigrationReadPort = {
    run: async (identity, args) => {
      const tasks = backlogTasks[identity.projectId] ?? {}
      if (args[0] === 'task' && args[1] === 'list') {
        return { schemaVersion: 1, kind: 'task-list', tasks: Object.keys(tasks).map(id => ({ id, title: tasks[id].title, status: tasks[id].status })) }
      }
      const requested = String(args[2])
      const task = tasks[requested]
      if (task === undefined) return { schemaVersion: 1, kind: 'task-view', task: null }
      return {
        schemaVersion: 1,
        kind: 'task-view',
        task: {
          id: requested,
          title: task.title,
          body: task.body ?? '',
          status: task.status,
          priority: task.priority,
          dependencies: task.dependencies,
          path: `.backlog/tasks/${requested}.md`
        }
      }
    },
    readWorkspaceFile: async (identity, relPath) => {
      const externalTaskId = relPath.replace(/^.*\//, '').replace(/\.md$/, '')
      const task = (backlogTasks[identity.projectId] ?? {})[externalTaskId]
      // The native task file's exact bytes carry the record, so a content change
      // changes the frozen digest exactly as the real source would.
      const content = task === undefined ? `${identity.projectId} ${relPath}\n` : `${task.title}\n${task.body ?? ''}\n${task.status}\n`
      return { bytes: Buffer.from(content, 'utf8'), truncated: false, binary: false }
    }
  }

  const readers: LegacyShadowReaders = {
    parallelRuns: async () => [],
    scheduledRuns: async () => [],
    scheduledExecutions: async () => [],
    projects: async () => projects.map(projectId => ({ projectId, repositoryId: `repo-${projectId}`, workspaceRoot: `/workspace/${projectId}` })),
    projectTaskSummaries: async () => ({})
  }

  mkdirSync(users, { recursive: true, mode: 0o700 })
  // Every profile-global snapshot exists on this fixture profile, matching a
  // profile whose legacy writers have all run at least once.
  const operational = {
    'orchestrations.json': { schemaVersion: 1, parallelRuns: [] },
    'automations.json': { schemaVersion: 1, scheduledRuns: [] },
    'automation-runs.json': { schemaVersion: 1, executions: [] },
    ...(options.operational ?? {})
  }
  for (const [name, document] of Object.entries(operational)) {
    writeFileSync(join(users, name), JSON.stringify(document), { mode: 0o600 })
  }

  const database = openTaskAuthorityDatabase({ databasePath: join(directory, 'task-authority.sqlite'), authorityLock: passThroughLock })
  const authority = new SqliteTaskAuthority(database)
  const harness: Harness = {
    directory,
    databasePath: join(directory, 'task-authority.sqlite'),
    authority,
    gate: new SqliteProfileMaintenanceGate({ database, profileId: PROFILE }),
    migration: new TaskAuthorityMigration({ authority, database, profileId: PROFILE, userDataDirectory: users, readers, backlog: port }),
    backlogTasks,
    closed: false
  }
  harnesses.push(harness)
  return harness
}

afterEach(() => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop() as Harness
    if (!harness.closed) {
      try { harness.authority.close() } catch { /* already closed */ }
    }
    rmSync(harness.directory, { recursive: true, force: true })
  }
})

function rowCounts(harness: Harness): Record<string, number> {
  const db = openTaskAuthorityRawConnection(harness.databasePath)
  try {
    const tables = ['tasks', 'attempts', 'schedules', 'schedule_executions', 'run_groups', 'run_members', 'execution_specifications', 'verification_artifacts', 'migration_sources', 'migration_entity_mappings', 'task_events']
    const counts: Record<string, number> = {}
    for (const table of tables) counts[table] = Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as Record<string, number>)['count'])
    return counts
  } finally {
    db.close()
  }
}

function rawScalar(harness: Harness, sql: string, ...params: Array<string | number>): unknown {
  const db = openTaskAuthorityRawConnection(harness.databasePath)
  try {
    const row = db.prepare(sql).get(...params) as Record<string, unknown> | undefined
    if (row === undefined) return undefined
    return Object.values(row)[0]
  } finally {
    db.close()
  }
}

/** Acquire + freeze + drain the maintenance lease, which the cutover path requires. */
async function acquireLease(harness: Harness): Promise<ProfileMaintenanceLease> {
  const lease = await harness.gate.acquire(COORDINATOR, {
    migrationId: 'migration-1',
    ownerStage: 'stage-2',
    participants: parseProfileMaintenanceParticipantSet(['task-authority']),
    expectedRevision: 1
  })
  await harness.gate.freeze(COORDINATOR, lease)
  await harness.gate.acknowledgeDrained({ connectionId: 'conn-task-authority', participant: 'task-authority' }, lease.migrationId)
  return lease
}

/** Freeze, drain, and enter the gate's cutover phase, which the fence path requires. */
async function enterCutover(harness: Harness, lease: ProfileMaintenanceLease): Promise<void> {
  await harness.gate.beginCutover(COORDINATOR, lease)
}

async function activated(harness: Harness, repositories: readonly string[] = [PROJECT_ALPHA, PROJECT_BETA]): Promise<ProfileMaintenanceLease> {
  await harness.migration.prepare()
  await harness.migration.shadow()
  const lease = await acquireLease(harness)
  await enterCutover(harness, lease)
  const sourceSet = await harness.migration.rehashFrozenSources()
  harness.migration.cutover(sourceSet)
  for (const receipt of harness.migration.publishOperationalFences(lease.migrationId)) {
    await harness.gate.recordRetirementFence(MIGRATION_OWNER, lease, {
      participant: 'task-authority',
      retiredPath: receipt.retiredPath,
      fenceReceiptSha256: receipt.fenceReceiptSha256,
      fsynced: receipt.fsynced
    })
  }
  harness.migration.activate(repositories)
  return lease
}

describe('task authority migration source reading', () => {
  it('fails closed on symlinked, non-private, and oversized legacy sources without touching them', () => {
    const harness = createHarness()
    const users = join(harness.directory, 'user-data')
    const sourcePath = join(users, 'orchestrations.json')

    writeFileSync(sourcePath, '{"schemaVersion":1,"parallelRuns":[]}', { mode: 0o644 })
    chmodSync(sourcePath, 0o644)
    expect(() => readLegacyOperationalFile(users, 'orchestrations')).toThrowError(expect.objectContaining({ code: 'MIGRATION_SOURCE_UNSAFE' }))
    expect(statSync(sourcePath).mode & 0o777).toBe(0o644)

    chmodSync(sourcePath, 0o600)
    expect(() => readLegacyOperationalFile(users, 'orchestrations')).not.toThrow()

    writeFileSync(sourcePath, 'x'.repeat(9 * 1024 * 1024), { mode: 0o600 })
    expect(() => readLegacyOperationalFile(users, 'orchestrations')).toThrowError(expect.objectContaining({ code: 'MIGRATION_SOURCE_OVERSIZED' }))
    expect(readFileSync(sourcePath).length).toBe(9 * 1024 * 1024)
  })

  it('rejects a symlinked snapshot rather than following it', () => {
    const harness = createHarness()
    const users = join(harness.directory, 'user-data')
    const real = join(harness.directory, 'real.json')
    writeFileSync(real, '{"schemaVersion":1,"parallelRuns":[]}', { mode: 0o600 })
    const link = join(users, 'orchestrations.json')
    rmSync(link, { force: true })
    symlinkSync(real, link)
    expect(() => readLegacyOperationalFile(users, 'orchestrations')).toThrowError(expect.objectContaining({ code: 'MIGRATION_SOURCE_UNSAFE' }))
  })

  it('reports a corrupt snapshot instead of repairing it', () => {
    const harness = createHarness({ operational: { 'automations.json': { schemaVersion: 1, scheduledRuns: [{ id: 'broken' }] } } })
    return expect(harness.migration.prepare()).rejects.toMatchObject({ code: 'MIGRATION_SOURCE_CORRUPT' })
  })

  it('treats a missing operational snapshot as the empty legacy document', () => {
    const directory = tempDirectory()
    try {
      const file = readLegacyOperationalFile(directory, 'automations')
      expect(JSON.parse(file.text)).toEqual({ schemaVersion: 1, scheduledRuns: [] })
      expect(file.bytes).toBe(Buffer.byteLength(file.text, 'utf8'))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('digests the source set deterministically across enumeration order', () => {
    const sources: MigrationSourceRecord[] = [
      { sourceKind: 'backlog', canonicalSourcePath: '/b', sourceSha256: SHA('b'), bytes: 2 },
      { sourceKind: 'automations', canonicalSourcePath: '/a', sourceSha256: SHA('a'), bytes: 1 }
    ]
    expect(migrationSourceSetSha256(sources)).toBe(migrationSourceSetSha256([...sources].reverse()))
    expect(migrationSourceSetSha256([...sources, { sourceKind: 'x', canonicalSourcePath: '/a', sourceSha256: SHA('a'), bytes: 2 }]))
      .not.toBe(migrationSourceSetSha256(sources))
  })
})

describe('task authority migration normalization', () => {
  it('imports in-progress Backlog state as explicit blocked, never a live claim', async () => {
    const harness = createHarness()
    await harness.migration.prepare()
    const tasks = harness.authority.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks
    const blocked = tasks.find(task => task.externalTaskId === 'DW-2')
    expect(blocked).toMatchObject({ status: 'blocked', currentAttempt: null, runnable: false })
    expect(() => harness.authority.claim({
      connection: { connectionId: 'w', role: 'worker', ownerId: '11111111-1111-4111-8111-111111111111', authorizedProjectIds: [PROJECT_ALPHA] },
      projectId: PROJECT_ALPHA,
      externalTaskId: 'DW-2',
      specification: { command: { program: 'node', args: [] }, target: { kind: 'local', root: '/workspace', label: 'w' }, verification: { requiredArtifacts: [] } }
    })).toThrowError(expect.objectContaining({ code: 'TASK_NOT_RUNNABLE' }))
  })

  it('records one profile source record per profile-global file and exact project scopes for Backlog', async () => {
    const harness = createHarness()
    await harness.migration.prepare()
    const sources = harness.migration.status().sources
    const profileSources = sources.filter(source => source.sourceKind !== 'backlog')
    expect(profileSources.map(source => source.sourceKind).sort()).toEqual(['automation-runs', 'automations', 'orchestrations'])
    // Each profile-global snapshot is recorded exactly once, never per project.
    expect(new Set(profileSources.map(source => source.canonicalSourcePath)).size).toBe(3)
    const backlogSources = sources.filter(source => source.sourceKind === 'backlog')
    expect(new Set(backlogSources.map(source => source.canonicalSourcePath.startsWith(`/workspace/${PROJECT_ALPHA}/`) ? PROJECT_ALPHA : PROJECT_BETA)))
      .toEqual(new Set([PROJECT_ALPHA, PROJECT_BETA]))
    const db = openTaskAuthorityRawConnection(harness.databasePath)
    try {
      const rows = db.prepare("SELECT scope_kind, scope_id FROM migration_sources WHERE source_kind = 'automations'").all() as Array<Record<string, string>>
      expect(rows).toEqual([{ scope_kind: 'profile', scope_id: PROFILE }])
    } finally {
      db.close()
    }
  })

  it('is resumable: a second prepare returns the prior committed mapping with no duplicate rows', async () => {
    const harness = createHarness()
    const first = await harness.migration.prepare()
    const counts = rowCounts(harness)
    const second = await harness.migration.prepare()
    expect(second.entities).toEqual(first.entities)
    expect(second.sourceSetSha256).toBe(first.sourceSetSha256)
    expect(rowCounts(harness)).toEqual(counts)
    expect(second.supersededSourceIds).toEqual([])
    expect(second.sourceSetSha256).toBe(migrationSourceSetSha256(harness.migration.status().sources))
  })

  it('creates a successor source record plus one rebuild on a changed frozen source', async () => {
    const harness = createHarness()
    const first = await harness.migration.prepare()
    const sourceCountBefore = harness.migration.status().sources.length

    harness.backlogTasks[PROJECT_ALPHA] = { 'DW-1': { title: 'Alpha one renamed', status: 'todo' } }
    const rebuilt = await harness.migration.prepare()
    expect(rebuilt.sourceSetSha256).not.toBe(first.sourceSetSha256)
    // The changed file produced one successor record, and the removed task's
    // file vanished with it, so two prior snapshots are superseded.
    expect(rebuilt.supersededSourceIds).toHaveLength(2)

    const tasks = harness.authority.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks
    expect(tasks.find(task => task.externalTaskId === 'DW-1')?.title).toBe('Alpha one renamed')
    // The removed record's mapping is no longer active.
    expect(rawScalar(harness, "SELECT COUNT(*) FROM migration_entity_mappings WHERE entity_kind = 'task' AND source_entity_key = 'DW-2' AND state = 'active'")).toBe(0)
    // One successor source record replaced the changed file; the vanished file
    // was retired without a successor.
    expect(harness.migration.status().sources).toHaveLength(sourceCountBefore - 1)
    expect(rawScalar(harness, "SELECT COUNT(*) FROM migration_sources WHERE supersedes_source_id IS NOT NULL")).toBe(1)
    expect(rawScalar(harness, "SELECT COUNT(*) FROM migration_sources WHERE phase = 'superseded'")).toBe(2)
  })

  it('keeps specification and materialized-task mappings reachable across replay and a successor rebuild', async () => {
    // A parallel run plus a historical schedule execution: both produce
    // imported attempt/specification pairs and a materialized execution task.
    const harness = createHarness({
      operational: {
        'orchestrations.json': {
          schemaVersion: 1,
          parallelRuns: [{
            id: 'run-map', name: 'mapped run', command: 'node build.js', concurrency: 1, status: 'succeeded', createdAt: '2026-01-01T00:00:00.000Z',
            tasks: [{ id: 'task-map', target: { kind: 'local', root: '/workspace/repo', label: 'repo' }, command: 'node build.js', status: 'succeeded', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z', exitCode: 0 }]
          }]
        },
        'automations.json': {
          schemaVersion: 1,
          scheduledRuns: [{
            id: 'sched-map', name: 'mapped nightly', target: { kind: 'local', root: '/workspace/repo', label: 'repo' },
            command: 'node nightly.js', schedule: { kind: 'interval', minutes: 30 }, enabled: true,
            createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z'
          }]
        },
        'automation-runs.json': {
          schemaVersion: 1,
          executions: [{ id: 'exec-map', scheduledRunId: 'sched-map', trigger: 'schedule', startedAt: '2026-01-01T00:00:00.000Z', status: 'succeeded' }]
        }
      }
    })

    const first = await harness.migration.prepare()
    // Both specification flavours are mapped, and their IDs are the live rows.
    expect(Object.keys(first.entities).some(key => key.startsWith('specification:'))).toBe(true)
    for (const [key, authorityEntityId] of Object.entries(first.entities)) {
      if (!key.startsWith('specification:')) continue
      expect(rawScalar(harness, 'SELECT provenance_kind FROM execution_specifications WHERE id = ?', authorityEntityId)).toBeDefined()
    }
    const activeByKind = (): Record<string, number> => {
      const db = openTaskAuthorityRawConnection(harness.databasePath)
      try {
        const rows = db.prepare("SELECT entity_kind, COUNT(*) AS count FROM migration_entity_mappings WHERE state = 'active' GROUP BY entity_kind ORDER BY entity_kind").all() as Array<Record<string, unknown>>
        return Object.fromEntries(rows.map(row => [String(row['entity_kind']), Number(row['count'])]))
      } finally {
        db.close()
      }
    }
    const firstActive = activeByKind()
    expect(firstActive['specification']).toBeGreaterThan(0)

    // Replay: identical entity map (including specification keys) and identical
    // active mapping counts — nothing was left unreachable.
    const replay = await harness.migration.prepare()
    expect(replay.entities).toEqual(first.entities)
    expect(activeByKind()).toEqual(firstActive)

    // Successor rebuild: the changed source re-registers the same mappings, so
    // every live specification still resolves from an active mapping row.
    harness.backlogTasks[PROJECT_ALPHA] = { 'DW-1': { title: 'Alpha one renamed', status: 'todo' } }
    const successor = await harness.migration.prepare()
    const firstKeys = Object.keys(first.entities).sort()
    const successorKeys = Object.keys(successor.entities).sort()
    // The successor drops exactly the entities the vanished source carried
    // (`DW-2`), and every other key — each `specification:` key included — is
    // unchanged.
    expect(firstKeys.filter(key => !successorKeys.includes(key))).toEqual(['task:DW-2'])
    expect(successorKeys).toEqual(firstKeys.filter(key => key !== 'task:DW-2'))
    const successorActive = activeByKind()
    expect(successorActive['specification']).toBe(firstActive['specification'])
    for (const [key, authorityEntityId] of Object.entries(successor.entities)) {
      if (!key.startsWith('specification:')) continue
      expect({ key, rows: Number(rawScalar(harness, "SELECT COUNT(*) FROM migration_entity_mappings WHERE authority_entity_id = ? AND state = 'active'", authorityEntityId)) })
        .toEqual({ key, rows: 1 })
    }
  })

  it('keeps every imported entity mapping in the same transaction as its entity', async () => {
    const harness = createHarness()
    const { entities } = await harness.migration.prepare()
    const db = openTaskAuthorityRawConnection(harness.databasePath)
    try {
      const mappings = db.prepare('SELECT entity_kind, source_entity_key, authority_entity_id FROM migration_entity_mappings').all() as Array<Record<string, string>>
      expect(Object.keys(entities).length).toBeGreaterThan(0)
      for (const [key, authorityEntityId] of Object.entries(entities)) {
        const separator = key.indexOf(':')
        const entityKind = key.slice(0, separator)
        const sourceEntityKey = key.slice(separator + 1).slice(0, 128)
        expect(mappings.some(mapping => mapping['entity_kind'] === entityKind
          && mapping['source_entity_key'] === sourceEntityKey
          && mapping['authority_entity_id'] === authorityEntityId)).toBe(true)
      }
    } finally {
      db.close()
    }
  })

  it('normalizes operational snapshots without retroactively binding the current schedule definition', () => {
    const executions = normalizeOperationalSnapshot('automation-runs', {
      schemaVersion: 1,
      executions: [{ id: 'exec-1', scheduledRunId: 'sched-1', trigger: 'schedule', startedAt: '2026-01-01T00:00:00.000Z', status: 'succeeded' }]
    }, PROFILE)
    expect(executions).toMatchObject({ scopeKind: 'profile', scopeId: PROFILE })
    expect(executions.scheduleExecutions?.[0]).toMatchObject({ executionKey: 'exec-1', scheduleKey: 'sched-1', trigger: 'due', idempotencyKey: 'exec-1' })

    const schedules = normalizeOperationalSnapshot('automations', {
      schemaVersion: 1,
      scheduledRuns: [{
        id: 'sched-1', name: 'nightly', target: { kind: 'local', root: '/workspace/repo', label: 'repo' },
        command: 'node nightly.js', schedule: { kind: 'interval', minutes: 30 }, enabled: true,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z'
      }]
    }, PROFILE)
    expect(schedules.schedules?.[0]).toMatchObject({ scheduleKey: 'sched-1', projectId: '/workspace/repo', cadence: { kind: 'interval', minutes: 30 }, enabled: true })
  })

  it('imports parallel-run history as provenance-marked lease-less legacy-unknown attempts', async () => {
    const harness = createHarness({
      operational: {
        'orchestrations.json': {
          schemaVersion: 1,
          parallelRuns: [{
            id: 'run-1', name: 'parallel run', command: 'node build.js', concurrency: 1, status: 'succeeded', createdAt: '2026-01-01T00:00:00.000Z',
            tasks: [{
              id: 'task-1', target: { kind: 'local', root: '/workspace', label: 'w' }, command: 'node build.js', status: 'succeeded',
              sessionId: 'session-1', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z', exitCode: 0, output: 'ok'
            }]
          }]
        }
      }
    })
    await harness.migration.prepare()
    expect(rawScalar(harness, "SELECT COUNT(*) FROM attempts WHERE provenance_kind = 'imported-legacy' AND current_lease_id IS NULL AND state = 'completed'")).toBe(1)
    expect(rawScalar(harness, "SELECT COUNT(*) FROM execution_specifications WHERE provenance_kind = 'legacy-unknown'")).toBeGreaterThan(0)
    expect(rawScalar(harness, 'SELECT COUNT(*) FROM run_groups')).toBe(1)
    expect(rawScalar(harness, 'SELECT COUNT(*) FROM run_members')).toBe(1)
    // Imported history is ineligible for native completion: no live attempt exists.
    expect(rawScalar(harness, "SELECT COUNT(*) FROM attempts WHERE provenance_kind = 'native'")).toBe(0)
  })

  it('never writes a native-provenance specification for an imported attempt', async () => {
    // A source that *does* carry the execution-time definition still imports as
    // imported-legacy provenance: an imported attempt can never own a native
    // specification, which would otherwise let it pass a native-only check and
    // be orphaned by an abort that filters on imported provenance.
    const harness = createHarness()
    const receipt = importLegacyEntities(harness.authority.database, {
      scopeKind: 'project',
      scopeId: PROJECT_ALPHA,
      tasks: [{ externalTaskId: 'DW-SPEC', title: 'spec task', body: '', status: 'done', priority: 0, dependencies: [] }],
      attempts: [{
        attemptKey: 'spec-attempt',
        taskExternalTaskId: 'DW-SPEC',
        state: 'completed',
        // Explicitly not legacy-unknown: the source carries the definition.
        specificationLegacyUnknown: false,
        specification: { command: { program: 'node', args: ['build.js'] }, target: { kind: 'local', root: '/workspace/repo', label: 'repo' }, verification: { requiredArtifacts: [] } },
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:01:00.000Z'
      }]
    })
    const specificationId = receipt['specification:spec-attempt']
    expect(specificationId).toBeDefined()
    expect(rawScalar(harness, 'SELECT provenance_kind FROM execution_specifications WHERE id = ?', specificationId))
      .toBe('imported-legacy')
    expect(rawScalar(harness, 'SELECT provenance_kind FROM attempts WHERE id = ?', receipt['attempt:spec-attempt']))
      .toBe('imported-legacy')
    // No imported row anywhere claims native provenance.
    expect(Number(rawScalar(harness, "SELECT COUNT(*) FROM execution_specifications WHERE provenance_kind = 'native'"))).toBe(0)

    // Abort still clears every imported row, including this specification.
    harness.migration.abort()
    expect(Number(rawScalar(harness, 'SELECT COUNT(*) FROM execution_specifications'))).toBe(0)
    expect(Number(rawScalar(harness, 'SELECT COUNT(*) FROM attempts'))).toBe(0)
  })

  it('never infers task linkage for generic Attention Inbox or EventStore rows', async () => {
    const harness = createHarness()
    await harness.migration.prepare()
    expect(rawScalar(harness, 'SELECT COUNT(*) FROM task_mailbox')).toBe(0)
    expect(rawScalar(harness, "SELECT COUNT(*) FROM task_events WHERE event_type NOT IN ('legacy-task-imported','legacy-attempt-imported','legacy-schedule-imported','legacy-execution-imported')")).toBe(0)
  })

  it('keeps two projects sharing one external task id without collision', async () => {
    const harness = createHarness()
    await harness.migration.prepare()
    const alpha = harness.authority.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks.find(task => task.externalTaskId === 'DW-1')
    const beta = harness.authority.query({ connection: ADMIN, projectId: PROJECT_BETA }).tasks.find(task => task.externalTaskId === 'DW-1')
    expect(alpha?.taskId).toBeDefined()
    expect(beta?.taskId).toBeDefined()
    expect(alpha?.taskId).not.toBe(beta?.taskId)
    expect(canonicalExternalTaskId(alpha?.externalTaskId as string)).toBe('dw-1')
  })
})

describe('task authority migration shadow comparison', () => {
  it('reports a clean comparison when authority matches the live legacy readers', async () => {
    const harness = createHarness()
    await harness.migration.prepare()
    const report = await harness.migration.shadow()
    expect(report.clean).toBe(true)
    expect(report.compared).toBe(0)
    expect(harness.migration.status().state).toBe('shadow')
  })

  it('reports differences with source path and field and never repairs them', async () => {
    const harness = createHarness()
    await harness.migration.prepare()
    const divergent = new SqliteTaskAuthority(openTaskAuthorityDatabase({ databasePath: harness.databasePath, authorityLock: passThroughLock }))
    try {
      const task = harness.authority.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks.find(candidate => candidate.externalTaskId === 'DW-1')
      if (!task) throw new Error('expected the imported task')
      divergent.updateTask({ connection: ADMIN, projectId: PROJECT_ALPHA, taskId: task.taskId, expectedEntityVersion: task.entityVersion, title: 'Authority retitled' })
    } finally {
      divergent.close()
    }
    const migration = new TaskAuthorityMigration({
      authority: harness.authority,
      database: openTaskAuthorityDatabase({ databasePath: harness.databasePath, authorityLock: passThroughLock }),
      profileId: PROFILE,
      userDataDirectory: join(harness.directory, 'user-data'),
      readers: {
        parallelRuns: async () => [],
        scheduledRuns: async () => [{
          id: 'sched-1', name: 'nightly', target: { kind: 'local', root: '/workspace/repo', label: 'repo' },
          command: 'node nightly.js', schedule: { kind: 'interval', minutes: 30 }, enabled: true,
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z'
        }],
        scheduledExecutions: async () => [],
        projects: async () => [],
        projectTaskSummaries: async () => ({ [PROJECT_ALPHA]: [{ id: 'DW-1', title: 'Legacy title', status: 'todo' }] })
      },
      backlog: { run: async () => ({ schemaVersion: 1, kind: 'task-list', tasks: [] }), readWorkspaceFile: async () => ({ bytes: Buffer.from(''), truncated: false, binary: false }) }
    })
    const report = await migration.shadow()
    expect(report.clean).toBe(false)
    expect(report.differences).toContainEqual(expect.objectContaining({ sourcePath: PROJECT_ALPHA, field: 'task:DW-1.title', authorityValue: 'Authority retitled', legacyValue: 'Legacy title' }))
    expect(report.differences).toContainEqual(expect.objectContaining({ field: 'schedule:sched-1' }))
    // Nothing was repaired: the authority still carries its own value.
    const tasks = harness.authority.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks
    expect(tasks.find(candidate => candidate.externalTaskId === 'DW-1')?.title).toBe('Authority retitled')
  })

  it('re-hashes under the lease and invalidates the snapshot when a source changed', async () => {
    const harness = createHarness()
    await harness.migration.prepare()
    await harness.migration.shadow()
    await acquireLease(harness)
    await expect(harness.migration.rehashFrozenSources()).resolves.toBeDefined()

    harness.backlogTasks[PROJECT_ALPHA] = { 'DW-1': { title: 'changed after freeze', status: 'todo' } }
    await expect(harness.migration.rehashFrozenSources()).rejects.toMatchObject({ code: 'MIGRATION_SOURCE_CHANGED' })
    // Any change returns to explicit import; the stale snapshot is never trusted.
    expect(harness.migration.status().state).toBe('preparing')
  })
})

describe('task authority migration cutover and activation', () => {
  it('publishes preserved backups and fsynced fences, then activates and exports read-only', async () => {
    const harness = createHarness()
    await harness.migration.prepare()
    await harness.migration.shadow()
    const lease = await acquireLease(harness)
    await enterCutover(harness, lease)
    const sourceSet = await harness.migration.rehashFrozenSources()
    harness.migration.cutover(sourceSet)

    const receipts = harness.migration.publishOperationalFences(lease.migrationId)
    expect(receipts).toHaveLength(3)
    const fenceDirectory = join(harness.directory, 'user-data', 'task-authority-migration')
    for (const receipt of receipts) {
      expect(receipt.fsynced).toBe(true)
      // The original legacy file is preserved, never deleted or overwritten.
      expect(existsSync(receipt.retiredPath)).toBe(true)
      expect(existsSync(join(fenceDirectory, `${receipt.retiredPath.split('/').pop() as string}.retired`))).toBe(true)
      expect(existsSync(join(fenceDirectory, `${receipt.retiredPath.split('/').pop() as string}.fence`))).toBe(true)
      await harness.gate.recordRetirementFence(MIGRATION_OWNER, lease, {
        participant: 'task-authority',
        retiredPath: receipt.retiredPath,
        fenceReceiptSha256: receipt.fenceReceiptSha256,
        fsynced: receipt.fsynced
      })
    }
    expect(await harness.gate.listRetirementFences({ migrationId: lease.migrationId })).toHaveLength(3)
    // Publishing a fence makes rollback irreversible.
    expect(harness.gate.readState().irreversible).toBe(true)

    harness.migration.activate([PROJECT_ALPHA, PROJECT_BETA])
    expect(harness.migration.status().state).toBe('active')
    expect(harness.migration.status().exportedRepositories).toEqual([PROJECT_ALPHA, PROJECT_BETA])

    const exported = harness.migration.exportBacklog(PROJECT_ALPHA)
    const content = readFileSync(exported.path, 'utf8')
    expect(content).toContain('generated: do not edit')
    expect(content).toContain('authority event sequence')
    expect(content).toContain('DW-1')
    expect(content).toContain(harness.migration.status().sourceSetSha256 as string)
    expect(createHash('sha256').update(readFileSync(exported.path)).digest('hex')).toBe(exported.sha256)
    expect(exported.tasks).toBeGreaterThan(0)
  })

  it('makes the migration-only Backlog reader unreachable after activation', async () => {
    const harness = createHarness()
    await activated(harness)
    expect(() => harness.migration.readBacklogSnapshot({ projectId: PROJECT_ALPHA, repositoryId: 'repo', workspaceRoot: '/workspace' }))
      .toThrowError(expect.objectContaining({ code: 'MIGRATION_STATE_INVALID' }))
    // The generated export still works and never writes into the repository.
    const exported = harness.migration.exportBacklog(PROJECT_BETA)
    expect(exported.path).toContain(`task-authority-projections/${PROJECT_BETA}/`)
    expect(statSync(exported.path).mode & 0o777).toBe(0o600)
    expect(existsSync(join(`/workspace/${PROJECT_BETA}`, 'backlog-export.md'))).toBe(false)
  })

  it('records a durable failed state that blocks further import until resolved', async () => {
    const harness = createHarness()
    await harness.migration.prepare()
    harness.migration.fail('SIMULATED_CRASH')
    expect(harness.migration.status().state).toBe('failed')
    await expect(harness.migration.prepare()).rejects.toMatchObject({ code: 'MIGRATION_STATE_INVALID' })
    await expect(harness.migration.shadow()).rejects.toMatchObject({ code: 'MIGRATION_STATE_INVALID' })
  })

  it('aborts to legacy writers and discards candidate-only rows without touching native rows', async () => {
    const harness = createHarness()
    await harness.migration.prepare()
    const native = harness.authority.createTask({ connection: ADMIN, projectId: PROJECT_BETA, externalTaskId: 'NATIVE-1', title: 'native task' })
    expect(Number(rawScalar(harness, 'SELECT COUNT(*) FROM tasks'))).toBeGreaterThan(1)

    harness.migration.abort()
    expect(harness.migration.status()).toMatchObject({ state: 'legacy', sourceSetSha256: null })
    const remaining = harness.authority.query({ connection: ADMIN }).tasks
    expect(remaining.map(task => task.taskId)).toEqual([native.taskId])
    expect(rawScalar(harness, 'SELECT COUNT(*) FROM migration_sources')).toBe(0)
    expect(rawScalar(harness, "SELECT COUNT(*) FROM tasks WHERE provenance_kind = 'imported-legacy'")).toBe(0)
    expect(rawScalar(harness, 'SELECT COUNT(*) FROM attempts')).toBe(0)
    expect(rawScalar(harness, 'SELECT COUNT(*) FROM run_groups')).toBe(0)
    expect(rawScalar(harness, 'SELECT COUNT(*) FROM task_dependencies')).toBe(0)
  })

  it('aborts to legacy through every foreign-key child, including legacy-unknown specifications', async () => {
    // This fixture produces both provenance values: an imported task (with a
    // specification) and a historical schedule execution whose specification is
    // `legacy-unknown`. Abort must clear both without violating a foreign key.
    const harness = createHarness({
      operational: {
        'automations.json': {
          schemaVersion: 1,
          scheduledRuns: [{
            id: 'sched-1', name: 'nightly', target: { kind: 'local', root: '/workspace/repo', label: 'repo' },
            command: 'node nightly.js', schedule: { kind: 'interval', minutes: 30 }, enabled: true,
            createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z'
          }]
        },
        'automation-runs.json': {
          schemaVersion: 1,
          executions: [{ id: 'exec-1', scheduledRunId: 'sched-1', trigger: 'schedule', startedAt: '2026-01-01T00:00:00.000Z', status: 'succeeded' }]
        },
        'orchestrations.json': {
          schemaVersion: 1,
          parallelRuns: [{
            id: 'run-1', name: 'parallel run', command: 'node build.js', concurrency: 1, status: 'succeeded', createdAt: '2026-01-01T00:00:00.000Z',
            tasks: [{ id: 'task-1', target: { kind: 'local', root: '/workspace/repo', label: 'repo' }, command: 'node build.js', status: 'succeeded', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z', exitCode: 0 }]
          }]
        }
      }
    })
    await harness.migration.prepare()
    const native = harness.authority.createTask({ connection: ADMIN, projectId: PROJECT_BETA, externalTaskId: 'NATIVE-ABORT', title: 'native task' })
    expect(Number(rawScalar(harness, "SELECT COUNT(*) FROM execution_specifications WHERE provenance_kind = 'legacy-unknown'"))).toBeGreaterThan(0)
    expect(Number(rawScalar(harness, "SELECT COUNT(*) FROM schedule_executions"))).toBeGreaterThan(0)
    // The import writes profile events; they are residue abort must clear.
    expect(Number(rawScalar(harness, "SELECT COUNT(*) FROM authority_profile_events WHERE event_type = 'legacy-schedule-imported'"))).toBeGreaterThan(0)
    // An unrelated profile event must survive: abort never clears by type alone.
    const unrelated = harness.authority.createSchedule({
      connection: ADMIN, projectId: PROJECT_BETA,
      spec: { profileId: PROFILE, taskTitle: 'unrelated', cadence: { kind: 'interval', minutes: 5 }, command: { program: 'node', args: [] }, target: { kind: 'local', root: '/workspace/unrelated', label: 'u' }, verification: { requiredArtifacts: [] } }
    })
    expect(unrelated.scheduleId).toBeDefined()

    harness.migration.abort()

    // The abort committed: the state is legacy, not a rolled-back failure.
    expect(harness.migration.status()).toMatchObject({ state: 'legacy', sourceSetSha256: null })
    expect(rawScalar(harness, "SELECT reason FROM task_authority_migration_failure WHERE reason = 'ABORTED'")).toBe('ABORTED')
    // Zero imported rows of either provenance survive...
    expect(rawScalar(harness, "SELECT COUNT(*) FROM tasks WHERE provenance_kind = 'imported-legacy'")).toBe(0)
    expect(rawScalar(harness, "SELECT COUNT(*) FROM execution_specifications WHERE provenance_kind IN ('imported-legacy','legacy-unknown')")).toBe(0)
    // ...and zero orphan children remain in any table that referenced them.
    for (const [table, clause] of [
      ['attempts', "provenance_kind = 'imported-legacy'"],
      ['run_members', "task_id NOT IN (SELECT id FROM tasks)"],
      ['schedule_executions', "task_id NOT IN (SELECT id FROM tasks)"],
      ['run_groups', "id NOT IN (SELECT DISTINCT run_group_id FROM run_members)"],
      // The imported schedule is gone; the one unrelated native schedule is the
      // only row that may remain, and it is asserted separately below.
      ['schedules', "id <> (SELECT authority_entity_id FROM migration_entity_mappings WHERE entity_kind = 'schedule') OR id IS NULL"],
      ['task_dependencies', '1 = 1'],
      ['verification_artifacts', "provenance_kind = 'imported-legacy'"],
      ['artifact_adoptions', '1 = 1'],
      ['migration_sources', '1 = 1'],
      ['migration_entity_mappings', '1 = 1'],
      ['authority_profile_events', "event_type = 'legacy-schedule-imported'"],
      // The imported schedule task's own event is residue too.
      ['task_events', "event_type = 'legacy-execution-imported'"]
    ] as const) {
      expect({ table, count: Number(rawScalar(harness, `SELECT COUNT(*) FROM ${table} WHERE ${clause}`)) }).toEqual({ table, count: 0 })
    }
    // The unrelated profile event survives: residue clearing is entity-scoped.
    expect(Number(rawScalar(harness, "SELECT COUNT(*) FROM authority_profile_events WHERE event_type = 'schedule-created'"))).toBe(1)
    // A same-type event that names no imported entity also survives, so the
    // residue delete cannot clear by event type alone.
    harness.authority.database.withImmediate(db => {
      db.prepare("INSERT INTO authority_profile_events(event_id, profile_id, run_group_id, event_type, entity_version, payload_json, created_at) VALUES (?,?,NULL,'legacy-schedule-imported',1,'{\"scheduleId\":\"not-an-imported-schedule\"}',?)")
        .run('unrelated-legacy-type-event', PROFILE, new Date().toISOString())
    })
    harness.migration.abort()
    expect(Number(rawScalar(harness, "SELECT COUNT(*) FROM authority_profile_events WHERE event_id = 'unrelated-legacy-type-event'"))).toBe(1)
    // Exactly the unrelated native schedule remains, and it is intact.
    expect(Number(rawScalar(harness, 'SELECT COUNT(*) FROM schedules'))).toBe(1)
    expect(harness.authority.readSchedule(PROJECT_BETA, unrelated.scheduleId)).toMatchObject({ taskTitle: 'unrelated' })
    // The native row is untouched and still addressable.
    expect(harness.authority.query({ connection: ADMIN }).tasks.map(task => task.taskId)).toEqual([native.taskId])
  })

  it('refuses to abort an active authority even if a caller invokes it directly', async () => {
    const harness = createHarness()
    await activated(harness)
    expect(harness.migration.status().state).toBe('active')
    const before = rowCounts(harness)
    // An operator abort reaches the gate, not this path, but a future
    // post-activation caller must not be able to full-table sweep the live
    // authority: the migration state forbids it.
    expect(() => harness.migration.abort('migration-late')).toThrowError(expect.objectContaining({ code: 'MIGRATION_STATE_INVALID' }))
    expect(harness.migration.status().state).toBe('active')
    expect(rowCounts(harness)).toEqual(before)
  })

  it('scopes the generated export to the requested project only', async () => {
    const harness = createHarness()
    await activated(harness)
    const alpha = harness.migration.exportBacklog(PROJECT_ALPHA)
    const content = readFileSync(alpha.path, 'utf8')
    // Alpha's own tasks are present; Beta's identical external id is not.
    expect(content).toContain('DW-1')
    expect(content).toContain('DW-2')
    expect(content).toContain(`scope: project ${PROJECT_ALPHA} only`)
    expect(content).not.toContain('Beta one')
    expect(alpha.tasks).toBe(2)

    const beta = harness.migration.exportBacklog(PROJECT_BETA)
    expect(readFileSync(beta.path, 'utf8')).toContain('Beta one')
    expect(beta.tasks).toBe(1)
    // The two exports are genuinely different projections.
    expect(beta.sha256).not.toBe(alpha.sha256)
  })

  it('reopens and resumes after an interruption without duplicating rows', async () => {
    const harness = createHarness()
    await harness.migration.prepare()
    await harness.migration.shadow()
    const counts = rowCounts(harness)
    const before = harness.migration.status()
    harness.authority.close()
    harness.closed = true

    const database = openTaskAuthorityDatabase({ databasePath: harness.databasePath, authorityLock: passThroughLock })
    const reopened = new SqliteTaskAuthority(database)
    try {
      const migration = new TaskAuthorityMigration({
        authority: reopened,
        database,
        profileId: PROFILE,
        userDataDirectory: join(harness.directory, 'user-data'),
        readers: { ...emptyReaders(), projects: async () => [] },
        backlog: { run: async () => ({ schemaVersion: 1, kind: 'task-list', tasks: [] }), readWorkspaceFile: async () => ({ bytes: Buffer.from(''), truncated: false, binary: false }) }
      })
      // The durable phase survives the restart.
      expect(migration.status().state).toBe('shadow')
      expect(migration.status().sources).toHaveLength(before.sources.length)
      expect(migration.status().sourceSetSha256).toBe(before.sourceSetSha256)
      await migration.prepare()
      expect(rowCounts(harness)['tasks']).toBe(counts['tasks'])
    } finally {
      reopened.close()
    }
  })

  it('refuses to overwrite a native task and never mutates native rows during a rebuild', async () => {
    const harness = createHarness()
    await harness.migration.prepare()
    const imported = harness.authority.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks.find(task => task.externalTaskId === 'DW-1')
    if (!imported) throw new Error('expected the imported task')
    const db = openTaskAuthorityRawConnection(harness.databasePath)
    try {
      db.prepare("UPDATE tasks SET provenance_kind = 'native', title = 'native title' WHERE project_id = ? AND id = ?").run(PROJECT_ALPHA, imported.taskId)
    } finally {
      db.close()
    }
    harness.backlogTasks[PROJECT_ALPHA] = { 'DW-1': { title: 'rebuilt', status: 'todo' } }
    await expect(harness.migration.prepare()).rejects.toMatchObject({ code: 'MIGRATION_REQUIRED' })
    const row = harness.authority.query({ connection: ADMIN, projectId: PROJECT_ALPHA }).tasks.find(task => task.externalTaskId === 'DW-1')
    expect(row?.title).toBe('native title')
  })
})

function emptyReaders(): LegacyShadowReaders {
  return {
    parallelRuns: async () => [],
    scheduledRuns: async () => [],
    scheduledExecutions: async () => [],
    projects: async () => [],
    projectTaskSummaries: async () => ({})
  }
}

describe('task authority migration error surface', () => {
  it('exposes typed codes for invalid state transitions', async () => {
    const harness = createHarness()
    expect(() => harness.migration.cutover({ sources: [], sha256: SHA('0') })).toThrowError(TaskAuthorityMigrationError)
    await expect(harness.migration.shadow()).rejects.toMatchObject({ code: 'MIGRATION_STATE_INVALID' })
    expect(() => harness.migration.exportBacklog(PROJECT_ALPHA)).toThrowError(expect.objectContaining({ code: 'MIGRATION_STATE_INVALID' }))
    expect(() => harness.migration.activate([PROJECT_ALPHA])).toThrowError(expect.objectContaining({ code: 'MIGRATION_STATE_INVALID' }))
  })
})

describe('task authority migration fixture scoping', () => {
  it('binds repository and workspace identity into the recorded source path', async () => {
    const harness = createHarness()
    await harness.migration.prepare()
    const backlogSources = harness.migration.status().sources.filter(source => source.sourceKind === 'backlog')
    expect(backlogSources.every(source => source.canonicalSourcePath.startsWith('/workspace/'))).toBe(true)
    expect(backlogSources.every(source => source.sourceSha256.length === 64)).toBe(true)
  })
})
