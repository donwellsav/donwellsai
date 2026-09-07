import { lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { artifactPath } from '@shared/project-export'
import type { WorktreeFiles } from './worktree-files'

/** Both directions use the existing exclusive file creation boundary; no archive extraction or script execution. */
export async function ensureEnvironmentArtifactParents(files: Pick<WorktreeFiles, 'createWorkspaceEntry'>, root: string, path: string): Promise<void> {
  const parts = artifactPath(path).split('/').slice(0, -1)
  for (let count = 1; count <= parts.length; count++) {
    const relative = parts.slice(0, count).join('/'), absolute = join(root, relative)
    try { await files.createWorkspaceEntry(root, { path: relative, kind: 'dir' }) }
    catch (error) {
      const info = await lstat(absolute).catch(() => null)
      if (!info || !info.isDirectory() || info.isSymbolicLink() || await realpath(absolute) !== absolute) throw error
    }
  }
}
