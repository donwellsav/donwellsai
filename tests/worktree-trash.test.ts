import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, readdirSync, symlinkSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitWorktrees } from '../src/main/git'
import { Store } from '../src/main/store'
import { fenceMainWorktree, isOrphanWorktree, moveToTrash, pruneTrash, witnessPathExists } from '../src/main/worktree-trash'

function sh(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd })
}

function makeRepo(): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'donwells-trash-'))
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
let trashDir: string
let store: Store
let git: GitWorktrees

beforeEach(() => {
  cleanup.length = 0
  storeDir = mkdtempSync(join(tmpdir(), 'donwells-trash-store-'))
  trashDir = join(storeDir, 'trash')
  cleanup.push(storeDir)
  store = new Store(storeDir)
  git = new GitWorktrees(store)
  git.setTrashRoot(trashDir)
})
afterEach(() => { for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('worktree trash removal', () => {
  it('clean remove: admin entry gone, directory moved to trash (recoverable)', async () => {
    const { root, path } = makeRepo()
    cleanup.push(root)
    await git.addRepo(path)
    await git.createWorktree(path, { name: 'feat' })
    let summary = await git.summarize(path)
    const wtPath = summary.worktrees.find((w) => w.branch === 'feat')!.path
    expect(existsSync(wtPath)).toBe(true)

    await git.removeWorktree(path, wtPath)
    summary = await git.summarize(path)
    expect(summary.worktrees.map((w) => w.branch)).not.toContain('feat')
    // original dir GONE from its old location
    expect(existsSync(wtPath)).toBe(false)
    // but recoverable in trash
    expect(existsSync(trashDir)).toBe(true)
    const trashed = readdirSync(trashDir)
    expect(trashed.length).toBe(1)
    expect(trashed[0]).toContain('wt-feat')
    // trashed copy still holds the worktree's files
    expect(existsSync(join(trashDir, trashed[0]!, 'f.txt'))).toBe(true)
  })

  it('force remove on dirty worktree: git forced, leftovers trashed', async () => {
    const { root, path } = makeRepo()
    cleanup.push(root)
    await git.addRepo(path)
    await git.createWorktree(path, { name: 'dirty' })
    let summary = await git.summarize(path)
    const wtPath = summary.worktrees.find((w) => w.branch === 'dirty')!.path
    writeFileSync(join(wtPath, 'uncommitted.txt'), 'precious\n')

    // plain remove must FAIL (dirty)
    await expect(git.removeWorktree(path, wtPath)).rejects.toThrow(/dirty|Cannot remove/)

    // force remove succeeds and trashes the content
    await git.removeWorktree(path, wtPath, true)
    summary = await git.summarize(path)
    expect(summary.worktrees.map((w) => w.branch)).not.toContain('dirty')
    expect(existsSync(wtPath)).toBe(false)
    const trashed = readdirSync(trashDir)
    expect(trashed.length).toBe(1)
    expect(existsSync(join(trashDir, trashed[0]!, 'uncommitted.txt'))).toBe(true)
  })

  it('preserves the main worktree when forced removal targets a symlink alias', async () => {
    const { root, path } = makeRepo()
    cleanup.push(root)
    await git.addRepo(path)
    const alias = join(root, 'repo-alias')
    symlinkSync(path, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(git.removeWorktree(path, alias, true)).rejects.toThrow()
    expect(readFileSync(join(path, 'f.txt'), 'utf8')).toBe('one\n')
    expect(existsSync(join(path, '.git'))).toBe(true)
    expect(existsSync(trashDir)).toBe(false)
  })

  it('fence: witness check refuses a vanished path', () => {
    expect(() => witnessPathExists('/tmp/definitely-vanished-xyz')).toThrow(/Witness/)
  })

  it('orphan worktree (dir deleted externally) is pruned, not trashed', async () => {
    const { root, path } = makeRepo()
    cleanup.push(root)
    await git.addRepo(path)
    await git.createWorktree(path, { name: 'orphan' })
    let summary = await git.summarize(path)
    const wtPath = summary.worktrees.find((w) => w.branch === 'orphan')!.path
    // simulate rm -rf: directory gone, admin entry lingers
    rmSync(wtPath, { recursive: true, force: true })
    expect(isOrphanWorktree(wtPath, path)).toBe(true)

    await git.removeWorktree(path, wtPath)
    summary = await git.summarize(path)
    expect(summary.worktrees.map((w) => w.branch)).not.toContain('orphan')
    // nothing was trashed (nothing existed to move)
    expect(existsSync(trashDir)).toBe(false)
  })
  it('pruneTrash removes only entries older than retention', () => {
    mkdirSync(join(trashDir, 'old-entry'), { recursive: true })
    mkdirSync(join(trashDir, 'new-entry'), { recursive: true })
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000)
    utimesSync(join(trashDir, 'old-entry'), old, old)
    const pruned = pruneTrash(trashDir, 7 * 24 * 3600 * 1000)
    expect(pruned).toBe(1)
    expect(existsSync(join(trashDir, 'old-entry'))).toBe(false)
    expect(existsSync(join(trashDir, 'new-entry'))).toBe(true)
  })

  it('moveToTrash stamps unique destinations', () => {
    const src = mkdtempSync(join(tmpdir(), 'donwells-src-'))
    cleanup.push(src)
    const a = moveToTrash(src, trashDir)
    expect(existsSync(a)).toBe(true)
  })
})