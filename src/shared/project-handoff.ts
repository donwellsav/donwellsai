import { parseProjectMemoryIdentifier, parseProjectMemoryWorkspacePath } from './project-memory'

export type ProjectHandoff = {
  id: string
  projectKey: string
  taskId: string | null
  fromSessionId: string
  toAgent: string | null
  checkoutPath: string
  sourceRevision: string | null
  contentFingerprint: string
  goal: string
  summary: string
  openQuestions: string[]
  nextSteps: string[]
  changedFiles: string[]
  evidenceIds: string[]
  state: 'open' | 'accepted' | 'superseded'
  delivery: 'not-sent' | 'confirmed' | 'uncertain'
  revision: number
  acceptedBySessionId: string | null
}

export function parseProjectHandoff(value: unknown): ProjectHandoff {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid handoff')
  const input = value as Record<string, unknown>
  const names = ['id', 'projectKey', 'taskId', 'fromSessionId', 'toAgent', 'checkoutPath', 'sourceRevision', 'contentFingerprint', 'goal', 'summary', 'openQuestions', 'nextSteps', 'changedFiles', 'evidenceIds', 'state', 'delivery', 'revision', 'acceptedBySessionId']
  if (Object.keys(input).length !== names.length || names.some(name => !Object.hasOwn(input, name))) throw new Error('Invalid handoff fields')
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
  const result: ProjectHandoff = {
    id: parseProjectMemoryIdentifier(input.id), projectKey, taskId: nullableId('taskId'),
    fromSessionId: parseProjectMemoryIdentifier(input.fromSessionId), toAgent: nullableId('toAgent'),
    checkoutPath: parseProjectMemoryWorkspacePath(input.checkoutPath), sourceRevision, contentFingerprint,
    goal: text('goal', 8000), summary: text('summary', 24000), openQuestions: list('openQuestions'), nextSteps: list('nextSteps'), changedFiles,
    evidenceIds: list('evidenceIds').map(id => parseProjectMemoryIdentifier(id)), state, delivery, revision: Number(input.revision), acceptedBySessionId
  }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 64000) throw new Error('Handoff is too large')
  return result
}
