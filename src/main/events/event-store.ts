import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { logger } from '../../shared/logger'

export interface DomainEvent {
  id: string
  type: string
  aggregateId: string
  aggregateType: string
  timestamp: number
  version: number
  payload: Record<string, unknown>
  metadata?: Record<string, string>
}

export interface EventStoreOptions {
  /** Base directory for event logs. */
  baseDir: string
  /** Max events per JSONL file before rotation. */
  fileRotationCount?: number
}

/**
 * Append-only event store using JSONL (JSON Lines) format.
 *
 * Each aggregate type gets its own directory. Within each directory,
 * events are appended to JSONL files that rotate when they reach the
 * configured threshold.
 *
 * This store is the foundation for:
 * - Session replay (Wave 5.3)
 * - Audit trails
 * - Time-travel debugging
 * - Event sourcing patterns
 */
export class EventStore {
  private options: Required<EventStoreOptions>
  private writeQueue: Map<string, Promise<void>> = new Map()

  constructor(options: EventStoreOptions) {
    this.options = {
      fileRotationCount: 10000,
      ...options
    }
  }

  /**
   * Appends an event to the store.
   *
   * Events are written sequentially per aggregate to maintain order.
   * The write queue ensures concurrent writes to the same aggregate
   * don't interleave.
   */
  async append(event: DomainEvent): Promise<void> {
    const { aggregateType, aggregateId } = event
    const dir = this.aggregateDir(aggregateType)
    await mkdir(dir, { recursive: true })

    // Serialize writes per aggregate
    const prevWrite = this.writeQueue.get(`${aggregateType}:${aggregateId}`) ?? Promise.resolve()

    const nextWrite = prevWrite.then(async () => {
      const file = await this.currentFile(dir)
      const line = JSON.stringify(event) + '\n'
      await appendFile(file, line, 'utf-8')
    }).catch((error) => {
      logger.error({ err: error, eventId: event.id }, 'event-store: append failed')
      throw error
    })

    this.writeQueue.set(`${aggregateType}:${aggregateId}`, nextWrite)
    await nextWrite
  }

  /**
   * Reads all events for a specific aggregate.
   */
  async readAggregate(aggregateType: string, aggregateId: string): Promise<DomainEvent[]> {
    const dir = this.aggregateDir(aggregateType)
    const files = await this.listFiles(dir)

    const events: DomainEvent[] = []
    for (const file of files) {
      const content = await readFile(file, 'utf-8')
      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        const event = JSON.parse(line) as DomainEvent
        if (event.aggregateId === aggregateId) {
          events.push(event)
        }
      }
    }

    return events.sort((a, b) => a.version - b.version)
  }

  /**
   * Reads all events of a given aggregate type.
   */
  async readType(aggregateType: string, limit?: number): Promise<DomainEvent[]> {
    const dir = this.aggregateDir(aggregateType)
    const files = await this.listFiles(dir)

    const events: DomainEvent[] = []
    for (const file of files) {
      const content = await readFile(file, 'utf-8')
      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        events.push(JSON.parse(line) as DomainEvent)
      }
    }

    events.sort((a, b) => a.timestamp - b.timestamp)
    return limit ? events.slice(-limit) : events
  }

  /**
   * Reads all events across all aggregates, ordered by timestamp.
   */
  async readAll(limit?: number): Promise<DomainEvent[]> {
    const baseDir = this.options.baseDir
    await mkdir(baseDir, { recursive: true })
    const types = await readdir(baseDir)

    const events: DomainEvent[] = []
    for (const type of types) {
      const typeDir = join(baseDir, type)
      const statRes = await stat(typeDir)
      if (!statRes.isDirectory()) continue

      const files = await this.listFiles(typeDir)
      for (const file of files) {
        const content = await readFile(file, 'utf-8')
        for (const line of content.split('\n')) {
          if (!line.trim()) continue
          events.push(JSON.parse(line) as DomainEvent)
        }
      }
    }

    events.sort((a, b) => a.timestamp - b.timestamp)
    return limit ? events.slice(-limit) : events
  }

  /**
   * Replays events through a reducer function.
   */
  async replay<T>(
    aggregateType: string,
    aggregateId: string,
    reducer: (state: T, event: DomainEvent) => T,
    initialState: T
  ): Promise<T> {
    const events = await this.readAggregate(aggregateType, aggregateId)
    return events.reduce(reducer, initialState)
  }

  /**
   * Computes a hash of all events for integrity verification.
   */
  async computeIntegrityHash(aggregateType: string): Promise<string> {
    const baseDir = this.aggregateDir(aggregateType)
    const hash = createHash('sha256')
    const files = await this.listFiles(baseDir)

    for (const file of files) {
      const content = await readFile(file)
      hash.update(content)
    }

    return hash.digest('hex')
  }

  private aggregateDir(type: string): string {
    return join(this.options.baseDir, type)
  }

  private async listFiles(dir: string): Promise<string[]> {
    try {
      const entries = await readdir(dir)
      return entries
        .filter(f => f.endsWith('.jsonl'))
        .map(f => join(dir, f))
        .sort()
    } catch {
      return []
    }
  }

  private async currentFile(dir: string): Promise<string> {
    const files = await this.listFiles(dir)
    if (files.length === 0) {
      return join(dir, '00000001.jsonl')
    }

    const latest = files[files.length - 1]
    const content = await readFile(latest, 'utf-8')
    const lines = content.split('\n').filter(l => l.trim())

    if (lines.length >= this.options.fileRotationCount) {
      const num = parseInt(latest.split('/').pop()!.replace('.jsonl', ''), 10) + 1
      return join(dir, num.toString().padStart(8, '0') + '.jsonl')
    }

    return latest
  }
}

// Factory function
export function createEventStore(baseDir: string): EventStore {
  return new EventStore({ baseDir })
}
