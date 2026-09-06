import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect as netConnect } from 'node:net'
import { localRuntimePaths } from '../src/main/local-runtime'

/**
 * Daemon e2e against the real compiled daemon: spawn entry, NDJSON over the
 * unix socket, PTY open/write/scrollback/attach, restart-survival semantics.
 * Real timers only where the PTY itself is asynchronous.
 */

const projectRoot = join(import.meta.dirname, '..')


function makeRepo(): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'donwells-daemon-'))
  const path = join(root, 'repo')
  mkdirSync(path)
  execFileSync('git', ['init', '-b', 'main'], { cwd: path })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: path })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: path })
  return { root, path }
}

const cleanup: string[] = []
const procs: ChildProcess[] = []

beforeEach(() => cleanup.length = 0)
afterEach(() => {
  for (const p of procs.splice(0)) {
    try { p.kill('SIGKILL') } catch {}
  }
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true })
})

type Client = {
  request: (op: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
  events: Array<Record<string, unknown>>
  close: () => void
}

/** Compile the daemon on demand once per suite via electron-vite (already built by QA). */
function daemonEntry(): string {
  const p = process.env['DONWELLS_TERMINAL_DAEMON_ENTRY'] ?? join(projectRoot, 'out', 'main', 'terminal-daemon-entry.js')
  if (!existsSync(p)) throw new Error('daemon entry not built — run electron-vite build first')
  return p
}

function spawnDaemon(userData: string, token: string): ChildProcess {
  const proc = spawn(process.execPath, [daemonEntry(), userData], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DONWELLS_DAEMON_TOKEN: token, ELECTRON_RUN_AS_NODE: '1' }
  })
  procs.push(proc)
  return proc
}

function connectClient(socketPath: string, authToken: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const sock = netConnect(socketPath, () => {
      const events: Array<Record<string, unknown>> = []
      const pending = new Map<string, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>()
      let buf = ''
      let helloDone = false

      const send = (msg: Record<string, unknown>): void => {
        sock.write(JSON.stringify(msg) + '\n')
      }

      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8')
        let nl: number
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          if (!line.trim()) continue
          let msg: Record<string, unknown>
          try { msg = JSON.parse(line) } catch { continue }
          if (!helloDone) {
            if (msg['ok'] === true) {
              helloDone = true
              resolve({
                events,
                request: (op, params = {}) => {
                  const id = Math.random().toString(36).slice(2)
                  return new Promise((res, rej) => {
                    pending.set(id, { resolve: res, reject: rej })
                    send({ id, op, ...params })
                  })
                },
                close: () => sock.destroy()
              })
            } else {
              reject(new Error('hello failed'))
            }
          } else if (msg['event']) {
            events.push(msg)
          } else {
            const p = pending.get(String(msg['id']))
            if (p) {
              pending.delete(String(msg['id']))
              if (msg['ok'] === true) p.resolve(msg)
              else p.reject(new Error(String(msg['error'])))
            }
          }
        }
      })
      sock.on('error', reject)
      // bad-token path: the daemon destroys without replying — treat close as hello failure
      sock.on('close', () => {
        if (!helloDone) reject(new Error('hello failed: connection closed during handshake'))
      })
      send({ id: 'hello', op: 'hello', authToken })
    })
    sock.on('error', reject)
  })
}

async function waitDaemonReady(userData: string, timeoutMs = 10000): Promise<void> {
  const runtimeFile = localRuntimePaths(userData, 'terminal').runtimeFile
  const deadline = Date.now() + timeoutMs
  while (!existsSync(runtimeFile)) {
    if (Date.now() > deadline) throw new Error('daemon runtime metadata never appeared')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function waitUntil(check: () => boolean, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition was not met before timeout')
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }
}

describe('terminal daemon', () => {
  it('reports incomplete retained output after overflow and preserves the flag across reattachment', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'donwells-daemon-truncated-'))
    cleanup.push(userData)
    spawnDaemon(userData, 'truncation-token')
    await waitDaemonReady(userData)
    const client = await connectClient(localRuntimePaths(userData, 'terminal').socketPath, 'truncation-token')
    try {
      const opened = await client.request('job.open', { cwd: userData, command: "printf '%600000s' x" })
      const id = (opened['session'] as { id: string }).id
      await waitUntil(() => client.events.some(event => event['event'] === 'exit' && event['sessionId'] === id))
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await client.request('session.attach', { sessionId: id })
        expect(result['truncated']).toBe(true)
        expect(String(result['scrollback']).length).toBeLessThanOrEqual(512 * 1024)
      }
      await client.request('session.close', { sessionId: id })
      const fresh = await client.request('session.open', { cwd: userData })
      const freshId = (fresh['session'] as { id: string }).id
      expect((await client.request('session.attach', { sessionId: freshId }))['truncated']).toBe(false)
      await client.request('session.close', { sessionId: freshId })
    } finally { client.close() }
  }, 20000)

  it('owns a PTY across client disconnect: data flows, session survives, scrollback replays', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'donwells-daemon-ud-'))
    cleanup.push(userData)
    const { root, path } = makeRepo()
    cleanup.push(root)
    const token = 'test-token-123'
    spawnDaemon(userData, token)
    await waitDaemonReady(userData)

    // client 1: open a session, write a marker
    const c1 = await connectClient(localRuntimePaths(userData, 'terminal').socketPath, token)
    const open = await c1.request('session.open', { cwd: path, cols: 80, rows: 24 })
    const session = open['session'] as { id: string }
    expect(session.id).toBeTruthy()
    c1.request('session.write', { sessionId: session.id, data: 'echo DAEMON_MARKER_42\r' }).catch(() => {})
    // PTY echo latency is external-process-bound; bounded poll on the events we receive
    const sawMarker = await new Promise<boolean>((resolve) => {
      const start = Date.now()
      const check = (): void => {
        const joined = c1.events.filter((e) => e['event'] === 'data' && e['sessionId'] === session.id).map((e) => String(e['data'])).join('')
        if (joined.includes('DAEMON_MARKER_42')) return resolve(true)
        if (Date.now() - start > 5000) return resolve(false)
        setTimeout(check, 100)
      }
      check()
    })
    expect(sawMarker).toBe(true)
    c1.close()

    // client 2 (fresh connection — simulates app restart reattach): attach replays scrollback
    const c2 = await connectClient(localRuntimePaths(userData, 'terminal').socketPath, token)
    const attach = await c2.request('session.attach', { sessionId: session.id })
    const sb = String(attach['scrollback'] ?? '')
    expect(sb).toContain('DAEMON_MARKER_42')

    // session still alive: write works from the new client
    await c2.request('session.write', { sessionId: session.id, data: 'echo SECOND_MARKER\r' })
    const sawSecond = await new Promise<boolean>((resolve) => {
      const start = Date.now()
      const check = (): void => {
        const joined = c2.events.filter((e) => e['event'] === 'data' && e['sessionId'] === session.id).map((e) => String(e['data'])).join('')
        if (joined.includes('SECOND_MARKER')) return resolve(true)
        if (Date.now() - start > 5000) return resolve(false)
        setTimeout(check, 100)
      }
      check()
    })
    expect(sawSecond).toBe(true)
    c2.close()
  }, 20000)

  it('rejects a wrong auth token (handshake fails closed)', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'donwells-daemon-ud2-'))
    cleanup.push(userData)
    const proc = spawnDaemon(userData, 'right-token')
    await waitDaemonReady(userData)
    await expect(connectClient(localRuntimePaths(userData, 'terminal').socketPath, 'wrong-token')).rejects.toThrow(/hello/)
    proc.kill('SIGKILL')
  })


  it('closing the last session clears scrollback and permits prompt daemon shutdown', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'donwells-daemon-ud3-'))
    cleanup.push(userData)
    const { root, path } = makeRepo()
    cleanup.push(root)
    const token = 'tok-3'
    const proc = spawnDaemon(userData, token)
    await waitDaemonReady(userData)
    const c = await connectClient(localRuntimePaths(userData, 'terminal').socketPath, token)
    const open = await c.request('session.open', { cwd: path })
    const session = open['session'] as { id: string }
    const list = await c.request('session.list')
    expect((list['sessions'] as Array<{ id: string }>).some((s) => s.id === session.id)).toBe(true)
    await c.request('session.close', { sessionId: session.id })
    const attach = await c.request('session.attach', { sessionId: session.id }).catch((e) => ({ error: String(e) }))
    expect(attach['error']).toBeTruthy()
    expect((await c.request('daemon.shutdown'))['stopped']).toBe(true)
    await expect.poll(() => proc.exitCode, { timeout: 2000 }).toBe(0)
    c.close()
  })

  it('runs finite jobs with sequenced bounded output, real exits, sanitized env, and cancellation', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'donwells-daemon-jobs-'))
    cleanup.push(userData)
    const { root, path } = makeRepo()
    cleanup.push(root)
    const token = 'job-secret-token'
    spawnDaemon(userData, token)
    await waitDaemonReady(userData)

    const client = await connectClient(localRuntimePaths(userData, 'terminal').socketPath, token)
    const opened = await client.request('job.open', {
      cwd: path,
      command: 'printf \'TOKEN=<%s> NODE=<%s>\\n\' "$DONWELLS_DAEMON_TOKEN" "$ELECTRON_RUN_AS_NODE"; exit 7'
    })
    const job = opened['session'] as { id: string }
    await waitUntil(() => client.events.some((event) => event['event'] === 'exit' && event['sessionId'] === job.id))
    const result = await client.request('job.result', { sessionId: job.id })
    expect(result['exited']).toBe(true)
    expect(result['exitCode']).toBe(7)
    expect(String(result['output'])).toContain('TOKEN=<> NODE=<>')
    expect(Number(result['sequence'])).toBeGreaterThan(0)
    const dataEvents = client.events.filter((event) => event['event'] === 'data' && event['sessionId'] === job.id)
    expect(dataEvents.every((event) => Number.isSafeInteger(event['sequence']))).toBe(true)

    const marker = join(root, 'must-not-exist')
    const cancellable = await client.request('job.open', {
      cwd: path,
      command: 'sleep 2; printf late > ' + JSON.stringify(marker)
    })
    const cancelJob = cancellable['session'] as { id: string }
    await client.request('session.close', { sessionId: cancelJob.id })
    await new Promise<void>((resolve) => setTimeout(resolve, 2200))
    expect(existsSync(marker)).toBe(false)
    await expect(client.request('job.result', { sessionId: cancelJob.id })).rejects.toThrow(/unknown job/)
    client.close()
  }, 20000)

  it('keeps a finite job authoritative across client disconnect', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'donwells-daemon-detached-job-'))
    cleanup.push(userData)
    const { root, path } = makeRepo()
    cleanup.push(root)
    const token = 'detached-job-token'
    spawnDaemon(userData, token)
    await waitDaemonReady(userData)

    const first = await connectClient(localRuntimePaths(userData, 'terminal').socketPath, token)
    const opened = await first.request('job.open', {
      cwd: path,
      command: "sleep 1; printf 'DETACHED_DONE\\n'; exit 3"
    })
    const job = opened['session'] as { id: string }
    first.close()
    await new Promise<void>((resolve) => setTimeout(resolve, 1500))

    const second = await connectClient(localRuntimePaths(userData, 'terminal').socketPath, token)
    const result = await second.request('job.result', { sessionId: job.id })
    expect(result['exited']).toBe(true)
    expect(result['exitCode']).toBe(3)
    expect(String(result['output'])).toContain('DETACHED_DONE')
    second.close()
  }, 20000)
})
