import { randomUUID } from 'node:crypto'
import type { ProcessIdentity } from '@shared/child-process/process-spec'
import {
  PROVIDER_SECRET_BROKER_DEADLINE_MS,
  PROVIDER_SECRET_BROKER_PROTOCOL,
  SecretAuthorityError,
  parseProviderLaunchAuthorization,
  parseSecretBrokerMaterializeResponse,
  type ProviderLaunchAuthorization,
  type ProviderLaunchSecrets,
  type SecretAuthorityErrorCode
} from '@shared/provider-secret-broker'

/** Daemon op the app owner uses to become the one live credential broker. */
export const SECRET_BROKER_REGISTER_OP = 'broker.register'
/** Daemon op the registered broker uses to answer exactly one request. */
export const SECRET_BROKER_RESPOND_OP = 'broker.respond'
/** Daemon event carrying one materialization request to the registered broker. */
export const SECRET_BROKER_REQUEST_EVENT = 'broker-request'

/**
 * Transport failures are distinct from `SecretAuthorityError`: those describe
 * what the Secret Authority decided, these describe why no decision arrived.
 * Callers branch on both, and neither carries secret material.
 */
export const SECRET_BROKER_ERROR_CODES = ['BROKER_ABSENT', 'BROKER_BUSY', 'BROKER_TIMEOUT', 'BROKER_DISCONNECTED', 'BROKER_RESPONSE_INVALID', 'BROKER_OWNER_UNVERIFIED'] as const
export type SecretBrokerErrorCode = (typeof SECRET_BROKER_ERROR_CODES)[number]

export class SecretBrokerError extends Error {
  constructor(readonly code: SecretBrokerErrorCode, message: string) {
    super(message)
    this.name = 'SecretBrokerError'
  }
}

/** The minimal transport the host writes to; tests inject a recording fake. */
export type SecretBrokerTransport = {
  write(frame: Buffer): void
  readonly destroyed: boolean
}

type Pending = {
  requestId: string
  settle: (result: { secrets: ProviderLaunchSecrets } | { error: SecretAuthorityErrorCode } | { transport: SecretBrokerErrorCode }) => void
  timer: ReturnType<typeof setTimeout>
}

export type ProviderSecretBrokerHostOptions = Readonly<{
  /**
   * Verifies that the registering process is the current app owner. The daemon
   * supplies this from Runtime Identity plus its own ownership row, so a second
   * process cannot claim the broker by presenting a plausible identity.
   */
  verifyOwner: (identity: ProcessIdentity) => boolean
  deadlineMs?: number
  now?: () => Date
}>

/**
 * The daemon side of `provider-secret-broker-v1`.
 *
 * Only the daemon creates request IDs and connection epochs; the app owner only
 * answers. One broker may be live at a time, a disconnect invalidates every
 * pending request, and exactly one schema-validated response per request is
 * accepted. No secret material is retained here: a resolved environment exists
 * only in the promise the requesting caller awaits.
 */
export class ProviderSecretBrokerHost {
  private readonly verifyOwner: (identity: ProcessIdentity) => boolean
  private readonly deadlineMs: number
  private readonly now: () => Date
  private transport: SecretBrokerTransport | null = null
  private epoch: string | null = null
  private pending = new Map<string, Pending>()

  constructor(options: ProviderSecretBrokerHostOptions) {
    this.verifyOwner = options.verifyOwner
    this.deadlineMs = options.deadlineMs ?? PROVIDER_SECRET_BROKER_DEADLINE_MS
    this.now = options.now ?? (() => new Date())
  }

  /** True once an authenticated broker is registered and still connected. */
  get live(): boolean {
    return this.transport !== null && !this.transport.destroyed
  }

  /** The current connection epoch, or null when no broker is registered. */
  get connectionEpoch(): string | null {
    if (!this.live) return null
    return this.epoch
  }

  /** Whether this exact connection is the registered broker. */
  ownsBroker(transport: SecretBrokerTransport): boolean {
    return this.live && this.transport === transport
  }

  /**
   * Registers the one live broker. A live registration is never replaced, so a
   * second process cannot seize the broker while the first still holds it; a
   * reconnect after disconnect receives a fresh epoch.
   */
  register(transport: SecretBrokerTransport, identity: ProcessIdentity): { epoch: string; deadlineMs: number } {
    if (this.live && this.transport !== transport) throw new SecretBrokerError('BROKER_BUSY', 'A verified credential broker is already registered')
    if (transport.destroyed) throw new SecretBrokerError('BROKER_DISCONNECTED', 'The registering connection is already closed')
    if (!this.verifyOwner(identity)) throw new SecretBrokerError('BROKER_OWNER_UNVERIFIED', 'Only the verified application owner may register the credential broker')
    this.transport = transport
    this.epoch = randomUUID() + randomUUID().slice(0, 8)
    return { epoch: this.epoch, deadlineMs: this.deadlineMs }
  }

  /**
   * Answers exactly one request. The response body is schema-validated and must
   * carry the current epoch; a stale-epoch or unknown request ID is discarded
   * without settling anything, so a late or forged frame cannot land. Only a
   * malformed body is a protocol error.
   */
  respond(transport: SecretBrokerTransport, message: unknown): void {
    if (!this.ownsBroker(transport)) throw new SecretBrokerError('BROKER_ABSENT', 'This connection is not the registered credential broker')
    let response
    try {
      response = parseSecretBrokerMaterializeResponse(message)
    } catch (error) {
      throw new SecretBrokerError('BROKER_RESPONSE_INVALID', error instanceof Error ? error.message : 'Credential broker response is malformed')
    }
    if (this.epoch === null || response.connectionEpoch !== this.epoch) return
    const pending = this.pending.get(response.requestId)
    if (!pending) return
    this.pending.delete(response.requestId)
    clearTimeout(pending.timer)
    pending.settle(response.ok ? { secrets: response.secrets } : { error: response.error })
  }

  /**
   * Sends one materialization request to the registered broker and awaits its
   * single response. Every failure path rejects without secret material.
   */
  materialize(authorization: ProviderLaunchAuthorization): Promise<ProviderLaunchSecrets> {
    const transport = this.live ? this.transport : null
    if (!transport || this.epoch === null) return Promise.reject(new SecretBrokerError('BROKER_ABSENT', 'No credential broker is registered'))
    const request = {
      protocol: PROVIDER_SECRET_BROKER_PROTOCOL,
      requestId: randomUUID(),
      connectionEpoch: this.epoch,
      deadline: new Date(this.now().getTime() + this.deadlineMs).toISOString(),
      authorization
    }
    const completion = Promise.withResolvers<ProviderLaunchSecrets>()
    const settle = (result: { secrets: ProviderLaunchSecrets } | { error: SecretAuthorityErrorCode } | { transport: SecretBrokerErrorCode }): void => {
      if ('secrets' in result) completion.resolve(result.secrets)
      else if ('error' in result) completion.reject(new SecretAuthorityError(result.error, 'The credential broker refused this launch'))
      else completion.reject(new SecretBrokerError(result.transport, 'The credential broker could not answer this launch'))
    }
    const timer = setTimeout(() => {
      this.pending.delete(request.requestId)
      completion.reject(new SecretBrokerError('BROKER_TIMEOUT', 'The credential broker did not answer within its deadline'))
    }, this.deadlineMs)
    timer.unref?.()
    this.pending.set(request.requestId, { requestId: request.requestId, settle, timer })
    try {
      transport.write(Buffer.from(JSON.stringify({ event: SECRET_BROKER_REQUEST_EVENT, ...request }) + '\n'))
    } catch (error) {
      this.pending.delete(request.requestId)
      clearTimeout(timer)
      completion.reject(new SecretBrokerError('BROKER_DISCONNECTED', error instanceof Error ? error.message : 'The credential broker connection failed'))
    }
    return completion.promise
  }

  /**
   * Invalidates every pending request for this connection. Late responses are
   * dropped because their request IDs are no longer pending.
   */
  invalidate(transport: SecretBrokerTransport): void {
    if (this.transport !== transport) return
    this.transport = null
    this.epoch = null
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.settle({ transport: 'BROKER_DISCONNECTED' })
    }
    this.pending.clear()
  }

  /** Parses the register frame's identity, refusing an unexpected shape. */
  static parseIdentity(value: unknown): ProcessIdentity {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SecretBrokerError('BROKER_OWNER_UNVERIFIED', 'Credential broker registration carries no process identity')
    const record = value as Record<string, unknown>
    const family = record['family']
    if (family !== 'donwells-app') throw new SecretBrokerError('BROKER_OWNER_UNVERIFIED', 'Only the application process may register the credential broker')
    if (typeof record['pid'] !== 'number' || !Number.isSafeInteger(record['pid']) || record['pid'] <= 0) throw new SecretBrokerError('BROKER_OWNER_UNVERIFIED', 'Credential broker registration carries an invalid PID')
    for (const field of ['bootId', 'startedAt', 'executablePath', 'capturedAt'] as const) {
      const fieldValue = record[field]
      if (typeof fieldValue !== 'string' || fieldValue.length === 0 || fieldValue.length > 16 * 1024) throw new SecretBrokerError('BROKER_OWNER_UNVERIFIED', `Credential broker registration carries an invalid ${field}`)
    }
    return {
      pid: record['pid'],
      bootId: record['bootId'] as string,
      startedAt: record['startedAt'] as string,
      executablePath: record['executablePath'] as string,
      family: 'donwells-app',
      capturedAt: record['capturedAt'] as string,
      ...(typeof record['generation'] === 'string' ? { generation: record['generation'] } : {})
    }
  }

  /** The one materialization path a validated broker response may satisfy. */
  static parseAuthorization(value: unknown): ProviderLaunchAuthorization {
    return parseProviderLaunchAuthorization(value)
  }
}
