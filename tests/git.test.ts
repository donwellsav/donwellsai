import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitWorktrees, parseWorktreePorcelain } from '../src/main/git'
import { parseStatusPorcelainV2Z } from '../src/main/git-status'
import { Store, idFromPath } from '../src/main/store'

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

const NUL = String.fromCharCode(0)
const LF = String.fromCharCode(10)
const HASH_A = 'a'.repeat(40)
const HASH_B = 'b'.repeat(40)
const HASH_C = 'c'.repeat(40)

describe('parseStatusPorcelainV2Z', () => {
  it('preserves unusual and renamed paths while deriving branch state and sections', () => {
    const renamed = 'new "quoted"' + LF + 'name.ts'
    const original = 'old -> name.ts'
    const untracked = 'tab' + String.fromCharCode(9) + 'line.txt'
    const output = [
      '# branch.oid ' + HASH_A,
      '# branch.head feature/x',
      '# branch.upstream origin/feature/x',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 ' + HASH_A + ' ' + HASH_A + ' src/a.ts',
      '2 R. N... 100644 100644 100644 ' + HASH_A + ' ' + HASH_B + ' R100 ' + renamed,
      original,
      '? ' + untracked,
      'u UU N... 100644 100644 100644 100644 ' + HASH_A + ' ' + HASH_B + ' ' + HASH_C + ' conflicted.ts',
      ''
    ].join(NUL)
    const status = parseStatusPorcelainV2Z(output)

    expect(status).toMatchObject({
      branch: 'feature/x',
      detached: false,
      upstream: 'origin/feature/x',
      ahead: 2,
      behind: 1,
      staged: 1,
      modified: 1,
      untracked: 1,
      conflicts: 1
    })
    expect(status.entries?.map((entry) => ({ path: entry.path, originalPath: entry.originalPath, kind: entry.kind }))).toEqual([
      { path: 'src/a.ts', originalPath: undefined, kind: 'ordinary' },
      { path: renamed, originalPath: original, kind: 'renamed' },
      { path: untracked, originalPath: undefined, kind: 'untracked' },
      { path: 'conflicted.ts', originalPath: undefined, kind: 'conflict' }
    ])
  })

  it('reports detached and unborn repositories authoritatively', () => {
    const detached = parseStatusPorcelainV2Z([
      '# branch.oid ' + HASH_A,
      '# branch.head (detached)',
      ''
    ].join(NUL))
    expect(detached).toMatchObject({ branch: '', detached: true, headOid: HASH_A })

    const unborn = parseStatusPorcelainV2Z([
      '# branch.oid (initial)',
      '# branch.head main',
      ''
    ].join(NUL))
    expect(unborn).toMatchObject({ branch: 'main', detached: false })
    expect(unborn.headOid).toBeUndefined()
  })
})

const gitCleanup: string[] = []
afterEach(() => {
  for (const path of gitCleanup.splice(0)) rmSync(path, { recursive: true, force: true })
})

async function gitFileContext(): Promise<{ git: GitWorktrees; repo: string }> {
  const root = mkdtempSync(join(tmpdir(), 'donwells-git-ref-'))
  gitCleanup.push(root)
  const repo = join(root, 'repo')
  mkdirSync(repo)
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo })
  writeFileSync(join(repo, 'f.txt'), 'committed\n')
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
  const git = new GitWorktrees(new Store(join(root, 'store')))
  await git.addRepo(repo)
  return { git, repo }
}

describe('GitWorktrees.readFileAtRef', () => {
  it('reads HEAD normally and an empty ref from the index', async () => {
    const { git, repo } = await gitFileContext()
    writeFileSync(join(repo, 'f.txt'), 'staged\n')
    execFileSync('git', ['add', 'f.txt'], { cwd: repo })

    await expect(git.readFileAtRef(repo, 'f.txt')).resolves.toEqual({ content: 'committed\n' })
    await expect(git.readFileAtRef(repo, 'f.txt', '')).resolves.toEqual({ content: 'staged\n' })
    await expect(git.readFileAtRef(repo, 'missing.txt')).resolves.toEqual({ content: null })
    await expect(git.readFileAtRef(repo, 'f.txt', 'missing-ref')).resolves.toEqual({ content: null })
  })

  it('bounds git object reads and propagates object database failures', async () => {
    const { git, repo } = await gitFileContext()
    writeFileSync(join(repo, 'large.txt'), Buffer.alloc(512 * 1024 + 1, 120))
    execFileSync('git', ['add', 'large.txt'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'large'], { cwd: repo })
    await expect(git.readFileAtRef(repo, 'large.txt')).rejects.toThrow('exceeds 512 KiB')

    const hash = execFileSync('git', ['rev-parse', 'HEAD:f.txt'], { cwd: repo, encoding: 'utf8' }).trim()
    unlinkSync(join(repo, '.git', 'objects', hash.slice(0, 2), hash.slice(2)))
    await expect(git.readFileAtRef(repo, 'f.txt')).rejects.toThrow()
  })
})

describe('GitWorktrees status and path operations', () => {
  it('reports the actual branch and detached HEAD instead of the first sorted branch', async () => {
    const { git, repo } = await gitFileContext()
    execFileSync('git', ['branch', 'aaa'], { cwd: repo })
    execFileSync('git', ['checkout', '-b', 'feature/z'], { cwd: repo })

    await expect(git.branches(repo)).resolves.toMatchObject({ current: 'feature/z', detached: false })
    execFileSync('git', ['checkout', '--detach', 'HEAD'], { cwd: repo })
    await expect(git.branches(repo)).resolves.toMatchObject({ current: null, detached: true })
    await expect(git.status(repo)).resolves.toMatchObject({ branch: '', detached: true })
  })

  it('round-trips renamed, quoted, tabbed, newline, colon, and backslash paths from real porcelain v2 output', async () => {
    const { git, repo } = await gitFileContext()
    const original = 'old -> "quoted"' + LF + 'name.txt'
    const renamed = 'renamed' + LF + 'name.txt'
    const untracked = 'tab' + String.fromCharCode(9) + 'line' + LF + ':back\\slash.txt'
    writeFileSync(join(repo, original), 'rename me')
    execFileSync('git', ['add', '--', original], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'add unusual path'], { cwd: repo })
    execFileSync('git', ['mv', '--', original, renamed], { cwd: repo })
    writeFileSync(join(repo, untracked), 'new')

    const status = await git.status(repo)
    expect(status.entries?.find((entry) => entry.path === renamed)).toMatchObject({
      originalPath: original,
      kind: 'renamed',
      staged: true
    })
    expect(status.entries?.find((entry) => entry.path === untracked)).toMatchObject({ kind: 'untracked' })
    await expect(git.stage(repo, [untracked])).resolves.toMatchObject({ succeeded: [untracked], failures: [] })
    await expect(git.readFileAtRef(repo, untracked, '')).resolves.toEqual({ content: 'new' })
  })

  it('returns exact partial failures and confines untracked discard to the workspace', async () => {
    const { git, repo } = await gitFileContext()
    const untracked = 'untracked' + LF + 'file.txt'
    const outside = join(repo, '..', 'outside.txt')
    writeFileSync(join(repo, 'f.txt'), 'changed' + LF)
    writeFileSync(join(repo, untracked), 'temporary')
    writeFileSync(outside, 'keep')

    const result = await git.discard(repo, [untracked, '../outside.txt', 'f.txt'])
    expect(result.succeeded).toEqual([untracked, 'f.txt'])
    expect(result.failures).toEqual([{ path: '../outside.txt', error: 'Path escapes workspace: ../outside.txt' }])
    expect(existsSync(join(repo, untracked))).toBe(false)
    expect(readFileSync(join(repo, 'f.txt'), 'utf8')).toBe('committed' + LF)
    expect(readFileSync(outside, 'utf8')).toBe('keep')
  })

  it('stages valid paths while surfacing a missing path, then unstages exactly the success', async () => {
    const { git, repo } = await gitFileContext()
    const path = 'new file.txt'
    writeFileSync(join(repo, path), 'new')

    const staged = await git.stage(repo, [path, 'missing.txt'])
    expect(staged.succeeded).toEqual([path])
    expect(staged.failures).toHaveLength(1)
    expect(staged.failures[0]?.path).toBe('missing.txt')
    const unstaged = await git.unstage(repo, [path])
    expect(unstaged).toEqual({ operation: 'unstage', succeeded: [path], failures: [] })
  })
  it('unstages an added path in an unborn repository without requiring HEAD', async () => {
    const root = mkdtempSync(join(tmpdir(), 'donwells-unborn-git-'))
    gitCleanup.push(root)
    const repo = join(root, 'repo')
    mkdirSync(repo)
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    const git = new GitWorktrees(new Store(join(root, 'store')))
    await git.addRepo(repo)
    writeFileSync(join(repo, 'first.txt'), 'first' + LF)

    await expect(git.stage(repo, ['first.txt'])).resolves.toMatchObject({ succeeded: ['first.txt'], failures: [] })
    await expect(git.unstage(repo, ['first.txt'])).resolves.toMatchObject({ succeeded: ['first.txt'], failures: [] })
    await expect(git.status(repo)).resolves.toMatchObject({ staged: 0, untracked: 1 })
  })
  it('propagates git diff failures instead of returning an empty diff', async () => {
    const root = mkdtempSync(join(tmpdir(), 'donwells-empty-git-'))
    gitCleanup.push(root)
    const repo = join(root, 'repo')
    mkdirSync(repo)
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    const git = new GitWorktrees(new Store(join(root, 'store')))
    await git.addRepo(repo)

    await expect(git.diff(repo, 'missing.txt')).rejects.toThrow(/bad revision|unknown revision|ambiguous argument/i)
  })

  it('reports real merge conflicts as typed conflict entries', async () => {
    const { git, repo } = await gitFileContext()
    execFileSync('git', ['checkout', '-b', 'side'], { cwd: repo })
    writeFileSync(join(repo, 'f.txt'), 'side' + LF)
    execFileSync('git', ['commit', '-am', 'side'], { cwd: repo })
    execFileSync('git', ['checkout', 'main'], { cwd: repo })
    writeFileSync(join(repo, 'f.txt'), 'main' + LF)
    execFileSync('git', ['commit', '-am', 'main'], { cwd: repo })
    try {
      execFileSync('git', ['merge', 'side'], { cwd: repo, stdio: 'pipe' })
    } catch {
      // Expected merge conflict; status is the observable contract under test.
    }

    const status = await git.status(repo)
    expect(status.conflicts).toBe(1)
    expect(status.entries?.find((entry) => entry.path === 'f.txt')).toMatchObject({ kind: 'conflict', conflict: true })
  })
})

describe('GitWorktrees folder and history workflows', () => {
  it('keeps plain folders visible and explicitly disables Git actions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'donwells-folder-'))
    gitCleanup.push(root)
    const folder = join(root, 'workspace')
    mkdirSync(folder)
    writeFileSync(join(folder, 'notes.txt'), 'plain folder' + LF)
    const git = new GitWorktrees(new Store(join(root, 'store')))

    const added = await git.addRepo(folder)
    expect(added.repo.kind).toBe('folder')
    expect(added.worktrees).toEqual([{ id: added.repo.id, path: added.repo.path, branch: '', isMain: true }])
    await expect(git.listAll()).resolves.toEqual([added])
    await expect(git.status(folder)).resolves.toMatchObject({ kind: 'folder', entries: [] })
    await expect(git.listWorkspaceDirectory(folder, { directory: '', showHidden: false, includeIgnored: false }))
      .resolves.toMatchObject({ entries: [{ path: 'notes.txt', name: 'notes.txt', type: 'file' }], truncated: false })
    const search = await git.searchWorkspaceFiles(folder, { query: 'notes', showHidden: false, includeIgnored: false })
    expect(search.matches[0]?.entry.path).toBe('notes.txt')
    const initial = await git.handoffSource(folder)
    expect(initial).toMatchObject({ sourceRevision: null, changedFiles: [] })
    expect(await git.handoffSource(folder)).toEqual(initial)
    writeFileSync(join(folder, 'notes.txt'), 'changed folder content')
    expect((await git.handoffSource(folder)).contentFingerprint).not.toBe(initial.contentFingerprint)
    const changed = await git.handoffSource(folder)
    writeFileSync(join(folder, '.hidden'), 'also part of the source')
    expect((await git.handoffSource(folder)).contentFingerprint).not.toBe(changed.contentFingerprint)
    symlinkSync(join(folder, 'notes.txt'), join(folder, 'link'))
    await expect(git.handoffSource(folder)).rejects.toThrow('links or special files')
    unlinkSync(join(folder, 'link'))
    mkdirSync(join(folder,'node_modules'));symlinkSync(join(folder,'notes.txt'),join(folder,'node_modules','ignored-dependency'))
    const scoped = await git.handoffSource(folder)
    expect(scoped.sourceBasis).toBe('folder-files')
    for (let index = 0; index < 250; index++) writeFileSync(join(folder, `bounded-${index}`), '')
    await expect(git.handoffSource(folder)).resolves.toMatchObject({sourceBasis:'folder-files'})
    for (let index = 0; index < 5; index++) writeFileSync(join(folder,`large-${index}`),Buffer.alloc(7 * 1024 * 1024))
    await expect(git.handoffSource(folder)).rejects.toThrow('exceeds 32 MiB')
    await expect(git.stage(folder, ['file.txt'])).rejects.toThrow('Git actions are unavailable for folder workspace')
    await expect(git.createWorktree(folder, { name: 'feature' })).rejects.toThrow('Git actions are unavailable for folder workspace')
  })

  it('preserves Git ignored-file semantics unless the request opts in', async () => {
    const { git, repo } = await gitFileContext()
    writeFileSync(join(repo, '.gitignore'), '*.log' + LF)
    writeFileSync(join(repo, 'ignored.log'), 'ignored' + LF)
    writeFileSync(join(repo, 'visible.txt'), 'visible' + LF)

    const ordinary = await git.searchWorkspaceFiles(repo, { query: 'ignored', showHidden: false, includeIgnored: false })
    expect(ordinary.matches).toEqual([])
    const optedIn = await git.searchWorkspaceFiles(repo, { query: 'ignored', showHidden: false, includeIgnored: true })
    expect(optedIn.matches[0]?.entry.path).toBe('ignored.log')
  })

  it('pages bounded history and requires explicit amend intent', async () => {
    const { git, repo } = await gitFileContext()
    for (const subject of ['second', 'third']) {
      writeFileSync(join(repo, 'f.txt'), subject + LF)
      execFileSync('git', ['add', 'f.txt'], { cwd: repo })
      execFileSync('git', ['commit', '-m', subject], { cwd: repo })
    }

    const first = await git.history(repo, { limit: 2 })
    expect(first.commits.map((commit) => commit.subject)).toEqual(['third', 'second'])
    expect(first.nextCursor).toBe(first.commits[1]?.oid)
    const second = await git.history(repo, { limit: 2, cursor: first.nextCursor })
    expect(second.commits.map((commit) => commit.subject)).toEqual(['init'])
    expect(second.nextCursor).toBeUndefined()

    writeFileSync(join(repo, 'f.txt'), 'amended' + LF)
    execFileSync('git', ['add', 'f.txt'], { cwd: repo })
    await git.commit(repo, 'third amended', { amend: true })
    expect(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: repo, encoding: 'utf8' }).trim()).toBe('third amended')
    expect(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()).toBe('3')
  })

  it('fetches, fast-forwards, and pushes only against an isolated local remote', async () => {
    const { git, repo } = await gitFileContext()
    const root = join(repo, '..')
    const remote = join(root, 'remote.git')
    const peer = join(root, 'peer')
    execFileSync('git', ['init', '--bare', remote])
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: repo })
    await git.push(repo)
    execFileSync('git', ['clone', remote, peer])
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: peer })
    execFileSync('git', ['config', 'user.name', 't'], { cwd: peer })
    writeFileSync(join(peer, 'remote.txt'), 'remote')
    execFileSync('git', ['add', 'remote.txt'], { cwd: peer })
    execFileSync('git', ['commit', '-m', 'remote advance'], { cwd: peer })
    execFileSync('git', ['push'], { cwd: peer })

    await expect(git.fetch(repo)).resolves.toBeTruthy()
    await expect(git.pull(repo)).resolves.toBeTruthy()
    expect(readFileSync(join(repo, 'remote.txt'), 'utf8')).toBe('remote')
  })
})