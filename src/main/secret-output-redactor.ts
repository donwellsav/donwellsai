import { PROVIDER_SECRET_MAX_BYTES } from '@shared/provider-secret-broker'

/**
 * Exact-secret accidental-disclosure mitigation for managed provider launches.
 *
 * One bounded streaming redactor per managed launch is constructed from the
 * exact credential values already in memory, and every byte of the child's
 * stdout and stderr passes through it before it reaches any PTY, event, log,
 * error, crash, or support sink.
 *
 * This is not containment of a malicious provider: a credential-bearing child
 * can transform, encode, derive from, or transmit its own credential. Network
 * and tool sandboxing and adversarial-provider confinement are outside this
 * stage.
 *
 * Bounds and lifetime:
 * - Each stream retains only its final `maxSecretBytes - 1` undecided bytes, so
 *   a match split across arbitrary chunk boundaries is caught without
 *   unbounded growth.
 * - `push` returns only settled bytes; the caller applies backpressure and
 *   output limits to those, never to the retain window.
 * - `flush` emits the residual undecided bytes at terminal close; `close`
 *   zeroizes patterns and carry and may only run once every child output pipe
 *   closed.
 * - Plaintext patterns are never persisted or replayed.
 */

/** Constant substitute for one exact credential value. */
export const REDACTED_SUBSTITUTE = '[REDACTED]'

export type SecretOutputStream = 'stdout' | 'stderr'

export class SecretOutputRedactorClosedError extends Error {
  constructor(readonly stream: SecretOutputStream) {
    super(`secret output redactor for ${stream} is closed; output can no longer be redacted`)
    this.name = 'SecretOutputRedactorClosedError'
  }
}

/**
 * Longest suffix of `value` whose UTF-8 encoding fits in `maxBytes`. Surrogate
 * pairs count as one four-byte unit and are never split, so a retained suffix
 * is always valid text.
 */
function undecidedSuffix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  let bytes = 0
  let cut = value.length
  while (cut > 0) {
    const low = value.charCodeAt(cut - 1)
    const isLowSurrogate = low >= 0xdc00 && low <= 0xdfff
    let size = 1
    let step = 1
    if (isLowSurrogate && cut >= 2 && value.charCodeAt(cut - 2) >= 0xd800 && value.charCodeAt(cut - 2) <= 0xdbff) {
      size = 4
      step = 2
    } else if (!isLowSurrogate && low >= 0x800) {
      size = 3
    } else if (!isLowSurrogate && low >= 0x80) {
      size = 2
    }
    if (bytes + size > maxBytes) break
    bytes += size
    cut -= step
  }
  // A high surrogate left immediately before the cut owns its low half beyond
  // it; retaining the whole pair keeps a split match alive.
  if (cut > 0) {
    const preceding = value.charCodeAt(cut - 1)
    if (preceding >= 0xd800 && preceding <= 0xdbff) cut -= 1
  }
  return value.slice(cut)
}

/** One exact credential value and its byte length, precomputed once. */
type Pattern = Readonly<{ value: string; bytes: number }>

class StreamCarry {
  /** Undecided tail retained across chunks; bounded by `retainBytes`. */
  private carry = ''
  private readonly retainBytes: number
  private closed = false

  constructor(private patterns: readonly Pattern[], maxSecretBytes: number) {
    let longest = 0
    for (const pattern of patterns) {
      if (pattern.bytes > longest) longest = pattern.bytes
    }
    this.retainBytes = Math.max(0, Math.min(longest - 1, maxSecretBytes - 1))
  }

  /**
   * Leftmost-longest match across the whole pattern set. Substituting one match
   * and rescanning the remainder resolves overlapping candidates (a secret that
   * contains another secret) deterministically, independent of pattern order.
   */
  private firstMatch(buffer: string): { index: number; length: number } | null {
    let found: { index: number; length: number } | null = null
    for (const pattern of this.patterns) {
      const index = buffer.indexOf(pattern.value)
      if (index === -1) continue
      if (found === null || index < found.index || (index === found.index && pattern.value.length > found.length)) {
        found = { index, length: pattern.value.length }
      }
    }
    return found
  }

  private settle(buffer: string, retain: boolean): { settled: string; carry: string } {
    let settled = ''
    let rest = buffer
    for (;;) {
      const hit = this.firstMatch(rest)
      if (hit === null) break
      settled += rest.slice(0, hit.index) + REDACTED_SUBSTITUTE
      rest = rest.slice(hit.index + hit.length)
    }
    if (!retain) return { settled: settled + rest, carry: '' }
    const carry = undecidedSuffix(rest, this.retainBytes)
    return { settled: settled + rest.slice(0, rest.length - carry.length), carry }
  }

  push(chunk: string, stream: SecretOutputStream): string {
    if (this.closed) throw new SecretOutputRedactorClosedError(stream)
    if (chunk.length === 0) return ''
    const { settled, carry } = this.settle(this.carry + chunk, true)
    this.carry = carry
    return settled
  }

  /** Emits the residual undecided bytes with no retention; valid only at stream end. */
  flush(stream: SecretOutputStream): string {
    if (this.closed) throw new SecretOutputRedactorClosedError(stream)
    const { settled } = this.settle(this.carry, false)
    this.carry = ''
    return settled
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.carry = ''
    // JavaScript strings are immutable, so the strongest available zeroization
    // is dropping every retained reference to the pattern material.
    this.patterns = []
  }

  get isClosed(): boolean {
    return this.closed
  }
}

/**
 * One redactor per managed launch: two independently carried streams, one
 * constant substitute, and a terminal close that zeroizes both.
 */
export class SecretOutputRedactor {
  private readonly streams: Record<SecretOutputStream, StreamCarry>

  constructor(secrets: readonly string[], maxSecretBytes: number = PROVIDER_SECRET_MAX_BYTES) {
    if (!Number.isSafeInteger(maxSecretBytes) || maxSecretBytes < 1) {
      throw new Error('secret output redactor requires a positive maxSecretBytes bound')
    }
    const unique = new Set<string>()
    for (const secret of secrets) {
      if (typeof secret !== 'string' || secret.length === 0 || secret.includes('\0')) {
        throw new Error('secret output redactor refuses empty or control-bearing secret values')
      }
      if (Buffer.byteLength(secret, 'utf8') > maxSecretBytes) {
        throw new Error('secret output redactor refuses a secret above its declared bound')
      }
      unique.add(secret)
    }
    if (unique.size === 0) throw new Error('secret output redactor requires at least one secret value')
    const patterns: Pattern[] = [...unique].map(value => ({ value, bytes: Buffer.byteLength(value, 'utf8') }))
    this.streams = {
      stdout: new StreamCarry(patterns, maxSecretBytes),
      stderr: new StreamCarry(patterns, maxSecretBytes)
    }
  }

  push(stream: SecretOutputStream, chunk: string): string {
    return this.streams[stream].push(chunk, stream)
  }

  flush(stream: SecretOutputStream): string {
    return this.streams[stream].flush(stream)
  }

  close(): void {
    this.streams.stdout.close()
    this.streams.stderr.close()
  }

  get zeroized(): boolean {
    return this.streams.stdout.isClosed && this.streams.stderr.isClosed
  }
}

/**
 * The daemon's single redaction funnel for managed launches.
 *
 * It owns exactly one redactor per session and is the only push site for that
 * child's output, so the live PTY sink (scrollback, replay, broadcast, job
 * result) and the task output pump read the same settled bytes instead of
 * racing two independent carry states. It deliberately retains no accumulated
 * output: every sink keeps its own bounded view, and this funnel stays bounded
 * by the retain window alone.
 *
 * A session with no registered redactor passes output through unchanged: `none`
 * launches carry no credential material and every legacy path stays
 * behaviorally identical.
 *
 * A closed session keeps its registration and returns nothing from `push`, so
 * output arriving after the child's pipes closed is dropped rather than emitted
 * unredacted. That is the fail-closed direction, and `isClosed` reports it.
 * `forget` is the separate, terminal step: it drops the registration once the
 * PTY is dismissed or reaped and nothing can arrive for that session again.
 */
export class SecretOutputBoundary {
  private readonly redactors = new Map<string, SecretOutputRedactor>()

  /** Registers the one redactor for a managed launch from its exact in-memory secrets. */
  register(sessionId: string, secrets: readonly string[], maxSecretBytes?: number): void {
    if (this.redactors.has(sessionId)) throw new Error(`session ${sessionId} already has a managed output redactor`)
    this.redactors.set(sessionId, new SecretOutputRedactor(secrets, maxSecretBytes))
  }

  has(sessionId: string): boolean {
    return this.redactors.has(sessionId)
  }

  isClosed(sessionId: string): boolean {
    return this.redactors.get(sessionId)?.zeroized ?? false
  }

  /** Redacts one chunk; returns only bytes a sink may receive. */
  push(sessionId: string, stream: SecretOutputStream, data: string): string {
    const redactor = this.redactors.get(sessionId)
    if (!redactor) return data
    if (redactor.zeroized) return ''
    return redactor.push(stream, data)
  }

  /** Emits one stream's residual undecided bytes at terminal close. */
  flush(sessionId: string, stream: SecretOutputStream = 'stdout'): string {
    const redactor = this.redactors.get(sessionId)
    if (!redactor || redactor.zeroized) return ''
    return redactor.flush(stream)
  }

  /** Zeroizes patterns and carry; only valid once every child output pipe closed. */
  close(sessionId: string): void {
    this.redactors.get(sessionId)?.close()
  }

  /**
   * Releases one session's registration at its terminal teardown — after the PTY
   * was dismissed or reaped, when no data, title, or exit can arrive for it any
   * more. Deliberately separate from `close`: a closed registration must keep
   * `has` true so late output is dropped rather than passed through unredacted,
   * so removing it inside `close` would trade a leak for an emission. Without
   * this the map holds one entry per managed launch for the daemon's life.
   */
  forget(sessionId: string): void {
    this.redactors.get(sessionId)?.close()
    this.redactors.delete(sessionId)
  }

  closeAll(): void {
    for (const redactor of this.redactors.values()) redactor.close()
  }

  get registeredSessions(): readonly string[] {
    return [...this.redactors.keys()]
  }
}
