import DOMPurify from 'dompurify'
import { marked } from 'marked'
import markedFootnote from 'marked-footnote'
import { useEffect, useRef, useState } from 'react'
import { CALLOUT_KINDS, scanNeeds, slugify, splitFrontMatter, type TocEntry } from '../lib/markdown'
import { monaco } from '../monaco-setup'
import { isMarkdownFile, useAppStore } from '../store'

marked.setOptions({ gfm: true, breaks: false })
marked.use(markedFootnote())

// Dynamic import is deliberate feature-level code-splitting (ts rule exception):
// KaTeX (~300 kB + fonts) and mermaid (~1.5 MB) should never weigh down the
// editor bundle; they load the first time a document actually needs them and
// stay hot for the session.
let mathEnabled = false
async function enableMath(): Promise<void> {
  if (mathEnabled) return
  const katex = await import('marked-katex-extension')
  await import('katex/dist/katex.min.css')
  marked.use(katex.default({ throwOnError: false }))
  mathEnabled = true
}

let mermaidReady: Promise<(typeof import('mermaid'))['default']> | null = null
function getMermaid(): Promise<(typeof import('mermaid'))['default']> {
  mermaidReady ??= import('mermaid').then((m) => {
    m.default.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'dark',
      fontFamily: "'Geist Variable', ui-sans-serif, system-ui, sans-serif",
      themeVariables: {
        background: '#0a0a0a',
        primaryColor: '#161616',
        primaryTextColor: '#ececec',
        primaryBorderColor: '#373737',
        secondaryColor: '#101010',
        tertiaryColor: '#0b0b0b',
        lineColor: '#7b7b7b',
        clusterBkg: 'transparent',
        titleColor: '#fafafa'
      }
    })
    return m.default
  })
  return mermaidReady
}

// task-list checkboxes survive sanitization, but a file must never smuggle in a live control
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'INPUT') {
    node.setAttribute('type', 'checkbox')
    node.setAttribute('disabled', 'true')
  }
})

function sanitizeDoc(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true, mathMl: true },
    FORBID_TAGS: ['style', 'form'],
    FORBID_ATTR: ['style', 'onerror', 'onload']
  })
}

const CALLOUT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i

/**
 * Premium markdown preview: GitHub-flavored rendering plus mermaid diagrams,
 * KaTeX math, footnotes, callouts, front matter, heading anchors, a TOC rail,
 * and code fences with language label, copy button, and monaco colorization.
 */
export function MarkdownPreview({ worktreePath, relPath }: { worktreePath: string; relPath: string }) {
  const content = useAppStore((s) => s.previews[worktreePath]?.[relPath]?.content ?? '')
  const hostRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [toc, setToc] = useState<TocEntry[]>([])
  const [activeHeading, setActiveHeading] = useState<string | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let cancelled = false
    const listeners: (() => void)[] = []

    void (async () => {
      const { meta, body } = splitFrontMatter(content)
      const needs = scanNeeds(body)
      if (needs.math) await enableMath()
      const parsed = await marked.parse(body, { async: true })
      if (cancelled) return
      host.innerHTML = sanitizeDoc(parsed)

      // front matter → quiet meta card at the top
      if (meta) {
        const card = document.createElement('div')
        card.className = 'md-front'
        for (const [k, v] of Object.entries(meta)) {
          const row = document.createElement('div')
          row.className = 'md-front-row'
          const key = document.createElement('span')
          key.className = 'md-front-key'
          key.textContent = k
          const val = document.createElement('span')
          val.textContent = v
          row.append(key, val)
          card.append(row)
        }
        host.prepend(card)
      }

      // headings: ids + hover anchors; collect TOC
      const entries: TocEntry[] = []
      const used = new Set<string>()
      for (const h of Array.from(host.querySelectorAll<HTMLElement>('h1, h2, h3'))) {
        const text = h.textContent ?? ''
        let id = slugify(text) || 'section'
        for (let n = 2; used.has(id); n++) id = `${slugify(text)}-${n}`
        used.add(id)
        h.id = id
        const anchor = document.createElement('a')
        anchor.className = 'md-anchor'
        anchor.href = `#${id}`
        anchor.textContent = '#'
        anchor.setAttribute('aria-label', `Link to ${text}`)
        h.append(anchor)
        entries.push({ id, depth: Number(h.tagName[1]), text })
      }
      if (!cancelled) setToc(entries.filter((e) => e.depth <= 3))

      // GitHub-style callouts
      for (const bq of Array.from(host.querySelectorAll('blockquote'))) {
        const firstP = bq.querySelector('p')
        if (!firstP) continue
        const m = CALLOUT_RE.exec(firstP.textContent?.trimStart() ?? '')
        if (!m) continue
        const kind = m[1]!.toLowerCase()
        if (!CALLOUT_KINDS.has(kind)) continue
        bq.classList.add('md-callout', `md-callout-${kind}`)
        // strip the [!KIND] marker from the leading text node
        for (const node of Array.from(firstP.childNodes)) {
          if (node.nodeType === Node.TEXT_NODE && node.textContent?.trimStart().startsWith(`[!`)) {
            node.textContent = node.textContent.replace(CALLOUT_RE, '').trimStart()
            break
          }
          if (node.nodeType === Node.ELEMENT_NODE && (node as Element).textContent?.trimStart().startsWith('[!')) {
            ;(node as Element).textContent = (node as Element).textContent!.replace(CALLOUT_RE, '').trimStart()
            break
          }
        }
        const title = document.createElement('div')
        title.className = 'md-callout-title'
        title.textContent = kind[0]!.toUpperCase() + kind.slice(1)
        bq.prepend(title)
      }

      // images: relative paths resolve inside the worktree only
      for (const img of Array.from(host.querySelectorAll('img'))) {
        const src = img.getAttribute('src') ?? ''
        if (/^(https?:)?\/\//.test(src) || src.startsWith('data:')) continue
        const rel = src.replace(/^\.\//, '')
        if (rel.includes('..')) {
          img.remove()
          continue
        }
        const base = worktreePath.endsWith('/') ? worktreePath.slice(0, -1) : worktreePath
        const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : ''
        img.src = `file://${base}${dir ? `/${dir}` : ''}/${rel}`
      }

      // code fences: header row (language + copy), monaco colorization
      for (const pre of Array.from(host.querySelectorAll('pre'))) {
        const code = pre.querySelector('code')
        if (!code) continue
        const fence = /language-(\w+)/.exec(code.className)?.[1]?.toLowerCase() ?? ''
        const text = code.textContent ?? ''
        if (!text) continue

        const lang = fence
          ? monaco.languages
              .getLanguages()
              .find((l) => l.id === fence || l.aliases?.some((a) => a.toLowerCase() === fence))?.id
          : undefined

        if (fence !== 'mermaid') {
          const header = document.createElement('div')
          header.className = 'md-codehead'
          const label = document.createElement('span')
          label.textContent = lang ?? 'text'
          const copy = document.createElement('button')
          copy.className = 'md-copy'
          copy.textContent = 'copy'
          const press = (): void => {
            void navigator.clipboard.writeText(text)
            copy.textContent = 'copied'
            window.setTimeout(() => (copy.textContent = 'copy'), 1200)
          }
          copy.addEventListener('click', press)
          listeners.push(() => copy.removeEventListener('click', press))
          header.append(label, copy)
          pre.prepend(header)
        }

        if (lang && fence !== 'mermaid') {
          code.textContent = ''
          void monaco.editor
            .colorize(text, lang, {})
            .then((colored) => {
              if (!cancelled) code.innerHTML = sanitizeDoc(colored)
            })
            .catch(() => {
              code.textContent = text
            })
        }
      }

      // mermaid diagrams: fence → centered figure
      if (needs.mermaid) {
        const mermaid = await getMermaid()
        if (cancelled) return
        let n = 0
        for (const pre of Array.from(host.querySelectorAll('pre'))) {
          const code = pre.querySelector('code.language-mermaid')
          if (!code) continue
          const source = code.textContent ?? ''
          const figure = document.createElement('figure')
          figure.className = 'md-figure'
          pre.replaceWith(figure)
          n += 1
          try {
            const { svg } = await mermaid.render(`md-mermaid-${Date.now()}-${n}`, source)
            if (cancelled) return
            figure.innerHTML = DOMPurify.sanitize(svg, {
              USE_PROFILES: { svg: true, html: true },
              FORBID_TAGS: ['style'],
              FORBID_ATTR: ['onerror', 'onload']
            })
          } catch {
            figure.className = 'md-figure md-figure-error'
            const pre2 = document.createElement('pre')
            pre2.textContent = source
            const cap = document.createElement('figcaption')
            cap.textContent = 'mermaid render failed'
            figure.append(cap, pre2)
          }
        }
      }

      // link behavior: app-internal for .md, external for http(s), scroll for anchors
      const openPreview = useAppStore.getState().openPreview
      const onClick = (e: MouseEvent): void => {
        const a = (e.target as HTMLElement).closest('a')
        if (!a) return
        e.preventDefault()
        e.stopPropagation()
        const href = a.getAttribute('href') ?? ''
        if (href.startsWith('#')) {
          const target = host.querySelector(`[id="${CSS.escape(href.slice(1))}"]`)
          target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
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
      listeners.push(() => host.removeEventListener('click', onClick))
    })()

    return () => {
      cancelled = true
      for (const off of listeners) off()
    }
  }, [worktreePath, relPath, content])

  // scroll-spy for the TOC rail
  useEffect(() => {
    if (toc.length < 3) {
      setActiveHeading(null)
      return
    }
    const scroller = scrollRef.current
    if (!scroller) return
    const onScroll = (): void => {
      const heads = toc
        .map((t) => document.getElementById(t.id))
        .filter((el): el is HTMLElement => el !== null)
      let current: string | null = null
      for (const h of heads) {
        if (h.getBoundingClientRect().top - scroller.getBoundingClientRect().top <= 96) current = h.id
        else break
      }
      setActiveHeading(current)
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [toc])

  const showToc = toc.length >= 3

  return (
    <div className={`md-wrap${showToc ? ' md-wrap-toc' : ''}`}>
      <div className="md-scroll" ref={scrollRef}>
        <div ref={hostRef} className="md-preview" />
      </div>
      {showToc && (
        <nav className="md-toc" aria-label="Contents">
          <div className="md-toc-title">On this page</div>
          {toc.map((t) => (
            <a
              key={t.id}
              href={`#${t.id}`}
              className={`md-toc-item${activeHeading === t.id ? ' active' : ''}`}
              style={{ paddingLeft: `${(t.depth - 1) * 12 + 10}px` }}
              onClick={(e) => {
                e.preventDefault()
                document.getElementById(t.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }}
            >
              {t.text}
            </a>
          ))}
        </nav>
      )}
    </div>
  )
}
