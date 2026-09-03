import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export type AutomationSchedule =
  | { kind: 'interval'; minutes: number }
  | { kind: 'daily'; time: string } // HH:MM local

export type Automation = {
  id: string
  name: string
  worktreePath: string
  command: string
  schedule: AutomationSchedule
  enabled: boolean
  createdAt: string
  /** ISO time of the next scheduled run (managed by the scheduler). */
  nextRunAt?: string
  lastRunAt?: string
  lastStatus?: AutomationRun['status']
}

export type AutomationRun = {
  id: string
  automationId: string
  startedAt: string
  finishedAt?: string
  status: 'running' | 'ok' | 'failed' | 'interrupted'
  /** Last ~2 KB of terminal output for the run. */
  tail?: string
}

const RUNS_CAP = 20
const TAIL_MAX = 2048

/** Persisted automations + run history (JSON file in userData). */
export class AutomationStore {
  private readonly file: string
  private readonly runsFile: string

  constructor(userDataDir: string) {
    this.file = join(userDataDir, 'automations.json')
    this.runsFile = join(userDataDir, 'automation-runs.json')
  }

  list(): Automation[] {
    if (!existsSync(this.file)) return []
    try { return JSON.parse(readFileSync(this.file, 'utf8')) as Automation[] } catch { return [] }
  }

  remove(id: string): void {
    const all = this.list().filter((a) => a.id !== id)
    writeFileSync(this.file, JSON.stringify(all, null, 2), 'utf8')
    this.saveRuns(this.allRuns().filter((r) => r.automationId !== id))
  }

  upsert(a: Automation): void {
    const all = this.list()
    const i = all.findIndex((x) => x.id === a.id)
    if (i >= 0) all[i] = a
    else all.push(a)
    writeFileSync(this.file, JSON.stringify(all, null, 2), 'utf8')
  }

  allRuns(): AutomationRun[] {
    if (!existsSync(this.runsFile)) return []
    try { return JSON.parse(readFileSync(this.runsFile, 'utf8')) as AutomationRun[] } catch { return [] }
  }

  runsFor(automationId: string, limit = RUNS_CAP): AutomationRun[] {
    return this.allRuns()
      .filter((r) => r.automationId === automationId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit)
  }

  appendRun(run: AutomationRun): void {
    const all = this.allRuns()
    all.push(run)
    // cap per automation
    const byAutomation = new Map<string, AutomationRun[]>()
    for (const r of all) {
      const list = byAutomation.get(r.automationId) ?? []
      list.push(r)
      byAutomation.set(r.automationId, list)
    }
    const kept: AutomationRun[] = []
    for (const list of byAutomation.values()) {
      list.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      kept.push(...list.slice(0, RUNS_CAP))
    }
    this.saveRuns(kept)
  }

  updateRun(run: AutomationRun): void {
    const all = this.allRuns().map((r) => (r.id === run.id ? run : r))
    this.saveRuns(all)
  }

  private saveRuns(runs: AutomationRun[]): void {
    writeFileSync(this.runsFile, JSON.stringify(runs, null, 2), 'utf8')
  }
}

/** Next fire time for a schedule, from a given moment. */
export function nextRunAfter(schedule: AutomationSchedule, from: Date): string {
  if (schedule.kind === 'interval') {
    return new Date(from.getTime() + Math.max(1, schedule.minutes) * 60_000).toISOString()
  }
  const [hh, mm] = schedule.time.split(':').map((n) => Number(n) || 0)
  const next = new Date(from)
  next.setHours(hh, mm, 0, 0)
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1)
  return next.toISOString()
}

/**
 * Scheduler: ticks every 15s, fires due automations into worktree terminals via
 * a run callback, and tracks run completion through daemon hook/exit events.
 */
export class SchedulerService {
  private timer: NodeJS.Timeout | null = null
  /** sessionId → in-flight run */
  private readonly active = new Map<string, { run: AutomationRun; automationId: string; tail: string }>()

  constructor(
    private readonly store: AutomationStore,
    private readonly run: (a: Automation) => Promise<string> // → sessionId
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), 15_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Force nextRunAt computation for all enabled automations missing one. */
  prime(): void {
    const now = new Date()
    for (const a of this.store.list()) {
      if (a.enabled && !a.nextRunAt) {
        this.store.upsert({ ...a, nextRunAt: nextRunAfter(a.schedule, now) })
      }
    }
  }

  tick(): void {
    const now = new Date()
    for (const a of this.store.list()) {
      if (!a.enabled || !a.nextRunAt) continue
      if (new Date(a.nextRunAt).getTime() > now.getTime()) continue
      void this.fire(a)
    }
  }

  async runNow(id: string): Promise<void> {
    const a = this.store.list().find((x) => x.id === id)
    if (a) await this.fire(a)
  }

  private async fire(a: Automation): Promise<void> {
    try {
      const sessionId = await this.run(a)
      const run: AutomationRun = { id: randomUUID(), automationId: a.id, startedAt: new Date().toISOString(), status: 'running' }
      this.active.set(sessionId, { run, automationId: a.id, tail: '' })
      this.store.appendRun(run)
      this.store.upsert({
        ...a,
        lastRunAt: run.startedAt,
        lastStatus: 'running',
        nextRunAt: nextRunAfter(a.schedule, new Date())
      })
    } catch (e) {
      const run: AutomationRun = { id: randomUUID(), automationId: a.id, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), status: 'failed', tail: String(e).slice(0, TAIL_MAX) }
      this.store.appendRun(run)
      this.store.upsert({ ...a, lastRunAt: run.startedAt, lastStatus: 'failed', nextRunAt: nextRunAfter(a.schedule, new Date()) })
    }
  }

  /** Feed daemon events for sessions the scheduler started. */
  onDaemonEvent(kind: 'hook' | 'exit', sessionId: string, state = '', exitCode = 0): void {
    const entry = this.active.get(sessionId)
    if (!entry) return
    if (kind === 'hook') {
      entry.tail = (entry.tail + `\n[hook ${state}]`).slice(-TAIL_MAX)
      if (state === 'done') {
        this.finish(sessionId, 'ok')
      } else if (state === 'permission') {
        entry.run.status = 'running'
        entry.tail = (entry.tail + ' (needs permission)').slice(-TAIL_MAX)
      }
      return
    }
    // exit: done-hook is the ok path; plain shell exit means interrupted
    this.finish(sessionId, exitCode !== 0 ? 'failed' : 'interrupted')
  }

  private finish(sessionId: string, status: AutomationRun['status']): void {
    const entry = this.active.get(sessionId)
    if (!entry) return
    this.active.delete(sessionId)
    const run: AutomationRun = { ...entry.run, finishedAt: new Date().toISOString(), status, tail: entry.tail || undefined }
    this.store.updateRun(run)
    const a = this.store.list().find((x) => x.id === entry.automationId)
    if (a) this.store.upsert({ ...a, lastStatus: status })
  }
}