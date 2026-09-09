import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist'
import type { TextContent } from 'pdfjs-dist/types/src/display/api'
import {
  MAX_PDF_PAGE_COUNT,
  MAX_PDF_SEARCH_PAGES,
  MAX_PDF_TEXT_CHARS_PER_PAGE,
  MAX_PDF_TEXT_CHARS_TOTAL
} from '@shared/media-preview'
import { useAppStore } from '../store'
import {
  MAX_PDF_SCALE,
  PDF_SEARCH_MATCH_LIMIT,
  PDF_SEARCH_QUERY_LIMIT,
  clampMediaScale,
  findTextMatches,
  formatMediaBytes,
  pdfScaleForFit,
  type MediaSize,
  type PdfFitMode,
  type PdfSearchMatch,
  type ViewportSize
} from '../media-preview'
import { createLocalPdfLoadingTask, textSegmentsFromContent } from '../pdf-engine'
import { useBinaryPreview } from '../use-binary-preview'
import { Icon } from './Icon'
import { PdfPage } from './PdfPage'
import { PdfThumbnail } from './PdfThumbnail'

type PdfSearchState =
  | Readonly<{ status: 'idle'; matches: readonly PdfSearchMatch[] }>
  | Readonly<{ status: 'searching'; matches: readonly PdfSearchMatch[]; scanned: number; total: number }>
  | Readonly<{ status: 'ready'; matches: readonly PdfSearchMatch[]; limited: boolean }>
  | Readonly<{ status: 'error'; matches: readonly PdfSearchMatch[]; message: string }>

type PendingZoomAnchor = Readonly<{
  clientX: number
  clientY: number
  ratioX: number
  ratioY: number
}>

export type PdfPreviewProps = Readonly<{
  worktreePath: string
  relPath: string
}>

const EMPTY_MATCHES: readonly PdfSearchMatch[] = Object.freeze([])

export function PdfPreview({ worktreePath, relPath }: PdfPreviewProps) {
  const defaultFit = useAppStore((state) => state.settings.pdfViewerFit)
  const { state, retry } = useBinaryPreview(worktreePath, relPath, 'pdf')
  const stageRef = useRef<HTMLDivElement>(null)
  const pageHostRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchGenerationRef = useRef(0)
  const pendingAnchorRef = useRef<PendingZoomAnchor | null>(null)
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null)
  const [documentError, setDocumentError] = useState<string | null>(null)
  const [pageNumber, setPageNumber] = useState(1)
  const [pageInput, setPageInput] = useState('1')
  const [baseSize, setBaseSize] = useState<MediaSize | null>(null)
  const [viewport, setViewport] = useState<ViewportSize>({ width: 0, height: 0 })
  const [fitMode, setFitMode] = useState<PdfFitMode>(defaultFit)
  const [customScale, setCustomScale] = useState(1)
  const [thumbnailsOpen, setThumbnailsOpen] = useState(true)
  const [query, setQuery] = useState('')
  const [searchState, setSearchState] = useState<PdfSearchState>({ status: 'idle', matches: EMPTY_MATCHES })
  const [activeMatchIndex, setActiveMatchIndex] = useState(-1)

  useEffect(() => {
    setFitMode(defaultFit)
  }, [defaultFit, relPath])

  useEffect(() => {
    if (state.status !== 'ready') {
      setPdfDocument(null)
      setDocumentError(null)
      return
    }
    let cancelled = false
    let loadingTask: PDFDocumentLoadingTask | null = null
    setPdfDocument(null)
    setDocumentError(null)
    setPageNumber(1)
    setPageInput('1')
    setBaseSize(null)
    setQuery('')
    setSearchState({ status: 'idle', matches: EMPTY_MATCHES })
    setActiveMatchIndex(-1)

    void createLocalPdfLoadingTask(state.payload.bytes).then(async (task) => {
      loadingTask = task
      if (cancelled) {
        await task.destroy()
        return null
      }
      const loaded = await task.promise
      if (cancelled) {
        await task.destroy()
        return null
      }
      if (loaded.numPages < 1 || loaded.numPages > MAX_PDF_PAGE_COUNT) {
        await task.destroy()
        throw new Error(`PDF has ${loaded.numPages.toLocaleString()} pages; the safe viewer limit is ${MAX_PDF_PAGE_COUNT.toLocaleString()}.`)
      }
      return loaded
    }).then((loaded) => {
      if (!cancelled && loaded) setPdfDocument(loaded)
    }).catch((reason: unknown) => {
      if (!cancelled) setDocumentError(reason instanceof Error ? reason.message : String(reason))
    })

    return () => {
      cancelled = true
      if (loadingTask) void loadingTask.destroy().catch(() => undefined)
    }
  }, [state])

  useEffect(() => {
    const node = stageRef.current
    if (!node || !pdfDocument) return
    const update = (): void => {
      const style = getComputedStyle(node)
      const horizontalPadding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight)
      const verticalPadding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom)
      setViewport({
        width: Math.max(0, node.clientWidth - horizontalPadding),
        height: Math.max(0, node.clientHeight - verticalPadding)
      })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [pdfDocument, thumbnailsOpen])

  const onBaseSize = useCallback((size: MediaSize): void => {
    setBaseSize((current) => current?.width === size.width && current.height === size.height ? current : size)
  }, [])

  const scale = useMemo(() => {
    if (!baseSize || fitMode === 'custom') return clampMediaScale(customScale, MAX_PDF_SCALE)
    return pdfScaleForFit(fitMode, baseSize, viewport)
  }, [baseSize, customScale, fitMode, viewport])

  useEffect(() => {
    const pending = pendingAnchorRef.current
    const stage = stageRef.current
    const page = pageHostRef.current?.querySelector<HTMLElement>('.media-pdf-page')
    if (!pending || !stage || !page) return
    pendingAnchorRef.current = null
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const bounds = page.getBoundingClientRect()
        stage.scrollLeft += bounds.left + pending.ratioX * bounds.width - pending.clientX
        stage.scrollTop += bounds.top + pending.ratioY * bounds.height - pending.clientY
      })
    })
  }, [scale])

  const zoomAt = useCallback((factor: number, clientX?: number, clientY?: number): void => {
    const stage = stageRef.current
    const page = pageHostRef.current?.querySelector<HTMLElement>('.media-pdf-page')
    if (!stage || !page) return
    const pageBounds = page.getBoundingClientRect()
    const stageBounds = stage.getBoundingClientRect()
    const anchorX = clientX ?? stageBounds.left + stage.clientWidth / 2
    const anchorY = clientY ?? stageBounds.top + stage.clientHeight / 2
    pendingAnchorRef.current = {
      clientX: anchorX,
      clientY: anchorY,
      ratioX: pageBounds.width > 0 ? (anchorX - pageBounds.left) / pageBounds.width : 0.5,
      ratioY: pageBounds.height > 0 ? (anchorY - pageBounds.top) / pageBounds.height : 0.5
    }
    setCustomScale(clampMediaScale(scale * factor, MAX_PDF_SCALE))
    setFitMode('custom')
  }, [scale])

  useEffect(() => {
    const node = stageRef.current
    if (!node || !pdfDocument) return
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      zoomAt(Math.exp(-event.deltaY * 0.002), event.clientX, event.clientY)
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [pdfDocument, zoomAt])

  const pageCount = pdfDocument?.numPages ?? 0
  const pageNumbers = useMemo(
    () => Array.from({ length: pageCount }, (_, index) => index + 1),
    [pageCount]
  )

  const goToPage = useCallback((requestedPage: number): void => {
    if (!pdfDocument) return
    const nextPage = Math.min(pdfDocument.numPages, Math.max(1, Math.round(requestedPage)))
    setPageNumber(nextPage)
    setPageInput(String(nextPage))
    setBaseSize(null)
    requestAnimationFrame(() => stageRef.current?.scrollTo({ top: 0, left: 0 }))
  }, [pdfDocument])

  useEffect(() => {
    if (!pdfDocument) return
    const needle = query.trim().slice(0, PDF_SEARCH_QUERY_LIMIT)
    searchGenerationRef.current += 1
    const generation = searchGenerationRef.current
    let cancelled = false
    let activeReader: ReadableStreamDefaultReader<TextContent> | null = null

    if (!needle) {
      setSearchState({ status: 'idle', matches: EMPTY_MATCHES })
      setActiveMatchIndex(-1)
      return
    }
    if (pdfDocument.numPages > MAX_PDF_SEARCH_PAGES) {
      setSearchState({
        status: 'error',
        matches: EMPTY_MATCHES,
        message: `Search supports documents up to ${MAX_PDF_SEARCH_PAGES.toLocaleString()} pages; this PDF has ${pdfDocument.numPages.toLocaleString()}.`
      })
      setActiveMatchIndex(-1)
      return
    }

    setSearchState({ status: 'searching', matches: EMPTY_MATCHES, scanned: 0, total: pdfDocument.numPages })
    setActiveMatchIndex(-1)

    void (async () => {
      const matches: PdfSearchMatch[] = []
      let totalCharacters = 0
      let limited = false
      for (let page = 1; page <= pdfDocument.numPages; page += 1) {
        if (cancelled || searchGenerationRef.current !== generation) return
        const pageProxy = await pdfDocument.getPage(page)
        if (cancelled || searchGenerationRef.current !== generation) {
          pageProxy.cleanup()
          return
        }
        const reader = pageProxy.streamTextContent().getReader()
        activeReader = reader
        const segments: string[] = []
        let pageCharacters = 0
        try {
          while (true) {
            const chunk = await reader.read()
            if (cancelled || searchGenerationRef.current !== generation) {
              await reader.cancel()
              return
            }
            if (chunk.done) break
            const chunkSegments = textSegmentsFromContent(chunk.value)
            for (const segment of chunkSegments) {
              pageCharacters += segment.length
              totalCharacters += segment.length
              if (pageCharacters > MAX_PDF_TEXT_CHARS_PER_PAGE) {
                throw new Error(`Page ${page.toLocaleString()} exceeds the searchable text limit.`)
              }
              if (totalCharacters > MAX_PDF_TEXT_CHARS_TOTAL) {
                throw new Error('Document exceeds the searchable text limit.')
              }
              segments.push(segment)
            }
          }
        } finally {
          activeReader = null
          pageProxy.cleanup()
        }
        const remaining = PDF_SEARCH_MATCH_LIMIT - matches.length
        matches.push(...findTextMatches(segments.join(''), needle, page, remaining))
        if (matches.length === PDF_SEARCH_MATCH_LIMIT) {
          limited = true
          break
        }
        if (page === pdfDocument.numPages || page % 8 === 0) {
          setSearchState({ status: 'searching', matches: EMPTY_MATCHES, scanned: page, total: pdfDocument.numPages })
        }
      }
      if (cancelled || searchGenerationRef.current !== generation) return
      setSearchState({ status: 'ready', matches, limited })
      setActiveMatchIndex(matches.length > 0 ? 0 : -1)
      if (matches[0]) goToPage(matches[0].page)
    })().catch((reason: unknown) => {
      if (cancelled || searchGenerationRef.current !== generation) return
      setSearchState({
        status: 'error',
        matches: EMPTY_MATCHES,
        message: reason instanceof Error ? reason.message : String(reason)
      })
      setActiveMatchIndex(-1)
    })

    return () => {
      cancelled = true
      searchGenerationRef.current += 1
      if (activeReader) void activeReader.cancel().catch(() => undefined)
    }
  }, [goToPage, pdfDocument, query])

  const matches = searchState.matches
  const activeMatch = activeMatchIndex >= 0 ? matches[activeMatchIndex] ?? null : null
  const pageMatches = useMemo(
    () => matches.filter((match) => match.page === pageNumber),
    [matches, pageNumber]
  )

  const moveMatch = (delta: number): void => {
    if (matches.length === 0) return
    const next = activeMatchIndex < 0
      ? (delta > 0 ? 0 : matches.length - 1)
      : (activeMatchIndex + delta + matches.length) % matches.length
    setActiveMatchIndex(next)
    goToPage(matches[next]!.page)
  }

  const chooseFit = (mode: Exclude<PdfFitMode, 'custom'>): void => {
    setFitMode(mode)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
      return
    }
    if (event.target instanceof HTMLInputElement) return
    if (event.key === 'PageUp' || event.key === 'ArrowLeft') {
      event.preventDefault()
      goToPage(pageNumber - 1)
    } else if (event.key === 'PageDown' || event.key === 'ArrowRight') {
      event.preventDefault()
      goToPage(pageNumber + 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      goToPage(1)
    } else if (event.key === 'End') {
      event.preventDefault()
      goToPage(pageCount)
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault()
      zoomAt(1.2)
    } else if (event.key === '-') {
      event.preventDefault()
      zoomAt(1 / 1.2)
    } else if (event.key === '0') {
      event.preventDefault()
      chooseFit('actual')
    } else if (event.key === '1') {
      event.preventDefault()
      chooseFit('page')
    } else if (event.key === '2') {
      event.preventDefault()
      chooseFit('width')
    }
  }

  const binaryError = state.status === 'error' ? state.message : null
  const error = binaryError ?? documentError
  const fileName = relPath.slice(relPath.lastIndexOf('/') + 1)

  if (state.status === 'loading' || (state.status === 'ready' && !pdfDocument && !error)) {
    return <div className="media-state" role="status"><span className="spinner" /><span>Opening PDF…</span></div>
  }
  if (error || !pdfDocument || state.status !== 'ready') {
    return (
      <div className="media-state media-state-error" role="alert">
        <Icon name="alert" size={18} />
        <strong>PDF preview unavailable</strong>
        <span>{error ?? 'The document could not be opened.'}</span>
        <button className="media-tool-button" onClick={retry}><Icon name="refresh" size={12} /> Retry</button>
      </div>
    )
  }

  return (
    <section className="media-viewer media-pdf-viewer" aria-label={`PDF preview: ${fileName}`} onKeyDown={onKeyDown}>
      <div className="media-toolbar media-pdf-toolbar">
        <div className="media-toolbar-group" role="group" aria-label="Page navigation">
          <button className="icon-btn" aria-label="Previous page" title="Previous page" disabled={pageNumber <= 1} onClick={() => goToPage(pageNumber - 1)}><Icon name="up" size={12} /></button>
          <label className="media-page-field">
            <span className="sr-only">Page number</span>
            <input
              value={pageInput}
              inputMode="numeric"
              aria-label="Page number"
              onChange={(event) => setPageInput(event.target.value.replace(/[^0-9]/g, ''))}
              onBlur={() => goToPage(Number(pageInput) || pageNumber)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  goToPage(Number(pageInput) || pageNumber)
                  event.currentTarget.select()
                }
              }}
            />
          </label>
          <span className="media-page-count">/ {pageCount.toLocaleString()}</span>
          <button className="icon-btn" aria-label="Next page" title="Next page" disabled={pageNumber >= pageCount} onClick={() => goToPage(pageNumber + 1)}><Icon name="down" size={12} /></button>
        </div>

        <div className="media-toolbar-group" role="group" aria-label="PDF zoom">
          <button className="icon-btn" aria-label="Zoom out" title="Zoom out" onClick={() => zoomAt(1 / 1.2)}><Icon name="minus" /></button>
          <span className="media-zoom-readout" aria-live="polite">{Math.round(scale * 100)}%</span>
          <button className="icon-btn" aria-label="Zoom in" title="Zoom in" onClick={() => zoomAt(1.2)}><Icon name="plus" /></button>
        </div>

        <div className="media-toolbar-group media-fit-controls" role="group" aria-label="PDF fit">
          <button className="media-tool-button" aria-pressed={fitMode === 'page'} onClick={() => chooseFit('page')}>Fit page</button>
          <button className="media-tool-button" aria-pressed={fitMode === 'width'} onClick={() => chooseFit('width')}>Fit width</button>
          <button className="media-tool-button" aria-pressed={fitMode === 'actual'} onClick={() => chooseFit('actual')}>Actual</button>
        </div>

        <div className="media-search" role="search">
          <Icon name="search" size={12} />
          <input
            ref={searchInputRef}
            value={query}
            maxLength={PDF_SEARCH_QUERY_LIMIT}
            placeholder="Find in document"
            aria-label="Find in document"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                moveMatch(event.shiftKey ? -1 : 1)
              } else if (event.key === 'Escape') {
                setQuery('')
              }
            }}
          />
          <span className="media-search-count" aria-live="polite">
            {searchState.status === 'searching'
              ? `${searchState.scanned}/${searchState.total}`
              : searchState.status === 'ready'
                ? `${activeMatchIndex >= 0 ? activeMatchIndex + 1 : 0}/${matches.length.toLocaleString()}${searchState.limited ? ' limit' : ''}`
                : '0/0'}
          </span>
          <button className="icon-btn" aria-label="Previous match" title="Previous match" disabled={matches.length === 0} onClick={() => moveMatch(-1)}><Icon name="up" size={11} /></button>
          <button className="icon-btn" aria-label="Next match" title="Next match" disabled={matches.length === 0} onClick={() => moveMatch(1)}><Icon name="down" size={11} /></button>
        </div>

        <div className="media-metadata">
          <span>{formatMediaBytes(state.payload.size)}</span>
          <button className="icon-btn" aria-pressed={thumbnailsOpen} aria-label="Toggle thumbnails" title="Toggle thumbnails" onClick={() => setThumbnailsOpen((open) => !open)}><Icon name="panelLeft" size={12} /></button>
        </div>
      </div>

      {searchState.status === 'error' && <div className="media-inline-error" role="alert">{searchState.message}</div>}
      {searchState.status === 'ready' && searchState.limited && (
        <div className="media-inline-notice" role="status">Showing the first {PDF_SEARCH_MATCH_LIMIT.toLocaleString()} matches.</div>
      )}

      <div className={`media-pdf-body${thumbnailsOpen ? '' : ' thumbnails-hidden'}`}>
        {thumbnailsOpen && (
          <nav className="media-pdf-thumbnails" aria-label="PDF pages">
            {pageNumbers.map((number) => (
              <PdfThumbnail
                key={number}
                document={pdfDocument}
                pageNumber={number}
                active={number === pageNumber}
                onSelect={goToPage}
              />
            ))}
          </nav>
        )}
        <main ref={stageRef} className="media-pdf-stage" tabIndex={0} aria-label={`Page ${pageNumber} of ${pageCount}`}>
          <div ref={pageHostRef} className="media-pdf-page-host">
            <PdfPage
              document={pdfDocument}
              pageNumber={pageNumber}
              scale={scale}
              matches={pageMatches}
              activeMatch={activeMatch?.page === pageNumber ? activeMatch : null}
              onBaseSize={onBaseSize}
            />
          </div>
        </main>
      </div>
    </section>
  )
}
