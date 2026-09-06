import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { OperationalTarget } from '../src/shared/operational-runs'
import {
  OperationalRunValidationError,
  parseParallelRunInput
} from '../src/shared/operational-runs'
import {
  OperationalRunsLoadError,
  ScheduledRunScheduler,
  ScheduledRunStore,
  nextScheduledRunAt
} from '../src/main/automations'
import {
  ParallelRunOrchestrator,
  ParallelRunStore
} from '../src/main/orchestration'

const directories: string[] = []

function tempDir(label = 'profile'): string {
  const directory = mkdtempSync(join(tmpdir(), `donwells-operational-${label}-`))
  directories.push(directory)
  return directory
}

function target(root: string): OperationalTarget {
  return { kind: 'local', root, label: basename(root) }
}
function obstructDirectory(directory: string): void {
  rmSync(directory, { recursive: true, force: true })
  writeFileSync(directory, 'blocked')
}

function restoreDirectory(directory: string): void {
  rmSync(directory, { force: true })
  mkdirSync(directory)
}

type ActualJob = {
  process: ChildProcessWithoutNullStreams
  output: string
  exited: boolean
  exitCode?: number
  settled: Promise<void>
}
const jobFixtures: ActualFiniteJobs[] = []

class ActualFiniteJobs {
  readonly launches: string[] = []
  readonly released: string[] = []
  maximumLive = 0
  onExit: ((sessionId: string, exitCode: number) => void | Promise<void>) | undefined
  private readonly jobs = new Map<string, ActualJob>()
  private readonly settlements: Promise<void>[] = []
  private readonly eventWork: Promise<void>[] = []
  private live = 0
  constructor() {
    jobFixtures.push(this)
  }

  async open(request: { target: OperationalTarget; command: string }): Promise<string> {
    if (request.target.kind !== 'local') throw new Error('fixture refuses remote execution')
    const sessionId = `fixture-job-${this.launches.length + 1}`
    const process = spawn('/bin/sh', ['-lc', request.command], {
      cwd: request.target.root,
      detached: true,
      env: { ...globalThis.process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const spawned = Promise.withResolvers<void>()
    const settled = Promise.withResolvers<void>()
    const job: ActualJob = { process, output: '', exited: false, settled: settled.promise }
    this.jobs.set(sessionId, job)
    this.launches.push(sessionId)
    this.live += 1
    this.maximumLive = Math.max(this.maximumLive, this.live)
    this.settlements.push(settled.promise)
    process.stdout.on('data', (chunk: Buffer) => { job.output += chunk.toString('utf8') })
    process.stderr.on('data', (chunk: Buffer) => { job.output += chunk.toString('utf8') })
    process.once('spawn', () => spawned.resolve())
    process.once('error', (error) => spawned.reject(error))
    process.once('close', (code) => {
      job.exited = true
      job.exitCode = code ?? -1
      this.live -= 1
      const callback = this.onExit
      if (callback) this.eventWork.push(Promise.resolve(callback(sessionId, job.exitCode)))
      settled.resolve()
    })
    await spawned.promise
    return sessionId
  }

  async inspect(sessionId: string): Promise<{ exited: boolean; exitCode?: number; output: string }> {
    const job = this.jobs.get(sessionId)
    if (!job) throw new Error(`fixture job ${sessionId} was released`)
    return { exited: job.exited, exitCode: job.exitCode, output: job.output }
  }

  async stop(sessionId: string): Promise<void> {
    const job = this.jobs.get(sessionId)
    if (!job) throw new Error(`fixture job ${sessionId} does not exist`)
    if (!job.exited) {
      if (job.process.pid === undefined) throw new Error(`fixture job ${sessionId} has no pid`)
      try {
        globalThis.process.kill(-job.process.pid, 'SIGTERM')
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error
      }
      await job.settled
    }
  }

  async release(sessionId: string): Promise<void> {
    const job = this.jobs.get(sessionId)
    if (!job) return
    if (!job.exited) throw new Error(`fixture refused to release live job ${sessionId}`)
    this.released.push(sessionId)
    this.jobs.delete(sessionId)
  }

  async drain(): Promise<void> {
    let settledCount = -1
    let eventCount = -1
    while (settledCount !== this.settlements.length || eventCount !== this.eventWork.length) {
      settledCount = this.settlements.length
      await Promise.all(this.settlements)
      eventCount = this.eventWork.length
      await Promise.all(this.eventWork)
    }
  }
  async stopAll(): Promise<void> {
    await Promise.all([...this.jobs.keys()].map((sessionId) => this.stop(sessionId).catch(() => {})))
    await this.drain()
  }
}

afterEach(async () => {
  await Promise.all(jobFixtures.splice(0).map((fixture) => fixture.stopAll()))
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('operational run validation and persistence', () => {
  it('surfaces corrupt state exactly without overwriting it', () => {
    const profile = tempDir('corrupt')
    const path = join(profile, 'automations.json')
    const corrupt = '{ definitely not json'
    writeFileSync(path, corrupt)

    expect(() => new ScheduledRunStore(profile)).toThrow(OperationalRunsLoadError)
    expect(readFileSync(path, 'utf8')).toBe(corrupt)
  })

  it('preserves unknown document and definition data across an atomic update', () => {
    const profile = tempDir('future-data')
    const path = join(profile, 'automations.json')
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      futureOwner: { value: 42 },
      scheduledRuns: [{
        id: 'daily',
        name: 'Daily check',
        target: target(profile),
        command: 'printf ok',
        schedule: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
        enabled: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        futureDefinitionField: ['kept']
      }]
    }))
    const store = new ScheduledRunStore(profile)
    const scheduler = new ScheduledRunScheduler(store, async () => 'unused', undefined, undefined, undefined, {
      now: () => new Date('2026-01-02T00:00:00.000Z')
    })

    scheduler.setEnabled('daily', false)

    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      futureOwner: { value: 42 },
      scheduledRuns: [{ futureDefinitionField: ['kept'], enabled: false }]
    })
    expect(readFileSync(path, 'utf8')).not.toContain('.tmp')
  })

  it('rejects duplicate parallel targets before any run is created', () => {
    const root = tempDir('duplicates')
    expect(() => parseParallelRunInput({
      name: 'duplicates',
      command: 'printf nope',
      concurrency: 2,
      targets: [target(root), target(root)]
    })).toThrow(OperationalRunValidationError)
  })
  it('bounds completed histories without dropping unresolved work', () => {
    const scheduledProfile = tempDir('scheduled-history-bound')
    const completedExecutions = Array.from({ length: 105 }, (_, index) => {
      const startedAt = new Date(Date.UTC(2026, 0, 1, index)).toISOString()
      return {
        id: `execution-${index}`,
        scheduledRunId: 'bounded-schedule',
        trigger: 'schedule',
        startedAt,
        finishedAt: startedAt,
        status: 'succeeded'
      }
    })
    writeFileSync(join(scheduledProfile, 'automation-runs.json'), JSON.stringify({
      schemaVersion: 1,
      executions: [
        ...completedExecutions,
        {
          id: 'unresolved-execution',
          scheduledRunId: 'bounded-schedule',
          trigger: 'schedule',
          startedAt: '2025-01-01T00:00:00.000Z',
          status: 'unverifiable',
          sessionId: 'retained-scheduled-job'
        }
      ]
    }))
    const scheduled = new ScheduledRunStore(scheduledProfile)
    scheduled.appendExecution({
      id: 'latest-execution',
      scheduledRunId: 'bounded-schedule',
      trigger: 'manual',
      startedAt: '2027-01-01T00:00:00.000Z',
      finishedAt: '2027-01-01T00:00:00.000Z',
      status: 'succeeded'
    })

    expect(scheduled.allExecutions()).toHaveLength(100)
    expect(scheduled.allExecutions().some((execution) => execution.id === 'unresolved-execution')).toBe(true)
    expect(scheduled.allExecutions().some((execution) => execution.id === 'latest-execution')).toBe(true)

    const parallelProfile = tempDir('parallel-history-bound')
    const completedRuns = Array.from({ length: 104 }, (_, index) => {
      const createdAt = new Date(Date.UTC(2026, 0, 1, index)).toISOString()
      return {
        id: `run-${index}`,
        name: `Completed ${index}`,
        command: 'printf done',
        concurrency: 1,
        status: 'succeeded',
        createdAt,
        finishedAt: createdAt,
        tasks: [{
          id: `task-${index}`,
          target: target(parallelProfile),
          command: 'printf done',
          status: 'succeeded',
          startedAt: createdAt,
          finishedAt: createdAt,
          exitCode: 0
        }]
      }
    })
    writeFileSync(join(parallelProfile, 'orchestrations.json'), JSON.stringify({
      schemaVersion: 1,
      parallelRuns: [
        ...completedRuns,
        {
          id: 'unresolved-run',
          name: 'Unresolved',
          command: 'sleep 30',
          concurrency: 1,
          status: 'unverifiable',
          createdAt: '2025-01-01T00:00:00.000Z',
          tasks: [{
            id: 'unresolved-task',
            target: target(parallelProfile),
            command: 'sleep 30',
            status: 'unverifiable',
            sessionId: 'retained-parallel-job'
          }]
        }
      ]
    }))
    const parallel = new ParallelRunStore(parallelProfile)
    parallel.upsert({
      id: 'latest-run',
      name: 'Latest',
      command: 'printf done',
      concurrency: 1,
      status: 'succeeded',
      createdAt: '2027-01-01T00:00:00.000Z',
      finishedAt: '2027-01-01T00:00:00.000Z',
      tasks: [{
        id: 'latest-task',
        target: target(parallelProfile),
        command: 'printf done',
        status: 'succeeded',
        startedAt: '2027-01-01T00:00:00.000Z',
        finishedAt: '2027-01-01T00:00:00.000Z',
        exitCode: 0
      }]
    })

    expect(parallel.list()).toHaveLength(100)
    expect(parallel.list().some((run) => run.id === 'unresolved-run')).toBe(true)
    expect(parallel.list().some((run) => run.id === 'latest-run')).toBe(true)
  })
})
describe('durable launch ownership', () => {
  it('stops a scheduled job whose daemon identity cannot be persisted', async () => {
    const profile = tempDir('scheduled-persistence-failure')
    const stopped: string[] = []
    const store = new ScheduledRunStore(profile)
    const scheduler = new ScheduledRunScheduler(
      store,
      async () => {
        obstructDirectory(profile)
        return 'scheduled-orphan'
      },
      undefined,
      undefined,
      async (sessionId) => {
        stopped.push(sessionId)
        restoreDirectory(profile)
      }
    )
    const definition = scheduler.save({
      name: 'Durable schedule',
      target: target(profile),
      command: 'printf safe',
      schedule: { kind: 'interval', minutes: 5 },
      enabled: true
    })

    const execution = await scheduler.runNow(definition.id)

    expect(stopped).toEqual(['scheduled-orphan'])
    expect(execution).toMatchObject({ status: 'failed', sessionId: undefined })
    expect(new ScheduledRunStore(profile).executionsFor(definition.id)[0]?.status).toBe('failed')
  })

  it('stops a parallel job whose daemon identity cannot be persisted', async () => {
    const profile = tempDir('parallel-persistence-failure')
    const stopped: string[] = []
    const store = new ParallelRunStore(profile)
    const orchestrator = new ParallelRunOrchestrator(
      store,
      async () => {
        obstructDirectory(profile)
        return 'parallel-orphan'
      },
      async (sessionId) => {
        stopped.push(sessionId)
        restoreDirectory(profile)
      }
    )

    const run = await orchestrator.start({
      name: 'Durable fan-out',
      command: 'printf safe',
      targets: [target(profile)],
      concurrency: 1
    })

    expect(stopped).toEqual(['parallel-orphan'])
    expect(run.status).toBe('failed')
    expect(run.tasks[0]).toMatchObject({ status: 'failed', sessionId: undefined })
    expect(new ParallelRunStore(profile).get(run.id)?.status).toBe('failed')
  })
})

describe('schedule semantics', () => {
  it('handles spring gaps, fall ambiguity, and intervals without drift', () => {
    const spring = { kind: 'daily' as const, time: '02:30', timeZone: 'America/New_York' }
    expect(nextScheduledRunAt(spring, new Date('2026-03-08T06:59:00.000Z'))).toBe('2026-03-08T07:00:00.000Z')

    const fall = { kind: 'daily' as const, time: '01:30', timeZone: 'America/New_York' }
    expect(nextScheduledRunAt(fall, new Date('2026-11-01T04:00:00.000Z'))).toBe('2026-11-01T05:30:00.000Z')
    expect(nextScheduledRunAt(fall, new Date('2026-11-01T05:30:00.000Z'))).toBe('2026-11-02T06:30:00.000Z')

    expect(nextScheduledRunAt({ kind: 'interval', minutes: 45 }, new Date('2026-05-01T00:00:00.000Z')))
      .toBe('2026-05-01T00:45:00.000Z')
  })

  it('does not shift an interval cadence when a run is started manually', async () => {
    const profile = tempDir('manual-cadence')
    let now = new Date('2026-01-01T00:00:00.000Z')
    const scheduler = new ScheduledRunScheduler(
      new ScheduledRunStore(profile),
      async () => 'manual-job',
      undefined,
      undefined,
      async () => {},
      { now: () => now }
    )
    const definition = scheduler.save({
      name: 'Stable cadence',
      target: target(profile),
      command: 'printf now',
      schedule: { kind: 'interval', minutes: 30 },
      enabled: true
    })
    expect(definition.nextRunAt).toBe('2026-01-01T00:30:00.000Z')

    now = new Date('2026-01-01T00:10:00.000Z')
    const execution = await scheduler.runNow(definition.id)

    expect(scheduler.list()[0]?.nextRunAt).toBe('2026-01-01T00:30:00.000Z')
    await scheduler.cancel(execution.id)
  })
})

describe('scheduled finite command lifecycle', () => {
  it('records real nonzero exit output and only releases after exit', async () => {
    const profile = tempDir('scheduled-failure')
    const jobs = new ActualFiniteJobs()
    const store = new ScheduledRunStore(profile)
    const scheduler = new ScheduledRunScheduler(
      store,
      (request) => jobs.open(request),
      (sessionId) => jobs.inspect(sessionId),
      (sessionId) => jobs.release(sessionId),
      (sessionId) => jobs.stop(sessionId)
    )
    jobs.onExit = (sessionId, exitCode) => scheduler.onDaemonEvent('exit', sessionId, '', exitCode)
    const definition = scheduler.save({
      name: 'Expected failure',
      target: target(profile),
      command: "printf 'failure-output'; exit 7",
      schedule: { kind: 'interval', minutes: 30 },
      enabled: false
    })

    await scheduler.runNow(definition.id)
    await jobs.drain()

    const [execution] = scheduler.history(definition.id)
    expect(execution).toMatchObject({ status: 'failed', exitCode: 7, output: 'failure-output' })
    expect(jobs.released).toHaveLength(1)
  })

  it('refuses overlap and reports cancellation only after the owned process exits', async () => {
    const profile = tempDir('scheduled-overlap')
    const jobs = new ActualFiniteJobs()
    const store = new ScheduledRunStore(profile)
    const scheduler = new ScheduledRunScheduler(
      store,
      (request) => jobs.open(request),
      (sessionId) => jobs.inspect(sessionId),
      (sessionId) => jobs.release(sessionId),
      (sessionId) => jobs.stop(sessionId)
    )
    jobs.onExit = (sessionId, exitCode) => scheduler.onDaemonEvent('exit', sessionId, '', exitCode)
    const definition = scheduler.save({
      name: 'No overlap',
      target: target(profile),
      command: 'sleep 30',
      schedule: { kind: 'interval', minutes: 1 },
      enabled: true
    })
    const execution = await scheduler.runNow(definition.id)
    scheduler.stop()
    if (!execution.sessionId) throw new Error('fixture did not retain the scheduled daemon identity')
    expect((await jobs.inspect(execution.sessionId)).exited).toBe(false)

    await expect(scheduler.runNow(definition.id)).rejects.toThrow('already has a live or unverifiable execution')
    const cancelled = await scheduler.cancel(execution.id)

    expect(cancelled.status).toBe('cancelled')
    expect(jobs.maximumLive).toBe(1)
    expect(jobs.released).toEqual([])
  })

  it('reconciles a retained live job after restart without launching a duplicate', async () => {
    const profile = tempDir('scheduled-restart')
    const jobs = new ActualFiniteJobs()
    const firstStore = new ScheduledRunStore(profile)
    const first = new ScheduledRunScheduler(
      firstStore,
      (request) => jobs.open(request),
      (sessionId) => jobs.inspect(sessionId),
      (sessionId) => jobs.release(sessionId),
      (sessionId) => jobs.stop(sessionId)
    )
    const definition = first.save({
      name: 'Restart durable',
      target: target(profile),
      command: 'sleep 30',
      schedule: { kind: 'interval', minutes: 10 },
      enabled: true
    })
    const execution = await first.runNow(definition.id)

    const restored = new ScheduledRunScheduler(
      new ScheduledRunStore(profile),
      async () => { throw new Error('retained work must not relaunch') },
      (sessionId) => jobs.inspect(sessionId),
      (sessionId) => jobs.release(sessionId),
      (sessionId) => jobs.stop(sessionId)
    )
    jobs.onExit = (sessionId, exitCode) => restored.onDaemonEvent('exit', sessionId, '', exitCode)
    await restored.resume()

    expect(jobs.launches).toHaveLength(1)
    expect(restored.history(definition.id)[0]?.status).toBe('running')
    await restored.cancel(execution.id)
    expect(restored.history(definition.id)[0]?.status).toBe('cancelled')
  })

  it('keeps an actual retained job alive when daemon inspection is temporarily unavailable', async () => {
    const profile = tempDir('scheduled-transport-loss')
    const jobs = new ActualFiniteJobs()
    const first = new ScheduledRunScheduler(
      new ScheduledRunStore(profile),
      (request) => jobs.open(request),
      (sessionId) => jobs.inspect(sessionId),
      (sessionId) => jobs.release(sessionId),
      (sessionId) => jobs.stop(sessionId)
    )
    const definition = first.save({
      name: 'Transport loss',
      target: target(profile),
      command: 'sleep 30',
      schedule: { kind: 'interval', minutes: 10 },
      enabled: true
    })
    const execution = await first.runNow(definition.id)
    if (!execution.sessionId) throw new Error('fixture did not retain the scheduled daemon identity')

    const restored = new ScheduledRunScheduler(
      new ScheduledRunStore(profile),
      async () => { throw new Error('retained work must not relaunch') },
      async () => { throw new Error('daemon transport unavailable') },
      (sessionId) => jobs.release(sessionId),
      (sessionId) => jobs.stop(sessionId)
    )
    jobs.onExit = (sessionId, exitCode) => restored.onDaemonEvent('exit', sessionId, '', exitCode)
    await restored.resume()
    expect(restored.history(definition.id)[0]?.status).toBe('unverifiable')
    expect((await jobs.inspect(execution.sessionId)).exited).toBe(false)
    expect(jobs.released).toEqual([])

    await restored.onDaemonEvent('data', execution.sessionId, 'transport-restored')
    expect(restored.history(definition.id)[0]).toMatchObject({ status: 'running', output: 'transport-restored' })
    expect(restored.list()[0]?.lastStatus).toBe('running')

    await restored.cancel(execution.id)
    expect(restored.history(definition.id)[0]?.status).toBe('cancelled')
  })
})

describe('parallel finite command lifecycle', () => {
  it('runs actual commands within the concurrency bound, retains per-target failure, and retries only the selected failure', async () => {
    const profile = tempDir('parallel')
    const roots = ['one', 'two', 'three'].map((name) => tempDir(name))
    const jobs = new ActualFiniteJobs()
    const store = new ParallelRunStore(profile)
    const orchestrator = new ParallelRunOrchestrator(
      store,
      (request) => jobs.open(request),
      (sessionId) => jobs.stop(sessionId),
      (sessionId) => jobs.inspect(sessionId),
      (sessionId) => jobs.release(sessionId)
    )
    jobs.onExit = (sessionId, exitCode) => orchestrator.onDaemonEvent('exit', sessionId, '', exitCode)
    const run = await orchestrator.start({
      name: 'Bounded real commands',
      command: "case \"$PWD\" in *two*) printf 'bad-target'; exit 9;; *) printf 'ok-target';; esac",
      targets: roots.map(target),
      concurrency: 2
    })

    await jobs.drain()
    await orchestrator.pump(run.id)
    await jobs.drain()

    const finished = store.get(run.id)
    expect(finished?.status).toBe('failed')
    expect(finished?.tasks.map((task) => task.status)).toEqual(['succeeded', 'failed', 'succeeded'])
    expect(finished?.tasks[1]).toMatchObject({ exitCode: 9, output: 'bad-target' })
    expect(jobs.maximumLive).toBeLessThanOrEqual(2)

    const failedTask = finished?.tasks[1]
    if (!failedTask) throw new Error('fixture did not retain the failed task')
    const retry = await orchestrator.retry(run.id, [failedTask.id])
    await jobs.drain()

    const retried = store.get(retry.id)
    expect(retried).toMatchObject({ status: 'failed', retryOfRunId: run.id })
    expect(retried?.tasks).toHaveLength(1)
    expect(retried?.tasks[0]?.retryOfTaskId).toBe(failedTask.id)
  })

  it('waits through a pending launch and stop acknowledgement before reporting cancellation', async () => {
    const profile = tempDir('parallel-race')
    const launch = Promise.withResolvers<string>()
    const stopStarted = Promise.withResolvers<void>()
    const stopAcknowledged = Promise.withResolvers<void>()
    const store = new ParallelRunStore(profile)
    const orchestrator = new ParallelRunOrchestrator(
      store,
      () => launch.promise,
      async () => {
        stopStarted.resolve()
        await stopAcknowledged.promise
      }
    )
    const starting = orchestrator.start({
      name: 'Cancellation race',
      command: 'sleep 30',
      targets: [target(profile)],
      concurrency: 1
    })
    const created = store.list()[0]
    if (!created) throw new Error('run was not durably created before launch')
    const cancelling = orchestrator.cancel(created.id)

    launch.resolve('late-job')
    await stopStarted.promise
    expect(store.get(created.id)?.status).toBe('cancelling')
    expect(store.get(created.id)?.tasks[0]?.status).toBe('cancelling')

    stopAcknowledged.resolve()
    await Promise.all([starting, cancelling])
    expect(store.get(created.id)?.status).toBe('cancelled')
  })

  it('keeps failed cancellation unverifiable instead of claiming success', async () => {
    const profile = tempDir('parallel-cancel-failure')
    const store = new ParallelRunStore(profile)
    store.upsert({
      id: 'run',
      name: 'Unknown stop',
      command: 'sleep 30',
      concurrency: 1,
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      tasks: [{
        id: 'task',
        target: target(profile),
        command: 'sleep 30',
        status: 'running',
        sessionId: 'retained-job'
      }]
    })
    const orchestrator = new ParallelRunOrchestrator(
      store,
      async () => { throw new Error('must not launch') },
      async () => { throw new Error('transport unavailable') }
    )

    await expect(orchestrator.cancel('run')).rejects.toThrow('Could not verify cancellation')
    expect(store.get('run')?.status).toBe('unverifiable')
    expect(store.get('run')?.tasks[0]?.status).toBe('unverifiable')
  })

  it('reconciles live work after restart, preserves the queue, and never launches a duplicate', async () => {
    const profile = tempDir('parallel-restart')
    const roots = [tempDir('restart-one'), tempDir('restart-two')]
    const jobs = new ActualFiniteJobs()
    const firstStore = new ParallelRunStore(profile)
    const first = new ParallelRunOrchestrator(
      firstStore,
      (request) => jobs.open(request),
      (sessionId) => jobs.stop(sessionId),
      (sessionId) => jobs.inspect(sessionId),
      (sessionId) => jobs.release(sessionId)
    )
    const run = await first.start({
      name: 'Restart parallel',
      command: 'sleep 30',
      targets: roots.map(target),
      concurrency: 1
    })
    expect(jobs.launches).toHaveLength(1)

    const restored = new ParallelRunOrchestrator(
      new ParallelRunStore(profile),
      (request) => jobs.open(request),
      (sessionId) => jobs.stop(sessionId),
      (sessionId) => jobs.inspect(sessionId),
      (sessionId) => jobs.release(sessionId)
    )
    jobs.onExit = (sessionId, exitCode) => restored.onDaemonEvent('exit', sessionId, '', exitCode)
    await restored.resume()

    expect(jobs.launches).toHaveLength(1)
    expect(restored.list().find((candidate) => candidate.id === run.id)?.tasks.map((task) => task.status)).toEqual(['running', 'queued'])
    await restored.cancel(run.id)
    expect(restored.list().find((candidate) => candidate.id === run.id)?.status).toBe('cancelled')
    expect(jobs.launches).toHaveLength(1)
  })
})

it('never converts a missing daemon exit code into successful verification', async () => {
  const profile=tempDir('unknown-exit')
  const scheduler=new ScheduledRunScheduler(new ScheduledRunStore(profile),async()=> 'scheduled-unknown')
  const definition=scheduler.save({name:'Unknown exit',target:target(profile),command:'true',schedule:{kind:'interval',minutes:30},enabled:false})
  await scheduler.runNow(definition.id)
  await scheduler.onDaemonEvent('exit','scheduled-unknown','output without status')
  expect(scheduler.history(definition.id)[0]).toMatchObject({status:'failed',exitCode:undefined,error:'Command exited with code unknown'})
  const parallel=new ParallelRunOrchestrator(new ParallelRunStore(profile),async()=> 'parallel-unknown',async()=>{})
  const run=await parallel.start({name:'Unknown exit',command:'true',targets:[target(profile)],concurrency:1})
  await parallel.onDaemonEvent('exit','parallel-unknown','output without status')
  expect(parallel.list().find(item=>item.id===run.id)?.tasks[0]).toMatchObject({status:'failed',exitCode:undefined,error:'Command exited with code unknown'})
})
