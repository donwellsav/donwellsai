import { describe, it, expect } from 'vitest'
import { parseStatusPorcelain, parseWorktreePorcelain } from '../src/main/git'
import { idFromPath } from '../src/main/store'

const SAMPLE = `worktree /Users/me/proj
HEAD abc1234def5678
branch refs/heads/main

worktree /Users/me/proj/../wt-feature
HEAD deadbeef1234567
branch refs/heads/feature

worktree /Users/me/proj/_retired_feat
HEAD 00112233aabbccdd
detached

worktree /Users/me/proj-locked
HEAD ffffffffffffffff
branch refs/heads/locked
locked

worktree /Users/me/bare
bare
`

describe('parseWorktreePorcelain', () => {
  it('parses main + linked worktrees with branch and head', () => {
    const wts = parseWorktreePorcelain(SAMPLE, '/Users/me/proj')
    expect(wts).toHaveLength(5)
    const main = wts.find((w) => w.isMain)!
    expect(main.path).toBe('/Users/me/proj')
    expect(main.branch).toBe('main')
    expect(main.head).toBe('abc1234def5678')
    const feature = wts.find((w) => w.branch === 'feature')!
    expect(feature.branch).toBe('feature')
    expect(feature.isMain).toBe(false)
  })

  it('marks detached, locked, and bare entries', () => {
    const wts = parseWorktreePorcelain(SAMPLE, '/Users/me/proj')
    const detached = wts.find((w) => w.detached)!
    expect(detached.detached).toBe(true)
    expect(detached.branch).toContain('HEAD@')
    const locked = wts.find((w) => w.branch === 'locked')!
    expect(locked.locked).toBe(true)
    const bare = wts.find((w) => w.bare)!
    expect(bare.bare).toBe(true)
  })

  it('returns empty array for empty input', () => {
    expect(parseWorktreePorcelain('')).toEqual([])
  })
})

describe('idFromPath', () => {
  it('is stable and filesystem-safe', () => {
    const a = idFromPath('/Users/me/project')
    expect(a).toBe(idFromPath('/Users/me/project'))
    expect(a).toBe(idFromPath('/Users/me/project/'))
    expect(idFromPath('/Users/me/a b')).toBe(idFromPath('/Users/me/a_b'))
    expect(a).not.toContain(' ')
    expect(a).not.toContain(':')
  })
})

describe('parseStatusPorcelain', () => {
  const BRANCH_LINE = '## feature/x...origin/feature/x [ahead 2, behind 1]'

  it('parses branch, ahead/behind, and change counts', () => {
    const out = `${BRANCH_LINE}
 M src/a.ts
A  src/b.ts
?? new-file.txt
UU conflicted.ts
`
    const s = parseStatusPorcelain(out)
    expect(s.branch).toBe('feature/x')
    expect(s.ahead).toBe(2)
    expect(s.behind).toBe(1)
    expect(s.modified).toBe(1)
    expect(s.staged).toBe(1)
    expect(s.untracked).toBe(1)
    expect(s.conflicts).toBe(1)
    expect(s.changedFiles).toEqual(['src/a.ts', 'src/b.ts', 'new-file.txt', 'conflicted.ts'])
  })

  it('returns a clean tree with no branch metadata as zeros', () => {
    const s = parseStatusPorcelain('')
    expect(s.branch).toBe('')
    expect(s.ahead).toBe(0)
    expect(s.behind).toBe(0)
    expect(s.staged + s.modified + s.untracked + s.conflicts).toBe(0)
    expect(s.changedFiles).toEqual([])
  })

  it('counts renames and deletions toward staged/modified without losing paths', () => {
    const out = `## main
R  old.ts -> new.ts
 D gone.ts
`
    const s = parseStatusPorcelain(out)
    expect(s.staged).toBe(1)
    expect(s.modified).toBe(1)
    expect(s.changedFiles).toEqual(['old.ts -> new.ts', 'gone.ts'])
  })
})