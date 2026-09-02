import type { Worktree } from '@shared/types'

/**
 * Worktree lineage (upstream worktree-lineage model): which branch each
 * worktree was created FROM. Enables "reset to base" walks and
 * removal-impact reporting ("removing feature/x strands feature/x-2 which
 * was cut from it").
 *
 * Keyed by branch name (worktrees are 1:1 with their branch here); value is
 * the base branch at creation time. Persisted per repo. Pruning drops
 * entries whose branch no longer exists in the live scan.
 */

export type Lineage = Record<string, string>

/** Record lineage when creating a worktree: branch ← base. */
export function recordLineage(lineage: Lineage, branch: string, base: string | undefined): Lineage {
  if (!base || base === branch) return lineage
  return { ...lineage, [branch]: base }
}

/**
 * Ancestor walk: [branch, parent, grandparent, …] stopping at the repo root
 * (branch absent from lineage), a cycle, or a missing link.
 */
export function ancestryOf(lineage: Lineage, branch: string): string[] {
  const chain: string[] = [branch]
  const seen = new Set(chain)
  let cur = branch
  while (true) {
    const parent = lineage[cur]
    if (!parent || seen.has(parent)) break
    chain.push(parent)
    seen.add(parent)
    cur = parent
  }
  return chain
}

/**
 * Prune lineage to branches that still exist in the live scan.
 * Main worktree branch is always retained as the root anchor.
 */
export function pruneLineage(lineage: Lineage, worktrees: Worktree[]): Lineage {
  const live = new Set(worktrees.map((w) => w.branch))
  const next: Lineage = {}
  for (const [branch, base] of Object.entries(lineage)) {
    if (live.has(branch) && live.has(base)) next[branch] = base
  }
  return next
}

/**
 * Removal impact: descendants (transitive children) of a branch about to be
 * removed — they still exist but their base is going away.
 */
export function descendantsOf(lineage: Lineage, branch: string): string[] {
  const childrenByBase = new Map<string, string[]>()
  for (const [b, base] of Object.entries(lineage)) {
    const list = childrenByBase.get(base) ?? []
    list.push(b)
    childrenByBase.set(base, list)
  }
  const out: string[] = []
  const queue = [branch]
  const seen = new Set(queue)
  while (queue.length) {
    const cur = queue.shift()!
    for (const child of childrenByBase.get(cur) ?? []) {
      if (!seen.has(child)) {
        seen.add(child)
        out.push(child)
        queue.push(child)
      }
    }
  }
  return out
}