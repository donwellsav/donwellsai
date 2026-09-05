import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunningAgent } from '../src/shared/agent-runtime'
import {
  ATTENTION_ACKNOWLEDGED_HISTORY_LIMIT,
  ATTENTION_INBOX_SCHEMA_VERSION,
  type AttentionAcknowledgeRequest,
  type AttentionEvent,
  type AttentionInboxApi,
  type AttentionInboxEntry,
  type AttentionInboxSnapshot
} from '../src/shared/attention-inbox'
import { AttentionInboxStore, AttentionInboxLoadError } from '../src/main/attention-inbox-store'
import { AttentionInboxService } from '../src/main/attention-inbox-service'
import {
  acknowledgeVisibleAttention,
  closeAttentionInbox,
  getAttentionInboxState,
  mountAttentionInbox,
  openAttentionInbox,
  pendingAttentionReveal,
  requestAttentionReveal,
  revealAttentionEntry
} from '../src/renderer/src/attention-inbox'

const directories: string[] = []
const epoch = Date.parse('2026-09-05T00:00:00.000Z')

function iso(tick: number): string {
  return new Date(epoch + tick * 1_000).toISOString()
}

function agent(overrides: Partial<RunningAgent> = {}): RunningAgent {
  return {
    id: 'run-1',
    sessionId: 'session-1',
    workspacePath: '/workspace/alpha',
    command: 'codex',
    presetId: 'codex',
    startedAt: iso(0),
    updatedAt: iso(1),
    liveness: 'live',
    activity: 'working',
    hook: {
      support: 'unavailable',
      events: [],
      reason: 'test provider has no hooks',
      connected: false
    },
    ...overrides
  }
}

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'donwells-attention-'))
  directories.push(path)
  return path
}

function storedEvent(version: number, acknowledged: boolean): AttentionEvent {
  return {
    id: `event-${version}`,
    version,
    runId: `run-${version}`,
    sessionId: `session-${version}`,
    workspacePath: `/workspace/${version}`,
    command: 'codex',
    providerId: 'codex',
    kind: version % 2 === 0 ? 'waiting' : 'permission',
    detail: `event ${version}`,
    occurredAt: iso(version),
    sourceUpdatedAt: iso(version),
    observedLiveness: 'live',
    ...(acknowledged ? { acknowledgedAt: iso(version + 1) } : {})
  }
}

afterEach(() => {
  closeAttentionInbox()
  vi.unstubAllGlobals()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('durable attention inbox', () => {
  it('records presentation transitions with truthful contact and preserves unread events through restart', () => {
    const path = directory()
    let nowTick = 100
    const contacts = new Map<string, { currentLiveness: 'live' | 'unverifiable' | 'exited' | 'unknown'; terminalAvailability: 'retained' | 'unavailable' }>()
    const service = new AttentionInboxService(new AttentionInboxStore(path), {
      now: () => new Date(epoch + nowTick++ * 1_000),
      resolveContact: (sessionId) => contacts.get(sessionId) ?? {
        currentLiveness: 'unknown',
        terminalAvailability: 'unavailable'
      }
    })

    contacts.set('session-1', { currentLiveness: 'live', terminalAvailability: 'retained' })
    service.observe(agent())
    service.observe(agent({ activity: 'permission', detail: 'Approve filesystem access', updatedAt: iso(2) }))
    service.observe(agent({ activity: 'working', updatedAt: iso(3) }))
    service.observe(agent({ activity: 'waiting', detail: 'Need a decision', updatedAt: iso(4) }))

    contacts.set('session-failed', { currentLiveness: 'exited', terminalAvailability: 'retained' })
    service.observe(agent({ id: 'run-failed', sessionId: 'session-failed', updatedAt: iso(5) }))
    service.observe(agent({
      id: 'run-failed',
      sessionId: 'session-failed',
      activity: 'failed',
      liveness: 'exited',
      exitCode: 17,
      updatedAt: iso(6)
    }))

    contacts.set('session-complete', { currentLiveness: 'live', terminalAvailability: 'retained' })
    service.observe(agent({ id: 'run-complete', sessionId: 'session-complete', updatedAt: iso(7) }))
    service.observe(agent({
      id: 'run-complete',
      sessionId: 'session-complete',
      activity: 'completed',
      detail: 'Hook reported completion',
      updatedAt: iso(8)
    }))

    contacts.set('session-contact', { currentLiveness: 'unverifiable', terminalAvailability: 'retained' })
    service.observe(agent({
      id: 'run-contact',
      sessionId: 'session-contact',
      liveness: 'unverifiable',
      updatedAt: iso(9)
    }))

    const snapshot = service.list()
    expect(snapshot.entries.map((entry: AttentionInboxEntry) => entry.kind)).toEqual([
      'contact',
      'completed',
      'failed',
      'waiting',
      'permission'
    ])
    expect(snapshot.unreadCount).toBe(5)
    expect(snapshot.entries.find((entry: AttentionInboxEntry) => entry.kind === 'completed')).toMatchObject({
      observedLiveness: 'live',
      currentLiveness: 'live',
      terminalAvailability: 'retained'
    })

    const restarted = new AttentionInboxService(new AttentionInboxStore(path)).list()
    expect(restarted.unreadCount).toBe(5)
    expect(restarted.entries.map((entry: AttentionInboxEntry) => entry.id)).toEqual(snapshot.entries.map((entry: AttentionInboxEntry) => entry.id))
    expect(restarted.entries.every((entry: AttentionInboxEntry) => entry.currentLiveness === 'unknown')).toBe(true)
    expect(restarted.entries.every((entry: AttentionInboxEntry) => entry.terminalAvailability === 'unavailable')).toBe(true)
  })

  it('deduplicates replay while retaining a later real recurrence', () => {
    const path = directory()
    const first = new AttentionInboxService(new AttentionInboxStore(path))
    first.observe(agent())
    const waiting = agent({ activity: 'waiting', detail: 'Need input', updatedAt: iso(2) })
    first.observe(waiting)
    expect(first.list().entries).toHaveLength(1)

    const restarted = new AttentionInboxService(new AttentionInboxStore(path))
    expect(restarted.observe(waiting)).toBeUndefined()
    expect(restarted.observe(agent({ activity: 'waiting', detail: 'Replay with a newer timestamp', updatedAt: iso(3) }))).toBeUndefined()
    expect(restarted.observe(agent({ activity: 'working', updatedAt: iso(2) }))).toBeUndefined()
    expect(restarted.list().entries).toHaveLength(1)

    restarted.observe(agent({ activity: 'working', updatedAt: iso(4) }))
    restarted.observe(agent({ activity: 'waiting', detail: 'A later wait', updatedAt: iso(5) }))
    expect(restarted.list().entries.map((entry: AttentionInboxEntry) => entry.kind)).toEqual(['waiting', 'waiting'])
  })

  it('acknowledges only the captured event version when a newer event wins the activation race', () => {
    const service = new AttentionInboxService(new AttentionInboxStore(directory()))
    service.observe(agent())
    const oldEvent = service.observe(agent({ activity: 'waiting', updatedAt: iso(2) }))!
    service.observe(agent({ activity: 'working', updatedAt: iso(3) }))
    const newerEvent = service.observe(agent({ activity: 'permission', updatedAt: iso(4) }))!

    const result = service.acknowledge({ eventId: oldEvent.id, eventVersion: oldEvent.version })
    expect(result.outcome).toBe('acknowledged')
    expect(result.snapshot.entries.find((entry: AttentionInboxEntry) => entry.id === oldEvent.id)?.acknowledgedAt).toBeDefined()
    expect(result.snapshot.entries.find((entry: AttentionInboxEntry) => entry.id === newerEvent.id)?.acknowledgedAt).toBeUndefined()
    expect(result.snapshot.unreadCount).toBe(1)

    const stale = service.acknowledge({ eventId: newerEvent.id, eventVersion: oldEvent.version })
    expect(stale.outcome).toBe('version-mismatch')
    expect(stale.snapshot.unreadCount).toBe(1)
  })

  it('bounds acknowledged history without dropping unread entries and reports retention', () => {
    const path = directory()
    const store = new AttentionInboxStore(path)
    const acknowledged = Array.from(
      { length: ATTENTION_ACKNOWLEDGED_HISTORY_LIMIT + 1 },
      (_, index) => storedEvent(index + 1, true)
    )
    const unread = Array.from({ length: 300 }, (_, index) => (
      storedEvent(ATTENTION_ACKNOWLEDGED_HISTORY_LIMIT + index + 2, false)
    ))
    const target = unread.at(-1)!
    store.commit({
      schemaVersion: ATTENTION_INBOX_SCHEMA_VERSION,
      revision: target.version,
      events: [...acknowledged, ...unread],
      observations: [],
      discardedAcknowledged: 0
    })

    const result = new AttentionInboxService(store).acknowledge({
      eventId: target.id,
      eventVersion: target.version
    })
    expect(result.snapshot.unreadCount).toBe(299)
    expect(result.snapshot.entries.filter((entry: AttentionInboxEntry) => entry.acknowledgedAt !== undefined)).toHaveLength(
      ATTENTION_ACKNOWLEDGED_HISTORY_LIMIT
    )
    expect(result.snapshot.entries.filter((entry: AttentionInboxEntry) => entry.acknowledgedAt === undefined)).toHaveLength(299)
    expect(result.snapshot.retention).toEqual({
      acknowledgedLimit: ATTENTION_ACKNOWLEDGED_HISTORY_LIMIT,
      discardedAcknowledged: 2,
      unreadProtected: true
    })
  })

  it('leaves a corrupt persisted inbox untouched instead of resetting it', () => {
    const path = directory()
    const file = join(path, 'attention-inbox.json')
    writeFileSync(file, '{broken', 'utf8')
    expect(() => new AttentionInboxStore(path)).toThrow(AttentionInboxLoadError)
    expect(readFileSync(file, 'utf8')).toBe('{broken')
  })

  it('does not let an app-focus render acknowledge an event that arrived after the captured reveal', async () => {
    const oldEntry: AttentionInboxEntry = {
      ...storedEvent(10_000, false),
      sessionId: 'session-focus',
      currentLiveness: 'live',
      terminalAvailability: 'retained'
    }
    const newerEntry: AttentionInboxEntry = {
      ...storedEvent(10_001, false),
      sessionId: 'session-focus',
      currentLiveness: 'live',
      terminalAvailability: 'retained'
    }
    const retention: AttentionInboxSnapshot['retention'] = {
      acknowledgedLimit: ATTENTION_ACKNOWLEDGED_HISTORY_LIMIT,
      discardedAcknowledged: 0,
      unreadProtected: true
    }
    const initial: AttentionInboxSnapshot = {
      revision: oldEntry.version,
      entries: [oldEntry],
      unreadCount: 1,
      retention
    }
    const afterAcknowledgement: AttentionInboxSnapshot = {
      revision: newerEntry.version + 1,
      entries: [newerEntry, { ...oldEntry, acknowledgedAt: iso(10_002) }],
      unreadCount: 1,
      retention
    }
    const requests: AttentionAcknowledgeRequest[] = []
    const attentionApi: AttentionInboxApi = {
      attentionInboxList: async () => ({ available: true, snapshot: initial }),
      attentionInboxAcknowledge: async (request) => {
        requests.push(request)
        return { available: true, outcome: 'acknowledged', snapshot: afterAcknowledgement }
      }
    }
    const unmount = mountAttentionInbox(attentionApi)
    try {
      await Promise.resolve()
      await Promise.resolve()
      const activeElement = {}
      vi.stubGlobal('document', {
        activeElement,
        hasFocus: () => true,
        visibilityState: 'visible'
      })
      const host = {
        isConnected: true,
        contains: (element: Node | null) => element === document.activeElement,
        getBoundingClientRect: () => ({ width: 640, height: 400 })
      }

      requestAttentionReveal(oldEntry)
      expect(await acknowledgeVisibleAttention({
        sessionId: oldEntry.sessionId,
        isActive: true,
        runsOverlayOpen: false,
        host,
        allowCapture: false
      })).toBe(true)
      expect(requests).toEqual([{ eventId: oldEntry.id, eventVersion: oldEntry.version }])
      expect(getAttentionInboxState().snapshot?.unreadCount).toBe(1)
      expect(pendingAttentionReveal(oldEntry.sessionId)).toBeUndefined()

      expect(await acknowledgeVisibleAttention({
        sessionId: oldEntry.sessionId,
        isActive: true,
        runsOverlayOpen: false,
        host,
        allowCapture: false
      })).toBe(false)
      expect(requests).toHaveLength(1)
    } finally {
      unmount()
    }
  })
  it('does not close or acknowledge when an event terminal is unavailable', async () => {
    const entry: AttentionInboxEntry = {
      ...storedEvent(1, false),
      currentLiveness: 'unknown',
      terminalAvailability: 'retained'
    }
    openAttentionInbox()
    let focusCalls = 0
    const opened = await revealAttentionEntry(entry, async () => {
      focusCalls++
      return false
    })

    expect(opened).toBe(false)
    expect(focusCalls).toBe(1)
    expect(getAttentionInboxState().overlayOpen).toBe(true)
    expect(pendingAttentionReveal(entry.sessionId)).toBeUndefined()
    expect(getAttentionInboxState().error).toMatch(/no longer available/)
  })
})
