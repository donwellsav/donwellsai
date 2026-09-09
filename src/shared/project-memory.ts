export const PROJECT_MEMORY_SCHEMA_VERSION = 2 as const
export const PROJECT_MEMORY_KINDS = ['fact', 'decision', 'convention', 'procedure', 'gotcha'] as const
export const PROJECT_MEMORY_MAX_ENTRIES = 10_000
export const PROJECT_MEMORY_MAX_ENTRIES_PER_PROJECT = 2_500
export const PROJECT_MEMORY_MAX_DOCUMENT_BYTES = 16 * 1024 * 1024
export const PROJECT_MEMORY_MAX_HISTORY_REVISIONS = 32
export const PROJECT_MEMORY_DEFAULT_RESULT_LIMIT = 50
export const PROJECT_MEMORY_MAX_RESULT_LIMIT = 200
export const PROJECT_MEMORY_MAX_CONTENT_LENGTH = 64_000
export const PROJECT_MEMORY_MAX_TITLE_LENGTH = 256
export const PROJECT_MEMORY_MAX_TAGS = 24
export const PROJECT_MEMORY_MAX_TAG_LENGTH = 64
export const PROJECT_MEMORY_MAX_QUERY_LENGTH = 512

export const PROJECT_MEMORY_MAX_IDENTIFIER_LENGTH = 128
const MAX_PROJECT_KEY_LENGTH = 256
export const PROJECT_MEMORY_MAX_PATH_LENGTH = 4_096
export const PROJECT_MEMORY_MAX_SOURCE_SESSION_LENGTH = 256
export const PROJECT_MEMORY_MAX_SOURCE_REF_LENGTH = 2_048
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/

export type ProjectMemoryKind = (typeof PROJECT_MEMORY_KINDS)[number]

export type ProjectMemoryProject = {
  projectKey: string
  projectPath: string
}

/** Attribution is supplied by the caller for provenance; it is not an authentication claim. */
export type ProjectMemoryAttributionInput = {
  harness: string
  sourceSession?: string
  sourceRef?: string
}

export type ProjectMemoryProvenance = {
  harness: string
  sourceSession: string | null
  sourceRef: string | null
  workspace: string
}

export type ProjectMemoryRevision = {
  revision: number
  kind: ProjectMemoryKind
  title: string
  content: string
  tags: string[]
  provenance: ProjectMemoryProvenance
  updatedAt: string
  archivedAt: string | null
}

export type ProjectMemoryEntry = ProjectMemoryRevision & {
  id: string
  createdAt: string
}

export type StoredProjectMemoryEntry = {
  current: ProjectMemoryEntry
  /** Oldest to newest; current is stored separately. */
  history: ProjectMemoryRevision[]
}

export type ProjectMemoryErasure = { id: string; revision: number; erasedAt: string }
export type ProjectMemoryEraseRequest = { workspacePath: string; id: string; expectedRevision: number }

export type ProjectMemoryProjectDocument = ProjectMemoryProject & {
  erased?: ProjectMemoryErasure[]
  entries: StoredProjectMemoryEntry[]
}

export type ProjectMemoryDocument = {
  schemaVersion: typeof PROJECT_MEMORY_SCHEMA_VERSION
  projects: ProjectMemoryProjectDocument[]
}

export type ProjectMemoryListRequest = {
  workspacePath: string
  query?: string
  kinds?: ProjectMemoryKind[]
  includeArchived?: boolean
  offset?: number
  limit?: number
}

export type ProjectMemoryListResult = {
  project: ProjectMemoryProject
  entries: ProjectMemoryEntry[]
  total: number
  hasMore: boolean
}

export type ProjectMemoryGetRequest = {
  workspacePath: string
  id: string
}

export type ProjectMemoryCreateRequest = {
  workspacePath: string
  kind: ProjectMemoryKind
  title: string
  content: string
  tags?: string[]
  attribution: ProjectMemoryAttributionInput
}

export type ProjectMemoryUpdateRequest = {
  workspacePath: string
  id: string
  expectedRevision: number
  kind: ProjectMemoryKind
  title: string
  content: string
  tags?: string[]
  attribution: ProjectMemoryAttributionInput
}

export type ProjectMemoryHistoryRequest = {
  workspacePath: string
  id: string
  limit?: number
}

export type ProjectMemoryHistoryResult = {
  project: ProjectMemoryProject
  entryId: string
  createdAt: string
  revisions: ProjectMemoryRevision[]
  truncated: boolean
}

/** archived=true archives; archived=false restores. Both transitions use revision CAS. */
export type ProjectMemoryArchiveRequest = {
  workspacePath: string
  id: string
  expectedRevision: number
  archived: boolean
  attribution: ProjectMemoryAttributionInput
}

export interface ProjectMemoryApi {
  projectMemoryErase(request: ProjectMemoryEraseRequest): Promise<ProjectMemoryErasure>
  projectMemoryList(request: ProjectMemoryListRequest): Promise<ProjectMemoryListResult>
  projectMemoryGet(request: ProjectMemoryGetRequest): Promise<ProjectMemoryEntry>
  projectMemoryCreate(request: ProjectMemoryCreateRequest): Promise<ProjectMemoryEntry>
  projectMemoryUpdate(request: ProjectMemoryUpdateRequest): Promise<ProjectMemoryEntry>
  projectMemoryHistory(request: ProjectMemoryHistoryRequest): Promise<ProjectMemoryHistoryResult>
  projectMemoryArchive(request: ProjectMemoryArchiveRequest): Promise<ProjectMemoryEntry>
}

export type ProjectMemoryStorageAction = 'migrate' | 'abort' | 'export' | 'reverse'
export type ProjectMemoryStorageStatus = {
  backend: 'json' | 'sqlite' | 'preparing' | 'aborting' | 'reversing' | 'unavailable'
  backupPath?: string
  backupBytes?: number
  error?: string
}

export const PROJECT_MEMORY_RPC_METHODS = {
  list: 'memory.list',
  get: 'memory.get',
  create: 'memory.create',
  update: 'memory.update',
  history: 'memory.history',
  archive: 'memory.archive'
} as const

export type ProjectMemoryRpcMethod = (typeof PROJECT_MEMORY_RPC_METHODS)[keyof typeof PROJECT_MEMORY_RPC_METHODS]

type UnknownRecord = Record<string, unknown>

function record(value: unknown, label: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as UnknownRecord
}

function keys(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[],
  label: string
): void {
  const allowed = new Set([...required, ...optional])
  const extra = Object.keys(value).find((key) => !allowed.has(key))
  if (extra) throw new Error(`${label} contains unknown field: ${extra}`)
  const missing = required.find((key) => !Object.hasOwn(value, key))
  if (missing) throw new Error(`${label} is missing field: ${missing}`)
}

function boundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`${label} must be a non-empty string no longer than ${maxLength} characters`)
  }
  if (value.includes(String.fromCharCode(0))) throw new Error(`${label} must not contain a null byte`)
  return value
}

function trimmedString(value: unknown, label: string, maxLength: number): string {
  const parsed = boundedString(value, label, maxLength)
  if (parsed !== parsed.trim()) throw new Error(`${label} must not have leading or trailing whitespace`)
  return parsed
}

function identifier(value: unknown, label: string): string {
  const parsed = trimmedString(value, label, PROJECT_MEMORY_MAX_IDENTIFIER_LENGTH)
  if (!IDENTIFIER_PATTERN.test(parsed)) {
    throw new Error(`${label} must start with a letter or number and contain only letters, numbers, dot, underscore, colon, slash, or dash`)
  }
  return parsed
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive integer`)
  return value as number
}

function timestamp(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 64)
  const milliseconds = Date.parse(parsed)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== parsed) {
    throw new Error(`${label} must be a canonical ISO-8601 timestamp`)
  }
  return parsed
}

function optionalSource(value: unknown, label: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null
  const parsed = trimmedString(value, label, maxLength)
  if (/[\r\n]/.test(parsed)) throw new Error(`${label} must be a single line`)
  return parsed
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`)
  return value
}

function resultLimit(value: unknown, label: string, maximum = PROJECT_MEMORY_MAX_RESULT_LIMIT): number {
  const parsed = positiveInteger(value, label)
  if (parsed > maximum) throw new Error(`${label} must not exceed ${maximum}`)
  return parsed
}

export function parseProjectMemoryWorkspacePath(value: unknown, label = 'workspacePath'): string {
  return boundedString(value, label, PROJECT_MEMORY_MAX_PATH_LENGTH)
}

export function parseProjectMemoryIdentifier(value: unknown, label = 'id'): string {
  return identifier(value, label)
}

export function parseProjectMemoryHarness(value: unknown, label = 'harness'): string {
  return identifier(value, label)
}

export function parseProjectMemoryKind(value: unknown, label = 'kind'): ProjectMemoryKind {
  if (typeof value !== 'string' || !(PROJECT_MEMORY_KINDS as readonly string[]).includes(value)) {
    throw new Error(`${label} must be one of: ${PROJECT_MEMORY_KINDS.join(', ')}`)
  }
  return value as ProjectMemoryKind
}

export function parseProjectMemoryTitle(value: unknown, label = 'title'): string {
  const parsed = trimmedString(value, label, PROJECT_MEMORY_MAX_TITLE_LENGTH)
  if (/[\r\n]/.test(parsed)) throw new Error(`${label} must be a single line`)
  return parsed
}

export function parseProjectMemoryContent(value: unknown, label = 'content'): string {
  const parsed = boundedString(value, label, PROJECT_MEMORY_MAX_CONTENT_LENGTH)
  if (parsed.trim().length === 0) throw new Error(`${label} must contain non-whitespace text`)
  return parsed
}

export function parseProjectMemoryTags(value: unknown, label = 'tags'): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  if (value.length > PROJECT_MEMORY_MAX_TAGS) throw new Error(`${label} must contain at most ${PROJECT_MEMORY_MAX_TAGS} tags`)
  const seen = new Set<string>()
  return value.map((candidate, index) => {
    const parsed = trimmedString(candidate, `${label}[${index}]`, PROJECT_MEMORY_MAX_TAG_LENGTH)
    if (/[\r\n]/.test(parsed)) throw new Error(`${label}[${index}] must be a single line`)
    const folded = parsed.normalize('NFKC').toLocaleLowerCase('en-US')
    if (seen.has(folded)) throw new Error(`${label} contains a duplicate tag: ${parsed}`)
    seen.add(folded)
    return parsed
  })
}

export function parseProjectMemoryAttributionInput(
  value: unknown,
  label = 'attribution'
): ProjectMemoryAttributionInput {
  const input = record(value, label)
  keys(input, ['harness'], ['sourceSession', 'sourceRef'], label)
  const sourceSession = optionalSource(input.sourceSession, `${label}.sourceSession`, PROJECT_MEMORY_MAX_SOURCE_SESSION_LENGTH)
  const sourceRef = optionalSource(input.sourceRef, `${label}.sourceRef`, PROJECT_MEMORY_MAX_SOURCE_REF_LENGTH)
  return {
    harness: parseProjectMemoryHarness(input.harness, `${label}.harness`),
    ...(sourceSession === null ? {} : { sourceSession }),
    ...(sourceRef === null ? {} : { sourceRef })
  }
}

export function parseProjectMemoryProject(value: unknown, label = 'project'): ProjectMemoryProject {
  const input = record(value, label)
  keys(input, ['projectKey', 'projectPath'], [], label)
  const projectKey = trimmedString(input.projectKey, `${label}.projectKey`, MAX_PROJECT_KEY_LENGTH)
  if (/\s/.test(projectKey)) throw new Error(`${label}.projectKey must not contain whitespace`)
  return {
    projectKey,
    projectPath: parseProjectMemoryWorkspacePath(input.projectPath, `${label}.projectPath`)
  }
}

export function parseProjectMemoryProvenance(value: unknown, label = 'provenance'): ProjectMemoryProvenance {
  const input = record(value, label)
  keys(input, ['harness', 'sourceSession', 'sourceRef', 'workspace'], [], label)
  return {
    harness: parseProjectMemoryHarness(input.harness, `${label}.harness`),
    sourceSession: optionalSource(input.sourceSession, `${label}.sourceSession`, PROJECT_MEMORY_MAX_SOURCE_SESSION_LENGTH),
    sourceRef: optionalSource(input.sourceRef, `${label}.sourceRef`, PROJECT_MEMORY_MAX_SOURCE_REF_LENGTH),
    workspace: parseProjectMemoryWorkspacePath(input.workspace, `${label}.workspace`)
  }
}

export function parseProjectMemoryRevision(value: unknown, label = 'revision'): ProjectMemoryRevision {
  const input = record(value, label)
  keys(input, ['revision', 'kind', 'title', 'content', 'tags', 'provenance', 'updatedAt', 'archivedAt'], [], label)
  const updatedAt = timestamp(input.updatedAt, `${label}.updatedAt`)
  const archivedAt = input.archivedAt === null ? null : timestamp(input.archivedAt, `${label}.archivedAt`)
  if (archivedAt !== null && archivedAt !== updatedAt) {
    throw new Error(`${label}.archivedAt must equal updatedAt for an archived revision`)
  }
  return {
    revision: positiveInteger(input.revision, `${label}.revision`),
    kind: parseProjectMemoryKind(input.kind, `${label}.kind`),
    title: parseProjectMemoryTitle(input.title, `${label}.title`),
    content: parseProjectMemoryContent(input.content, `${label}.content`),
    tags: parseProjectMemoryTags(input.tags, `${label}.tags`),
    provenance: parseProjectMemoryProvenance(input.provenance, `${label}.provenance`),
    updatedAt,
    archivedAt
  }
}

export function parseProjectMemoryEntry(value: unknown, label = 'entry'): ProjectMemoryEntry {
  const input = record(value, label)
  keys(input, ['id', 'revision', 'kind', 'title', 'content', 'tags', 'provenance', 'createdAt', 'updatedAt', 'archivedAt'], [], label)
  const revision = parseProjectMemoryRevision({
    revision: input.revision,
    kind: input.kind,
    title: input.title,
    content: input.content,
    tags: input.tags,
    provenance: input.provenance,
    updatedAt: input.updatedAt,
    archivedAt: input.archivedAt
  }, label)
  const createdAt = timestamp(input.createdAt, `${label}.createdAt`)
  if (createdAt > revision.updatedAt) throw new Error(`${label}.createdAt must not be after updatedAt`)
  return {
    id: parseProjectMemoryIdentifier(input.id, `${label}.id`),
    createdAt,
    ...revision
  }
}

export function projectMemoryRevisionFromEntry(entry: ProjectMemoryEntry): ProjectMemoryRevision {
  return parseProjectMemoryRevision({
    revision: entry.revision,
    kind: entry.kind,
    title: entry.title,
    content: entry.content,
    tags: entry.tags,
    provenance: entry.provenance,
    updatedAt: entry.updatedAt,
    archivedAt: entry.archivedAt
  })
}

export function parseStoredProjectMemoryEntry(value: unknown, label = 'stored entry'): StoredProjectMemoryEntry {
  const input = record(value, label)
  keys(input, ['current', 'history'], [], label)
  const current = parseProjectMemoryEntry(input.current, `${label}.current`)
  if (!Array.isArray(input.history)) throw new Error(`${label}.history must be an array`)
  if (input.history.length > PROJECT_MEMORY_MAX_HISTORY_REVISIONS) {
    throw new Error(`${label}.history exceeds ${PROJECT_MEMORY_MAX_HISTORY_REVISIONS} revisions`)
  }
  const history = input.history.map((candidate, index) => parseProjectMemoryRevision(candidate, `${label}.history[${index}]`))
  const expectedLength = Math.min(current.revision - 1, PROJECT_MEMORY_MAX_HISTORY_REVISIONS)
  if (history.length !== expectedLength) throw new Error(`${label}.history does not match the current revision`)
  let previousUpdatedAt = current.createdAt
  for (let index = 0; index < history.length; index += 1) {
    const revision = history[index]!
    const expectedRevision = current.revision - history.length + index
    if (revision.revision !== expectedRevision) throw new Error(`${label}.history revisions must be contiguous and ordered`)
    if (revision.updatedAt < current.createdAt || (index > 0 && revision.updatedAt <= previousUpdatedAt)) {
      throw new Error(`${label}.history timestamps must advance with each revision`)
    }
    if (revision.revision === 1 && (revision.updatedAt !== current.createdAt || revision.archivedAt !== null)) {
      throw new Error(`${label}.first revision must be the active creation state`)
    }
    previousUpdatedAt = revision.updatedAt
  }
  if (current.revision === 1) {
    if (current.updatedAt !== current.createdAt || current.archivedAt !== null) {
      throw new Error(`${label}.first revision must be the active creation state`)
    }
  } else if (current.updatedAt <= previousUpdatedAt) {
    throw new Error(`${label}.current timestamp must advance beyond its history`)
  }
  return { current, history }
}

export function parseProjectMemoryDocument(value: unknown): ProjectMemoryDocument {
  const input = record(value, 'project memory document')
  keys(input, ['schemaVersion', 'projects'], [], 'project memory document')
  if (input.schemaVersion !== 1 && input.schemaVersion !== PROJECT_MEMORY_SCHEMA_VERSION) {
    throw new Error(`Unsupported project memory schema version: ${String(input.schemaVersion)}`)
  }
  if (!Array.isArray(input.projects)) throw new Error('project memory document.projects must be an array')
  const projectKeys = new Set<string>()
  const entryIds = new Set<string>()
  let entryCount = 0
  const projects = input.projects.map((candidate, projectIndex) => {
    const projectInput = record(candidate, `project memory document.projects[${projectIndex}]`)
    keys(projectInput, ['projectKey', 'projectPath', 'entries'], input.schemaVersion === 2 ? ['erased'] : [], `project memory document.projects[${projectIndex}]`)
    const project = parseProjectMemoryProject({
      projectKey: projectInput.projectKey,
      projectPath: projectInput.projectPath
    }, `project memory document.projects[${projectIndex}]`)
    if (projectKeys.has(project.projectKey)) throw new Error(`Duplicate project memory project key: ${project.projectKey}`)
    projectKeys.add(project.projectKey)
    if (!Array.isArray(projectInput.entries)) throw new Error(`project ${project.projectKey} entries must be an array`)
    if (projectInput.entries.length > PROJECT_MEMORY_MAX_ENTRIES_PER_PROJECT) {
      throw new Error(`project ${project.projectKey} exceeds ${PROJECT_MEMORY_MAX_ENTRIES_PER_PROJECT} entries`)
    }
    const entries = projectInput.entries.map((entry, entryIndex) => {
      const parsed = parseStoredProjectMemoryEntry(entry, `project ${project.projectKey} entry ${entryIndex}`)
      if (entryIds.has(parsed.current.id)) throw new Error(`Duplicate project memory entry ID: ${parsed.current.id}`)
      entryIds.add(parsed.current.id)
      return parsed
    })
    const erased = projectInput.erased ?? []
    if (!Array.isArray(erased) || erased.length > PROJECT_MEMORY_MAX_ENTRIES) throw new Error('Invalid erased memory references')
    const tombstones = erased.map(candidate => {
      const value = record(candidate, 'erased memory reference')
      keys(value, ['id', 'revision', 'erasedAt'], [], 'erased memory reference')
      const id = parseProjectMemoryIdentifier(value.id)
      if (entryIds.has(id)) throw new Error(`Duplicate memory or erased ID: ${id}`)
      entryIds.add(id)
      return { id, revision: positiveInteger(value.revision, 'erased revision'), erasedAt: timestamp(value.erasedAt, 'erasedAt') }
    })
    entryCount += entries.length + tombstones.length
    return { ...project, entries, ...(tombstones.length ? { erased: tombstones } : {}) }
  })
  if (entryCount > PROJECT_MEMORY_MAX_ENTRIES) {
    throw new Error(`Project memory document exceeds ${PROJECT_MEMORY_MAX_ENTRIES} entries`)
  }
  return { schemaVersion: PROJECT_MEMORY_SCHEMA_VERSION, projects }
}

export function parseProjectMemoryListRequest(value: unknown): ProjectMemoryListRequest {
  const input = record(value, 'project memory list request')
  keys(input, ['workspacePath'], ['query', 'kinds', 'includeArchived', 'limit', 'offset'], 'project memory list request')
  if (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || (input.offset as number) < 0)) throw new Error('offset must be a non-negative safe integer')
  let query: string | undefined
  if (input.query !== undefined) {
    if (typeof input.query !== 'string' || input.query.length > PROJECT_MEMORY_MAX_QUERY_LENGTH) {
      throw new Error(`query must be a string no longer than ${PROJECT_MEMORY_MAX_QUERY_LENGTH} characters`)
    }
    if (input.query.includes(String.fromCharCode(0))) throw new Error('query must not contain a null byte')
    query = input.query.trim() || undefined
  }
  let kinds: ProjectMemoryKind[] | undefined
  if (input.kinds !== undefined) {
    if (!Array.isArray(input.kinds) || input.kinds.length === 0 || input.kinds.length > PROJECT_MEMORY_KINDS.length) {
      throw new Error(`kinds must contain between 1 and ${PROJECT_MEMORY_KINDS.length} values`)
    }
    kinds = input.kinds.map((kind, index) => parseProjectMemoryKind(kind, `kinds[${index}]`))
    if (new Set(kinds).size !== kinds.length) throw new Error('kinds must not contain duplicates')
  }
  return {
    workspacePath: parseProjectMemoryWorkspacePath(input.workspacePath),
    ...(query === undefined ? {} : { query }),
    ...(kinds === undefined ? {} : { kinds }),
    ...(input.includeArchived === undefined ? {} : { includeArchived: boolean(input.includeArchived, 'includeArchived') }),
    ...(input.offset === undefined ? {} : { offset: input.offset as number }),
    ...(input.limit === undefined ? {} : { limit: resultLimit(input.limit, 'limit') })
  }
}

export function parseProjectMemoryGetRequest(value: unknown): ProjectMemoryGetRequest {
  const input = record(value, 'project memory get request')
  keys(input, ['workspacePath', 'id'], [], 'project memory get request')
  return {
    workspacePath: parseProjectMemoryWorkspacePath(input.workspacePath),
    id: parseProjectMemoryIdentifier(input.id)
  }
}

export function parseProjectMemoryCreateRequest(value: unknown): ProjectMemoryCreateRequest {
  const input = record(value, 'project memory create request')
  keys(input, ['workspacePath', 'kind', 'title', 'content', 'attribution'], ['tags'], 'project memory create request')
  return {
    workspacePath: parseProjectMemoryWorkspacePath(input.workspacePath),
    kind: parseProjectMemoryKind(input.kind),
    title: parseProjectMemoryTitle(input.title),
    content: parseProjectMemoryContent(input.content),
    tags: parseProjectMemoryTags(input.tags ?? []),
    attribution: parseProjectMemoryAttributionInput(input.attribution)
  }
}

export function parseProjectMemoryUpdateRequest(value: unknown): ProjectMemoryUpdateRequest {
  const input = record(value, 'project memory update request')
  keys(input, ['workspacePath', 'id', 'expectedRevision', 'kind', 'title', 'content', 'attribution'], ['tags'], 'project memory update request')
  return {
    workspacePath: parseProjectMemoryWorkspacePath(input.workspacePath),
    id: parseProjectMemoryIdentifier(input.id),
    expectedRevision: positiveInteger(input.expectedRevision, 'expectedRevision'),
    kind: parseProjectMemoryKind(input.kind),
    title: parseProjectMemoryTitle(input.title),
    content: parseProjectMemoryContent(input.content),
    tags: parseProjectMemoryTags(input.tags ?? []),
    attribution: parseProjectMemoryAttributionInput(input.attribution)
  }
}

export function parseProjectMemoryHistoryRequest(value: unknown): ProjectMemoryHistoryRequest {
  const input = record(value, 'project memory history request')
  keys(input, ['workspacePath', 'id'], ['limit'], 'project memory history request')
  return {
    workspacePath: parseProjectMemoryWorkspacePath(input.workspacePath),
    id: parseProjectMemoryIdentifier(input.id),
    ...(input.limit === undefined
      ? {}
      : { limit: resultLimit(input.limit, 'limit', PROJECT_MEMORY_MAX_HISTORY_REVISIONS + 1) })
  }
}

export function parseProjectMemoryArchiveRequest(value: unknown): ProjectMemoryArchiveRequest {
  const input = record(value, 'project memory archive request')
  keys(input, ['workspacePath', 'id', 'expectedRevision', 'archived', 'attribution'], [], 'project memory archive request')
  return {
    workspacePath: parseProjectMemoryWorkspacePath(input.workspacePath),
    id: parseProjectMemoryIdentifier(input.id),
    expectedRevision: positiveInteger(input.expectedRevision, 'expectedRevision'),
    archived: boolean(input.archived, 'archived'),
    attribution: parseProjectMemoryAttributionInput(input.attribution)
  }
}


export function parseProjectMemoryEraseRequest(value: unknown): ProjectMemoryEraseRequest {
  const input = record(value, 'project memory erase request')
  keys(input, ['workspacePath', 'id', 'expectedRevision'], [], 'project memory erase request')
  return { workspacePath: parseProjectMemoryWorkspacePath(input.workspacePath), id: parseProjectMemoryIdentifier(input.id), expectedRevision: positiveInteger(input.expectedRevision, 'expectedRevision') }
}
