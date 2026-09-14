import { describe, expect, it } from 'vitest'
import { PARALLEL_HISTORY_LIMIT, SCHEDULED_HISTORY_LIMIT } from '@shared/operational-runs'
import {
  compareArtifacts,
  compareRunMembers,
  projectParallelRun,
  projectParallelRunHistory,
  projectParallelRunTask,
  projectProjectTasksInspection,
  projectScheduledExecution,
  projectScheduledHistory,
  projectScheduledRunDefinition,
  PROJECTION_MAX_MEMBERS,
  ProjectionError,
  type ProjectionAttempt,
  type ProjectionRunGroup,
  type ProjectionRunMember,
  type ProjectionSchedule,
  type ProjectionScheduleExecution
} from './task-projections'
import type { TaskSnapshot } from '@shared/task-authority'

const SPECIFICATION = {
  command: { program: 'node', args: ['build.js'], cwd: '/workspace' },
  target: { kind: 'local' as const, root: '/workspace', label: 'workspace' },
  verification: { requiredArtifacts: [{ path: 'dist/out.js', relationship: 'attached-reference' as const }] },
  legacyUnknown: false
}

function attempt(overrides: Partial<ProjectionAttempt> = {}): ProjectionAttempt {
  return {
    projectId: 'project-alpha',
    taskId: 'task-1',
    attemptId: 'attempt-1',
    sequence: 1,
    state: 'completed',
    provenance: 'native',
    sessionId: 'session-1',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:05:00.000Z',
    exitCode: 0,
    error: null,
    output: 'built',
    specification: SPECIFICATION,
    artifacts: [{
      path: 'dist/out.js',
      sha256: 'a'.repeat(64),
      bytes: 12,
      attachedAt: '2026-01-01T00:04:00.000Z',
      sourceFingerprint: 'fp-1',
      relationship: 'attached-reference',
      provenance: 'native'
    }],
    ...overrides
  }
}

function member(overrides: Partial<ProjectionRunMember> = {}): ProjectionRunMember {
  const taskId = overrides.taskId ?? 'task-1'
  // Each member runs in its own checkout, so the projected target differs —
  // the renderer shape requires exactly that.
  const specification = { ...SPECIFICATION, target: { kind: 'local' as const, root: `/workspace/${taskId}`, label: taskId } }
  return {
    projectId: 'project-alpha',
    taskId,
    ordinal: 0,
    state: 'completed',
    externalTaskId: 'DW-1',
    title: 'First task',
    specification,
    attempt: attempt({ taskId, specification }),
    ...overrides
  }
}

function group(overrides: Partial<ProjectionRunGroup> = {}): ProjectionRunGroup {
  return {
    runGroupId: 'run-group-1',
    profileId: 'profile-main',
    name: 'parallel run',
    retryOfRunGroupId: null,
    concurrency: 2,
    state: 'completed',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:06:00.000Z',
    members: [member()],
    ...overrides
  }
}

const SCHEDULE: ProjectionSchedule = {
  scheduleId: 'schedule-1',
  projectId: 'project-alpha',
  profileId: 'profile-main',
  taskTitle: 'nightly',
  cadence: { kind: 'interval', minutes: 30 },
  command: SPECIFICATION.command,
  target: SPECIFICATION.target,
  verification: SPECIFICATION.verification,
  enabled: true,
  nextRunAt: '2026-01-02T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastRunAt: null,
  lastStatus: null
}

const EXECUTION: ProjectionScheduleExecution = {
  projectId: 'project-alpha',
  scheduleId: 'schedule-1',
  executionId: 'execution-1',
  trigger: 'due',
  idempotencyKey: 'execution-1',
  taskId: 'task-1',
  dueAt: '2026-01-01T00:00:00.000Z',
  state: 'succeeded',
  createdAt: '2026-01-01T00:00:00.000Z',
  attempt: attempt()
}

describe('parallel run projections', () => {
  it('renders a completed run in the legacy renderer shape', () => {
    const run = projectParallelRun(group())
    expect(run).toMatchObject({
      id: 'run-group-1',
      name: 'parallel run',
      command: 'node build.js',
      concurrency: 2,
      status: 'succeeded',
      createdAt: '2026-01-01T00:00:00.000Z'
    })
    expect(run.tasks).toEqual([expect.objectContaining({
      id: 'task-1',
      status: 'succeeded',
      sessionId: 'session-1',
      exitCode: 0,
      output: 'built',
      target: { kind: 'local', root: '/workspace/task-1', label: 'task-1' },
      command: 'node build.js',
      verificationSetup: { outputs: ['dist/out.js'], origin: { kind: 'unattributed' } }
    })])
    expect(run.finishedAt).toBe('2026-01-01T00:05:00.000Z')
  })

  it('derives run status from member states exactly as the legacy orchestrator did', () => {
    expect(projectParallelRun(group({ state: 'cancelling' })).status).toBe('cancelling')
    expect(projectParallelRun(group({ state: 'cancelled' })).status).toBe('cancelled')
    expect(projectParallelRun(group({ members: [member({ state: 'running', attempt: attempt({ state: 'running', finishedAt: null }) })] })).status).toBe('running')
    // A queued member carries its committed fan-out specification with no
    // attempt yet, so it renders with the exact target it will run in.
    const queued = member({ state: 'queued', taskId: 'queued-task', attempt: null })
    expect(projectParallelRun(group({ members: [queued] })).status).toBe('queued')
    expect(projectParallelRunTask(queued)).toMatchObject({
      id: 'queued-task',
      status: 'queued',
      command: 'node build.js',
      target: { kind: 'local', root: '/workspace/queued-task', label: 'queued-task' }
    })
    expect(projectParallelRun(group({ members: [member({ state: 'quarantined', attempt: attempt({ state: 'quarantined', finishedAt: null }) })] })).status).toBe('unverifiable')
    expect(projectParallelRun(group({ members: [member({ state: 'failed', attempt: attempt({ state: 'failed', exitCode: 1 }) })] })).status).toBe('failed')
    // A queued member beside a started sibling is a running run, not queued.
    const mixed = group({
      members: [
        member({ ordinal: 0, taskId: 'task-1', state: 'completed' }),
        member({ ordinal: 1, taskId: 'task-2', state: 'queued', attempt: null })
      ]
    })
    expect(projectParallelRun(mixed).status).toBe('running')
  })

  it('preserves retry lineage and orders members deterministically by ordinal', () => {
    const run = projectParallelRun(group({
      retryOfRunGroupId: 'run-group-0',
      members: [
        member({ ordinal: 2, taskId: 'task-c', externalTaskId: 'DW-C' }),
        member({ ordinal: 0, taskId: 'task-a', externalTaskId: 'DW-A' }),
        member({ ordinal: 1, taskId: 'task-b', externalTaskId: 'DW-B' })
      ]
    }))
    expect(run.retryOfRunId).toBe('run-group-0')
    expect(run.tasks.map(task => task.id)).toEqual(['task-a', 'task-b', 'task-c'])
    // Ordering is a pure function of the member list, not of input order.
    expect(run.tasks.map(task => task.id)).toEqual(
      [...run.tasks].map(task => task.id).sort()
    )
  })

  it('bounds the member list and the run history', () => {
    const many = group({ members: Array.from({ length: PROJECTION_MAX_MEMBERS + 25 }, (_, index) => member({ ordinal: index, taskId: `task-${String(index).padStart(3, '0')}` })) })
    expect(projectParallelRun(many).tasks).toHaveLength(PROJECTION_MAX_MEMBERS)

    const live = group({ runGroupId: 'live', state: 'active', createdAt: '2026-01-05T00:00:00.000Z', members: [member({ state: 'running', attempt: attempt({ state: 'running', finishedAt: null }) })] })
    const completed = Array.from({ length: PARALLEL_HISTORY_LIMIT + 10 }, (_, index) => group({
      runGroupId: `completed-${index}`,
      createdAt: `2026-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`
    }))
    const history = projectParallelRunHistory([...completed, live])
    expect(history.length).toBeLessThanOrEqual(PARALLEL_HISTORY_LIMIT)
    // Live runs are always retained regardless of the history bound.
    expect(history.some(run => run.id === 'live')).toBe(true)
    expect(history[0].id).toBe('live')
  })

  it('refuses to project a member with no committed specification instead of inventing a target', () => {
    expect(() => projectParallelRunTask(member({ state: 'queued', specification: null, attempt: null, title: 'Queued task', externalTaskId: 'DW-9' })))
      .toThrowError(ProjectionError)
  })

  it('refuses two members that would collapse onto one rendered target', () => {
    const shared = member({ ordinal: 0, taskId: 'task-a' })
    expect(() => projectParallelRun(group({
      members: [shared, { ...shared, ordinal: 1, taskId: 'task-b', specification: shared.specification, attempt: { ...attempt(), taskId: 'task-b', specification: shared.specification } }]
    }))).toThrowError(ProjectionError)
  })

  it('is pure: repeated projection of the same snapshot is deep-equal', () => {
    const snapshot = group()
    expect(projectParallelRun(snapshot)).toEqual(projectParallelRun(snapshot))
    expect(projectParallelRunTask(snapshot.members[0])).toEqual(projectParallelRunTask(snapshot.members[0]))
  })
})

describe('scheduled run projections', () => {
  it('renders a definition with its bounded history status', () => {
    const definition = projectScheduledRunDefinition(SCHEDULE, EXECUTION)
    expect(definition).toMatchObject({
      id: 'schedule-1',
      name: 'nightly',
      command: 'node build.js',
      schedule: { kind: 'interval', minutes: 30 },
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      nextRunAt: '2026-01-02T00:00:00.000Z',
      lastRunAt: '2026-01-01T00:00:00.000Z',
      lastStatus: 'succeeded'
    })
  })

  it('renders an execution with its session, exit code, and bounded output', () => {
    const execution = projectScheduledExecution(EXECUTION)
    expect(execution).toMatchObject({
      id: 'execution-1',
      scheduledRunId: 'schedule-1',
      trigger: 'schedule',
      status: 'succeeded',
      sessionId: 'session-1',
      exitCode: 0,
      output: 'built'
    })
    expect(projectScheduledExecution({ ...EXECUTION, trigger: 'manual' }).trigger).toBe('manual')
    expect(projectScheduledExecution({ ...EXECUTION, attempt: null })).toMatchObject({ startedAt: EXECUTION.createdAt, status: 'succeeded' })
  })

  it('orders and bounds history newest first with live executions retained', () => {
    const executions: ProjectionScheduleExecution[] = [
      { ...EXECUTION, executionId: 'old', attempt: attempt({ startedAt: '2026-01-01T00:00:00.000Z' }) },
      { ...EXECUTION, executionId: 'new', attempt: attempt({ startedAt: '2026-01-03T00:00:00.000Z' }) },
      { ...EXECUTION, executionId: 'live', state: 'running', attempt: attempt({ state: 'running', startedAt: '2026-01-02T00:00:00.000Z', finishedAt: null }) },
      ...Array.from({ length: SCHEDULED_HISTORY_LIMIT + 5 }, (_, index) => ({
        ...EXECUTION,
        executionId: `filler-${index}`,
        attempt: attempt({ startedAt: `2025-12-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z` })
      }))
    ]
    const history = projectScheduledHistory(executions)
    expect(history.length).toBeLessThanOrEqual(SCHEDULED_HISTORY_LIMIT)
    expect(history[0].id).toBe('live')
    expect(history.map(entry => entry.id)).toContain('live')
    expect(history.filter(entry => entry.id === 'live')).toHaveLength(1)
  })
})

describe('project task inspection projection', () => {
  const tasks: readonly TaskSnapshot[] = [
    { projectId: 'p', taskId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', externalTaskId: 'DW-3', title: 'third', body: '', status: 'blocked', priority: 5, dependencies: [], dependencyBlocked: false, runnable: false, cancelState: 'none', currentAttempt: null, entityVersion: 1, createdAt: '2026-01-03T00:00:00.000Z', updatedAt: '2026-01-03T00:00:00.000Z' },
    { projectId: 'p', taskId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', externalTaskId: 'DW-1', title: 'first', body: '', status: 'todo', priority: 1, dependencies: [], dependencyBlocked: false, runnable: true, cancelState: 'none', currentAttempt: null, entityVersion: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    { projectId: 'p', taskId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', externalTaskId: 'DW-4', title: 'fourth', body: '', status: 'in-progress', priority: 5, dependencies: [], dependencyBlocked: false, runnable: false, cancelState: 'none', currentAttempt: null, entityVersion: 1, createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
    { projectId: 'p', taskId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', externalTaskId: 'DW-2', title: 'second', body: '', status: 'done', priority: 5, dependencies: [], dependencyBlocked: false, runnable: false, cancelState: 'none', currentAttempt: null, entityVersion: 1, createdAt: '2026-01-01T12:00:00.000Z', updatedAt: '2026-01-01T12:00:00.000Z' }
  ]

  it('reproduces the legacy inspection shape with deterministic priority order', () => {
    const inspection = projectProjectTasksInspection('backlog.md', [], tasks)
    expect(inspection.authority).toBe('backlog.md')
    expect(inspection.tasks.map(task => task.id)).toEqual(['DW-1', 'DW-2', 'DW-4', 'DW-3'])
    expect(inspection.tasks[0]).toEqual({ id: 'DW-1', title: 'first', status: 'To Do' })
    expect(inspection.tasks[3].status).toBe('Blocked')
  })

  it('carries an optional problem without dropping the task list', () => {
    const inspection = projectProjectTasksInspection(null, [], [], 'Native board unavailable')
    expect(inspection).toEqual({ authority: null, tools: [], tasks: [], problem: 'Native board unavailable' })
  })

  it('bounds the task list', () => {
    const many = Array.from({ length: 600 }, (_, index) => ({ ...tasks[0], externalTaskId: `DW-${index}`, taskId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` }))
    expect(projectProjectTasksInspection('backlog.md', [], many).tasks).toHaveLength(500)
  })
})

describe('projection ordering helpers', () => {
  it('orders members by ordinal then project then task id', () => {
    const members = [
      member({ ordinal: 1, projectId: 'b', taskId: 'z' }),
      member({ ordinal: 1, projectId: 'a', taskId: 'z' }),
      member({ ordinal: 1, projectId: 'a', taskId: 'a' }),
      member({ ordinal: 0, projectId: 'z', taskId: 'z' })
    ]
    const ordered = [...members].sort(compareRunMembers).map(entry => `${entry.ordinal}:${entry.projectId}:${entry.taskId}`)
    expect(ordered).toEqual(['0:z:z', '1:a:a', '1:a:z', '1:b:z'])
  })

  it('orders artifacts by path then attachment time', () => {
    const artifacts = [
      { path: 'b', sha256: 'a'.repeat(64), bytes: 1, attachedAt: '2026-01-01T00:00:00.000Z', sourceFingerprint: null, relationship: 'attached-reference' as const, provenance: 'native' as const },
      { path: 'a', sha256: 'b'.repeat(64), bytes: 1, attachedAt: '2026-01-02T00:00:00.000Z', sourceFingerprint: null, relationship: 'attached-reference' as const, provenance: 'native' as const },
      { path: 'a', sha256: 'c'.repeat(64), bytes: 1, attachedAt: '2026-01-01T00:00:00.000Z', sourceFingerprint: null, relationship: 'attached-reference' as const, provenance: 'native' as const }
    ]
    expect([...artifacts].sort(compareArtifacts).map(entry => `${entry.path}:${entry.attachedAt}`)).toEqual([
      'a:2026-01-01T00:00:00.000Z',
      'a:2026-01-02T00:00:00.000Z',
      'b:2026-01-01T00:00:00.000Z'
    ])
  })
})
