export const NAVIGATION_HISTORY_VERSION = 1
export const MAX_NAVIGATION_PROJECTS = 24
export const MAX_NAVIGATION_ENTRIES = 96
export const MAX_NAVIGATION_MRU = 32

export type NavigationLocation = {
  mode?: 'edit' | 'preview'
  line?: number
  column?: number
  anchor?: string
}

export type NavigationTarget =
  | { repoId: string; worktreePath: string; kind: 'workspace' }
  | { repoId: string; worktreePath: string; kind: 'terminal'; paneKey: string; sessionId: string }
  | { repoId: string; worktreePath: string; kind: 'file'; paneKey: string; file: string; location?: NavigationLocation }
  | { repoId: string; worktreePath: string; kind: 'browser'; paneKey: string }
  | { repoId: string; worktreePath: string; kind: 'diff'; paneKey: string; file: string }

export type PersistedProjectNavigationHistory = {
  entries: NavigationTarget[]
  cursor: number
  mru: NavigationTarget[]
}

export type PersistedNavigationHistoryV1 = {
  version: typeof NAVIGATION_HISTORY_VERSION
  /** Most-recent project first. Kept separately because object-key order is not an LRU contract. */
  projectOrder: string[]
  projects: Record<string, PersistedProjectNavigationHistory>
}

export type NavigationHistoryValidation =
  | { ok: true; value: PersistedNavigationHistoryV1 }
  | { ok: false; error: string }

const MAX_REPO_ID_LENGTH = 256
const MAX_PATH_LENGTH = 4_096
const MAX_PANE_KEY_LENGTH = 2_048
const MAX_SESSION_ID_LENGTH = 512
const MAX_ANCHOR_LENGTH = 1_024
const MAX_DOCUMENT_POSITION = 100_000_000
const INVALID_TEXT = /[\u0000-\u001f\u007f]/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || INVALID_TEXT.test(value)) {
    throw new Error(`${name} must be a non-empty bounded string without control characters`)
  }
  return value
}

function optionalPosition(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_DOCUMENT_POSITION) {
    throw new Error(`${name} must be a positive bounded integer`)
  }
  return value
}

function navigationLocation(value: unknown, path: string): NavigationLocation | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error(`${path} must be an object`)
  const source = value
  const mode = source['mode']
  if (mode !== undefined && mode !== 'edit' && mode !== 'preview') throw new Error(`${path}.mode is invalid`)
  const anchor = source['anchor'] === undefined
    ? undefined
    : text(source['anchor'], `${path}.anchor`, MAX_ANCHOR_LENGTH)
  const line = optionalPosition(source['line'], `${path}.line`)
  const column = optionalPosition(source['column'], `${path}.column`)
  if (column !== undefined && line === undefined) throw new Error(`${path}.column requires a line`)
  return {
    ...(mode !== undefined ? { mode } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
    ...(anchor !== undefined ? { anchor } : {})
  }
}

function navigationTarget(value: unknown, path: string, expectedRepoId: string): NavigationTarget {
  if (!isRecord(value)) throw new Error(`${path} must be an object`)
  const source = value
  const repoId = text(source['repoId'], `${path}.repoId`, MAX_REPO_ID_LENGTH)
  if (repoId !== expectedRepoId) throw new Error(`${path}.repoId must match its project key`)
  const worktreePath = text(source['worktreePath'], `${path}.worktreePath`, MAX_PATH_LENGTH)
  const kind = source['kind']
  if (kind === 'workspace') return { repoId, worktreePath, kind }

  const paneKey = text(source['paneKey'], `${path}.paneKey`, MAX_PANE_KEY_LENGTH)
  if (kind === 'terminal') {
    const sessionId = text(source['sessionId'], `${path}.sessionId`, MAX_SESSION_ID_LENGTH)
    return { repoId, worktreePath, kind, paneKey, sessionId }
  }
  if (kind === 'file') {
    const file = text(source['file'], `${path}.file`, MAX_PATH_LENGTH)
    const location = navigationLocation(source['location'], `${path}.location`)
    return { repoId, worktreePath, kind, paneKey, file, ...(location ? { location } : {}) }
  }
  if (kind === 'browser') return { repoId, worktreePath, kind, paneKey }
  if (kind === 'diff') {
    const file = text(source['file'], `${path}.file`, MAX_PATH_LENGTH)
    return { repoId, worktreePath, kind, paneKey, file }
  }
  throw new Error(`${path}.kind is invalid`)
}

function targetList(value: unknown, path: string, repoId: string, limit: number): NavigationTarget[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`)
  if (value.length > limit) throw new Error(`${path} exceeds its ${limit}-item bound`)
  return value.map((target, index) => navigationTarget(target, `${path}[${index}]`, repoId))
}

/** Strict runtime validation. Invalid persisted intent is reported, never silently replaced. */
export function validatePersistedNavigationHistory(value: unknown): NavigationHistoryValidation {
  try {
    if (!isRecord(value)) throw new Error('navigationHistory must be an object')
    const source = value
    if (source['version'] !== NAVIGATION_HISTORY_VERSION) throw new Error('navigationHistory version is unsupported')
    if (!isRecord(source['projects'])) throw new Error('navigationHistory.projects must be an object')
    const rawProjects = source['projects']
    const rawProjectOrder = source['projectOrder']
    if (!Array.isArray(rawProjectOrder)) throw new Error('navigationHistory.projectOrder must be an array')
    const projectEntries = Object.entries(rawProjects)
    if (projectEntries.length > MAX_NAVIGATION_PROJECTS) {
      throw new Error(`navigationHistory.projects exceeds its ${MAX_NAVIGATION_PROJECTS}-project bound`)
    }
    if (rawProjectOrder.length !== projectEntries.length || rawProjectOrder.length > MAX_NAVIGATION_PROJECTS) {
      throw new Error('navigationHistory.projectOrder must contain every project exactly once')
    }

    const projectOrder = rawProjectOrder.map((repoId, index) =>
      text(repoId, `navigationHistory.projectOrder[${index}]`, MAX_REPO_ID_LENGTH))
    if (new Set(projectOrder).size !== projectOrder.length || projectOrder.some((repoId) => !(repoId in rawProjects))) {
      throw new Error('navigationHistory.projectOrder contains missing or duplicate project ids')
    }

    const projects: Record<string, PersistedProjectNavigationHistory> = {}
    for (const repoId of projectOrder) {
      if (!isRecord(rawProjects[repoId])) throw new Error(`navigationHistory.projects[${JSON.stringify(repoId)}] must be an object`)
      const project = rawProjects[repoId]
      const entries = targetList(project['entries'], `navigationHistory.projects[${JSON.stringify(repoId)}].entries`, repoId, MAX_NAVIGATION_ENTRIES)
      const mru = targetList(project['mru'], `navigationHistory.projects[${JSON.stringify(repoId)}].mru`, repoId, MAX_NAVIGATION_MRU)
      const cursor = project['cursor']
      if (typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor < -1 || cursor >= entries.length) {
        throw new Error(`navigationHistory.projects[${JSON.stringify(repoId)}].cursor is outside the entry list`)
      }
      if ((entries.length === 0) !== (cursor === -1)) {
        throw new Error(`navigationHistory.projects[${JSON.stringify(repoId)}].cursor must be -1 only for an empty history`)
      }
      projects[repoId] = { entries, cursor, mru }
    }
    return { ok: true, value: { version: NAVIGATION_HISTORY_VERSION, projectOrder, projects } }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
