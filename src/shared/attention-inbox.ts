import {
  AGENT_PROVIDER_IDS,
  type AgentLiveness,
  type AgentProviderId
} from './agent-runtime'
import type { AgentPresentationStatus } from './agent-presentation'

export const ATTENTION_INBOX_SCHEMA_VERSION = 1 as const
export const ATTENTION_ACKNOWLEDGED_HISTORY_LIMIT = 256
export const ATTENTION_INBOX_CAPABILITY = 'attention-inbox-v1'

const MAX_IDENTIFIER_LENGTH = 128
const MAX_PATH_LENGTH = 4_096
const MAX_COMMAND_LENGTH = 16 * 1_024
const MAX_DETAIL_LENGTH = 512

export type AttentionEventKind = 'permission' | 'waiting' | 'failed' | 'completed' | 'contact'
export type AttentionTerminalAvailability = 'retained' | 'unavailable'

/** Immutable evidence that one agent entered an attention-worthy presentation state. */
export type AttentionEvent = {
  id: string
  /** Monotonic inbox revision at which this event was recorded. */
  version: number
  runId: string
  sessionId: string
  workspacePath: string
  command: string
  providerId?: AgentProviderId
  kind: AttentionEventKind
  detail: string
  occurredAt: string
  sourceUpdatedAt: string
  /** Runtime liveness when the event was observed; completed does not imply exited. */
  observedLiveness: AgentLiveness
  acknowledgedAt?: string
}

/** Current contact facts are added by the live daemon and are never inferred from app connectivity. */
export type AttentionInboxEntry = AttentionEvent & {
  currentLiveness: AgentLiveness | 'unknown'
  terminalAvailability: AttentionTerminalAvailability
}

export type AttentionInboxRetention = {
  /** Only acknowledged history is capped. Unread entries are never discarded. */
  acknowledgedLimit: number
  discardedAcknowledged: number
  unreadProtected: true
}

export type AttentionInboxSnapshot = {
  revision: number
  entries: AttentionInboxEntry[]
  unreadCount: number
  retention: AttentionInboxRetention
}

export type AttentionInboxUnavailable = {
  available: false
  reason: 'daemon-upgrade-required'
}

export type AttentionInboxListResult =
  | { available: true; snapshot: AttentionInboxSnapshot }
  | AttentionInboxUnavailable

export type AttentionAcknowledgeRequest = {
  eventId: string
  eventVersion: number
}

export type AttentionAcknowledgeOutcome =
  | 'acknowledged'
  | 'already-acknowledged'
  | 'not-found'
  | 'version-mismatch'

export type AttentionAcknowledgeResult =
  | {
      available: true
      outcome: AttentionAcknowledgeOutcome
      snapshot: AttentionInboxSnapshot
    }
  | AttentionInboxUnavailable

export interface AttentionInboxApi {
  attentionInboxList(): Promise<AttentionInboxListResult>
  attentionInboxAcknowledge(request: AttentionAcknowledgeRequest): Promise<AttentionAcknowledgeResult>
}

export type AttentionObservation = {
  runId: string
  sessionId: string
  status: AgentPresentationStatus
  sourceUpdatedAt: string
}

export type AttentionInboxDocument = {
  schemaVersion: typeof ATTENTION_INBOX_SCHEMA_VERSION
  revision: number
  events: AttentionEvent[]
  observations: AttentionObservation[]
  discardedAcknowledged: number
}

type UnknownRecord = Record<string, unknown>

function record(value: unknown, label: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as UnknownRecord
}

function exactKeys(value: UnknownRecord, required: readonly string[], optional: readonly string[], label: string): void {
  const expected = new Set([...required, ...optional])
  const extra = Object.keys(value).find((key) => !expected.has(key))
  if (extra) throw new Error(`${label} contains unknown field: ${extra}`)
  const missing = required.find((key) => !Object.hasOwn(value, key))
  if (missing) throw new Error(`${label} is missing field: ${missing}`)
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes(String.fromCharCode(0))) {
    throw new Error(`${label} must be a non-empty string no longer than ${maximum} characters`)
  }
  return value
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`)
  return value as number
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = nonNegativeInteger(value, label)
  if (parsed === 0) throw new Error(`${label} must be a positive integer`)
  return parsed
}

function canonicalTimestamp(value: unknown, label: string): string {
  const timestamp = boundedString(value, label, 64)
  const milliseconds = Date.parse(timestamp)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== timestamp) {
    throw new Error(`${label} must be a canonical ISO timestamp`)
  }
  return timestamp
}

function agentLiveness(value: unknown, label: string): AgentLiveness {
  if (value !== 'live' && value !== 'unverifiable' && value !== 'exited') {
    throw new Error(`${label} must be live, unverifiable, or exited`)
  }
  return value
}

function presentationStatus(value: unknown, label: string): AgentPresentationStatus {
  if (value !== 'starting' && value !== 'working' && value !== 'waiting' && value !== 'permission'
    && value !== 'stopping' && value !== 'completed' && value !== 'failed'
    && value !== 'unverifiable' && value !== 'exited') {
    throw new Error(`${label} is not an agent presentation status`)
  }
  return value
}

function eventKind(value: unknown, label: string): AttentionEventKind {
  if (value !== 'permission' && value !== 'waiting' && value !== 'failed'
    && value !== 'completed' && value !== 'contact') {
    throw new Error(`${label} is not an attention event kind`)
  }
  return value
}

function providerId(value: unknown, label: string): AgentProviderId {
  if (typeof value !== 'string' || !AGENT_PROVIDER_IDS.some((candidate) => candidate === value)) {
    throw new Error(`${label} is not a registered agent provider`)
  }
  return value as AgentProviderId
}

export function parseAttentionEvent(value: unknown, label = 'attention event'): AttentionEvent {
  const input = record(value, label)
  exactKeys(
    input,
    ['id', 'version', 'runId', 'sessionId', 'workspacePath', 'command', 'kind', 'detail', 'occurredAt', 'sourceUpdatedAt', 'observedLiveness'],
    ['providerId', 'acknowledgedAt'],
    label
  )
  return {
    id: boundedString(input['id'], `${label}.id`, MAX_IDENTIFIER_LENGTH),
    version: positiveInteger(input['version'], `${label}.version`),
    runId: boundedString(input['runId'], `${label}.runId`, MAX_IDENTIFIER_LENGTH),
    sessionId: boundedString(input['sessionId'], `${label}.sessionId`, MAX_IDENTIFIER_LENGTH),
    workspacePath: boundedString(input['workspacePath'], `${label}.workspacePath`, MAX_PATH_LENGTH),
    command: boundedString(input['command'], `${label}.command`, MAX_COMMAND_LENGTH),
    ...(input['providerId'] === undefined ? {} : { providerId: providerId(input['providerId'], `${label}.providerId`) }),
    kind: eventKind(input['kind'], `${label}.kind`),
    detail: boundedString(input['detail'], `${label}.detail`, MAX_DETAIL_LENGTH),
    occurredAt: canonicalTimestamp(input['occurredAt'], `${label}.occurredAt`),
    sourceUpdatedAt: canonicalTimestamp(input['sourceUpdatedAt'], `${label}.sourceUpdatedAt`),
    observedLiveness: agentLiveness(input['observedLiveness'], `${label}.observedLiveness`),
    ...(input['acknowledgedAt'] === undefined
      ? {}
      : { acknowledgedAt: canonicalTimestamp(input['acknowledgedAt'], `${label}.acknowledgedAt`) })
  }
}

export function parseAttentionObservation(value: unknown, label = 'attention observation'): AttentionObservation {
  const input = record(value, label)
  exactKeys(input, ['runId', 'sessionId', 'status', 'sourceUpdatedAt'], [], label)
  return {
    runId: boundedString(input['runId'], `${label}.runId`, MAX_IDENTIFIER_LENGTH),
    sessionId: boundedString(input['sessionId'], `${label}.sessionId`, MAX_IDENTIFIER_LENGTH),
    status: presentationStatus(input['status'], `${label}.status`),
    sourceUpdatedAt: canonicalTimestamp(input['sourceUpdatedAt'], `${label}.sourceUpdatedAt`)
  }
}

export function parseAttentionInboxDocument(value: unknown): AttentionInboxDocument {
  const input = record(value, 'attention inbox document')
  exactKeys(input, ['schemaVersion', 'revision', 'events', 'observations', 'discardedAcknowledged'], [], 'attention inbox document')
  if (input['schemaVersion'] !== ATTENTION_INBOX_SCHEMA_VERSION) {
    throw new Error(`unsupported attention inbox schema version: ${String(input['schemaVersion'])}`)
  }
  if (!Array.isArray(input['events'])) throw new Error('attention inbox document.events must be an array')
  if (!Array.isArray(input['observations'])) throw new Error('attention inbox document.observations must be an array')
  const events = input['events'].map((entry, index) => parseAttentionEvent(entry, `attention inbox event ${index}`))
  const observations = input['observations'].map((entry, index) => parseAttentionObservation(entry, `attention inbox observation ${index}`))
  const eventIds = new Set<string>()
  for (const event of events) {
    if (eventIds.has(event.id)) throw new Error(`attention inbox contains duplicate event id: ${event.id}`)
    eventIds.add(event.id)
  }
  const runIds = new Set<string>()
  for (const observation of observations) {
    if (runIds.has(observation.runId)) throw new Error(`attention inbox contains duplicate observation for run: ${observation.runId}`)
    runIds.add(observation.runId)
  }
  const revision = nonNegativeInteger(input['revision'], 'attention inbox document.revision')
  if (events.some((event) => event.version > revision)) {
    throw new Error('attention inbox event version exceeds document revision')
  }
  return {
    schemaVersion: ATTENTION_INBOX_SCHEMA_VERSION,
    revision,
    events,
    observations,
    discardedAcknowledged: nonNegativeInteger(input['discardedAcknowledged'], 'attention inbox document.discardedAcknowledged')
  }
}

export function parseAttentionAcknowledgeRequest(value: unknown): AttentionAcknowledgeRequest {
  const input = record(value, 'attention acknowledgement')
  exactKeys(input, ['eventId', 'eventVersion'], [], 'attention acknowledgement')
  return {
    eventId: boundedString(input['eventId'], 'attention acknowledgement.eventId', MAX_IDENTIFIER_LENGTH),
    eventVersion: positiveInteger(input['eventVersion'], 'attention acknowledgement.eventVersion')
  }
}

export function parseAttentionInboxSnapshot(value: unknown): AttentionInboxSnapshot {
  const input = record(value, 'attention inbox snapshot')
  exactKeys(input, ['revision', 'entries', 'unreadCount', 'retention'], [], 'attention inbox snapshot')
  const revision = nonNegativeInteger(input['revision'], 'attention inbox snapshot.revision')
  if (!Array.isArray(input['entries'])) throw new Error('attention inbox snapshot.entries must be an array')
  const entries = input['entries'].map((value, index): AttentionInboxEntry => {
    const entry = record(value, `attention inbox entry ${index}`)
    const { currentLiveness, terminalAvailability, ...eventFields } = entry
    const parsed = parseAttentionEvent(eventFields, `attention inbox entry ${index}`)
    const parsedCurrentLiveness = currentLiveness === 'unknown'
      ? 'unknown'
      : agentLiveness(currentLiveness, `attention inbox entry ${index}.currentLiveness`)
    if (terminalAvailability !== 'retained' && terminalAvailability !== 'unavailable') {
      throw new Error(`attention inbox entry ${index}.terminalAvailability is invalid`)
    }
    return { ...parsed, currentLiveness: parsedCurrentLiveness, terminalAvailability }
  })
  const eventIds = new Set<string>()
  for (const entry of entries) {
    if (eventIds.has(entry.id)) throw new Error('attention inbox snapshot contains duplicate event id: ' + entry.id)
    if (entry.version > revision) throw new Error('attention inbox snapshot event version exceeds revision')
    eventIds.add(entry.id)
  }
  const retention = record(input['retention'], 'attention inbox snapshot.retention')
  exactKeys(retention, ['acknowledgedLimit', 'discardedAcknowledged', 'unreadProtected'], [], 'attention inbox snapshot.retention')
  if (retention['unreadProtected'] !== true) throw new Error('attention inbox snapshot must protect unread entries')
  const unreadCount = nonNegativeInteger(input['unreadCount'], 'attention inbox snapshot.unreadCount')
  if (entries.filter((entry) => entry.acknowledgedAt === undefined).length !== unreadCount) {
    throw new Error('attention inbox snapshot unreadCount does not match entries')
  }
  return {
    revision,
    entries,
    unreadCount,
    retention: {
      acknowledgedLimit: positiveInteger(retention['acknowledgedLimit'], 'attention inbox snapshot.retention.acknowledgedLimit'),
      discardedAcknowledged: nonNegativeInteger(retention['discardedAcknowledged'], 'attention inbox snapshot.retention.discardedAcknowledged'),
      unreadProtected: true
    }
  }
}
