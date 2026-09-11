import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventStore } from '../src/main/events/event-store'

describe('EventStore', () => {
  let store: EventStore
  let baseDir: string

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'donwells-events-'))
    store = new EventStore({ baseDir, fileRotationCount: 5 })
  })

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true })
  })

  it('appends and reads events for an aggregate', async () => {
    await store.append({
      id: 'evt-1',
      type: 'session:started',
      aggregateId: 'session-1',
      aggregateType: 'session',
      timestamp: Date.now(),
      version: 1,
      payload: { provider: 'claude' }
    })

    await store.append({
      id: 'evt-2',
      type: 'session:completed',
      aggregateId: 'session-1',
      aggregateType: 'session',
      timestamp: Date.now() + 1000,
      version: 2,
      payload: { totalTokens: 500 }
    })

    const events = await store.readAggregate('session', 'session-1')
    expect(events).toHaveLength(2)
    expect(events[0].type).toBe('session:started')
    expect(events[1].type).toBe('session:completed')
  })

  it('reads events ordered by version', async () => {
    // Append out of order
    for (const v of [3, 1, 2]) {
      await store.append({
        id: `evt-${v}`,
        type: 'session:response_chunk',
        aggregateId: 's-1',
        aggregateType: 'session',
        timestamp: Date.now() + v,
        version: v,
        payload: { chunkSize: v * 100 }
      })
    }

    const events = await store.readAggregate('session', 's-1')
    expect(events.map(e => e.version)).toEqual([1, 2, 3])
  })

  it('filters by aggregate type', async () => {
    await store.append({
      id: 'p-1', type: 'project:created', aggregateId: 'proj-1', aggregateType: 'project',
      timestamp: Date.now(), version: 1, payload: { name: 'test' }
    })
    await store.append({
      id: 's-1', type: 'session:started', aggregateId: 'sess-1', aggregateType: 'session',
      timestamp: Date.now(), version: 1, payload: {}
    })

    const sessions = await store.readType('session')
    expect(sessions).toHaveLength(1)
    expect(sessions[0].type).toBe('session:started')

    const projects = await store.readType('project')
    expect(projects).toHaveLength(1)
    expect(projects[0].type).toBe('project:created')
  })

  it('reads all events across types', async () => {
    await store.append({
      id: '1', type: 'project:created', aggregateId: 'p1', aggregateType: 'project',
      timestamp: 100, version: 1, payload: {}
    })
    await store.append({
      id: '2', type: 'session:started', aggregateId: 's1', aggregateType: 'session',
      timestamp: 200, version: 1, payload: {}
    })
    await store.append({
      id: '3', type: 'session:completed', aggregateId: 's1', aggregateType: 'session',
      timestamp: 300, version: 2, payload: {}
    })

    const all = await store.readAll()
    expect(all).toHaveLength(3)
    expect(all.map(e => e.timestamp)).toEqual([100, 200, 300])
  })

  it('replays events through a reducer', async () => {
    await store.append({
      id: '1', type: 'session:started', aggregateId: 's1', aggregateType: 'session',
      timestamp: 100, version: 1, payload: { provider: 'claude' }
    })
    await store.append({
      id: '2', type: 'session:response_chunk', aggregateId: 's1', aggregateType: 'session',
      timestamp: 200, version: 2, payload: { chunkSize: 50 }
    })
    await store.append({
      id: '3', type: 'session:response_chunk', aggregateId: 's1', aggregateType: 'session',
      timestamp: 300, version: 3, payload: { chunkSize: 75 }
    })

    interface SessionState {
      totalChunks: number
      totalTokens: number
    }

    const result = await store.replay<SessionState>('session', 's1', (state, event) => {
      if (event.type === 'session:response_chunk') {
        return {
          totalChunks: state.totalChunks + 1,
          totalTokens: state.totalTokens + (event.payload.chunkSize as number)
        }
      }
      return state
    }, { totalChunks: 0, totalTokens: 0 })

    expect(result.totalChunks).toBe(2)
    expect(result.totalTokens).toBe(125)
  })

  it('rotates files when threshold is reached', async () => {
    // Write more events than the rotation threshold (5)
    for (let i = 0; i < 7; i++) {
      await store.append({
        id: `evt-${i}`,
        type: 'session:response_chunk',
        aggregateId: 's-1',
        aggregateType: 'session',
        timestamp: Date.now() + i,
        version: i + 1,
        payload: { chunkSize: i }
      })
    }

    const dir = join(baseDir, 'session')
    const files = await readdir(dir)
    expect(files.length).toBeGreaterThan(1)

    // All events should still be readable
    const events = await store.readAggregate('session', 's-1')
    expect(events).toHaveLength(7)
  })

  it('computes integrity hash', async () => {
    await store.append({
      id: '1', type: 'session:started', aggregateId: 's1', aggregateType: 'session',
      timestamp: 100, version: 1, payload: {}
    })

    const hash = await store.computeIntegrityHash('session')
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })
})
