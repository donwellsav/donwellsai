export type ResolvedDocumentLink =
  | { kind: 'external'; href: string }
  | { kind: 'anchor'; anchor: string }
  | {
      kind: 'file'
      relPath: string
      mode: 'edit' | 'preview'
      line?: number
      column?: number
      anchor?: string
    }

const URI_SCHEME = /^[a-z][a-z\d+.-]*:/i
const HTTP_SCHEME = /^https?:/i
const ABSOLUTE_HTTP_URL = /^https?:\/\/[^/?#\s]+(?:[/?#]|$)/i
const MARKDOWN_EXTENSION = /\.(?:md|markdown|mdx)$/i
const SOURCE_LOCATION = /^(.*?):(\d+)(?::(\d+))?$/
const GITHUB_LINE = /^L(\d+)(?:C(\d+))?$/i
const INVALID_LINK_CHARACTER = /[\u0000-\u001f\u007f]/

function decodeLinkPart(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value)
    return INVALID_LINK_CHARACTER.test(decoded) ? undefined : decoded
  } catch {
    return undefined
  }
}

function normalizeRelativePath(currentRelPath: string, linkedPath: string): string | undefined {
  if (
    !currentRelPath ||
    INVALID_LINK_CHARACTER.test(currentRelPath) ||
    currentRelPath.startsWith('/') ||
    currentRelPath.startsWith('\\') ||
    currentRelPath.includes('\\') ||
    !linkedPath ||
    INVALID_LINK_CHARACTER.test(linkedPath) ||
    linkedPath.startsWith('/') ||
    linkedPath.startsWith('\\') ||
    linkedPath.includes('\\')
  ) return undefined

  const base: string[] = []
  for (const segment of currentRelPath.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (base.length === 0) return undefined
      base.pop()
      continue
    }
    base.push(segment)
  }
  if (base.length === 0) return undefined
  base.pop()

  for (const segment of linkedPath.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (base.length === 0) return undefined
      base.pop()
      continue
    }
    base.push(segment)
  }
  return base.length > 0 ? base.join('/') : undefined
}

function resolveExternalHttpUrl(value: string): ResolvedDocumentLink | undefined {
  if (!ABSOLUTE_HTTP_URL.test(value)) return undefined
  try {
    const url = new URL(value)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return undefined
    return { kind: 'external', href: value }
  } catch {
    return undefined
  }
}

function positiveLocation(value: string): number | undefined {
  const location = Number(value)
  return Number.isSafeInteger(location) && location > 0 ? location : undefined
}

export function resolveDocumentLink(currentRelPath: string, href: string): ResolvedDocumentLink | undefined {
  const value = href.trim()
  if (!value || INVALID_LINK_CHARACTER.test(value)) return undefined
  if (value.startsWith('#')) {
    const anchor = decodeLinkPart(value.slice(1))
    return anchor === undefined ? undefined : { kind: 'anchor', anchor }
  }
  if (HTTP_SCHEME.test(value)) return resolveExternalHttpUrl(value)
  if (value.startsWith('//')) return undefined

  const hashIndex = value.indexOf('#')
  const queryIndex = value.indexOf('?')
  const pathEndCandidates = [hashIndex, queryIndex].filter((index) => index >= 0)
  const pathEnd = pathEndCandidates.length > 0 ? Math.min(...pathEndCandidates) : value.length
  const decodedPath = decodeLinkPart(value.slice(0, pathEnd))
  if (!decodedPath) return undefined

  const rawFragment = hashIndex >= 0 ? value.slice(hashIndex + 1) : ''
  const fragment = decodeLinkPart(rawFragment)
  if (fragment === undefined) return undefined

  let linkedPath = decodedPath
  let line: number | undefined
  let column: number | undefined
  const sourceLocation = SOURCE_LOCATION.exec(linkedPath)
  if (sourceLocation?.[1]) {
    // A root-level source reference can look like a URI scheme (file.ts:12).
    // Only disambiguate it as a file when its prefix is recognizably path-like;
    // opaque unsupported schemes such as javascript:12 remain rejected.
    if (URI_SCHEME.test(decodedPath) && !/[./]/.test(sourceLocation[1])) return undefined
    linkedPath = sourceLocation[1]
    line = positiveLocation(sourceLocation[2])
    if (line === undefined) return undefined
    if (sourceLocation[3]) {
      column = positiveLocation(sourceLocation[3])
      if (column === undefined) return undefined
    }
  }
  if (URI_SCHEME.test(linkedPath)) return undefined

  const githubLine = GITHUB_LINE.exec(fragment)
  if (githubLine) {
    line = positiveLocation(githubLine[1])
    if (line === undefined) return undefined
    if (githubLine[2]) {
      column = positiveLocation(githubLine[2])
      if (column === undefined) return undefined
    }
  }

  const relPath = normalizeRelativePath(currentRelPath, linkedPath)
  if (!relPath) return undefined
  return {
    kind: 'file',
    relPath,
    mode: line === undefined && MARKDOWN_EXTENSION.test(relPath) ? 'preview' : 'edit',
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
    ...(hashIndex >= 0 && !githubLine ? { anchor: fragment } : {})
  }
}
