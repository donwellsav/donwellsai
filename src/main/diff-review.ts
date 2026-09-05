import { randomUUID } from 'node:crypto'
import {
  parseDiffReviewCreateRequest,
  parseDiffReviewDeleteRequest,
  parseDiffReviewListRequest,
  parseDiffReviewNote,
  parseDiffReviewTarget,
  parseDiffReviewUpdateRequest,
  parseDiffReviewWorkspacePath,
  type DiffReviewCreateRequest,
  type DiffReviewDeleteRequest,
  type DiffReviewListRequest,
  type DiffReviewListResult,
  type DiffReviewNote,
  type DiffReviewTarget,
  type DiffReviewUpdateRequest
} from '@shared/diff-review'
import { DiffReviewStore } from './diff-review-store'

export type DiffReviewWorkspaceResolver = (workspacePath: string) => string | Promise<string>

export type DiffReviewServiceOptions = {
  resolveWorkspace: DiffReviewWorkspaceResolver
  now?: () => Date
  createId?: () => string
}

/** Authorized facade: every operation re-resolves a currently registered workspace. */
export class DiffReviewService {
  readonly store: DiffReviewStore
  private readonly resolveWorkspace: DiffReviewWorkspaceResolver
  private readonly now: () => Date
  private readonly createId: () => string

  constructor(userDataDir: string, options: DiffReviewServiceOptions) {
    if (!options?.resolveWorkspace) throw new Error('DiffReviewService requires a registered-workspace resolver')
    this.store = new DiffReviewStore(userDataDir)
    this.resolveWorkspace = options.resolveWorkspace
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? randomUUID
  }

  async list(value: DiffReviewListRequest): Promise<DiffReviewListResult> {
    const request = parseDiffReviewListRequest(value)
    const target = await this.authorizedTarget(request)
    return { target, notes: this.store.list(target) }
  }

  async create(value: DiffReviewCreateRequest): Promise<DiffReviewNote> {
    const request = parseDiffReviewCreateRequest(value)
    const target = await this.authorizedTarget(request)
    const now = this.timestamp()
    const note = parseDiffReviewNote({
      id: this.createId(),
      target,
      snapshot: request.snapshot,
      anchor: request.anchor,
      body: request.body,
      createdAt: now,
      updatedAt: now,
      revision: 1
    })
    return this.store.create(note)
  }

  async update(value: DiffReviewUpdateRequest): Promise<DiffReviewNote> {
    const request = parseDiffReviewUpdateRequest(value)
    const workspacePath = await this.authorizedWorkspace(request.workspacePath)
    return this.store.update(workspacePath, request.id, request.expectedRevision, request.body, this.timestamp())
  }

  async remove(value: DiffReviewDeleteRequest): Promise<void> {
    const request = parseDiffReviewDeleteRequest(value)
    const workspacePath = await this.authorizedWorkspace(request.workspacePath)
    this.store.remove(workspacePath, request.id, request.expectedRevision)
  }

  private async authorizedTarget(target: DiffReviewTarget): Promise<DiffReviewTarget> {
    const workspacePath = await this.authorizedWorkspace(target.workspacePath)
    return parseDiffReviewTarget({
      workspacePath,
      filePath: target.filePath,
      comparison: target.comparison
    })
  }

  private async authorizedWorkspace(workspacePath: string): Promise<string> {
    const resolved = await this.resolveWorkspace(parseDiffReviewWorkspacePath(workspacePath))
    return parseDiffReviewWorkspacePath(resolved)
  }

  private timestamp(): string {
    const value = this.now()
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('Diff review clock returned an invalid instant')
    return value.toISOString()
  }
}
