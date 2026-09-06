// Isolated engine admission trial. Does not modify user documents, configuration, or models.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { createHash } from 'node:crypto'

const { values } = parseArgs({ options: { package: { type: 'string' }, evidence: { type: 'string' } } })
assert(values.package && values.evidence, '--package and --evidence are required')
const packagePath = resolve(values.package)
const metadata = JSON.parse(readFileSync(join(packagePath, 'package.json'), 'utf8'))
assert.equal(metadata.name, '@tobilu/qmd')
assert.equal(metadata.version, '2.8.3')
const { createStore } = await import(pathToFileURL(join(packagePath, 'dist/index.js')).href)
const root = mkdtempSync(join(tmpdir(), 'donwells-qmd-trial-'))
const docs = join(root, 'docs'), foreign = join(root, 'foreign')
mkdirSync(docs); mkdirSync(foreign)
const put = (path, text) => writeFileSync(path, text)
const report = { version: metadata.version, entrySha256: createHash('sha256').update(readFileSync(join(packagePath, 'dist/index.js'))).digest('hex'), mode: 'lexical', checks: {}, timingsMs: {} }
let store, unrelated
const timed = async (name, action) => {
  const start = performance.now()
  try { return await action() } finally { report.timingsMs[name] = performance.now() - start }
}
try {
  put(join(docs, 'terminal.md'), '# Terminal workspace\nTerminals use graphiteamber as the primary surface.\n')
  put(join(docs, 'mémoire.md'), '# Mémoire\nProject decisions use sapphirerecall.\n')
  put(join(foreign, 'outside.md'), '# Private outside project\nForeign canary obsidianboundary.\n')
  symlinkSync(join(foreign, 'outside.md'), join(docs, 'linked.md'))
  mkdirSync(join(docs, 'dist')); put(join(docs, 'dist/generated.md'), '# Generated\nGenerated canary garnetgenerated.\n')
  put(join(docs, '.secrets.md'), '# Hidden\nHidden canary hiddenruby.\n')
  put(join(docs, 'credentials.md'), '# Excluded\nExcluded canary emeraldexcluded.\n')
  store = await createStore({ dbPath: join(root, 'project.sqlite'), config: { collections: { project: { path: docs, pattern: '**/*.md', ignore: ['credentials.md'] } } } })
  unrelated = await createStore({ dbPath: join(root, 'foreign.sqlite'), config: { collections: { other: { path: foreign, pattern: '**/*.md' } } } })
  await timed('firstIndex', () => store.update())
  await unrelated.update()
  const hits = await timed('coldSearch', () => store.searchLex('graphiteamber'))
  assert.equal(hits.length, 1)
  assert.equal((await timed('warmSearch', () => store.searchLex('graphiteamber'))).length, 1)
  assert.equal((await store.searchLex('sapphirerecall')).length, 1)
  for (const query of ['obsidianboundary', 'garnetgenerated', 'hiddenruby', 'emeraldexcluded']) assert.equal((await store.searchLex(query)).length, 0, query)
  report.checks.exclusionsAndSymlink = true
  const outside = (await unrelated.searchLex('obsidianboundary'))[0]
  assert(outside)
  assert('error' in await store.get(outside.filepath, { includeBody: true }))
  assert.equal((await store.multiGet('qmd://other/*', { includeBody: true })).docs.length, 0)
  report.checks.separateIndexLookupIsolation = true
  put(join(docs, 'terminal.md'), '# Terminal workspace\nTerminals now use silverrevision.\n')
  await timed('editIndex', () => store.update())
  assert.equal((await store.searchLex('graphiteamber')).length, 0)
  assert.equal((await store.searchLex('silverrevision')).length, 1)
  renameSync(join(docs, 'terminal.md'), join(docs, 'renamed.md'))
  await store.update()
  assert((await store.searchLex('silverrevision'))[0].filepath.endsWith('/renamed.md'))
  assert('error' in await store.get(hits[0].filepath))
  rmSync(join(docs, 'renamed.md'))
  await timed('deleteIndex', () => store.update())
  assert.equal((await store.searchLex('silverrevision')).length, 0)
  report.checks.editRenameDelete = true
  await store.close(); store = null
  store = await createStore({ dbPath: join(root, 'project.sqlite') })
  assert.equal((await store.searchLex('sapphirerecall')).length, 1)
  report.checks.reopenUnicode = true
  const damaged = join(root, 'damaged.sqlite')
  const original = Buffer.from('This is not a SQLite index. Preserve the original bytes.')
  writeFileSync(damaged, original)
  await assert.rejects(() => createStore({ dbPath: damaged }))
  assert.deepEqual(readFileSync(damaged), original)
  report.checks.corruptIndexRefusedWithoutOverwrite = true
  await store.close(); store = null
  store = await createStore({ dbPath: join(root, 'project.sqlite'), config: { models: { embed: join(root, 'missing-embedding.gguf') }, collections: { project: { path: docs, pattern: '**/*.md', ignore: ['credentials.md'] } } } })
  let embeddingError, embeddingResult
  try { embeddingResult = await store.embed({ collection: 'project' }) }
  catch (error) { embeddingError = String(error) }
  assert(embeddingError || embeddingResult?.errors > 0, 'An unavailable embedding model must not report success')
  assert.equal((await store.searchLex('sapphirerecall')).length, 1)
  report.checks.lexicalAfterMissingModel = true
  report.unavailableModel = embeddingError ? 'rejected' : 'reported-errors'
  await store.close(); await unrelated.close(); store = null; unrelated = null
  const configA = join(root, 'a.yml'), configB = join(root, 'b.yml')
  writeFileSync(configA, JSON.stringify({ collections: { project: { path: docs, pattern: '**/*.md' } } }))
  writeFileSync(configB, JSON.stringify({ collections: { other: { path: foreign, pattern: '**/*.md' } } }))
  const beforeB = readFileSync(configB, 'utf8')
  store = await createStore({ dbPath: join(root, 'a.sqlite'), configPath: configA })
  unrelated = await createStore({ dbPath: join(root, 'b.sqlite'), configPath: configB })
  await store.addCollection('added-to-a', { path: docs, pattern: '**/*.md' })
  report.sharedProcessConfigIsolation = readFileSync(configB, 'utf8') === beforeB
  report.productionAdmitted = false
  report.lexicalChecksPassed = true
} catch (error) {
  report.lexicalChecksPassed = false; report.error = String(error); process.exitCode = 1
} finally {
  await store?.close(); await unrelated?.close()
  rmSync(root, { recursive: true, force: true })
  writeFileSync(resolve(values.evidence), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify(report))
}
