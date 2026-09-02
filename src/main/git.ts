import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { RepoSummary, Worktree } from '@shared/types'
import type { Store } from './store'
import { idFromPath } from './store'

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

export class GitWorktrees {
  constructor(private store: Store) {}

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
    const worktrees = await listRepoWorktrees(repoPath)
    return {
      repo: { id: idFromPath(repoPath), path: repoPath, addedAt: new Date().toISOString() },
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
    const wdName = opts.name?.trim() || (base ? basename(base) : 'feature')
    const wtPath = join(repoPath, '..', `wt-${wdName}`)
    const args = ['worktree', 'add', '-b', wdName, wtPath]
    if (base) {
      args.push(base)
    }
    await run(repoPath, args, { timeoutMs: 120000 })
    return this.summarize(repoPath)
  }

  async removeWorktree(repoPath: string, worktreePath: string): Promise<RepoSummary> {
    // Safety: never remove the main worktree, never resolve to repoPath itself.
    const canonical = worktreePath.replace(/\/+$/, '')
    if (canonical === repoPath.replace(/\/+$/, '')) {
      throw new GitError('Refusing to remove the main worktree')
    }
    await run(repoPath, ['worktree', 'remove', canonical], { timeoutMs: 30000 }).catch((e: GitError) => {
      throw new GitError(`Cannot remove worktree (dirty?): ${e.message}`)
    })
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
}