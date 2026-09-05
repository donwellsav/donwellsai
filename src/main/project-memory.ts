import { randomUUID } from 'node:crypto'
import {
  PROJECT_MEMORY_DEFAULT_RESULT_LIMIT,
  PROJECT_MEMORY_MAX_HISTORY_REVISIONS,
  parseProjectMemoryArchiveRequest,
  parseProjectMemoryCreateRequest,
  parseProjectMemoryEntry,
  parseProjectMemoryGetRequest,
  parseProjectMemoryHistoryRequest,
  parseProjectMemoryListRequest,
  parseProjectMemoryProject,
  parseProjectMemoryProvenance,
  parseProjectMemoryUpdateRequest,
  type ProjectMemoryApi,
  type ProjectMemoryArchiveRequest,
  type ProjectMemoryAttributionInput,
  type ProjectMemoryCreateRequest,
  type ProjectMemoryEntry,
  type ProjectMemoryGetRequest,
  type ProjectMemoryHistoryRequest,
  type ProjectMemoryHistoryResult,
  type ProjectMemoryListRequest,
  type ProjectMemoryListResult,
  type ProjectMemoryProject,
  type ProjectMemoryProvenance,
  type ProjectMemoryUpdateRequest
} from '@shared/project-memory'
import { ProjectMemoryStore } from './project-memory-store'

export type ProjectMemoryResolver = (workspacePath: string) => Promise<ProjectMemoryProject>

export type ProjectMemoryServiceOptions = {
  now?: () => Date
  createId?: () => string
  onChanged?: (project: ProjectMemoryProject) => void
}

/**
 * Resolves every request through the registered-project authority before
 * accessing the single app-owned store. Resolver failures are intentionally
 * propagated; memory never falls back to an unregistered or remote path.
 */
export class ProjectMemoryService implements ProjectMemoryApi {
  private readonly store: ProjectMemoryStore
  private readonly now: () => Date
  private readonly createId: () => string
  private readonly onChanged?: (project: ProjectMemoryProject) => void

  constructor(
    userDataDir: string,
    private readonly resolveProject: ProjectMemoryResolver,
    options: ProjectMemoryServiceOptions = {}
  ) {
    this.store = new ProjectMemoryStore(userDataDir)
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? randomUUID
    this.onChanged = options.onChanged
  }

  async projectMemoryList(value: ProjectMemoryListRequest): Promise<ProjectMemoryListResult> {
    const request = parseProjectMemoryListRequest(value)
    const project = await this.projectFor(request.workspacePath)
    const result = this.store.list(project.projectKey, {
      query: request.query,
      kinds: request.kinds,
      includeArchived: request.includeArchived ?? false,
      limit: request.limit ?? PROJECT_MEMORY_DEFAULT_RESULT_LIMIT
    })
    return {
      project,
      entries: result.entries,
      total: result.total,
      hasMore: result.total > result.entries.length
    }
  }

  async projectMemoryGet(value: ProjectMemoryGetRequest): Promise<ProjectMemoryEntry> {
    const request = parseProjectMemoryGetRequest(value)
    const project = await this.projectFor(request.workspacePath)
    return this.store.get(project.projectKey, request.id)
  }

  async projectMemoryCreate(value: ProjectMemoryCreateRequest): Promise<ProjectMemoryEntry> {
    const request = parseProjectMemoryCreateRequest(value)
    const project = await this.projectFor(request.workspacePath)
    const createdAt = this.nextTimestamp()
    const entry = parseProjectMemoryEntry({
      id: this.createId(),
      revision: 1,
      kind: request.kind,
      title: request.title,
      content: request.content,
      tags: request.tags ?? [],
      provenance: this.provenance(request.attribution, request.workspacePath),
      createdAt,
      updatedAt: createdAt,
      archivedAt: null
    })
    const created = this.store.create(project, entry)
    this.notifyChanged(project)
    return created
  }

  async projectMemoryUpdate(value: ProjectMemoryUpdateRequest): Promise<ProjectMemoryEntry> {
    const request = parseProjectMemoryUpdateRequest(value)
    const project = await this.projectFor(request.workspacePath)
    const current = this.store.get(project.projectKey, request.id)
    const updated = this.store.replace(project, request.id, request.expectedRevision, {
      kind: request.kind,
      title: request.title,
      content: request.content,
      tags: request.tags ?? [],
      provenance: this.provenance(request.attribution, request.workspacePath),
      updatedAt: this.nextTimestamp(current.updatedAt)
    })
    this.notifyChanged(project)
    return updated
  }

  async projectMemoryHistory(value: ProjectMemoryHistoryRequest): Promise<ProjectMemoryHistoryResult> {
    const request = parseProjectMemoryHistoryRequest(value)
    const project = await this.projectFor(request.workspacePath)
    const history = this.store.history(
      project.projectKey,
      request.id,
      request.limit ?? PROJECT_MEMORY_MAX_HISTORY_REVISIONS + 1
    )
    return {
      project,
      entryId: history.entry.id,
      createdAt: history.entry.createdAt,
      revisions: history.revisions,
      truncated: history.truncated
    }
  }

  async projectMemoryArchive(value: ProjectMemoryArchiveRequest): Promise<ProjectMemoryEntry> {
    const request = parseProjectMemoryArchiveRequest(value)
    const project = await this.projectFor(request.workspacePath)
    const current = this.store.get(project.projectKey, request.id)
    const updated = this.store.setArchived(project, request.id, request.expectedRevision, {
      archived: request.archived,
      provenance: this.provenance(request.attribution, request.workspacePath),
      updatedAt: this.nextTimestamp(current.updatedAt)
    })
    this.notifyChanged(project)
    return updated
  }

  private async projectFor(workspacePath: string): Promise<ProjectMemoryProject> {
    const resolved = await this.resolveProject(workspacePath)
    return parseProjectMemoryProject(resolved, 'resolved project memory identity')
  }

  private provenance(
    attribution: ProjectMemoryAttributionInput,
    workspacePath: string
  ): ProjectMemoryProvenance {
    return parseProjectMemoryProvenance({
      harness: attribution.harness,
      sourceSession: attribution.sourceSession ?? null,
      sourceRef: attribution.sourceRef ?? null,
      workspace: workspacePath
    })
  }

  private notifyChanged(project: ProjectMemoryProject): void {
    try {
      this.onChanged?.(project)
    } catch {
      // Persistence already committed; an observer cannot roll it back.
    }
  }

  private nextTimestamp(previous?: string): string {
    const current = this.now().getTime()
    if (!Number.isFinite(current)) throw new Error('Project memory clock returned an invalid date')
    const minimum = previous === undefined ? current : Date.parse(previous) + 1
    return new Date(Math.max(current, minimum)).toISOString()
  }
}
