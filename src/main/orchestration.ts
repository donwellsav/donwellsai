import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  OPERATIONAL_ERROR_LIMIT,
  OPERATIONAL_OUTPUT_LIMIT,
  PARALLEL_HISTORY_LIMIT,
  parseParallelRun,
  parseParallelRunInput,
  parseParallelRunsDocument
} from '@shared/operational-runs'
import type {
  FiniteJobInspection,
  ParallelRun,
  ParallelRunInput,
  ParallelRunsDocument,
  ParallelRunStatus,
  ParallelRunTask,
  ParallelTaskStatus
} from '@shared/operational-runs'
import { OperationalRunsLoadError } from './automations'

export type ParallelLaunchRequest = {
  target: ParallelRunTask['target']
  command: string
  runId: string
  taskId: string
}

export type ParallelLaunch = (request: ParallelLaunchRequest) => Promise<string>
export type StopJob = (sessionId: string) => Promise<void>
export type InspectJob = (sessionId: string) => Promise<FiniteJobInspection>
export type ReleaseJob = (sessionId: string) => Promise<void>

function loadDocument(path: string): ParallelRunsDocument {
  if (!existsSync(path)) return { schemaVersion: 1, parallelRuns: [] }
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new OperationalRunsLoadError('corrupt', path, `invalid JSON (${detail})`)
  }
  try {
    return parseParallelRunsDocument(value)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new OperationalRunsLoadError('invalid', path, detail)
  }
}

function atomicWrite(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, OPERATIONAL_ERROR_LIMIT)
}

function boundedOutput(output: string | undefined): string | undefined {
  return output ? output.slice(-OPERATIONAL_OUTPUT_LIMIT) : undefined
}

function taskMayBeLive(status: ParallelTaskStatus): boolean {
  return status === 'launching' || status === 'running' || status === 'unverifiable' || status === 'cancelling'
}

function runMayBeLive(status: ParallelRunStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'unverifiable' || status === 'cancelling'
}

function compactRuns(runs: ParallelRun[]): ParallelRun[] {
  const sorted = [...runs].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  const live = sorted.filter((run) => runMayBeLive(run.status))
  const completed = sorted.filter((run) => !runMayBeLive(run.status))
  return [...live, ...completed.slice(0, Math.max(0, PARALLEL_HISTORY_LIMIT - live.length))]
}

/** Strict, atomic, bounded persistence for parallel operational runs. */
export class ParallelRunStore {
  readonly path: string
  private document: ParallelRunsDocument

  constructor(userDataDir: string) {
    this.path = join(userDataDir, 'orchestrations.json')
    this.document = loadDocument(this.path)
  }

  list(): ParallelRun[] {
    return this.document.parallelRuns.map((run, index) => parseParallelRun(run, `parallelRuns[${index}]`))
  }

  get(id: string): ParallelRun | null {
    const run = this.document.parallelRuns.find((candidate) => candidate.id === id)
    return run ? parseParallelRun(run) : null
  }

  upsert(value: ParallelRun): ParallelRun {
    const run = parseParallelRun(value)
    const runs = [...this.document.parallelRuns]
    const index = runs.findIndex((candidate) => candidate.id === run.id)
    if (index >= 0) runs[index] = run
    else runs.unshift(run)
    const document: ParallelRunsDocument = { ...this.document, schemaVersion: 1, parallelRuns: compactRuns(runs) }
    atomicWrite(this.path, document)
    this.document = document
    return parseParallelRun(run)
  }

  remove(id: string): void {
    const runs = this.document.parallelRuns.filter((run) => run.id !== id)
    const document: ParallelRunsDocument = { ...this.document, schemaVersion: 1, parallelRuns: runs }
    atomicWrite(this.path, document)
    this.document = document
  }
}

type SessionIndex = { runId: string; taskId: string; output: string }
type OrchestratorOptions = { now?: () => Date }

/** Bounded fan-out over daemon-owned finite jobs with restart-safe reconciliation. */
export class ParallelRunOrchestrator {
  private readonly sessionIndex = new Map<string, SessionIndex>()
  private readonly pumps = new Map<string, Promise<void>>()
  private readonly cancellations = new Map<string, Promise<ParallelRun>>()
  private readonly now: () => Date

  constructor(
    private readonly store: ParallelRunStore,
    private readonly launch: ParallelLaunch,
    private readonly stop: StopJob,
    private readonly inspect?: InspectJob,
    private readonly release?: ReleaseJob,
    options: OrchestratorOptions = {}
  ) {
    this.now = options.now ?? (() => new Date())
    for (const run of store.list()) {
      for (const task of run.tasks) {
        if (taskMayBeLive(task.status) && task.sessionId) {
          this.sessionIndex.set(task.sessionId, { runId: run.id, taskId: task.id, output: task.output ?? '' })
        }
      }
    }
  }

  list(): ParallelRun[] {
    return this.store.list()
  }

  async start(value: ParallelRunInput): Promise<ParallelRun> {
    const input = parseParallelRunInput(value)
    return this.createAndStart(input)
  }

  async retry(runId: string, taskIds: string[]): Promise<ParallelRun> {
    const source = this.store.get(runId)
    if (!source) throw new Error(`Parallel run ${runId} does not exist`)
    if (runMayBeLive(source.status)) throw new Error(`Parallel run ${runId} is not finished and cannot be retried`)
    if (taskIds.length === 0) throw new Error('Select at least one failed task to retry')
    const selected = new Set(taskIds)
    if (selected.size !== taskIds.length) throw new Error('Retry task IDs must be distinct')
    const tasks = taskIds.map((taskId) => {
      const task = source.tasks.find((candidate) => candidate.id === taskId)
      if (!task) throw new Error(`Parallel task ${taskId} does not exist in run ${runId}`)
      if (task.status !== 'failed') throw new Error(`Parallel task ${taskId} is ${task.status}, not failed`)
      return task
    })
    return this.createAndStart(
      parseParallelRunInput({
        name: `Retry · ${source.name}`,
        command: source.command,
        targets: tasks.map((task) => task.target),
        concurrency: Math.min(source.concurrency, tasks.length)
      }),
      source,
      tasks
    )
  }

  private async createAndStart(
    input: ParallelRunInput,
    source?: ParallelRun,
    sourceTasks: ParallelRunTask[] = []
  ): Promise<ParallelRun> {
    const createdAt = this.now().toISOString()
    const run: ParallelRun = {
      id: randomUUID(),
      name: input.name,
      command: input.command,
      concurrency: Math.min(input.concurrency, input.targets.length),
      status: 'queued',
      createdAt,
      retryOfRunId: source?.id,
      tasks: input.targets.map((target, index) => ({
        id: randomUUID(),
        target,
        command: input.command,
        status: 'queued',
        retryOfTaskId: sourceTasks[index]?.id
      }))
    }
    this.store.upsert(run)
    await this.pump(run.id)
    return this.store.get(run.id) ?? run
  }

  /** Reconcile retained identities without relaunching ambiguous work. */
  async resume(): Promise<void> {
    const releases: Promise<void>[] = []
    const inspections: Promise<void>[] = []
    for (const run of this.store.list()) {
      for (const task of run.tasks) {
        if (!taskMayBeLive(task.status)) {
          if (task.sessionId && this.release && (task.status === 'succeeded' || task.status === 'failed')) {
            releases.push(this.release(task.sessionId).catch(() => {}))
          }
          continue
        }
        if (!task.sessionId) {
          task.status = 'unverifiable'
          task.error = 'Launch state is unverifiable after restart; this task was not relaunched'
          continue
        }
        inspections.push(this.reconcileSession(task.sessionId))
      }
      this.store.upsert(run)
      this.refreshStatus(run.id)
    }
    await Promise.all([...releases, ...inspections])
    await Promise.all(this.store.list().filter((run) => runMayBeLive(run.status)).map((run) => this.pump(run.id)))
  }

  async pump(runId: string): Promise<void> {
    const current = this.pumps.get(runId)
    if (current) return current
    const pump = this.pumpInner(runId).finally(() => this.pumps.delete(runId))
    this.pumps.set(runId, pump)
    return pump
  }

  private async pumpInner(runId: string): Promise<void> {
    while (!this.cancellations.has(runId)) {
      const run = this.store.get(runId)
      if (!run || !runMayBeLive(run.status) || run.status === 'cancelling') return
      const activeCount = run.tasks.filter((task) => taskMayBeLive(task.status)).length
      const available = run.concurrency - activeCount
      if (available <= 0) {
        this.refreshStatus(run.id)
        return
      }
      const wave = run.tasks.filter((task) => task.status === 'queued').slice(0, available)
      if (wave.length === 0) {
        this.refreshStatus(run.id)
        return
      }
      const startedAt = this.now().toISOString()
      run.status = 'running'
      run.startedAt ??= startedAt
      for (const task of wave) {
        task.status = 'launching'
        task.startedAt = startedAt
      }
      this.store.upsert(run)
      await Promise.all(wave.map((task) => this.launchTask(run.id, task.id)))
    }
  }

  private async launchTask(runId: string, taskId: string): Promise<void> {
    const before = this.store.get(runId)
    const beforeTask = before?.tasks.find((candidate) => candidate.id === taskId)
    if (!before || !beforeTask || beforeTask.status !== 'launching') return
    let sessionId: string | undefined
    try {
      sessionId = await this.launch({
        target: beforeTask.target,
        command: beforeTask.command,
        runId,
        taskId
      })
      const run = this.store.get(runId)
      const task = run?.tasks.find((candidate) => candidate.id === taskId)
      if (!run || !task) {
        await this.stop(sessionId)
        return
      }
      task.sessionId = sessionId
      task.status = run.status === 'cancelling' || this.cancellations.has(runId) ? 'cancelling' : 'running'
      this.store.upsert(run)
      this.sessionIndex.set(sessionId, { runId, taskId, output: task.output ?? '' })
      if (task.status === 'running' && this.inspect) await this.reconcileSession(sessionId)
    } catch (error) {
      const run = this.store.get(runId)
      const task = run?.tasks.find((candidate) => candidate.id === taskId)
      if (sessionId && task?.sessionId !== sessionId) {
        this.sessionIndex.delete(sessionId)
        try {
          await this.stop(sessionId)
        } catch (stopError) {
          if (!run || !task) throw stopError
          task.sessionId = sessionId
          task.status = 'unverifiable'
          task.error = errorText(`Launch persistence failed (${errorText(error)}); stop acknowledgement failed: ${errorText(stopError)}`)
          this.store.upsert(run)
          this.sessionIndex.set(sessionId, { runId, taskId, output: task.output ?? '' })
          this.refreshStatus(runId)
          return
        }
      }
      if (!run || !task || (task.status !== 'launching' && task.status !== 'cancelling')) return
      const cancelled = run.status === 'cancelling' || this.cancellations.has(runId)
      task.status = cancelled ? 'cancelled' : 'failed'
      task.finishedAt = this.now().toISOString()
      task.error = cancelled ? undefined : errorText(error)
      this.store.upsert(run)
      this.refreshStatus(runId)
    }
  }

  async onDaemonEvent(kind: 'data' | 'exit', sessionId: string, data = '', exitCode = 0): Promise<void> {
    const index = this.sessionIndex.get(sessionId)
    if (!index) return
    if (kind === 'data') {
      index.output = (index.output + data).slice(-OPERATIONAL_OUTPUT_LIMIT)
      const run = this.store.get(index.runId)
      const task = run?.tasks.find((candidate) => candidate.id === index.taskId)
      if (run && task?.status === 'unverifiable') {
        task.status = 'running'
        task.output = boundedOutput(index.output)
        task.error = undefined
        this.store.upsert(run)
        this.refreshStatus(run.id)
      }
      return
    }
    const run = this.store.get(index.runId)
    const task = run?.tasks.find((candidate) => candidate.id === index.taskId)
    if (!task || task.status === 'cancelling') return
    let output = index.output
    if (this.inspect) {
      try { output = boundedOutput((await this.inspect(sessionId)).output) ?? output } catch {}
    }
    await this.finishTask(index.runId, index.taskId, exitCode, output)
  }

  private async reconcileSession(sessionId: string): Promise<void> {
    const index = this.sessionIndex.get(sessionId)
    if (!index || !this.inspect) return
    try {
      const result = await this.inspect(sessionId)
      const run = this.store.get(index.runId)
      const task = run?.tasks.find((candidate) => candidate.id === index.taskId)
      if (!run || !task || !taskMayBeLive(task.status)) return
      index.output = boundedOutput(result.output) ?? ''
      if (result.exited) {
        await this.finishTask(index.runId, index.taskId, result.exitCode, index.output)
      } else if (task.status !== 'cancelling') {
        task.status = 'running'
        task.output = boundedOutput(result.output)
        task.error = undefined
        this.store.upsert(run)
        this.refreshStatus(run.id)
      }
    } catch (error) {
      const run = this.store.get(index.runId)
      const task = run?.tasks.find((candidate) => candidate.id === index.taskId)
      if (!run || !task || !taskMayBeLive(task.status) || task.status === 'cancelling') return
      task.status = 'unverifiable'
      task.output = index.output || task.output
      task.error = `Daemon state is unverifiable: ${errorText(error)}`
      this.store.upsert(run)
      this.refreshStatus(run.id)
    }
  }

  private async finishTask(
    runId: string,
    taskId: string,
    exitCode: number | undefined,
    output: string | undefined
  ): Promise<void> {
    const run = this.store.get(runId)
    const task = run?.tasks.find((candidate) => candidate.id === taskId)
    if (!run || !task || !taskMayBeLive(task.status) || task.status === 'cancelling') return
    const sessionId = task.sessionId
    task.status = exitCode === 0 ? 'succeeded' : 'failed'
    task.finishedAt = this.now().toISOString()
    task.exitCode = exitCode
    task.output = boundedOutput(output)
    task.error = exitCode === 0 ? undefined : `Command exited with code ${exitCode ?? 'unknown'}`
    this.store.upsert(run)
    if (sessionId) this.sessionIndex.delete(sessionId)
    this.refreshStatus(runId)
    if (sessionId && this.release) await this.release(sessionId).catch(() => {})
    void this.pump(runId)
  }

  private refreshStatus(runId: string): ParallelRun | null {
    const run = this.store.get(runId)
    if (!run || run.status === 'cancelling') return run
    const hasUnverifiable = run.tasks.some((task) => task.status === 'unverifiable')
    const hasActive = run.tasks.some((task) => taskMayBeLive(task.status))
    const hasQueued = run.tasks.some((task) => task.status === 'queued')
    if (hasUnverifiable) run.status = 'unverifiable'
    else if (hasActive) run.status = 'running'
    else if (hasQueued) run.status = run.startedAt ? 'running' : 'queued'
    else {
      run.status = run.tasks.some((task) => task.status === 'failed')
        ? 'failed'
        : run.tasks.some((task) => task.status === 'cancelled') ? 'cancelled' : 'succeeded'
      run.finishedAt = this.now().toISOString()
    }
    return this.store.upsert(run)
  }

  async cancel(runId: string): Promise<ParallelRun> {
    const current = this.cancellations.get(runId)
    if (current) return current
    const cancellation = this.cancelInner(runId).finally(() => this.cancellations.delete(runId))
    this.cancellations.set(runId, cancellation)
    return cancellation
  }

  private async cancelInner(runId: string): Promise<ParallelRun> {
    const initial = this.store.get(runId)
    if (!initial) throw new Error(`Parallel run ${runId} does not exist`)
    if (!runMayBeLive(initial.status)) return initial
    initial.status = 'cancelling'
    for (const task of initial.tasks) {
      if (task.status === 'queued') {
        task.status = 'cancelled'
        task.finishedAt = this.now().toISOString()
      } else if (taskMayBeLive(task.status)) {
        task.status = 'cancelling'
      }
    }
    this.store.upsert(initial)

    const launching = this.pumps.get(runId)
    if (launching) await launching.catch(() => {})
    const run = this.store.get(runId)
    if (!run) throw new Error(`Parallel run ${runId} disappeared during cancellation`)
    const failures: string[] = []
    await Promise.all(run.tasks.map(async (task) => {
      if (task.status !== 'cancelling') return
      if (!task.sessionId) {
        task.status = 'unverifiable'
        task.error = 'Task has no retained daemon job identity and cannot be reported as cancelled'
        failures.push(`${task.target.label}: missing daemon job identity`)
        return
      }
      const index = this.sessionIndex.get(task.sessionId)
      let output = index?.output || task.output
      if (this.inspect) {
        try { output = boundedOutput((await this.inspect(task.sessionId)).output) ?? output } catch {}
      }
      try {
        await this.stop(task.sessionId)
        this.sessionIndex.delete(task.sessionId)
        task.status = 'cancelled'
        task.finishedAt = this.now().toISOString()
        task.output = output
        task.error = undefined
      } catch (error) {
        task.status = 'unverifiable'
        task.output = output
        task.error = `Cancellation is unverifiable: ${errorText(error)}`
        failures.push(`${task.target.label}: ${errorText(error)}`)
      }
    }))
    if (failures.length > 0) {
      run.status = 'unverifiable'
      this.store.upsert(run)
      throw new Error(`Could not verify cancellation of every task: ${failures.join('; ')}`)
    }
    run.status = 'cancelled'
    run.finishedAt = this.now().toISOString()
    return this.store.upsert(run)
  }

  remove(runId: string): void {
    const run = this.store.get(runId)
    if (!run) throw new Error(`Parallel run ${runId} does not exist`)
    if (runMayBeLive(run.status) || run.tasks.some((task) => taskMayBeLive(task.status))) {
      throw new Error(`Parallel run ${runId} has live or unverifiable tasks and cannot be deleted`)
    }
    this.store.remove(runId)
  }
}
