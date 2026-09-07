import { parseDiffReviewNote, parseDiffReviewTarget, type DiffReviewNote } from './diff-review'
import { type ProjectMemoryEntry, parseProjectMemoryIdentifier, parseProjectMemoryWorkspacePath } from './project-memory'

export type ProjectHandoff = {
  id: string
  projectKey: string
  taskId: string | null
  fromSessionId: string
  toAgent: string | null
  checkoutPath: string
  sourceRevision: string | null
  sourceBasis?: 'folder-files'
  contentFingerprint: string
  goal: string
  summary: string
  openQuestions: string[]
  nextSteps: string[]
  changedFiles: string[]
  evidenceIds: string[]
  reviewEvidence?: DiffReviewNote[]
  memorySources?: Array<{ id: string; revision: number }>
  state: 'open' | 'accepted' | 'superseded'
  delivery: 'not-sent' | 'confirmed' | 'uncertain'
  dispatch?: { requestId: string; state: 'uncertain' | 'submitted' }
  revision: number
  acceptedBySessionId: string | null
}

export function parseProjectHandoff(value: unknown): ProjectHandoff {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid handoff')
  const input = value as Record<string, unknown>
  const names = ['id', 'projectKey', 'taskId', 'fromSessionId', 'toAgent', 'checkoutPath', 'sourceRevision', 'contentFingerprint', 'goal', 'summary', 'openQuestions', 'nextSteps', 'changedFiles', 'evidenceIds', 'state', 'delivery', 'revision', 'acceptedBySessionId']
  if (Object.keys(input).some(name => !names.includes(name) && name !== 'memorySources' && name !== 'dispatch' && name !== 'reviewEvidence' && name !== 'sourceBasis') || names.some(name => !Object.hasOwn(input, name))) throw new Error('Invalid handoff fields')
  const text = (name: string, max: number): string => {
    const v = input[name]
    if (typeof v !== 'string' || !v.trim() || v.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v)) throw new Error(`Invalid handoff ${name}`)
    return v
  }
  const nullableId = (name: string): string | null => input[name] === null ? null : parseProjectMemoryIdentifier(input[name], name)
  const list = (name: string): string[] => {
    const values = input[name]
    if (!Array.isArray(values) || values.length > 200 || values.some(v => typeof v !== 'string' || !v.trim() || v.length > 4096 || /[\x00-\x1f\x7f]/.test(v))) throw new Error(`Invalid handoff ${name}`)
    return [...values]
  }
  const projectKey = text('projectKey', 64)
  if (!/^[a-f0-9]{64}$/.test(projectKey)) throw new Error('Invalid handoff project key')
  const contentFingerprint = text('contentFingerprint', 71)
  if (!/^sha256:[a-f0-9]{64}$/.test(contentFingerprint)) throw new Error('Invalid handoff content fingerprint')
  const sourceRevision = input.sourceRevision === null ? null : text('sourceRevision', 64)
  if (sourceRevision !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceRevision)) throw new Error('Invalid handoff source revision')
  const state = input.state as ProjectHandoff['state']
  const delivery = input.delivery as ProjectHandoff['delivery']
  if (!['open', 'accepted', 'superseded'].includes(state) || !['not-sent', 'confirmed', 'uncertain'].includes(delivery)) throw new Error('Invalid handoff state')
  if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 1) throw new Error('Invalid handoff revision')
  const acceptedBySessionId = nullableId('acceptedBySessionId')
  if ((state === 'open' && acceptedBySessionId !== null) || (state === 'accepted' && acceptedBySessionId === null) || (delivery !== 'not-sent' && acceptedBySessionId === null)) throw new Error('Inconsistent handoff acceptance')
  const changedFiles = list('changedFiles')
  if (changedFiles.some(path => path.startsWith('/') || path.includes('\\') || path.split('/').some(part => part === '..' || part === '.' || !part) || /^[a-z]:/i.test(path))) throw new Error('Handoff files must be checkout-relative paths')
  if (input.sourceBasis !== undefined && input.sourceBasis !== 'folder-files') throw new Error('Invalid handoff source basis')
  const memorySources = input.memorySources === undefined ? undefined : parseHandoffMemorySources(input.memorySources)
  let dispatch: ProjectHandoff['dispatch']
  if (input.dispatch !== undefined) {
    const value = input.dispatch as Record<string, unknown>
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 || !['uncertain', 'submitted'].includes(String(value.state)) || acceptedBySessionId === null) throw new Error('Invalid handoff dispatch')
    dispatch = { requestId: parseProjectMemoryIdentifier(value.requestId), state: value.state as 'uncertain' | 'submitted' }
  }
  const result: ProjectHandoff = {
    id: parseProjectMemoryIdentifier(input.id), projectKey, taskId: nullableId('taskId'),
    fromSessionId: parseProjectMemoryIdentifier(input.fromSessionId), toAgent: nullableId('toAgent'),
    ...(input.sourceBasis === undefined ? {} : { sourceBasis: input.sourceBasis }),
    checkoutPath: parseProjectMemoryWorkspacePath(input.checkoutPath), sourceRevision, contentFingerprint,
    goal: text('goal', 8000), summary: text('summary', 24000), openQuestions: list('openQuestions'), nextSteps: list('nextSteps'), changedFiles,
    ...(input.reviewEvidence === undefined ? {} : { reviewEvidence: parseHandoffReviewEvidence(input.reviewEvidence) }),
    ...(memorySources === undefined ? {} : { memorySources }),
    ...(dispatch === undefined ? {} : { dispatch }),
    evidenceIds: list('evidenceIds').map(id => parseProjectMemoryIdentifier(id)), state, delivery, revision: Number(input.revision), acceptedBySessionId
  }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 64000) throw new Error('Handoff is too large')
  return result
}


export type ProjectHandoffDraft = Pick<ProjectHandoff, 'taskId' | 'fromSessionId' | 'toAgent' | 'goal' | 'summary' | 'openQuestions' | 'nextSteps' | 'evidenceIds' | 'memorySources'> & { reviewSelections?: HandoffReviewSelection[] }
export type HandoffMemoryStatus = { id: string; revision: number; state: 'current' | 'changed' | 'archived' | 'unavailable'; current?: ProjectMemoryEntry }
export type ProjectHandoffStatus = { handoff: ProjectHandoff; stale: boolean; sourceError?: string; memorySources?: HandoffMemoryStatus[] }

export function parseHandoffMemorySources(value: unknown): Array<{ id: string; revision: number }> {
  if (!Array.isArray(value) || value.length > 50) throw new Error('Handoff supports up to 50 reviewed memory references')
  const seen = new Set<string>()
  return value.map(ref => {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref) || Object.keys(ref).length !== 2 || !Object.hasOwn(ref, 'id') || !Object.hasOwn(ref, 'revision')) throw new Error('Invalid handoff memory reference')
    const id = parseProjectMemoryIdentifier(ref.id)
    if (seen.has(id) || !Number.isSafeInteger(ref.revision) || ref.revision < 1) throw new Error('Invalid or duplicate handoff memory revision')
    seen.add(id)
    return { id, revision: ref.revision }
  })
}
export interface ProjectHandoffApi {
  projectHandoffExport(workspacePath: string): Promise<{ path: string; count: number }>
  projectHandoffList(workspacePath: string): Promise<ProjectHandoff[]>
  projectHandoffGet(workspacePath: string, id: string): Promise<ProjectHandoffStatus>
  projectHandoffCreate(workspacePath: string, draft: ProjectHandoffDraft): Promise<ProjectHandoff>
  projectHandoffDispatch(workspacePath: string, id: string, expectedRevision: number): Promise<ProjectHandoff>
  projectHandoffAccept(workspacePath: string, id: string, expectedRevision: number, sessionId: string, idempotencyKey: string): Promise<ProjectHandoff>
  projectHandoffSupersede(workspacePath: string, id: string, expectedRevision: number): Promise<ProjectHandoff>
}


export type HandoffReviewSelection = { id: string; revision: number; filePath: string; comparison: DiffReviewNote['target']['comparison'] }
export function parseHandoffReviewSelections(value: unknown, workspacePath: string): HandoffReviewSelection[] {
 if (!Array.isArray(value) || value.length > 10) throw new Error('Attach at most 10 reviewed diff selections')
 const seen = new Set<string>()
 return value.map(ref => {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref) || Object.keys(ref).length !== 4) throw new Error('Invalid reviewed diff selection')
  const id = parseProjectMemoryIdentifier(ref.id)
  if (seen.has(id) || !Number.isSafeInteger(ref.revision) || ref.revision < 1) throw new Error('Invalid or duplicate reviewed diff revision')
  seen.add(id)
  const target = parseDiffReviewTarget({ workspacePath, filePath: ref.filePath, comparison: ref.comparison })
  return { id, revision: ref.revision, filePath: target.filePath, comparison: target.comparison }
 })
}
function parseHandoffReviewEvidence(value: unknown): DiffReviewNote[] {
 if (!Array.isArray(value) || value.length > 10) throw new Error('Attach at most 10 reviewed diff selections')
 const notes = value.map(note => parseDiffReviewNote(note))
 if (new Set(notes.map(note => note.id)).size !== notes.length) throw new Error('Duplicate captured review evidence')
 return notes
}
