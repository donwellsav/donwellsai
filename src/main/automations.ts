import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  OPERATIONAL_ERROR_LIMIT,
  OPERATIONAL_OUTPUT_LIMIT,
  SCHEDULED_HISTORY_LIMIT,
  OperationalRunValidationError,
  parseScheduledExecution,
  parseScheduledExecutionsDocument,
  parseScheduledRunDefinition,
  parseScheduledRunInput,
  parseScheduledRunPatch,
  parseScheduledRunsDocument
} from '@shared/operational-runs'
import type {
  FiniteJobInspection,
  ScheduledExecution,
  ScheduledExecutionStatus,
  ScheduledExecutionsDocument,
  ScheduledRunDefinition,
  ScheduledRunInput,
  ScheduledRunPatch,
  ScheduledRunsDocument
} from '@shared/operational-runs'

export type ScheduledLaunchRequest = {
  target: ScheduledRunDefinition['target']
  command: string
  executionId: string
}

export type ScheduledLaunch = (request: ScheduledLaunchRequest) => Promise<string>
export type InspectJob = (sessionId: string) => Promise<FiniteJobInspection>
export type ReleaseJob = (sessionId: string) => Promise<void>
export type StopJob = (sessionId: string) => Promise<void>

export class OperationalRunsLoadError extends Error {
  constructor(
    readonly kind: 'corrupt' | 'invalid',
    readonly path: string,
    detail: string
  ) {
    super(`Cannot load operational runs from ${path}: ${detail}`)
    this.name = 'OperationalRunsLoadError'
  }
}

function loadDocument<T>(path: string, empty: T, parse: (value: unknown) => T): T {
  if (!existsSync(path)) return empty
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new OperationalRunsLoadError('corrupt', path, `invalid JSON (${detail})`)
  }
  try {
    return parse(value)
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

function boundedOutput(output: string | undefined): string | undefined {
  return output ? output.slice(-OPERATIONAL_OUTPUT_LIMIT) : undefined
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, OPERATIONAL_ERROR_LIMIT)
}

function isLiveExecution(status: ScheduledExecutionStatus): boolean {
  return status === 'running' || status === 'cancelling' || status === 'unverifiable'
}

function compactExecutions(executions: ScheduledExecution[]): ScheduledExecution[] {
  const byDefinition = new Map<string, ScheduledExecution[]>()
  for (const execution of executions) {
    const current = byDefinition.get(execution.scheduledRunId)
    if (current) current.push(execution)
    else byDefinition.set(execution.scheduledRunId, [execution])
  }
  const kept: ScheduledExecution[] = []
  for (const current of byDefinition.values()) {
    current.sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    const live = current.filter((execution) => isLiveExecution(execution.status))
    const completed = current.filter((execution) => !isLiveExecution(execution.status))
    kept.push(...live, ...completed.slice(0, Math.max(0, SCHEDULED_HISTORY_LIMIT - live.length)))
  }
  return kept.sort((left, right) => right.startedAt.localeCompare(left.startedAt))
}

/** Strict, atomic persistence for scheduled definitions and their bounded histories. */
export class ScheduledRunStore {
  readonly definitionsPath: string
  readonly executionsPath: string
  private definitionsDocument: ScheduledRunsDocument
  private executionsDocument: ScheduledExecutionsDocument

  constructor(userDataDir: string) {
    this.definitionsPath = join(userDataDir, 'automations.json')
    this.executionsPath = join(userDataDir, 'automation-runs.json')
    this.definitionsDocument = loadDocument(
      this.definitionsPath,
      { schemaVersion: 1, scheduledRuns: [] },
      parseScheduledRunsDocument
    )
    this.executionsDocument = loadDocument(
      this.executionsPath,
      { schemaVersion: 1, executions: [] },
      parseScheduledExecutionsDocument
    )
  }

  list(): ScheduledRunDefinition[] {
    return this.definitionsDocument.scheduledRuns.map((definition, index) =>
      parseScheduledRunDefinition(definition, `scheduledRuns[${index}]`)
    )
  }

  get(id: string): ScheduledRunDefinition | null {
    const definition = this.definitionsDocument.scheduledRuns.find((candidate) => candidate.id === id)
    return definition ? parseScheduledRunDefinition(definition) : null
  }

  upsert(value: ScheduledRunDefinition): ScheduledRunDefinition {
    const definition = parseScheduledRunDefinition(value)
    const definitions = [...this.definitionsDocument.scheduledRuns]
    const index = definitions.findIndex((candidate) => candidate.id === definition.id)
    if (index >= 0) definitions[index] = definition
    else definitions.unshift(definition)
    const document: ScheduledRunsDocument = { ...this.definitionsDocument, schemaVersion: 1, scheduledRuns: definitions }
    atomicWrite(this.definitionsPath, document)
    this.definitionsDocument = document
    return parseScheduledRunDefinition(definition)
  }

  remove(id: string): void {
    const definitions = this.definitionsDocument.scheduledRuns.filter((definition) => definition.id !== id)
    const executions = this.executionsDocument.executions.filter((execution) => execution.scheduledRunId !== id)
    const executionsDocument: ScheduledExecutionsDocument = { ...this.executionsDocument, schemaVersion: 1, executions }
    atomicWrite(this.executionsPath, executionsDocument)
    this.executionsDocument = executionsDocument
    const definitionsDocument: ScheduledRunsDocument = { ...this.definitionsDocument, schemaVersion: 1, scheduledRuns: definitions }
    atomicWrite(this.definitionsPath, definitionsDocument)
    this.definitionsDocument = definitionsDocument
  }

  allExecutions(): ScheduledExecution[] {
    return this.executionsDocument.executions.map((execution, index) =>
      parseScheduledExecution(execution, `executions[${index}]`)
    )
  }

  executionsFor(scheduledRunId: string, limit = SCHEDULED_HISTORY_LIMIT): ScheduledExecution[] {
    const boundedLimit = Math.max(1, Math.min(SCHEDULED_HISTORY_LIMIT, Math.floor(limit)))
    return this.allExecutions()
      .filter((execution) => execution.scheduledRunId === scheduledRunId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .slice(0, boundedLimit)
  }

  appendExecution(value: ScheduledExecution): ScheduledExecution {
    const execution = parseScheduledExecution(value)
    const executions = compactExecutions([
      ...this.executionsDocument.executions.filter((candidate) => candidate.id !== execution.id),
      execution
    ])
    const document: ScheduledExecutionsDocument = { ...this.executionsDocument, schemaVersion: 1, executions }
    atomicWrite(this.executionsPath, document)
    this.executionsDocument = document
    return parseScheduledExecution(execution)
  }

  updateExecution(value: ScheduledExecution): ScheduledExecution {
    const execution = parseScheduledExecution(value)
    const index = this.executionsDocument.executions.findIndex((candidate) => candidate.id === execution.id)
    if (index < 0) throw new Error(`Scheduled execution ${execution.id} does not exist`)
    const executions = [...this.executionsDocument.executions]
    executions[index] = execution
    const document: ScheduledExecutionsDocument = {
      ...this.executionsDocument,
      schemaVersion: 1,
      executions: compactExecutions(executions)
    }
    atomicWrite(this.executionsPath, document)
    this.executionsDocument = document
    return parseScheduledExecution(execution)
  }
}

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number }
const zoneFormatters = new Map<string, Intl.DateTimeFormat>()

function zonedParts(at: Date, zone: string): ZonedParts {
  let formatter = zoneFormatters.get(zone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    })
    zoneFormatters.set(zone, formatter)
  }
  const values: Partial<ZonedParts> = {}
  for (const part of formatter.formatToParts(at)) {
    if (part.type === 'year' || part.type === 'month' || part.type === 'day' || part.type === 'hour' || part.type === 'minute') {
      values[part.type] = Number(part.value)
    }
  }
  if (values.year === undefined || values.month === undefined || values.day === undefined || values.hour === undefined || values.minute === undefined) {
    throw new Error(`Could not resolve wall-clock time in ${zone}`)
  }
  return values as ZonedParts
}

function nextCalendarDate(parts: Pick<ZonedParts, 'year' | 'month' | 'day'>): Pick<ZonedParts, 'year' | 'month' | 'day'> {
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1))
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() }
}

function dailyInstant(
  date: Pick<ZonedParts, 'year' | 'month' | 'day'>,
  wantedMinutes: number,
  zone: string
): Date | null {
  const approximateMidnight = Date.UTC(date.year, date.month - 1, date.day)
  const start = approximateMidnight - 18 * 60 * 60_000
  const end = approximateMidnight + 42 * 60 * 60_000
  let firstAfterGap: Date | null = null
  for (let instant = start; instant <= end; instant += 60_000) {
    const candidate = new Date(instant)
    const wall = zonedParts(candidate, zone)
    if (wall.year !== date.year || wall.month !== date.month || wall.day !== date.day) continue
    const wallMinutes = wall.hour * 60 + wall.minute
    if (wallMinutes === wantedMinutes) return candidate
    if (wallMinutes > wantedMinutes && !firstAfterGap) firstAfterGap = candidate
  }
  return firstAfterGap
}

/** Next strict-future fire instant. Daily schedules follow one wall-clock fire per local calendar day. */
export function nextScheduledRunAt(schedule: ScheduledRunDefinition['schedule'], from: Date): string {
  if (!Number.isFinite(from.getTime())) throw new OperationalRunValidationError('from', 'must be a valid date')
  if (schedule.kind === 'interval') return new Date(from.getTime() + schedule.minutes * 60_000).toISOString()

  const [hoursText, minutesText] = schedule.time.split(':')
  const wantedMinutes = Number(hoursText) * 60 + Number(minutesText)
  const current = zonedParts(from, schedule.timeZone)
  let date: Pick<ZonedParts, 'year' | 'month' | 'day'> = current
  if (current.hour * 60 + current.minute >= wantedMinutes) date = nextCalendarDate(current)
  for (let attempts = 0; attempts < 3; attempts += 1) {
    const candidate = dailyInstant(date, wantedMinutes, schedule.timeZone)
    if (candidate && candidate.getTime() > from.getTime()) return candidate.toISOString()
    date = nextCalendarDate(date)
  }
  throw new Error(`Could not resolve the next ${schedule.time} run in ${schedule.timeZone}`)
}

type ActiveScheduledExecution = {
  executionId: string
  scheduledRunId: string
  output: string
}

type SchedulerOptions = {
  now?: () => Date
  pollMilliseconds?: number
  maxConcurrent?: number
}

/** Bounded scheduler over daemon-owned finite jobs. Stopping it never stops those jobs. */
export class ScheduledRunScheduler {
  private timer: NodeJS.Timeout | null = null
  private readonly activeBySession = new Map<string, ActiveScheduledExecution>()
  private readonly launchingByDefinition = new Map<string, Promise<ScheduledExecution>>()
  private readonly launchingByExecution = new Map<string, Promise<ScheduledExecution>>()
  private readonly cancelling = new Set<string>()
  private readonly now: () => Date
  private readonly pollMilliseconds: number
  private readonly maxConcurrent: number

  constructor(
    private readonly store: ScheduledRunStore,
    private readonly launch: ScheduledLaunch,
    private readonly inspect?: InspectJob,
    private readonly release?: ReleaseJob,
    private readonly stopJob?: StopJob,
    options: SchedulerOptions = {}
  ) {
    this.now = options.now ?? (() => new Date())
    this.pollMilliseconds = Math.max(1_000, options.pollMilliseconds ?? 15_000)
    this.maxConcurrent = Math.max(1, Math.min(16, Math.floor(options.maxConcurrent ?? 4)))
    for (const execution of store.allExecutions()) {
      if (isLiveExecution(execution.status) && execution.sessionId) {
        this.activeBySession.set(execution.sessionId, {
          executionId: execution.id,
          scheduledRunId: execution.scheduledRunId,
          output: execution.output ?? ''
        })
      }
    }
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), this.pollMilliseconds)
  }

  /** Stops polling only. Daemon-owned finite jobs deliberately survive app quit. */
  stop(): void {
    clearInterval(this.timer ?? undefined)
    this.timer = null
  }

  list(): ScheduledRunDefinition[] {
    return this.store.list()
  }

  history(id: string): ScheduledExecution[] {
    return this.store.executionsFor(id)
  }

  save(value: ScheduledRunInput): ScheduledRunDefinition {
    const input = parseScheduledRunInput(value)
    const now = this.now()
    const existing = input.id ? this.store.get(input.id) : null
    if (input.id && !existing) throw new Error(`Scheduled run ${input.id} does not exist`)
    const enabled = input.enabled ?? existing?.enabled ?? true
    const definition: ScheduledRunDefinition = {
      ...(existing ?? {}),
      id: existing?.id ?? input.id ?? randomUUID(),
      name: input.name,
      target: input.target,
      command: input.command,
      schedule: input.schedule,
      enabled,
      createdAt: existing?.createdAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
      nextRunAt: enabled ? nextScheduledRunAt(input.schedule, now) : undefined,
      lastRunAt: existing?.lastRunAt,
      lastStatus: existing?.lastStatus
    }
    return this.store.upsert(definition)
  }

  update(id: string, value: ScheduledRunPatch): ScheduledRunDefinition {
    const existing = this.store.get(id)
    if (!existing) throw new Error(`Scheduled run ${id} does not exist`)
    const patch = parseScheduledRunPatch(value)
    return this.save({
      id,
      name: patch.name ?? existing.name,
      target: patch.target ?? existing.target,
      command: patch.command ?? existing.command,
      schedule: patch.schedule ?? existing.schedule,
      enabled: patch.enabled ?? existing.enabled
    })
  }

  setEnabled(id: string, enabled: boolean): ScheduledRunDefinition {
    return this.update(id, { enabled })
  }

  duplicate(id: string): ScheduledRunDefinition {
    const existing = this.store.get(id)
    if (!existing) throw new Error(`Scheduled run ${id} does not exist`)
    return this.save({
      name: `${existing.name} copy`,
      target: existing.target,
      command: existing.command,
      schedule: existing.schedule,
      enabled: false
    })
  }

  remove(id: string): void {
    const existing = this.store.get(id)
    if (!existing) throw new Error(`Scheduled run ${id} does not exist`)
    const live = this.store.executionsFor(id).find((execution) => isLiveExecution(execution.status))
    if (live) throw new Error(`Scheduled run ${id} has a live or unverifiable execution and cannot be deleted`)
    this.store.remove(id)
  }

  prime(): void {
    const now = this.now()
    for (const definition of this.store.list()) {
      if (!definition.enabled && definition.nextRunAt !== undefined) {
        this.store.upsert({ ...definition, nextRunAt: undefined, updatedAt: now.toISOString() })
      } else if (definition.enabled && !definition.nextRunAt) {
        this.store.upsert({
          ...definition,
          nextRunAt: nextScheduledRunAt(definition.schedule, now),
          updatedAt: now.toISOString()
        })
      }
    }
  }

  async resume(): Promise<void> {
    const release = this.release
    const work: Promise<void>[] = []
    for (const execution of this.store.allExecutions()) {
      if (isLiveExecution(execution.status)) {
        if (execution.sessionId) work.push(this.reconcileSession(execution.sessionId))
        else {
          const unverifiable = this.store.updateExecution({
            ...execution,
            status: 'unverifiable',
            error: 'Launch state is unverifiable after restart; the execution was not relaunched'
          })
          const definition = this.store.get(unverifiable.scheduledRunId)
          if (definition) this.store.upsert({ ...definition, lastStatus: 'unverifiable', updatedAt: this.now().toISOString() })
        }
      } else if (release && execution.sessionId && (execution.status === 'succeeded' || execution.status === 'failed')) {
        work.push(release(execution.sessionId).catch(() => {}))
      }
    }
    await Promise.all(work)
  }

  async tick(at = this.now()): Promise<void> {
    for (const definition of this.store.list()) {
      if (!definition.enabled || !definition.nextRunAt) continue
      if (Date.parse(definition.nextRunAt) > at.getTime()) continue
      if (this.activeBySession.size + this.launchingByDefinition.size >= this.maxConcurrent) return
      await this.fire(definition, 'schedule', at)
    }
  }

  async runNow(id: string): Promise<ScheduledExecution> {
    const definition = this.store.get(id)
    if (!definition) throw new Error(`Scheduled run ${id} does not exist`)
    if (this.activeBySession.size + this.launchingByDefinition.size >= this.maxConcurrent) {
      throw new Error(`Scheduled run capacity (${this.maxConcurrent}) is full`)
    }
    return this.fire(definition, 'manual', this.now())
  }

  private async fire(
    definition: ScheduledRunDefinition,
    trigger: ScheduledExecution['trigger'],
    at: Date
  ): Promise<ScheduledExecution> {
    const launching = this.launchingByDefinition.get(definition.id)
    const live = this.store.executionsFor(definition.id).find((execution) => isLiveExecution(execution.status))
    if (launching || live) {
      if (trigger === 'manual') throw new Error(`Scheduled run ${definition.id} already has a live or unverifiable execution`)
      const skipped: ScheduledExecution = {
        id: randomUUID(),
        scheduledRunId: definition.id,
        trigger,
        startedAt: at.toISOString(),
        finishedAt: at.toISOString(),
        status: 'skipped',
        error: 'Previous execution is still live or unverifiable'
      }
      this.store.appendExecution(skipped)
      this.store.upsert({
        ...definition,
        nextRunAt: nextScheduledRunAt(definition.schedule, at),
        lastRunAt: skipped.startedAt,
        lastStatus: skipped.status,
        updatedAt: at.toISOString()
      })
      return skipped
    }

    const execution: ScheduledExecution = {
      id: randomUUID(),
      scheduledRunId: definition.id,
      trigger,
      startedAt: at.toISOString(),
      status: 'running'
    }
    this.store.appendExecution(execution)
    this.store.upsert({
      ...definition,
      nextRunAt: trigger === 'schedule' && definition.enabled ? nextScheduledRunAt(definition.schedule, at) : definition.nextRunAt,
      lastRunAt: execution.startedAt,
      lastStatus: execution.status,
      updatedAt: at.toISOString()
    })
    const pending = this.launchExecution(definition, execution)
    this.launchingByDefinition.set(definition.id, pending)
    this.launchingByExecution.set(execution.id, pending)
    try {
      return await pending
    } finally {
      this.launchingByDefinition.delete(definition.id)
      this.launchingByExecution.delete(execution.id)
    }
  }

  private async launchExecution(
    definition: ScheduledRunDefinition,
    execution: ScheduledExecution
  ): Promise<ScheduledExecution> {
    let sessionId: string | undefined
    try {
      sessionId = await this.launch({
        target: definition.target,
        command: definition.command,
        executionId: execution.id
      })
      const current = this.store.executionsFor(definition.id).find((candidate) => candidate.id === execution.id)
      if (!current || !isLiveExecution(current.status)) {
        if (!this.stopJob) throw new Error('A launched daemon job lost its durable owner and no stop operation is available')
        await this.stopJob(sessionId)
        return current ?? execution
      }
      const running = this.store.updateExecution({ ...current, status: 'running', sessionId })
      this.activeBySession.set(sessionId, {
        executionId: running.id,
        scheduledRunId: running.scheduledRunId,
        output: running.output ?? ''
      })
      if (this.inspect) await this.reconcileSession(sessionId)
      return this.store.executionsFor(definition.id).find((candidate) => candidate.id === execution.id) ?? running
    } catch (error) {
      const current = this.store.executionsFor(definition.id).find((candidate) => candidate.id === execution.id)
      if (sessionId && current?.sessionId !== sessionId) {
        this.activeBySession.delete(sessionId)
        try {
          if (!this.stopJob) throw new Error('No daemon stop operation is available')
          await this.stopJob(sessionId)
        } catch (stopError) {
          if (current && isLiveExecution(current.status)) {
            const unverifiable = this.store.updateExecution({
              ...current,
              status: 'unverifiable',
              sessionId,
              error: errorText(`Launch persistence failed (${errorText(error)}); stop acknowledgement failed: ${errorText(stopError)}`)
            })
            this.activeBySession.set(sessionId, {
              executionId: unverifiable.id,
              scheduledRunId: unverifiable.scheduledRunId,
              output: unverifiable.output ?? ''
            })
            const latest = this.store.get(definition.id)
            if (latest) this.store.upsert({ ...latest, lastStatus: unverifiable.status, updatedAt: this.now().toISOString() })
            return unverifiable
          }
          throw stopError
        }
      }
      if (!current || current.status !== 'running' || current.sessionId) throw error
      const failed = this.store.updateExecution({
        ...current,
        status: 'failed',
        finishedAt: this.now().toISOString(),
        error: errorText(error)
      })
      const latest = this.store.get(definition.id)
      if (latest) this.store.upsert({ ...latest, lastStatus: failed.status, updatedAt: this.now().toISOString() })
      return failed
    }
  }

  async cancel(executionId: string): Promise<ScheduledExecution> {
    this.cancelling.add(executionId)
    try {
      const pending = this.launchingByExecution.get(executionId)
      if (pending) await pending
      const execution = this.store.allExecutions().find((candidate) => candidate.id === executionId)
      if (!execution) throw new Error(`Scheduled execution ${executionId} does not exist`)
      if (!isLiveExecution(execution.status)) return execution
      if (!execution.sessionId) {
        const unverifiable = this.store.updateExecution({
          ...execution,
          status: 'unverifiable',
          error: 'Execution has no retained daemon job identity and cannot be reported as cancelled'
        })
        throw new Error(unverifiable.error)
      }
      const cancelling = this.store.updateExecution({ ...execution, status: 'cancelling', error: undefined })
      const output = await this.captureOutput(execution.sessionId)
      try {
        if (!this.stopJob) throw new Error('No daemon stop operation is available')
        await this.stopJob(execution.sessionId)
      } catch (error) {
        const unverifiable = this.store.updateExecution({
          ...cancelling,
          status: 'unverifiable',
          output,
          error: `Cancellation is unverifiable: ${errorText(error)}`
        })
        const definition = this.store.get(unverifiable.scheduledRunId)
        if (definition) this.store.upsert({ ...definition, lastStatus: 'unverifiable', updatedAt: this.now().toISOString() })
        throw new Error(unverifiable.error)
      }
      this.activeBySession.delete(execution.sessionId)
      const cancelled = this.store.updateExecution({
        ...cancelling,
        status: 'cancelled',
        finishedAt: this.now().toISOString(),
        output,
        error: undefined
      })
      const definition = this.store.get(cancelled.scheduledRunId)
      if (definition) this.store.upsert({ ...definition, lastStatus: 'cancelled', updatedAt: this.now().toISOString() })
      return cancelled
    } finally {
      this.cancelling.delete(executionId)
    }
  }

  async onDaemonEvent(kind: 'data' | 'exit', sessionId: string, data = '', exitCode = 0): Promise<void> {
    const active = this.activeBySession.get(sessionId)
    if (!active) return
    if (kind === 'data') {
      active.output = (active.output + data).slice(-OPERATIONAL_OUTPUT_LIMIT)
      const execution = this.store.allExecutions().find((candidate) => candidate.id === active.executionId)
      if (execution?.status === 'unverifiable') {
        this.store.updateExecution({ ...execution, status: 'running', output: boundedOutput(active.output), error: undefined })
        const definition = this.store.get(active.scheduledRunId)
        if (definition) this.store.upsert({ ...definition, lastStatus: 'running', updatedAt: this.now().toISOString() })
      }
      return
    }
    if (this.cancelling.has(active.executionId)) return
    const output = await this.captureOutput(sessionId)
    if (!this.cancelling.has(active.executionId)) this.finish(sessionId, exitCode, output ?? active.output)
  }

  private async reconcileSession(sessionId: string): Promise<void> {
    const active = this.activeBySession.get(sessionId)
    if (!active || !this.inspect) return
    try {
      const result = await this.inspect(sessionId)
      const current = this.store.allExecutions().find((candidate) => candidate.id === active.executionId)
      if (!current || !isLiveExecution(current.status)) return
      active.output = boundedOutput(result.output) ?? ''
      if (result.exited) this.finish(sessionId, result.exitCode, active.output)
      else if (current.status === 'unverifiable') {
        this.store.updateExecution({ ...current, status: 'running', output: boundedOutput(result.output), error: undefined })
        const definition = this.store.get(active.scheduledRunId)
        if (definition) this.store.upsert({ ...definition, lastStatus: 'running', updatedAt: this.now().toISOString() })
      }
    } catch (error) {
      const current = this.store.allExecutions().find((candidate) => candidate.id === active.executionId)
      if (!current || !isLiveExecution(current.status) || current.status === 'cancelling') return
      this.store.updateExecution({
        ...current,
        status: 'unverifiable',
        output: active.output || current.output,
        error: `Daemon state is unverifiable: ${errorText(error)}`
      })
      const definition = this.store.get(active.scheduledRunId)
      if (definition) this.store.upsert({ ...definition, lastStatus: 'unverifiable', updatedAt: this.now().toISOString() })
    }
  }

  private async captureOutput(sessionId: string): Promise<string | undefined> {
    const active = this.activeBySession.get(sessionId)
    if (!this.inspect) return active?.output || undefined
    try {
      const result = await this.inspect(sessionId)
      return boundedOutput(result.output) ?? (active?.output || undefined)
    } catch {
      return active?.output || undefined
    }
  }

  private finish(sessionId: string, exitCode: number | undefined, output: string): void {
    const active = this.activeBySession.get(sessionId)
    if (!active) return
    const execution = this.store.allExecutions().find((candidate) => candidate.id === active.executionId)
    if (!execution || !isLiveExecution(execution.status)) return
    this.activeBySession.delete(sessionId)
    const succeeded = exitCode === 0
    const finished = this.store.updateExecution({
      ...execution,
      status: succeeded ? 'succeeded' : 'failed',
      finishedAt: this.now().toISOString(),
      exitCode,
      output: boundedOutput(output),
      error: succeeded ? undefined : `Command exited with code ${exitCode ?? 'unknown'}`
    })
    const definition = this.store.get(active.scheduledRunId)
    if (definition) this.store.upsert({ ...definition, lastStatus: finished.status, updatedAt: this.now().toISOString() })
    if (this.release) void this.release(sessionId).catch(() => {})
  }
}
