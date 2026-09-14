// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { PROVIDER_SECRET_MAX_BYTES } from '@shared/provider-secret-broker'
import { REDACTED_SUBSTITUTE, SecretOutputBoundary, SecretOutputRedactor, SecretOutputRedactorClosedError } from './secret-output-redactor'

/**
 * Disposable markers shaped like real credential values: long enough to span
 * several chunks, distinct enough that a leak names its own origin, and never a
 * real secret.
 */
const MARKER_ALPHA = 'sk-alpha-0123456789abcdefghijklmnopqrstuv'
const MARKER_BETA = 'ghp_beta-ZYXWVUTSRQPONMLKJIHGFEDCBA'
const MARKER_GAMMA = 'xai-gamma-fedcba9876543210zzzz'

/**
 * Chunks `text` at every byte offset across `chunkCount` chunks, so a match
 * begins at, before, and after each boundary the transport can produce.
 */
function chunksAtEverySplit(text: string, chunkCount: number): string[][] {
  const splits: string[][] = []
  for (let split = 0; split <= text.length; split += 1) {
    const pieces = chunkCount === 1 ? [text] : []
    if (chunkCount > 1) {
      for (let index = 0; index < chunkCount; index += 1) {
        const start = Math.floor((text.length * index) / chunkCount)
        const end = Math.floor((text.length * (index + 1)) / chunkCount)
        pieces.push(text.slice(start, end))
      }
      // Rotate the cut so each candidate boundary is exercised as a real chunk edge.
      const head = text.slice(0, split)
      const tail = text.slice(split)
      pieces.length = 0
      pieces.push(head, tail)
    }
    splits.push(pieces.filter(piece => piece.length > 0))
  }
  return splits
}

/** Feeds `pieces` through one stream and returns everything a sink would see. */
function drain(redactor: SecretOutputRedactor, stream: 'stdout' | 'stderr', pieces: readonly string[]): string {
  let seen = ''
  for (const piece of pieces) seen += redactor.push(stream, piece)
  seen += redactor.flush(stream)
  return seen
}

describe('SecretOutputRedactor', () => {
  it('substitutes an exact secret echoed whole in one chunk', () => {
    const redactor = new SecretOutputRedactor([MARKER_ALPHA])
    const seen = drain(redactor, 'stdout', [`auth=${MARKER_ALPHA} ready\n`])
    expect(seen).toBe(`auth=${REDACTED_SUBSTITUTE} ready\n`)
    expect(seen).not.toContain(MARKER_ALPHA)
  })

  it('substitutes a secret split at every stdout and stderr byte offset', () => {
    for (const marker of [MARKER_ALPHA, MARKER_BETA, MARKER_GAMMA]) {
      for (const stream of ['stdout', 'stderr'] as const) {
        for (const pieces of chunksAtEverySplit(`prefix:${marker}:suffix`, 2)) {
          const redactor = new SecretOutputRedactor([MARKER_ALPHA, MARKER_BETA, MARKER_GAMMA])
          const seen = drain(redactor, stream, pieces)
          expect(seen, `leak for ${marker} on ${stream} split ${JSON.stringify(pieces)}`).not.toContain(marker)
          // The substitution is constant, so no fragment of the marker survives
          // as an identifiable prefix or suffix of the emitted bytes.
          expect(seen).toContain(REDACTED_SUBSTITUTE)
        }
      }
    }
  })

  it('substitutes a secret split across three chunks at a boundary spanning the whole secret', () => {
    const text = `a${MARKER_ALPHA}b`
    for (let first = 0; first <= text.length; first += 1) {
      for (let second = first; second <= text.length; second += 1) {
        const redactor = new SecretOutputRedactor([MARKER_ALPHA])
        const seen = drain(redactor, 'stdout', [text.slice(0, first), text.slice(first, second), text.slice(second)].filter(piece => piece.length > 0))
        expect(seen, `three-chunk leak at ${first}/${second}`).not.toContain(MARKER_ALPHA)
        expect(seen).toBe(`a${REDACTED_SUBSTITUTE}b`)
      }
    }
  })

  it('resolves overlapping secrets leftmost-longest instead of by pattern order', () => {
    const outer = 'secret-outer-0123456789'
    const inner = 'outer-0123456789'
    const forward = new SecretOutputRedactor([outer, inner])
    const reverse = new SecretOutputRedactor([inner, outer])
    expect(drain(forward, 'stdout', [`x${outer}y`])).toBe(drain(reverse, 'stdout', [`x${outer}y`]))
    expect(drain(forward, 'stdout', [`x${outer}y`])).toBe(`x${REDACTED_SUBSTITUTE}y`)
  })

  it('retains at most maxSecretBytes minus one undecided byte per stream', () => {
    // An eight-byte bound permits a seven-byte retain window, so one byte of an
    // eight-byte run is settled immediately and the rest stays undecided.
    const redactor = new SecretOutputRedactor(['abcd1234'], 8)
    expect(redactor.push('stdout', 'abcdefgh')).toBe('a')
    expect(redactor.push('stdout', '\n')).toBe('b')
    expect(redactor.flush('stdout')).toBe('cdefgh\n')
    // Across a long run the retained window stays bounded: exactly
    // (longest secret - 1) bytes are withheld, and the whole input is released.
    const wide = new SecretOutputRedactor([MARKER_ALPHA])
    const payload = 'y'.repeat(PROVIDER_SECRET_MAX_BYTES * 2)
    const emitted = wide.push('stdout', payload)
    expect(emitted).toHaveLength(payload.length - (MARKER_ALPHA.length - 1))
    expect(emitted + wide.flush('stdout')).toBe(payload)
  })

  it('keeps stdout and stderr carries independent', () => {
    const redactor = new SecretOutputRedactor([MARKER_ALPHA])
    const half = Math.floor(MARKER_ALPHA.length / 2)
    // The same leading half arrives on both streams and is withheld as undecided.
    expect(redactor.push('stdout', MARKER_ALPHA.slice(0, half))).toBe('')
    expect(redactor.push('stderr', MARKER_ALPHA.slice(0, half))).toBe('')
    // Completing only the stdout half redacts stdout and leaves the stderr carry
    // untouched, so one stream's match never consumes the other's bytes.
    expect(redactor.push('stdout', MARKER_ALPHA.slice(half))).toContain(REDACTED_SUBSTITUTE)
    expect(redactor.flush('stderr')).toBe(MARKER_ALPHA.slice(0, half))
  })

  it('flushes the residual undecided bytes at terminal close and then refuses further use', () => {
    const redactor = new SecretOutputRedactor([MARKER_ALPHA])
    expect(redactor.push('stdout', 'tail')).toBe('')
    expect(redactor.flush('stdout')).toBe('tail')
    redactor.close()
    expect(redactor.zeroized).toBe(true)
    expect(() => redactor.push('stdout', 'after close')).toThrowError(SecretOutputRedactorClosedError)
    expect(() => redactor.flush('stderr')).toThrowError(SecretOutputRedactorClosedError)
  })

  it('refuses empty, oversized, and control-bearing secret values before use', () => {
    expect(() => new SecretOutputRedactor([])).toThrowError(/at least one secret/)
    expect(() => new SecretOutputRedactor([''])).toThrowError(/empty or control-bearing/)
    expect(() => new SecretOutputRedactor(['a\0b'])).toThrowError(/empty or control-bearing/)
    expect(() => new SecretOutputRedactor(['x'.repeat(16)], 8)).toThrowError(/above its declared bound/)
  })
})

describe('SecretOutputBoundary', () => {
  it('passes output through unchanged for a session with no managed redactor', () => {
    const boundary = new SecretOutputBoundary()
    expect(boundary.has('legacy')).toBe(false)
    expect(boundary.push('legacy', 'stdout', `plain ${MARKER_ALPHA}`)).toBe(`plain ${MARKER_ALPHA}`)
    expect(boundary.flush('legacy')).toBe('')
    expect(boundary.isClosed('legacy')).toBe(false)
  })

  it('redacts a managed session across both streams and drops output after close', () => {
    const boundary = new SecretOutputBoundary()
    boundary.register('managed', [MARKER_ALPHA])
    const half = Math.floor(MARKER_ALPHA.length / 2)
    let seen = boundary.push('managed', 'stdout', MARKER_ALPHA.slice(0, half))
    seen += boundary.push('managed', 'stderr', MARKER_BETA)
    seen += boundary.push('managed', 'stdout', MARKER_ALPHA.slice(half))
    expect(seen).not.toContain(MARKER_ALPHA)
    expect(seen).not.toContain(MARKER_BETA)
    boundary.close('managed')
    expect(boundary.isClosed('managed')).toBe(true)
    // After the child's pipes closed, later output is dropped rather than
    // emitted unredacted: fail closed, never leak.
    expect(boundary.push('managed', 'stdout', MARKER_ALPHA)).toBe('')
  })

  it('refuses a second redactor for one session', () => {
    const boundary = new SecretOutputBoundary()
    boundary.register('managed', [MARKER_ALPHA])
    expect(() => boundary.register('managed', [MARKER_BETA])).toThrowError(/already has a managed output redactor/)
  })
})
