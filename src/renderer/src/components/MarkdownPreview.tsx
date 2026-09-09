import DOMPurify from 'dompurify'
import { Marked } from 'marked'
import markedFootnote from 'marked-footnote'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { findTextMatches, textSegmentsForMatch } from '../media-preview'
import { Icon } from './Icon'
import { CALLOUT_KINDS, scanNeeds, slugify, splitFrontMatter, type TocEntry } from '../lib/markdown'
import { monaco } from '../monaco-setup'
import { useAppStore } from '../store'
import { useMarkdownView } from '../use-markdown-view'

type KatexModule = typeof import('marked-katex-extension')

// Dynamic import is deliberate feature-level code-splitting (ts rule exception):
// KaTeX (~300 kB + fonts) and mermaid (~1.5 MB) should never weigh down the
// editor bundle; they load the first time a document actually needs them and
// stay hot for the session.
let katexReady: Promise<KatexModule> | null = null
function getKatex(): Promise<KatexModule> {
  katexReady ??= Promise.all([
    import('marked-katex-extension'),
    import('katex/dist/katex.min.css')
  ]).then(([module]) => module).catch((error: unknown) => {
    katexReady = null
    throw error
  })
  return katexReady
}

let mermaidReady: Promise<(typeof import('mermaid'))['default']> | null = null
function getMermaid(): Promise<(typeof import('mermaid'))['default']> {
  mermaidReady ??= import('mermaid').then((module) => {
    const tokens = getComputedStyle(document.documentElement)
    const chartColors = [1, 2, 3, 4, 5].map((index) => tokens.getPropertyValue(`--chart-${index}`).trim())
    const chartVariables: Record<string, string> = {}
    for (let index = 0; index < 12; index += 1) {
      const color = chartColors[index % chartColors.length]
      chartVariables[`pie${index + 1}`] = color
      chartVariables[`cScale${index}`] = color
    }
    module.default.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      fontFamily: "'Geist Variable', ui-sans-serif, system-ui, sans-serif",
      flowchart: { htmlLabels: false, useMaxWidth: true },
      themeVariables: {
        ...chartVariables,
        darkMode: true,
        pieOpacity: 1,
        pieStrokeColor: tokens.getPropertyValue('--background').trim(),
        pieTitleTextColor: tokens.getPropertyValue('--foreground').trim(),
        pieLegendTextColor: tokens.getPropertyValue('--foreground').trim(),
        xyChart: {
          plotColorPalette: chartColors.join(','),
          backgroundColor: tokens.getPropertyValue('--background').trim(),
          titleColor: tokens.getPropertyValue('--foreground').trim(),
          xAxisLabelColor: tokens.getPropertyValue('--foreground').trim(),
          yAxisLabelColor: tokens.getPropertyValue('--foreground').trim(),
          xAxisTitleColor: tokens.getPropertyValue('--foreground').trim(),
          yAxisTitleColor: tokens.getPropertyValue('--foreground').trim(),
          xAxisTickColor: tokens.getPropertyValue('--muted-fg').trim(),
          yAxisTickColor: tokens.getPropertyValue('--muted-fg').trim(),
          xAxisLineColor: tokens.getPropertyValue('--muted-fg').trim(),
          yAxisLineColor: tokens.getPropertyValue('--muted-fg').trim()
        },
        background: tokens.getPropertyValue('--background').trim(),
        primaryColor: tokens.getPropertyValue('--card').trim(),
        primaryTextColor: tokens.getPropertyValue('--foreground').trim(),
        actorTextColor: tokens.getPropertyValue('--foreground').trim(),
        primaryBorderColor: tokens.getPropertyValue('--input').trim(),
        secondaryColor: tokens.getPropertyValue('--secondary').trim(),
        tertiaryColor: tokens.getPropertyValue('--muted').trim(),
        lineColor: tokens.getPropertyValue('--muted-fg').trim(),
        textColor: tokens.getPropertyValue('--foreground').trim(),
        clusterBkg: tokens.getPropertyValue('--background').trim(),
        titleColor: tokens.getPropertyValue('--foreground').trim()
      }
    })
    return module.default
  }).catch((error: unknown) => {
    mermaidReady = null
    throw error
  })
  return mermaidReady
}
let markdownRenderSequence = 0
function nextMarkdownRenderToken(): string {
  markdownRenderSequence += 1
  return 'md-' + markdownRenderSequence.toString(36)
}
const KATEX_LAYOUT_PROPERTY: Record<string, true> = {
  height: true,
  width: true,
  'min-width': true,
  top: true,
  left: true,
  'margin-left': true,
  'margin-right': true,
  'padding-left': true,
  'vertical-align': true,
  'border-bottom-width': true,
  'border-width': true
}
const MERMAID_COLOR_PROPERTY: Record<string, true> = {
  fill: true,
  stroke: true,
  color: true,
  background: true,
  'background-color': true,
  'stop-color': true,
  'flood-color': true
}
const MERMAID_OPACITY_PROPERTY: Record<string, true> = {
  opacity: true,
  'fill-opacity': true,
  'stroke-opacity': true,
  'stop-opacity': true,
  'flood-opacity': true
}
const MERMAID_LENGTH_PROPERTY: Record<string, true> = {
  'stroke-width': true,
  'stroke-dashoffset': true,
  'stroke-miterlimit': true,
  'font-size': true,
  width: true,
  height: true,
  'max-width': true,
  rx: true,
  ry: true,
  'border-radius': true
}
const MERMAID_KEYWORD_PROPERTY: Record<string, RegExp> = {
  display: /^(?:none|block|inline|inline-block)$/,
  visibility: /^(?:visible|hidden|collapse)$/,
  overflow: /^(?:visible|hidden)$/,
  'pointer-events': /^(?:none|auto)$/,
  'font-style': /^(?:normal|italic|oblique)$/,
  'text-align': /^(?:left|right|center|start|end)$/,
  'text-anchor': /^(?:start|middle|end)$/,
  'dominant-baseline': /^(?:auto|middle|central|hanging|text-after-edge|text-before-edge)$/,
  'stroke-linecap': /^(?:butt|round|square)$/,
  'stroke-linejoin': /^(?:arcs|bevel|miter|miter-clip|round)$/,
  'vector-effect': /^(?:none|non-scaling-stroke)$/,
  'shape-rendering': /^(?:auto|optimizespeed|crispedges|geometricprecision)$/
}
const MERMAID_LOCAL_REFERENCE_PROPERTY: Record<string, true> = {
  filter: true,
  'clip-path': true,
  mask: true,
  'marker-start': true,
  'marker-mid': true,
  'marker-end': true
}
const SAFE_LENGTH = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:em|ex|px|pt|%)?$/
const SAFE_COLOR = /^(?:none|transparent|currentcolor|#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\)|[a-z]+)$/i
const SAFE_LOCAL_REFERENCE = /^url\((?:['"])?#[a-z0-9_.:-]+(?:['"])?\)$/i

function safeKatexStyle(style: string): string {
  const safe: string[] = []
  for (const declaration of style.split(';')) {
    const separator = declaration.indexOf(':')
    if (separator === -1) continue
    const property = declaration.slice(0, separator).trim().toLowerCase()
    const value = declaration.slice(separator + 1).trim().toLowerCase()
    const safeLength = SAFE_LENGTH.test(value) && Math.abs(Number.parseFloat(value)) <= 10_000
    if (KATEX_LAYOUT_PROPERTY[property] && safeLength) safe.push(`${property}:${value}`)
    else if (property === 'position' && value === 'relative') safe.push('position:relative')
    else if (property === 'border-style' && value === 'solid') safe.push('border-style:solid')
    else if (property === 'color' && SAFE_COLOR.test(value)) safe.push(`color:${value}`)
  }
  return safe.join(';')
}

function safeMermaidStyle(style: string): string {
  const safe: string[] = []
  for (const declaration of style.split(';')) {
    const separator = declaration.indexOf(':')
    if (separator === -1) continue
    const property = declaration.slice(0, separator).trim().toLowerCase()
    const rawValue = declaration.slice(separator + 1).replace(/\s*!important\s*$/i, '').trim()
    if (rawValue.length > 200) continue
    const value = rawValue.toLowerCase()
    const safeLength = SAFE_LENGTH.test(value) && Math.abs(Number.parseFloat(value)) <= 10_000
    const keyword = MERMAID_KEYWORD_PROPERTY[property]
    if (MERMAID_COLOR_PROPERTY[property] && SAFE_COLOR.test(value)) {
      safe.push(`${property}:${value}`)
    } else if (MERMAID_OPACITY_PROPERTY[property] && /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value)) {
      safe.push(`${property}:${value}`)
    } else if (MERMAID_LENGTH_PROPERTY[property] && safeLength) {
      safe.push(`${property}:${value}`)
    } else if (property === 'stroke-dasharray' && /^[\d\s.,-]+$/.test(value)) {
      safe.push(`${property}:${value}`)
    } else if (property === 'font-weight' && /^(?:normal|bold|[1-9]00)$/.test(value)) {
      safe.push(`${property}:${value}`)
    } else if (keyword?.test(value)) {
      safe.push(`${property}:${value}`)
    } else if (MERMAID_LOCAL_REFERENCE_PROPERTY[property] && (value === 'none' || SAFE_LOCAL_REFERENCE.test(rawValue))) {
      safe.push(`${property}:${rawValue}`)
    }
  }
  return safe.join(';')
}

// KaTeX needs numeric inline geometry. Preserve only its inert layout subset;
// arbitrary markdown style attributes remain forbidden.
function sanitizeDoc(html: string): string {
  const source = document.createElement('template')
  source.innerHTML = html
  const token = nextMarkdownRenderToken()
  const styles: string[] = []
  for (const element of Array.from(source.content.querySelectorAll('.katex[style], .katex [style]'))) {
    const style = safeKatexStyle(element.getAttribute('style') ?? '')
    if (!style) continue
    const index = styles.push(style) - 1
    element.setAttribute('data-katex-layout', `${token}:${index}`)
  }
  const sanitized = DOMPurify.sanitize(source.innerHTML, {
    USE_PROFILES: { html: true, svg: true, mathMl: true },
    FORBID_TAGS: ['style', 'form'],
    FORBID_ATTR: ['style', 'onerror', 'onload']
  })
  const clean = document.createElement('template')
  clean.innerHTML = sanitized
  for (const element of Array.from(clean.content.querySelectorAll('[data-katex-layout]'))) {
    const marker = element.getAttribute('data-katex-layout') ?? ''
    element.removeAttribute('data-katex-layout')
    const prefix = `${token}:`
    if (!marker.startsWith(prefix)) continue
    const style = styles[Number(marker.slice(prefix.length))]
    if (style) element.setAttribute('style', style)
  }
  return clean.innerHTML
}

function replaceMermaidHtmlLabels(fragment: DocumentFragment): void {
  for (const foreignObject of Array.from(fragment.querySelectorAll('foreignObject'))) {
    const label = (foreignObject.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (!label) {
      foreignObject.remove()
      continue
    }
    const x = Number.parseFloat(foreignObject.getAttribute('x') ?? '0')
    const y = Number.parseFloat(foreignObject.getAttribute('y') ?? '0')
    const width = Number.parseFloat(foreignObject.getAttribute('width') ?? '0')
    const height = Number.parseFloat(foreignObject.getAttribute('height') ?? '0')
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text')
    text.textContent = label
    text.setAttribute('x', String((Number.isFinite(x) ? x : 0) + (Number.isFinite(width) ? width / 2 : 0)))
    text.setAttribute('y', String((Number.isFinite(y) ? y : 0) + (Number.isFinite(height) ? height / 2 : 0)))
    text.setAttribute('text-anchor', 'middle')
    text.setAttribute('dominant-baseline', 'central')
    text.setAttribute('font-size', '16')
    foreignObject.replaceWith(text)
  }
}

function inlineSafeMermaidCss(fragment: DocumentFragment): void {
  const originalStyles = new Map<Element, string>()
  for (const element of Array.from(fragment.querySelectorAll('[style]'))) {
    if (element.tagName.toLowerCase() === 'style') continue
    originalStyles.set(element, element.getAttribute('style') ?? '')
    element.removeAttribute('style')
  }

  let rulesSeen = 0
  for (const styleElement of Array.from(fragment.querySelectorAll('style'))) {
    const sheet = new CSSStyleSheet()
    try {
      sheet.replaceSync(styleElement.textContent ?? '')
      for (const rule of Array.from(sheet.cssRules)) {
        if (!(rule instanceof CSSStyleRule) || ++rulesSeen > 512) continue
        const style = safeMermaidStyle(rule.style.cssText)
        if (!style) continue
        let matches: NodeListOf<Element>
        try {
          matches = fragment.querySelectorAll(rule.selectorText)
        } catch {
          continue
        }
        for (const element of Array.from(matches)) {
          const existing = element.getAttribute('style')
          element.setAttribute('style', existing ? `${existing};${style}` : style)
        }
      }
    } catch {
      // Invalid or unsupported CSS is discarded with the style element.
    }
    styleElement.remove()
  }

  // Mermaid directives emit inline styles; they outrank theme stylesheet rules.
  for (const [element, original] of originalStyles) {
    const style = safeMermaidStyle(original)
    if (!style) continue
    const existing = element.getAttribute('style')
    element.setAttribute('style', existing ? `${existing};${style}` : style)
  }
}

function hexLuminance(color: string): number | null {
  if (!/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(color)) return null
  const hex = color.length === 4
    ? color[1] + color[1] + color[2] + color[2] + color[3] + color[3]
    : color.slice(1)
  const rgb = Number.parseInt(hex, 16)
  let luminance = 0
  for (let index = 0; index < 3; index += 1) {
    const channel = ((rgb >>> (16 - index * 8)) & 255) / 255
    const linear = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    luminance += linear * (index === 0 ? 0.2126 : index === 1 ? 0.7152 : 0.0722)
  }
  return luminance
}

function contrastPieLabels(root: SVGSVGElement): void {
  const slices = root.querySelectorAll<SVGPathElement>('path.pieCircle')
  if (!slices.length) return
  const tokens = getComputedStyle(document.documentElement)
  const foreground = hexLuminance(tokens.getPropertyValue('--foreground').trim())
  const background = hexLuminance(tokens.getPropertyValue('--background').trim())
  if (foreground === null || background === null) return
  const labels = root.querySelectorAll<SVGTextElement>('text.slice')
  for (let index = 0; index < slices.length; index += 1) {
    const label = labels[index]
    const slice = slices[index]
    const luminance = hexLuminance(slice.style.fill || slice.getAttribute('fill') || '')
    if (!label || luminance === null) continue
    const foregroundContrast = (Math.max(foreground, luminance) + 0.05) / (Math.min(foreground, luminance) + 0.05)
    const backgroundContrast = (Math.max(background, luminance) + 0.05) / (Math.min(background, luminance) + 0.05)
    label.style.fill = foregroundContrast >= backgroundContrast ? 'var(--foreground)' : 'var(--background)'
  }
}

// Mermaid stylesheets are converted to safe, SVG-local presentation values,
// then removed before sanitization. Label contrast uses app tokens afterward.
function sanitizeMermaidSvg(svg: string): string {
  const source = document.createElement('template')
  source.innerHTML = svg
  replaceMermaidHtmlLabels(source.content)
  inlineSafeMermaidCss(source.content)
  const token = nextMarkdownRenderToken()
  const styles: string[] = []
  for (const element of Array.from(source.content.querySelectorAll('[style]'))) {
    const style = safeMermaidStyle(element.getAttribute('style') ?? '')
    if (!style) continue
    const index = styles.push(style) - 1
    element.setAttribute('data-mermaid-style', `${token}:${index}`)
  }
  const sanitized = DOMPurify.sanitize(source.innerHTML, {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    FORBID_TAGS: ['style'],
    FORBID_ATTR: ['style', 'onerror', 'onload']
  })
  const clean = document.createElement('template')
  clean.innerHTML = sanitized
  for (const element of Array.from(clean.content.querySelectorAll('[data-mermaid-style]'))) {
    const marker = element.getAttribute('data-mermaid-style') ?? ''
    element.removeAttribute('data-mermaid-style')
    const prefix = `${token}:`
    if (!marker.startsWith(prefix)) continue
    const style = styles[Number(marker.slice(prefix.length))]
    if (style) element.setAttribute('style', style)
  }
  const root = clean.content.querySelector('svg')
  if (!root) return ''
  root.setAttribute('role', 'img')
  if (!root.hasAttribute('aria-label') && !root.hasAttribute('aria-labelledby')) {
    root.setAttribute('aria-label', 'Mermaid diagram')
  }
  if (!root.style.maxWidth) root.style.maxWidth = '100%'
  root.style.fontFamily = 'var(--font-sans)'
  root.style.color = 'var(--foreground)'
  root.style.fill = 'var(--foreground)'
  root.style.background = 'transparent'
  contrastPieLabels(root)
  for (const shape of Array.from(root.querySelectorAll('.node rect, .node circle, .node ellipse, .node polygon'))) {
    if (!(shape instanceof SVGElement)) continue
    if (!shape.style.fill && !shape.getAttribute('fill')) shape.style.fill = 'var(--card)'
    if (!shape.style.stroke && !shape.getAttribute('stroke')) shape.style.stroke = 'var(--input)'
  }
  for (const edge of Array.from(root.querySelectorAll('.flowchart-link, .edgePath path, .messageLine0, .messageLine1'))) {
    if (edge instanceof SVGElement) edge.style.stroke = 'var(--muted-fg)'
  }
  for (const arrow of Array.from(root.querySelectorAll('marker path'))) {
    if (arrow instanceof SVGElement) {
      arrow.style.fill = 'var(--muted-fg)'
      arrow.style.stroke = 'var(--muted-fg)'
    }
  }
  return clean.innerHTML
}

// Task-list checkboxes survive sanitization, but a file must never smuggle in a live control.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'INPUT') {
    node.setAttribute('type', 'checkbox')
    node.setAttribute('disabled', 'true')
  }
})

const CALLOUT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i

/**
 * Premium markdown preview: GitHub-flavored rendering plus mermaid diagrams,
 * KaTeX math, footnotes, callouts, front matter, heading anchors, a TOC rail,
 * and code fences with language label, copy button, and monaco colorization.
 */
export function MarkdownPreview({ worktreePath, relPath }: { worktreePath: string; relPath: string }) {
  const content = useAppStore((s) => s.previews[worktreePath]?.[relPath]?.content ?? '')
  const hostRef = useRef<HTMLElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const { beginRender, finishRender, failRender, navigateToAnchor } = useMarkdownView(
    worktreePath,
    relPath,
    { hostRef, scrollRef }
  )
  const [toc, setToc] = useState<TocEntry[]>([])
  const [activeHeading, setActiveHeading] = useState<string | null>(null)
  const [renderState, setRenderState] = useState<Readonly<{ phase: 'rendering' | 'ready' | 'error'; error?: string }>>({ phase: 'rendering' })
  const [renderAttempt, setRenderAttempt] = useState(0)
  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [matchIndex, setMatchIndex] = useState(0)
  const findInput = useRef<HTMLInputElement>(null)
  const highlightId = 'md-find-' + useId().replace(/[^a-z0-9]/gi, '')
  const matches = useMemo(() => {
    const host = hostRef.current
    if (!host || renderState.phase !== 'ready' || !findOpen || !query.trim()) return []
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
    const nodes: Text[] = [], segments: string[] = []
    let block: Element | null = null
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement
      if (!parent || parent.closest('.md-anchor, .md-codehead, svg, [aria-hidden="true"]')) continue
      const nextBlock = parent.closest('p,li,th,td,h1,h2,h3,h4,h5,h6,pre,blockquote')
      if (nodes.length && block !== nextBlock) { nodes.push(document.createTextNode('\n')); segments.push('\n') }
      nodes.push(node as Text); segments.push(node.textContent ?? ''); block = nextBlock
    }
    // ponytail: cap highlighting at 1000 matches; use a worker/index if documents outgrow this synchronous scan.
    return findTextMatches(segments.join(''), query, 1, 1000).map(match => {
      const parts = textSegmentsForMatch(segments, match), first = parts[0]!, last = parts[parts.length - 1]!
      const range = document.createRange()
      range.setStart(nodes[first.segment]!, first.start); range.setEnd(nodes[last.segment]!, last.end)
      return range
    })
  }, [query, findOpen, renderState])
  useEffect(() => {
    CSS.highlights.set(highlightId, new Highlight(...matches))
    return () => { CSS.highlights.delete(highlightId) }
  }, [highlightId, matches])
  useEffect(() => {
    const match = matches[matchIndex % matches.length]
    CSS.highlights.set(highlightId + '-current', new Highlight(...(match ? [match] : [])))
    match?.startContainer.parentElement?.scrollIntoView({ block: 'center' })
    return () => { CSS.highlights.delete(highlightId + '-current') }
  }, [highlightId, matches, matchIndex])
  useEffect(() => {
    if (findOpen) { findInput.current?.focus(); findInput.current?.select() }
  }, [findOpen])
  useEffect(() => {
    const open = (event: Event) => {
      const target = (event as CustomEvent).detail
      if (target?.worktreePath === worktreePath && target?.file === relPath) {
        setFindOpen(true); findInput.current?.focus(); findInput.current?.select()
      }
    }
    window.addEventListener('donwells:document-find', open)
    return () => window.removeEventListener('donwells:document-find', open)
  }, [worktreePath, relPath])
  const closeFind = () => { setFindOpen(false); scrollRef.current?.focus() }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const checkpoint = beginRender()
    let cancelled = false
    const listeners: (() => void)[] = []
    const codeColorizations: Promise<void>[] = []
    setRenderState({ phase: 'rendering' })
    setToc([])
    host.replaceChildren()
    void (async () => {
      const { meta, body } = splitFrontMatter(content)
      const needs = scanNeeds(body)
      const parser = new Marked({ gfm: true, breaks: false })
      parser.use(markedFootnote())
      if (needs.math) parser.use((await getKatex()).default({ throwOnError: false }))
      const parsed = await parser.parse(body, { async: true })
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
        const baseId = slugify(text) || 'section'
        let id = baseId
        for (let n = 2; used.has(id); n++) id = `${baseId}-${n}`
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
          if (node instanceof Element) {
            const text = node.textContent
            if (!text?.trimStart().startsWith('[!')) continue
            node.textContent = text.replace(CALLOUT_RE, '').trimStart()
            break
          }
        }
        const title = document.createElement('div')
        title.className = 'md-callout-title'
        title.textContent = kind[0]!.toUpperCase() + kind.slice(1)
        bq.prepend(title)
      }

      // Relative images are resolved and encoded by the confined main-process API.
      // Decode completion is part of the render checkpoint so scroll restoration
      // sees final image geometry instead of a transient short document.
      const imageLoads: Promise<void>[] = []
      for (const img of Array.from(host.querySelectorAll('img'))) {
        const source = img.getAttribute('src') ?? ''
        const showUnavailable = (message: string): void => {
          if (cancelled) return
          const fallback = document.createElement('span')
          fallback.className = 'md-image-unavailable'
          fallback.setAttribute('role', 'img')
          fallback.setAttribute('aria-label', `${img.alt || 'Image'}: ${message}`)
          fallback.title = message
          fallback.textContent = `${img.alt ? `${img.alt}: ` : ''}${message}`
          img.replaceWith(fallback)
        }
        if (/^data:image\//i.test(source)) {
          imageLoads.push(img.decode().catch((error: unknown) => {
            showUnavailable(error instanceof Error ? error.message : String(error))
          }))
          continue
        }
        if (/^(?:https?:)?\/\//i.test(source)) {
          showUnavailable('Remote images are blocked for privacy')
          continue
        }
        if (!source || /^[a-z][a-z0-9+.-]*:/i.test(source)) {
          showUnavailable('Unsupported image source')
          continue
        }
        imageLoads.push(
          window.donwells.readPreviewImage(worktreePath, relPath, source)
            .then(async (dataUrl: string) => {
              if (cancelled) return
              if (!/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon|svg\+xml);base64,/i.test(dataUrl)) {
                showUnavailable('The image reader returned an unsupported format')
                return
              }
              img.src = dataUrl
              await img.decode()
            })
            .catch((error: unknown) => {
              showUnavailable(error instanceof Error ? error.message : String(error))
            })
        )
      }
      await Promise.all(imageLoads)
      if (cancelled) return

      // code fences: header row (language + copy), monaco colorization
      for (const pre of Array.from(host.querySelectorAll('pre'))) {
        const code = pre.querySelector('code')
        if (!code) continue
        const fence = /language-([^\s]+)/.exec(code.className)?.[1]?.toLowerCase() ?? ''
        const text = code.textContent ?? ''
        if (!text) continue

        const lang = fence
          ? monaco.languages
              .getLanguages()
              .find((language) => language.id === fence || language.aliases?.some((alias) => alias.toLowerCase() === fence))?.id
          : undefined

        if (fence !== 'mermaid') {
          const header = document.createElement('div')
          header.className = 'md-codehead'
          const label = document.createElement('span')
          label.textContent = fence || 'text'
          const copy = document.createElement('button')
          copy.type = 'button'
          copy.className = 'md-copy'
          copy.textContent = 'copy'
          let resetTimer: number | undefined
          const press = (): void => {
            void navigator.clipboard.writeText(text).then(() => {
              if (cancelled) return
              copy.classList.remove('failed')
              copy.removeAttribute('title')
              copy.textContent = 'copied'
              if (resetTimer !== undefined) window.clearTimeout(resetTimer)
              resetTimer = window.setTimeout(() => {
                if (!cancelled) copy.textContent = 'copy'
              }, 1200)
            }).catch((error: unknown) => {
              if (cancelled) return
              const message = `Could not copy code: ${String(error)}`
              copy.classList.add('failed')
              copy.textContent = 'copy failed'
              copy.title = message
              useAppStore.getState().setError(message)
            })
          }
          copy.addEventListener('click', press)
          listeners.push(() => {
            copy.removeEventListener('click', press)
            if (resetTimer !== undefined) window.clearTimeout(resetTimer)
          })
          header.append(label, copy)
          pre.prepend(header)
        }

        if (lang && fence !== 'mermaid') {
          code.textContent = ''
          codeColorizations.push(
            monaco.editor.colorize(text, lang, {}).then((colored) => {
              if (!cancelled) code.innerHTML = sanitizeDoc(colored)
            }).catch(() => {
              if (!cancelled) code.textContent = text
            })
          )
        }
      }
      await Promise.all(codeColorizations)
      if (cancelled) return

      // mermaid diagrams: fence → centered figure
      if (needs.mermaid) {
        const mermaid = await getMermaid()
        if (cancelled) return
        for (const pre of Array.from(host.querySelectorAll('pre'))) {
          if (cancelled) return
          const code = pre.querySelector('code.language-mermaid')
          if (!code) continue
          const source = code.textContent ?? ''
          const figure = document.createElement('figure')
          figure.className = 'md-figure'
          pre.replaceWith(figure)
          try {
            const { svg } = await mermaid.render(nextMarkdownRenderToken(), source)
            if (cancelled) return
            const sanitized = sanitizeMermaidSvg(svg)
            if (!sanitized) throw new Error('Mermaid returned no safe SVG')
            figure.innerHTML = sanitized
          } catch (error) {
            if (cancelled) return
            figure.className = 'md-figure md-figure-error'
            const pre2 = document.createElement('pre')
            pre2.textContent = source
            const cap = document.createElement('figcaption')
            cap.textContent = 'mermaid render failed'
            cap.title = error instanceof Error ? error.message : String(error)
            figure.append(cap, pre2)
          }
        }
      }
      if (cancelled) return
      finishRender(checkpoint)
      setRenderState({ phase: 'ready' })
    })().catch((error: unknown) => {
      if (cancelled) return
      failRender(checkpoint)
      setToc([])
      host.replaceChildren()
      setRenderState({
        phase: 'error',
        error: error instanceof Error ? error.message : String(error)
      })
    })

    return () => {
      cancelled = true
      for (const off of listeners) off()
    }
  }, [beginRender, content, failRender, finishRender, relPath, renderAttempt, worktreePath])

  // scroll-spy for the TOC rail
  useEffect(() => {
    if (toc.length < 3) {
      setActiveHeading(null)
      return
    }
    const scroller = scrollRef.current
    const host = hostRef.current
    if (!scroller || !host) return
    const heads = Array.from(host.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id]'))
    const onScroll = (): void => {
      const threshold = scroller.getBoundingClientRect().top + 96
      let current: string | null = null
      for (const heading of heads) {
        if (heading.getBoundingClientRect().top <= threshold) current = heading.id
        else break
      }
      setActiveHeading(current)
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [toc])

  const showToc = renderState.phase === 'ready' && toc.length >= 3
  const empty = renderState.phase === 'ready' && !content.trim()

  return (
    <div className={`md-wrap${showToc ? ' md-wrap-toc' : ''}`} aria-busy={renderState.phase === 'rendering'}>
      <style>{`::highlight(${highlightId}) { background: #e7c65b; color: #181818; } ::highlight(${highlightId}-current) { background: #f28c38; color: #181818; }`}</style>
      {findOpen && <div className="md-find" role="search" aria-label="Find in document" onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); closeFind() }
        if (event.key === 'Enter' && matches.length) { event.preventDefault(); setMatchIndex(index => (index + (event.shiftKey ? -1 : 1) + matches.length) % matches.length) }
      }}>
        <input ref={findInput} type="search" aria-label="Find in document" placeholder="Find in document" value={query} maxLength={256} onChange={event => { setQuery(event.target.value); setMatchIndex(0) }} />
        <span role="status">{query ? matches.length ? `${matchIndex % matches.length + 1} of ${matches.length}${matches.length === 1000 ? '+' : ''}` : 'No matches' : ''}</span>
        <button className="icon-btn" title="Previous match (Shift+Enter)" aria-label="Previous match" disabled={!matches.length} onClick={() => setMatchIndex(index => (index - 1 + matches.length) % matches.length)}><Icon name="up" /></button>
        <button className="icon-btn" title="Next match (Enter)" aria-label="Next match" disabled={!matches.length} onClick={() => setMatchIndex(index => (index + 1) % matches.length)}><Icon name="down" /></button>
        <button className="icon-btn" title="Close find (Escape)" aria-label="Close document find" onClick={closeFind}><Icon name="x" /></button>
      </div>}
      <div className="md-scroll" ref={scrollRef} tabIndex={0} role="region" aria-label="Markdown document">
        {renderState.phase === 'rendering' && (
          <div className="md-render-error" role="status"><strong>Rendering preview…</strong><span>Preparing document features and local assets.</span></div>
        )}
        {renderState.phase === 'error' && (
          <div className="md-render-error" role="alert">
            <strong>Could not render this document</strong>
            <span>{renderState.error}</span>
            <button type="button" className="btn btn-secondary" onClick={() => setRenderAttempt((attempt) => attempt + 1)}>Retry preview</button>
          </div>
        )}
        {empty && (
          <div className="md-render-error" role="status"><strong>Nothing to preview</strong><span>Add Markdown content in the editor to see it rendered here.</span></div>
        )}
      {showToc && (
        <details className="md-toc">
          <summary className="md-toc-title" title="Show or hide the document outline">Contents</summary>
          <nav aria-label="Contents">
          {toc.map((t) => (
            <a
              key={t.id}
              href={`#${t.id}`}
              className={`md-toc-item${activeHeading === t.id ? ' active' : ''}`}
              style={{ paddingLeft: `${(t.depth - 1) * 12 + 10}px` }}
              onClick={(event) => {
                event.preventDefault()
                navigateToAnchor(t.id)
              }}
            >
              {t.text}
            </a>
          ))}
          </nav>
        </details>
      )}
        <article ref={hostRef} aria-label={relPath} className="md-preview" hidden={renderState.phase !== 'ready' || empty} />
      </div>

    </div>
  )
}
