import { describe, expect, it } from 'vitest'
import {
  buildBrowserAddressSuggestions,
  createBrowserAddressState,
  normalizeBrowserCommandUrl,
  reduceBrowserAddress,
  resolveBrowserAddress
} from '../src/renderer/src/browser-address'
import type { BrowserHistoryEntry } from '../src/shared/browser-history'

describe('browser address resolution', () => {
  it('distinguishes local and public addresses from searches under the HTTP(S)-only policy', () => {
    expect(resolveBrowserAddress('localhost:4173/health', 'duckduckgo')).toMatchObject({
      kind: 'url',
      url: 'http://localhost:4173/health'
    })
    expect(resolveBrowserAddress('docs.example.com/reference', 'google')).toMatchObject({
      kind: 'url',
      url: 'https://docs.example.com/reference'
    })
    expect(resolveBrowserAddress('browser navigation state', 'bing')).toEqual({
      kind: 'search',
      url: 'https://www.bing.com/search?q=browser%20navigation%20state',
      label: 'Search Bing for browser navigation state'
    })
    expect(() => resolveBrowserAddress('file:///tmp/private', 'duckduckgo')).toThrow(
      'Only HTTP and HTTPS addresses can be opened'
    )
    expect(() => resolveBrowserAddress('https://user:secret@example.com', 'duckduckgo')).toThrow(
      'Addresses containing credentials are not allowed'
    )
  })

  it('keeps runtime commands URL-only while preserving scheme normalization', () => {
    expect(normalizeBrowserCommandUrl('HTTP://example.test/path')).toBe('http://example.test/path')
    expect(normalizeBrowserCommandUrl('example.test')).toBe('https://example.test')
    expect(() => normalizeBrowserCommandUrl('javascript:alert(1)')).toThrow(
      'Only HTTP and HTTPS addresses can be opened'
    )
  })
})

describe('browser address draft', () => {
  it('does not let live back/forward or load updates clobber a focused edit', () => {
    let state = createBrowserAddressState('https://one.test')
    state = reduceBrowserAddress(state, { type: 'focus' })
    state = reduceBrowserAddress(state, { type: 'change', value: 'unfinished query' })
    state = reduceBrowserAddress(state, { type: 'live-url', url: 'https://two.test' })

    expect(state).toMatchObject({
      liveUrl: 'https://two.test',
      draft: 'unfinished query',
      focused: true,
      dirty: true
    })

    state = reduceBrowserAddress(state, { type: 'blur' })
    expect(state).toEqual({
      liveUrl: 'https://two.test',
      draft: 'https://two.test',
      focused: false,
      dirty: false
    })
  })

  it('keeps a committed target through blur and makes Escape restore the live location', () => {
    let state = createBrowserAddressState('https://one.test')
    state = reduceBrowserAddress(state, { type: 'focus' })
    state = reduceBrowserAddress(state, { type: 'change', value: 'two.test' })
    state = reduceBrowserAddress(state, { type: 'commit', url: 'https://two.test' })
    state = reduceBrowserAddress(state, { type: 'blur' })
    expect(state.draft).toBe('https://two.test')

    state = reduceBrowserAddress(state, { type: 'focus' })
    state = reduceBrowserAddress(state, { type: 'change', value: 'discard me' })
    state = reduceBrowserAddress(state, { type: 'cancel' })
    expect(state).toEqual({
      liveUrl: 'https://one.test',
      draft: 'https://one.test',
      focused: false,
      dirty: false
    })
  })
})

describe('local browser history suggestions', () => {
  const history: BrowserHistoryEntry[] = [
    {
      url: 'https://docs.example.com/browser',
      normalizedUrl: 'https://docs.example.com/browser',
      title: 'Browser reference',
      lastVisitedAt: 100,
      visitCount: 2
    },
    {
      url: 'https://github.com/acme/project',
      normalizedUrl: 'https://github.com/acme/project',
      title: 'Acme source',
      lastVisitedAt: 300,
      visitCount: 5
    },
    {
      url: 'http://localhost:3000/',
      normalizedUrl: 'http://localhost:3000/',
      title: 'Local app',
      lastVisitedAt: 200,
      visitCount: 3
    }
  ]

  it('ranks bounded MRU matches behind the local submit action without remote suggestions', () => {
    const suggestions = buildBrowserAddressSuggestions('git', history, 'duckduckgo', 3)

    expect(suggestions).toEqual([
      {
        id: 'search:https://duckduckgo.com/?q=git',
        kind: 'search',
        url: 'https://duckduckgo.com/?q=git',
        label: 'Search DuckDuckGo for git',
        detail: 'DuckDuckGo'
      },
      {
        id: 'history:https://github.com/acme/project',
        kind: 'history',
        url: 'https://github.com/acme/project',
        label: 'Acme source',
        detail: 'https://github.com/acme/project'
      }
    ])
  })

  it('shows recent local history for an empty draft and suppresses unsafe synthetic actions', () => {
    expect(buildBrowserAddressSuggestions('', history, 'google', 2).map((entry) => entry.url)).toEqual([
      'https://github.com/acme/project',
      'http://localhost:3000/'
    ])
    expect(buildBrowserAddressSuggestions('javascript:alert(1)', history, 'google'))
      .toEqual([])
  })
})
