import { createHash, randomUUID } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { isObject } from '@shared/command-catalog'
import { parseHindsightConfiguration, parseKnowledgeSelections, type HindsightTransferSnapshot, type HindsightConfiguration, type KnowledgeAnswer, type KnowledgeSelection, type KnowledgeSourceRef, type KnowledgeStatus } from '@shared/project-knowledge'
import type { ProjectHandoffStatus } from '@shared/project-handoff'
import type { ProjectToolScope } from '@shared/project-tools'
import { ProjectMemoryStore } from './project-memory-store'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
type Source = { ref: KnowledgeSourceRef; content: string; remoteId: string }
type Generation = { bank: string; endpoint: string; model: string; digest: string; state: string; selection: string }
// ponytail: one desktop process serializes model work; multiple owners would need a durable lease.
let modelOperation = false
export function acquireKnowledgeOperation(): () => void {
  if (modelOperation) throw new Error('Another knowledge operation is running; retry after it finishes')
  modelOperation = true
  return () => { modelOperation = false }
}

/** Canonical sources remain authoritative; this ledger stores only disposable projection identities. */
export class ProjectKnowledge {
  private readonly config: HindsightConfiguration
  private phase: KnowledgeStatus['phase'] = 'idle'
  private error: string | null = null
  private operation: { abort: AbortController; done: ReturnType<typeof Promise.withResolvers<void>> } | null = null
  private closed = false
  constructor(private profile: string, configuration: HindsightConfiguration, private resolveScope: (path: string) => Promise<ProjectToolScope>, private handoff?: (path: string, id: string) => Promise<ProjectHandoffStatus>, private request: typeof fetch = fetch) {
    this.config = parseHindsightConfiguration(configuration)
  }
  private ledger<T>(action: (db: DatabaseSync) => T): T {
    const directory = join(this.profile, 'project-knowledge'); mkdirSync(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, 'projections.sqlite')
    try { closeSync(openSync(path, 'wx', 0o600)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const file = lstatSync(path)
    if (!file.isFile() || file.isSymbolicLink() || (process.platform !== 'win32' && ((file.mode & 0o077) || (process.getuid && file.uid !== process.getuid())))) throw new Error('Knowledge ledger must be a private regular file')
    const db = new DatabaseSync(path)
    try {
      db.exec('PRAGMA busy_timeout=1000; BEGIN IMMEDIATE')
      const version = db.prepare('PRAGMA user_version').get()!.user_version
      if (version !== 0 && version !== 1) throw new Error('Unsupported knowledge ledger version')
      if (version === 0 && db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length) throw new Error('Unrecognized knowledge ledger; existing tables left untouched')
      if (version === 0) db.exec('CREATE TABLE generations(project TEXT NOT NULL,bank TEXT PRIMARY KEY,endpoint TEXT NOT NULL,model TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,selection TEXT NOT NULL); CREATE TABLE sources(bank TEXT NOT NULL,remote_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,state TEXT NOT NULL,operation_id TEXT NOT NULL,PRIMARY KEY(bank,remote_id)); PRAGMA user_version=1')
      const result = action(db); db.exec('COMMIT'); return result
    } finally { db.close() }
  }
  private generations(project: string): Generation[] { return this.ledger(db => db.prepare('SELECT bank,endpoint,model,digest,state,selection FROM generations WHERE project=? ORDER BY rowid DESC').all(project) as Generation[]) }
  private async scope(path: string): Promise<ProjectToolScope> {
    if (this.closed || !this.config.enabled) throw new Error('Hindsight is disabled or stopped')
    return this.resolveScope(path)
  }
  private async snapshot(path: string, scope: ProjectToolScope, selection: KnowledgeSelection[]): Promise<Source[]> {
    const memory = new ProjectMemoryStore(this.profile), sources: Source[] = []
    for (const selected of selection) {
      let content: string, sourceTime: string | null
      if (selected.kind === 'memory') {
        const fact = memory.get(scope.projectKey, selected.id)
        if (fact.revision !== selected.revision || fact.archivedAt) throw new Error('Selected memory changed or was archived; review current sources')
        content = `${fact.kind}: ${fact.title}\n${fact.content}`; sourceTime = fact.updatedAt
      } else {
        if (!this.handoff) throw new Error('Reviewed handoff source reader is unavailable')
        const status = await this.handoff(path, selected.id), record = status.handoff
        if (record.projectKey !== scope.projectKey || record.revision !== selected.revision || status.stale || record.state === 'superseded') throw new Error('Selected handoff changed or is no longer current')
        content = `${record.goal}\n${record.summary}\nOpen questions:\n${record.openQuestions.join('\n')}\nNext steps:\n${record.nextSteps.join('\n')}`
        sourceTime = null // Handoffs do not currently store authored timestamps; do not invent one.
      }
      sources.push({ ref: { ...selected, projectKey: scope.projectKey, sourceTime }, content, remoteId: digest([selected.kind, selected.id, selected.revision]) })
    }
    if (sources.reduce((n, source) => n + Buffer.byteLength(source.content), 0) > 128 * 1024) throw new Error('Selected knowledge exceeds 128 KiB; select fewer sources')
    const current = await this.scope(path)
    if (current.projectKey !== scope.projectKey || current.indexKey !== scope.indexKey) throw new Error('Knowledge project changed during source review')
    return sources
  }
  private async http(endpoint: string, bank: string, suffix: string, method: string, body?: unknown): Promise<Record<string, unknown>> {
    parseHindsightConfiguration({ ...this.config, endpoint })
    const response = await this.request(endpoint + '/v1/default/banks/' + encodeURIComponent(bank) + suffix, { method, redirect: 'error', ...(body instanceof FormData ? { body } : { headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), signal: AbortSignal.any([this.operation!.abort.signal, AbortSignal.timeout(120000)]) })
    if (method === 'DELETE' && response.status === 404) return { success: true }
    if (!response.ok) throw new Error(`Hindsight ${method} failed (${response.status})`)
    const reader = response.body?.getReader(); if (!reader) throw new Error('Hindsight returned no response')
    const chunks: Uint8Array[] = []; let bytes = 0
    try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length; if (bytes > 1024 * 1024) throw new Error('Hindsight response exceeds 1 MiB'); chunks.push(chunk.value) } }
    finally { await reader.cancel().catch(() => {}) }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!isObject(value)) throw new Error('Invalid Hindsight response')
    return value
  }
  private async cleanup(project: string, generations: Generation[]): Promise<void> {
    for (const generation of generations) {
      if (!generation.bank.startsWith('donwells-' + project + '-')) throw new Error('Refusing foreign knowledge bank cleanup')
      const uncertain = this.ledger(db=>db.prepare("SELECT remote_id FROM sources WHERE bank=? AND operation_id='unknown-import' AND state IN ('submitting','submitted')").all(generation.bank))
      if(uncertain.length){
        const listed=await this.http(generation.endpoint,generation.bank,'/operations?type=import_documents&limit=2','GET')
        if(listed.bank_id!==generation.bank||listed.total!==1||!Array.isArray(listed.operations)||listed.operations.length!==1||!isObject(listed.operations[0])||typeof listed.operations[0].id!=='string')throw new Error('Native import submission remains uncertain; keep its unpublished bank until its single operation can be identified')
        const discoveredId=listed.operations[0].id
        this.ledger(db=>db.prepare("UPDATE sources SET operation_id=? WHERE bank=? AND operation_id='unknown-import'").run(discoveredId,generation.bank))
      }
      const operations = this.ledger(db => db.prepare("SELECT DISTINCT operation_id,state FROM sources WHERE bank=? AND state IN ('submitting','submitted')").all(generation.bank))
      for (const operation of operations) {
        const suffix = '/operations/' + encodeURIComponent(String(operation.operation_id))
        let status = await this.http(generation.endpoint, generation.bank, suffix, 'GET')
        if (status.status === 'pending' || status.status === 'processing') {
          const cancelled = await this.http(generation.endpoint, generation.bank, suffix, 'DELETE')
          if (cancelled.success !== true) throw new Error('Remote retain cancellation is not acknowledged; cleanup remains pending')
          status = await this.http(generation.endpoint, generation.bank, suffix, 'GET')
        }
        if (!['completed', 'failed', 'cancelled'].includes(String(status.status))) throw new Error('Remote retain state is uncertain; cleanup remains pending')
      }
      const result = await this.http(generation.endpoint, generation.bank, '', 'DELETE')
      if (result.success !== true) throw new Error('Hindsight did not acknowledge bank cleanup')
      this.ledger(db => { db.prepare('DELETE FROM sources WHERE bank=?').run(generation.bank); db.prepare('DELETE FROM generations WHERE project=? AND bank=?').run(project, generation.bank) })
    }
  }
  private async run<T>(phase: 'retaining' | 'querying', action: () => Promise<T>): Promise<T> {
    if (this.operation || modelOperation) throw new Error('Another knowledge operation is running; retry after it finishes')
    const release = acquireKnowledgeOperation(); this.phase = phase; this.error = null
    const operation = { abort: new AbortController(), done: Promise.withResolvers<void>() }; this.operation = operation
    try { return await action() } catch (error) { this.error = String(error).slice(0, 500); throw error }
    finally { this.operation = null; this.phase = this.closed ? 'stopped' : 'idle'; release(); operation.done.resolve() }
  }
  async status(path: string): Promise<KnowledgeStatus> {
    const scope = await this.resolveScope(path), generations = this.generations(scope.projectKey)
    const published = generations.find(row => row.state === 'published')
    const sources = published ? parseKnowledgeSelections(JSON.parse(published.selection)) : []
    let stale = true
    try { if (published && published.endpoint === this.config.endpoint && published.model === this.config.model) stale = digest(await this.snapshot(path, scope, sources)) !== published.digest } catch { /* Withdrawn or unavailable sources cannot support a current answer. */ }
    return { enabled: this.config.enabled && !this.closed, phase: this.phase, generation: published?.bank ?? null, sources, stale, pendingCleanup: generations.filter(row => row.state !== 'published').length, error: this.error, model: this.config.model }
  }
  async reconcile(path: string, value: KnowledgeSelection[]): Promise<KnowledgeStatus> {
    const selection = parseKnowledgeSelections(value), scope = await this.scope(path)
    await this.run('retaining', async () => {
      const sources = await this.snapshot(path, scope, selection), sourceDigest = digest(sources)
      const previous = this.generations(scope.projectKey)
      await this.cleanup(scope.projectKey, previous.filter(row => row.state !== 'published'))
      const current = previous.find(row => row.state === 'published')
      if (current?.digest === sourceDigest && current.endpoint === this.config.endpoint && current.model === this.config.model) return
      const bank = 'donwells-' + scope.projectKey + '-' + randomUUID()
      this.ledger(db => {
        db.prepare('INSERT INTO generations VALUES(?,?,?,?,?,?,?)').run(scope.projectKey, bank, this.config.endpoint, this.config.model, sourceDigest, 'building', JSON.stringify(selection))
        const insert = db.prepare('INSERT INTO sources VALUES(?,?,?,?,?,?,?)')
        for (const source of sources) insert.run(bank, source.remoteId, source.ref.kind, source.ref.id, source.ref.revision, 'pending', randomUUID())
      })
      await this.http(this.config.endpoint, bank, '', 'PUT', { name: 'Donwells reviewed project knowledge', enable_observations: false })
      const configuration = await this.http(this.config.endpoint, bank, '/config', 'PATCH', { updates: { enable_observations: false } })
      if (!isObject(configuration.config) || configuration.config.enable_observations !== false) throw new Error('Hindsight did not confirm explicit source-only retention')
      for (const source of sources) {
        const operationId = String(this.ledger(db => db.prepare('SELECT operation_id FROM sources WHERE bank=? AND remote_id=?').get(bank, source.remoteId))!.operation_id)
        this.ledger(db => db.prepare('UPDATE sources SET state=? WHERE bank=? AND remote_id=?').run('submitting', bank, source.remoteId))
        const result = await this.http(this.config.endpoint, bank, '/memories', 'POST', { async: true, operation_id: operationId, items: [{ content: source.content, ...(source.ref.kind === 'memory' ? { timestamp: source.ref.sourceTime } : {}), document_id: source.remoteId, metadata: { project: scope.projectKey, kind: source.ref.kind, source_id: source.ref.id, revision: String(source.ref.revision) } }] })
        if (result.success !== true || result.bank_id !== bank || result.async !== true || result.operation_id !== operationId || result.items_count !== 1) throw new Error('Hindsight retain acknowledgement is incomplete')
        this.ledger(db => db.prepare('UPDATE sources SET state=? WHERE bank=? AND remote_id=?').run('submitted', bank, source.remoteId))
        const deadline = Date.now() + 120000
        for (;;) {
          const status = await this.http(this.config.endpoint, bank, '/operations/' + encodeURIComponent(operationId), 'GET')
          if (status.status === 'completed') break
          if (!['pending', 'processing'].includes(String(status.status))) throw new Error('Hindsight retain did not complete; reconcile cleanup before retrying')
          if (Date.now() > deadline) throw new Error('Hindsight retain is still running; cleanup remains pending')
          await delay(1000, undefined, { signal: this.operation!.abort.signal })
        }
        this.ledger(db => db.prepare('UPDATE sources SET state=? WHERE bank=? AND remote_id=?').run('retained', bank, source.remoteId))
      }
      if (digest(await this.snapshot(path, scope, selection)) !== sourceDigest) throw new Error('Knowledge source changed during retention; unpublished generation needs cleanup')
      this.ledger(db => {
        db.prepare('UPDATE generations SET state=? WHERE project=? AND state=?').run('cleanup', scope.projectKey, 'published')
        db.prepare('UPDATE generations SET state=? WHERE project=? AND bank=?').run('published', scope.projectKey, bank)
      })
      await this.cleanup(scope.projectKey, this.generations(scope.projectKey).filter(row => row.state !== 'published'))
    })
    return this.status(path)
  }
  private async answer(path: string, query: string, reflect: boolean): Promise<KnowledgeAnswer> {
    if (typeof query !== 'string' || !query.trim() || query.length > 2000 || /[\x00-\x1f\x7f]/.test(query)) throw new Error('Knowledge query must contain 1–2000 characters')
    const scope = await this.scope(path)
    return this.run('querying', async () => {
      const state = await this.status(path)
      if (!state.generation || state.stale || state.pendingCleanup) throw new Error('Knowledge projection is stale or cleanup is pending; review and reconcile its selected sources')
      const sources = await this.snapshot(path, scope, state.sources), sourceDigest = digest(sources), byDocument = new Map(sources.map(source => [source.remoteId, source.ref]))
      const configuration = await this.http(this.config.endpoint, state.generation, '/config', 'GET')
      if (!isObject(configuration.config) || configuration.config.enable_observations !== false) throw new Error('Hindsight retention configuration changed; reconcile after reviewing service configuration')
      const result = await this.http(this.config.endpoint, state.generation, reflect ? '/reflect' : '/memories/recall', 'POST', reflect ? { query, budget: 'low', max_tokens: 1000, include: { facts: {} }, fact_types: ['world', 'experience'], exclude_mental_models: true } : { query, budget: 'low', max_tokens: 1500, types: ['world', 'experience'], include: { entities: null } })
      const items: KnowledgeAnswer['items'] = []; let omitted = 0
      if (reflect) {
        const based = isObject(result.based_on) ? result.based_on : null
        if (!based || !Array.isArray(based.memories) || !based.memories.length || (Array.isArray(based.mental_models) && based.mental_models.length) || (Array.isArray(based.directives) && based.directives.length) || typeof result.text !== 'string') throw new Error('Reflection has incomplete source provenance; no generated answer returned')
        const refs: KnowledgeSourceRef[] = []
        for (const fact of based.memories.slice(0, 50)) {
          if (!isObject(fact) || typeof fact.id !== 'string') throw new Error('Reflection contains an untraceable fact; no generated answer returned')
          const detail = await this.http(this.config.endpoint, state.generation, '/memories/' + encodeURIComponent(fact.id), 'GET')
          const ref = typeof detail.document_id === 'string' ? byDocument.get(detail.document_id) : undefined
          if (!ref || detail.state === 'invalidated' || !['world', 'experience'].includes(String(detail.type))) throw new Error('Reflection contains an unknown source; no generated answer returned')
          refs.push(ref)
        }
        if (based.memories.length > 50) throw new Error('Reflection provenance exceeds review limit; no generated answer returned')
        items.push({ text: result.text, sources: refs })
      } else {
        if (!Array.isArray(result.results)) throw new Error('Invalid Hindsight recall results')
        for (const fact of result.results.slice(0, 20)) {
          const ref = isObject(fact) && typeof fact.document_id === 'string' ? byDocument.get(fact.document_id) : undefined
          if (!isObject(fact) || typeof fact.text !== 'string' || !ref || !['world', 'experience'].includes(String(fact.type))) { omitted++; continue }
          items.push({ text: fact.text, sources: [ref] })
        }
        omitted += Math.max(0, result.results.length - 20)
      }
      if (digest(await this.snapshot(path, scope, state.sources)) !== sourceDigest) throw new Error('Knowledge sources changed during the query; no generated answer returned')
      return { classification: 'learned', generation: state.generation, model: this.config.model, items, omitted }
    })
  }
  async importTransfer(path: string, selectionValue: KnowledgeSelection[], archiveBase64: string, facts: number): Promise<KnowledgeStatus> {
    const selection=parseKnowledgeSelections(selectionValue),scope=await this.scope(path),archive=Buffer.from(archiveBase64,'base64')
    if(!selection.length||archive.length>8*1024*1024||archive.length<4||archive.readUInt32LE(0)!==0x04034b50||!Number.isSafeInteger(facts)||facts<0)throw new Error('Invalid reviewed learned transfer')
    await this.run('retaining',async()=>{
      const sources=await this.snapshot(path,scope,selection),sourceDigest=digest(sources)
      await this.cleanup(scope.projectKey,this.generations(scope.projectKey).filter(row=>row.state!=='published'))
      const bank='donwells-'+scope.projectKey+'-'+randomUUID()
      this.ledger(db=>{
        db.prepare('INSERT INTO generations VALUES(?,?,?,?,?,?,?)').run(scope.projectKey,bank,this.config.endpoint,this.config.model,sourceDigest,'building',JSON.stringify(selection))
        for(const source of sources)db.prepare('INSERT INTO sources VALUES(?,?,?,?,?,?,?)').run(bank,source.remoteId,source.ref.kind,source.ref.id,source.ref.revision,'pending','unknown-import')
      })
      await this.http(this.config.endpoint,bank,'','PUT',{name:'Donwells restored learned knowledge',enable_observations:false})
      const config=await this.http(this.config.endpoint,bank,'/config','PATCH',{updates:{enable_observations:false}})
      if(!isObject(config.config)||config.config.enable_observations!==false)throw new Error('Hindsight did not confirm source-only import')
      const file=new FormData();file.set('file',new Blob([archive],{type:'application/zip'}),'documents.zip')
      this.ledger(db=>db.prepare("UPDATE sources SET state='submitting' WHERE bank=?").run(bank))
      const submitted=await this.http(this.config.endpoint,bank,'/document-transfer?on_conflict=skip','POST',file)
      if(typeof submitted.operation_id!=='string'||!submitted.operation_id)throw new Error('Native import has no operation receipt; unpublished bank retained')
      this.ledger(db=>db.prepare("UPDATE sources SET state='submitted',operation_id=? WHERE bank=?").run(submitted.operation_id as string,bank))
      const deadline=Date.now()+120000
      for(;;){
        const operation=await this.http(this.config.endpoint,bank,'/operations/'+encodeURIComponent(submitted.operation_id),'GET')
        if(operation.status==='completed'){
          const result=operation.result_metadata
          if(!isObject(result)||result.documents_imported!==sources.length||result.documents_skipped!==0||result.facts_imported!==facts||!isObject(result.remapped_document_ids)||Object.keys(result.remapped_document_ids).length)throw new Error('Native import count or identity receipt does not match reviewed facts')
          break
        }
        if(!['pending','processing'].includes(String(operation.status)))throw new Error('Native learned import did not complete')
        if(Date.now()>deadline)throw new Error('Native learned import remains pending; reconcile cleanup before retrying')
        await delay(1000,undefined,{signal:this.operation!.abort.signal})
      }
      this.ledger(db=>db.prepare("UPDATE sources SET state='retained' WHERE bank=?").run(bank))
      if(digest(await this.snapshot(path,scope,selection))!==sourceDigest)throw new Error('Canonical source changed during import; learned bank remains unpublished')
      this.ledger(db=>{db.prepare("UPDATE generations SET state='cleanup' WHERE project=? AND state='published'").run(scope.projectKey);db.prepare("UPDATE generations SET state='published' WHERE bank=?").run(bank)})
      await this.cleanup(scope.projectKey,this.generations(scope.projectKey).filter(row=>row.state!=='published'))
    })
    return this.status(path)
  }
  async exportTransfer(path: string): Promise<HindsightTransferSnapshot> {
    const scope = await this.scope(path)
    return this.run('querying', async () => {
      const status = await this.status(path)
      if (!status.generation || status.stale || status.pendingCleanup) throw new Error('Reconcile current sources before exporting learned memory')
      const sources = await this.snapshot(path, scope, status.sources), sourceDigest = digest(sources)
      const submitted = await this.http(this.config.endpoint, status.generation, '/document-transfer/export?' + new URLSearchParams(sources.map(source=>['document_id',source.remoteId])).toString(), 'POST')
      if (typeof submitted.operation_id !== 'string') throw new Error('Hindsight did not return an export operation ID')
      const deadline = Date.now() + 120000
      let metadata: Record<string, unknown> | null = null
      while (!metadata) {
        const operation = await this.http(this.config.endpoint, status.generation, '/operations/' + encodeURIComponent(submitted.operation_id), 'GET')
        if (operation.status === 'completed' && isObject(operation.result_metadata)) metadata = operation.result_metadata
        else if (!['pending','processing'].includes(String(operation.status))) throw new Error('Hindsight document-transfer export did not complete')
        if (!metadata) { if (Date.now() > deadline) throw new Error('Hindsight export remains pending; no partial kit written'); await delay(1000, undefined, {signal:this.operation!.abort.signal}) }
      }
      if (typeof metadata.download_url !== 'string') throw new Error('Hindsight export has no download receipt')
      const url = new URL(metadata.download_url, this.config.endpoint)
      if (url.origin !== this.config.endpoint || !url.pathname.startsWith('/v1/default/files/download/') || url.username || url.password || url.hash || url.search) throw new Error('Refusing unowned learned-memory download')
      const response = await this.request(url, {redirect:'error',signal:AbortSignal.any([this.operation!.abort.signal,AbortSignal.timeout(60000)])})
      if (!response.ok || !response.body) throw new Error('Hindsight learned-memory download failed')
      const reader=response.body.getReader(), chunks:Uint8Array[]=[];let bytes=0
      try {for(;;){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.length;if(bytes>8*1024*1024)throw new Error('Learned snapshot exceeds8MiB; no partial archive accepted');chunks.push(chunk.value)}}finally{await reader.cancel().catch(()=>{})}
      const archive=Buffer.concat(chunks)
      if (archive.length<4 || archive.readUInt32LE(0)!==0x04034b50 || (typeof metadata.byte_size==='number' && metadata.byte_size!==archive.length)) throw new Error('Invalid learned-memory transfer archive receipt')
      if (digest(await this.snapshot(path,scope,status.sources))!==sourceDigest) throw new Error('Canonical sources changed during learned-memory export')
      return {format:'hindsight-document-transfer',transferSchemaRevision:'ebad478240d3171bb88201ececda5e8d9883d22d',exportedAt:new Date().toISOString(),model:this.config.model,sources:sources.map(source=>({...source.ref,documentId:source.remoteId})),archiveBase64:archive.toString('base64'),sha256:createHash('sha256').update(archive).digest('hex')}
    })
  }
  recall(path: string, query: string) { return this.answer(path, query, false) }
  reflect(path: string, query: string) { return this.answer(path, query, true) }
  matches(configuration: HindsightConfiguration): boolean { return JSON.stringify(this.config) === JSON.stringify(parseHindsightConfiguration(configuration)) }
  get stopped(): boolean { return this.closed }
  async close(): Promise<void> { this.closed = true; this.phase = 'stopped'; const operation = this.operation; if (operation) { operation.abort.abort(new Error('Knowledge operation stopped')); await operation.done.promise } }
}
