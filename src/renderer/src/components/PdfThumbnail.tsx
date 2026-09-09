import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'

const THUMBNAIL_WIDTH = 104
const MAX_THUMBNAIL_PIXELS = 512 * 512

export type PdfThumbnailProps = Readonly<{
  document: PDFDocumentProxy
  pageNumber: number
  active: boolean
  onSelect(pageNumber: number): void
}>

export function PdfThumbnail({ document, pageNumber, active, onSelect }: PdfThumbnailProps) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const node = buttonRef.current
    if (!node) return
    const observer = new IntersectionObserver((entries) => {
      setVisible(entries.some((entry) => entry.isIntersecting))
    }, { root: node.parentElement, rootMargin: '320px 0px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (active) buttonRef.current?.scrollIntoView({ block: 'nearest' })
  }, [active])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    let page: PDFPageProxy | null = null
    let renderTask: RenderTask | null = null
    setFailed(false)

    void document.getPage(pageNumber).then(async (loadedPage) => {
      page = loadedPage
      if (cancelled) {
        loadedPage.cleanup()
        page = null
        return
      }
      try {
        const base = loadedPage.getViewport({ scale: 1 })
        const scale = THUMBNAIL_WIDTH / base.width
        const viewport = loadedPage.getViewport({ scale })
        const requestedOutputScale = Math.min(1.5, Math.max(1, window.devicePixelRatio || 1))
        const safeOutputScale = Math.sqrt(MAX_THUMBNAIL_PIXELS / Math.max(1, viewport.width * viewport.height))
        const outputScale = Math.max(0.5, Math.min(requestedOutputScale, safeOutputScale))
        const canvas = canvasRef.current
        if (!canvas) return
        const context = canvas.getContext('2d', { alpha: false })
        if (!context) throw new Error('Canvas rendering is unavailable')
        canvas.width = Math.max(1, Math.floor(viewport.width * outputScale))
        canvas.height = Math.max(1, Math.floor(viewport.height * outputScale))
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        renderTask = loadedPage.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0]
        })
        await renderTask.promise
      } finally {
        loadedPage.cleanup()
        if (page === loadedPage) page = null
      }
    }).catch((reason: unknown) => {
      if (cancelled || (reason instanceof Error && reason.name === 'RenderingCancelledException')) return
      setFailed(true)
    })

    return () => {
      cancelled = true
      renderTask?.cancel()
      page?.cleanup()
    }
  }, [document, pageNumber, visible])

  return (
    <button
      ref={buttonRef}
      type="button"
      className={`media-pdf-thumbnail${active ? ' is-active' : ''}`}
      aria-current={active ? 'page' : undefined}
      aria-label={`Go to page ${pageNumber}`} title={`Go to page ${pageNumber}`}
      onClick={() => onSelect(pageNumber)}
    >
      <span className="media-pdf-thumbnail-canvas">
        {visible && <canvas ref={canvasRef} />}
        {!visible && <span className="media-pdf-thumbnail-placeholder" />}
        {visible && failed && <span className="media-pdf-thumbnail-error">Unavailable</span>}
      </span>
      <span>{pageNumber}</span>
    </button>
  )
}
