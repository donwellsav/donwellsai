import { describe, expect, it } from 'vitest'
import type { RepoSummary } from '../src/shared/types'
import {
  moveWorkspaceNavigation,
  normalizeWorkspaceNavigation,
  orderedWorkspacePaths,
  restoreWorkspaceNavigation
} from '../src/renderer/src/workspace-navigation'

const main = '/workspace/product'
const feature = '/workspace/product-feature'
const notes = '/workspace/notes'

function repositories(): RepoSummary[] {
  return [
    {
      repo: { id: 'product', path: main, addedAt: '2026-09-04T09:00:00.000Z', kind: 'git' },
      worktrees: [
        { id: 'main', path: main, branch: 'main', isMain: true },
        { id: 'feature', path: feature, branch: 'feat/navigation', isMain: false }
      ],
      defaultBranch: 'main'
    },
    {
      repo: { id: 'notes', path: notes, addedAt: '2026-09-04T09:00:00.000Z', kind: 'folder' },
      worktrees: [{ id: 'notes', path: notes, branch: '', isMain: true }],
      defaultBranch: ''
    }
  ]
}

describe('workspace navigation state', () => {
  it('prunes stale identities while preserving user order and normalized labels', () => {
    const state = normalizeWorkspaceNavigation({
      collapsedRepoIds: ['missing', 'product', 'product'],
      pinnedPaths: ['/missing', feature, feature],
      order: [notes, '/missing', main, notes],
      renames: { [feature]: '  Navigation   Lab  ', '/missing': 'Ghost' },
      hiddenPaths: [main, '/missing', main]
    }, repositories())

    expect(state).toEqual({
      collapsedRepoIds: ['product'],
      pinnedPaths: [feature],
      order: [notes, main],
      renames: { [feature]: 'Navigation Lab' },
      hiddenPaths: [main]
    })
    expect(orderedWorkspacePaths(repositories(), state)).toEqual([notes, main, feature])
  })

  it('reorders only within valid bounds and restores one hidden workspace without disturbing others', () => {
    const state = normalizeWorkspaceNavigation({ order: [main, feature, notes], hiddenPaths: [main, notes] }, repositories())
    const moved = moveWorkspaceNavigation(state, repositories(), feature, 1)
    expect(moved.order).toEqual([main, notes, feature])
    expect(moveWorkspaceNavigation(moved, repositories(), main, -1)).toBe(moved)

    const restored = restoreWorkspaceNavigation(moved, main)
    expect(restored.hiddenPaths).toEqual([notes])
    expect(restoreWorkspaceNavigation(restored).hiddenPaths).toEqual([])
  })
})
