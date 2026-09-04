import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { useEffect, useRef } from 'react'
import { monaco } from '../monaco-setup'
import { isMarkdownFile, useAppStore } from '../store'

marked.setOptions({ gfm: true, breaks: false })

// task-list checkboxes survive sanitization, but a file must never smuggle in a live control
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'INPUT') {
    node.setAttribute('type', 'checkbox')
    node.setAttribute('disabled', 'true')
  }
})

/**
 * Rendered markdown for an open editor buffer (`.md/.markdown/.mdx`): marked
 * → DOMPurify (renderer DOM trust: every node is user-controlled file text) →
 * post-pass for links/images/code.
 * - relative links navigate the app (openPreview), http(s) open external
 * - relative images resolve against the worktree, confined to it
 * - fenced code with a known language gets monaco colorization
 */
export function MarkdownPreview({ worktreePath, relPath }: { worktreePath: string; relPath: string }) {
  const content = useAppStore((s) => s.previews[worktreePath]?.[relPath]?.content ?? '')
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const parsed = marked.parse(content, { async: false })
    host.innerHTML = DOMPurify.sanitize(parsed, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'form'],
      FORBID_ATTR: ['style', 'onerror', 'onload']
    })

    for (const img of Array.from(host.querySelectorAll('img'))) {
      const src = img.getAttribute('src') ?? ''
      if (/^(https?:)?\/\//.test(src) || src.startsWith('data:')) continue
      const rel = src.replace(/^\.\//, '')
      // confine: previews only render files inside the worktree
      if (rel.includes('..')) { img.remove(); continue }
      const base = worktreePath.endsWith('/') ? worktreePath.slice(0, -1) : worktreePath
      const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : ''
      img.src = `file://${base}${dir ? `/${dir}` : ''}/${rel}`
    }

    const openPreview = useAppStore.getState().openPreview
    const onClick = (e: MouseEvent): void => {
      const a = (e.target as HTMLElement).closest('a')
      if (!a) return
      e.preventDefault()
      const href = a.getAttribute('href') ?? ''
      if (href.startsWith('#')) {
        host.querySelector(`[id="${CSS.escape(href.slice(1))}"]`)?.scrollIntoView({ behavior: 'smooth' })
        return
      }
      if (/^https?:/.test(href)) {
        void window.orca.openExternal(href)
        return
      }
      if (isMarkdownFile(href)) {
        const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : ''
        void openPreview(worktreePath, dir ? `${dir}/${href}` : href)
      }
    }
    host.addEventListener('click', onClick)

    for (const code of Array.from(host.querySelectorAll<HTMLElement>('pre code'))) {
      const m = /language-(\w+)/.exec(code.className)
      const fence = m?.[1]?.toLowerCase() ?? ''
      const text = code.textContent ?? ''
      // fences use aliases more often than ids: ```ts, ```sh, ```py
      const lang = monaco.languages
        .getLanguages()
        .find((l) => l.id === fence || l.aliases?.some((a) => a.toLowerCase() === fence))?.id
      if (!lang || !text) continue
      code.textContent = ''
      void monaco.editor
        .colorize(text, lang, {})
        .then((html) => {
          code.innerHTML = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
        })
        .catch(() => {
          code.textContent = text
        })
    }
    return () => host.removeEventListener('click', onClick)
  }, [worktreePath, relPath, content])

  return (
    <div className="md-scroll">
      <div ref={hostRef} className="md-preview" />
    </div>
  )
}
