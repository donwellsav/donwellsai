import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  MAX_IMAGE_PREVIEW_AXIS,
  MAX_IMAGE_PREVIEW_PIXELS,
  type BinaryPreviewPayload
} from '@shared/media-preview'
import { useAppStore } from '../store'
import {
  MAX_IMAGE_SCALE,
  clampMediaScale,
  formatMediaBytes,
  imageScaleForFit,
  type ImageFitMode,
  type MediaSize,
  type ViewportSize
} from '../media-preview'
import { useBinaryPreview } from '../use-binary-preview'
import { Icon } from './Icon'

type ImageResource = Readonly<{ url: string; payload: BinaryPreviewPayload }>
type PanState = Readonly<{ pointerId: number; x: number; y: number; left: number; top: number }>

export type ImagePreviewProps = Readonly<{
  worktreePath: string
  relPath: string
}>

export function ImagePreview({ worktreePath, relPath }: ImagePreviewProps) {
  const defaultFit = useAppStore((state) => state.settings.imageViewerFit)
  const { state, retry } = useBinaryPreview(worktreePath, relPath, 'image')
  const viewportRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const panRef = useRef<PanState | null>(null)
  const scaleRef = useRef(1)
  const [resource, setResource] = useState<ImageResource | null>(null)
  const [dimensions, setDimensions] = useState<MediaSize | null>(null)
  const [viewport, setViewport] = useState<ViewportSize>({ width: 0, height: 0 })
  const [fitMode, setFitMode] = useState<ImageFitMode>(defaultFit)
  const [customScale, setCustomScale] = useState(1)
  const [decodeError, setDecodeError] = useState<string | null>(null)
  const [panning, setPanning] = useState(false)

  useEffect(() => {
    setFitMode(defaultFit)
  }, [defaultFit, relPath])

  useEffect(() => {
    if (state.status !== 'ready') {
      setResource(null)
      setDimensions(null)
      setDecodeError(null)
      return
    }
    const blob = new Blob([state.payload.bytes], { type: state.payload.mime })
    const url = URL.createObjectURL(blob)
    setResource({ url, payload: state.payload })
    setDimensions(null)
    setDecodeError(null)
    return () => URL.revokeObjectURL(url)
  }, [state])

  useEffect(() => {
    const node = viewportRef.current
    if (!node) return
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
  }, [decodeError, resource])

  const scale = useMemo(() => {
    if (!dimensions || fitMode === 'custom') return clampMediaScale(customScale, MAX_IMAGE_SCALE)
    return imageScaleForFit(fitMode, dimensions, viewport)
  }, [customScale, dimensions, fitMode, viewport])
  scaleRef.current = scale

  const zoomAt = useCallback((factor: number, clientX?: number, clientY?: number): void => {
    const scroll = viewportRef.current
    const image = imageRef.current
    if (!scroll || !image || !dimensions) return
    const before = image.getBoundingClientRect()
    const anchorX = clientX ?? scroll.getBoundingClientRect().left + scroll.clientWidth / 2
    const anchorY = clientY ?? scroll.getBoundingClientRect().top + scroll.clientHeight / 2
    const ratioX = before.width > 0 ? (anchorX - before.left) / before.width : 0.5
    const ratioY = before.height > 0 ? (anchorY - before.top) / before.height : 0.5
    const nextScale = clampMediaScale(scaleRef.current * factor, MAX_IMAGE_SCALE)
    setCustomScale(nextScale)
    setFitMode('custom')
    requestAnimationFrame(() => {
      const after = image.getBoundingClientRect()
      scroll.scrollLeft += after.left + ratioX * after.width - anchorX
      scroll.scrollTop += after.top + ratioY * after.height - anchorY
    })
  }, [dimensions])

  useEffect(() => {
    const node = viewportRef.current
    if (!node) return
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      zoomAt(Math.exp(-event.deltaY * 0.002), event.clientX, event.clientY)
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  const chooseFit = (mode: Exclude<ImageFitMode, 'custom'>): void => {
    setFitMode(mode)
  }

  const onImageLoad = (): void => {
    const image = imageRef.current
    if (!image) return
    const width = image.naturalWidth
    const height = image.naturalHeight
    if (width <= 0 || height <= 0) {
      setDecodeError('The image decoded without usable dimensions.')
      return
    }
    if (width > MAX_IMAGE_PREVIEW_AXIS || height > MAX_IMAGE_PREVIEW_AXIS || width * height > MAX_IMAGE_PREVIEW_PIXELS) {
      setDecodeError(
        `Decoded image is ${width.toLocaleString()} × ${height.toLocaleString()} px, above the safe pixel limit.`
      )
      return
    }
    setDimensions({ width, height })
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const scroll = viewportRef.current
    if (!scroll || event.target instanceof HTMLButtonElement) return
    if (event.key === '+' || event.key === '=') {
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
      chooseFit('contain')
    } else if (event.key === '2') {
      event.preventDefault()
      chooseFit('width')
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      scroll.scrollBy({ left: event.key === 'ArrowLeft' ? -80 : 80, behavior: 'smooth' })
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      scroll.scrollBy({ top: event.key === 'ArrowUp' ? -80 : 80, behavior: 'smooth' })
    }
  }

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    const scroll = viewportRef.current
    if (!scroll || event.button !== 0 || !dimensions) return
    event.currentTarget.focus()
    event.currentTarget.setPointerCapture(event.pointerId)
    panRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: scroll.scrollLeft,
      top: scroll.scrollTop
    }
    setPanning(true)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const start = panRef.current
    const scroll = viewportRef.current
    if (!start || !scroll || start.pointerId !== event.pointerId) return
    scroll.scrollLeft = start.left - (event.clientX - start.x)
    scroll.scrollTop = start.top - (event.clientY - start.y)
  }

  const endPan = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (panRef.current?.pointerId !== event.pointerId) return
    panRef.current = null
    setPanning(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const loadError = state.status === 'error' ? state.message : decodeError
  const fileName = relPath.slice(relPath.lastIndexOf('/') + 1)
  const scaledWidth = dimensions ? Math.max(1, Math.round(dimensions.width * scale)) : 1
  const scaledHeight = dimensions ? Math.max(1, Math.round(dimensions.height * scale)) : 1

  return (
    <section className="media-viewer" aria-label={`Image preview: ${fileName}`}>
      <div className="media-toolbar">
        <div className="media-toolbar-group" role="group" aria-label="Image zoom">
          <button className="icon-btn" title="Zoom out (−)" aria-label="Zoom out" onClick={() => zoomAt(1 / 1.2)}><Icon name="minus" /></button>
          <span className="media-zoom-readout" aria-live="polite">{Math.round(scale * 100)}%</span>
          <button className="icon-btn" title="Zoom in (+)" aria-label="Zoom in" onClick={() => zoomAt(1.2)}><Icon name="plus" /></button>
        </div>
        <div className="media-toolbar-group media-fit-controls" role="group" aria-label="Image fit">
          <button className="media-tool-button" aria-pressed={fitMode === 'contain'} onClick={() => chooseFit('contain')}>Contain</button>
          <button className="media-tool-button" aria-pressed={fitMode === 'width'} onClick={() => chooseFit('width')}>Fit width</button>
          <button className="media-tool-button" aria-pressed={fitMode === 'actual'} onClick={() => chooseFit('actual')}>Actual</button>
        </div>
        <div className="media-metadata" aria-live="polite">
          {dimensions && <span>{dimensions.width.toLocaleString()} × {dimensions.height.toLocaleString()} px</span>}
          {resource && <span>{formatMediaBytes(resource.payload.size)}</span>}
        </div>
      </div>

      {state.status === 'loading' ? (
        <div className="media-state" role="status"><span className="spinner" /><span>Loading image…</span></div>
      ) : loadError ? (
        <div className="media-state media-state-error" role="alert">
          <Icon name="alert" size={18} />
          <strong>Image preview unavailable</strong>
          <span>{loadError}</span>
          <button className="media-tool-button" onClick={retry}><Icon name="refresh" size={12} /> Retry</button>
        </div>
      ) : resource ? (
        <div
          ref={viewportRef}
          className={`media-image-viewport${panning ? ' is-panning' : ''}`}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPan}
          onPointerCancel={endPan}
          aria-label="Scrollable image canvas. Drag to pan; Control or Command plus wheel to zoom."
        >
          <div className="media-image-canvas" style={{ width: scaledWidth, height: scaledHeight }}>
            <img
              ref={imageRef}
              src={resource.url}
              width={scaledWidth}
              height={scaledHeight}
              draggable={false}
              alt={fileName}
              onLoad={onImageLoad}
              onError={() => setDecodeError('The image data could not be decoded by Chromium.')}
            />
          </div>
        </div>
      ) : null}
    </section>
  )
}
