import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitWorktrees } from '../src/main/git'
import { Store } from '../src/main/store'

function sh(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd })
}

function makeRepo(): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'donwells-write-'))
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
afterEach(() => { for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true }) })

async function repoContext(): Promise<{ git: GitWorktrees; path: string }> {
  const { root, path } = makeRepo()
  cleanup.push(root)
  const storeDir = mkdtempSync(join(tmpdir(), 'donwells-write-store-'))
  cleanup.push(storeDir)
  const store = new Store(storeDir)
  const git = new GitWorktrees(store)
  await git.addRepo(path)
  return { git, path }
}

describe('GitWorktrees.writeFile', () => {
  it('round-trips new and existing files inside the worktree', async () => {
    const { git, path } = await repoContext()
    mkdirSync(join(path, 'src'))
    await git.writeFile(path, 'src/new.ts', 'export const x = 1\n')
    expect(readFileSync(join(path, 'src', 'new.ts'), 'utf8')).toBe('export const x = 1\n')
    await git.writeFile(path, 'f.txt', 'two\n')
    const read = await git.readFile(path, 'f.txt')
    expect(read.content).toBe('two\n')
    expect(read.bytes).toBe(4)
  })

  it('refuses traversal outside the worktree, for read and write alike', async () => {
    const { git, path } = await repoContext()
    await expect(git.writeFile(path, '../escape.txt', 'x')).rejects.toThrow('escapes worktree')
    await expect(git.readFile(path, '../../../etc/passwd')).rejects.toThrow('escapes worktree')
    await expect(git.writeFile('/tmp', '/abs.txt', 'x')).rejects.toThrow()
  })

  it('rejects a path whose parent directory does not exist', async () => {
    const { git, path } = await repoContext()
    await expect(git.writeFile(path, 'nope/deep/file.ts', 'x')).rejects.toThrow('No such directory')
  })
})
