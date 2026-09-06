// Measures whole-file source retrieval; does not score generated answers or code-graph reasoning.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, createReadStream } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir, cpus, totalmem, release } from 'node:os'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const { values } = parseArgs({ options: { package: { type: 'string' }, 'lance-package': { type: 'string' }, 'production-index': { type: 'boolean' }, evidence: { type: 'string' }, corpus: { type: 'string' }, repetitions: { type: 'string', default: '1' }, 'embedding-model': { type: 'string' }, 'reranking-model': { type: 'string' }, 'expansion-model': { type: 'string' }, hybrid: { type: 'boolean' }, 'source-commit': { type: 'string' } } })
assert(!values['production-index'] || values['lance-package'], '--production-index requires --lance-package')
assert(values.package && values.evidence, '--package and --evidence are required')
assert(!values['lance-package'] || (values['embedding-model'] && !values.hybrid && !values['expansion-model']), 'Lance comparison uses native RRF and pinned local models')
assert(!values.hybrid || values['embedding-model'], '--hybrid requires --embedding-model')
assert(!values['reranking-model'] || values.hybrid || values['lance-package'], '--reranking-model requires --hybrid or --lance-package')
assert(!values['expansion-model'] || (values.hybrid && values['reranking-model']), '--expansion-model requires --hybrid and --reranking-model')
assert(!values['source-commit'] || /^[a-f0-9]{40}$/.test(values['source-commit']), 'Use a full source commit hash')
const repository = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const corpusPath = values.corpus ? resolve(values.corpus) : join(repository, 'tests/fixtures/project-knowledge.json')
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'))
const acceptance = corpus.schemaVersion === 2
assert.equal(corpus.questions.length, acceptance ? 40 : 50)
assert.equal(new Set(corpus.questions.map(row => row.id)).size, corpus.questions.length)
const repetitions = Number(values.repetitions)
assert(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 10)
if (acceptance) {
  assert.equal(corpus.traps.length, 10)
  assert.equal(new Set(corpus.traps.map(row => row.id)).size, 10)
  assert.equal(values['source-commit'], corpus.sourceCommit, 'Acceptance requires the frozen source commit')
}
const root = mkdtempSync(join(tmpdir(), 'donwells-qmd-corpus-'))
const docs = join(root, 'checkout'); mkdirSync(docs)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const manifest = []
let store, lance, table, llm, rerank, formatQuery, nativeIndex
let retrievalTrace
const sql = value => "'" + value.replaceAll("'", "''") + "'"
const referencePrefix = values['lance-package'] ? 'lance://project/' : 'qmd://project/'
const report = { environment: { platform: process.platform, arch: process.arch, node: process.version, osRelease: release(), cpu: cpus()[0]?.model, memoryBytes: totalmem(), externalProcessesControlled: false, thermalAndPowerState: 'uncontrolled', cacheCondition: 'Fresh derived index, existing downloaded model files; filesystem cache not evicted. Repetitions share one process and loaded models.' }, mode: values['expansion-model'] ? 'expanded-hybrid-with-rerank' : values.hybrid ? values['reranking-model'] ? 'hybrid-with-rerank' : 'hybrid-without-rerank' : values['embedding-model'] ? 'vector' : 'lexical', metric: 'macro gold source-file recall in first five results', corpusSha256: hash(readFileSync(corpusPath)), runnerSha256: hash(readFileSync(new URL(import.meta.url))), corpusVersion: corpus.schemaVersion, repetitions, rows: [] }
try {
  const sourceCommit = values['source-commit']
  const tracked = execFileSync('git', sourceCommit ? ['ls-tree', '-rz', '--name-only', sourceCommit, '--', 'src', 'docs'] : ['ls-files', '-z', 'src', 'docs'], { cwd: repository }).toString().split('\0').filter(path => /\.(md|ts|tsx|css|json)$/.test(path))
  for (const path of tracked) {
    const bytes = sourceCommit ? execFileSync('git', ['show', `${sourceCommit}:${path}`], { cwd: repository, maxBuffer: 4 * 1024 * 1024 }) : readFileSync(join(repository, path))
    if (bytes.length > 2 * 1024 * 1024) continue
    mkdirSync(dirname(join(docs, path)), { recursive: true })
    writeFileSync(join(docs, path), bytes)
    manifest.push({ path, sha256: hash(bytes) })
  }
  for (const row of corpus.questions) for (const path of row.expectedSources) assert(manifest.some(file => file.path === path), `Missing expected source: ${path}`)
  const packagePath = resolve(values.package)
  report.packageVersion = JSON.parse(readFileSync(join(packagePath, 'package.json'), 'utf8')).version
  assert.equal(report.packageVersion, '2.8.3')
  const { createStore } = await import(pathToFileURL(join(packagePath, 'dist/index.js')).href)
  if (acceptance && !values['lance-package']) {
    // Separate native processes avoid QMD's module-global collection configuration.
    const seedScript = `import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; import {pathToFileURL} from 'node:url';
      const {createStore}=await import(pathToFileURL(process.argv[1]).href);
      const input=JSON.parse(readFileSync(process.argv[2],'utf8'));
      const store=await createStore(input.options);
      try { await store.update(); for(const trap of input.traps) assert((await store.searchLex(trap.marker)).some(hit=>hit.filepath==='qmd://project/'+trap.path)); }
      finally { await store.close(); }`
    for (const scope of new Set(corpus.traps.map(trap => trap.scope))) {
      const traps = corpus.traps.filter(trap => trap.scope === scope)
      const foreign = join(root, scope)
      for (const trap of traps) {
        assert(!manifest.some(file => readFileSync(join(docs, file.path), 'utf8').includes(trap.marker)), 'Trap marker already in source corpus')
        mkdirSync(dirname(join(foreign, trap.path)), { recursive: true })
        writeFileSync(join(foreign, trap.path), `# Private routing decision\n${trap.marker}\nPrivate routing uses the ${scope} configuration.\n`)
      }
      const input = join(root, scope + '.json')
      writeFileSync(input, JSON.stringify({ traps, options: { dbPath: join(root, scope + '.sqlite'), config: { collections: { project: { path: foreign, pattern: '**/*.{md,ts,tsx}' } } } } }))
      execFileSync(process.execPath, ['--input-type=module', '-e', seedScript, join(packagePath, 'dist/index.js'), input], { timeout: 30_000, maxBuffer: 1024 * 1024 })
    }
    report.foreignFixturesIndexedAndRetrievable = true
  }
  const model = values['embedding-model'] ? resolve(values['embedding-model']) : undefined
  const reranker = values['reranking-model'] ? resolve(values['reranking-model']) : undefined
  const expansion = values['expansion-model'] ? resolve(values['expansion-model']) : undefined
  if (model) report.embeddingParallelism = process.env.QMD_EMBED_PARALLELISM ?? 'automatic'
  for (const [path, key] of [[model, 'modelSha256'], [reranker, 'rerankerSha256'], [expansion, 'expansionSha256']]) {
    if (!path) continue
    const digest = createHash('sha256')
    for await (const bytes of createReadStream(path)) digest.update(bytes)
    report[key] = digest.digest('hex')
  }
  let start = performance.now()
  if (values['production-index']) {
    const modulePath = join(repository, 'src/main/project-document-index.ts')
    report.engineSha256 = hash(readFileSync(modulePath))
    const { openProjectDocumentIndex } = await import(pathToFileURL(modulePath).href)
    const config = { qmdPackage: packagePath, lancePackage: resolve(values['lance-package']), database: join(root, 'native-index'), embeddingModel: model, rerankingModel: reranker }
    const foreign = await openProjectDocumentIndex({ ...config, collections: [...new Set(corpus.traps.map(trap => hash(trap.scope)))] })
    try {
      for (const scope of new Set(corpus.traps.map(trap => trap.scope))) {
        const traps = corpus.traps.filter(trap => trap.scope === scope)
        await foreign.replace(hash(scope), traps.map(trap => ({ path: trap.path, content: trap.marker, revision: hash(trap.marker) })))
        for (const trap of traps) assert((await foreign.search(trap.marker)).hits.some(hit => hit.collection === hash(scope) && hit.path === trap.path))
      }
    } finally { await foreign.close() }
    nativeIndex = await openProjectDocumentIndex({ ...config, collections: [hash('project')] })
    report.index = await nativeIndex.replace(hash('project'), manifest.map(file => ({ path: file.path, content: readFileSync(join(docs, file.path), 'utf8'), revision: file.sha256 })), (completed, total) => { if (completed % 160 === 0 || completed === total) console.error(JSON.stringify({ embedded: completed, total })) })
    report.embeddingMs = report.index.embeddingMs; report.indexMs = report.index.indexMs
    report.foreignFixturesIndexedAndRetrievable = true; report.mode = 'production-lancedb-native-hybrid-local-rerank'
  } else if (values['lance-package']) {
    const lancePath = resolve(values['lance-package'])
    report.lanceVersion = JSON.parse(readFileSync(join(lancePath, 'package.json'), 'utf8')).version
    assert.equal(report.lanceVersion, '0.38.0')
    const { connect, Index, rerankers } = await import(pathToFileURL(join(lancePath, 'dist/index.js')).href)
    const { chunkDocumentAsync } = await import(pathToFileURL(join(packagePath, 'dist/store.js')).href)
    const { LlamaCpp, formatDocForEmbedding, formatQueryForEmbedding } = await import(pathToFileURL(join(packagePath, 'dist/llm.js')).href)
    formatQuery = formatQueryForEmbedding
    llm = new LlamaCpp({ embedModel: model, ...(reranker ? { rerankModel: reranker } : {}), modelCacheDir: join(root, 'models') })
    const { getASTBreakPoints } = await import(pathToFileURL(join(packagePath, 'dist/ast.js')).href)
    assert((await getASTBreakPoints('export function probe() { return 1; }', 'probe.ts')).some(point => point.type.startsWith('ast:')), 'Native chunker grammar must be available')
    const chunks = []
    for (const file of manifest) {
      const body = readFileSync(join(docs, file.path), 'utf8')
      for (const chunk of await chunkDocumentAsync(body, undefined, undefined, undefined, file.path, 'auto')) {
        chunks.push({ scope: 'project', path: file.path, text: file.path + '\n' + chunk.text, pos: chunk.pos })
      }
    }
    for (const trap of corpus.traps ?? []) chunks.push({ scope: trap.scope, path: trap.path, text: trap.marker, pos: 0 })
    report.mode = reranker ? 'lancedb-native-hybrid-local-rerank' : 'lancedb-native-hybrid-rrf'; report.chunking = 'Existing QMD AST-aware chunker; default sizes; path-prefixed text'
    report.embeddingMs = 0
    for (let offset = 0; offset < chunks.length; offset += 16) {
      start = performance.now()
      const batch = chunks.slice(offset, offset + 16)
      const vectors = await llm.embedBatch(batch.map(chunk => formatDocForEmbedding(chunk.text, chunk.path, model)))
      assert(vectors.every(Boolean), 'Missing embedding')
      batch.forEach((chunk, index) => { chunk.vector = vectors[index].embedding })
      report.embeddingMs += performance.now() - start
      if (offset % 160 === 0) console.error(JSON.stringify({ embedded: offset + batch.length, total: chunks.length }))
    }
    start = performance.now()
    lance = await connect(join(root, 'lance'))
    table = await lance.createTable('documents', chunks)
    await table.createIndex('text', { config: Index.fts() })
    rerank = await rerankers.RRFReranker.create()
    report.index = { files: manifest.length, chunks: chunks.length }; report.indexMs = performance.now() - start
    for (const trap of corpus.traps ?? []) {
      const hits = await table.query().where('scope = ' + sql(trap.scope)).fullTextSearch(trap.marker).toArray()
      assert(hits.some(hit => hit.text === trap.marker), 'Foreign fixture must actually be indexed')
    }
    report.foreignFixturesIndexedAndRetrievable = true
  } else {
    store = await createStore({ dbPath: join(root, 'index.sqlite'), config: { ...(model ? { models: { embed: model, ...(reranker ? { rerank: reranker } : {}), ...(expansion ? { generate: expansion } : {}) } } : {}), collections: { project: { path: docs, pattern: '**/*.{md,ts,tsx,css,json}' } } } })
    report.index = await store.update()
    report.indexMs = performance.now() - start
    if (model) {
    start = performance.now()
    report.embedding = await store.embed({ collection: 'project' })
    report.embeddingMs = performance.now() - start
    }
  }
  const search = async query => {
    if (nativeIndex) {
      const result = await nativeIndex.search(query); assert.equal(result.mode, 'hybrid', result.modelError)
      return result.hits.map(hit => ({ filepath: referencePrefix + hit.path }))
    }
    if (table) {
      const vector = await llm.embed(formatQuery(query, model)); assert(vector)
      let hits = await table.vectorSearch(vector.embedding).where("scope = 'project'").fullTextSearch(query).rerank(rerank).limit(50).toArray()
      retrievalTrace = { candidates: hits.map(hit => ({ path: hit.path, pos: hit.pos })) }
      if (reranker) {
        const ranked = await llm.rerank(query, hits.map((hit, index) => ({ file: String(index), text: hit.text })))
        assert.notEqual(ranked.model, 'fallback', 'Reranker must actually execute')
        retrievalTrace.ranked = ranked.results.map(result => ({ path: hits[result.index].path, pos: hits[result.index].pos, score: result.score }))
        hits = ranked.results.map(result => hits[result.index])
      }
      const seen = new Set()
      return hits.filter(hit => !seen.has(hit.path) && seen.add(hit.path)).slice(0, 5).map(hit => ({ filepath: referencePrefix + hit.path, path: hit.path }))
    }
    return values.hybrid
    ? store.search({ ...(expansion ? { query } : { queries: [{ type: 'lex', query }, { type: 'vec', query }] }), collections: ['project'], rerank: Boolean(reranker), limit: 5 })
    : model ? store.searchVector(query, { collection: 'project', limit: 5 }) : store.searchLex(query, { collection: 'project', limit: 5 })
  }
  const get = async reference => {
    if (nativeIndex) {
      assert(reference.startsWith(referencePrefix))
      return await nativeIndex.get(hash('project'), reference.slice(referencePrefix.length)) ?? { error: 'Source unavailable in this project' }
    }
    if (!table) return store.get(reference, { includeBody: true })
    assert(reference.startsWith(referencePrefix))
    const hits = await table.query().where("scope = 'project' AND path = " + sql(reference.slice(referencePrefix.length))).toArray()
    return hits.length ? hits.map(({ vector, ...hit }) => hit) : { error: 'Source unavailable in this project' }
  }
  const reference = hit => values.hybrid ? hit.file : hit.filepath
  if (nativeIndex) {
    start = performance.now(); await search(corpus.questions[0].question); report.coldFirstQueryMs = performance.now() - start
    report.warmRepetitions = repetitions
  }
  for (let repetition = 1; repetition <= repetitions; repetition++) for (const row of corpus.questions) {
    start = performance.now()
    const hits = await search(row.question)
    const elapsedMs = performance.now() - start
    const sources = hits.map(hit => reference(hit).slice(referencePrefix.length))
    const rank = sources.findIndex(path => row.expectedSources.includes(path)) + 1
    assert(row.expectedSources.length > 0 && row.expectedSources.length <= 5)
    const recall = new Set(sources.filter(path => row.expectedSources.includes(path))).size / row.expectedSources.length
    for (const hit of hits) assert(!('error' in await get(reference(hit))), 'Unresolvable result citation')
    report.rows.push({ id: row.id, kind: row.kind, repetition, rank: rank || null, recall, elapsedMs, sources, ...(retrievalTrace ? { retrievalTrace } : {}) })
    if (report.rows.length % 10 === 0) console.error(JSON.stringify({ completed: report.rows.length, total: corpus.questions.length * repetitions }))
  }
  report.recallAt5 = report.rows.reduce((sum, row) => sum + row.recall, 0) / report.rows.length
  const exact = report.rows.filter(row => row.kind === 'exact')
  report.exactRecallAt5 = exact.reduce((sum, row) => sum + row.recall, 0) / exact.length
  report.citationsResolvable = true
  if (acceptance) {
    report.traps = []
    for (const trap of corpus.traps) {
      const hits = await search(trap.question)
      const direct = await get(referencePrefix + trap.path)
      const batch = (table || nativeIndex) ? await Promise.all([get(referencePrefix + trap.path)]) : await store.multiGet(referencePrefix + trap.path, { includeBody: true })
      const leaked = JSON.stringify([hits, direct, batch]).includes(trap.marker)
      report.traps.push({ id: trap.id, scope: trap.scope, leaked, sources: hits.map(reference) })
    }
    report.trapLeakage = report.traps.filter(trap => trap.leaked).length
    report.retrievalGatePassed = report.recallAt5 >= .9 && report.exactRecallAt5 === 1 && report.trapLeakage === 0
    if (!report.retrievalGatePassed) process.exitCode = 1
  }
  report.meanReciprocalRank = report.rows.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) / report.rows.length
  report.sourceCommit = sourceCommit ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
  report.sourceManifest = manifest
  report.maxRssKiB = process.resourceUsage().maxRSS
} catch (error) {
  report.error = String(error)
  process.exitCode = 1
} finally {
  await nativeIndex?.close()
  await store?.close()
  await llm?.dispose()
  table?.close(); lance?.close()
  rmSync(root, { recursive: true, force: true })
}
writeFileSync(resolve(values.evidence), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({ questions: report.rows.length, files: manifest.length, recallAt5: report.recallAt5, meanReciprocalRank: report.meanReciprocalRank, indexMs: report.indexMs }))
