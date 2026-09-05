import type { BrowserHistoryEntry } from '@shared/browser-history'

export type BrowserSearchEngine = 'duckduckgo' | 'google' | 'bing'

const SEARCH_URL_BY_ENGINE: Record<BrowserSearchEngine, string> = {
  duckduckgo: 'https://duckduckgo.com/?q=',
  google: 'https://www.google.com/search?q=',
  bing: 'https://www.bing.com/search?q='
}

const SEARCH_LABEL_BY_ENGINE: Record<BrowserSearchEngine, string> = {
  duckduckgo: 'DuckDuckGo',
  google: 'Google',
  bing: 'Bing'
}

const EXPLICIT_SCHEME = /^[a-z][a-z\d+.-]*:/i
const HTTP_SCHEME = /^https?:\/\//i
const LOCAL_ADDRESS = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[[0-9a-f:]+\])(?::\d+)?(?:[/?#].*)?$/i
const IPV4_ADDRESS = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:[/?#].*)?$/
const HOST_WITH_PORT = /^[a-z\d](?:[a-z\d-]*[a-z\d])?:\d+(?:[/?#].*)?$/i
const DOMAIN_ADDRESS = /^(?:[^\s./]+\.)+[^\s./:]{2,}(?::\d+)?(?:[/?#].*)?$/i

export const BROWSER_ADDRESS_QUERY_MAX_BYTES = 2 * 1024
export const BROWSER_ADDRESS_SUGGESTION_LIMIT = 8

export type ResolvedBrowserAddress = {
  kind: 'url' | 'search'
  url: string
  label: string
}

export type BrowserAddressSuggestion = {
  id: string
  kind: 'history' | 'url' | 'search'
  url: string
  label: string
  detail: string
}

export type BrowserAddressState = {
  liveUrl: string
  draft: string
  focused: boolean
  dirty: boolean
}

export type BrowserAddressAction =
  | { type: 'focus' }
  | { type: 'change'; value: string }
  | { type: 'live-url'; url: string }
  | { type: 'commit'; url: string }
  | { type: 'cancel' }
  | { type: 'blur' }

function addressCandidate(rawInput: string, addressBar: boolean): { candidate: string; kind: 'url' | 'search' } {
  const input = rawInput.trim()
  if (!input) throw new Error(addressBar ? 'Enter an address or search' : 'browser URL is required')
  if (new TextEncoder().encode(input).byteLength > BROWSER_ADDRESS_QUERY_MAX_BYTES) {
    throw new Error('Address or search is too long')
  }

  if (HTTP_SCHEME.test(input)) return { candidate: input, kind: 'url' }
  if (LOCAL_ADDRESS.test(input) || IPV4_ADDRESS.test(input) || HOST_WITH_PORT.test(input)) {
    return { candidate: `http://${input}`, kind: 'url' }
  }
  if (EXPLICIT_SCHEME.test(input)) throw new Error('Only HTTP and HTTPS addresses can be opened')
  if (!addressBar) return { candidate: `https://${input}`, kind: 'url' }
  if (DOMAIN_ADDRESS.test(input)) return { candidate: `https://${input}`, kind: 'url' }
  return { candidate: input, kind: 'search' }
}

function validateHttpAddress(candidate: string): string {
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error('Enter a valid HTTP or HTTPS address')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS addresses can be opened')
  }
  if (!parsed.hostname) throw new Error('Enter a valid HTTP or HTTPS address')
  if (parsed.username || parsed.password) throw new Error('Addresses containing credentials are not allowed')

  const separator = candidate.indexOf(':')
  return candidate.slice(0, separator).toLowerCase() + candidate.slice(separator)
}

/** Strict URL-only normalization for persisted panes and runtime RPC commands. */
export function normalizeBrowserCommandUrl(rawInput: string): string {
  const { candidate } = addressCandidate(rawInput, false)
  return validateHttpAddress(candidate)
}

/** Resolve a user omnibox submission locally: direct HTTP(S) target or configured search. */
export function resolveBrowserAddress(
  rawInput: string,
  searchEngine: BrowserSearchEngine
): ResolvedBrowserAddress {
  const { candidate, kind } = addressCandidate(rawInput, true)
  if (kind === 'url') {
    const url = validateHttpAddress(candidate)
    return { kind, url, label: `Go to ${rawInput.trim()}` }
  }
  const query = candidate.trim()
  return {
    kind,
    url: `${SEARCH_URL_BY_ENGINE[searchEngine]}${encodeURIComponent(query)}`,
    label: `Search ${SEARCH_LABEL_BY_ENGINE[searchEngine]} for ${query}`
  }
}

function historyMatchTier(entry: BrowserHistoryEntry, query: string): number | null {
  let host = ''
  try {
    host = new URL(entry.url).host.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
  const lowerUrl = entry.url.toLowerCase()
  if (host.startsWith(query) || lowerUrl.startsWith(query)) return 0
  if (host.includes(query)) return 1
  if (entry.title.toLowerCase().includes(query)) return 2
  return lowerUrl.includes(query) ? 3 : null
}

/** Build a bounded suggestion list from only local history plus the local submit action. */
export function buildBrowserAddressSuggestions(
  rawInput: string,
  history: readonly BrowserHistoryEntry[],
  searchEngine: BrowserSearchEngine,
  limit = BROWSER_ADDRESS_SUGGESTION_LIMIT
): BrowserAddressSuggestion[] {
  const safeLimit = Math.max(0, Math.min(BROWSER_ADDRESS_SUGGESTION_LIMIT, Math.floor(limit)))
  if (safeLimit === 0) return []
  const input = rawInput.trim()
  if (new TextEncoder().encode(input).byteLength > BROWSER_ADDRESS_QUERY_MAX_BYTES) return []

  const query = input.toLowerCase()
  const ranked = history
    .map((entry) => ({ entry, tier: query ? historyMatchTier(entry, query) : 0 }))
    .filter((candidate): candidate is { entry: BrowserHistoryEntry; tier: number } => candidate.tier !== null)
    .sort((left, right) =>
      left.tier - right.tier ||
      right.entry.lastVisitedAt - left.entry.lastVisitedAt ||
      right.entry.visitCount - left.entry.visitCount ||
      left.entry.normalizedUrl.localeCompare(right.entry.normalizedUrl)
    )

  const suggestions: BrowserAddressSuggestion[] = []
  let resolved: ResolvedBrowserAddress | null = null
  if (input) {
    try {
      resolved = resolveBrowserAddress(input, searchEngine)
      suggestions.push({
        id: `${resolved.kind}:${resolved.url}`,
        kind: resolved.kind,
        url: resolved.url,
        label: resolved.label,
        detail: resolved.kind === 'search' ? SEARCH_LABEL_BY_ENGINE[searchEngine] : resolved.url
      })
    } catch {
      // Invalid explicit schemes get no synthetic action; submission reports the precise error.
    }
  }

  for (const { entry } of ranked) {
    if (suggestions.length >= safeLimit) break
    if (resolved && entry.normalizedUrl === normalizeSuggestionUrl(resolved.url)) continue
    suggestions.push({
      id: `history:${entry.normalizedUrl}`,
      kind: 'history',
      url: entry.url,
      label: entry.title,
      detail: entry.url
    })
  }
  return suggestions.slice(0, safeLimit)
}

function normalizeSuggestionUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return rawUrl
  }
}

export function createBrowserAddressState(url: string): BrowserAddressState {
  return { liveUrl: url, draft: url, focused: false, dirty: false }
}

/** Address editing state: live navigation cannot overwrite a focused dirty draft. */
export function reduceBrowserAddress(
  state: BrowserAddressState,
  action: BrowserAddressAction
): BrowserAddressState {
  switch (action.type) {
    case 'focus':
      return { ...state, focused: true }
    case 'change':
      return { ...state, draft: action.value, focused: true, dirty: true }
    case 'live-url':
      return {
        ...state,
        liveUrl: action.url,
        draft: state.focused && state.dirty ? state.draft : action.url
      }
    case 'commit':
      return { ...state, draft: action.url, dirty: false }
    case 'cancel':
      return { ...state, draft: state.liveUrl, focused: false, dirty: false }
    case 'blur':
      return {
        ...state,
        draft: state.dirty ? state.liveUrl : state.draft,
        focused: false,
        dirty: false
      }
  }
}
