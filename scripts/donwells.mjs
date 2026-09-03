#!/usr/bin/env node
/**
 * donwells CLI — drives the running app over its runtime RPC socket.
 * Agents running in worktree terminals use this to control the app's
 * embedded browser and inspect pages.
 *
 * Discovery: <userData>/donwells-runtime.json = { socketPath, authToken }
 * (userData is /tmp/donwells-qa-style app data dir; DONWELLS_USER_DATA env
 * overrides when the app was launched with it).
 *
 * Usage:
 *   donwells.mjs browser list
 *   donwells.mjs browser open <worktreePath> <url>
 *   donwells.mjs browser navigate <key> <url>
 *   donwells.mjs browser snapshot <key>      # {url, title, text}
 *   donwells.mjs browser eval <key> '<js>'
 *   donwells.mjs browser back|forward|reload <key>
 *   donwells.mjs terminal list
 */
import { connect } from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

const userData = process.env.DONWELLS_USER_DATA ?? join(homedir(), 'Library', 'Application Support', 'donwells.ai')
const runtimeFile = join(userData, 'donwells-runtime.json')

/** One NDJSON RPC call: auth.hello handshake, then the domain method. */
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    let rt
    try {
      rt = JSON.parse(readFileSync(runtimeFile, 'utf8'))
    } catch {
      reject(new Error(`no running app (${runtimeFile} unreadable)`))
      return
    }
    const socket = connect(rt.socketPath)
    const id = randomUUID()
    let buf = ''
    let stage = 'hello'
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('rpc timeout'))
    }, 15000)
    const send = (obj) => socket.write(JSON.stringify(obj) + '\n')
    socket.on('connect', () => {
      // protocol requires auth.hello before any domain call
      send({ id: 'hello', authToken: rt.authToken, method: 'auth.hello' })
    })
    socket.on('data', (d) => {
      buf += d.toString()
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        const msg = JSON.parse(line)
        if (stage === 'hello') {
          if (!msg.ok) {
            clearTimeout(timer)
            socket.destroy()
            reject(new Error('auth failed'))
            return
          }
          stage = 'call'
          send({ id, authToken: rt.authToken, method, params })
          continue
        }
        clearTimeout(timer)
        socket.destroy()
        if (msg.id !== id) continue
        if (msg.ok) resolve(msg.result)
        else reject(new Error(msg.error ?? 'rpc error'))
      }
    })
    socket.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

const [domain, action, ...rest] = process.argv.slice(2)

try {
  if (domain === 'browser') {
    const key = rest[0]
    switch (action) {
      case 'list': {
        const { panes } = await rpc('browser.list')
        console.log(panes.length ? panes.join('\n') : '(no browser panes open)')
        break
      }
      case 'open': {
        const [wt, url] = rest
        const { snapshot } = await rpc('browser.open', { worktreePath: wt, url })
        console.log(JSON.stringify(snapshot, null, 1))
        break
      }
      case 'navigate': {
        const [, url] = rest
        console.log(JSON.stringify(await rpc('browser.navigate', { key, url }), null, 1))
        break
      }
      case 'snapshot': {
        const { snapshot } = await rpc('browser.snapshot', { key })
        console.log(JSON.stringify(snapshot, null, 1))
        break
      }
      case 'eval': {
        const [, js] = rest
        console.log(JSON.stringify(await rpc('browser.eval', { key, js }), null, 1))
        break
      }
      case 'back':
      case 'forward':
      case 'reload':
        console.log(JSON.stringify(await rpc(`browser.${action}`, { key }), null, 1))
        break
      default:
        throw new Error(`unknown browser action: ${action ?? '(none)'}`)
    }
  } else if (domain === 'terminal' && action === 'list') {
    const { sessions } = await rpc('terminal.list')
    console.log(JSON.stringify(sessions, null, 1))
  } else if (domain === 'meta') {
    console.log(JSON.stringify(await rpc('meta.get'), null, 1))
  } else {
    throw new Error('usage: donwells.mjs <browser|terminal|meta> ...')
  }
} catch (e) {
  console.error('donwells:', e instanceof Error ? e.message : e)
  process.exit(1)
}
