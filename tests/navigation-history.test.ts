import { describe, expect, it } from 'vitest'
import { createAppShortcutMatcher, validateAppShortcutOverrides } from '../src/shared/app-commands'
import {
  MAX_NAVIGATION_ENTRIES,
  type NavigationTarget,
  validatePersistedNavigationHistory
} from '../src/shared/navigation-history'
import {
  ensureNavigationHistoryInitialized,
  getPersistedNavigationHistory,
  NavigationHistoryAuthority
} from '../src/renderer/src/navigation-history'

const available = (): boolean => true

function fileTarget(repoId: string, file: string, line?: number): NavigationTarget {
  return {
    repoId,
    worktreePath: `/workspaces/${repoId}`,
    kind: 'file',
    paneKey: `preview:${file}`,
    file,
    ...(line ? { location: { mode: 'edit', line } } : {})
  }
}

describe('NavigationHistoryAuthority', () => {
  it('traverses without self-recording and truncates forward history after a new activation', () => {
    const authority = new NavigationHistoryAuthority()
    expect(authority.completeRestore(undefined, available)).toEqual({ ok: true })
    const first = fileTarget('repo-a', 'src/first.ts', 4)
    const second = fileTarget('repo-a', 'src/second.ts', 8)
    const third = fileTarget('repo-a', 'src/third.ts', 12)
    const branch = fileTarget('repo-a', 'src/branch.ts', 16)
    authority.record(first)
    authority.record(second)
    authority.record(third)

    expect(authority.traverse('repo-a', -1, available)).toEqual(second)
    expect(authority.getSnapshot().projects['repo-a']).toMatchObject({ cursor: 1 })
    expect(authority.getSnapshot().projects['repo-a']?.entries).toHaveLength(3)

    authority.record(branch)
    expect(authority.getSnapshot().projects['repo-a']?.entries).toEqual([first, second, branch])
    expect(authority.traverse('repo-a', 1, available)).toBeUndefined()
  })

  it('skips targets removed from the current workspace topology', () => {
    const authority = new NavigationHistoryAuthority()
    authority.completeRestore(undefined, available)
    const first = fileTarget('repo-a', 'src/first.ts')
    const removed = fileTarget('repo-a', 'src/removed.ts')
    const third = fileTarget('repo-a', 'src/third.ts')
    authority.record(first)
    authority.record(removed)
    authority.record(third)

    const target = authority.traverse('repo-a', -1, (candidate) =>
      candidate.kind !== 'file' || candidate.file !== 'src/removed.ts')

    expect(target).toEqual(first)
    expect(authority.getSnapshot().projects['repo-a']?.cursor).toBe(0)
  })

  it('keeps traversal cursors and MRU switching isolated by project', () => {
    const authority = new NavigationHistoryAuthority()
    authority.completeRestore(undefined, available)
    const a1 = fileTarget('repo-a', 'src/a1.ts')
    const a2 = fileTarget('repo-a', 'src/a2.ts')
    const b1 = fileTarget('repo-b', 'src/b1.ts')
    const b2 = fileTarget('repo-b', 'src/b2.ts')
    authority.record(a1)
    authority.record(a2)
    authority.record(b1)
    authority.record(b2)

    expect(authority.traverse('repo-a', -1, available)).toEqual(a1)
    expect(authority.getSnapshot().projects['repo-a']?.cursor).toBe(0)
    expect(authority.getSnapshot().projects['repo-b']?.cursor).toBe(1)
    expect(authority.cycleMru('repo-b', b2, 1, available)).toEqual(b1)
    expect(authority.cycleMru('repo-b', b2, -1, available)).toEqual(b1)
  })

  it('fails closed on corrupt or oversized persisted history instead of replacing it', async () => {
    const oversizedEntries = Array.from({ length: MAX_NAVIGATION_ENTRIES + 1 }, (_, index) =>
      fileTarget('repo-a', `src/${index}.ts`))
    const persisted = {
      version: 1,
      projectOrder: ['repo-a'],
      projects: {
        'repo-a': { entries: oversizedEntries, cursor: oversizedEntries.length - 1, mru: [] }
      }
    }

    expect(validatePersistedNavigationHistory(persisted)).toMatchObject({ ok: false })
    const authority = new NavigationHistoryAuthority()
    expect(authority.completeRestore(persisted, available)).toMatchObject({ ok: false })
    await authority.waitUntilReady()
    expect(authority.getPhase()).toBe('error')
    expect(() => authority.persistedSnapshot()).toThrow()
  })
})

describe('navigation history initialization', () => {
  it('loads persisted intent once before a non-UI persistence caller can take a snapshot', async () => {
    const target = fileTarget('repo-persisted', 'src/preserved.ts', 9)
    const persisted = {
      version: 1,
      projectOrder: ['repo-persisted'],
      projects: {
        'repo-persisted': { entries: [target], cursor: 0, mru: [target] }
      }
    }
    const load = Promise.withResolvers<unknown>()
    let loads = 0
    const first = ensureNavigationHistoryInitialized(() => {
      loads += 1
      return load.promise
    })
    const second = ensureNavigationHistoryInitialized(async () => {
      loads += 1
      return undefined
    })

    expect(second).toBe(first)
    load.resolve(persisted)
    await first
    expect(loads).toBe(1)
    expect(getPersistedNavigationHistory().projects['repo-persisted']?.entries).toEqual([target])
  })
})

describe('navigation command shortcuts', () => {
  it('registers conflict-free platform shortcuts for history, MRU, and the global navigator', () => {
    expect(validateAppShortcutOverrides({})).toEqual([])
    const match = createAppShortcutMatcher({}, 'mac')
    expect(match({ key: 'f', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true })?.id).toBe('show-project-search')
    expect(match({ key: 'f', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })?.id).toBe('find')

    expect(match({ key: 'ArrowLeft', metaKey: false, ctrlKey: false, altKey: true, shiftKey: false })?.id)
      .toBe('navigate-back')
    expect(match({ key: 'ArrowRight', metaKey: false, ctrlKey: false, altKey: true, shiftKey: false })?.id)
      .toBe('navigate-forward')
    expect(match({ key: 'Tab', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false })?.id)
      .toBe('switch-mru-next')
    expect(match({ key: 'Tab', metaKey: false, ctrlKey: true, altKey: false, shiftKey: true })?.id)
      .toBe('switch-mru-previous')
    expect(match({ key: 'o', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true })?.id)
      .toBe('global-navigator')
  })
})
