import { isObject } from '@shared/command-catalog'

export function graphResult(response: unknown) {
  if (!isObject(response)) throw new Error('Invalid graph response')
  const text = Array.isArray(response.content) ? response.content.filter(item => isObject(item) && item.type === 'text').map(item => item.text).join('\n') : ''
  if (response.isError === true) throw new Error(text || 'Graph request failed')
  const value: unknown = response.structuredContent ?? JSON.parse(text)
  if (!isObject(value)) throw new Error('Invalid graph result')
  const freshness = isObject(value.freshness) ? value.freshness : {}
  const callers: { name: string; strategy: string; confidence: number | null }[] = []
  if (value.status !== 'indexed') {
    if (!isObject(value.callers) || !Array.isArray(value.callers.cols) || !Array.isArray(value.callers.groups)) throw new Error('Unsupported caller response')
    const columns = value.callers.cols
    for (const group of value.callers.groups) {
      if (!isObject(group) || !Array.isArray(group.rows)) throw new Error('Invalid caller group')
      for (const row of group.rows) {
        if (!Array.isArray(row) || typeof row[columns.indexOf('name')] !== 'string') throw new Error('Invalid caller row')
        const confidence: unknown = row[columns.indexOf('confidence')]
        if (callers.length < 200) callers.push({ name: row[columns.indexOf('name')], strategy: String(row[columns.indexOf('strategy')] ?? 'unknown'), confidence: typeof confidence === 'number' && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? confidence : null })
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
