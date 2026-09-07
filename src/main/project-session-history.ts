import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, type Dirent } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SessionHistorySource, SessionHistoryAnalytics, SessionAnalyticsOptions, SessionAnalyticsProgress, SessionHistoryPage } from '@shared/project-session-history'
import { aggregateSessionHistory, duckdbSessionHistory } from './project-analytics'
import type { ChildProcess } from 'node:child_process'
import { isObject } from '@shared/command-catalog'
import { spawnProcess } from '@shared/child-process/run-process'
import { forceTerminateProcessTree } from '@shared/child-process/process-tree-termination'
import type { ProjectSearchHit, ProjectToolScope } from '@shared/project-tools'

export const SESSION_HISTORY_VERSION = 'agentsview-0.42.0-donwells-cwd3'
export const SESSION_HISTORY_BINARY_SHA256 = '1c9365fd70b3bca35ff1997dfb1fcebc06bb0804d95d9a6401af9583a53af05a'
export const SESSION_HISTORY_CAPABILITIES = {
  omp: 'AgentsView 0.42.0 parser; project from native cwd; parent/helper identity preserved; exact source resume',
  'deepseek-harness': 'AgentsView 0.42.0 parser; project from native cwd; parent/helper identity preserved; exact UUID resume',
  hermes: 'AgentsView 0.42.0 + Donwells cwd3 patch; native state.db cwd attribution and aggregate freshness; parent/helper identity preserved; exact native-ID resume',
  kimi: 'AgentsView 0.42.0 + Donwells cwd3 patch; explicit workspace roots and validated native state.json identity/cwd with wire fallback; parent/helper identity preserved; exact native-ID resume'
}

type Row = Record<string, unknown>
type SourceFingerprint = { size:string; mtime:string }
type HistoryOptions = { analyticsPython?: string; binary: string; cache: string; roots: { omp: string[]; 'deepseek-harness': string[]; hermes?: string[]; kimi?: string[] } }
const supportedAgents = ['omp', 'deepseek-harness', 'hermes', 'kimi']
const helperSession = (row: Row) => Boolean(typeof row.parent_session_id === 'string' && row.parent_session_id || /helper|subagent/i.test(`${row.relationship_type ?? ''} ${row.session_kind ?? ''}`))
const disabledProviderRoots = Object.fromEntries([
  'amp_dirs', 'antigravity_dirs', 'antigravity_cli_dirs', 'claude_project_dirs', 'codebuff_dirs', 'codex_sessions_dirs',
  'copilot_dirs', 'cursor_ide_dirs', 'cursor_project_dirs', 'deepseek_tui_sessions_dirs', 'devin_dirs', 'forge_dirs',
  'gemini_dirs', 'grok_dirs', 'iflow_dirs', 'kilo_dirs', 'kilo_legacy_dirs', 'kimi_work_dirs', 'kiro_ide_dirs',
  'mimocode_dirs', 'omnigent_dirs', 'openclaude_project_dirs', 'opencode_dirs', 'openhands_dirs', 'piebald_dirs',
  'poolside_dirs', 'posit_assistant_dirs', 'positron_dirs', 'qclaw_dirs', 'qwen_project_dirs', 'qwenpaw_dirs',
  'shelley_dirs', 'trae_dirs', 'traex_sessions_dirs', 'visualstudio_copilot_dirs', 'vscode_copilot_dirs', 'warp_dirs',
  'workbuddy_project_dirs', 'zcode_dirs', 'zed_dirs', 'zencoder_dirs'
].map(key => [key, []]))

/** Derived archive only. The admitted native engine owns parsing/FTS; app reads its SQLite archive. */
export class ProjectSessionHistory {
  private queue = new Map<string, Promise<unknown>>()
  private children = new Set<ChildProcess>()
  private closed = false
  private searches = new Map<string, { requestId: string; controller: AbortController }>()
  private cancelledSearchRequests = new Set<string>()
  private analyticsJobs = new Map<string, { requestId: string; controller: AbortController; progress: SessionAnalyticsProgress; done: ReturnType<typeof Promise.withResolvers<void>> }>()
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
    if (hash.digest('hex') !== SESSION_HISTORY_BINARY_SHA256) throw new Error('Session history requires the admitted AgentsView 0.42.0 Donwells cwd3 binary')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const roots = async (values: string[]) => Promise.all(values.map(value => realpath(value)))
    const prefixes = new Set([resolve(path), scope.checkoutPath, scope.projectPath])
    for (const prefix of [...prefixes]) {
      const alias = prefix.startsWith('/private/') ? prefix.slice('/private'.length) : null
      if (process.platform === 'darwin' && alias && await realpath(alias).catch(() => null) === prefix) prefixes.add(alias)
    }
    const config = {
      ...disabledProviderRoots,
      disable_update_check: true,
      sync_include_cwd_prefixes: [...prefixes],
      omp_dirs: await roots(this.options.roots.omp),
      deepseek_harness_sessions_dirs: await roots(this.options.roots['deepseek-harness']),
      hermes_sessions_dirs: await roots(this.options.roots.hermes ?? []),
      kimi_dirs: await roots(this.options.roots.kimi ?? [])
    }
    await writeFile(join(directory, 'config.toml'), Object.entries(config).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600 })
    await this.assertScope(path, scope)
    await rm(join(directory, 'receipt.json'), { force: true })
    const token = randomBytes(32).toString('hex')
    // Every provider root is explicit above, so AgentsView cannot fall back to home-directory discovery.
    const child = spawnProcess({ program: this.options.binary, args: ['serve', '--no-sync', '--no-browser', '--port', '0', '--require-auth'], cwd: scope.checkoutPath, env: { PATH: process.env.PATH, HOME: process.env.HOME, AGENTSVIEW_DATA_DIR: directory, AGENTSVIEW_AUTH_TOKEN: token }, detached: true })
    this.children.add(child)
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let output = '', diagnostic = ''
        child.stderr?.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-2000) })
        const timer = setTimeout(() => reject(new Error('History engine readiness timed out')), 10000)
        child.once('error', reject)
        child.once('exit', () => { clearTimeout(timer); reject(new Error('History engine exited before ready' + (diagnostic.trim() ? ': ' + diagnostic.trim().replaceAll(token, '[redacted]') : ''))) })
        child.stdout?.on('data', chunk => {
          output = (output + chunk.toString()).slice(-16000)
          const match = /listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(output)
          if (match) { clearTimeout(timer); resolve(match[1]!) }
        })
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
      await writeFile(join(directory, 'receipt.json'), JSON.stringify({ version: SESSION_HISTORY_VERSION, binarySha256: SESSION_HISTORY_BINARY_SHA256, indexedAt, indexKey: scope.indexKey }), { mode: 0o600 })
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
    if (!isObject(receipt) || receipt.version !== SESSION_HISTORY_VERSION || receipt.binarySha256 !== SESSION_HISTORY_BINARY_SHA256 || receipt.indexKey !== scope.indexKey || typeof receipt.indexedAt !== 'string') throw new Error('Session history must be indexed for this parser version')
    return { scope, directory, indexedAt: receipt.indexedAt }
  }

  private async sourceFingerprint(row:Row):Promise<SourceFingerprint|null>{
    const file = await lstat(String(row.file_path), { bigint: true })
    if (!file.isFile()) return null
    let size=file.size,mtime=file.mtimeNs
    if (row.agent === 'hermes' && String(row.file_path).endsWith('state.db')) {
      let wal:Awaited<ReturnType<typeof lstat>>|null=null
      try{wal=await lstat(String(row.file_path)+'-wal',{bigint:true})}catch(error){if(!isObject(error)||error.code!=='ENOENT')throw error}
      if(wal?.isFile()&&wal.size>0n){size+=wal.size;if(wal.mtimeNs>mtime)mtime=wal.mtimeNs}
      const sessions=join(dirname(String(row.file_path)),'sessions');let entries:Dirent[]
      try{entries=await readdir(sessions,{withFileTypes:true})}catch(error){if(!isObject(error)||error.code!=='ENOENT')throw error;entries=[]}
      if(entries.length>100_000)return null
      for(const entry of entries){if(!entry.isFile()||!(extname(entry.name)==='.jsonl'||entry.name.startsWith('session_')&&extname(entry.name)==='.json'))continue;const item=await lstat(join(sessions,entry.name),{bigint:true}).catch(()=>null);if(!item?.isFile())return null;size+=item.size;if(item.mtimeNs>mtime)mtime=item.mtimeNs}
    }
    return {size:size.toString(),mtime:mtime.toString()}
  }

  private async current(row: Row, scope: ProjectToolScope, fingerprints?:Map<string,Promise<SourceFingerprint|null>>): Promise<boolean> {
    if (typeof row.cwd !== 'string' || typeof row.file_path !== 'string' || !supportedAgents.includes(String(row.agent))) return false
    try {
      const sourceScope = await this.resolveScope(row.cwd)
      if (sourceScope.projectKey !== scope.projectKey) return false
      const key=`${row.agent}\0${row.file_path}`;let pending=fingerprints?.get(key)
      if(!pending){pending=this.sourceFingerprint(row);fingerprints?.set(key,pending)}
      const fingerprint=await pending
      return fingerprint?.size === String(row.file_size) && fingerprint.mtime === String(row.source_mtime)
    } catch { return false }
  }

  async search(path: string, query: string, requestId = randomBytes(16).toString('hex')): Promise<{ hits: ProjectSearchHit[]; truncated: boolean; capabilities: typeof SESSION_HISTORY_CAPABILITIES }> {
    if (typeof query !== 'string' || !query.trim() || query.length > 512) throw new Error('Session query must contain 1–512 characters')
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(requestId)) throw new Error('Invalid session search request')
    const { scope, directory, indexedAt } = await this.archive(path)
    if (this.searches.has(scope.indexKey)) throw new Error('Session search is already running')
    const operation = { requestId, controller: new AbortController() }
    this.searches.set(scope.indexKey, operation)
    if (this.cancelledSearchRequests.has(requestId)) operation.controller.abort(new Error('Session search cancelled'))
    const db = new DatabaseSync(join(directory, 'sessions.db'), { readOnly: true })
    let rows: Row[]
    try {
      operation.controller.signal.throwIfAborted()
      rows = db.prepare(`SELECT s.id,s.agent,s.cwd,s.file_path,s.file_size,CAST(s.file_mtime AS TEXT) AS source_mtime,s.transcript_revision,s.parent_session_id,s.relationship_type,s.session_kind,m.ordinal,substr(m.content,1,600) AS excerpt,coalesce(s.session_name,s.display_name,s.first_message,s.id) AS title FROM messages_fts f JOIN messages m ON m.id=f.rowid JOIN sessions s ON s.id=m.session_id WHERE messages_fts MATCH ? AND s.deleted_at IS NULL AND s.source_missing_at IS NULL AND m.is_system=0 AND m.role IN ('user','assistant') ORDER BY rank LIMIT 101`).all('"' + query.replaceAll('"', '""') + '"')
    } catch (error) { this.searches.delete(scope.indexKey); this.cancelledSearchRequests.delete(requestId); throw error }
    finally { db.close() }
    try {
      const hits: ProjectSearchHit[] = [],fingerprints=new Map<string,Promise<SourceFingerprint|null>>()
      for (const row of rows.slice(0, 100)) {
        operation.controller.signal.throwIfAborted()
        if (!await this.current(row, scope, fingerprints)) continue
        hits.push({ source: 'session', id: `session:${scope.indexKey}:${encodeURIComponent(String(row.id))}:${row.ordinal}`, title: `${row.agent}${helperSession(row) ? ' helper' : ''} · ${String(row.title).slice(0, 160)}`, excerpt: String(row.excerpt), path: null, line: Number(row.ordinal) + 1, revision: String(row.transcript_revision), indexedAt, stale: false })
      }
      await this.assertScope(path, scope)
      return { hits, truncated: rows.length > 100, capabilities: SESSION_HISTORY_CAPABILITIES }
    } finally {
      if (this.searches.get(scope.indexKey) === operation) this.searches.delete(scope.indexKey)
      this.cancelledSearchRequests.delete(requestId)
    }
  }

  async cancelSearch(path: string, requestId: string): Promise<void> {
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(requestId)) throw new Error('Invalid session search request')
    // ponytail: a bounded set closes the pre-start IPC race; replace with per-request jobs if concurrent searches are later allowed.
    if (this.cancelledSearchRequests.size >= 256) this.cancelledSearchRequests.clear()
    this.cancelledSearchRequests.add(requestId)
    const { scope } = await this.bound(path), operation = this.searches.get(scope.indexKey)
    if (operation?.requestId === requestId) operation.controller.abort(new Error('Session search cancelled'))
  }

  async get(path: string, id: string, page: SessionHistoryPage = {}): Promise<SessionHistorySource> {
    const { scope, directory, indexedAt } = await this.archive(path)
    const prefix = `session:${scope.indexKey}:`
    if (typeof id !== 'string' || !id.startsWith(prefix) || id.length > 2048) throw new Error('Session belongs to another checkout')
    const split = id.lastIndexOf(':'), ordinal = Number(id.slice(split + 1)), nativeId = decodeURIComponent(id.slice(prefix.length, split))
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new Error('Invalid session message')
    if (!isObject(page) || Object.keys(page).some(key => !['fromOrdinal', 'limit'].includes(key))) throw new Error('Invalid session page')
    const fromOrdinal = page.fromOrdinal ?? Math.max(0, ordinal - 2), limit = page.limit ?? 5
    if (!Number.isSafeInteger(fromOrdinal) || fromOrdinal < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid session page')
    const db = new DatabaseSync(join(directory, 'sessions.db'), { readOnly: true })
    let row: Row | undefined, messages: Row[]
    try {
      row = db.prepare('SELECT id,agent,cwd,file_path,file_size,CAST(file_mtime AS TEXT) AS source_mtime,source_session_id,source_version,parent_session_id,relationship_type,session_kind FROM sessions WHERE id=? AND deleted_at IS NULL AND source_missing_at IS NULL').get(nativeId)
      messages = db.prepare("SELECT ordinal,role,substr(content,1,12000) AS content FROM messages WHERE session_id=? AND ordinal>=? AND is_system=0 AND role IN ('user','assistant') ORDER BY ordinal LIMIT ?").all(nativeId, fromOrdinal, limit + 1)
    } finally { db.close() }
    if (!row || !await this.current(row, scope)) throw new Error('Original session is missing, changed, or outside this project. Refresh session history.')
    await this.assertScope(path, scope)
    const dshId = /^deepseek-harness:session-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(nativeId)?.[1]
    const role = helperSession(row) ? 'helper' : 'primary'
    const sourceSessionId = typeof row.source_session_id === 'string' && row.source_session_id ? row.source_session_id : null
    const resume = role === 'helper' ? null : row.agent === 'omp' ? { executable: 'omp', args: ['--resume', String(row.file_path)] } : row.agent === 'deepseek-harness' && dshId ? { executable: 'dsh', args: ['--profile', 'tui', '--resume', dshId] } : row.agent === 'hermes' && sourceSessionId ? { executable: 'hermes', args: ['--tui', '--resume', sourceSessionId] } : row.agent === 'kimi' && sourceSessionId ? { executable: 'kimi', args: ['--session', sourceSessionId] } : null
    const visible = messages.slice(0, limit)
    const sourceFormat = row.agent === 'hermes' ? 'Hermes state.db' : row.agent === 'kimi' ? 'Kimi wire.jsonl' : row.agent === 'deepseek-harness' ? 'DeepSeek Harness native session' : 'OMP native session'
    return { id, agent: String(row.agent), nativeId, source: String(row.file_path), sourceFormat, sourceVersion: typeof row.source_version === 'string' && row.source_version ? row.source_version : null, projectAttribution: 'cwd', parentNativeId: typeof row.parent_session_id === 'string' && row.parent_session_id ? row.parent_session_id : null, role, cwd: String(row.cwd), indexedAt, resume, messages: visible.map(message => ({ ordinal: Number(message.ordinal), role: String(message.role), content: String(message.content) })), previousOrdinal: fromOrdinal > 0 ? Math.max(0, fromOrdinal - limit) : null, nextOrdinal: messages.length > limit ? Number(messages[limit]!.ordinal) : null, untrusted: true }
  }

  async analyticsProgress(path: string, requestId: string): Promise<SessionAnalyticsProgress> {
    const { scope } = await this.bound(path), job = this.analyticsJobs.get(scope.indexKey)
    if (!job || job.requestId !== requestId) throw new Error('Analytics request is no longer active')
    return { ...job.progress }
  }

  async cancelAnalytics(path: string, requestId: string): Promise<void> {
    const { scope } = await this.bound(path), job = this.analyticsJobs.get(scope.indexKey)
    if (!job || job.requestId !== requestId) throw new Error('Analytics request is no longer active')
    job.controller.abort(new Error('Analytics cancelled'))
    await job.done.promise
  }

  async analytics(path: string, options: SessionAnalyticsOptions = {}): Promise<SessionHistoryAnalytics> {
    if (!isObject(options) || Object.keys(options).some(key => !['engine', 'requestId', 'decisionAt'].includes(key)) || (options.engine !== undefined && !['sqlite', 'duckdb'].includes(options.engine)) || (options.requestId !== undefined && (typeof options.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(options.requestId))) || (options.decisionAt !== undefined && (typeof options.decisionAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(options.decisionAt) || !Number.isFinite(Date.parse(options.decisionAt))))) throw new Error('Invalid analytics options')
    const engine = options.engine ?? 'sqlite'
    if (engine === 'sqlite' && options.decisionAt) throw new Error('Decision comparison requires DuckDB')
    if (engine === 'duckdb' && !this.options.analyticsPython) throw new Error('DuckDB analytics is disabled or unconfigured; configure its Python executable or select SQLite summary')
    const { scope, directory, indexedAt } = await this.archive(path)
    const existing = this.analyticsJobs.get(scope.indexKey)
    if (existing && ['validating', 'snapshot', 'querying'].includes(existing.progress.phase)) throw new Error('Analytics is already running for this checkout')
    const job = { requestId: options.requestId ?? randomBytes(16).toString('hex'), controller: new AbortController(), progress: { phase: 'validating', validated: 0, scanned: 0 } as SessionAnalyticsProgress, done: Promise.withResolvers<void>() }
    this.analyticsJobs.set(scope.indexKey, job)
    const deadline = setTimeout(() => job.controller.abort(new Error('Analytics exceeded the two-minute limit')), 120000)
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(join(directory, 'sessions.db'), { readOnly: true })
      const version = db.prepare('PRAGMA data_version').get()!.data_version
      db.exec('BEGIN')
      let reading = true
      const selected: Row[] = [],fingerprints=new Map<string,Promise<SourceFingerprint|null>>()
      let truncated = false, cursor: string | null = null
      do {
        job.controller.signal.throwIfAborted()
        const rows: Row[] = db.prepare(`SELECT id,agent,cwd,file_path,file_size,CAST(file_mtime AS TEXT) source_mtime FROM sessions WHERE deleted_at IS NULL AND source_missing_at IS NULL AND (? IS NULL OR id>?) ORDER BY ${engine === 'sqlite' ? 'started_at DESC,id' : 'id'} LIMIT 1001`).all(cursor, cursor)
        for (const row of rows.slice(0, 1000)) {
          job.controller.signal.throwIfAborted()
          job.progress.scanned++
          if (await this.current(row, scope, fingerprints)) { selected.push(row); job.progress.validated++ }
          if (selected.length > 10000 || job.progress.scanned > 100000) throw new Error('Analytics source limit reached; narrow indexed session roots')
        }
        truncated = rows.length > 1000
        cursor = truncated ? String(rows[999]!.id) : null
      } while (engine === 'duckdb' && cursor !== null)
      const revalidate = async () => {
        job.controller.signal.throwIfAborted()
        const currentFingerprints=new Map<string,Promise<SourceFingerprint|null>>()
        for (const row of selected) {
          job.controller.signal.throwIfAborted()
          if (!await this.current(row, scope, currentFingerprints)) throw new Error('Native session changed during analytics. Refresh session history.')
        }
        await this.assertScope(path, scope)
        if ((await this.archive(path)).indexedAt !== indexedAt || db!.prepare('PRAGMA data_version').get()!.data_version !== version) throw new Error('History index changed during analytics; refresh before using these results')
      }
      job.progress.phase = 'snapshot'
      const result = engine === 'duckdb'
        ? await duckdbSessionHistory(db, selected.map(row => String(row.id)), this.options.analyticsPython!, job.controller.signal, async () => { await revalidate(); db!.exec('COMMIT'); reading = false; job.progress.phase = 'querying' }, options.decisionAt)
        : aggregateSessionHistory(db, selected.map(row => String(row.id)))
      if (reading) db.exec('COMMIT')
      await revalidate()
      const sourceRefs = selected.map(row => ({ id: String(row.id), fingerprint: createHash('sha256').update(JSON.stringify([row.id, row.file_size, row.source_mtime])).digest('hex') }))
      const sourceGeneration = createHash('sha256').update(JSON.stringify([indexedAt, sourceRefs, result])).digest('hex')
      job.progress.phase = 'complete'
      return { ...result, engine, sourceGeneration, ...(options.decisionAt ? { decisionAt: options.decisionAt } : {}), sourceRefs, indexedAt, sessions: selected.length, excluded: job.progress.scanned - selected.length, truncated }
    } catch (error) { job.progress.phase = job.controller.signal.aborted ? 'cancelled' : 'failed'; throw error }
    finally { clearTimeout(deadline); db?.close(); job.done.resolve() }
  }

  async isIndexing(path: string): Promise<boolean> { return this.queue.has((await this.bound(path)).scope.indexKey) }

  async close(): Promise<void> {
    this.closed = true
    for (const operation of this.searches.values()) operation.controller.abort(new Error('History service closed'))
    for (const job of this.analyticsJobs.values()) job.controller.abort(new Error('History service closed'))
    await Promise.all([...this.analyticsJobs.values()].map(job => job.done.promise))
    const stopped = await Promise.all([...this.children].map(child => forceTerminateProcessTree(child)))
    if (stopped.some(ok => !ok)) throw new Error('History engine shutdown could not be verified')
    await Promise.allSettled(this.queue.values())
  }
}
