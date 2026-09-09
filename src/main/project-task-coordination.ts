import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { isObject } from '@shared/command-catalog'
import type { ProjectTasksInspection } from '@shared/agent-runtime'
import { runProcess } from '@shared/child-process/run-process'
import { sanitizedProcessEnv } from '@shared/child-process/process-environment'
import { AgentRegistry } from './agents/registry'
import { shellCommand } from './agents/provider-hooks'
import { resolveRegisteredProjectWorkspace } from './git'
import { WorktreeFiles } from './worktree-files'
import type { Store } from './store'
import type { DaemonClient } from './daemon-client'

const TOOLS = {
  lazygit: { version: '0.62.2', sha256: 'f7ff3785fc0b85305933da9ab1ea46e099557c2e73d03d9bb8545e59cd72807c' },
  backlog: { version: '1.51.0', sha256: 'f8ecec1e9e748db9ccddf6ec71fbff06e406bc0db106891e7e60fd1af2713415' }
} as const

/** Native task files remain authoritative; the app stores only the project's opt-in. */
export class ProjectTaskCoordination {
  constructor(private readonly store: Store, private readonly terminals: DaemonClient, private readonly backlogBinary: string | ((path: string) => Promise<string | undefined>) | undefined = process.env.DONWELLS_BACKLOG_BINARY, private readonly registry = new AgentRegistry()) {}

  private async workspace(path: string) {
    const scope = await resolveRegisteredProjectWorkspace(this.store, path)
    const repo = this.store.listRepos().find(repo => repo.id === scope.projectId)
    if (!repo) throw new Error('Project is no longer registered')
    return { ...scope, repo }
  }

  private async binary(tool: 'lazygit' | 'backlog', workspacePath: string): Promise<string> {
    const candidate = tool === 'backlog' ? typeof this.backlogBinary === 'function' ? await this.backlogBinary(workspacePath) : this.backlogBinary : this.registry.findExecutable('lazygit')
    if (!candidate) throw new Error(`${tool} is not configured`)
    const path = await realpath(candidate)
    const info = await stat(path)
    if (!info.isFile() || info.size > 128 * 1024 * 1024) throw new Error('Invalid native task executable')
    const hash = createHash('sha256')
    for await (const bytes of createReadStream(path)) hash.update(bytes)
    if (hash.digest('hex') !== TOOLS[tool].sha256) throw new Error(`${tool} does not match the admitted ${TOOLS[tool].version} executable`)
    return path
  }

  private async backlog(path: string, args: string[]): Promise<unknown> {
    const scope = await this.workspace(path)
    if (scope.repo.taskAuthority !== 'backlog.md') throw new Error('Backlog.md is not the selected project task authority')
    const files = new WorktreeFiles()
    // Local config is required so native discovery cannot climb into another project.
    let configured = false
    for (const config of ['backlog.config.yml', 'backlog/config.yml', '.backlog/config.yml']) {
      try { const file = await files.readFile(scope.path, config); if (!file.binary && !file.truncated) configured = true } catch {}
    }
    if (!configured) throw new Error('Initialize Backlog.md in this checkout using its native CLI first')
    const result = await runProcess({ program: await this.binary('backlog', path), args, cwd: scope.path,
      env: sanitizedProcessEnv(process.env, { BACKLOG_CWD: scope.path }), timeoutMs: 10000, maxOutputBytes: 256 * 1024 })
    if ((await this.workspace(path)).repo.taskAuthority !== 'backlog.md') throw new Error('Project task authority changed during native read')
    return JSON.parse(result.stdout)
  }

  async inspect(path: string): Promise<ProjectTasksInspection> {
    const scope = await this.workspace(path)
    const tools = await Promise.all((['lazygit', 'backlog'] as const).map(async id => {
      try { return { id, version: TOOLS[id].version, available: true, path: await this.binary(id, path) } }
      catch (error) { return { id, version: TOOLS[id].version, available: false, problem: String(error) } }
    }))
    const result: ProjectTasksInspection = { authority: scope.repo.taskAuthority ?? null, tools, tasks: [] }
    if (result.authority) {
      try {
        const payload = await this.backlog(path, ['task', 'list', '--json', '--limit', '100'])
        if (!isObject(payload) || payload.schemaVersion !== 1 || payload.kind !== 'task-list' || !Array.isArray(payload.tasks) || payload.tasks.length > 100) throw new Error('Unexpected native task list')
        result.tasks = payload.tasks.map(task => {
          if (!isObject(task) || !['id', 'title', 'status'].every(key => typeof task[key] === 'string' && String(task[key]).length <= 4096)) throw new Error('Invalid native task')
          return { id: String(task.id), title: String(task.title), status: String(task.status) }
        })
      } catch (error) { result.problem = String(error) }
    }
    return result
  }

  async setAuthority(path: string, enabled: boolean): Promise<void> {
    const scope = await this.workspace(path)
    this.store.setTaskAuthority(scope.repo.id, enabled)
  }

  async requireTask(path: string, id: string): Promise<void> {
    const payload = await this.backlog(path, ['task', 'view', id, '--json'])
    if (!isObject(payload) || payload.schemaVersion !== 1 || payload.kind !== 'task-view' || !isObject(payload.task) || String(payload.task.id).toLowerCase() !== id.toLowerCase() || typeof payload.task.path !== 'string') throw new Error('Native task does not exist')
    await new WorktreeFiles().readFile((await this.workspace(path)).path, payload.task.path)
  }

  async openTool(path: string, tool: 'lazygit' | 'backlog') {
    if (tool !== 'lazygit' && tool !== 'backlog') throw new Error('Unknown project task tool')
    const scope = await this.workspace(path)
    if (tool === 'backlog') {
      const state = await this.inspect(path)
      if (!state.authority || state.problem) throw new Error(state.problem ?? 'Choose Backlog.md as the task authority first')
    }
    const program = await this.binary(tool, path)
    await this.workspace(path)
    return this.terminals.openJob(scope.path, shellCommand(tool === 'backlog' ? ['/usr/bin/env', `BACKLOG_CWD=${scope.path}`, program, 'board'] : [program], process.platform))
  }
}
