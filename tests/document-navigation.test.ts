import { describe, expect, it } from 'vitest'
import { resolveDocumentLink } from '../src/renderer/src/document-navigation'

describe('document link resolution', () => {
  it('allows only well-formed absolute HTTP(S) links to leave the app', () => {
    expect(resolveDocumentLink('docs/guide.md', ' https://example.com/api?q=1#types ')).toEqual({
      kind: 'external',
      href: 'https://example.com/api?q=1#types'
    })
    expect(resolveDocumentLink('docs/guide.md', 'HTTP://localhost:4173/status')).toEqual({
      kind: 'external',
      href: 'HTTP://localhost:4173/status'
    })

    for (const href of [
      '//example.com/path',
      'https://',
      'https:/example.com',
      'http://exa mple.com',
      'mailto:team@example.com',
      'file:///etc/passwd',
      'ftp://example.com/file',
      'data:text/html,hello',
      'javascript:alert(1)',
      'javascript:12'
    ]) {
      expect(resolveDocumentLink('docs/guide.md', href), href).toBeUndefined()
    }
  })

  it('decodes same-document anchors without accepting malformed escapes or controls', () => {
    expect(resolveDocumentLink('docs/guide.md', '#api%2Fv2%20%5Bstable%5D')).toEqual({
      kind: 'anchor',
      anchor: 'api/v2 [stable]'
    })
    expect(resolveDocumentLink('docs/guide.md', '#')).toEqual({ kind: 'anchor', anchor: '' })
    expect(resolveDocumentLink('docs/guide.md', '#bad%ZZ')).toBeUndefined()
    expect(resolveDocumentLink('docs/guide.md', '#bad%0Aanchor')).toBeUndefined()
  })

  it('normalizes nested relative paths but never escapes the workspace', () => {
    expect(resolveDocumentLink('docs/guides/setup.md', '../../README.md#overview')).toEqual({
      kind: 'file',
      relPath: 'README.md',
      mode: 'preview',
      anchor: 'overview'
    })
    expect(resolveDocumentLink('docs/guides/setup.md', '..%2F..%2FCHANGELOG.md')).toEqual({
      kind: 'file',
      relPath: 'CHANGELOG.md',
      mode: 'preview'
    })

    for (const href of [
      '../../../outside.md',
      '..%2F..%2F..%2Foutside.md',
      '/etc/passwd',
      '%2Fetc%2Fpasswd',
      '\\server\\share.md',
      '..%5Coutside.md',
      'bad%00name.md'
    ]) {
      expect(resolveDocumentLink('docs/guides/setup.md', href), href).toBeUndefined()
    }
    expect(resolveDocumentLink('../docs/setup.md', 'next.md')).toBeUndefined()
  })

  it('turns source locations into editor navigation with validated one-based positions', () => {
    expect(resolveDocumentLink('docs/guide.md', '../src/index.ts:27:4')).toEqual({
      kind: 'file',
      relPath: 'src/index.ts',
      mode: 'edit',
      line: 27,
      column: 4
    })
    expect(resolveDocumentLink('docs/guide.md', '../README.md:9')).toEqual({
      kind: 'file',
      relPath: 'README.md',
      mode: 'edit',
      line: 9
    })
    expect(resolveDocumentLink('docs/guide.md', '../src/index.ts#L31C8')).toEqual({
      kind: 'file',
      relPath: 'src/index.ts',
      mode: 'edit',
      line: 31,
      column: 8
    })
    expect(resolveDocumentLink('docs/guide.md', './Makefile:12')).toEqual({
      kind: 'file',
      relPath: 'docs/Makefile',
      mode: 'edit',
      line: 12
    })

    for (const href of ['../src/index.ts:0', '../src/index.ts:2:0', '../src/index.ts#L0', '../src/index.ts#L2C0']) {
      expect(resolveDocumentLink('docs/guide.md', href), href).toBeUndefined()
    }
  })

  it('routes Markdown, source, and media targets through one normalized file result', () => {
    expect(resolveDocumentLink('docs/guide.md', './chapter%202.mdx#deep%20dive')).toEqual({
      kind: 'file',
      relPath: 'docs/chapter 2.mdx',
      mode: 'preview',
      anchor: 'deep dive'
    })
    expect(resolveDocumentLink('docs/guide.md', '../assets/diagram.png')).toEqual({
      kind: 'file',
      relPath: 'assets/diagram.png',
      mode: 'edit'
    })
    expect(resolveDocumentLink('docs/guide.md', '../spec.pdf#page%3D2')).toEqual({
      kind: 'file',
      relPath: 'spec.pdf',
      mode: 'edit',
      anchor: 'page=2'
    })
    expect(resolveDocumentLink('docs/guide.md', './legacy.mdown')).toEqual({
      kind: 'file',
      relPath: 'docs/legacy.mdown',
      mode: 'edit'
    })
    expect(resolveDocumentLink('docs/guide.md', '../README.md?plain=1#intro')).toEqual({
      kind: 'file',
      relPath: 'README.md',
      mode: 'preview',
      anchor: 'intro'
    })
  })
})
