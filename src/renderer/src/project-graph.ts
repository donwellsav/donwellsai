import { isObject } from '@shared/command-catalog'

export function selectedGraphSymbol(selection: string, word = ''): string {
  const symbol = (selection || word).trim()
  if (!symbol || symbol.length > 128 || /[\0\r\n]/.test(symbol)) throw new Error('Select one bounded symbol before opening the code graph.')
  return symbol
}

function graphValue(response: unknown) {
  if (!isObject(response)) throw new Error('Invalid graph response')
  const text = Array.isArray(response.content) ? response.content.filter(item => isObject(item) && item.type === 'text').map(item => item.text).join('\n') : ''
  if (response.isError === true) throw new Error(text || 'Graph request failed')
  const value: unknown = response.structuredContent ?? JSON.parse(text)
  if (!isObject(value)) throw new Error('Invalid graph result')
  return value
}

export function graphSource(response: unknown) {
  const value = graphValue(response)
  if (!isObject(value.freshness) || value.freshness.state !== 'current') throw new Error('Source changed or freshness is unverified. Rebuild the code index before opening this symbol.')
  if (typeof value.file_path !== 'string' || !Number.isSafeInteger(value.start_line) || Number(value.start_line) < 1 || typeof value.source !== 'string' || value.source === '(source not available)') throw new Error('Graph source is unavailable')
  return { path: value.file_path, line: Number(value.start_line), firstLine: value.source.split('\n')[0]!.replace(/\r$/, '') }
}

export function graphDefinitions(response: unknown) {
  const value = graphValue(response), freshness = isObject(value.freshness) ? value.freshness : {}
  if (!Array.isArray(value.cols) || !Array.isArray(value.groups)) throw new Error('Unsupported definition response')
  const nameIndex = value.cols.indexOf('name'), labelIndex = value.cols.indexOf('label'), linesIndex = value.cols.indexOf('lines')
  if (nameIndex < 0 || labelIndex < 0 || linesIndex < 0) throw new Error('Unsupported definition response')
  const definitions: { name: string; qualifiedName: string; label: string; path: string; line: number }[] = []
  for (const group of value.groups) {
    if (!isObject(group) || typeof group.qn_prefix !== 'string' || typeof group.file !== 'string' || !Array.isArray(group.rows)) throw new Error('Invalid definition group')
    for (const row of group.rows) {
      if (!Array.isArray(row) || typeof row[nameIndex] !== 'string' || typeof row[labelIndex] !== 'string' || typeof row[linesIndex] !== 'string') throw new Error('Invalid definition row')
      const line = Number(/^\d+/.exec(row[linesIndex])?.[0])
      if (!Number.isSafeInteger(line) || line < 1) throw new Error('Invalid definition line')
      definitions.push({ name: row[nameIndex], qualifiedName: group.qn_prefix ? `${group.qn_prefix}.${row[nameIndex]}` : row[nameIndex], label: row[labelIndex], path: group.file, line })
    }
  }
  return { definitions, freshness: freshness.state === 'current' || freshness.state === 'stale' ? freshness.state : 'unknown' }
}

export function graphImports(response: unknown) {
  const value = graphValue(response), freshness = isObject(value.freshness) ? value.freshness : {}
  if (!Array.isArray(value.imports) || value.imports.some(name => typeof name !== 'string' || !name)) throw new Error('Unsupported import response')
  return { imports: value.imports as string[], freshness: freshness.state === 'current' || freshness.state === 'stale' ? freshness.state : 'unknown' }
}

export function graphResult(response: unknown) {
  const value = graphValue(response)
  const freshness = isObject(value.freshness) ? value.freshness : {}
  const callers: { name: string; qualifiedName: string | null; strategy: string; confidence: number | null }[] = []
  if (value.status !== 'indexed') {
    if (!isObject(value.callers) || !Array.isArray(value.callers.cols) || !Array.isArray(value.callers.groups)) throw new Error('Unsupported caller response')
    const columns = value.callers.cols
    for (const group of value.callers.groups) {
      if (!isObject(group) || !Array.isArray(group.rows)) throw new Error('Invalid caller group')
      for (const row of group.rows) {
        if (!Array.isArray(row) || typeof row[columns.indexOf('name')] !== 'string') throw new Error('Invalid caller row')
        const confidence: unknown = row[columns.indexOf('confidence')]
        const name = row[columns.indexOf('name')] as string
        if (callers.length < 200) callers.push({ name, qualifiedName: typeof group.qn_prefix === 'string' ? (group.qn_prefix ? `${group.qn_prefix}.${name}` : name) : null, strategy: String(row[columns.indexOf('strategy')] ?? 'unknown'), confidence: typeof confidence === 'number' && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? confidence : null })
      }
    }
  }
  return {
    callers,
    total: typeof value.callers_total === 'number' ? value.callers_total : callers.length,
    indexed: value.status === 'indexed',
    nodes: typeof value.nodes === 'number' ? value.nodes : null,
    partial: typeof value.parse_partial_count === 'number' ? value.parse_partial_count : null,
    freshness: freshness.state === 'current' || freshness.state === 'stale' ? freshness.state : 'unknown',
    indexedAt: typeof freshness.indexedAt === 'string' ? freshness.indexedAt : null
  }
}
