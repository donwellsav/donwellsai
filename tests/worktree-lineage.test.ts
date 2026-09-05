import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitWorktrees } from '../src/main/git'
import { Store } from '../src/main/store'
import { ancestryOf, descendantsOf, pruneLineage, recordLineage } from '../src/shared/worktree-lineage'
import type { Worktree } from '../src/shared/types'

function sh(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd })
}

function makeRepo(): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'donwells-lineage-'))
  const path = join(root, 'repo')
  mkdirSync(path)
  sh(path, 'init', '-b', 'main')
  sh(path, 'config', 'user.email', 't@t')
  sh(path, 'config', 'user.name', 't')
  writeFileSync(join(path, 'f.txt'), 'one\n')
  sh(path, 'add', '.')
  sh(path, 'commit', '-m', 'init')
  return { root, path }
}

const cleanup: string[] = []
let storeDir: string
let store: Store
let git: GitWorktrees

beforeEach(() => {
  cleanup.length = 0
  storeDir = mkdtempSync(join(tmpdir(), 'donwells-lineage-store-'))
  cleanup.push(storeDir)
  store = new Store(storeDir)
  git = new GitWorktrees(store)
  git.setTrashRoot(join(storeDir, 'trash'))
})
afterEach(() => { for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('worktree lineage (pure)', () => {
  it('recordLineage: base recorded, self-references skipped', () => {
    let l: Record<string, string> = {}
    l = recordLineage(l, 'feat', 'main')
    l = recordLineage(l, 'sub', 'feat')
    expect(l).toEqual({ feat: 'main', sub: 'feat' })
    l = recordLineage(l, 'main', 'main')
    expect(l['main']).toBeUndefined()
    l = recordLineage(l, 'x', undefined)
    expect(l['x']).toBeUndefined()
  })

  it('ancestryOf walks to root, stops at cycle', () => {
    const l = { sub: 'feat', feat: 'main', a: 'b', b: 'a' }
    expect(ancestryOf(l, 'sub')).toEqual(['sub', 'feat', 'main'])
    expect(ancestryOf(l, 'a')).toEqual(['a', 'b'])
    expect(ancestryOf(l, 'main')).toEqual(['main'])
  })

  it('pruneLineage keeps only live branch pairs', () => {
    const l = { feat: 'main', dead: 'feat', orphan: 'dead' }
    const wts: Worktree[] = [
      { id: '1', path: '/r', branch: 'main', isMain: true },
      { id: '2', path: '/r/wt-feat', branch: 'feat', isMain: false }
    ]
    expect(pruneLineage(l, wts)).toEqual({ feat: 'main' })
  })

  it('descendantsOf finds transitive children', () => {
    const l = { feat: 'main', sub: 'feat', subsub: 'sub', other: 'main' }
    expect(descendantsOf(l, 'feat').sort()).toEqual(['sub', 'subsub'])
  })
})

describe('worktree lineage (persisted lifecycle)', () => {
  it('createWorktree records lineage; removeWorktree prunes it', async () => {
    const { root, path } = makeRepo()
    cleanup.push(root)
    await git.addRepo(path)
    await git.createWorktree(path, { name: 'feat' })
    let summary = await git.summarize(path)
    const wtFeat = summary.worktrees.find((w) => w.branch === 'feat')!.path

    // nested: create from feat
    await git.createWorktree(path, { name: 'sub', branch: 'feat' })
    summary = await git.summarize(path)
    const lineage = store.getLineage('tmp/lite-nope') // wrong id — must be empty
    expect(Object.keys(lineage).length).toBe(0)

    const repoId = summary.repo.id
    const lin = store.getLineage(repoId)
    expect(lin['feat']).toBe('main')
    expect(lin['sub']).toBe('feat')

    // removal prunes the removed branch's lineage
    const wtSub = summary.worktrees.find((w) => w.branch === 'sub')!.path
    await git.removeWorktree(path, wtSub)
    expect(store.getLineage(repoId)['sub']).toBeUndefined()
    expect(store.getLineage(repoId)['feat']).toBe('main')

    await git.removeWorktree(path, wtFeat)
    expect(store.getLineage(repoId)['feat']).toBeUndefined()
  })

  it('lineage survives restart (persisted in store file)', async () => {
    const { root, path } = makeRepo()
    cleanup.push(root)
    await git.addRepo(path)
    await git.createWorktree(path, { name: 'feat' })
    const repoId = (await git.summarize(path)).repo.id

    const store2 = new Store(storeDir)
    expect(store2.getLineage(repoId)['feat']).toBe('main')
  })
})