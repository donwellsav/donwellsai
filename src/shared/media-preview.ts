export const IMAGE_PREVIEW_BYTE_LIMIT = 64 * 1024 * 1024
export const PDF_PREVIEW_BYTE_LIMIT = 128 * 1024 * 1024
export const MAX_IMAGE_PREVIEW_PIXELS = 64 * 1024 * 1024
export const MAX_IMAGE_PREVIEW_AXIS = 32_768
export const MAX_PDF_PAGE_COUNT = 5_000
export const MAX_PDF_SEARCH_PAGES = 2_000
export const MAX_PDF_TEXT_CHARS_PER_PAGE = 2 * 1024 * 1024
export const MAX_PDF_TEXT_CHARS_TOTAL = 16 * 1024 * 1024

export type MediaPreviewKind = 'image' | 'pdf'
export type ImagePreviewMime =
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp'
  | 'image/avif'
  | 'image/bmp'
  | 'image/x-icon'
export type MediaPreviewMime = ImagePreviewMime | 'application/pdf'

export type MediaPreviewDescriptor = Readonly<{
  kind: MediaPreviewKind
  mime: MediaPreviewMime
}>

export type BinaryPreviewRequest = Readonly<{
  path: string
  kind: MediaPreviewKind
  generation: number
}>

export type BinaryPreviewPayload = Readonly<{
  path: string
  kind: MediaPreviewKind
  mime: MediaPreviewMime
  size: number
  generation: number
  bytes: Uint8Array<ArrayBuffer>
}>

export interface MediaPreviewApi {
  readBinaryPreview(worktreePath: string, request: BinaryPreviewRequest): Promise<BinaryPreviewPayload>
  cancelBinaryPreview(generation: number): Promise<void>
}

const MEDIA_BY_EXTENSION: Readonly<Record<string, MediaPreviewDescriptor>> = Object.freeze({
  '.png': Object.freeze({ kind: 'image', mime: 'image/png' }),
  '.jpg': Object.freeze({ kind: 'image', mime: 'image/jpeg' }),
  '.jpeg': Object.freeze({ kind: 'image', mime: 'image/jpeg' }),
  '.gif': Object.freeze({ kind: 'image', mime: 'image/gif' }),
  '.webp': Object.freeze({ kind: 'image', mime: 'image/webp' }),
  '.avif': Object.freeze({ kind: 'image', mime: 'image/avif' }),
  '.bmp': Object.freeze({ kind: 'image', mime: 'image/bmp' }),
  '.ico': Object.freeze({ kind: 'image', mime: 'image/x-icon' }),
  '.pdf': Object.freeze({ kind: 'pdf', mime: 'application/pdf' })
})

/**
 * SVG is intentionally absent: previewing attacker-controlled active markup in
 * an image surface would bypass the app's document sanitization boundary.
 */
export function mediaPreviewDescriptorForPath(path: string): MediaPreviewDescriptor | null {
  if (typeof path !== 'string') return null
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return null
  return MEDIA_BY_EXTENSION[name.slice(dot).toLowerCase()] ?? null
}

export function byteLimitForMediaKind(kind: MediaPreviewKind): number {
  return kind === 'image' ? IMAGE_PREVIEW_BYTE_LIMIT : PDF_PREVIEW_BYTE_LIMIT
}

export function validateBinaryPreviewGeneration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Invalid binary preview generation')
  }
  return value
}

export function validateBinaryPreviewRequest(value: unknown): BinaryPreviewRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Invalid binary preview request')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Invalid binary preview request')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 3 || !keys.includes('path') || !keys.includes('kind') || !keys.includes('generation')) {
    throw new TypeError('Invalid binary preview request')
  }
  if (typeof record.path !== 'string' || record.path.length === 0) {
    throw new TypeError('Invalid binary preview path')
  }
  if (record.kind !== 'image' && record.kind !== 'pdf') {
    throw new TypeError('Invalid binary preview kind')
  }
  const generation = validateBinaryPreviewGeneration(record.generation)
  return {
    path: record.path,
    kind: record.kind,
    generation
  }
}

export function validateBinaryPreviewPayload(
  value: unknown,
  request: BinaryPreviewRequest
): BinaryPreviewPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Invalid binary preview response')
  }
  const record = value as Record<string, unknown>
  if (
    record.path !== request.path ||
    record.kind !== request.kind ||
    record.generation !== request.generation
  ) {
    throw new TypeError('Stale binary preview response')
  }
  const descriptor = mediaPreviewDescriptorForPath(request.path)
  if (!descriptor || descriptor.kind !== request.kind || record.mime !== descriptor.mime) {
    throw new TypeError('Invalid binary preview MIME type')
  }
  const size = record.size
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
    throw new TypeError('Invalid binary preview size')
  }
  const bytes = record.bytes
  if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer)) {
    throw new TypeError('Invalid binary preview bytes')
  }
  if (bytes.byteLength !== size || bytes.byteLength > byteLimitForMediaKind(request.kind)) {
    throw new TypeError('Invalid binary preview byte length')
  }
  return {
    path: request.path,
    kind: request.kind,
    mime: descriptor.mime,
    size,
    generation: request.generation,
    bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
}
