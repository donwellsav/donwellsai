import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  BROWSER_HISTORY_LIMIT,
  type BrowserHistoryEntry,
  type BrowserHistoryRecord
} from '@shared/browser-history'

const FILE = 'browser-history.json'
const MAX_URL_BYTES = 8 * 1024
const MAX_TITLE_LENGTH = 512

function normalizeUrl(rawUrl: string): { url: string; normalizedUrl: string } | null {
  const trimmed = rawUrl.trim()
  if (!trimmed || Buffer.byteLength(trimmed, 'utf8') > MAX_URL_BYTES) return null

  try {
    const parsed = new URL(trimmed)
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
      return null
    }
    const url = parsed.toString()
    parsed.hash = ''
    return { url, normalizedUrl: parsed.toString() }
  } catch {
    return null
  }
}

function cleanTitle(rawTitle: string, fallback: string): string {
  const title = rawTitle
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_LENGTH)
  return title || fallback
}

function sanitizeEntry(value: unknown): BrowserHistoryEntry | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<BrowserHistoryEntry>
  if (typeof candidate.url !== 'string') return null
  const normalized = normalizeUrl(candidate.url)
  if (!normalized) return null

  const lastVisitedAt = candidate.lastVisitedAt
  const visitCount = candidate.visitCount
  if (
    typeof lastVisitedAt !== 'number' ||
    !Number.isFinite(lastVisitedAt) ||
    typeof visitCount !== 'number' ||
    !Number.isSafeInteger(visitCount) ||
    visitCount < 1
  ) return null

  return {
    ...normalized,
    title: cleanTitle(typeof candidate.title === 'string' ? candidate.title : '', normalized.url),
    lastVisitedAt: Math.max(0, lastVisitedAt),
    visitCount
  }
}

/** Atomic, bounded, main-process authority for local browser history. */
export class BrowserHistoryStore {
  readonly path: string
  private readonly limit: number

  constructor(
    userDataDir: string,
    limit = BROWSER_HISTORY_LIMIT,
    private readonly now: () => number = Date.now,
    private readonly recordingEnabled: () => boolean = () => true
  ) {
    this.path = join(userDataDir, FILE)
    this.limit = Math.max(1, Math.min(BROWSER_HISTORY_LIMIT, Math.floor(limit)))
  }

  list(): BrowserHistoryEntry[] {
    let values: unknown
    try {
      values = JSON.parse(readFileSync(this.path, 'utf8'))
    } catch {
      return []
    }
    if (!Array.isArray(values)) return []

    const byUrl = new Map<string, BrowserHistoryEntry>()
    for (const value of values) {
      const entry = sanitizeEntry(value)
      if (!entry) continue
      const current = byUrl.get(entry.normalizedUrl)
      if (!current) {
        byUrl.set(entry.normalizedUrl, entry)
        continue
      }
      const newest = current.lastVisitedAt >= entry.lastVisitedAt ? current : entry
      byUrl.set(entry.normalizedUrl, {
        ...newest,
        visitCount: Math.min(Number.MAX_SAFE_INTEGER, current.visitCount + entry.visitCount)
      })
    }

    return [...byUrl.values()]
      .sort((left, right) =>
        right.lastVisitedAt - left.lastVisitedAt ||
        right.visitCount - left.visitCount ||
        left.normalizedUrl.localeCompare(right.normalizedUrl)
      )
      .slice(0, this.limit)
      .map((entry) => ({ ...entry }))
  }

  record(input: BrowserHistoryRecord): BrowserHistoryEntry[] {
    const normalized = normalizeUrl(input.url)
    if (!normalized) throw new Error('browser history only accepts HTTP(S) URLs without credentials')

    const entries = this.list()
    if (!this.recordingEnabled()) return entries
    const previous = entries.find((entry) => entry.normalizedUrl === normalized.normalizedUrl)
    const next: BrowserHistoryEntry = {
      ...normalized,
      title: cleanTitle(input.title, normalized.url),
      lastVisitedAt: this.now(),
      visitCount: Math.min(Number.MAX_SAFE_INTEGER, (previous?.visitCount ?? 0) + 1)
    }
    const updated = [next, ...entries.filter((entry) => entry.normalizedUrl !== next.normalizedUrl)]
      .sort((left, right) => right.lastVisitedAt - left.lastVisitedAt)
      .slice(0, this.limit)
    this.save(updated)
    return updated.map((entry) => ({ ...entry }))
  }

  clear(): void {
    rmSync(this.path, { force: true })
    rmSync(`${this.path}.tmp`, { force: true })
  }

  private save(entries: BrowserHistoryEntry[]): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(entries, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.path)
  }
}
