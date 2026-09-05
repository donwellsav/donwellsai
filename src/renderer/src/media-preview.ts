import type { AppSettings } from '@shared/types'

export const MIN_MEDIA_SCALE = 0.05
export const MAX_IMAGE_SCALE = 16
export const MAX_PDF_SCALE = 8
export const PDF_SEARCH_QUERY_LIMIT = 512
export const PDF_SEARCH_MATCH_LIMIT = 20_000

export type MediaSize = Readonly<{ width: number; height: number }>
export type ViewportSize = Readonly<{ width: number; height: number }>
export type ImageFitMode = AppSettings['imageViewerFit'] | 'custom'
export type PdfFitMode = AppSettings['pdfViewerFit'] | 'custom'
export type PdfSearchMatch = Readonly<{ page: number; index: number; length: number }>
export type TextSegmentMatch = Readonly<{
  segment: number
  start: number
  end: number
}>

export function clampMediaScale(scale: number, maximum: number): number {
  if (!Number.isFinite(scale)) return 1
  return Math.min(maximum, Math.max(MIN_MEDIA_SCALE, scale))
}

export function imageScaleForFit(
  mode: Exclude<ImageFitMode, 'custom'>,
  image: MediaSize,
  viewport: ViewportSize
): number {
  if (mode === 'actual') return 1
  if (image.width <= 0 || image.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return 1
  const widthScale = viewport.width / image.width
  if (mode === 'width') return clampMediaScale(widthScale, MAX_IMAGE_SCALE)
  return clampMediaScale(Math.min(1, widthScale, viewport.height / image.height), MAX_IMAGE_SCALE)
}

export function pdfScaleForFit(
  mode: Exclude<PdfFitMode, 'custom'>,
  page: MediaSize,
  viewport: ViewportSize
): number {
  if (mode === 'actual') return 1
  if (page.width <= 0 || page.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return 1
  const widthScale = viewport.width / page.width
  if (mode === 'width') return clampMediaScale(widthScale, MAX_PDF_SCALE)
  return clampMediaScale(Math.min(widthScale, viewport.height / page.height), MAX_PDF_SCALE)
}

export function formatMediaBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown size'
  if (bytes < 1024) return `${bytes} B`
  const kib = bytes / 1024
  if (kib < 1024) return `${kib < 10 ? kib.toFixed(1) : Math.round(kib)} KB`
  const mib = kib / 1024
  if (mib < 1024) return `${mib < 10 ? mib.toFixed(1) : Math.round(mib)} MB`
  return `${(mib / 1024).toFixed(1)} GB`
}

export function findTextMatches(
  text: string,
  query: string,
  page: number,
  maximum = PDF_SEARCH_MATCH_LIMIT
): PdfSearchMatch[] {
  const needle = query.trim().slice(0, PDF_SEARCH_QUERY_LIMIT)
  const limit = Number.isFinite(maximum)
    ? Math.max(0, Math.min(PDF_SEARCH_MATCH_LIMIT, Math.floor(maximum)))
    : PDF_SEARCH_MATCH_LIMIT
  if (!needle || limit === 0) return []
  const expression = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
  const matches: PdfSearchMatch[] = []
  for (const match of text.matchAll(expression)) {
    if (match.index === undefined || match[0].length === 0) continue
    matches.push({ page, index: match.index, length: match[0].length })
    if (matches.length === limit) break
  }
  return matches
}

/** Map one match in concatenated PDF.js text to exact per-span character ranges. */
export function textSegmentsForMatch(
  segments: readonly string[],
  match: Pick<PdfSearchMatch, 'index' | 'length'>
): TextSegmentMatch[] {
  if (match.index < 0 || match.length <= 0) return []
  const matchEnd = match.index + match.length
  const result: TextSegmentMatch[] = []
  let offset = 0
  for (let segment = 0; segment < segments.length && offset < matchEnd; segment += 1) {
    const value = segments[segment] ?? ''
    const segmentEnd = offset + value.length
    const start = Math.max(match.index, offset)
    const end = Math.min(matchEnd, segmentEnd)
    if (start < end) result.push({ segment, start: start - offset, end: end - offset })
    offset = segmentEnd
  }
  return result
}
