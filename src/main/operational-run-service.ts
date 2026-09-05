import { parseParallelRunInput, parseScheduledRunInput, type OperationalRunsApi, type OperationalTarget, type ParallelRunInput, type ScheduledRunInput } from '@shared/operational-runs'
import { ScheduledRunScheduler, ScheduledRunStore } from './automations'
import { ParallelRunOrchestrator, ParallelRunStore } from './orchestration'
import type { DaemonClient } from './daemon-client'

export class OperationalRunService implements OperationalRunsApi {
  private readonly scheduler: ScheduledRunScheduler
  private readonly parallel: ParallelRunOrchestrator

  constructor(userDataDir: string, terminals: DaemonClient, private readonly resolveWorkspace: (path: string) => Promise<string>) {
    const launch = async ({ target, command }: { target: OperationalTarget; command: string }): Promise<string> => {
      const workspacePath = await this.localWorkspace(target)
      return (await terminals.openJob(workspacePath, command)).id
    }
    const inspect = (sessionId: string) => terminals.jobResult(sessionId)
    const release = (sessionId: string) => terminals.close(sessionId)
    const stop = (sessionId: string) => terminals.close(sessionId)
    this.scheduler = new ScheduledRunScheduler(new ScheduledRunStore(userDataDir), launch, inspect, release, stop)
    this.parallel = new ParallelRunOrchestrator(new ParallelRunStore(userDataDir), launch, stop, inspect, release)
  }

  private async localWorkspace(target: OperationalTarget): Promise<string> {
    if (target.kind !== 'local') throw new Error('Remote operational execution is unavailable; this run was not launched locally')
    return this.resolveWorkspace(target.root)
  }

  async resume(): Promise<void> {
    await Promise.all([this.scheduler.resume(), this.parallel.resume()])
    this.scheduler.prime()
    this.scheduler.start()
  }

  stop(): void {
    this.scheduler.stop()
  }

  async onDaemonEvent(kind: 'data' | 'exit', sessionId: string, data: string, exitCode?: number): Promise<void> {
    await Promise.all([
      this.scheduler.onDaemonEvent(kind, sessionId, data, exitCode),
      this.parallel.onDaemonEvent(kind, sessionId, data, exitCode)
    ])
  }

  async scheduledRunsList() { return this.scheduler.list() }
  async scheduledRunHistory(id: string) { return this.scheduler.history(id) }

  async scheduledRunSave(value: ScheduledRunInput) {
    const input = parseScheduledRunInput(value)
    const root = await this.localWorkspace(input.target)
    return this.scheduler.save({ ...input, target: { ...input.target, root } })
  }

  async scheduledRunSetEnabled(id: string, enabled: boolean) {
    if (enabled) {
      const definition = this.scheduler.list().find((entry) => entry.id === id)
      if (!definition) throw new Error('Scheduled run does not exist')
      await this.localWorkspace(definition.target)
    }
    return this.scheduler.setEnabled(id, enabled)
  }

  async scheduledRunDuplicate(id: string) { return this.scheduler.duplicate(id) }
  async scheduledRunDelete(id: string) { this.scheduler.remove(id) }
  async scheduledRunRunNow(id: string) { return this.scheduler.runNow(id) }
  async scheduledRunCancel(executionId: string) { return this.scheduler.cancel(executionId) }
  async parallelRunsList() { return this.parallel.list() }

  async parallelRunStart(value: ParallelRunInput) {
    const input = parseParallelRunInput(value)
    const targets = await Promise.all(input.targets.map(async (target) => ({ ...target, root: await this.localWorkspace(target) })))
    return this.parallel.start({ ...input, targets })
  }

  async parallelRunRetry(id: string, taskIds: string[]) {
    const run = this.parallel.list().find((entry) => entry.id === id)
    if (!run) throw new Error('Parallel run does not exist')
    if (!Array.isArray(taskIds) || taskIds.some((taskId) => typeof taskId !== 'string')) throw new Error('Task IDs must be a string list')
    await Promise.all(run.tasks.filter((task) => taskIds.includes(task.id)).map((task) => this.localWorkspace(task.target)))
    return this.parallel.retry(id, taskIds)
  }

  async parallelRunCancel(id: string) { return this.parallel.cancel(id) }
  async parallelRunDelete(id: string) { this.parallel.remove(id) }
}
