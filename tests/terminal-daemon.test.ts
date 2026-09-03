import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect as netConnect } from 'node:net'

/**
 * Daemon e2e against the REAL compiled daemon: spawn entry, NDJSON over the
 * unix socket, PTY open/write/scrollback/attach, restart-survival semantics.
 * Real timers only where the PTY itself is asynchronous (comments note why).
 */

const projectRoot = join(import.meta.dirname, '..')

function sh(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd })
}

function makeRepo(): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'orca-daemon-'))
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
  sock: ReturnType<typeof createConnection>
  request: (op: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
  events: Array<Record<string, unknown>>
  close: () => void
}

/** Compile the daemon on demand once per suite via electron-vite (already built by QA). */
function daemonEntry(): string {
  const p = join(projectRoot, 'out', 'main', 'terminal-daemon-entry.js')
  if (!existsSync(p)) throw new Error('daemon entry not built — run electron-vite build first')
  return p
}

function spawnDaemon(userData: string, token: string): ChildProcess {
  const proc = spawn(process.execPath, [daemonEntry(), userData], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ORCA_LITE_DAEMON_TOKEN: token, ELECTRON_RUN_AS_NODE: '1' }
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

      const send = (msg: Record<string, unknown>): void => sock.write(JSON.stringify(msg) + '\n')

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
                sock,
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
  const sock = join(userData, 'terminal.sock')
  const deadline = Date.now() + timeoutMs
  while (!existsSync(sock)) {
    if (Date.now() > deadline) throw new Error('daemon socket never appeared')
    await new Promise((r) => setTimeout(r, 50)) // filesystem poll for external process bind — no event to await
  }
}

describe('terminal daemon', () => {
  it('owns a PTY across client disconnect: data flows, session survives, scrollback replays', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'orca-daemon-ud-'))
    cleanup.push(userData)
    const { root, path } = makeRepo()
    cleanup.push(root)
    const token = 'test-token-123'
    const proc = spawnDaemon(userData, token)
    await waitDaemonReady(userData)

    // client 1: open a session, write a marker
    const c1 = await connectClient(join(userData, 'terminal.sock'), token)
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
    const c2 = await connectClient(join(userData, 'terminal.sock'), token)
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
    const userData = mkdtempSync(join(tmpdir(), 'orca-daemon-ud2-'))
    cleanup.push(userData)
    const proc = spawnDaemon(userData, 'right-token')
    await waitDaemonReady(userData)
    await expect(connectClient(join(userData, 'terminal.sock'), 'wrong-token')).rejects.toThrow(/hello/)
    proc.kill('SIGKILL')
  })

  it('strips agent hook envelopes from data and emits separate hook events', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'orca-daemon-ud4-'))
    cleanup.push(userData)
    const { root, path } = makeRepo()
    cleanup.push(root)
    const token = 'hook-token'
    const proc = spawnDaemon(userData, token)
    await waitDaemonReady(userData)
    const c = await connectClient(join(userData, 'terminal.sock'), token)
    const open = await c.request('session.open', { cwd: path, cols: 80, rows: 24 })
    const session = open['session'] as { id: string }
    // the shell must EMIT the envelopes (daemon scans PTY output, not input)
    c.request('session.write', {
      sessionId: session.id,
      data: "printf 'BEFORE\\033]777;donwells:done\\007\\033]777;donwells:permission=stage1\\007AFTER\\n'\r"
    }).catch(() => {})
    const res = await new Promise<{ hook: Array<Record<string, unknown>>; clean: boolean }>((resolve) => {
      const start = Date.now()
      const check = (): void => {
        const hooks = c.events.filter((e) => e['event'] === 'hook' && e['sessionId'] === session.id)
        const datas = c.events.filter((e) => e['event'] === 'data' && e['sessionId'] === session.id).map((e) => String(e['data'])).join('')
        if (hooks.length >= 2 && datas.includes('AFTER')) {
          // the echoed command text contains the literal words; raw ESC envelopes must not leak
          resolve({ hook: hooks, clean: datas.includes('BEFORE') && !datas.includes('\x1b]777') })
          return
        }
        if (Date.now() - start > 6000) return resolve({ hook: hooks, clean: false })
        setTimeout(check, 100)
      }
      check()
    })
    expect(res.hook.length).toBeGreaterThanOrEqual(2)
    const states = res.hook.map((h) => String(h['state']))
    expect(states).toContain('done')
    expect(states).toContain('permission')
    expect(res.hook.some((h) => String(h['detail']) === 'stage1')).toBe(true)
    expect(res.clean).toBe(true)
    c.close()
  }, 20000)

  it('session.list reflects opened sessions; close clears scrollback', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'orca-daemon-ud3-'))
    cleanup.push(userData)
    const { root, path } = makeRepo()
    cleanup.push(root)
    const token = 'tok-3'
    const proc = spawnDaemon(userData, token)
    await waitDaemonReady(userData)
    const c = await connectClient(join(userData, 'terminal.sock'), token)
    const open = await c.request('session.open', { cwd: path })
    const session = open['session'] as { id: string }
    const list = await c.request('session.list')
    expect((list['sessions'] as Array<{ id: string }>).some((s) => s.id === session.id)).toBe(true)
    await c.request('session.close', { sessionId: session.id })
    const attach = await c.request('session.attach', { sessionId: session.id }).catch((e) => ({ error: String(e) }))
    expect(attach['error']).toBeTruthy()
    c.close()
  })
})