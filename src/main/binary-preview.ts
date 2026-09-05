import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import {
  byteLimitForMediaKind,
  mediaPreviewDescriptorForPath,
  validateBinaryPreviewRequest,
  type BinaryPreviewPayload,
  type ImagePreviewMime,
  type MediaPreviewMime
} from '@shared/media-preview'
import {
  assertPathMatchesDescriptor,
  resolveExistingFile,
  WorktreeFileError
} from './worktree-files'

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0
const READ_CHUNK_BYTES = 256 * 1024
const PDF_HEADER_SCAN_BYTES = 1_024
const PDF_TRAILER_SCAN_BYTES = 2_048

export type BinaryPreviewErrorCode =
  | 'cancelled'
  | 'changed'
  | 'invalid-request'
  | 'malformed'
  | 'too-large'
  | 'unsupported'
  | 'unreadable'

export class BinaryPreviewError extends Error {
  constructor(
    readonly code: BinaryPreviewErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'BinaryPreviewError'
  }
}

function throwIfAborted(signal: AbortSignal | undefined, path: string): void {
  if (signal?.aborted) {
    throw new BinaryPreviewError('cancelled', `Preview cancelled: ${path}`)
  }
}

function imageMimeFromHeader(bytes: Uint8Array): ImagePreviewMime | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) return 'image/png'

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }

  if (bytes.length >= 6) {
    const signature = Buffer.from(bytes.buffer, bytes.byteOffset, 6).toString('ascii')
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif'
  }

  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.buffer, bytes.byteOffset, 4).toString('ascii') === 'RIFF' &&
    Buffer.from(bytes.buffer, bytes.byteOffset + 8, 4).toString('ascii') === 'WEBP'
  ) return 'image/webp'

  if (bytes.length >= 12 && Buffer.from(bytes.buffer, bytes.byteOffset + 4, 4).toString('ascii') === 'ftyp') {
    const declaredBoxSize = Buffer.from(bytes.buffer, bytes.byteOffset, 4).readUInt32BE(0)
    const scanEnd = Math.min(bytes.length, Math.max(12, Math.min(declaredBoxSize, 64)))
    for (let offset = 8; offset + 4 <= scanEnd; offset += 4) {
      const brand = Buffer.from(bytes.buffer, bytes.byteOffset + offset, 4).toString('ascii')
      if (brand === 'avif' || brand === 'avis') return 'image/avif'
    }
  }

  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp'
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) {
    return 'image/x-icon'
  }
  return null
}

function pdfMimeFromStructure(bytes: Uint8Array): 'application/pdf' | null {
  if (bytes.length < 16) return null
  const headLength = Math.min(bytes.length, PDF_HEADER_SCAN_BYTES)
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, headLength).toString('latin1')
  if (!/(?:^|[\r\n])%PDF-(?:1\.[0-7]|2\.0)(?:[\r\n]|%)/.test(head)) return null

  const tailOffset = Math.max(0, bytes.length - PDF_TRAILER_SCAN_BYTES)
  const tail = Buffer.from(bytes.buffer, bytes.byteOffset + tailOffset, bytes.length - tailOffset).toString('latin1')
  if (!/startxref\s+\d+\s+%%EOF[\s\0]*$/.test(tail)) return null
  return 'application/pdf'
}

function mimeFromContent(bytes: Uint8Array): MediaPreviewMime | null {
  return imageMimeFromHeader(bytes) ?? pdfMimeFromStructure(bytes)
}

async function readStableBytes(
  root: string,
  path: string,
  limit: number,
  signal: AbortSignal | undefined
): Promise<Buffer> {
  throwIfAborted(signal, path)
  const confinedRoot = await realpath(root)
  const absolutePath = await resolveExistingFile(confinedRoot, path)
  throwIfAborted(signal, path)
  const handle = await open(absolutePath, constants.O_RDONLY | NO_FOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile()) throw new BinaryPreviewError('unreadable', `Cannot preview non-file: ${path}`)
    await assertPathMatchesDescriptor(absolutePath, confinedRoot, before, path)
    if (!Number.isSafeInteger(before.size) || before.size < 0) {
      throw new BinaryPreviewError('unreadable', `Cannot determine preview size: ${path}`)
    }
    if (before.size > limit) {
      const maximum = Math.floor(limit / (1024 * 1024))
      throw new BinaryPreviewError('too-large', `Cannot preview ${path}: file exceeds the ${maximum} MiB limit`)
    }

    const bytes = Buffer.allocUnsafe(before.size)
    let offset = 0
    while (offset < bytes.length) {
      throwIfAborted(signal, path)
      const length = Math.min(READ_CHUNK_BYTES, bytes.length - offset)
      const { bytesRead } = await handle.read(bytes, offset, length, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }

    const after = await handle.stat()
    await assertPathMatchesDescriptor(absolutePath, confinedRoot, after, path)
    const stable =
      before.dev === after.dev &&
      before.ino === after.ino &&
      before.size === after.size &&
      before.mtimeMs === after.mtimeMs &&
      before.ctimeMs === after.ctimeMs &&
      offset === after.size
    if (!stable) {
      throw new BinaryPreviewError('changed', `Cannot preview ${path}: file changed while it was being read`)
    }
    throwIfAborted(signal, path)
    return bytes
  } finally {
    await handle.close()
  }
}

/** Read one immutable, complete media payload from inside a worktree boundary. */
export async function readBinaryPreview(
  root: string,
  input: unknown,
  signal?: AbortSignal
): Promise<BinaryPreviewPayload> {
  let request
  try {
    request = validateBinaryPreviewRequest(input)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid binary preview request'
    throw new BinaryPreviewError('invalid-request', message)
  }

  const descriptor = mediaPreviewDescriptorForPath(request.path)
  if (!descriptor || descriptor.kind !== request.kind) {
    throw new BinaryPreviewError('unsupported', `Unsupported preview type: ${request.path}`)
  }

  let bytes: Buffer
  try {
    bytes = await readStableBytes(root, request.path, byteLimitForMediaKind(request.kind), signal)
  } catch (error) {
    if (error instanceof BinaryPreviewError || error instanceof WorktreeFileError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new BinaryPreviewError('unreadable', `Cannot preview ${request.path}: ${message}`)
  }

  const actualMime = mimeFromContent(bytes)
  if (!actualMime) {
    throw new BinaryPreviewError('malformed', `Cannot preview ${request.path}: malformed or truncated file header`)
  }
  if (actualMime !== descriptor.mime) {
    throw new BinaryPreviewError(
      'malformed',
      `Cannot preview ${request.path}: file header does not match ${descriptor.mime}`
    )
  }

  const payloadBytes = bytes.buffer instanceof ArrayBuffer
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : Uint8Array.from(bytes)
  return {
    path: request.path,
    kind: request.kind,
    mime: actualMime,
    size: payloadBytes.byteLength,
    generation: request.generation,
    bytes: payloadBytes
  }
}
