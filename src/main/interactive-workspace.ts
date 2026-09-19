import { readFileSync, realpathSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runProcess } from '@shared/child-process/run-process'
import { TaskAuthorityError } from '@shared/task-authority'

/**
 * Authorizes one interactive provider-launch workspace against the app's own
 * persisted repository registry (`donwells-data.json`), read fresh on every
 * launch so added/removed repositories and later-created worktrees are
 * reflected immediately. This is separate from the Backlog migration's
 * `projects.json` registry, which stays opt-in and migration-only.
 */
export async function resolveInteractiveWorkspace(userDataDir: string, workspacePath: string): Promise<{ projectId: string; repositoryId: string; workspaceRoot: string }> {
  let workspaceRoot: string
  try {
    workspaceRoot = realpathSync.native(workspacePath)
  } catch {
    throw new TaskAuthorityError('AUTHORIZATION_DENIED', 'the workspace is not a registered project')
  }
  let envelope: unknown
  try {
    envelope = JSON.parse(readFileSync(join(userDataDir, 'donwells-data.json'), 'utf8'))
  } catch {
    throw new TaskAuthorityError('AUTHORIZATION_DENIED', 'the workspace is not a registered project')
  }
  if (typeof envelope !== 'object' || envelope === null) {
    throw new TaskAuthorityError('AUTHORIZATION_DENIED', 'invalid app repository registry')
  }
  const repos = (envelope as { repos?: unknown }).repos
  if (!Array.isArray(repos)) {
    throw new TaskAuthorityError('AUTHORIZATION_DENIED', 'invalid app repository registry')
  }
  const registered = new Map<string, string>()
  for (const repo of repos) {
    if (typeof repo !== 'object' || repo === null || typeof repo.id !== 'string' || typeof repo.path !== 'string') {
      throw new TaskAuthorityError('AUTHORIZATION_DENIED', 'invalid app repository registration')
    }
    if (!existsSync(repo.path)) continue
    registered.set(realpathSync.native(repo.path), repo.id)
  }
  const projectId = registered.get(workspaceRoot)
  if (projectId !== undefined) return { projectId, repositoryId: projectId, workspaceRoot }
  // A linked Git worktree lives outside its registered repository root, so the
  // workspace itself must resolve back to a registered repository. `--show-toplevel`
  // excludes subdirectories of a repository; only a worktree root may launch.
  try {
    const probe = await runProcess({
      program: 'git',
      args: ['-C', workspaceRoot, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
      timeoutMs: 10_000
    })
    const [toplevel, commonDir] = probe.stdout.trim().split('\n')
    if (toplevel && commonDir && realpathSync.native(toplevel) === workspaceRoot) {
      const mainRoot = realpathSync.native(dirname(commonDir))
      const worktreeProjectId = registered.get(mainRoot)
      if (worktreeProjectId !== undefined) return { projectId: worktreeProjectId, repositoryId: worktreeProjectId, workspaceRoot }
    }
  } catch {
    // Not a Git workspace (or Git refused): fall through to the denial.
  }
  throw new TaskAuthorityError('AUTHORIZATION_DENIED', 'the workspace is not a registered project')
}
