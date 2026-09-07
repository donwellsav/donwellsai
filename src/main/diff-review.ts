import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { resolveExistingFile, assertPathMatchesDescriptor } from './worktree-files'
import {
  parseDiffReviewCreateRequest,
  parseDiffReviewDeleteRequest,
  parseDiffReviewListRequest,
  parseDiffReviewNote,
  parseDiffReviewTarget,
  parseDiffReviewUpdateRequest,
  parseDiffReviewWorkspacePath,
  type DiffReviewRunState,
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
  runs?: (workspacePath: string) => Promise<Record<string, DiffReviewRunState>>
  now?: () => Date
  createId?: () => string
}

/** Authorized facade: every operation re-resolves a currently registered workspace. */
export class DiffReviewService {
  readonly store: DiffReviewStore
  private readonly resolveWorkspace: DiffReviewWorkspaceResolver
  private readonly now: () => Date
  private readonly createId: () => string

  constructor(userDataDir: string, private options: DiffReviewServiceOptions) {
    if (!options?.resolveWorkspace) throw new Error('DiffReviewService requires a registered-workspace resolver')
    this.store = new DiffReviewStore(userDataDir)
    this.resolveWorkspace = options.resolveWorkspace
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? randomUUID
  }

  async list(value: DiffReviewListRequest): Promise<DiffReviewListResult> {
    const request = parseDiffReviewListRequest(value)
    const target = await this.authorizedTarget(request)
    const notes = this.store.list(target)
    if (!notes.some(note => note.runLink)) return { target, notes }
    const runs = await this.options.runs?.(target.workspacePath) ?? {}
    const runStates = Object.fromEntries(notes.filter(note => note.runLink).map(note => {
      const linked = runs[note.runLink!.runId + ':' + note.runLink!.taskId]
      return [note.id, linked?.sourceFingerprint === note.runLink!.sourceFingerprint ? linked : null]
    }))
    if (await this.authorizedWorkspace(request.workspacePath) !== target.workspacePath) throw new Error('Review workspace changed while resolving runs')
    return { target, notes, runStates }
  }

  async create(value: DiffReviewCreateRequest): Promise<DiffReviewNote> {
    const request = parseDiffReviewCreateRequest(value)
    const target = await this.authorizedTarget(request)
    let runLink
    if (request.runLink) {
      const run = (await this.options.runs?.(target.workspacePath))?.[request.runLink.runId + ':' + request.runLink.taskId]
      if (!run?.sourceFingerprint) throw new Error('Selected run has no captured source identity in this checkout')
      runLink = { ...request.runLink, sourceFingerprint: run.sourceFingerprint }
      if (await this.authorizedWorkspace(request.workspacePath) !== target.workspacePath) throw new Error('Review workspace changed while linking run')
    }
    const now = this.timestamp()
    const note = parseDiffReviewNote({
      ...(runLink ? { runLink } : {}),
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

/** Hash an explicitly attached reference only inside the checkout or its owned browser artifact roots. */
export async function hashVerificationArtifact(path: string, roots: string[]): Promise<{path:string;sha256:string;bytes:number}> {
  if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096) throw new Error('An absolute artifact path is required')
  for (const candidate of roots) {
    const root=await realpath(candidate).catch(()=>null)
    if (!root) continue
    const local=relative(root,path)
    if (!local || local==='..' || local.startsWith('..'+sep) || isAbsolute(local)) continue
    const absolute=await resolveExistingFile(root,local),handle=await open(absolute,constants.O_RDONLY|(constants.O_NOFOLLOW??0))
    try {
      const before=await handle.stat()
      if (!before.isFile() || before.size>512*1024*1024) throw new Error('Artifact must be a regular file no larger than 512 MiB')
      await assertPathMatchesDescriptor(absolute,root,before,local)
      const hash=createHash('sha256');let bytes=0
      for await (const chunk of handle.createReadStream({autoClose:false})) { bytes+=chunk.length;if(bytes>512*1024*1024)throw new Error('Artifact grew beyond the limit');hash.update(chunk) }
      const after=await handle.stat()
      await assertPathMatchesDescriptor(absolute,root,after,local)
      if (before.size!==after.size || before.mtimeMs!==after.mtimeMs || before.ctimeMs!==after.ctimeMs || bytes!==after.size) throw new Error('Artifact changed while hashing')
      return {path:absolute,sha256:hash.digest('hex'),bytes}
    } finally {await handle.close()}
  }
  throw new Error('Artifact is outside this checkout and its owned browser evidence')
}
