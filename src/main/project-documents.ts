import type { GitWorktrees } from './git'
import type { ProjectToolScope } from '@shared/project-tools'
import { validateRelativePath } from './worktree-files'

/** QMD references are index identifiers, never permission to read arbitrary filesystem paths. */
export function projectDocumentReference(scope: ProjectToolScope, reference: string, documentRoot: string): string {
  if (typeof reference !== 'string' || reference.length > 4096) throw new Error('Invalid document reference')
  const prefix = reference.startsWith('qmd://') ? 'qmd://project/' : 'project/'
  if (!reference.startsWith(prefix)) throw new Error('Document is outside the project collection')
  const value = reference.slice(prefix.length)
  const path = validateRelativePath(prefix.startsWith('qmd://') ? decodeURIComponent(value) : value)
  // QMD interprets trailing colon numbers as line ranges, so those references are ambiguous.
  if (/:\d+(?::\d+)?$/.test(path)) throw new Error('Document line ranges require a separate line argument')
  const root = validateRelativePath(documentRoot, true)
  return `document:${scope.indexKey}:${encodeURIComponent(root ? `${root}/${path}` : path)}`
}

export async function readProjectDocument(
  workspacePath: string,
  id: string,
  resolveScope: (path: string) => Promise<ProjectToolScope>,
  files: Pick<GitWorktrees, 'readFile'>,
  documentRoot: string
) {
  const scope = await resolveScope(workspacePath)
  const prefix = `document:${scope.indexKey}:`
  if (typeof id !== 'string' || id.length > 8192 || !id.startsWith(prefix)) throw new Error('Document belongs to another checkout')
  const path = validateRelativePath(decodeURIComponent(id.slice(prefix.length)))
  const root = validateRelativePath(documentRoot, true)
  if (root && !path.startsWith(`${root}/`)) throw new Error('Document is outside the selected document root')
  const file = await files.readFile(scope.checkoutPath, path)
  if ((await resolveScope(workspacePath)).indexKey !== scope.indexKey) throw new Error('Document checkout changed while opening')
  return file
}
