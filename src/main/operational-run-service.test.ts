// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { OperationalRunService } from './operational-run-service'
import type { DaemonClient } from './daemon-client'
import type { AgentSessionCredential } from '@shared/agent-runtime'
import type { RunGroupSnapshot, ScheduleExecutionSnapshot, ScheduleSnapshot, TaskSnapshot } from '@shared/task-authority'

const PROJECT = 'project-test'
const PROFILE = 'profile-test'
const SCHEDULE_ID = '11111111-1111-4111-8111-111111111111'
const EXECUTION_ID = '22222222-2222-4222-8222-222222222222'
const GROUP_ID = '33333333-3333-4333-8333-333333333333'
const TASK_ID = '44444444-4444-4444-8444-444444444444'

function schedule(version = 1): ScheduleSnapshot {
  return {
    scheduleId: SCHEDULE_ID,
    projectId: PROJECT,
    profileId: PROFILE,
    taskTitle: 'nightly check',
    cadence: { kind: 'interval', minutes: 5 },
    command: { program: 'node', args: ['check.js'], cwd: '/repo' },
    target: { kind: 'local', root: '/repo', label: 'repo' },
    verification: { requiredArtifacts: [] },
    enabled: true,
    entityVersion: version,
    nextRunAt: null,
    createdAt: '2026-09-14T00:00:00.000Z',
    updatedAt: '2026-09-14T00:00:00.000Z'
  }
}

function execution(state: ScheduleExecutionSnapshot['state'] = 'running'): ScheduleExecutionSnapshot {
  return { projectId: PROJECT, scheduleId: SCHEDULE_ID, executionId: EXECUTION_ID, trigger: 'manual', idempotencyKey: 'manual', intentSha256: 'a'.repeat(64), taskId: TASK_ID, attemptId: null, dueAt: null, state, entityVersion: 1, createdAt: '2026-09-14T00:01:00.000Z' }
}

function task(): TaskSnapshot {
  return { taskId: TASK_ID, projectId: PROJECT, externalTaskId: 'donwells:task', title: 'verify', body: '', priority: 0, status: 'todo', dependencies: [], cancelState: 'none', dependencyBlocked: false, runnable: true, entityVersion: 1, createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z', currentAttempt: null }
}

function group(): RunGroupSnapshot {
  return {
    runGroupId: GROUP_ID,
    profileId: PROFILE,
    name: 'verify',
    retryOfRunGroupId: null,
    concurrency: 1,
    state: 'active',
    entityVersion: 1,
    members: [{ projectId: PROJECT, taskId: TASK_ID, attemptId: null, ordinal: 0, state: 'queued', specification: { command: { program: 'node', args: ['check.js'], cwd: '/repo' }, target: { kind: 'local', root: '/repo', label: 'repo' }, verification: { requiredArtifacts: [] } } }],
    createdAt: '2026-09-14T00:00:00.000Z',
    updatedAt: '2026-09-14T00:00:00.000Z'
  }
}

describe('OperationalRunService daemon integration', () => {
  it('uses the current schedule entity version for save-after-update and cancels through the daemon', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'operational-runs-'))
    const workspace = join(directory, 'repo')
    mkdirSync(workspace)
    let current = schedule()
    const updateVersions: number[] = []
    const terminals = {
      taskSchedules: async () => [current],
      taskScheduleCreate: async () => current,
      taskScheduleUpdate: async (input: { expectedEntityVersion: number; spec?: { taskTitle: string } }) => {
        updateVersions.push(input.expectedEntityVersion)
        current = { ...current, entityVersion: current.entityVersion + 1, taskTitle: input.spec?.taskTitle ?? current.taskTitle }
        return current
      },
      taskScheduleExecutions: async () => ({ executions: [execution()], nextCursor: null }),
      taskScheduleExecutionCancel: async () => execution('cancelled')
    } as unknown as DaemonClient
    try {
      const service = new OperationalRunService(directory, terminals, async () => workspace, undefined, async () => PROJECT)
      await service.scheduledRunSave({ id: SCHEDULE_ID, name: 'edited once', target: { kind: 'local', root: workspace, label: 'repo' }, command: 'node check.js', schedule: { kind: 'interval', minutes: 5 }, enabled: true })
      await service.scheduledRunSave({ id: SCHEDULE_ID, name: 'edited twice', target: { kind: 'local', root: workspace, label: 'repo' }, command: 'node check.js', schedule: { kind: 'interval', minutes: 5 }, enabled: true })
      await expect(service.scheduledRunCancel(EXECUTION_ID)).resolves.toMatchObject({ id: EXECUTION_ID, status: 'cancelled' })
      expect(updateVersions).toEqual([1, 2])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('authenticates credentials before parallel admission and projects daemon members', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'operational-runs-'))
    const workspace = join(directory, 'repo')
    mkdirSync(workspace)
    const credential: AgentSessionCredential = { runId: 'run', sessionId: 'session', token: 'token' }
    let authenticated: AgentSessionCredential | undefined
    let admitted: unknown
    const terminals = {
      authenticateAgent: async (value: AgentSessionCredential) => { authenticated = value; return { id: 'agent', sessionId: value.sessionId, workspacePath: workspace, liveness: 'live' as const } },
      taskCreate: async () => task(),
      taskRunGroupCreate: async (value: unknown) => { admitted = value; return group() },
      taskRunGroups: async () => [group()]
    } as unknown as DaemonClient
    try {
      const service = new OperationalRunService(directory, terminals, async () => workspace, undefined, async () => PROJECT)
      const run = await service.parallelRunStart({ name: 'verify', command: 'node check.js', targets: [{ kind: 'local', root: workspace, label: 'repo' }], concurrency: 1 }, { credential })
      expect(authenticated).toEqual(credential)
      expect(admitted).toMatchObject({ profileId: expect.not.stringContaining(directory), members: [{ specification: { command: { program: 'node' }, target: { root: workspace } } }] })
      expect(run.tasks[0]).toMatchObject({ target: { root: '/repo' }, command: 'node check.js', status: 'queued' })
      authenticateAgent: async (value: AgentSessionCredential) => { authenticated = value; return { id: 'agent', sessionId: value.sessionId, workspacePath: workspace, liveness: 'live' as const } }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not write retired JSON run stores', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'operational-runs-'))
    const workspace = join(directory, 'repo')
    mkdirSync(workspace)
    const terminals = { taskSchedules: async () => [] } as unknown as DaemonClient
    try {
      const service = new OperationalRunService(directory, terminals, async () => workspace, undefined, async () => PROJECT)
      await expect(service.scheduledRunsList()).resolves.toEqual([])
      expect(existsSync(join(directory, 'automations.json'))).toBe(false)
      expect(existsSync(join(directory, 'automation-runs.json'))).toBe(false)
      expect(existsSync(join(directory, 'orchestrations.json'))).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
