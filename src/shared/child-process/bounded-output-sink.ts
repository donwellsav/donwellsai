import { Buffer } from 'node:buffer'

/** Collects bytes up to a hard cap and reports the first overflow. */
export function createOutputSink(maxBytes: number, onLimit: () => void): {
  write: (chunk: Buffer | string) => void
  text: () => string
  truncated: () => boolean
} {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxOutputBytes must be a non-negative safe integer')
  }
  const chunks: Buffer[] = []
  let bytes = 0
  let didNotifyLimit = false
  return {
    write(raw) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      const remaining = maxBytes - bytes
      if (remaining > 0) chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk)
      bytes += chunk.length
      if (bytes > maxBytes && !didNotifyLimit) {
        didNotifyLimit = true
        onLimit()
      }
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
    truncated: () => bytes > maxBytes
  }
}
