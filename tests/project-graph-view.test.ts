import { expect, it } from 'vitest'
import { graphResult } from '../src/renderer/src/project-graph'

it('preserves native caller evidence, rejects errors and defaults missing freshness to unknown', () => {
  const value = { function: 'target', callers_total: 1, callers: { cols: ['confidence', 'name', 'strategy'], groups: [{ rows: [[0.95, 'caller', 'lsp']] }] }, freshness: { state: 'stale', indexedAt: '2026-09-06T00:00:00Z' } }
  const result = graphResult({ structuredContent: value })
  expect(result.callers).toEqual([{ name: 'caller', strategy: 'lsp', confidence: 0.95 }])
  expect(result.freshness).toBe('stale')
  expect(graphResult({ content: [{ type: 'text', text: JSON.stringify({ status: 'indexed', nodes: 3, parse_partial_count: 1 }) }] }).freshness).toBe('unknown')
  expect(() => graphResult({ isError: true, content: [{ type: 'text', text: 'Index unavailable' }] })).toThrow('Index unavailable')
  expect(() => graphResult({ structuredContent: { callers: {} } })).toThrow()
})
