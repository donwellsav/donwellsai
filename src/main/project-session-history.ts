import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SessionHistorySource } from '@shared/project-session-history'
import type { ChildProcess } from 'node:child_process'
import { isObject } from '@shared/command-catalog'
import { spawnProcess } from '@shared/child-process/run-process'
import { forceTerminateProcessTree } from '@shared/child-process/process-tree-termination'
import type { ProjectSearchHit, ProjectToolScope } from '@shared/project-tools'

export const SESSION_HISTORY_VERSION = 'agentsview-0.42.0'
const BINARY_SHA256 = '7bfa30b671bd0aa497b18cf639f95c9f2499a70a14ed03c704f4d15f9b61bd88'
export const SESSION_HISTORY_CAPABILITIES = {
  omp: 'Nested native sessions; explicit session resume',
  'deepseek-harness': 'Native compressed UUID sessions; explicit TUI resume',
  hermes: 'Unavailable: AgentsView 0.42.0 omits the native working directory',
  kimi: 'Unavailable: this Kimi wire format does not expose cwd to AgentsView 0.42.0'
}

type Row = Record<string, unknown>
type HistoryOptions = { binary: string; cache: string; roots: { omp: string[]; 'deepseek-harness': string[] } }

/** Derived archive only. The admitted native engine owns parsing/FTS; app reads its SQLite archive. */
export class ProjectSessionHistory {
  private queue = new Map<string, Promise<unknown>>()
  private children = new Set<ChildProcess>()
  private closed = false
  constructor(private options: HistoryOptions, private resolveScope: (path: string) => Promise<ProjectToolScope>) {}

  private async bound(path: string) {
    if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\0')) throw new Error('Invalid history workspace')
    if (this.closed) throw new Error('Session history is shutting down')
    const scope = await this.resolveScope(path)
    return { scope, directory: join(this.options.cache, scope.indexKey, SESSION_HISTORY_VERSION) }
  }

  private async assertScope(path: string, scope: ProjectToolScope) {
    const current = await this.resolveScope(path)
    if (this.closed || current.indexKey !== scope.indexKey || current.projectKey !== scope.projectKey) throw new Error('Session history scope changed')
  }

  async index(path: string): Promise<{ indexedAt: string; capabilities: typeof SESSION_HISTORY_CAPABILITIES }> {
    const { scope, directory } = await this.bound(path)
    const existing = this.queue.get(scope.indexKey)
    if (existing) throw new Error('Session indexing is already running')
    const operation = this.rebuild(path, scope, directory)
    this.queue.set(scope.indexKey, operation)
    try { return await operation } finally { this.queue.delete(scope.indexKey) }
  }

  private async rebuild(path: string, scope: ProjectToolScope, directory: string) {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(this.options.binary)) hash.update(chunk)
    if (hash.digest('hex') !== BINARY_SHA256) throw new Error('Session history requires the admitted AgentsView 0.42.0 binary')
    await mkdir(join(directory, 'home'), { recursive: true, mode: 0o700 })
    const roots = async (values: string[]) => Promise.all(values.map(value => realpath(value)))
    const prefixes = new Set([resolve(path), scope.checkoutPath, scope.projectPath])
    for (const prefix of [...prefixes]) {
      const alias = prefix.startsWith('/private/') ? prefix.slice('/private'.length) : null
      if (process.platform === 'darwin' && alias && await realpath(alias).catch(() => null) === prefix) prefixes.add(alias)
    }
    const config = {
      disable_update_check: true,
      sync_include_cwd_prefixes: [...prefixes],
      omp_dirs: await roots(this.options.roots.omp),
      deepseek_harness_sessions_dirs: await roots(this.options.roots['deepseek-harness'])
    }
    await writeFile(join(directory, 'config.toml'), Object.entries(config).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600 })
    await this.assertScope(path, scope)
    await rm(join(directory, 'receipt.json'), { force: true })
    const token = randomBytes(32).toString('hex')
    // Isolated HOME prevents native engine defaults from discovering other providers or user configuration.
    const child = spawnProcess({ program: this.options.binary, args: ['serve', '--no-sync', '--no-browser', '--port', '0', '--require-auth'], cwd: scope.checkoutPath, env: { PATH: process.env.PATH, HOME: join(directory, 'home'), AGENTSVIEW_DATA_DIR: directory, AGENTSVIEW_AUTH_TOKEN: token }, detached: true })
    this.children.add(child)
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let output = ''
        const timer = setTimeout(() => reject(new Error('History engine readiness timed out')), 10000)
        child.once('error', reject)
        child.once('exit', () => { clearTimeout(timer); reject(new Error('History engine exited before ready')) })
        child.stdout?.on('data', chunk => {
          output = (output + chunk.toString()).slice(-16000)
          const match = /listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(output)
          if (match) { clearTimeout(timer); resolve(match[1]!) }
        })
        child.stderr?.resume()
      })
      await this.assertScope(path, scope)
      const response = await fetch(url + '/api/v1/resync', { method: 'POST', headers: { Authorization: 'Bearer ' + token, Origin: url, Accept: 'application/json' }, signal: AbortSignal.timeout(120000) })
      let body = ''
      if (!response.body) throw new Error('History indexing returned no response')
      for await (const chunk of response.body) {
        body += Buffer.from(chunk).toString('utf8')
        if (Buffer.byteLength(body) > 1024 * 1024) throw new Error('History index progress exceeded limit')
      }
      if (!response.ok || /event: error/.test(body)) throw new Error('History indexing failed')
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        if (!/event: done/.test(body)) throw new Error('History indexing ended without completion')
      } else if (!isObject(JSON.parse(body))) throw new Error('Invalid history index response')
      await this.assertScope(path, scope)
      if (!await forceTerminateProcessTree(child)) throw new Error('History engine termination could not be verified')
      this.children.delete(child)
      // The engine's prefix filter also accepts nested projects; publish only the selected registered roots.
      const db = new DatabaseSync(join(directory, 'sessions.db'))
      try {
        db.exec('PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON')
        db.prepare(`DELETE FROM sessions WHERE cwd IS NULL OR cwd NOT IN (${[...prefixes].map(() => '?').join(',')})`).run(...prefixes)
      } finally { db.close() }
      await this.assertScope(path, scope)
      const indexedAt = new Date().toISOString()
      await writeFile(join(directory, 'receipt.json'), JSON.stringify({ version: SESSION_HISTORY_VERSION, indexedAt, indexKey: scope.indexKey }), { mode: 0o600 })
      return { indexedAt, capabilities: SESSION_HISTORY_CAPABILITIES }
    } finally {
      if (this.children.has(child)) {
        if (!await forceTerminateProcessTree(child)) throw new Error('History engine termination could not be verified')
        this.children.delete(child)
      }
    }
  }

  private async archive(path: string) {
    const { scope, directory } = await this.bound(path)
    if (this.queue.has(scope.indexKey)) throw new Error('Session indexing is running')
    const receipt: unknown = JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8'))
    if (!isObject(receipt) || receipt.version !== SESSION_HISTORY_VERSION || receipt.indexKey !== scope.indexKey || typeof receipt.indexedAt !== 'string') throw new Error('Session history must be indexed for this parser version')
    return { scope, directory, indexedAt: receipt.indexedAt }
  }

  private async current(row: Row, scope: ProjectToolScope): Promise<boolean> {
    if (typeof row.cwd !== 'string' || typeof row.file_path !== 'string' || !['omp', 'deepseek-harness'].includes(String(row.agent))) return false
    try {
      const sourceScope = await this.resolveScope(row.cwd)
      if (sourceScope.projectKey !== scope.projectKey) return false
      const file = await lstat(row.file_path, { bigint: true })
      return file.isFile() && file.size.toString() === String(row.file_size) && file.mtimeNs.toString() === String(row.source_mtime)
    } catch { return false }
  }

  async search(path: string, query: string): Promise<{ hits: ProjectSearchHit[]; truncated: boolean; capabilities: typeof SESSION_HISTORY_CAPABILITIES }> {
    if (typeof query !== 'string' || !query.trim() || query.length > 512) throw new Error('Session query must contain 1–512 characters')
    const { scope, directory, indexedAt } = await this.archive(path)
    const db = new DatabaseSync(join(directory, 'sessions.db'), { readOnly: true })
    let rows: Row[]
    try {
      rows = db.prepare(`SELECT s.id,s.agent,s.cwd,s.file_path,s.file_size,CAST(s.file_mtime AS TEXT) AS source_mtime,s.transcript_revision,m.ordinal,substr(m.content,1,600) AS excerpt,coalesce(s.session_name,s.display_name,s.first_message,s.id) AS title FROM messages_fts f JOIN messages m ON m.id=f.rowid JOIN sessions s ON s.id=m.session_id WHERE messages_fts MATCH ? AND s.deleted_at IS NULL AND s.source_missing_at IS NULL AND m.is_system=0 AND m.role IN ('user','assistant') ORDER BY rank LIMIT 101`).all('"' + query.replaceAll('"', '""') + '"')
    } finally { db.close() }
    const hits: ProjectSearchHit[] = []
    for (const row of rows.slice(0, 100)) {
      if (!await this.current(row, scope)) continue
      hits.push({ source: 'session', id: `session:${scope.indexKey}:${encodeURIComponent(String(row.id))}:${row.ordinal}`, title: `${row.agent} · ${String(row.title).slice(0, 160)}`, excerpt: String(row.excerpt), path: null, line: Number(row.ordinal) + 1, revision: String(row.transcript_revision), indexedAt, stale: false })
    }
    await this.assertScope(path, scope)
    return { hits, truncated: rows.length > 100, capabilities: SESSION_HISTORY_CAPABILITIES }
  }

  async get(path: string, id: string): Promise<SessionHistorySource> {
    const { scope, directory, indexedAt } = await this.archive(path)
    const prefix = `session:${scope.indexKey}:`
    if (typeof id !== 'string' || !id.startsWith(prefix) || id.length > 2048) throw new Error('Session belongs to another checkout')
    const split = id.lastIndexOf(':'), ordinal = Number(id.slice(split + 1)), nativeId = decodeURIComponent(id.slice(prefix.length, split))
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new Error('Invalid session message')
    const db = new DatabaseSync(join(directory, 'sessions.db'), { readOnly: true })
    let row: Row | undefined, messages: Row[]
    try {
      row = db.prepare('SELECT id,agent,cwd,file_path,file_size,CAST(file_mtime AS TEXT) AS source_mtime FROM sessions WHERE id=? AND deleted_at IS NULL AND source_missing_at IS NULL').get(nativeId)
      messages = db.prepare("SELECT ordinal,role,substr(content,1,12000) AS content FROM messages WHERE session_id=? AND ordinal BETWEEN ? AND ? AND is_system=0 AND role IN ('user','assistant') ORDER BY ordinal").all(nativeId, Math.max(0, ordinal - 2), ordinal + 2)
    } finally { db.close() }
    if (!row || !await this.current(row, scope)) throw new Error('Original session is missing, changed, or outside this project. Refresh session history.')
    await this.assertScope(path, scope)
    const dshId = /^deepseek-harness:session-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(nativeId)?.[1]
    return { id, agent: String(row.agent), nativeId, source: String(row.file_path), cwd: String(row.cwd), indexedAt, resume: row.agent === 'omp' ? { executable: 'omp', args: ['--resume', String(row.file_path)] } : row.agent === 'deepseek-harness' && dshId ? { executable: 'dsh', args: ['--profile', 'tui', '--resume', dshId] } : null, messages: messages.map(message => ({ ordinal: Number(message.ordinal), role: String(message.role), content: String(message.content) })), untrusted: true }
  }

  async isIndexing(path: string): Promise<boolean> { return this.queue.has((await this.bound(path)).scope.indexKey) }

  async close(): Promise<void> {
    this.closed = true
    const stopped = await Promise.all([...this.children].map(child => forceTerminateProcessTree(child)))
    if (stopped.some(ok => !ok)) throw new Error('History engine shutdown could not be verified')
    await Promise.allSettled(this.queue.values())
  }
}
