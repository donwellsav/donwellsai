import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import type { ProjectTasksInspection } from '@shared/agent-runtime'
import { runProcess } from '@shared/child-process/run-process'
import { sanitizedProcessEnv } from '@shared/child-process/process-environment'
import { shellCommand } from './agents/provider-hooks'
import { AgentRegistry } from './agents/registry'
import { resolveRegisteredProjectWorkspace } from './git'
import type { Store } from './store'
import type { DaemonClient } from './daemon-client'
import { projectProjectTasksInspection } from './task-authority/task-projections'
import type { BacklogMigrationReadPort, BacklogWorkspaceIdentity } from './task-authority/backlog-migration-reader'
import { WorktreeFiles } from './worktree-files'

const TOOLS = {
  lazygit: { version: '0.62.2', sha256: 'f7ff3785fc0b85305933da9ab1ea46e099557c2e73d03d9bb8545e59cd72807c' },
  backlog: { version: '1.51.0', sha256: 'f8ecec1e9e748db9ccddf6ec71fbff06e406bc0db106891e7e60fd1af2713415' }
} as const

/** Main-process adapter: task state and admission come from the daemon. */
export class ProjectTaskCoordination {
  constructor(
    private readonly store: Store,
    private readonly terminals: DaemonClient,
    private readonly backlogBinary: string | ((path: string) => Promise<string | undefined>) | undefined = process.env.DONWELLS_BACKLOG_BINARY,
    private readonly registry = new AgentRegistry()
  ) {}

  private async workspace(path: string) {
    const scope = await resolveRegisteredProjectWorkspace(this.store, path)
    const repo = this.store.listRepos().find(candidate => candidate.id === scope.projectId)
    if (!repo) throw new Error('Project is no longer registered')
    return { ...scope, repo }
  }

  private async migrationBinary(workspacePath: string): Promise<string> {
    const candidate = typeof this.backlogBinary === 'function' ? await this.backlogBinary(workspacePath) : this.backlogBinary
    if (!candidate) throw new Error('backlog is not configured')
    const path = await realpath(candidate)
    const info = await stat(path)
    if (!info.isFile() || info.size > 128 * 1024 * 1024) throw new Error('Invalid native task executable')
    const hash = createHash('sha256')
    for await (const bytes of createReadStream(path)) hash.update(bytes)
    if (hash.digest('hex') !== TOOLS.backlog.sha256) throw new Error(`backlog does not match the admitted ${TOOLS.backlog.version} executable`)
    return path
  }

  /** Full-record Backlog access is migration-only and never used for authority. */
  private async migrationBacklog(path: string, args: string[]): Promise<unknown> {
    const scope = await this.workspace(path)
    if (scope.repo.taskAuthority !== 'backlog.md') throw new Error('Backlog.md is not the selected migration source')
    const files = new WorktreeFiles()
    let configured = false
    for (const config of ['backlog.config.yml', 'backlog/config.yml', '.backlog/config.yml']) {
      try {
        const file = await files.readFile(scope.path, config)
        if (!file.binary && !file.truncated) configured = true
      } catch { /* source may be absent during migration preparation */ }
    }
    if (!configured) throw new Error('Initialize Backlog.md in this checkout using its native CLI first')
    const result = await runProcess({
      program: await this.migrationBinary(scope.path),
      args,
      cwd: scope.path,
      env: sanitizedProcessEnv(process.env, { BACKLOG_CWD: scope.path }),
      timeoutMs: 10_000,
      maxOutputBytes: 256 * 1024
    })
    return JSON.parse(result.stdout)
  }

  async inspect(path: string): Promise<ProjectTasksInspection> {
    const scope = await this.workspace(path)
    const tools = (Object.keys(TOOLS) as Array<'lazygit' | 'backlog'>).map(id => ({ id, version: TOOLS[id].version, available: false, problem: 'task authority is daemon-owned' }))
    if (!scope.repo.taskAuthority) return projectProjectTasksInspection(null, tools, [])
    try {
      const projection = await this.terminals.taskQuery({ projectId: scope.projectId, limit: 100 })
      return projectProjectTasksInspection(scope.repo.taskAuthority, tools, projection.tasks)
    } catch (error) {
      return projectProjectTasksInspection(scope.repo.taskAuthority, tools, [], String(error))
    }
  }
  backlogMigrationReadPort(): BacklogMigrationReadPort {
    return {
      run: async (identity, args) => {
        this.assertMigrationWorkspace(identity)
        return this.migrationBacklog(identity.workspaceRoot, [...args])
      },
      readWorkspaceFile: async (identity, relPath) => {
        this.assertMigrationWorkspace(identity)
        const file = await new WorktreeFiles().readFile(identity.workspaceRoot, relPath)
        return { bytes: Buffer.from(file.content, 'utf8'), truncated: file.truncated, binary: file.binary === true }
      }
    }
  }

  private assertMigrationWorkspace(identity: BacklogWorkspaceIdentity): void {
    const registered = this.store.listRepos().find(repo => repo.id === identity.repositoryId)
    if (!registered || registered.taskAuthority !== 'backlog.md') throw new Error('Migration source is not the project selected task authority')
  }

  async setAuthority(path: string, enabled: boolean): Promise<void> {
    const scope = await this.workspace(path)
    this.store.setTaskAuthority(scope.repo.id, enabled)
  }


  async openTool(path: string, tool: 'lazygit' | 'backlog') {
    if (tool !== 'lazygit' && tool !== 'backlog') throw new Error('Unknown project task tool')
    const scope = await this.workspace(path)
    if (tool === 'backlog') throw new Error('Backlog board is migration-only; use the daemon task projection')
    const program = this.registry.findExecutable('lazygit')
    if (!program) throw new Error('lazygit is not configured')
    return this.terminals.openJob(scope.path, shellCommand([program], process.platform))
  }
}
