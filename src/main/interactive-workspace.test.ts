import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveInteractiveWorkspace } from './interactive-workspace'

const directories: string[] = []

function registration(userData: string, directory: string, worktree?: boolean): { userData: string; workspace: string } {
  const repository = join(directory, 'repo')
  mkdirSync(repository, { recursive: true, mode: 0o700 })
  execFileSync('git', ['-C', repository, 'init', '--quiet'])
  execFileSync('git', ['-C', repository, 'commit', '--quiet', '--allow-empty', '-m', 'fixture'], { env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' } })
  const worktreePath = worktree ? join(directory, 'linked') : repository
  if (worktree) execFileSync('git', ['-C', repository, 'worktree', 'add', worktreePath, 'HEAD'])
  writeFileSync(join(userData, 'donwells-data.json'), JSON.stringify({ schemaVersion: 2, repos: [{ id: 'registered-repo', path: repository, addedAt: new Date().toISOString() }], settings: {} }))
  return { userData, workspace: worktree ? worktreePath : repository }
}

describe('interactive workspace authorization', () => {
  it('authorizes registered repositories and linked worktrees', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'interactive-workspace-')))
    directories.push(directory)
    const userData = join(directory, 'profile')
    mkdirSync(userData, { recursive: true, mode: 0o700 })
    for (const worktree of [undefined, true]) {
      const { workspace } = registration(userData, directory, worktree)
      await expect(resolveInteractiveWorkspace(userData, workspace)).resolves.toMatchObject({ projectId: 'registered-repo', repositoryId: 'registered-repo' })
    }
  })

  it('refuses removed and unregistered workspaces with the authoritative error', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'interactive-workspace-')))
    directories.push(directory)
    const userData = join(directory, 'userData')
    mkdirSync(userData, { recursive: true, mode: 0o700 })
    const { workspace } = registration(userData, directory)
    rmSync(join(userData, 'donwells-data.json'))
    await expect(resolveInteractiveWorkspace(userData, workspace)).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' })
    await expect(resolveInteractiveWorkspace(join(userData, 'missing-registration'), workspace)).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' })
    await expect(resolveInteractiveWorkspace(userData, tmpdir())).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' })
  })

  it('ignores repository roots and linked checkouts that no longer exist', async () => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'interactive-workspace-')))
    directories.push(directory)
    const userData = join(directory, 'userData')
    mkdirSync(userData, { recursive: true, mode: 0o700 })
    const { workspace } = registration(userData, directory)
    rmSync(join(directory, 'repo'), { recursive: true, force: true })
    await expect(resolveInteractiveWorkspace(userData, workspace)).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' })
  })
})

afterAll(() => {
  while (directories.length > 0) rmSync(directories.pop() as string, { recursive: true, force: true })
})
