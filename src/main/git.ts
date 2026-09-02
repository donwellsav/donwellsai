import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { FileContent, FileEntry, RepoSummary, Worktree, WorktreeStatus } from '@shared/types'
import type { Store } from './store'
import { readRepoWorktreeAdminFingerprint } from './worktree-fingerprint'
import { retireWorktreeName, takenNames, uniquifyWorktreeName } from './worktree-name-retirement'
import { idFromPath } from './store'
import { fenceMainWorktree, isOrphanWorktree, moveToTrash, witnessPathExists } from './worktree-trash'
import { pruneLineage, recordLineage } from './worktree-lineage'

export class GitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitError'
  }
}

function run(repoPath: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd: opts.cwd ?? repoPath, timeout: opts.timeoutMs ?? 30000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new GitError((stderr || stdout || String(err)).trim()))
          return
        }
        resolve(stdout.trim())
      }
    )
  })
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
  const out = await run(repoPath, ['worktree', 'list', '--porcelain'], { timeoutMs: 10000 }).catch(() => '')
  // git resolves symlinks (e.g. /tmp -> /private/tmp on macOS); compare on the
  // real path so the main worktree of a /tmp repo is identified correctly.
  const real = realpathSync(repoPath)
  const worktrees = parseWorktreePorcelain(out, real)
  return worktrees.sort((a, b) => (a.isMain === b.isMain ? 0 : a.isMain ? -1 : 1))
}

export function repoSummary(repoPath: string, worktrees: Worktree[]): { defaultBranch: string; currentBranch?: string } {
  const main = worktrees.find((w) => w.isMain)
  return {
    defaultBranch: main ? main.branch : 'unknown',
    currentBranch: main ? main.branch : undefined
  }
}

async function verifyRepoIsGit(path: string): Promise<void> {
  const out = await run(path, ['rev-parse', '--git-dir']).catch(() => '')
  if (!out) throw new GitError(`Not a git repository: ${path}`)
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
    await verifyRepoIsGit(repoPath)
    const worktrees = await this.listWorktreesCached(repoPath)
    const repoId = idFromPath(repoPath)
    // keep lineage aligned with the live scan: drop dead branch pairs
    this.store.setLineage(repoId, pruneLineage(this.store.getLineage(repoId), worktrees))
    return {
      repo: { id: repoId, path: repoPath, addedAt: new Date().toISOString() },
      worktrees,
      ...repoSummary(repoPath, worktrees)
    }
  }


  /** Ensure a repo directory is a real git repo, then record it. */
  async addRepo(dir: string): Promise<RepoSummary> {
    const normalized = dir.replace(/\/+$/, '')
    await verifyRepoIsGit(normalized)
    const worktrees = await listRepoWorktrees(normalized)
    const summary = {
      repo: { id: idFromPath(normalized), path: normalized, addedAt: new Date().toISOString() },
      worktrees,
      ...repoSummary(normalized, worktrees)
    }
    if (!this.store.listRepos().some((r) => r.id === summary.repo.id)) {
      this.store.addRepo(summary.repo)
    } else {
      this.store.addRepo(summary.repo) // idempotent
    }
    return summary
  }

  removeRepo(repoId: string): void {
    this.store.removeRepo(repoId)
  }

  async createWorktree(
    repoPath: string,
    opts: { name?: string; branch?: string }
  ): Promise<RepoSummary> {
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
    const baseBranch = base ?? repoSummary(repoPath, worktreesBefore).currentBranch
    if (baseBranch) {
      this.store.setLineage(repoId, recordLineage(this.store.getLineage(repoId), wdName, baseBranch))
    }
    this.scanCache.invalidate(repoPath)
    return this.summarize(repoPath)
  }
  async removeWorktree(repoPath: string, worktreePath: string, force = false): Promise<RepoSummary> {
    fenceMainWorktree(worktreePath, repoPath)
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


  async detectAgents(): Promise<{ name: string; command: string; detected: boolean }[]> {
    const candidates = ['codex', 'claude', 'pi', 'opencode', 'cursor-agent', 'qwen-code', 'goose']
    const found = await Promise.all(
      candidates.map(async (c) => ({ name: c, command: c, detected: await this.hasBin(c) }))
    )
    return found.filter((a) => a.detected)
  }

  private hasBin(name: string): Promise<boolean> {
    return new Promise((resolve) => {
      execFile('which', [name], (err) => resolve(!err))
    })
  }

  /** Per-worktree git status: branch + ahead/behind + change counts + changed file paths. */
  async status(worktreePath: string): Promise<WorktreeStatus> {
    verifyWorktreePath(this.store, worktreePath)
    const out = await runWorktree(worktreePath, ['status', '--porcelain', '--branch'])
    return parseStatusPorcelain(out)
  }

  /** List files under a worktree (git-tracked + untracked, ignoring ignored files). */
  async listFiles(worktreePath: string, prefix = ''): Promise<FileEntry[]> {
    verifyWorktreePath(this.store, worktreePath)
    const lsOut = await runWorktree(worktreePath, ['ls-files', '--others', '--exclude-standard', '--', prefix])
    const files = new Set<string>()
    for (const line of lsOut.split('\n')) {
      const rel = line.trim()
      if (rel && rel.startsWith(prefix)) files.add(rel)
    }
    // include untracked dirs collapsed to their top level so explorers stay shallow
    const entries: FileEntry[] = []
    const seenDirs = new Set<string>()
    const base = prefix ? `${prefix}/` : ''
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
    // fs directories that git doesn't know (empty / ignored) still show up
    const abs = join(worktreePath, prefix)
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      for (const name of readdirSync(abs)) {
        const rel = base + name
        if (files.has(rel)) continue
        const st = statSync(join(abs, name))
        entries.push({ path: rel, name, type: st.isDirectory() ? 'dir' : 'file' })
      }
    }
    return entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
  }

  /** Read one file from a worktree, capped at 512 KiB (rendering guard, not a product limit). */
  async readFile(worktreePath: string, relPath: string): Promise<FileContent> {
    verifyWorktreePath(this.store, worktreePath)
    const abs = join(worktreePath, relPath)
    if (!existsSync(abs)) throw new GitError(`No such file: ${relPath}`)
    const st = statSync(abs)
    if (st.isDirectory()) throw new GitError(`${relPath} is a directory`)
    const limit = 512 * 1024
    const buf = readFileSync(abs)
    return {
      path: relPath,
      content: buf.subarray(0, limit).toString('utf8'),
      truncated: buf.length > limit,
      bytes: buf.length
    }
  }
}

/**
 * Parse `git status --porcelain --branch` (v1) into counts + changed paths.
 * Branch line: `## main...origin/main [ahead 1, behind 2]`; worktree lines:
 * `XY path` where X=index, Y=worktree, `??` untracked, `U*`/`*U` conflicts.
 */
export function parseStatusPorcelain(output: string): WorktreeStatus {
  let branch = ''
  let ahead = 0
  let behind = 0
  let staged = 0
  let modified = 0
  let untracked = 0
  let conflicts = 0
  const changedFiles: string[] = []
  const raw: string[] = []

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trimEnd()
    if (!line) continue
    raw.push(line)
    if (line.startsWith('## ')) {
      const rest = line.slice(3)
      const [br, upstream] = rest.split('...')
      branch = br.split(' ')[0] ?? ''
      const upticks = rest.match(/ahead (\d+)/)
      const downticks = rest.match(/behind (\d+)/)
      if (upticks) ahead = Number(upticks[1])
      if (downticks) behind = Number(downticks[1])
      void upstream
      continue
    }
    const x = line[0] ?? ''
    const y = line[1] ?? ''
    const p = line.slice(3)
    if (x === '?' && y === '?') {
      untracked++
      changedFiles.push(p)
    } else {
      if (x === 'U' || y === 'U' || line.startsWith('DD') || line.startsWith('AA')) {
        conflicts++
      } else if (x !== ' ' && x !== '.') {
        staged++
      } else if (y !== ' ' && y !== '.') {
        modified++
      }
      if (p) changedFiles.push(p)
    }
  }
  return { branch, ahead, behind, staged, modified, untracked, conflicts, changedFiles, raw }
}

async function verifyWorktreePath(store: Store, path: string): Promise<void> {
  if (!existsSync(path)) throw new GitError(`Path does not exist: ${path}`)
  const real = realpathSync(path)
  // Accept a registered repo root itself or any worktree git lists for it —
  // linked worktrees live OUTSIDE the repo dir (e.g. ../wt-feature/<name>).
  for (const r of store.listRepos()) {
    if (!existsSync(r.path)) continue
    const rr = realpathSync(r.path)
    if (real === rr) return
    try {
      const wts = await listRepoWorktrees(r.path)
      if (wts.some((w) => realpathSync(w.path) === real)) return
    } catch {
      // not a repo / git unavailable — fall through to next registered repo
    }
  }
  throw new GitError(`Unknown worktree: ${path}`)
}

function runWorktree(worktreePath: string, args: string[]): Promise<string> {
  return run(worktreePath, args, { timeoutMs: 20000 })
}