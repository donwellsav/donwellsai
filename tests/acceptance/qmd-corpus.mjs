// Measures whole-file source retrieval; does not score generated answers or code-graph reasoning.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, createReadStream } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const { values } = parseArgs({ options: { package: { type: 'string' }, evidence: { type: 'string' }, 'embedding-model': { type: 'string' }, hybrid: { type: 'boolean' }, 'source-commit': { type: 'string' } } })
assert(values.package && values.evidence, '--package and --evidence are required')
assert(!values.hybrid || values['embedding-model'], '--hybrid requires --embedding-model')
assert(!values['source-commit'] || /^[a-f0-9]{40}$/.test(values['source-commit']), 'Use a full source commit hash')
const repository = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const corpusPath = join(repository, 'tests/fixtures/project-knowledge.json')
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'))
assert.equal(corpus.questions.length, 50)
assert.equal(new Set(corpus.questions.map(row => row.id)).size, 50)
const root = mkdtempSync(join(tmpdir(), 'donwells-qmd-corpus-'))
const docs = join(root, 'checkout'); mkdirSync(docs)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const manifest = []
let store
const report = { mode: values.hybrid ? 'hybrid-without-rerank' : values['embedding-model'] ? 'vector' : 'lexical', metric: 'expected whole source file in first five results', corpusSha256: hash(readFileSync(corpusPath)), rows: [] }
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
  const model = values['embedding-model'] ? resolve(values['embedding-model']) : undefined
  if (model) {
    report.embeddingParallelism = process.env.QMD_EMBED_PARALLELISM ?? 'automatic'
    const digest = createHash('sha256')
    for await (const bytes of createReadStream(model)) digest.update(bytes)
    report.modelSha256 = digest.digest('hex')
  }
  store = await createStore({ dbPath: join(root, 'index.sqlite'), config: { ...(model ? { models: { embed: model } } : {}), collections: { project: { path: docs, pattern: '**/*.{md,ts,tsx,css,json}' } } } })
  let start = performance.now()
  report.index = await store.update()
  report.indexMs = performance.now() - start
  if (model) {
    start = performance.now()
    report.embedding = await store.embed({ collection: 'project' })
    report.embeddingMs = performance.now() - start
  }
  for (const row of corpus.questions) {
    start = performance.now()
    const hits = values.hybrid
      ? await store.search({ queries: [{ type: 'lex', query: row.question }, { type: 'vec', query: row.question }], collections: ['project'], rerank: false, limit: 5 })
      : model
      ? await store.searchVector(row.question, { collection: 'project', limit: 5 })
      : await store.searchLex(row.question, { collection: 'project', limit: 5 })
    const sources = hits.map(hit => (values.hybrid ? hit.file : hit.filepath).replace(/^qmd:\/\/project\//, ''))
    const rank = sources.findIndex(path => row.expectedSources.includes(path)) + 1
    report.rows.push({ id: row.id, kind: row.kind, rank: rank || null, elapsedMs: performance.now() - start, sources })
  }
  report.recallAt5 = report.rows.filter(row => row.rank !== null).length / report.rows.length
  report.meanReciprocalRank = report.rows.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) / report.rows.length
  report.sourceCommit = sourceCommit ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
  report.sourceManifest = manifest
  report.maxRssKiB = process.resourceUsage().maxRSS
} catch (error) {
  report.error = String(error)
  process.exitCode = 1
} finally {
  await store?.close()
  rmSync(root, { recursive: true, force: true })
}
writeFileSync(resolve(values.evidence), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({ questions: report.rows.length, files: manifest.length, recallAt5: report.recallAt5, meanReciprocalRank: report.meanReciprocalRank, indexMs: report.indexMs }))
