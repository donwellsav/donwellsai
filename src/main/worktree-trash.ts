import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { join, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { GitError } from './git'

/**
 * Delete-to-trash worktree removal (upstream worktree-trash model):
 * 1. Safety fences run BEFORE any mutation (witness, main-refusal, orphan proof).
 * 2. `git worktree remove` detaches the admin entry (git's own dirty check
 *    applies unless force).
 * 3. If the directory still exists (force removal leaves it when git bailed,
 *    or untracked leftovers), it is MOVED to the trash dir — recoverable —
 *    never rm -rf'd except explicit force.
 *
 * Trash layout: <userData>/trash/<timestamp>-<dirname>-<uuid4-short>/
 */

/** Fence 1: the path must still exist at removal time (witness check). */
export function witnessPathExists(worktreePath: string): void {
  if (!existsSync(worktreePath)) {
    throw new GitError(`Witness check failed: ${worktreePath} no longer exists`)
  }
}

/** Fence 2: refuse the main worktree (repo root) — never removable. */
export function fenceMainWorktree(worktreePath: string, repoPath: string): void {
  if (worktreePath.replace(/\/+$/, '') === repoPath.replace(/\/+$/, '')) {
    throw new GitError('Refusing to remove the main worktree')
  }
}

/**
 * Fence 3: orphan-gitdir proof. A worktree dir may be gone while its admin
 * entry lingers (rm -rf case). Detect: gitdir file points at a missing path.
 * Such orphans are prunable — but only pruned, never trashed (nothing to move).
 */
export function isOrphanWorktree(worktreePath: string, repoPath: string): boolean {
  return !existsSync(worktreePath) && existsSync(join(repoPath, '.git'))
}

/** Move a directory to the trash dir; returns the trash destination. */
export function moveToTrash(worktreePath: string, trashRoot: string): string {
  witnessPathExists(worktreePath)
  mkdirSync(trashRoot, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = join(trashRoot, `${stamp}-${basename(worktreePath)}-${randomUUID().slice(0, 8)}`)
  renameSync(worktreePath, dest)
  return dest
}

