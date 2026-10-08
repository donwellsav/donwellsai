// @vitest-environment node
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProcessIdentity } from '@shared/child-process/process-spec'
import { PROVIDER_SECRET_BROKER_PROTOCOL, SecretAuthorityError, asCredentialRef, type ProviderLaunchAuthorization } from '@shared/provider-secret-broker'
import { localRuntimePaths, readRuntimeRecord } from './local-runtime'
import { claimRuntimeOwner, publishRuntimeOwner } from './runtime-ownership'
import { runtimeIdentityAuthority } from './runtime-identity'
import type { SecretBrokerTransport } from './provider-secret-broker'
import { ProviderSecretBrokerHost, SecretBrokerError, SECRET_BROKER_REGISTER_OP, SECRET_BROKER_RESPOND_OP, SECRET_BROKER_REQUEST_EVENT } from './provider-secret-broker'
import { TerminalDaemon } from './terminal-daemon'

const directories: string[] = []
const MARKER = 'broker-transport-marker-0123456789'

function profile(prefix: string): string {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
  directories.push(directory)
  return directory
}

function appIdentity(overrides: Partial<ProcessIdentity> = {}): ProcessIdentity {
  return {
    pid: process.pid,
    bootId: 'broker-boot',
    startedAt: '2026-09-14T00:00:00.000Z',
    executablePath: process.execPath,
    family: 'donwells-app',
    capturedAt: '2026-09-14T00:00:00.000Z',
    ...overrides
  }
}

function authorization(): ProviderLaunchAuthorization {
  return {
    launchAdmissionId: 'admission-1',
    preparationId: 'preparation-1',
    attemptId: 'attempt-1',
    sessionId: 'session-1',
    purpose: 'agent-launch',
    driverId: 'codex',
    providerInstanceId: 'instance-1',
    instanceRevision: 1,
    accountId: 'account-1',
    accountRevision: 1,
    credentialRef: asCredentialRef('ref-1'),
    bindingGeneration: 1
  }
}

/** A recording transport: it captures every frame and never performs I/O. */
class RecordingTransport {
  readonly frames: Record<string, unknown>[] = []
  destroyed = false

  write(frame: Buffer): void {
    for (const line of frame.toString('utf8').split('\n')) {
      if (line.trim()) this.frames.push(JSON.parse(line) as Record<string, unknown>)
    }
  }

  /** The same object, typed as the broker's transport seam. */
  get transport(): SecretBrokerTransport {
    return this
  }
}

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true })
})

describe('ProviderSecretBrokerHost', () => {
  function host(options: { verifyOwner?: (identity: ProcessIdentity) => boolean; deadlineMs?: number } = {}) {
    return new ProviderSecretBrokerHost({ verifyOwner: options.verifyOwner ?? (() => true), ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }) })
  }

  it('refuses an unverified owner and a second broker while one is live', () => {
    const unverified = host({ verifyOwner: () => false })
    expect(() => unverified.register(new RecordingTransport().transport, appIdentity())).toThrowError(SecretBrokerError)
    expect(unverified.live).toBe(false)

    const verified = host()
    const first = new RecordingTransport()
    const second = new RecordingTransport()
    verified.register(first.transport, appIdentity())
    expect(() => verified.register(second.transport, appIdentity())).toThrowError(/already registered/)
    // The live broker keeps ownership; the challenger did not displace it.
    expect(verified.ownsBroker(first.transport)).toBe(true)
    expect(verified.ownsBroker(second.transport)).toBe(false)
  })

  it('issues unguessable epochs and a fresh epoch on reconnect', () => {
    const broker = host()
    const first = new RecordingTransport()
    const firstRegistration = broker.register(first.transport, appIdentity())
    expect(firstRegistration.epoch).toMatch(/^[0-9a-f-]{36}/)
    broker.invalidate(first.transport)
    expect(broker.live).toBe(false)
    const second = new RecordingTransport()
    const secondRegistration = broker.register(second.transport, appIdentity())
    expect(secondRegistration.epoch).not.toBe(firstRegistration.epoch)
  })

  it('answers a request only when correlation and epoch both match', async () => {
    const broker = host()
    const transport = new RecordingTransport()
    const { epoch } = broker.register(transport.transport, appIdentity())
    const pending = broker.materialize(authorization())
    const request = transport.frames.find(frame => frame['event'] === SECRET_BROKER_REQUEST_EVENT)!
    expect(request['protocol']).toBe(PROVIDER_SECRET_BROKER_PROTOCOL)
    expect(request['connectionEpoch']).toBe(epoch)
    expect(request['requestId']).toBeTypeOf('string')
    expect(Number.isFinite(Date.parse(String(request['deadline'])))).toBe(true)

    // A wrong correlation, a stale epoch, and a malformed frame are each refused
    // without settling the request.
    broker.respond(transport.transport, { requestId: 'someone-else', connectionEpoch: epoch, ok: true, secrets: { environment: { OPENAI_API_KEY: MARKER }, credentialRevision: 1 } })
    broker.respond(transport.transport, { requestId: request['requestId'], connectionEpoch: 'stale-epoch', ok: true, secrets: { environment: { OPENAI_API_KEY: MARKER }, credentialRevision: 1 } })
    // A malformed body is a protocol error; the request still awaits a valid answer.
    expect(() => broker.respond(transport.transport, { requestId: request['requestId'], connectionEpoch: epoch, ok: true, secrets: 'not-an-object' })).toThrowError(SecretBrokerError)
    // An extended body is refused too, so a foreign frame cannot be smuggled in.
    expect(() => broker.respond(transport.transport, { requestId: request['requestId'], connectionEpoch: epoch, ok: true, secrets: { environment: { OPENAI_API_KEY: MARKER }, credentialRevision: 1 }, extra: true })).toThrowError(SecretBrokerError)

    broker.respond(transport.transport, { requestId: request['requestId'], connectionEpoch: epoch, ok: true, secrets: { environment: { OPENAI_API_KEY: MARKER }, credentialRevision: 7 } })
    await expect(pending).resolves.toEqual({ environment: { OPENAI_API_KEY: MARKER }, credentialRevision: 7 })
  })

  it('rejects with a timeout and a typed authority refusal', async () => {
    const broker = host({ deadlineMs: 30 })
    const transport = new RecordingTransport()
    const { epoch } = broker.register(transport.transport, appIdentity())
    await expect(broker.materialize(authorization())).rejects.toMatchObject({ code: 'BROKER_TIMEOUT' })

    const refused = broker.materialize(authorization())
    const request = transport.frames.filter(frame => frame['event'] === SECRET_BROKER_REQUEST_EVENT).at(-1)!
    broker.respond(transport.transport, { requestId: request['requestId'], connectionEpoch: epoch, ok: false, error: 'CREDENTIAL_REVOKED' })
    await expect(refused).rejects.toBeInstanceOf(SecretAuthorityError)
    await expect(refused).rejects.toMatchObject({ code: 'CREDENTIAL_REVOKED' })
  })

  it('invalidates every pending request on disconnect and drops late responses', async () => {
    const broker = host()
    const transport = new RecordingTransport()
    broker.register(transport.transport, appIdentity())
    const first = broker.materialize(authorization())
    const second = broker.materialize(authorization())
    broker.invalidate(transport.transport)
    await expect(first).rejects.toMatchObject({ code: 'BROKER_DISCONNECTED' })
    await expect(second).rejects.toMatchObject({ code: 'BROKER_DISCONNECTED' })
    // A late response for an invalidated request resolves nothing and throws nothing.
    const frames = transport.frames.filter(frame => frame['event'] === SECRET_BROKER_REQUEST_EVENT)
    expect(() => broker.respond(transport.transport, { requestId: frames[0]!['requestId'], connectionEpoch: frames[0]!['connectionEpoch'], ok: true, secrets: { environment: { OPENAI_API_KEY: MARKER }, credentialRevision: 1 } })).toThrowError(/not the registered credential broker/)
  })

  it('rejects materialization when no broker is registered', async () => {
    await expect(host().materialize(authorization())).rejects.toMatchObject({ code: 'BROKER_ABSENT' })
  })

  it('refuses a registration that no longer names the application family', () => {
    expect(() => ProviderSecretBrokerHost.parseIdentity({ ...appIdentity(), family: 'terminal-daemon' })).toThrowError(/application process/)
    expect(() => ProviderSecretBrokerHost.parseIdentity(null)).toThrowError(SecretBrokerError)
    expect(ProviderSecretBrokerHost.parseIdentity(appIdentity())).toEqual(appIdentity())
  })
})

/** A raw authenticated daemon connection used to drive the broker ops. */
class WireClient {
  private decoder = new StringDecoder('utf8')
  private buffer = ''
  private greeted = false
  readonly frames: Record<string, unknown>[] = []
  private readonly waiters: Array<(message: Record<string, unknown>) => void> = []

  private constructor(private readonly socket: Socket) {
    socket.on('data', chunk => {
      this.buffer += this.decoder.write(chunk)
      let newline: number
      while ((newline = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        if (!line.trim()) continue
        let message: Record<string, unknown>
        try {
          message = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        if (!this.greeted && Array.isArray(message['capabilities'])) {
          this.greeted = true
          const waiter = this.waiters.shift()
          if (waiter) waiter(message)
          continue
        }
        const waiter = this.waiters.shift()
        if (waiter) waiter(message)
        else this.frames.push(message)
      }
    })
  }

  static async open(socketPath: string, authToken: string): Promise<WireClient> {
    const socket = createConnection(socketPath)
    const opened = Promise.withResolvers<void>()
    socket.once('connect', () => opened.resolve())
    socket.once('error', opened.reject)
    await opened.promise
    const client = new WireClient(socket)
    const hello = client.next()
    socket.write(JSON.stringify({ id: 'hello', op: 'hello', authToken }) + '\n')
    await hello
    return client
  }

  next(): Promise<Record<string, unknown>> {
    const queued = this.frames.shift()
    if (queued) return Promise.resolve(queued)
    const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>()
    this.waiters.push(resolve)
    return promise
  }

  send(message: Record<string, unknown>): void {
    this.socket.write(JSON.stringify(message) + '\n')
  }

  close(): void {
    this.socket.destroy()
  }
}

describe('terminal daemon credential broker transport', () => {
  async function started(prefix: string) {
    const directory = profile(prefix)
    const daemon = new TerminalDaemon({ userDataDir: directory, authToken: 'broker-transport-token-123456' })
    await daemon.start()
    const locator = readRuntimeRecord(localRuntimePaths(directory, 'terminal').runtimeFile)
    if (locator.status !== 'current') throw new Error('daemon did not publish its endpoint')
    return { directory, daemon, locator: locator.record }
  }

  it('advertises the broker capability and never answers a registration from an unverified owner', async () => {
    const { daemon, locator } = await started('broker-daemon-')
    const client = await WireClient.open(locator.socketPath, locator.authToken)
    try {
      client.send({ id: 'register', op: SECRET_BROKER_REGISTER_OP, protocol: PROVIDER_SECRET_BROKER_PROTOCOL, identity: appIdentity({ executablePath: '/nonexistent/donwells' }) })
      const reply = await client.next()
      expect(reply).toMatchObject({ id: 'register', ok: false })
      expect(reply['code']).toBe('BROKER_OWNER_UNVERIFIED')
    } finally {
      client.close()
      await daemon.stopIfIdle()
    }
  })

  it('refuses an ordinary op that tries to answer a broker request', async () => {
    const { daemon, locator } = await started('broker-ordinary-')
    const client = await WireClient.open(locator.socketPath, locator.authToken)
    try {
      client.send({ id: 'respond', op: SECRET_BROKER_RESPOND_OP, requestId: 'r', connectionEpoch: 'e', ok: true, secrets: { environment: { OPENAI_API_KEY: MARKER }, credentialRevision: 1 } })
      const reply = await client.next()
      expect(reply).toMatchObject({ id: 'respond', ok: false })
      expect(reply['code']).toBe('BROKER_ABSENT')
    } finally {
      client.close()
      await daemon.stopIfIdle()
    }
  })

  it('registers the verified app owner, correlates one answer, and invalidates on disconnect', async () => {
    const { directory, daemon, locator } = await started('broker-answer-')
    // Stand in for the app process: publish its ownership row, then verify.
    const authority = runtimeIdentityAuthority()
    const app = claimRuntimeOwner({
      userDataDir: directory,
      kind: 'donwells-app',
      endpoint: join(tmpdir(), `donwells-app-broker-${process.pid}.sock`),
      authToken: 'broker-app-token-123456',
      captureIdentity: generation => authority.capture(process.pid, { family: 'donwells-app', executablePath: process.execPath, generation }),
      authority
    })
    await publishRuntimeOwner(app, () => undefined)
    const client = await WireClient.open(locator.socketPath, locator.authToken)
    try {
      client.send({ id: 'register', op: SECRET_BROKER_REGISTER_OP, protocol: PROVIDER_SECRET_BROKER_PROTOCOL, identity: app.owner.identity })
      const reply = await client.next()
      expect(reply).toMatchObject({ id: 'register', ok: true })
      const epoch = String(reply['epoch'])
      expect(epoch.length).toBeGreaterThan(16)

      // The trusted launch path requests one materialization; the broker answers.
      const pending = daemon.materializeProviderLaunch(authorization())
      const request = await client.next()
      expect(request).toMatchObject({ event: SECRET_BROKER_REQUEST_EVENT, connectionEpoch: epoch })
      client.send({ id: String(request['requestId']), op: SECRET_BROKER_RESPOND_OP, requestId: request['requestId'], connectionEpoch: epoch, ok: true, secrets: { environment: { OPENAI_API_KEY: MARKER }, credentialRevision: 3 } })
      await expect(pending).resolves.toEqual({ environment: { OPENAI_API_KEY: MARKER }, credentialRevision: 3 })
      // The response acknowledgement itself carries no secret material.
      const acknowledged = await client.next()
      expect(JSON.stringify(acknowledged)).not.toContain(MARKER)

      const orphaned = daemon.materializeProviderLaunch(authorization())
      await client.next()
      client.close()
      await expect(orphaned).rejects.toMatchObject({ code: 'BROKER_DISCONNECTED' })
    } finally {
      client.close()
      app.store.close()
      await daemon.stopIfIdle()
    }
  })
})
