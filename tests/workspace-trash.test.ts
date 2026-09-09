import { expect, it } from 'vitest'
import { mkdtemp, writeFile, readFile, rm, rename, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorktreeFiles } from '../src/main/worktree-files'

it('retains files when Trash fails and hands the validated path to Trash on success', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'donwells-trash-')))
  try {
    const file = join(root, 'draft.txt'), trashed = join(root, 'recoverable.txt')
    await writeFile(file, 'preserve me')
    const files = new WorktreeFiles()
    await expect(files.deleteWorkspaceEntry(root, { path: 'draft.txt' }, async () => { throw new Error('Trash unavailable') })).rejects.toThrow('Trash unavailable')
    expect(await readFile(file, 'utf8')).toBe('preserve me')
    await files.deleteWorkspaceEntry(root, { path: 'draft.txt' }, async path => { expect(path).toBe(file); await rename(path, trashed) })
    expect(await readFile(trashed, 'utf8')).toBe('preserve me')
    await expect(files.deleteWorkspaceEntry(root, { path: '../escape' }, async () => { throw new Error('must not execute') })).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})
