import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export type OrchestrationTaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'
export type OrchestrationRunStatus = 'running' | 'done' | 'failed' | 'cancelled'

export type OrchestrationTask = {
  id: string
  worktreePath: string
  prompt: string
  status: OrchestrationTaskStatus
  sessionId?: string
  startedAt?: string
  finishedAt?: string
  error?: string
}

export type OrchestrationRun = {
  id: string
  name: string
  command: string
  /** How many tasks may run concurrently (default: all). */
  parallel: number
  status: OrchestrationRunStatus
  createdAt: string
  finishedAt?: string
  tasks: OrchestrationTask[]
}

/** Persisted orchestration runs (JSON file in userData). */
export class OrchestrationStore {
  private readonly file: string

  constructor(userDataDir: string) {
    this.file = join(userDataDir, 'orchestrations.json')
  }

  list(): OrchestrationRun[] {
    if (!existsSync(this.file)) return []
    try { return JSON.parse(readFileSync(this.file, 'utf8')) as OrchestrationRun[] } catch { return [] }
  }

  save(runs: OrchestrationRun[]): void {
    // keep the last 30 runs
    writeFileSync(this.file, JSON.stringify(runs.slice(0, 30), null, 2), 'utf8')
  }

  get(id: string): OrchestrationRun | null {
    return this.list().find((r) => r.id === id) ?? null
  }

  upsert(run: OrchestrationRun): void {
    const all = this.list()
    const i = all.findIndex((r) => r.id === run.id)
    if (i >= 0) all[i] = run
    else all.unshift(run)
    this.save(all)
  }
}

export type LaunchFn = (worktreePath: string, prompt: string) => Promise<string> // → sessionId

/**
 * Orchestrator: fans a prompt across worktrees (one task per worktree),
 * launches tasks via the daemon (bounded concurrency), and advances task
 * state through daemon hook/exit events. A run completes when all its
 * tasks reach a terminal state.
 */
export class Orchestrator {
  /** sessionId → { runId, taskId } */
  private readonly sessionIndex = new Map<string, { runId: string; taskId: string }>()

  constructor(
    private readonly store: OrchestrationStore,
    private readonly launch: LaunchFn
  ) {}

  /** Create + start a run: one task per worktree path. */
  async start(name: string, command: string, worktreePaths: string[], parallel = 4): Promise<OrchestrationRun> {
    const run: OrchestrationRun = {
      id: randomUUID(),
      name,
      command,
      parallel: Math.max(1, parallel),
      status: 'running',
      createdAt: new Date().toISOString(),
      tasks: worktreePaths.map((p) => ({
        id: randomUUID(),
        worktreePath: p,
        prompt: command,
        status: 'pending' as OrchestrationTaskStatus
      }))
    }
    this.store.upsert(run)
    await this.pump(run.id)
    return run
  }

  /** Launch pending tasks while under the parallel cap. */
  async pump(runId: string): Promise<void> {
    const run = this.store.get(runId)
    if (!run || run.status !== 'running') return
    const running = run.tasks.filter((t) => t.status === 'running').length
    let slots = run.parallel - running
    for (const t of run.tasks) {
      if (slots <= 0) break
      if (t.status !== 'pending') continue
      t.status = 'running'
      t.startedAt = new Date().toISOString()
      slots--
      try {
        const sessionId = await this.launch(t.worktreePath, t.prompt)
        t.sessionId = sessionId
        this.sessionIndex.set(sessionId, { runId: run.id, taskId: t.id })
      } catch (e) {
        t.status = 'failed'
        t.error = String(e).slice(0, 500)
        t.finishedAt = new Date().toISOString()
      }
    }
    this.store.upsert(run)
    this.refreshStatus(run.id)
  }

  /** Feed daemon events for launched task sessions. */
  onDaemonEvent(kind: 'hook' | 'exit', sessionId: string, state = ''): void {
    const idx = this.sessionIndex.get(sessionId)
    if (!idx) return
    if (kind === 'hook') {
      if (state === 'done') this.finishTask(idx.runId, idx.taskId, 'done')
      return
    }
    this.finishTask(idx.runId, idx.taskId, 'failed', 'session exited before done hook')
  }

  finishTask(runId: string, taskId: string, status: OrchestrationTaskStatus, error?: string): void {
    const run = this.store.get(runId)
    if (!run) return
    const t = run.tasks.find((x) => x.id === taskId)
    if (!t || t.status !== 'running') return
    if (t.sessionId) this.sessionIndex.delete(t.sessionId)
    t.status = status
    t.error = error
    t.finishedAt = new Date().toISOString()
    this.store.upsert(run)
    this.refreshStatus(runId)
    // slot freed: launch next pending
    void this.pump(runId)
  }

  /** Recompute run status from task states. */
  private refreshStatus(runId: string): void {
    const run = this.store.get(runId)
    if (!run || run.status !== 'running') return
    const pending = run.tasks.filter((t) => t.status === 'pending').length
    const running = run.tasks.filter((t) => t.status === 'running').length
    if (pending === 0 && running === 0) {
      const failed = run.tasks.filter((t) => t.status === 'failed').length
      this.store.upsert({
        ...run,
        status: failed > 0 && failed === run.tasks.length ? 'failed' : 'done',
        finishedAt: new Date().toISOString()
      })
    }
  }

  cancel(runId: string): void {
    const run = this.store.get(runId)
    if (!run || run.status !== 'running') return
    for (const t of run.tasks) {
      if (t.status === 'pending' || t.status === 'running') {
        t.status = 'cancelled'
        t.finishedAt = new Date().toISOString()
        if (t.sessionId) this.sessionIndex.delete(t.sessionId)
      }
    }
    this.store.upsert({ ...run, status: 'cancelled', finishedAt: new Date().toISOString() })
  }
}