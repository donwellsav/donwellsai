import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties
} from 'react'
import type { PDFDocumentProxy, PDFPageProxy, RenderTask, TextLayer as PdfJsTextLayer } from 'pdfjs-dist'
import {
  textSegmentsForMatch,
  type MediaSize,
  type PdfSearchMatch
} from '../media-preview'
import { loadPdfEngine } from '../pdf-engine'

const MAX_RENDERED_CANVAS_PIXELS = 32 * 1024 * 1024

type HighlightRect = Readonly<{
  key: string
  left: number
  top: number
  width: number
  height: number
  active: boolean
}>

type TextRenderData = Readonly<{
  divs: readonly HTMLElement[]
  segments: readonly string[]
}>

type PdfPageStyle = CSSProperties & { '--total-scale-factor': string }

export type PdfPageProps = Readonly<{
  document: PDFDocumentProxy
  pageNumber: number
  scale: number
  matches: readonly PdfSearchMatch[]
  activeMatch: PdfSearchMatch | null
  onBaseSize(size: MediaSize): void
}>

function textPoint(root: Node, offset: number): Readonly<{ node: Node; offset: number }> | null {
  const walker = root.ownerDocument?.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  if (!walker) return null
  let remaining = offset
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.nodeValue?.length ?? 0
    if (remaining <= length) return { node, offset: remaining }
    remaining -= length
  }
  return null
}

export function PdfPage({ document: pdfDocument, pageNumber, scale, matches, activeMatch, onBaseSize }: PdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const textDataRef = useRef<TextRenderData | null>(null)
  const [displaySize, setDisplaySize] = useState<MediaSize>({ width: 1, height: 1 })
  const [renderVersion, setRenderVersion] = useState(0)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [highlights, setHighlights] = useState<readonly HighlightRect[]>([])

  useEffect(() => {
    let cancelled = false
    let renderTask: RenderTask | null = null
    let textLayer: PdfJsTextLayer | null = null
    let pageProxy: PDFPageProxy | null = null
    textDataRef.current = null
    setStatus('loading')
    setError(null)

    void Promise.all([pdfDocument.getPage(pageNumber), loadPdfEngine()]).then(async ([page, engine]) => {
      pageProxy = page
      if (cancelled) {
        page.cleanup()
        return
      }
      const baseViewport = page.getViewport({ scale: 1 })
      onBaseSize({ width: baseViewport.width, height: baseViewport.height })
      const viewport = page.getViewport({ scale })
      setDisplaySize({ width: viewport.width, height: viewport.height })

      const canvas = canvasRef.current
      const textHost = textLayerRef.current
      if (!canvas || !textHost) throw new Error('PDF page surface is unavailable')
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) throw new Error('Canvas rendering is unavailable')

      const requestedOutputScale = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
      const cssPixels = Math.max(1, viewport.width * viewport.height)
      const safeOutputScale = Math.sqrt(MAX_RENDERED_CANVAS_PIXELS / cssPixels)
      const outputScale = Math.max(0.25, Math.min(requestedOutputScale, safeOutputScale))
      canvas.width = Math.max(1, Math.floor(viewport.width * outputScale))
      canvas.height = Math.max(1, Math.floor(viewport.height * outputScale))
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
      textHost.replaceChildren()

      renderTask = page.render({
        canvas,
        canvasContext: context,
        viewport,
        transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0]
      })
      textLayer = new engine.TextLayer({
        textContentSource: page.streamTextContent({ includeMarkedContent: true }),
        container: textHost,
        viewport
      })
      await Promise.all([renderTask.promise, textLayer.render()])
      if (cancelled) return
      textDataRef.current = {
        divs: textLayer.textDivs,
        segments: textLayer.textContentItemsStr
      }
      setRenderVersion((version) => version + 1)
      setStatus('ready')
    }).catch((reason: unknown) => {
      if (cancelled || (reason instanceof Error && reason.name === 'RenderingCancelledException')) return
      setError(reason instanceof Error ? reason.message : String(reason))
      setStatus('error')
    })

    return () => {
      cancelled = true
      renderTask?.cancel()
      textLayer?.cancel()
      pageProxy?.cleanup()
      textDataRef.current = null
    }
  }, [onBaseSize, pageNumber, pdfDocument, scale])

  useLayoutEffect(() => {
    const page = pageRef.current
    const data = textDataRef.current
    if (status !== 'ready' || !page || !data || matches.length === 0) {
      setHighlights([])
      return
    }

    let measuredWidth = -1
    let measuredHeight = -1
    const measureHighlights = (): void => {
      const pageBounds = page.getBoundingClientRect()
      if (pageBounds.width === measuredWidth && pageBounds.height === measuredHeight) return
      measuredWidth = pageBounds.width
      measuredHeight = pageBounds.height
      const next: HighlightRect[] = []
      if (pageBounds.width > 0 && pageBounds.height > 0) {
        for (let matchIndex = 0; matchIndex < matches.length; matchIndex += 1) {
          const match = matches[matchIndex]!
          const active = activeMatch !== null && activeMatch.page === match.page &&
            activeMatch.index === match.index && activeMatch.length === match.length
          const segments = textSegmentsForMatch(data.segments, match)
          for (let partIndex = 0; partIndex < segments.length; partIndex += 1) {
            const part = segments[partIndex]!
            const textDiv = data.divs[part.segment]
            if (!textDiv) continue
            const start = textPoint(textDiv, part.start)
            const end = textPoint(textDiv, part.end)
            if (!start || !end) continue
            const range = window.document.createRange()
            range.setStart(start.node, start.offset)
            range.setEnd(end.node, end.offset)
            const rects = range.getClientRects()
            for (let rectIndex = 0; rectIndex < rects.length; rectIndex += 1) {
              const rect = rects[rectIndex]!
              if (rect.width <= 0 || rect.height <= 0) continue
              next.push({
                key: `${match.index}:${partIndex}:${rectIndex}`,
                left: rect.left - pageBounds.left,
                top: rect.top - pageBounds.top,
                width: rect.width,
                height: rect.height,
                active
              })
            }
          }
        }
      }
      setHighlights(next)
    }
    measureHighlights()
    // Hidden panes have zero-sized ranges until their layout becomes visible.
    const observer = new ResizeObserver(measureHighlights)
    observer.observe(page)
    return () => observer.disconnect()
  }, [activeMatch, matches, renderVersion, status])

  const pageStyle: PdfPageStyle = {
    width: displaySize.width,
    height: displaySize.height,
    '--total-scale-factor': String(scale)
  }

  return (
    <div ref={pageRef} className="media-pdf-page" style={pageStyle} data-page-number={pageNumber}>
      <canvas ref={canvasRef} aria-label={`PDF page ${pageNumber}`} />
      <div ref={textLayerRef} className="media-pdf-text-layer textLayer" />
      <div className="media-pdf-highlight-layer" aria-hidden="true">
        {highlights.map((highlight) => (
          <span
            key={highlight.key}
            className={`media-pdf-search-highlight${highlight.active ? ' is-active' : ''}`}
            style={{
              left: highlight.left,
              top: highlight.top,
              width: highlight.width,
              height: highlight.height
            }}
          />
        ))}
      </div>
      {status === 'loading' && <div className="media-page-state" role="status"><span className="spinner" /> Rendering page…</div>}
      {status === 'error' && <div className="media-page-state media-state-error" role="alert">{error ?? 'Page could not be rendered.'}</div>}
    </div>
  )
}
