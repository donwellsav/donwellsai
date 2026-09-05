import { existsSync, lstatSync, realpathSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type {
  FileContent,
  FileEntry,
  GitBranchInfo,
  GitCommit,
  GitHistoryPage,
  GitPathOperation,
  GitPathOperationResult,
  Repo,
  RepoKind,
  RepoSummary,
  Worktree,
  WorktreeStatus
} from '@shared/types'
import { ProcessExecutionError, runProcess } from '@shared/child-process/run-process'
import { rankWorkspaceFiles } from '@shared/file-search'
import {
  MAX_DIRECTORY_ENTRIES,
  MAX_FILE_SEARCH_CANDIDATES,
  type WorkspaceCreateRequest,
  type WorkspaceDeleteRequest,
  type WorkspaceDirectoryRequest,
  type WorkspaceDirectoryResult,
  type WorkspaceDuplicateRequest,
  type WorkspaceFileSearchRequest,
  type WorkspaceFileSearchResult,
  type WorkspaceMoveRequest,
  type WorkspaceMutationResult
} from '@shared/file-workspace'
import { emptyWorkspaceStatus, parseStatusPorcelainV2Z } from './git-status'
import type { Store } from './store'
import { readRepoWorktreeAdminFingerprint } from './worktree-fingerprint'
import { retireWorktreeName, takenNames, uniquifyWorktreeName } from './worktree-name-retirement'
import { idFromPath } from './store'
import { fenceMainWorktree, isOrphanWorktree, moveToTrash, witnessPathExists } from './worktree-trash'
import { pruneLineage, recordLineage } from '@shared/worktree-lineage'
import { PREVIEW_BYTE_LIMIT, WorktreeFiles } from './worktree-files'
import type { BinaryPreviewRequest, BinaryPreviewPayload } from '@shared/media-preview'
import { readBinaryPreview } from './binary-preview'

const HIDDEN_DIRS = new Set([`.git`, `node_modules`, `.DS_Store`])

export class GitError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'GitError'
  }
}

const DEFAULT_GIT_OUTPUT_BYTES = 16 * 1024 * 1024

function gitFailure(error: unknown): GitError {
  if (!(error instanceof ProcessExecutionError)) {
    return error instanceof GitError ? error : new GitError(error instanceof Error ? error.message : String(error), { cause: error })
  }
  const detail = error.result?.stderr.trim() || error.result?.stdout.trim() || error.message
  return new GitError(detail, { cause: error })
}

async function run(
  repoPath: string,
  args: readonly string[],
  opts: { cwd?: string; timeoutMs?: number; raw?: boolean; maxOutputBytes?: number } = {}
): Promise<string> {
  try {
    const result = await runProcess({
      program: 'git',
      args,
      cwd: opts.cwd ?? repoPath,
      timeoutMs: opts.timeoutMs ?? 30_000,
      maxOutputBytes: opts.maxOutputBytes ?? DEFAULT_GIT_OUTPUT_BYTES,
      executionHost: { kind: 'local' }
    })
    return opts.raw ? result.stdout : result.stdout.trim()
  } catch (error) {
    throw gitFailure(error)
  }
}

async function runCapture(
  repoPath: string,
  args: readonly string[],
  options: { timeoutMs?: number; maxOutputBytes?: number } = {}
): Promise<{ failed: boolean; code: number | null; stdout: string; stderr: string }> {
  try {
    const result = await runProcess({
      program: 'git',
      args,
      cwd: repoPath,
      timeoutMs: options.timeoutMs ?? 20_000,
      maxOutputBytes: options.maxOutputBytes ?? PREVIEW_BYTE_LIMIT + 1,
      acceptExitCodes: [0, 1, 128],
      executionHost: { kind: 'local' }
    })
    return { failed: result.code !== 0, code: result.code, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    throw gitFailure(error)
  }
}

interface WorktreeRunOptions {
  timeoutMs?: number
  raw?: boolean
  maxOutputBytes?: number
}

/** Parse `git worktree list --porcelain` output into structured worktrees.
 * The main worktree is the one whose path equals the repo root (it has a
 * branch too — the repo's current branch — so branch presence can't identify it).
 */
export function parseWorktreePorcelain(output: string, mainPath?: string): Worktree[] {
  const entries = output.split(/\n(?=worktree )/)
  const worktrees: Worktree[] = []
  for (const entry of entries) {
    if (!entry.trim()) continue
    const pathMatch = entry.match(/^worktree (.+)$/m)
    const headMatch = entry.match(/^HEAD ([0-9a-f]+)$/m)
    const branchMatch = entry.match(/^branch refs\/heads\/(.+)$/m)
    const detached = /^detached$/m.test(entry)
    const bare = /^bare$/m.test(entry)
    const locked = /^locked(?: .*)?$/m.test(entry)
    if (!pathMatch) continue
    const path = pathMatch[1].replace(/\/+$/, '')
    const main = mainPath?.replace(/\/+$/, '')
    worktrees.push({
      id: idFromPath(path),
      path,
      branch: branchMatch ? branchMatch[1] : `HEAD@${headMatch?.[1]?.slice(0, 7) ?? 'detached'}`,
      head: headMatch?.[1],
      isMain: main ? path === main : false,
      detached,
      bare: bare || undefined,
      locked: locked || undefined
    })
  }
  return worktrees
}

/** Worktree sync: every repo is the source of truth for its own worktrees; repo records in the store are just pointers. */
export async function listRepoWorktrees(repoPath: string): Promise<Worktree[]> {
  if (!existsSync(repoPath)) throw new GitError(`Path does not exist: ${repoPath}`)
  const out = await run(repoPath, ['worktree', 'list', '--porcelain'], { timeoutMs: 10_000 })
  // git resolves symlinks (e.g. /tmp -> /private/tmp on macOS); compare on the
  // real path so the main worktree of a /tmp repo is identified correctly.
  const real = realpathSync(repoPath)
  const worktrees = parseWorktreePorcelain(out, real)
  return worktrees.sort((a, b) => (a.isMain === b.isMain ? 0 : a.isMain ? -1 : 1))
}

export function repoSummary(worktrees: Worktree[]): { defaultBranch: string; currentBranch?: string } {
  const main = worktrees.find((w) => w.isMain)
  return {
    defaultBranch: main ? main.branch : 'unknown',
    currentBranch: main ? main.branch : undefined
  }
}

type WorkspaceIdentity = { path: string; kind: RepoKind }

function canonicalDirectory(path: string): string {
  if (!existsSync(path)) throw new GitError(`Path does not exist: ${path}`)
  const real = realpathSync(path)
  if (!statSync(real).isDirectory()) throw new GitError(`Path is not a directory: ${path}`)
  return real
}

async function classifyWorkspace(path: string): Promise<WorkspaceIdentity> {
  const real = canonicalDirectory(path)
  const probe = await runCapture(real, ['rev-parse', '--is-inside-work-tree'])
  if (!probe.failed && probe.stdout.trim() === 'true') return { path: real, kind: 'git' }
  const detail = (probe.stderr || probe.stdout).trim()
  if (probe.failed && /not a git repository|not a git directory/i.test(detail)) {
    return { path: real, kind: 'folder' }
  }
  if (!probe.failed) return { path: real, kind: 'folder' }
  throw new GitError(detail || `Unable to classify workspace: ${real}`)
}

function folderSummary(repo: Repo): RepoSummary {
  return {
    repo: { ...repo, kind: 'folder' },
    worktrees: [{ id: idFromPath(repo.path), path: repo.path, branch: '', isMain: true }],
    lineage: {},
    defaultBranch: ''
  }
}


/** Scan freshness: 30s TTL, extended by the admin fingerprint when nothing changed externally. */
const SCAN_TTL_MS = 30_000
type ScanEntry = { worktrees: Worktree[]; fingerprint: string | null; scannedAt: number }

export class WorktreeScanCache {
  private entries = new Map<string, ScanEntry>()
  private inflight = new Map<string, Promise<Worktree[]>>()

  invalidate(repoPath: string): void {
    this.entries.delete(repoPath)
  }

  async get(repoPath: string, scan: () => Promise<Worktree[]>): Promise<Worktree[]> {
    const hit = this.entries.get(repoPath)
    const fresh = hit && Date.now() - hit.scannedAt < SCAN_TTL_MS
    if (hit && !fresh) {
      // TTL expired: the fingerprint decides whether a rescan is needed
      const fp = readRepoWorktreeAdminFingerprint(repoPath)
      if (fp !== null && fp === hit.fingerprint) {
        hit.scannedAt = Date.now() // prove-unchanged: extend
        return hit.worktrees
      }
    } else if (fresh) {
      return hit.worktrees
    }
    // fingerprint captured BEFORE the scan — a mid-flight mutation leaves the
    // stored fingerprint stale, so the next probe rescans (upstream ordering rule)
    const fingerprint = readRepoWorktreeAdminFingerprint(repoPath)
    const existing = this.inflight.get(repoPath)
    if (existing) return existing
    const p = scan().then((worktrees) => {
      this.entries.set(repoPath, { worktrees, fingerprint, scannedAt: Date.now() })
      this.inflight.delete(repoPath)
      return worktrees
    })
    this.inflight.set(repoPath, p)
    return p
  }
}
export class GitWorktrees {
  private scanCache = new WorktreeScanCache()
  private files = new WorktreeFiles()
  /** Recovery dir for removed worktrees (wired from main). */
  private trashDir: string | null = null

  constructor(private store: Store) {}

  /** Main wires the userData trash dir after construction. */
  setTrashRoot(dir: string): void {
    this.trashDir = dir
  }

  private get trashRoot(): string {
    if (!this.trashDir) throw new GitError('Trash root not configured')
    return this.trashDir
  }

  /** In-app mutation hook: in-app creates/removes invalidate directly (no fingerprint wait). */
  invalidateScan(repoPath: string): void {
    this.scanCache.invalidate(repoPath)
  }

  /** Cached worktree list — 30s TTL extended by the admin fingerprint gate. */
  private async listWorktreesCached(repoPath: string): Promise<Worktree[]> {
    return this.scanCache.get(repoPath, () => listRepoWorktrees(repoPath))
  }
  async listAll(): Promise<RepoSummary[]> {
    const summaries: RepoSummary[] = []
    for (const repo of this.store.listRepos()) {
      try {
        summaries.push(await this.summarize(repo.path))
      } catch {
        // Repo may be offline/unmounted; skip, renderer can still show the stored repo via listRepos.
      }
    }
    return summaries
  }

  async summarize(repoPath: string): Promise<RepoSummary> {
    const identity = await classifyWorkspace(repoPath)
    const stored = this.store.listRepos().find((repo) => repo.id === idFromPath(identity.path))
    const repo: Repo = {
      id: idFromPath(identity.path),
      path: identity.path,
      addedAt: stored?.addedAt ?? new Date().toISOString(),
      kind: identity.kind
    }
    if (identity.kind === 'folder') return folderSummary(repo)

    const worktrees = await this.listWorktreesCached(identity.path)
    // keep lineage aligned with the live scan: drop dead branch pairs
    const lineage = pruneLineage(this.store.getLineage(repo.id), worktrees)
    this.store.setLineage(repo.id, lineage)
    return {
      repo,
      worktrees,
      lineage,
      ...repoSummary(worktrees)
    }
  }

  /** Record either a Git worktree root or a plain folder workspace. */
  async addRepo(dir: string): Promise<RepoSummary> {
    const identity = await classifyWorkspace(dir)
    const repo: Repo = {
      id: idFromPath(identity.path),
      path: identity.path,
      addedAt: new Date().toISOString(),
      kind: identity.kind
    }
    let summary: RepoSummary
    if (identity.kind === 'git') {
      const worktrees = await listRepoWorktrees(identity.path)
      summary = {
        repo,
        worktrees,
        lineage: {},
        ...repoSummary(worktrees)
      }
    } else {
      summary = folderSummary(repo)
    }
    this.store.addRepo(repo)
    return summary
  }

  removeRepo(repoId: string): void {
    this.store.removeRepo(repoId)
  }

  async createWorktree(
    repoPath: string,
    opts: { name?: string; branch?: string }
  ): Promise<RepoSummary> {
    repoPath = await requireGitWorktree(this.store, repoPath)
    const base = opts.branch?.trim()
    const requested = opts.name?.trim() || (base ? basename(base) : 'feature')
    // retirement: a removed name never returns; collisions suffix -2, -3, …
    const repoId = idFromPath(repoPath)
    const worktreesBefore = await this.listWorktreesCached(repoPath)
    const taken = takenNames(worktreesBefore, this.store.getRetiredNames(repoId))
    const wdName = uniquifyWorktreeName(requested, taken)
    const wtPath = join(repoPath, '..', `wt-${wdName}`)
    const args = ['worktree', 'add', '-b', wdName, wtPath]
    if (base) {
      args.push(base)
    }
    await run(repoPath, args, { timeoutMs: 120000 })
    // lineage: branch ← base at creation. Default base = main worktree branch.
    const baseBranch = base ?? repoSummary(worktreesBefore).currentBranch
    if (baseBranch) {
      this.store.setLineage(repoId, recordLineage(this.store.getLineage(repoId), wdName, baseBranch))
    }
    this.scanCache.invalidate(repoPath)
    return this.summarize(repoPath)
  }
  async removeWorktree(repoPath: string, worktreePath: string, force = false): Promise<RepoSummary> {
    repoPath = await requireGitWorktree(this.store, repoPath)
    // resolve the victim from the live scan (canonical path + branch to retire).
    // compare on realpaths: git prints symlink-resolved paths (/tmp → /private/tmp)
    const worktrees = await this.listWorktreesCached(repoPath)
    // orphan (dir gone) can't realpath — fall back to lexical compare only
    const realTarget = existsSync(worktreePath) ? realpathSync(worktreePath) : null
    const canonical =
      worktrees.find((w) => w.path === worktreePath || w.path === worktreePath.replace(/\/+$/, '')) ??
      worktrees.find((w) => {
        if (realTarget === null) return false
        try {
          return realpathSync(w.path) === realTarget
        } catch {
          return false
        }
      })
    if (!canonical) throw new GitError(`Unknown worktree: ${worktreePath}`)
    const victimDir = canonical.path
    const victimBranch = canonical.branch
    fenceMainWorktree(realTarget ?? victimDir, repoPath)
    fenceMainWorktree(victimDir, worktrees[0]?.path ?? repoPath)

    if (isOrphanWorktree(victimDir, repoPath)) {
      // dir already gone (external rm -rf): prune the lingering admin entry
      await run(repoPath, ['worktree', 'prune'], { timeoutMs: 15000 })
    } else {
      witnessPathExists(victimDir)
      // TRASH-FIRST: git worktree remove deletes the directory outright, so the
      // only recoverable order is move-to-trash BEFORE git learns of it; prune
      // then clears the admin entry. Without force, git's dirty check still
      // applies: probe status first — a dirty non-forced removal refuses before
      // anything moves.
      if (!force) {
        const status = await run(victimDir, ['status', '--porcelain'], { timeoutMs: 15000 }).catch(() => '?? dirty-probe-failed')
        if (status.trim()) {
          throw new GitError(`Cannot remove worktree (dirty?): ${victimDir} has uncommitted changes — use force`)
        }
      }
      try {
        moveToTrash(victimDir, this.trashRoot)
      } catch (e) {
        throw new GitError(`Trashing failed: ${e instanceof Error ? e.message : String(e)}`)
      }
      await run(repoPath, ['worktree', 'prune'], { timeoutMs: 15000 }).catch(async () => {
        // older git prune misses; explicit force-remove of the missing dir clears
        await run(repoPath, ['worktree', 'remove', '--force', victimDir], { timeoutMs: 15000 }).catch(() => {})
      })
    }

    if (this.store.listRepos().some((r) => r.id === idFromPath(repoPath))) {
      this.store.retireNames(idFromPath(repoPath), retireWorktreeName(new Set(), victimDir, victimBranch))
    }
    this.scanCache.invalidate(repoPath)
    return this.summarize(repoPath)
  }


  /** Per-workspace status. Folder workspaces return an explicit non-Git snapshot. */
  async status(worktreePath: string): Promise<WorktreeStatus> {
    const workspace = await resolveWorkspacePath(this.store, worktreePath)
    if (workspace.kind === 'folder') return emptyWorkspaceStatus('folder')
    const out = await runWorktree(workspace.path, [
      'status',
      '--porcelain=v2',
      '--branch',
      '-z',
      '--untracked-files=all'
    ], { raw: true })
    try {
      return parseStatusPorcelainV2Z(out)
    } catch (error) {
      throw new GitError(`Unable to parse Git status: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }

  /** List files under a worktree (git-tracked + untracked, ignoring ignored files). */
  async listFiles(worktreePath: string, prefix = ''): Promise<FileEntry[]> {
    const root = await requireGitWorktree(this.store, worktreePath)
    if (prefix.split('/').some((segment) => HIDDEN_DIRS.has(segment))) throw new GitError(`Invalid path prefix: ${prefix}`)
    await this.files.resolveDirectory(root, prefix)
    const lsArgs = prefix
      ? ['ls-files', '-z', '--others', '--exclude-standard', '--', prefix]
      : ['ls-files', '-z', '--others', '--exclude-standard']
    const trackedArgs = prefix ? ['ls-files', '-z', '--', prefix] : ['ls-files', '-z']
    const [untracked, tracked] = await Promise.all([
      runWorktree(root, lsArgs, { raw: true }),
      runWorktree(root, trackedArgs, { raw: true })
    ])
    const candidates = new Set<string>()
    const base = prefix ? `${prefix}/` : ''
    for (const rel of `${untracked}${tracked}`.split('\0')) {
      if (rel && (!prefix || rel.startsWith(base))) candidates.add(rel)
    }

    const files = new Set<string>()
    const candidateList = [...candidates]
    for (let start = 0; start < candidateList.length; start += 64) {
      const batch = candidateList.slice(start, start + 64)
      const safe = await Promise.all(batch.map((rel) => this.files.isSafeListedPath(root, rel)))
      for (let index = 0; index < batch.length; index++) {
        if (safe[index]) files.add(batch[index])
      }
    }

    const entries: FileEntry[] = []
    const seenDirs = new Set<string>()
    for (const rel of files) {
      const rest = rel.slice(base.length)
      const slash = rest.indexOf('/')
      if (slash === -1) {
        entries.push({ path: rel, name: rest, type: 'file' })
      } else {
        const dir = `${base}${rest.slice(0, slash)}`
        if (!seenDirs.has(dir)) {
          seenDirs.add(dir)
          entries.push({ path: dir, name: rest.slice(0, slash), type: 'dir' })
        }
      }
    }
    for (const item of await this.files.listDirectory(root, prefix)) {
      if (HIDDEN_DIRS.has(item.name)) continue
      const rel = base + item.name
      if (files.has(rel) || seenDirs.has(rel)) continue
      entries.push({ path: rel, name: item.name, type: item.type })
    }
    return entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
  }

  /** Raw recursive file list (QuickOpen wants every safe regular file path). */
  async listAllFiles(worktreePath: string): Promise<FileEntry[]> {
    const root = await requireGitWorktree(this.store, worktreePath)
    const [untracked, tracked] = await Promise.all([
      runWorktree(root, ['ls-files', '-z', '--others', '--exclude-standard'], { raw: true }),
      runWorktree(root, ['ls-files', '-z'], { raw: true })
    ])
    const candidates = [...new Set(`${untracked}${tracked}`.split(String.fromCharCode(0)).filter(Boolean))]
      .slice(0, MAX_FILE_SEARCH_CANDIDATES + 1)
    const entries: FileEntry[] = []
    for (let start = 0; start < candidates.length; start += 64) {
      const batch = candidates.slice(start, start + 64)
      const safe = await Promise.all(batch.map((rel) => this.files.isSafeListedPath(root, rel)))
      for (let index = 0; index < batch.length; index++) {
        const rel = batch[index]
        if (!safe[index] || rel.split('/').some((segment) => HIDDEN_DIRS.has(segment))) continue
        entries.push({ path: rel, name: rel.split('/').pop() ?? rel, type: 'file' })
      }
    }
    return entries
  }

  async listWorkspaceDirectory(
    workspacePath: string,
    request: WorkspaceDirectoryRequest
  ): Promise<WorkspaceDirectoryResult> {
    const workspace = await resolveWorkspacePath(this.store, workspacePath)
    if (!request || typeof request.directory !== 'string'
      || typeof request.showHidden !== 'boolean' || typeof request.includeIgnored !== 'boolean') {
      throw new GitError('Invalid workspace directory request')
    }
    if (workspace.kind === 'folder' || request.includeIgnored) {
      return this.files.listWorkspaceDirectory(workspace.path, request)
    }
    const all = await this.listFiles(workspace.path, request.directory)
    const visible = request.showHidden ? all : all.filter((entry) => !entry.name.startsWith('.'))
    return {
      directory: request.directory,
      entries: visible.slice(0, MAX_DIRECTORY_ENTRIES),
      truncated: visible.length > MAX_DIRECTORY_ENTRIES
    }
  }

  async searchWorkspaceFiles(
    workspacePath: string,
    request: WorkspaceFileSearchRequest
  ): Promise<WorkspaceFileSearchResult> {
    const workspace = await resolveWorkspacePath(this.store, workspacePath)
    if (!request || typeof request.query !== 'string'
      || typeof request.showHidden !== 'boolean' || typeof request.includeIgnored !== 'boolean') {
      throw new GitError('Invalid workspace file search request')
    }
    if (workspace.kind === 'folder' || request.includeIgnored) {
      return this.files.searchWorkspaceFiles(workspace.path, request)
    }
    return rankWorkspaceFiles(await this.listAllFiles(workspace.path), request)
  }

  /** Read a bounded preview. Full stable snapshots carry the only revisions accepted by guarded writes. */
  async readFile(worktreePath: string, relPath: string): Promise<FileContent> {
    const root = await verifyWorktreePath(this.store, worktreePath)
    return this.files.readFile(root, relPath)
  }

  /** File content at HEAD or the index (empty ref). Only an absent object or path maps to null. */
  async readFileAtRef(worktreePath: string, relPath: string, ref = 'HEAD'): Promise<{ content: string | null }> {
    worktreePath = await requireGitWorktree(this.store, worktreePath)
    validateGitPath(relPath)

    let hash: string | null = null
    if (ref === '') {
      const staged = await runWorktree(worktreePath, ['ls-files', '--stage', '-z', '--', relPath])
      const matches = staged.split('\0').filter((record) => record.endsWith(`\t${relPath}`))
      if (matches.length === 0) return { content: null }
      const stageZero = matches.find((record) => /^\d+ [a-f0-9]+ 0\t/.test(record))
      if (!stageZero) throw new GitError(`Cannot read unmerged index entry: ${relPath}`)
      hash = stageZero.match(/^\d+ ([a-f0-9]+) 0\t/)?.[1] ?? null
    } else {
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)) throw new GitError(`Invalid ref: ${ref}`)
      const probe = await runCapture(worktreePath, ['rev-parse', '--verify', '--quiet', `${ref}^{object}`])
      if (probe.failed) {
        if (typeof probe.code === 'number' && !probe.stdout && !probe.stderr) return { content: null }
        throw new GitError((probe.stderr || probe.stdout || `Unable to resolve git ref: ${ref}`).trim())
      }
      const tree = await runWorktree(worktreePath, ['ls-tree', '-z', ref, '--', relPath])
      const record = tree.split('\0').find((entry) => entry.endsWith(`\t${relPath}`))
      if (!record) return { content: null }
      const match = record.match(/^\d+ (\S+) ([a-f0-9]+)\t/)
      if (!match) throw new GitError(`Invalid git tree entry for: ${relPath}`)
      if (match[1] !== 'blob') throw new GitError(`${relPath} is not a regular file at ${ref}`)
      hash = match[2]
    }
    if (!hash) throw new GitError(`Invalid git object for: ${relPath}`)
    const sizeText = await runWorktree(worktreePath, ['cat-file', '-s', hash])
    const size = Number(sizeText)
    if (!Number.isSafeInteger(size) || size < 0) throw new GitError(`Invalid git object size for: ${relPath}`)
    if (size > PREVIEW_BYTE_LIMIT) throw new GitError(`Git object exceeds 512 KiB preview cap: ${relPath}`)
    return {
      content: await run(worktreePath, ['cat-file', '-p', hash], {
        raw: true,
        maxOutputBytes: PREVIEW_BYTE_LIMIT + 1
      })
    }
  }

  /** Serialized whole-file write. expectedRevision enables optimistic conflict protection. */
  async writeFile(worktreePath: string, relPath: string, content: string, expectedRevision?: string): Promise<FileContent> {
    const root = await verifyWorktreePath(this.store, worktreePath)
    return this.files.writeFile(root, relPath, content, expectedRevision)
  }

  /** Resolve a markdown-local image into a verified, bounded data URL. */
  async readPreviewImage(worktreePath: string, documentPath: string, source: string): Promise<string> {
    const root = await verifyWorktreePath(this.store, worktreePath)
    return this.files.readPreviewImage(root, documentPath, source)
  }

  async readBinaryPreview(workspacePath: string, request: BinaryPreviewRequest, signal?: AbortSignal): Promise<BinaryPreviewPayload> {
    return readBinaryPreview(await verifyWorktreePath(this.store, workspacePath), request, signal)
  }

  async createWorkspaceEntry(workspacePath: string, request: WorkspaceCreateRequest): Promise<WorkspaceMutationResult> {
    return this.files.createWorkspaceEntry(await verifyWorktreePath(this.store, workspacePath), request)
  }

  async moveWorkspaceEntry(workspacePath: string, request: WorkspaceMoveRequest): Promise<WorkspaceMutationResult> {
    return this.files.moveWorkspaceEntry(await verifyWorktreePath(this.store, workspacePath), request)
  }

  async duplicateWorkspaceEntry(workspacePath: string, request: WorkspaceDuplicateRequest): Promise<WorkspaceMutationResult> {
    return this.files.duplicateWorkspaceEntry(await verifyWorktreePath(this.store, workspacePath), request)
  }

  async deleteWorkspaceEntry(workspacePath: string, request: WorkspaceDeleteRequest): Promise<WorkspaceMutationResult> {
    return this.files.deleteWorkspaceEntry(await verifyWorktreePath(this.store, workspacePath), request)
  }
  // ── Git operations ───────────────────────────────────────────────────────

  private async operatePaths(
    operation: GitPathOperation,
    paths: readonly string[],
    execute: (path: string) => Promise<void>
  ): Promise<GitPathOperationResult> {
    const result: GitPathOperationResult = { operation, succeeded: [], failures: [] }
    for (const path of new Set(paths)) {
      try {
        validateGitPath(path)
        await execute(path)
        result.succeeded.push(path)
      } catch (error) {
        result.failures.push({ path, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return result
  }

  async stage(worktreePath: string, paths: readonly string[]): Promise<GitPathOperationResult> {
    const root = await requireGitWorktree(this.store, worktreePath)
    return this.operatePaths('stage', paths, (path) => runWorktree(root, ['add', '--', path]).then(() => undefined))
  }

  async unstage(worktreePath: string, paths: readonly string[]): Promise<GitPathOperationResult> {
    const root = await requireGitWorktree(this.store, worktreePath)
    const hasHead = !(await runCapture(root, ['rev-parse', '--verify', 'HEAD'])).failed
    return this.operatePaths('unstage', paths, (path) => {
      const args = hasHead ? ['restore', '--staged', '--', path] : ['rm', '--cached', '--', path]
      return runWorktree(root, args).then(() => undefined)
    })
  }

  /** Discard exact worktree paths. The renderer confirms and flushes dirty editors first. */
  async discard(worktreePath: string, paths: readonly string[]): Promise<GitPathOperationResult> {
    const root = await requireGitWorktree(this.store, worktreePath)
    const status = await this.status(root)
    const entries = status.entries
    if (!entries) throw new GitError('This Git host does not provide typed status entries')
    const byPath = new Map(entries.map((entry) => [entry.path, entry]))
    return this.operatePaths('discard', paths, async (path) => {
      const entry = byPath.get(path)
      if (!entry) throw new GitError('Path has no discardable changes')
      if (entry.kind === 'untracked') {
        removeUntrackedPath(root, path)
        return
      }
      if (entry.conflict) {
        await runWorktree(root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', path])
        return
      }
      if (!entry.unstaged) throw new GitError('Path has no unstaged changes')
      const targets = entry.originalPath ? [entry.originalPath, entry.path] : [entry.path]
      for (const target of targets) validateGitPath(target)
      await runWorktree(root, ['restore', '--worktree', '--', ...targets])
    })
  }

  async commit(worktreePath: string, message: string, options: { amend?: boolean } = {}): Promise<string> {
    const root = await requireGitWorktree(this.store, worktreePath)
    const msg = message.trim()
    if (!msg) throw new GitError('Commit message is empty')
    const args = ['commit']
    if (options.amend) args.push('--amend')
    args.push('-m', msg)
    const out = await runWorktree(root, args, { timeoutMs: 60_000 })
    return out.split(String.fromCharCode(10)).find((line) => line.includes(']'))?.trim() ?? (options.amend ? 'Commit amended' : 'Committed')
  }

  async fetch(worktreePath: string): Promise<string> {
    const root = await requireGitWorktree(this.store, worktreePath)
    return (await runWorktree(root, ['fetch'], { timeoutMs: 120_000 })) || 'Fetch complete'
  }

  /** Push HEAD; sets origin as upstream only when no upstream is configured. */
  async push(worktreePath: string): Promise<string> {
    const root = await requireGitWorktree(this.store, worktreePath)
    const branch = await this.branches(root)
    if (!branch.current) throw new GitError('Cannot push a detached HEAD')
    const upstream = await runCapture(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
    const args = upstream.failed ? ['push', '-u', 'origin', 'HEAD'] : ['push']
    return (await runWorktree(root, args, { timeoutMs: 120_000 })) || 'Push complete'
  }

  async pull(worktreePath: string): Promise<string> {
    const root = await requireGitWorktree(this.store, worktreePath)
    return (await runWorktree(root, ['pull', '--ff-only'], { timeoutMs: 120_000 })) || 'Already up to date'
  }

  async branches(worktreePath: string): Promise<GitBranchInfo> {
    const root = await requireGitWorktree(this.store, worktreePath)
    const [currentOutput, refsOutput, head] = await Promise.all([
      runWorktree(root, ['branch', '--show-current']),
      runWorktree(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
      runCapture(root, ['rev-parse', '--verify', 'HEAD'])
    ])
    const current = currentOutput || null
    const headOid = head.failed ? undefined : head.stdout.trim() || undefined
    return {
      current,
      detached: Boolean(headOid && !current),
      headOid,
      all: refsOutput.split(String.fromCharCode(10)).map((branch) => branch.trim()).filter(Boolean)
    }
  }

  async checkout(worktreePath: string, branch: string): Promise<GitBranchInfo> {
    const root = await requireGitWorktree(this.store, worktreePath)
    const name = branch.trim()
    if (!name) throw new GitError('Branch is empty')
    await validateBranchName(root, name)
    await runWorktree(root, ['checkout', name])
    return this.branches(root)
  }

  async createBranch(worktreePath: string, branch: string, startPoint?: string): Promise<GitBranchInfo> {
    const root = await requireGitWorktree(this.store, worktreePath)
    const name = branch.trim()
    if (!name) throw new GitError('Branch is empty')
    await validateBranchName(root, name)
    const args = ['checkout', '-b', name]
    if (startPoint !== undefined) {
      const base = startPoint.trim()
      if (!/^[A-Za-z0-9][A-Za-z0-9._/~^-]*$/.test(base)) throw new GitError('Invalid branch start point')
      args.push(base)
    }
    await runWorktree(root, args)
    return this.branches(root)
  }

  async history(
    worktreePath: string,
    options: { cursor?: string; limit?: number } = {}
  ): Promise<GitHistoryPage> {
    const root = await requireGitWorktree(this.store, worktreePath)
    const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 30)))
    const branch = await this.branches(root)
    if (!branch.headOid) return { commits: [] }
    const args = [
      'log',
      '-z',
      `--max-count=${limit + 1}`,
      '--format=%H%x00%h%x00%an%x00%aI%x00%s'
    ]
    if (options.cursor) {
      if (!/^[0-9a-f]{40,64}$/i.test(options.cursor)) throw new GitError('Invalid history cursor')
      args.push('--skip=1', options.cursor)
    }
    const output = await runWorktree(root, args, { raw: true, timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024 })
    const commits = parseHistory(output)
    const page = commits.slice(0, limit)
    return {
      commits: page,
      nextCursor: commits.length > limit ? page.at(-1)?.oid : undefined
    }
  }

  /** Unified diff for one path (worktree vs HEAD). Git failures are never reclassified as an empty diff. */
  async diff(worktreePath: string, relPath: string): Promise<string> {
    const root = await requireGitWorktree(this.store, worktreePath)
    validateGitPath(relPath)
    return runWorktree(root, ['diff', 'HEAD', '--', relPath], { timeoutMs: 20_000 })
  }
}

function parseHistory(output: string): GitCommit[] {
  const fields = output.split(String.fromCharCode(0))
  while (fields.at(-1) === '') fields.pop()
  if (fields.length % 5 !== 0) throw new GitError('Git returned a malformed history record')
  const commits: GitCommit[] = []
  for (let index = 0; index < fields.length; index += 5) {
    let oid = fields[index] ?? ''
    while (oid.charCodeAt(0) === 10) oid = oid.slice(1)
    const shortOid = fields[index + 1] ?? ''
    const author = fields[index + 2] ?? ''
    const authoredAt = fields[index + 3] ?? ''
    const subject = fields[index + 4] ?? ''
    if (!/^[0-9a-f]{40,64}$/i.test(oid) || !shortOid || !authoredAt) {
      throw new GitError('Git returned a malformed history record')
    }
    commits.push({ oid, shortOid, author, authoredAt, subject })
  }
  return commits
}

function validateGitPath(relPath: string): string {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.includes(String.fromCharCode(0))) {
    throw new GitError(`Invalid Git path: ${String(relPath)}`)
  }
  const pathSegments = sep === '\\' ? relPath.split(/[\\/]/) : relPath.split('/')
  const windowsAbsolute = sep === '\\' && (relPath.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(relPath))
  if (
    relPath.startsWith('/') ||
    windowsAbsolute ||
    pathSegments.some((part) => part === '..' || part === '.' || part === '')
  ) {
    throw new GitError(`Path escapes workspace: ${relPath}`)
  }
  return relPath
}

function pathIsInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
}

function removeUntrackedPath(root: string, relPath: string): void {
  validateGitPath(relPath)
  const realRoot = realpathSync(root)
  const target = resolve(realRoot, relPath)
  if (!pathIsInside(realRoot, target)) throw new GitError(`Path escapes workspace: ${relPath}`)
  const realParent = realpathSync(dirname(target))
  if (!pathIsInside(realRoot, realParent)) throw new GitError(`Path escapes workspace through a symlink: ${relPath}`)
  const metadata = lstatSync(target)
  if (metadata.isDirectory()) throw new GitError(`Refusing to discard an untracked directory: ${relPath}`)
  rmSync(target)
}

async function resolveWorkspacePath(store: Store, path: string): Promise<WorkspaceIdentity & { projectPath: string }> {
  const real = canonicalDirectory(path)
  // Accept a registered workspace root itself or any worktree Git lists for it.
  // Linked worktrees live outside the registered repo directory.
  for (const repo of store.listRepos()) {
    if (!existsSync(repo.path)) continue
    const registered = realpathSync(repo.path)
    if (real === registered) {
      const kind = repo.kind ?? (await classifyWorkspace(registered)).kind
      return { path: real, kind, projectPath: registered }
    }
    if (repo.kind === 'folder') continue
    try {
      const worktrees = await listRepoWorktrees(registered)
      for (const worktree of worktrees) {
        if (existsSync(worktree.path) && realpathSync(worktree.path) === real) return { path: real, kind: 'git', projectPath: registered }
      }
    } catch {
      // A different registered repo may be offline; it must not authorize this path.
    }
  }
  throw new GitError(`Unknown worktree: ${path}`)
}

export async function resolveRegisteredProjectWorkspace(store: Store, path: string): Promise<WorkspaceIdentity & { projectPath: string }> {
  return resolveWorkspacePath(store, path)
}

export async function verifyWorktreePath(store: Store, path: string): Promise<string> {
  return (await resolveWorkspacePath(store, path)).path
}

async function requireGitWorktree(store: Store, path: string): Promise<string> {
  const workspace = await resolveWorkspacePath(store, path)
  if (workspace.kind !== 'git') throw new GitError(`Git actions are unavailable for folder workspace: ${path}`)
  return workspace.path
}

async function validateBranchName(worktreePath: string, branch: string): Promise<void> {
  const result = await runCapture(worktreePath, ['check-ref-format', '--branch', branch])
  if (result.failed) throw new GitError(`Invalid branch name: ${branch}`)
}

function runWorktree(worktreePath: string, args: readonly string[], opts: WorktreeRunOptions = {}): Promise<string> {
  return run(worktreePath, args, {
    timeoutMs: opts.timeoutMs ?? 20_000,
    raw: opts.raw,
    maxOutputBytes: opts.maxOutputBytes
  })
}