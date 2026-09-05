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
    expect(read.revision).toMatch(/^sha256:[a-f0-9]{64}$/)
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
  // regression: unawaited verifyWorktreePath let ops run on unregistered paths
  it('worktree verification gates every operation', async () => {
    const { git } = await repoContext()
    await expect(git.status('/tmp')).rejects.toThrow('Unknown worktree')
    await expect(git.listAllFiles('/tmp')).rejects.toThrow('Unknown worktree')
    await expect(git.commit('/tmp', 'x')).rejects.toThrow('Unknown worktree')
    await expect(git.diff('/tmp', 'a')).rejects.toThrow('Unknown worktree')
  })

  it('rejects a stale guarded write and returns a fresh revision after saving', async () => {
    const { git, path } = await repoContext()
    const initial = await git.readFile(path, 'f.txt')
    expect(initial.revision).toBeDefined()
    writeFileSync(join(path, 'f.txt'), 'external\n')

    await expect(git.writeFile(path, 'f.txt', 'editor\n', initial.revision)).rejects.toThrow(
      'Write conflict: f.txt changed on disk'
    )
    expect(readFileSync(join(path, 'f.txt'), 'utf8')).toBe('external\n')

    const current = await git.readFile(path, 'f.txt')
    const saved = await git.writeFile(path, 'f.txt', 'editor\n', current.revision)
    expect(saved.revision).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(saved.revision).not.toBe(current.revision)
  })

  it('serializes competing guarded writes so only one revision wins', async () => {
    const { git, path } = await repoContext()
    const revision = (await git.readFile(path, 'f.txt')).revision
    const results = await Promise.allSettled([
      git.writeFile(path, 'f.txt', 'first\n', revision),
      git.writeFile(path, 'f.txt', 'second\n', revision)
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected?.status === 'rejected' ? String(rejected.reason) : '').toContain('Write conflict:')
    expect(['first\n', 'second\n']).toContain(readFileSync(join(path, 'f.txt'), 'utf8'))
  })

  it('never issues revisions for partial snapshots or accepts them for guarded writes', async () => {
    const { git, path } = await repoContext()
    writeFileSync(join(path, 'large.txt'), Buffer.alloc(512 * 1024 + 1, 97))
    const preview = await git.readFile(path, 'large.txt')
    expect(preview.truncated).toBe(true)
    expect(preview.content).toHaveLength(512 * 1024)
    expect(preview.revision).toBeUndefined()
    await expect(git.writeFile(path, 'large.txt', 'unsafe', `sha256:${'0'.repeat(64)}`)).rejects.toThrow(
      'partial or truncated'
    )
    await expect(git.writeFile(path, 'large.txt', 'agent whole-file write')).resolves.toMatchObject({
      content: 'agent whole-file write',
      truncated: false
    })
  })
})
