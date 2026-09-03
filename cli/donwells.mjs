#!/usr/bin/env node
/**
 * donwells.ai CLI (upstream §7.9 command-spec model, lite surface):
 *   donwells <method> [args] [--user-data <dir>] [--text]
 *
 * Transport: NDJSON over the app's unix socket, discovered via
 * <userData>/orca-runtime.json (auth token handshake). Envelope:
 *   {id, ok, result|error, _meta}
 * Exit 0 on ok, 1 on error.
 *
 * Method shortcuts (command-spec style):
 *   status, repo-list, repo-add <dir>, repo-remove <id>,
 *   wt-create <repoId> [name] [--branch <b>], wt-remove <repoId> <path> [--force],
 *   term-open <cwd>, term-write <sessionId> <data>, term-list, term-close <id>,
 *   git-status <worktreePath>, settings-get, settings-set <json>, meta,
 *   browser-list, browser-open <worktreePath> <url>, browser-navigate <key> <url>,
 *   browser-snapshot <key>, browser-eval <key> '<js>', browser-back|forward|reload <key>,
 *   ui-state, ui-activate <worktreePath|repoId>, ui-terminal <worktreePath>, ui-split <worktreePath>,
 *   ui-focus <worktreePath> <key>, ui-close-pane <worktreePath> <key>, ui-resize <worktreePath> <splitId> <pct>,
 *   ui-preview <worktreePath> <relPath>, ui-preview-close <worktreePath>,
 *   ui-sidebar <left|right> [open|close|toggle] [explorer|git] [width],
 *   ui-floating [open|close|toggle], ui-palette [open|close|toggle], ui-settings [section]
 */
import { createConnection } from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const METHOD_MAP = {
  status: 'status.get',
  'repo-list': 'repo.list',
  'repo-add': 'repo.add',
  'repo-remove': 'repo.remove',
  'wt-create': 'worktree.create',
  'wt-remove': 'worktree.remove',
  'term-open': 'terminal.open',
  'term-write': 'terminal.write',
  'term-list': 'terminal.list',
  'term-close': 'terminal.close',
  'git-status': 'git.status',
  'browser-list': 'browser.list',
  'browser-open': 'browser.open',
  'browser-navigate': 'browser.navigate',
  'browser-snapshot': 'browser.snapshot',
  'browser-eval': 'browser.eval',
  'browser-back': 'browser.back',
  'browser-forward': 'browser.forward',
  'browser-reload': 'browser.reload',
  'ui-state': 'ui.state',
  'ui-activate': 'ui.activate',
  'ui-terminal': 'ui.terminal.open',
  'ui-split': 'ui.split',
  'ui-focus': 'ui.pane.focus',
  'ui-close-pane': 'ui.pane.close',
  'ui-resize': 'ui.pane.resize',
  'ui-preview': 'ui.preview.open',
  'ui-preview-close': 'ui.preview.close',
  'ui-sidebar': 'ui.sidebar',
  'ui-floating': 'ui.floating',
  'ui-palette': 'ui.palette',
  'ui-settings': 'ui.settings.open',
  'settings-get': 'settings.get',
  'settings-set': 'settings.set',
  meta: 'meta.get'
}

function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else {
      positional.push(a)
    }
  }
  const method = positional[0] ?? ''
  const rest = positional.slice(1)
  const params = {}
  if (rest[0] !== undefined && rest[0].startsWith('{')) {
    try { Object.assign(params, JSON.parse(rest[0])) } catch { params._raw = rest[0] }
  } else {
    if (rest[0] !== undefined) params.a0 = rest[0]
    if (rest[1] !== undefined) params.a1 = rest[1]
    if (rest[2] !== undefined) params.a2 = rest[2]
    if (rest[3] !== undefined) params.a3 = rest[3]
  }
  return { method, params, flags }
}

function runtimePath(flags) {
  const dir = typeof flags['user-data'] === 'string'
    ? flags['user-data']
    : process.env.DONWELLS_USER_DATA
      ?? join(homedir(), 'Library', 'Application Support', 'donwells.ai')
  return join(dir, 'donwells-runtime.json')
}

function remapParams(method, params, flags) {
  const p = params
  if (method === 'repo.add' && p.a0) { p.dir = p.a0 }
  if (method === 'repo.remove' && p.a0) { p.repoId = p.a0 }
  if (method === 'worktree.create' && p.a0) {
    p.repoId = p.a0
    if (p.a1) p.name = p.a1
    if (flags.branch) p.branch = flags.branch
  }
  if (method === 'worktree.remove' && p.a0) {
    p.repoId = p.a0
    if (p.a1) p.worktreePath = p.a1
    if (flags.force === true) p.force = true
  }
  if (method === 'terminal.open' && p.a0) { p.cwd = p.a0 }
  if (method === 'terminal.write' && p.a0) {
    p.sessionId = p.a0
    if (p.a1) p.data = p.a1
  }
  if (method === 'terminal.close' && p.a0) { p.sessionId = p.a0 }
  if (method === 'git.status' && p.a0) { p.worktreePath = p.a0 }
  if (method === 'browser.open' && p.a0) {
    p.worktreePath = p.a0
    if (p.a1) p.url = p.a1
  }
  if (method === 'browser.navigate' && p.a0) {
    p.key = p.a0
    if (p.a1) p.url = p.a1
  }
  if (method === 'browser.eval' && p.a0) {
    p.key = p.a0
    if (p.a1) p.js = p.a1
  }
  if (['browser.snapshot', 'browser.back', 'browser.forward', 'browser.reload'].includes(method) && p.a0) { p.key = p.a0 }
  if (method === 'ui.activate' && p.a0) {
    if (String(p.a0).startsWith('/')) p.worktreePath = p.a0
    else p.repoId = p.a0
  }
  if (['ui.terminal.open', 'ui.split', 'ui.preview.close'].includes(method) && p.a0) { p.worktreePath = p.a0 }
  if (['ui.pane.focus', 'ui.pane.close'].includes(method) && p.a0) {
    p.worktreePath = p.a0
    if (p.a1) p.key = p.a1
  }
  if (method === 'ui.pane.resize' && p.a0) {
    p.worktreePath = p.a0
    if (p.a1 !== undefined) p.splitId = Number(p.a1)
    if (p.a2 !== undefined) p.pct = Number(p.a2)
  }
  if (method === 'ui.preview.open' && p.a0) {
    p.worktreePath = p.a0
    if (p.a1) p.relPath = p.a1
  }
  if (method === 'ui.sidebar' && p.a0) {
    p.side = p.a0
    const openWords = { open: true, close: false, toggle: 'toggle' }
    for (const a of [p.a1, p.a2, p.a3]) {
      if (a === undefined) continue
      if (a in openWords) p.open = openWords[a]
      else if (a === 'explorer' || a === 'git') p.tab = a
      else if (!Number.isNaN(Number(a))) p.width = Number(a)
    }
  }
  if (method === 'ui.floating' && p.a0) { p.action = p.a0 }
  if (method === 'ui.palette' && p.a0) { p.open = p.a0 }
  if (method === 'ui.settings.open' && p.a0) { p.section = p.a0 }
  for (const k of ['a0', 'a1', 'a2', 'a3']) delete p[k]
  return p
}

async function main() {
  const { method: short, params, flags } = parseArgs(process.argv.slice(2))
  if (!short || short === 'help' || flags.help === true) {
    console.log('usage: donwells <method> [args] [--user-data <dir>] [--text]')
    console.log('methods: ' + Object.keys(METHOD_MAP).join(', '))
    return 0
  }
  const method = METHOD_MAP[short] ?? short
  const params2 = remapParams(method, params, flags)
  const rtFile = runtimePath(flags)
  if (!existsSync(rtFile)) {
    console.log(JSON.stringify({ id: randomUUID(), ok: false, error: `runtime not found at ${rtFile} — is the app running?`, _meta: { ts: Date.now() } }))
    return 1
  }
  let rt
  try {
    rt = JSON.parse(readFileSync(rtFile, 'utf8'))
  } catch (e) {
    console.log(JSON.stringify({ id: randomUUID(), ok: false, error: `runtime file unreadable: ${e.message}`, _meta: { ts: Date.now() } }))
    return 1
  }

  return await new Promise((resolve) => {
    const id = randomUUID()
    const sock = createConnection(rt.socketPath, () => {
      sock.write(JSON.stringify({ id, method: 'auth.hello', authToken: rt.authToken }) + '\n')
    })
    let buf = ''
    let helloed = false
    const done = (envelope) => {
      console.log(flags.text === true && envelope.ok ? JSON.stringify(envelope.result, null, 2) : JSON.stringify(envelope, null, 2))
      sock.destroy()
      resolve(envelope.ok ? 0 : 1)
    }
    const fail = (error) => done({ id, ok: false, error, _meta: { ts: Date.now(), method } })
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        if (!helloed) {
          if (msg.ok !== true) return fail('auth failed')
          helloed = true
          sock.write(JSON.stringify({ id, method, params: params2 }) + '\n')
          continue
        }
        done({
          id,
          ok: msg.ok === true,
          ...(msg.ok === true ? { result: msg.result } : { error: String(msg.error ?? 'unknown') }),
          _meta: { ts: Date.now(), method }
        })
        return
      }
    })
    sock.on('error', (e) => fail(`connect failed: ${e.message}`))
    sock.on('close', () => { if (!helloed) fail('connection closed during handshake') })
    setTimeout(() => { if (!helloed || buf) fail('timeout waiting for response') }, 15000)
  })
}

main().then((code) => process.exit(code))