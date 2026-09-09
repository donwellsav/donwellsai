import { installProjectTool } from './project-tool-install'
import { rm } from 'node:fs/promises'
import { ProjectTemporalKnowledge } from './project-temporal-knowledge'
import { ProjectKnowledge } from './project-knowledge'
import type { KnowledgeSelection } from '@shared/project-knowledge'
import type { ProjectHandoffStatus } from '@shared/project-handoff'
import { ProjectSessionHistory, discoverNativeSessionRoots, SESSION_HISTORY_VERSION } from './project-session-history'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, opendir, readdir, realpath, stat, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { WorktreeFiles } from './worktree-files'
import { ProjectTools, resolveProjectToolScope, type ProjectToolDefinition } from './project-tools'
import { PROJECT_TOOL_FIELDS, parseProjectToolConfiguration, type ProjectToolConfiguration, type ProjectDoctorReport } from '@shared/project-doctor'
import { redactDesignCaptureSecrets } from '@shared/design-capture'

export async function measureProjectToolPath(path: string): Promise<{ bytes: number; sizeKind: 'file' | 'directory' }> {
  const root = await realpath(path), info = await stat(root)
  if (info.isFile()) return { bytes: info.size, sizeKind: 'file' }
  if (!info.isDirectory()) throw new Error('Not a regular file or directory')
  let bytes = 0, entries = 0
  const directories = [root]
  // ponytail: inspect at most 10k entries; larger installs show unknown size instead of blocking Settings.
  while (directories.length) {
    const directory = directories.pop()!
    if (await realpath(directory) !== directory) continue
    for await (const entry of await opendir(directory)) {
      if (++entries > 10000) throw new Error('Selected directory exceeds size inspection limit')
      if (entry.isSymbolicLink()) continue
      const target = join(entry.parentPath, entry.name)
      if (entry.isDirectory()) directories.push(target)
      else if (entry.isFile()) { const file = await lstat(target); if (file.isFile()) bytes += file.size }
    }
  }
  return { bytes, sizeKind: 'directory' }
}

/** Project configuration routes to the existing MCP owners; changing it stops those owners first. */
export class ProjectDoctor {
  private readonly files = new WorktreeFiles()
  private readonly discovered = new Map<string, ProjectToolConfiguration>()
  private readonly owners = new Map<string, Promise<ProjectTools>>()
  private readonly histories = new Map<string, ProjectSessionHistory>()
  private readonly temporalOwners = new Map<string, ProjectTemporalKnowledge>()
  private readonly knowledgeOwners = new Map<string, ProjectKnowledge>()
  private readonly revisions = new Map<string, string | null>()
  private readonly changing = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
  private closed = false
  constructor(
    private readonly directory: string,
    private readonly resolveWorkspace: (path: string) => Promise<{ path: string; projectPath: string }>,
    private readonly defaults: (projectPath: string) => ProjectToolConfiguration,
    private readonly definitions: (config: ProjectToolConfiguration, projectPath: string) => ProjectToolDefinition[],
    private readonly historyCache = join(directory, 'history'),
    private readonly knowledgeSources?: { profile: string; graphitiPassword?(projectKey: string): string | null; handoff(path: string, id: string): Promise<ProjectHandoffStatus> }
  ) {}

  private async location(path: string) {
    const scope = await resolveProjectToolScope(path, this.resolveWorkspace)
    const directory = join(this.directory, scope.projectKey)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    return { ...scope, directory: await realpath(directory) }
  }

  private async snapshot(directory: string, name = 'tools.json') {
    const exists = await lstat(join(directory, name)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
    if (!exists) return { revision: null, content: null }
    const file = await this.files.readFile(directory, name)
    if (file.binary || file.truncated || !file.revision || file.bytes > 65536) throw new Error('Project tool configuration is not bounded readable text')
    return { revision: file.revision, content: file.content }
  }

  private async read(directory: string, projectPath: string) {
    const snapshot = await this.snapshot(directory)
    // Keep discovery stable for the lifetime of the project owners; rediscover on app restart.
    if (!this.discovered.has(projectPath)) this.discovered.set(projectPath, parseProjectToolConfiguration(this.defaults(projectPath)))
    try { return { ...snapshot, configuration: parseProjectToolConfiguration({ ...this.discovered.get(projectPath), ...(snapshot.content === null ? {} : parseProjectToolConfiguration(JSON.parse(snapshot.content))) }) } }
    catch { throw new Error('Project tool configuration is invalid; repair it or review a saved backup') }
  }

  async previewBackup(path: string, name: string): Promise<ProjectToolConfiguration> {
    if (typeof name !== 'string' || !/^tools-backup-[a-f0-9-]{36}\.json$/.test(name)) throw new Error('Invalid tool backup name')
    const scope = await this.location(path), snapshot = await this.snapshot(scope.directory, name)
    if (snapshot.content === null) throw new Error('Tool backup no longer exists')
    try { return parseProjectToolConfiguration(JSON.parse(snapshot.content)) }
    catch { throw new Error('Tool backup contains invalid configuration') }
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
    let configurationValid = true
    try { ({ configuration, revision } = await this.read(scope.directory, scope.projectPath)) } catch { configurationValid = false; revision = (await this.snapshot(scope.directory).catch(() => null))?.revision ?? null; problem = 'Cannot read project tool configuration. Restore a valid backup or repair this file, then recheck.' }
    const backups = (await Promise.all((await readdir(scope.directory)).filter(name => /^tools-backup-[a-f0-9-]{36}\.json$/.test(name)).map(async name => ({ name, createdAt: await stat(join(scope.directory, name)).then(info => info.mtime.toISOString(), () => '') })))).filter(backup => backup.createdAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100)
    const resources = await Promise.all((Object.keys(PROJECT_TOOL_FIELDS) as Array<keyof typeof PROJECT_TOOL_FIELDS>).filter(field => configuration[field]).map(async field => {
      try { return { field, ...await measureProjectToolPath(configuration[field]!), problem: null } }
      catch (error) { return { field, bytes: null, problem: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Missing path' : 'Cannot access selected path' } }
    }))
    const availableDiskBytes = await statfs(scope.directory).then(info => info.bavail * info.bsize, () => null)
    let services: ProjectDoctorReport['services'] = []
    if (!problem) try { services = await (await this.owner(path)).list(path) } catch (error) { problem = redactDesignCaptureSecrets(String(error)) }
    if (problem && this.owners.has(scope.projectKey)) services = await (await this.owners.get(scope.projectKey)!).list(path).catch(() => [])
    if (this.histories.has(scope.projectKey) || (configurationValid && configuration.historyBinary && !configuration.disabled.includes('history'))) services.push({ id: 'history', status: await this.histories.get(scope.projectKey)?.isIndexing(path).catch(() => false) ? 'starting' : 'stopped', version: SESSION_HISTORY_VERSION, detail: 'Finite native indexing job; Reindex verifies the selected binary and roots.' })
    const discovered = discoverNativeSessionRoots([scope.projectPath, scope.checkoutPath])
    return { discoveredHistoryRoots: { historyOmpRoots: discovered.omp, historyDshRoots: discovered['deepseek-harness'], historyHermesRoots: discovered.hermes, historyKimiRoots: discovered.kimi }, workspacePath: scope.projectPath, configuration, revision, configurationPath: join(scope.directory, 'tools.json'), configurationValid, backups, problem, resources, availableDiskBytes,
      services: services.map(service => ({ ...service, detail: service.detail ? redactDesignCaptureSecrets(service.detail) : null })) }
  }

  async configure(path: string, input: unknown, expectedRevision: string | null): Promise<ProjectDoctorReport> {
    const configuration = parseProjectToolConfiguration(input), scope = await this.location(path)
    if (this.closed || this.changing.has(scope.projectKey)) throw new Error('Project tool configuration is already changing')
    const settled = Promise.withResolvers<void>()
    this.changing.set(scope.projectKey, settled)
    try {
      const current = await this.snapshot(scope.directory)
      if (current.revision !== expectedRevision) throw new Error('Tool configuration changed; reload before applying')
      await Promise.all([(async () => (await this.owners.get(scope.projectKey))?.close())(), this.histories.get(scope.projectKey)?.close(), this.knowledgeOwners.get(scope.projectKey)?.close(), this.temporalOwners.get(scope.projectKey)?.close()])
      // Keep failed termination owners retained: their close must succeed before any replacement can launch.
      this.owners.delete(scope.projectKey)
      this.revisions.delete(scope.projectKey)
      this.histories.delete(scope.projectKey)
      this.knowledgeOwners.delete(scope.projectKey)
      this.temporalOwners.delete(scope.projectKey)
      if ((await this.location(path)).projectKey !== scope.projectKey) throw new Error('Project changed while configuring tools')
      if (current.content !== null) await this.files.createWorkspaceEntry(scope.directory, { kind: 'file', path: `tools-backup-${randomUUID()}.json`, content: current.content })
      const content = JSON.stringify(configuration, null, 2) + '\n'
      if (current.revision) await this.files.writeFile(scope.directory, 'tools.json', content, current.revision)
      else await this.files.createWorkspaceEntry(scope.directory, { kind: 'file', path: 'tools.json', content })
    } finally { this.changing.delete(scope.projectKey); settled.resolve() }
    return this.inspect(path)
  }

  async setup(path: string, field: string, revision: string | null) {
    const scope = await this.location(path)
    const current = await this.read(scope.directory, scope.projectPath)
    if (current.revision !== revision) throw new Error('Configuration changed; recheck before setup')
    if (current.configuration[field as keyof ProjectToolConfiguration]) throw new Error('This component already has a configured path; preserve or clear that override before setup')
    const installed = await installProjectTool(field, join(scope.directory, 'installed'))
    try { return await this.configure(path, { ...current.configuration, [field]: installed.path }, revision) }
    catch (cause) {
      const latest = await this.read(scope.directory, scope.projectPath).catch(() => null)
      if (latest && latest.configuration[field as keyof ProjectToolConfiguration] !== installed.path) await rm(installed.directory, { recursive: true, force: true })
      throw cause
    }
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
      history = new ProjectSessionHistory({ binary: config.historyBinary, analyticsPython: config.duckdbPython, cache: this.historyCache, roots: { omp: config.historyOmpRoots, 'deepseek-harness': config.historyDshRoots, hermes: config.historyHermesRoots, kimi: config.historyKimiRoots } }, async requested => {
        const current = await resolveProjectToolScope(requested, this.resolveWorkspace)
        if (current.projectKey !== scope.projectKey) throw new Error('History belongs to another project')
        return current
      })
      this.histories.set(scope.projectKey, history)
    }
    return history
  }
  async historyIndex(path: string) { return (await this.history(path)).index(path) }
  async historySearch(path: string, query: string, requestId?: string) { return (await this.history(path)).search(path, query, requestId) }
  async historySearchCancel(path: string, requestId: string) { return (await this.history(path)).cancelSearch(path, requestId) }
  async historyGet(path: string, id: string, page?: import('@shared/project-session-history').SessionHistoryPage) { return (await this.history(path)).get(path, id, page) }
  async historyAnalytics(path: string, options?: import('@shared/project-session-history').SessionAnalyticsOptions) { return (await this.history(path)).analytics(path, options) }
  async historyAnalyticsCancel(path: string, requestId: string) { return (await this.history(path)).cancelAnalytics(path, requestId) }
  async historyAnalyticsProgress(path: string, requestId: string) { return (await this.history(path)).analyticsProgress(path, requestId) }

  private async knowledge(path: string, restart = false): Promise<ProjectKnowledge> {
    const scope = await this.location(path), config = await this.configuration(path)
    if (this.closed || this.changing.has(scope.projectKey)) throw new Error('Knowledge is stopped for configuration changes')
    if (!config.hindsight || !this.knowledgeSources) throw new Error('Configure the local Hindsight endpoint and selected model first')
    let owner = this.knowledgeOwners.get(scope.projectKey)
    if (owner && !owner.matches(config.hindsight)) { await owner.close(); this.knowledgeOwners.delete(scope.projectKey); owner = undefined }
    if (!owner || (restart && owner.stopped)) {
      owner = new ProjectKnowledge(this.knowledgeSources.profile, config.hindsight, async requested => {
        const current = await resolveProjectToolScope(requested, this.resolveWorkspace)
        if (current.projectKey !== scope.projectKey) throw new Error('Knowledge belongs to another project')
        return current
      }, this.knowledgeSources.handoff)
      this.knowledgeOwners.set(scope.projectKey, owner)
    }
    return owner
  }
  async knowledgeImport(path: string, selection: import('@shared/project-knowledge').KnowledgeSelection[], archiveBase64: string, facts: number) { return (await this.knowledge(path)).importTransfer(path, selection, archiveBase64, facts) }
  async knowledgeExport(path: string) { return (await this.knowledge(path)).exportTransfer(path) }
  async knowledgeStatus(path: string) { return (await this.knowledge(path)).status(path) }
  async knowledgeReconcile(path: string, sources: KnowledgeSelection[]) { return (await this.knowledge(path, true)).reconcile(path, sources) }
  async knowledgeRecall(path: string, query: string) { return (await this.knowledge(path)).recall(path, query) }
  async knowledgeReflect(path: string, query: string) { return (await this.knowledge(path)).reflect(path, query) }
  async knowledgeStop(path: string) { const scope = await this.location(path); await this.knowledgeOwners.get(scope.projectKey)?.close() }

  private async temporal(path: string, restart = false): Promise<ProjectTemporalKnowledge> {
    const scope = await this.location(path), config = await this.configuration(path)
    if (this.closed || this.changing.has(scope.projectKey)) throw new Error('Temporal knowledge is stopped for configuration changes')
    if (!config.graphiti || !this.knowledgeSources) throw new Error('Configure Graphiti Python, Neo4j and local models first')
    let owner = this.temporalOwners.get(scope.projectKey)
    if (owner && !owner.matches(config.graphiti)) { await owner.close(); this.temporalOwners.delete(scope.projectKey); owner = undefined }
    if (!owner || (restart && owner.stopped)) {
      owner = new ProjectTemporalKnowledge(this.knowledgeSources.profile, config.graphiti, async requested => {
        const current = await resolveProjectToolScope(requested, this.resolveWorkspace)
        if (current.projectKey !== scope.projectKey) throw new Error('Temporal knowledge belongs to another project')
        return current
      }, () => this.knowledgeSources?.graphitiPassword?.(scope.projectKey) ?? null)
      this.temporalOwners.set(scope.projectKey, owner)
    }
    return owner
  }
  async temporalKnowledgeStatus(path: string) { return (await this.temporal(path)).status(path) }
  async temporalKnowledgeReconcile(path: string, sources: KnowledgeSelection[]) { return (await this.temporal(path, true)).reconcile(path, sources) }
  async temporalKnowledgeQuery(path: string, query: string, asOf?: string) { return (await this.temporal(path)).query(path, query, asOf) }
  async temporalKnowledgeStop(path: string) { const scope = await this.location(path); await this.temporalOwners.get(scope.projectKey)?.close() }

  async retry(path: string, id: string) { if (id === 'history') { await this.stop(path, id); await this.historyIndex(path); return { id, status: 'stopped' as const, version: SESSION_HISTORY_VERSION, detail: 'Native history index updated' } } const owner = await this.owner(path); await owner.stop(path, id); return owner.start(path, id) }
  async close() {
    this.closed = true
    await Promise.all([...this.changing.values()].map(change => change.promise))
    const results = await Promise.allSettled([...this.owners.values()].map(async owner => (await owner).close()).concat([...this.histories.values()].map(history => history.close()), [...this.knowledgeOwners.values()].map(owner => owner.close()), [...this.temporalOwners.values()].map(owner => owner.close())))
    if (results.some(result => result.status === 'rejected')) throw new Error('Some project tools could not be stopped')
  }
}
