import type { Worktree } from '@shared/types'

/**
 * Worktree name retirement (upstream worktree-name-retirement rule): once a
 * worktree name is deleted in a repo, that name never comes back — recreating
 * "feature/x" yields "feature-x-2", never "feature/x" again. Prevents the
 * classic confusion where a fresh worktree silently reuses an old identity
 * (stale agent prompts, cached panes, muscle-memory terminals).
 *
 * The registry is per repo id and persisted (monotonic, never pruned).
 */

/** Names already claimed: live worktrees (by branch AND dir name) + retired set. */
export function takenNames(worktrees: Worktree[], retired: ReadonlySet<string>): Set<string> {
  const taken = new Set(retired)
  for (const w of worktrees) {
    taken.add(worktreeDirName(w.path))
    if (w.branch) taken.add(w.branch)
  }
  return taken
}

/** Directory segment of a worktree path (its on-disk identity). */
export function worktreeDirName(worktreePath: string): string {
  const parts = worktreePath.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] ?? worktreePath
}

/**
 * Uniquify a requested worktree name against live + retired names.
 * Collision policy: append `-2`, `-3`, … (matching upstream's suffix scheme).
 * Returns the first free name; never mutates inputs.
 */
export function uniquifyWorktreeName(requested: string, taken: ReadonlySet<string>): string {
  if (!taken.has(requested)) return requested
  for (let n = 2; ; n++) {
    const candidate = `${requested}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

/** Record a removal: the name is retired forever in this repo. Returns the new set. */
export function retireWorktreeName(
  repoRetired: ReadonlySet<string>,
  worktreePath: string,
  branch?: string
): Set<string> {
  const next = new Set(repoRetired)
  next.add(worktreeDirName(worktreePath))
  if (branch) next.add(branch)
  return next
}