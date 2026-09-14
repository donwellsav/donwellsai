import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FiniteJobInspection } from '@shared/operational-runs'
import { OperationalRunService } from './operational-run-service'
import type { DaemonClient } from './daemon-client'

/**
 * Affected-work admission for the legacy operational-run paths.
 *
 * The maintenance gate must fence work that mutates state a migration is about
 * to freeze — and it must fence it for the *whole* launch, not merely around a
 * bookkeeping call, or a cutover could proceed while a member is still
 * starting.
 */

type Job = { id: string; command: string; exited: boolean; exitCode?: number; output: string }

const directories: string[] = []

function tempDirectory(): string {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'operational-admission-')))
  directories.push(directory)
  return directory
}

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop() as string, { recursive: true, force: true })
})

/** Minimal in-memory daemon job host: open/close/jobResult only. */
function fakeTerminals(): { client: DaemonClient; jobs: Map<string, Job>; opened: string[] } {
  const jobs = new Map<string, Job>()
  const opened: string[] = []
  let counter = 0
  const client = {
    async openJob(cwd: string, command: string) {
      counter += 1
      const id = `job-${counter}`
      jobs.set(id, { id, command, exited: false, output: '' })
      opened.push(`${cwd}\u0000${command}`)
      return { id, cwd, command, cols: 100, rows: 30 }
    },
    async close(sessionId: string) {
      const job = jobs.get(sessionId)
      if (job) { job.exited = true; job.exitCode = 0 }
    },
    async jobResult(sessionId: string): Promise<FiniteJobInspection> {
      const job = jobs.get(sessionId)
      if (!job) throw new Error(`unknown job ${sessionId}`)
      return { exited: job.exited, ...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }), output: job.output }
    }
  } as unknown as DaemonClient
  return { client, jobs, opened }
}

describe('operational run affected-work admission', () => {
  it('holds the parallel admission across the workspace, evidence, and job open', async () => {
    const directory = tempDirectory()
    const { client } = fakeTerminals()
    const events: string[] = []
    // The set of admissions that are currently open. Sampling it at each step of
    // the launch proves they all happen under the admission, not merely that
    // some bookkeeping call did.
    const open = new Set<string>()
    let observedAtWorkspace: boolean | null = null
    let observedAtJobOpen: boolean | null = null

    const service = new OperationalRunService(
      directory,
      client,
      async path => {
        observedAtWorkspace = open.size > 0
        events.push('workspace')
        return path
      },
      undefined,
      async operationId => {
        open.add(operationId)
        events.push(`admit:${operationId}`)
        return operationId
      },
      async (operationId, outcome) => {
        events.push(`complete:${operationId}:${outcome}`)
        open.delete(operationId)
      }
    )

    const originalOpenJob = (client as unknown as { openJob: (cwd: string, command: string) => Promise<{ id: string }> }).openJob.bind(client)
    ;(client as unknown as { openJob: unknown }).openJob = async (cwd: string, command: string) => {
      observedAtJobOpen = open.size > 0
      return originalOpenJob(cwd, command)
    }

    const run = await service.parallelRunStart({
      name: 'admission run',
      command: 'node build.js',
      targets: [{ kind: 'local', root: '/workspace/repo', label: 'repo' }],
      concurrency: 1
    })

    // The admission was open when the workspace was resolved and when the job
    // was opened: a cutover could not have proceeded mid-launch.
    expect(observedAtWorkspace).toBe(true)
    expect(observedAtJobOpen).toBe(true)

    // Only this run's member is admitted: the scheduler's own launch path may
    // also run here, and it is filtered out by the operation prefix.
    const expected = `parallel-launch:${run.id}:${run.tasks[0].id}`
    const admitEvents = events.filter(entry => entry === `admit:${expected}`)
    expect(admitEvents.length).toBeGreaterThan(0)
    // Every admission that opened was closed, and closed after it opened.
    const completeEvents = events.filter(entry => entry === `complete:${expected}:completed`)
    expect(completeEvents).toHaveLength(admitEvents.length)
    expect(events.indexOf(completeEvents[0])).toBeGreaterThan(events.indexOf(admitEvents[0]))
    expect(open.size).toBe(0)
  })

  it('closes the parallel admission as cancelled when the daemon job open fails', async () => {
    const directory = tempDirectory()
    const { client } = fakeTerminals()
    const events: string[] = []
    const service = new OperationalRunService(
      directory,
      client,
      async path => path,
      undefined,
      async operationId => { events.push(`admit:${operationId}`); return operationId },
      async (operationId, outcome) => { events.push(`complete:${operationId}:${outcome}`) }
    )

    // The daemon refuses to open the job: the member fails *inside* the launch
    // callback, which is the branch that must close the admission cancelled.
    ;(client as unknown as { openJob: () => Promise<never> }).openJob = async () => { throw new Error('daemon refused the job') }

    const run = await service.parallelRunStart({
      name: 'failing run',
      command: 'node build.js',
      targets: [{ kind: 'local', root: '/workspace/repo', label: 'repo' }],
      concurrency: 1
    })

    const expected = `parallel-launch:${run.id}:${run.tasks[0].id}`
    expect(events.filter(entry => entry === `admit:${expected}`)).toHaveLength(1)
    expect(events.filter(entry => entry === `complete:${expected}:cancelled`)).toHaveLength(1)
    expect(events.filter(entry => entry === `complete:${expected}:completed`)).toHaveLength(0)
    expect(run.tasks[0].status).toBe('failed')
  })

  it('admits a scheduled launch with the execution-scoped operation id', async () => {
    const directory = tempDirectory()
    const { client } = fakeTerminals()
    const events: string[] = []
    const service = new OperationalRunService(
      directory,
      client,
      async path => path,
      undefined,
      async operationId => { events.push(`admit:${operationId}`); return operationId },
      async (operationId, outcome) => { events.push(`complete:${operationId}:${outcome}`) }
    )

    const definition = await service.scheduledRunSave({
      name: 'nightly',
      target: { kind: 'local', root: '/workspace/repo', label: 'repo' },
      command: 'node nightly.js',
      schedule: { kind: 'interval', minutes: 30 }
    })
    await service.scheduledRunRunNow(definition.id)

    const admitEvents = events.filter(entry => entry.startsWith('admit:'))
    expect(admitEvents).toHaveLength(1)
    expect(admitEvents[0]).toMatch(/^admit:scheduled-launch:/)
    expect(events.filter(entry => entry.startsWith('complete:'))).toHaveLength(1)
  })

  it('proceeds without a wired gate so unrelated call sites stay unfenced', async () => {
    const directory = tempDirectory()
    const { client, opened } = fakeTerminals()
    const service = new OperationalRunService(directory, client, async path => path)
    const run = await service.parallelRunStart({
      name: 'unfenced run',
      command: 'node build.js',
      targets: [{ kind: 'local', root: '/workspace/repo', label: 'repo' }],
      concurrency: 1
    })
    expect(opened).toHaveLength(1)
    expect(run.tasks).toHaveLength(1)
  })
})
