import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitWorktrees } from '../src/main/git'
import { Store } from '../src/main/store'

const cleanup: string[] = []
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true })
})

function gitCommand(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd })
}

async function makeContext(): Promise<{ git: GitWorktrees; repo: string; outside: string }> {
  const root = mkdtempSync(join(tmpdir(), 'donwells-confined-'))
  cleanup.push(root)
  const repo = join(root, 'repo')
  const outside = join(root, 'outside')
  mkdirSync(repo)
  mkdirSync(outside)
  gitCommand(repo, 'init', '-b', 'main')
  gitCommand(repo, 'config', 'user.email', 't@t')
  gitCommand(repo, 'config', 'user.name', 't')
  mkdirSync(join(repo, 'docs'))
  writeFileSync(join(repo, 'docs', 'guide.md'), '# Guide\n')
  writeFileSync(join(repo, 'safe.txt'), 'safe\n')
  gitCommand(repo, 'add', '.')
  gitCommand(repo, 'commit', '-m', 'init')

  const storeDir = join(root, 'store')
  const store = new Store(storeDir)
  const git = new GitWorktrees(store)
  await git.addRepo(repo)
  return { git, repo, outside }
}

describe('worktree filesystem confinement', () => {
  it('rejects lexical escapes and pathspec-like prefixes before filesystem or git access', async () => {
    const { git, repo } = await makeContext()
    for (const path of ['../safe.txt', '/etc/passwd', 'C:\\Windows\\win.ini', 'docs/../safe.txt', 'safe.txt\nHEAD']) {
      await expect(git.readFile(repo, path)).rejects.toThrow()
      await expect(git.writeFile(repo, path, 'x')).rejects.toThrow()
    }
    for (const prefix of ['..', '../outside', 'C:\\Windows', ':/**', '.git', 'node_modules', 'docs//nested']) {
      await expect(git.listFiles(repo, prefix)).rejects.toThrow()
    }
  })

  it('never follows file or directory symlinks through reads, writes, or listings', async () => {
    const { git, repo, outside } = await makeContext()
    writeFileSync(join(outside, 'secret.txt'), 'secret\n')
    symlinkSync(join(outside, 'secret.txt'), join(repo, 'secret-link.txt'))
    symlinkSync(outside, join(repo, 'outside-link'), 'dir')

    await expect(git.readFile(repo, 'secret-link.txt')).rejects.toThrow('escapes worktree')
    await expect(git.writeFile(repo, 'secret-link.txt', 'overwrite')).rejects.toThrow('escapes worktree')
    await expect(git.readFile(repo, 'outside-link/secret.txt')).rejects.toThrow('escapes worktree')
    await expect(git.writeFile(repo, 'outside-link/new.txt', 'escape')).rejects.toThrow('escapes worktree')
    await expect(git.listFiles(repo, 'outside-link')).rejects.toThrow('escapes worktree')

    const shallow = await git.listFiles(repo)
    expect(shallow.map((entry) => entry.path)).not.toContain('secret-link.txt')
    expect(shallow.map((entry) => entry.path)).not.toContain('outside-link')
    const recursive = await git.listAllFiles(repo)
    expect(recursive.map((entry) => entry.path)).not.toContain('secret-link.txt')
  })

  it('serves only verified local image bytes as bounded data URLs', async () => {
    const { git, repo, outside } = await makeContext()
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    )
    writeFileSync(join(repo, 'docs', 'logo.png'), png)
    const dataUrl = await git.readPreviewImage(repo, 'docs/guide.md', './logo.png?cache=1')
    expect(dataUrl).toBe(`data:image/png;base64,${png.toString('base64')}`)

    writeFileSync(join(repo, 'docs', 'fake.png'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    writeFileSync(join(outside, 'outside.png'), png)
    symlinkSync(join(outside, 'outside.png'), join(repo, 'docs', 'linked.png'))
    for (const source of [
      '../safe.png',
      '%2e%2e%2fsafe.png',
      '/etc/passwd',
      '//host/image.png',
      'https://host/image.png',
      'https%3A%2F%2Fhost%2Fimage.png'
    ]) {
      await expect(git.readPreviewImage(repo, 'docs/guide.md', source)).rejects.toThrow()
    }
    await expect(git.readPreviewImage(repo, 'docs/guide.md', 'linked.png')).rejects.toThrow('escapes worktree')
    await expect(git.readPreviewImage(repo, 'docs/guide.md', 'fake.png')).rejects.toThrow('mismatched image type')
  })
})
