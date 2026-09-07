import type { RepoSummary } from './types'

export type CreateProjectRequest = {
  parentPath: string
  name: string
  initializeGit: boolean
  workflow?: 'app-workflow-v1'
}

export const APP_WORKFLOW_FILES = {
  'SPEC.md': '# App specification\n\nWorkflow version: 1.0.0\n\n## Outcome\n\nDescribe who uses the app and the work it must help them finish.\n\n## Acceptance\n\n- [ ] Describe one complete user journey and its observable result.\n- [ ] Record supported platforms and explicit exclusions.\n- [ ] Record recovery behavior when an operation fails.\n',
  'TASKS.md': '# Implementation tasks\n\nWorkflow version: 1.0.0\n\nRead SPEC.md and existing project instructions before changing code.\n\n- [ ] Inspect the current project and confirm the next acceptance requirement.\n- [ ] Implement the smallest complete user journey.\n- [ ] Run the declared check, test and build commands; record actual outcomes.\n- [ ] Exercise the app and its failure/recovery path.\n- [ ] Review the diff, preserve user changes, and record remaining work.\n',
  '.agents/skills/app-workflow/SKILL.md': '---\nname: app-workflow\ndescription: Implement and verify the project specification one complete journey at a time.\nversion: "1.0.0"\n---\n\nRead the project SPEC.md, TASKS.md and existing instructions. Preserve user-authored instructions and decisions. Identify the current task before editing. Reuse existing code and declared package scripts. Run only tools authorized for the project; this document grants no tool access or permission. Record checks, actual app behavior, failures and remaining work in TASKS.md. Never mark a task complete from compilation alone.\n'
} as const

export type ProjectCreationDefaults = {
  parentPath: string
}

export type ProjectCreationApi = {
  createProject(request: CreateProjectRequest): Promise<RepoSummary>
  getProjectCreationDefaults(): Promise<ProjectCreationDefaults>
}

export type ProjectCreationField = keyof CreateProjectRequest

export type ProjectCreationValidation =
  | { ok: true; request: CreateProjectRequest }
  | { ok: false; field: ProjectCreationField; error: string }

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
const INVALID_PROJECT_NAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/
const WINDOWS_ABSOLUTE_PATH = /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function validateProjectName(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return 'Enter a project name.'
  if (value.trim().length === 0) return 'Project name cannot be blank.'
  if (value !== value.trim()) return 'Project name cannot start or end with whitespace.'
  if (value === '.' || value === '..') return 'Project name cannot be “.” or “..”.'
  if (INVALID_PROJECT_NAME_CHARACTERS.test(value)) {
    return 'Project name cannot contain control characters or < > : " / \\ | ? *.'
  }
  if (value.endsWith('.') || value.endsWith(' ')) return 'Project name cannot end with a period or space.'
  if (WINDOWS_RESERVED_NAME.test(value)) return `“${value}” is reserved by the operating system.`
  const utf8Length = new TextEncoder().encode(value).byteLength
  if (value.length > 255 || utf8Length > 255) return 'Project name must be 255 bytes or fewer.'
  return null
}

export function validateProjectParentPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return 'Choose a location.'
  if (value.includes('\u0000')) return 'Location contains an invalid null character.'
  if (!value.startsWith('/') && !WINDOWS_ABSOLUTE_PATH.test(value)) {
    return 'Location must be an absolute folder path.'
  }
  return null
}

export function validateProjectCreationRequest(value: unknown): ProjectCreationValidation {
  if (!isRecord(value)) {
    return { ok: false, field: 'parentPath', error: 'Project creation request must be an object.' }
  }
  const input = value
  const parentPath = input.parentPath
  if (typeof parentPath !== 'string') return { ok: false, field: 'parentPath', error: 'Choose a location.' }
  const parentError = validateProjectParentPath(parentPath)
  if (parentError) return { ok: false, field: 'parentPath', error: parentError }
  const name = input.name
  if (typeof name !== 'string') return { ok: false, field: 'name', error: 'Enter a project name.' }
  const nameError = validateProjectName(name)
  if (nameError) return { ok: false, field: 'name', error: nameError }
  const initializeGit = input.initializeGit
  if (typeof initializeGit !== 'boolean') {
    return { ok: false, field: 'initializeGit', error: 'Git initialization choice must be true or false.' }
  }
  if (input.workflow !== undefined && input.workflow !== 'app-workflow-v1') {
    return { ok: false, field: 'workflow', error: 'Choose a supported project workflow.' }
  }
  return { ok: true, request: { parentPath, name, initializeGit, ...(input.workflow === undefined ? {} : { workflow: input.workflow }) } }
}

/** Renderer-safe display join. Main resolves the same two validated path segments authoritatively. */
export function projectCreationTargetPath(parentPath: string, name: string): string {
  if (!parentPath) return name
  if (!name) return parentPath
  const lastSlash = parentPath.lastIndexOf('/')
  const lastBackslash = parentPath.lastIndexOf('\\')
  const windowsPath = !parentPath.startsWith('/') && WINDOWS_ABSOLUTE_PATH.test(parentPath)
  const separator = windowsPath && lastBackslash >= lastSlash ? '\\' : '/'
  const hasTrailingSeparator = separator === '\\' ? /[\\/]$/.test(parentPath) : parentPath.endsWith('/')
  return parentPath + (hasTrailingSeparator ? '' : separator) + name
}
