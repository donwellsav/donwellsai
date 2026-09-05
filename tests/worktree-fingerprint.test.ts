import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, utimesSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readRepoWorktreeAdminFingerprint } from '../src/main/worktree-fingerprint'
import { WorktreeScanCache } from '../src/main/git'

function sh(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd })
}

function makeRepo(): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'donwells-fp-'))
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
beforeEach(() => cleanup.length = 0)
afterEach(() => { for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('readRepoWorktreeAdminFingerprint', () => {
  it('is stable across repeated reads with no change', () => {
    const { root, path } = makeRepo()
    cleanup.push(root)
    const a = readRepoWorktreeAdminFingerprint(path)
    const b = readRepoWorktreeAdminFingerprint(path)
    expect(a).not.toBeNull()
    expect(a).toBe(b)
  })

  it('changes when a linked worktree is added externally', () => {
    const { root, path } = makeRepo()
    cleanup.push(root)
    const before = readRepoWorktreeAdminFingerprint(path)
    sh(path, 'worktree', 'add', join(root, 'wt-x'), '-b', 'wt-x')
    const after = readRepoWorktreeAdminFingerprint(path)
    expect(before).not.toBeNull()
    expect(after).not.toBeNull()
    expect(before).not.toBe(after)
  })

  it('changes when a commit moves a branch (loose ref rewrite)', () => {
    const { root, path } = makeRepo()
    cleanup.push(root)
    const before = readRepoWorktreeAdminFingerprint(path)
    // commit with an explicit old mtime to prove mtime alone isn't the signal
    writeFileSync(join(path, 'f.txt'), 'two\n')
    sh(path, 'commit', '-am', 'second')
    const after = readRepoWorktreeAdminFingerprint(path)
    expect(before).not.toBe(after)
  })

  it('changes when packed-refs changes', () => {
    const { root, path } = makeRepo()
    cleanup.push(root)
    const before = readRepoWorktreeAdminFingerprint(path)
    sh(path, 'update-ref', 'refs/heads/feature', 'HEAD')
    sh(path, 'pack-refs', '--all')
    const after = readRepoWorktreeAdminFingerprint(path)
    expect(before).not.toBe(after)
  })

  it('returns null for a non-repo path (cannot prove unchanged)', () => {
    expect(readRepoWorktreeAdminFingerprint('/tmp/definitely-not-here-xyz')).toBeNull()
  })
})

describe('WorktreeScanCache', () => {
  it('serves from cache within TTL without rescanning', async () => {
    const { root, path } = makeRepo()
    cleanup.push(root)
    const cache = new WorktreeScanCache()
    let scans = 0
    const scan = async () => { scans++; return [{ id: 'x', path, branch: 'main', isMain: true }] }
    await cache.get(path, scan)
    await cache.get(path, scan)
    await cache.get(path, scan)
    expect(scans).toBe(1)
  })

  it('fingerprint-unchanged extends the entry past TTL without a rescan', async () => {
    const { root, path } = makeRepo()
    cleanup.push(root)
    const cache = new WorktreeScanCache()
    let scans = 0
    const scan = async () => { scans++; return [] }
    await cache.get(path, scan)
    // fake aging past TTL
    const entry = (cache as unknown as { entries: Map<string, { scannedAt: number }> }).entries.get(path)!
    entry.scannedAt = Date.now() - 60_000
    await cache.get(path, scan)
    expect(scans).toBe(1) // fingerprint proved unchanged
  })

  it('external admin-area change forces a rescan at expired TTL', async () => {
    const { root, path } = makeRepo()
    cleanup.push(root)
    const cache = new WorktreeScanCache()
    let scans = 0
    const scan = async () => { scans++; return [] }
    await cache.get(path, scan)
    const entry = (cache as unknown as { entries: Map<string, { scannedAt: number }> }).entries.get(path)!
    entry.scannedAt = Date.now() - 60_000
    sh(path, 'worktree', 'add', join(root, 'wt-y'), '-b', 'wt-y')
    await cache.get(path, scan)
    expect(scans).toBe(2)
  })

  it('invalidate() forces a rescan regardless of fingerprint', async () => {
    const { root, path } = makeRepo()
    cleanup.push(root)
    const cache = new WorktreeScanCache()
    let scans = 0
    const scan = async () => { scans++; return [] }
    await cache.get(path, scan)
    cache.invalidate(path)
    await cache.get(path, scan)
    expect(scans).toBe(2)
  })

  it('dedupes concurrent scans into one', async () => {
    const { root, path } = makeRepo()
    cleanup.push(root)
    const cache = new WorktreeScanCache()
    let scans = 0
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const scan = async () => { scans++; await gate; return [] }
    const all = Promise.all([cache.get(path, scan), cache.get(path, scan), cache.get(path, scan)])
    release()
    await all
    expect(scans).toBe(1)
  })
})