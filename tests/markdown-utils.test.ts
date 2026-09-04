import { describe, expect, it } from 'vitest'
import { scanNeeds, slugify, splitFrontMatter } from '../src/renderer/src/lib/markdown'

describe('markdown pre-pass helpers', () => {
  it('splitFrontMatter separates meta and keeps the body intact', () => {
    const { meta, body } = splitFrontMatter('---\ntitle: Ship It\ntags: [a, b]\nempty:\n---\n\n# Hello\n')
    expect(meta).toEqual({ title: 'Ship It', tags: '[a, b]', empty: '' })
    expect(body).toBe('\n# Hello\n')
  })

  it('splitFrontMatter passes through when absent or empty', () => {
    expect(splitFrontMatter('# x').meta).toBeNull()
    expect(splitFrontMatter('---\n---\nbody').meta).toBeNull()
  })

  it('slugify matches GitHub anchor rules', () => {
    expect(slugify('Hello, World!')).toBe('hello-world')
    expect(slugify('`code` in heading')).toBe('code-in-heading')
    expect(slugify('  spaced  out  ')).toBe('spaced-out')
  })

  it('scanNeeds gates the heavy renderers', () => {
    expect(scanNeeds('# plain')).toEqual({ mermaid: false, math: false })
    expect(scanNeeds('```mermaid\ngraph TD;A-->B\n```').mermaid).toBe(true)
    expect(scanNeeds('cost is $5 and $7').math).toBe(false)
    expect(scanNeeds('inline $x^2$ here')).toEqual({ mermaid: false, math: true })
    expect(scanNeeds('block $$\\int x dx$$ here').math).toBe(true)
    expect(scanNeeds('100% sure').math).toBe(false)
  })
})
