import { expect, it } from 'vitest'
import { graphDefinitions, graphImports, graphResult, graphSource, selectedGraphSymbol } from '../src/renderer/src/project-graph'

it('uses an explicit selection or cursor word for graph navigation', () => {
  expect(selectedGraphSymbol('  selected.call  ', 'ignored')).toBe('selected.call')
  expect(selectedGraphSymbol('', 'cursorWord')).toBe('cursorWord')
  expect(() => selectedGraphSymbol('', '')).toThrow('Select one bounded symbol')
  expect(() => selectedGraphSymbol('first\nsecond')).toThrow('Select one bounded symbol')
})

it('preserves native caller evidence, rejects errors and defaults missing freshness to unknown', () => {
  const value = { function: 'target', callers_total: 1, callers: { cols: ['confidence', 'name', 'strategy'], groups: [{ rows: [[0.95, 'caller', 'lsp']] }] }, freshness: { state: 'stale', indexedAt: '2026-09-06T00:00:00Z' } }
  const result = graphResult({ structuredContent: value })
  expect(result.callers).toEqual([{ name: 'caller', qualifiedName: null, strategy: 'lsp', confidence: 0.95 }])
  expect(result.freshness).toBe('stale')
  expect(graphResult({ content: [{ type: 'text', text: JSON.stringify({ status: 'indexed', nodes: 3, parse_partial_count: 1 }) }] }).freshness).toBe('unknown')
  expect(() => graphResult({ isError: true, content: [{ type: 'text', text: 'Index unavailable' }] })).toThrow('Index unavailable')
  expect(() => graphResult({ structuredContent: { callers: {} } })).toThrow()
})

it('preserves qualified caller identity and rejects stale source navigation', () => {
  const caller = graphResult({ structuredContent: { callers: { cols: ['name'], groups: [{ qn_prefix: 'checkout.code', rows: [['caller']] }] } } }).callers[0]!
  expect(caller.qualifiedName).toBe('checkout.code.caller')
  const source = { file_path: 'code.ts', start_line: 2, source: 'function caller() {}\r\n', freshness: { state: 'current' } }
  expect(graphSource({ structuredContent: source })).toEqual({ path: 'code.ts', line: 2, firstLine: 'function caller() {}' })
  expect(() => graphSource({ structuredContent: { ...source, freshness: { state: 'stale' } } })).toThrow('Rebuild')
  expect(() => graphSource({ structuredContent: { ...source, start_line: 0 } })).toThrow('unavailable')
})

it('parses exact definitions and imports with freshness', () => {
  expect(graphDefinitions({ structuredContent: { cols: ['name', 'label', 'lines'], groups: [{ qn_prefix: 'checkout.code', file: 'code.ts', rows: [['target', 'Function', '2-4']] }], freshness: { state: 'current' } } })).toEqual({ definitions: [{ name: 'target', qualifiedName: 'checkout.code.target', label: 'Function', path: 'code.ts', line: 2 }], freshness: 'current' })
  expect(graphImports({ structuredContent: { imports: ['checkout.dep.one'], freshness: { state: 'stale' } } })).toEqual({ imports: ['checkout.dep.one'], freshness: 'stale' })
  expect(() => graphDefinitions({ structuredContent: { cols: [], groups: [] } })).toThrow('Unsupported')
  expect(() => graphImports({ structuredContent: { imports: [null] } })).toThrow('Unsupported')
})
