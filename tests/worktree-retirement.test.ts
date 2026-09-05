import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitWorktrees } from '../src/main/git'
import { Store } from '../src/main/store'
import { takenNames, uniquifyWorktreeName, worktreeDirName } from '../src/main/worktree-name-retirement'
import type { Worktree } from '../src/shared/types'

function sh(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd })
}

function makeRepo(): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'donwells-retire-'))
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
  storeDir = mkdtempSync(join(tmpdir(), 'donwells-retire-store-'))
  cleanup.push(storeDir)
  store = new Store(storeDir)
  git = new GitWorktrees(store)
  git.setTrashRoot(join(storeDir, 'trash'))
})
afterEach(() => { for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('worktree name retirement', () => {
  it('pure uniquify: first choice free, collisions suffix -2', () => {
    const taken = new Set(['feature', 'feature-2'])
    expect(uniquifyWorktreeName('feature', taken)).toBe('feature-3')
    expect(uniquifyWorktreeName('other', taken)).toBe('other')
  })

  it('takenNames includes live branch names, dir names, and retired set', () => {
    const wts: Worktree[] = [
      { id: 'a', path: '/r/wt-feat/x', branch: 'feat/x', isMain: false }
    ]
    const taken = takenNames(wts, new Set(['gone']))
    expect(taken.has('feat/x')).toBe(true)
    expect(taken.has('x')).toBe(true)
    expect(taken.has('gone')).toBe(true)
  })
  it('dirName extracts last segment, trimming trailing slashes', () => {
    expect(worktreeDirName('/a/b/wt-feat/')).toBe('wt-feat')
    expect(worktreeDirName('/')).toBe('')
  })

  it('full lifecycle: remove a worktree then recreate — name is suffixed, never reused', async () => {
    const { root, path } = makeRepo()
    cleanup.push(root)
    const summary1 = await git.addRepo(path)
    expect(summary1.worktrees.map((w) => w.branch)).toEqual(['main'])

    await git.createWorktree(path, { name: 'feature' })
    let summary = await git.summarize(path)
    expect(summary.worktrees.map((w) => w.branch)).toContain('feature')

    // remove it (dirty state? worktree is clean — plain remove)
    const wtPath = summary.worktrees.find((w) => w.branch === 'feature')!.path
    await git.removeWorktree(path, wtPath)
    summary = await git.summarize(path)
    expect(summary.worktrees.map((w) => w.branch)).not.toContain('feature')

    // recreate: retired name must NOT come back
    await git.createWorktree(path, { name: 'feature' })
    summary = await git.summarize(path)
    const branches = summary.worktrees.map((w) => w.branch)
    expect(branches).toContain('feature-2')
    expect(branches).not.toContain('feature')

    // and removing feature-2 retires it too — next is feature-3
    const wt2 = summary.worktrees.find((w) => w.branch === 'feature-2')!.path
    await git.removeWorktree(path, wt2)
    await git.createWorktree(path, { name: 'feature' })
    summary = await git.summarize(path)
    const b3 = summary.worktrees.map((w) => w.branch)
    expect(b3).toContain('feature-3')
  })

  it('registry persists across store instances (restart survival)', async () => {
    const { root, path } = makeRepo()
    cleanup.push(root)
    await git.addRepo(path)
    await git.createWorktree(path, { name: 'alpha' })
    const summary = await git.summarize(path)
    const wtPath = summary.worktrees.find((w) => w.branch === 'alpha')!.path
    await git.removeWorktree(path, wtPath)

    const store2 = new Store(storeDir)
    const git2 = new GitWorktrees(store2)
    git2.setTrashRoot(join(storeDir, 'trash'))
    await git2.createWorktree(path, { name: 'alpha' })
    const summary2 = await git2.summarize(path)
    const branches = summary2.worktrees.map((w) => w.branch)
    expect(branches).toContain('alpha-2')
    expect(branches).not.toContain('alpha')
  })

  it('removing a worktree of an unregistered repo is refused (scan fence)', async () => {
    const { root, path } = makeRepo()
    cleanup.push(root)
    const worktreePath = join(root, 'wt-z')
    sh(path, 'worktree', 'add', worktreePath, '-b', 'z')
    await expect(git.removeWorktree(path, worktreePath)).rejects.toThrow()
    expect(readFileSync(join(worktreePath, 'f.txt'), 'utf8')).toBe('one\n')
  })
})