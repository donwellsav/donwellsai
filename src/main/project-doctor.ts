import { ProjectSessionHistory, SESSION_HISTORY_VERSION } from './project-session-history'
import { randomUUID } from 'node:crypto'
import { mkdir, stat, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { WorktreeFiles } from './worktree-files'
import { ProjectTools, resolveProjectToolScope, type ProjectToolDefinition } from './project-tools'
import { PROJECT_TOOL_FIELDS, parseProjectToolConfiguration, type ProjectToolConfiguration, type ProjectDoctorReport } from '@shared/project-doctor'
import { redactDesignCaptureSecrets } from '@shared/design-capture'

/** Project configuration routes to the existing MCP owners; changing it stops those owners first. */
export class ProjectDoctor {
  private readonly files = new WorktreeFiles()
  private readonly owners = new Map<string, Promise<ProjectTools>>()
  private readonly histories = new Map<string, ProjectSessionHistory>()
  private readonly revisions = new Map<string, string | null>()
  private readonly changing = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
  private closed = false
  constructor(
    private readonly directory: string,
    private readonly resolveWorkspace: (path: string) => Promise<{ path: string; projectPath: string }>,
    private readonly defaults: (projectPath: string) => ProjectToolConfiguration,
    private readonly definitions: (config: ProjectToolConfiguration, projectPath: string) => ProjectToolDefinition[],
    private readonly historyCache = join(directory, 'history')
  ) {}

  private async location(path: string) {
    const scope = await resolveProjectToolScope(path, this.resolveWorkspace)
    const directory = join(this.directory, scope.projectKey)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    return { ...scope, directory }
  }

  private async read(directory: string, projectPath: string) {
    // Read failures and corrupt content never silently revert to a working default.
    const exists = await stat(join(directory, 'tools.json')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
    if (!exists) return { configuration: parseProjectToolConfiguration(this.defaults(projectPath)), revision: null, content: null }
    const file = await this.files.readFile(directory, 'tools.json')
    if (file.binary || file.truncated || !file.revision || file.bytes > 65536) throw new Error('Project tool configuration is not bounded readable JSON')
    return { configuration: parseProjectToolConfiguration(JSON.parse(file.content)), revision: file.revision, content: file.content }
  }

  private async owner(path: string): Promise<ProjectTools> {
    const scope = await this.location(path)
    if (this.closed || this.changing.has(scope.projectKey)) throw new Error('Project tools are stopped for configuration changes')
    let owner = this.owners.get(scope.projectKey)
    if (!owner) {
      owner = this.read(scope.directory, scope.projectPath).then(({ configuration, revision }) => {
        this.revisions.set(scope.projectKey, revision)
        return new ProjectTools(async requested => {
        const resolved = await this.resolveWorkspace(requested)
        const current = await resolveProjectToolScope(requested, this.resolveWorkspace)
        if (current.projectKey !== scope.projectKey) throw new Error('Tool belongs to another project')
        return resolved
      }, this.definitions(configuration, scope.projectPath).filter(tool => !configuration.disabled.includes(tool.id)))
      })
      this.owners.set(scope.projectKey, owner)
      void owner.catch(() => { if (this.owners.get(scope.projectKey) === owner) this.owners.delete(scope.projectKey) })
    }
    const ready = await owner
    if (this.closed || this.changing.has(scope.projectKey)) throw new Error('Project tools are stopped for configuration changes')
    if ((await this.read(scope.directory, scope.projectPath)).revision !== this.revisions.get(scope.projectKey)) throw new Error('Tool configuration changed on disk; apply it before using these services')
    return ready
  }

  async inspect(path: string): Promise<ProjectDoctorReport> {
    const scope = await this.location(path)
    let configuration = parseProjectToolConfiguration(this.defaults(scope.projectPath)), revision: string | null = null, problem: string | null = null
    try { ({ configuration, revision } = await this.read(scope.directory, scope.projectPath)) } catch { problem = 'Cannot read project tool configuration. Restore a valid backup or repair this file, then recheck.' }
    const resources = await Promise.all((Object.keys(PROJECT_TOOL_FIELDS) as Array<keyof typeof PROJECT_TOOL_FIELDS>).filter(field => configuration[field]).map(async field => {
      try { const info = await stat(configuration[field]!); return { field, bytes: info.isFile() ? info.size : null, problem: info.isFile() || info.isDirectory() ? null : 'Not a regular file or directory' } }
      catch (error) { return { field, bytes: null, problem: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Missing path' : 'Cannot access selected path' } }
    }))
    const availableDiskBytes = await statfs(scope.directory).then(info => info.bavail * info.bsize, () => null)
    let services: ProjectDoctorReport['services'] = []
    if (!problem) try { services = await (await this.owner(path)).list(path) } catch (error) { problem = redactDesignCaptureSecrets(String(error)) }
    if (configuration.historyBinary && !configuration.disabled.includes('history')) services.push({ id: 'history', status: await this.histories.get(scope.projectKey)?.isIndexing(path).catch(() => false) ? 'starting' : 'stopped', version: SESSION_HISTORY_VERSION, detail: 'Finite native indexing job; Reindex verifies the selected binary and roots.' })
    return { workspacePath: scope.projectPath, configuration, revision, configurationPath: join(scope.directory, 'tools.json'), problem, resources, availableDiskBytes,
      services: services.map(service => ({ ...service, detail: service.detail ? redactDesignCaptureSecrets(service.detail) : null })) }
  }

  async configure(path: string, input: unknown, expectedRevision: string | null): Promise<ProjectDoctorReport> {
    const configuration = parseProjectToolConfiguration(input), scope = await this.location(path)
    if (this.closed || this.changing.has(scope.projectKey)) throw new Error('Project tool configuration is already changing')
    const settled = Promise.withResolvers<void>()
    this.changing.set(scope.projectKey, settled)
    try {
      const current = await this.read(scope.directory, scope.projectPath)
      if (current.revision !== expectedRevision) throw new Error('Tool configuration changed; reload before applying')
      await Promise.all([(async () => (await this.owners.get(scope.projectKey))?.close())(), this.histories.get(scope.projectKey)?.close()])
      // Keep failed termination owners retained: their close must succeed before any replacement can launch.
      this.owners.delete(scope.projectKey)
      this.revisions.delete(scope.projectKey)
      this.histories.delete(scope.projectKey)
      if ((await this.location(path)).projectKey !== scope.projectKey) throw new Error('Project changed while configuring tools')
      if (current.content !== null) await this.files.createWorkspaceEntry(scope.directory, { kind: 'file', path: `tools-backup-${randomUUID()}.json`, content: current.content })
      const content = JSON.stringify(configuration, null, 2) + '\n'
      if (current.revision) await this.files.writeFile(scope.directory, 'tools.json', content, current.revision)
      else await this.files.createWorkspaceEntry(scope.directory, { kind: 'file', path: 'tools.json', content })
    } finally { this.changing.delete(scope.projectKey); settled.resolve() }
    return this.inspect(path)
  }

  async list(path: string) { return (await this.owner(path)).list(path) }
  async start(path: string, id: string) { return (await this.owner(path)).start(path, id) }
  async call(path: string, id: string, operation: string, input: unknown) { return (await this.owner(path)).call(path, id, operation, input) }
  async stop(path: string, id: string) {
    const scope = await this.location(path)
    if (id === 'history') { await this.histories.get(scope.projectKey)?.close(); this.histories.delete(scope.projectKey); return }
    const existing = this.owners.get(scope.projectKey)
    if (existing) await (await existing).stop(path, id)
  }
  async configuration(path: string): Promise<ProjectToolConfiguration> {
    const owner = await this.owner(path), scope = await this.location(path)
    const selected = await this.read(scope.directory, scope.projectPath)
    if (this.closed || this.changing.has(scope.projectKey) || await this.owners.get(scope.projectKey) !== owner || selected.revision !== this.revisions.get(scope.projectKey)) throw new Error('Project tool configuration changed while reading')
    return selected.configuration
  }
  private async history(path: string): Promise<ProjectSessionHistory> {
    const scope = await this.location(path), config = await this.configuration(path)
    if (this.closed || this.changing.has(scope.projectKey)) throw new Error('History is stopped for configuration changes')
    if (!config.historyBinary || config.disabled.includes('history')) throw new Error('Configure and enable the admitted session history engine first')
    let history = this.histories.get(scope.projectKey)
    if (!history) {
      history = new ProjectSessionHistory({ binary: config.historyBinary, cache: this.historyCache, roots: { omp: config.historyOmpRoots ?? [], 'deepseek-harness': config.historyDshRoots ?? [] } }, async requested => {
        const current = await resolveProjectToolScope(requested, this.resolveWorkspace)
        if (current.projectKey !== scope.projectKey) throw new Error('History belongs to another project')
        return current
      })
      this.histories.set(scope.projectKey, history)
    }
    return history
  }
  async historyIndex(path: string) { return (await this.history(path)).index(path) }
  async historySearch(path: string, query: string) { return (await this.history(path)).search(path, query) }
  async historyGet(path: string, id: string) { return (await this.history(path)).get(path, id) }

  async retry(path: string, id: string) { if (id === 'history') { await this.stop(path, id); await this.historyIndex(path); return { id, status: 'stopped' as const, version: SESSION_HISTORY_VERSION, detail: 'Native history index updated' } } const owner = await this.owner(path); await owner.stop(path, id); return owner.start(path, id) }
  async close() {
    this.closed = true
    await Promise.all([...this.changing.values()].map(change => change.promise))
    const results = await Promise.allSettled([...this.owners.values()].map(async owner => (await owner).close()).concat([...this.histories.values()].map(history => history.close())))
    if (results.some(result => result.status === 'rejected')) throw new Error('Some project tools could not be stopped')
  }
}
