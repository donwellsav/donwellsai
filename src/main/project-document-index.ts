import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export type IndexedDocument = { path: string; content: string; revision: string }
export type DocumentIndexConfiguration = {
  qmdPackage: string
  lancePackage: string
  database: string
  collections: string[]
  embeddingModel?: string
  rerankingModel?: string
}
type Chunk = { collection: string; path: string; text: string; revision: string; indexedAt: string; hash: string; pos: number; line: number; embedded: boolean; vector: number[] }
const sql = (value: string): string => "'" + value.replaceAll("'", "''") + "'"

/** Native Lance storage/fusion and QMD chunking/models; callers supply already-confined source snapshots. */
export async function openProjectDocumentIndex(config: DocumentIndexConfiguration) {
  if (!config.collections.length || config.collections.some(id => !/^[a-f0-9]{64}$/.test(id))) throw new Error('Invalid document collections')
  for (const [path, version] of [[config.qmdPackage, '2.8.3'], [config.lancePackage, '0.38.0']]) {
    if (JSON.parse(await readFile(join(path!, 'package.json'), 'utf8')).version !== version) throw new Error('Document engine version is not admitted')
  }
  const { connect, Index, rerankers } = await import(pathToFileURL(join(config.lancePackage, 'dist/index.js')).href)
  const { chunkDocumentAsync } = await import(pathToFileURL(join(config.qmdPackage, 'dist/store.js')).href)
  const { getASTBreakPoints } = await import(pathToFileURL(join(config.qmdPackage, 'dist/ast.js')).href)
  if (!(await getASTBreakPoints('export function probe() { return 1; }', 'probe.ts')).some((point: { type: string }) => point.type.startsWith('ast:'))) throw new Error('Document chunker grammar is unavailable')
  const { LlamaCpp, formatDocForEmbedding, formatQueryForEmbedding } = await import(pathToFileURL(join(config.qmdPackage, 'dist/llm.js')).href)
  const require = createRequire(join(config.lancePackage, 'package.json'))
  const { Schema, Field, Utf8, Int32, Bool, Float32, FixedSizeList } = require('apache-arrow')
  const connection = await connect(config.database)
  const names: string[] = await connection.tableNames()
  const schema = new Schema([
    ...['collection', 'path', 'text', 'revision', 'indexedAt', 'hash'].map(name => new Field(name, new Utf8(), false)),
    ...['pos', 'line'].map(name => new Field(name, new Int32(), false)),
    new Field('embedded', new Bool(), false),
    new Field('vector', new FixedSizeList(2560, new Field('item', new Float32(), true)), false)
  ])
  let table
  try {
    table = names.includes('documents') ? await connection.openTable('documents') : await connection.createEmptyTable('documents', schema, { existOk: true })
    if (!names.includes('documents')) await table.createIndex('text', { config: Index.fts() })
  } catch (error) { table?.close(); connection.close(); throw error }
  const fusion = await rerankers.RRFReranker.create()
  const llm = config.embeddingModel && config.rerankingModel
    ? new LlamaCpp({ embedModel: config.embeddingModel, rerankModel: config.rerankingModel, modelCacheDir: join(config.database, 'models') }) : null
  const scope = 'collection IN (' + config.collections.map(sql).join(',') + ')'
  const collectionFilter = (collection: string): string => {
    if (!config.collections.includes(collection)) throw new Error('Document collection is outside the project')
    return 'collection = ' + sql(collection)
  }
  let indexing = false
  return {
    async replace(collection: string, documents: IndexedDocument[], progress: (completed: number, total: number) => void = () => {}, checkpoint: () => Promise<void> = async () => {}) {
      const where = collectionFilter(collection)
      if (indexing) throw new Error('Document indexing is already running')
      // ponytail: materialize at most 64 MiB/20k chunks per root; use native streaming ingestion if larger roots are required.
      if (documents.length > 10000 || documents.reduce((bytes, doc) => bytes + Buffer.byteLength(doc.content), 0) > 64 * 1024 * 1024) throw new Error('Document root exceeds index size limit; select a smaller root')
      indexing = true
      try {
        await table.checkoutLatest()
        const previous: Chunk[] = await table.query().where(where).limit(20001).toArray()
        if (previous.length > 20000) throw new Error('Existing document index exceeds chunk limit')
        const cache = new Map(previous.filter(row => row.embedded).map(row => [row.hash, Array.from(row.vector)]))
        const rows: Chunk[] = [], indexedAt = new Date().toISOString()
        for (const doc of documents) {
          await checkpoint()
          for (const chunk of await chunkDocumentAsync(doc.content, undefined, undefined, undefined, doc.path, 'auto')) {
            const text = doc.path + '\n' + chunk.text, hash = createHash('sha256').update(text).digest('hex'), cached = cache.get(hash)
            rows.push({ collection, path: doc.path, text, hash, revision: doc.revision, indexedAt, pos: chunk.pos, line: doc.content.slice(0, chunk.pos).split('\n').length, embedded: Boolean(cached), vector: cached ?? Array(2560).fill(0) })
            if (rows.length > 20000) throw new Error('Document root exceeds chunk limit')
          }
        }
        const missing = rows.filter(row => !row.embedded)
        progress(0, missing.length)
        const embeddingStart = performance.now()
        if (llm) for (let offset = 0; offset < missing.length; offset += 16) {
          await checkpoint()
          const batch = missing.slice(offset, offset + 16)
          const vectors = await llm.embedBatch(batch.map(row => formatDocForEmbedding(row.text, row.path, config.embeddingModel)))
          if (vectors.length !== batch.length || vectors.some((value: { embedding: number[] } | null) => !value || value.embedding.length !== 2560)) throw new Error('Document embedding is incomplete or incompatible')
          batch.forEach((row, index) => { row.vector = vectors[index].embedding; row.embedded = true })
          progress(offset + batch.length, missing.length)
        }
        const embeddingMs = performance.now() - embeddingStart, indexStart = performance.now()
        await checkpoint()
        if (rows.length) await table.mergeInsert(['collection', 'path', 'pos']).whenMatchedUpdateAll().whenNotMatchedInsertAll().whenNotMatchedBySourceDelete({ where }).execute(rows)
        else await table.delete(where)
        return { documents: documents.length, chunks: rows.length, indexedAt, embeddingMs, indexMs: performance.now() - indexStart, mode: llm ? 'hybrid' : 'lexical' }
      } finally { indexing = false }
    },
    async search(query: string, limit = 5) {
      if (typeof query !== 'string' || !query.trim() || query.length > 1000 || query.includes('\0') || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid document query')
      await table.checkoutLatest()
      if (!(await table.query().where(scope).limit(1).toArray()).length) return { mode: 'unindexed', modelError: null, hits: [] }
      let hits: Chunk[], mode = 'lexical', modelError: string | null = null
      try {
        if (!llm || (await table.query().where(scope + ' AND embedded = false').limit(1).toArray()).length) throw new Error('Semantic models or embeddings unavailable')
        const vector = await llm.embed(formatQueryForEmbedding(query, config.embeddingModel))
        if (!vector || vector.embedding.length !== 2560) throw new Error('Document embedding unavailable')
        hits = await table.vectorSearch(vector.embedding).where(scope).fullTextSearch(query).rerank(fusion).limit(50).toArray()
        const ranked = await llm.rerank(query, hits.map((hit, index) => ({ file: String(index), text: hit.text })))
        if (ranked.model === 'fallback') throw new Error('Document reranker unavailable')
        hits = ranked.results.map((result: { index: number }) => hits[result.index]!)
        mode = 'hybrid'
      } catch (error) {
        modelError = String(error).slice(0, 300)
        hits = await table.query().where(scope).fullTextSearch(query).limit(50).toArray()
      }
      const seen = new Set<string>()
      return { mode, modelError, hits: hits.filter(hit => {
        const key = hit.collection + '\0' + hit.path
        if (seen.has(key)) return false
        seen.add(key); return true
      }).slice(0, limit).map(({ vector: _vector, hash: _hash, ...hit }) => hit) }
    },
    async get(collection: string, path: string) {
      const where = collectionFilter(collection)
      await table.checkoutLatest()
      const rows: Chunk[] = await table.query().where(where + ' AND path = ' + sql(path)).limit(1).toArray()
      return rows.length ? { collection, path, revision: rows[0]!.revision, indexedAt: rows[0]!.indexedAt } : null
    },
    async close() { await llm?.dispose(); table.close(); connection.close() }
  }
}
