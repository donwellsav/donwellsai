import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserHistoryStore } from '../src/main/browser-history'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'donwells-browser-history-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('BrowserHistoryStore', () => {
  it('deduplicates fragment visits, updates the title, and keeps only the newest bounded entries', () => {
    const directory = temporaryDirectory()
    let now = 100
    const store = new BrowserHistoryStore(directory, 2, () => ++now)

    store.record({ url: 'https://example.test/page#one', title: 'First title' })
    store.record({ url: 'http://localhost:3000/', title: 'Local app' })
    store.record({ url: 'https://example.test/page#two', title: 'Updated title' })
    store.record({ url: 'https://newest.test/', title: 'Newest' })

    expect(store.list()).toEqual([
      {
        url: 'https://newest.test/',
        normalizedUrl: 'https://newest.test/',
        title: 'Newest',
        lastVisitedAt: 104,
        visitCount: 1
      },
      {
        url: 'https://example.test/page#two',
        normalizedUrl: 'https://example.test/page',
        title: 'Updated title',
        lastVisitedAt: 103,
        visitCount: 2
      }
    ])
    expect(JSON.parse(readFileSync(store.path, 'utf8'))).toHaveLength(2)
  })

  it('filters malformed persisted rows and refuses non-HTTP or credential-bearing records', () => {
    const directory = temporaryDirectory()
    const store = new BrowserHistoryStore(directory)
    writeFileSync(store.path, JSON.stringify([
      { url: 'file:///tmp/private', title: 'Private', lastVisitedAt: 1, visitCount: 1 },
      { url: 'https://valid.test/', title: 'Valid', lastVisitedAt: 2, visitCount: 1 },
      { url: 'https://invalid.test/', title: 'Invalid count', lastVisitedAt: 3, visitCount: 0 }
    ]))

    expect(store.list()).toEqual([
      {
        url: 'https://valid.test/',
        normalizedUrl: 'https://valid.test/',
        title: 'Valid',
        lastVisitedAt: 2,
        visitCount: 1
      }
    ])
    expect(() => store.record({ url: 'file:///tmp/private', title: 'Private' })).toThrow(
      'browser history only accepts HTTP(S) URLs without credentials'
    )
    expect(() => store.record({ url: 'https://user:secret@example.test/', title: 'Secret' })).toThrow(
      'browser history only accepts HTTP(S) URLs without credentials'
    )
  })

  it('removes the main-owned history file when explicitly cleared', () => {
    const store = new BrowserHistoryStore(temporaryDirectory())
    store.record({ url: 'https://example.test/', title: 'Example' })

    store.clear()

    expect(store.list()).toEqual([])
  })
})
