import { randomUUID } from 'node:crypto'
import { agentPresentation, type AgentPresentationStatus } from '@shared/agent-presentation'
import type { AgentLiveness, RunningAgent } from '@shared/agent-runtime'
import {
  ATTENTION_ACKNOWLEDGED_HISTORY_LIMIT,
  ATTENTION_INBOX_SCHEMA_VERSION,
  parseAttentionAcknowledgeRequest,
  type AttentionAcknowledgeOutcome,
  type AttentionAcknowledgeRequest,
  type AttentionEvent,
  type AttentionEventKind,
  type AttentionInboxDocument,
  type AttentionInboxSnapshot,
  type AttentionObservation,
  type AttentionTerminalAvailability
} from '@shared/attention-inbox'
import { AttentionInboxStore } from './attention-inbox-store'

export type AttentionContact = {
  currentLiveness: AgentLiveness | 'unknown'
  terminalAvailability: AttentionTerminalAvailability
}

export type AttentionAcknowledgeServiceResult = {
  outcome: AttentionAcknowledgeOutcome
  snapshot: AttentionInboxSnapshot
}

export type AttentionInboxServiceOptions = {
  now?: () => Date
  resolveContact?: (sessionId: string) => AttentionContact
}

const DEFAULT_CONTACT: AttentionContact = {
  currentLiveness: 'unknown',
  terminalAvailability: 'unavailable'
}

function eventKindForStatus(status: AgentPresentationStatus): AttentionEventKind | undefined {
  switch (status) {
    case 'permission': return 'permission'
    case 'waiting': return 'waiting'
    case 'failed': return 'failed'
    case 'completed': return 'completed'
    case 'unverifiable': return 'contact'
    default: return undefined
  }
}

/** Persists transitions before publishing them to app clients. */
export class AttentionInboxService {
  private readonly now: () => Date
  private readonly resolveContact: (sessionId: string) => AttentionContact

  constructor(
    private readonly store: AttentionInboxStore,
    options: AttentionInboxServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date())
    this.resolveContact = options.resolveContact ?? (() => DEFAULT_CONTACT)
  }

  observe(run: RunningAgent): AttentionEvent | undefined {
    const current = this.store.snapshot()
    const presentation = agentPresentation(run)
    const observationIndex = current.observations.findIndex((item) => item.runId === run.id)
    const previous = current.observations[observationIndex]

    // Older replays cannot move the durable cursor backwards. Same-state newer
    // observations advance the cursor without creating duplicate inbox rows.
    if (previous && run.updatedAt < previous.sourceUpdatedAt) return undefined
    if (previous && run.updatedAt === previous.sourceUpdatedAt && previous.status === presentation.status) return undefined

    const observation: AttentionObservation = {
      runId: run.id,
      sessionId: run.sessionId,
      status: presentation.status,
      sourceUpdatedAt: run.updatedAt
    }
    const observations = current.observations.slice()
    if (observationIndex < 0) observations.push(observation)
    else observations[observationIndex] = observation

    const revision = current.revision + 1
    const kind = previous?.status === presentation.status
      ? undefined
      : eventKindForStatus(presentation.status)
    let event: AttentionEvent | undefined
    const events = current.events.slice()
    if (kind) {
      event = {
        id: randomUUID(),
        version: revision,
        runId: run.id,
        sessionId: run.sessionId,
        workspacePath: run.workspacePath,
        command: run.command,
        ...(run.presetId ? { providerId: run.presetId } : {}),
        kind,
        detail: presentation.description.slice(0, 512),
        occurredAt: this.now().toISOString(),
        sourceUpdatedAt: run.updatedAt,
        observedLiveness: run.liveness
      }
      events.push(event)
    }

    this.store.commit({
      schemaVersion: ATTENTION_INBOX_SCHEMA_VERSION,
      revision,
      events,
      observations,
      discardedAcknowledged: current.discardedAcknowledged
    })
    return event ? structuredClone(event) : undefined
  }

  list(): AttentionInboxSnapshot {
    return this.snapshot(this.store.snapshot())
  }

  acknowledge(value: AttentionAcknowledgeRequest): AttentionAcknowledgeServiceResult {
    const request = parseAttentionAcknowledgeRequest(value)
    const current = this.store.snapshot()
    const eventIndex = current.events.findIndex((event) => event.id === request.eventId)
    if (eventIndex < 0) return { outcome: 'not-found', snapshot: this.snapshot(current) }
    const target = current.events[eventIndex]!
    if (target.version !== request.eventVersion) {
      return { outcome: 'version-mismatch', snapshot: this.snapshot(current) }
    }
    if (target.acknowledgedAt !== undefined) {
      return { outcome: 'already-acknowledged', snapshot: this.snapshot(current) }
    }

    const events = current.events.slice()
    events[eventIndex] = { ...target, acknowledgedAt: this.now().toISOString() }
    const acknowledged = events
      .filter((event) => event.acknowledgedAt !== undefined)
      .sort((left, right) => right.version - left.version)
    const retainedAcknowledgedIds = new Set(
      acknowledged.slice(0, ATTENTION_ACKNOWLEDGED_HISTORY_LIMIT).map((event) => event.id)
    )
    const pruned = events.filter((event) => event.acknowledgedAt === undefined || retainedAcknowledgedIds.has(event.id))
    const discardedNow = events.length - pruned.length
    const document = this.store.commit({
      schemaVersion: ATTENTION_INBOX_SCHEMA_VERSION,
      revision: current.revision + 1,
      events: pruned,
      observations: current.observations,
      discardedAcknowledged: current.discardedAcknowledged + discardedNow
    })
    return { outcome: 'acknowledged', snapshot: this.snapshot(document) }
  }

  private snapshot(document: AttentionInboxDocument): AttentionInboxSnapshot {
    const entries = document.events
      .map((event) => ({ ...event, ...this.resolveContact(event.sessionId) }))
      .sort((left, right) => right.version - left.version)
    return {
      revision: document.revision,
      entries,
      unreadCount: entries.filter((event) => event.acknowledgedAt === undefined).length,
      retention: {
        acknowledgedLimit: ATTENTION_ACKNOWLEDGED_HISTORY_LIMIT,
        discardedAcknowledged: document.discardedAcknowledged,
        unreadProtected: true
      }
    }
  }
}
