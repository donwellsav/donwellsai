import { expect, it } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, symlink, rename, realpath, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { openProjectDocumentIndex } from '../src/main/project-document-index'
import { ProjectTools } from '../src/main/project-tools'
import { createDocumentDefinition } from '../src/main/project-documents'

it.skipIf(!process.env.DONWELLS_LANCE_PACKAGE || !process.env.DONWELLS_QMD_PACKAGE)('updates native collections without leaking or deleting sibling sources and exposes lexical fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'donwells-documents-'))
  const a = 'a'.repeat(64), b = 'b'.repeat(64), shared = 'c'.repeat(64)
  const config = { qmdPackage: process.env.DONWELLS_QMD_PACKAGE!, lancePackage: process.env.DONWELLS_LANCE_PACKAGE!, database: root }
  const first = await openProjectDocumentIndex({ ...config, collections: [a, shared] })
  const second = await openProjectDocumentIndex({ ...config, collections: [b, shared] })
  try {
    await first.replace(a, [{ path: 'mémoire.md', content: 'copperorchard', revision: 'one' }])
    await second.replace(b, [{ path: 'private.md', content: 'violetmeadow', revision: 'one' }])
    await first.replace(shared, [{ path: 'reference.md', content: 'sharedreference', revision: 'one' }])
    expect((await first.search('copperorchard'))).toMatchObject({ mode: 'lexical', hits: [{ path: 'mémoire.md' }] })
    expect((await second.search('copperorchard')).hits).toEqual([])
    expect((await second.search('sharedreference')).hits).toHaveLength(1)
    const database = join(root, 'corrupt')
    const corrupt = await openProjectDocumentIndex({ ...config, database, collections: [a] })
    await corrupt.replace(a, [{ path: 'one.md', content: 'corruptfixture', revision: 'one' }]); await corrupt.close()
    const manifests = join(database, 'documents.lance', '_versions')
    for (const name of await readdir(manifests)) if (name.endsWith('.manifest')) await writeFile(join(manifests, name), 'invalid native manifest')
    await expect((async () => {
      const broken = await openProjectDocumentIndex({ ...config, database, collections: [a] })
      try { await broken.search('corruptfixture') } finally { await broken.close() }
    })()).rejects.toThrow()
    await expect(first.get(b, 'private.md')).rejects.toThrow('outside')
    await first.replace(a, [{ path: 'renamed.md', content: 'changedorchard', revision: 'two' }])
    expect(await first.get(a, 'mémoire.md')).toBeNull()
    expect((await first.search('copperorchard')).hits).toEqual([])
    expect(await first.get(a, 'renamed.md')).toMatchObject({ revision: 'two' })
    expect((await second.search('violetmeadow')).hits).toHaveLength(1)
    await first.replace(a, [])
    expect(await first.get(a, 'renamed.md')).toBeNull()
    expect((await second.search('sharedreference')).hits).toHaveLength(1)
  } finally { await first.close(); await second.close(); await rm(root, { recursive: true, force: true }) }
}, 30000)

it.skipIf(!process.env.DONWELLS_LANCE_PACKAGE || !process.env.DONWELLS_QMD_PACKAGE)('serves confined current sources, shared references and cancellable indexing over native MCP', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'donwells-document-service-')))
  const [a, linked, b, references] = ['a', 'linked', 'b', 'references'].map(name => join(root, name))
  for (const path of [a!, linked!, b!, references!]) await mkdir(path)
  await writeFile(join(a!, 'mémoire.md'), 'copperorchard\n')
  await writeFile(join(linked!, 'linked.md'), 'amberfield\n')
  await writeFile(join(b!, 'private.md'), 'violetmeadow\n')
  await writeFile(join(references!, 'shared.md'), 'sharedreference\n')
  await writeFile(join(a!, 'credentials.json'), '{"secret":"neverindexsecret"}')
  await writeFile(join(a!, '.hidden.md'), 'neverindexhidden')
  await mkdir(join(a!, '.git'))
  await writeFile(join(a!, '.gitignore'), 'ignored.md\n')
  await writeFile(join(a!, 'ignored.md'), 'neverindexignored')
  await mkdir(join(a!, 'out')); await writeFile(join(a!, 'out/generated.md'), 'neverindexgenerated')
  await symlink(join(b!, 'private.md'), join(a!, 'leak.md'))
  const tools = new ProjectTools(async path => {
    if (![a, linked, b].includes(path)) throw new Error('Unregistered checkout')
    return { path, projectPath: path === linked ? a! : path }
  }, [createDocumentDefinition({ program: process.env.DONWELLS_DOCUMENT_TEST_EXECUTABLE ?? process.execPath, worker: process.env.DONWELLS_DOCUMENT_TEST_WORKER ?? join(process.cwd(), 'out/main/project-document-worker.js'), cache: join(root, 'cache'), qmdPackage: process.env.DONWELLS_QMD_PACKAGE!, lancePackage: process.env.DONWELLS_LANCE_PACKAGE!, embeddingModel: join(root, 'missing-embedding.gguf'), rerankingModel: join(root, 'missing-reranker.gguf'), references: JSON.stringify({ [a!]: [references] }) })])
  const call = async (path: string, operation: string, input = {}): Promise<any> => {
    const result: any = await tools.call(path, 'documents', operation, input)
    if (result.isError) throw new Error(JSON.stringify(result.content))
    return result.structuredContent
  }
  const rebuild = async (path: string) => {
    await call(path, 'index')
    await expect.poll(async () => (await call(path, 'status')).phase, { timeout: 15000 }).toBe('ready')
  }
  try {
    await rebuild(a!); await rebuild(linked!); await rebuild(b!)
    expect(await call(a!, 'status')).toMatchObject({ mode: 'lexical', modelBytes: 0 })
    const hit = (await call(a!, 'query', { query: 'copperorchard' })).hits[0]
    expect(hit).toMatchObject({ path: 'mémoire.md', stale: false })
    expect((await call(linked!, 'query', { query: 'copperorchard' })).hits).toEqual([])
    expect((await call(linked!, 'query', { query: 'sharedreference' })).hits).toHaveLength(1)
    expect((await call(b!, 'query', { query: 'sharedreference' })).hits).toEqual([])
    for (const query of ['neverindexsecret', 'neverindexhidden', 'neverindexignored', 'neverindexgenerated', 'violetmeadow']) expect((await call(a!, 'query', { query })).hits).toEqual([])
    await expect(call(b!, 'get', { id: hit.id })).rejects.toThrow('another checkout')
    await expect(call(a!, 'query', { query: 'copperorchard', root: b })).rejects.toThrow('not permitted')
    await writeFile(join(a!, 'mémoire.md'), 'currentorchard\n')
    expect(await call(a!, 'get', { id: hit.id })).toMatchObject({ content: 'currentorchard\n', stale: true })
    expect((await call(a!, 'multiGet', { ids: [hit.id] })).documents).toHaveLength(1)
    await rename(join(a!, 'mémoire.md'), join(a!, 'renamed.md'))
    expect((await call(a!, 'query', { query: 'copperorchard' })).hits).toEqual([])
    await rebuild(a!)
    expect((await call(a!, 'query', { query: 'currentorchard' })).hits[0]).toMatchObject({ path: 'renamed.md', stale: false })
    for (let i = 0; i < 40; i++) await writeFile(join(a!, `bulk-${i}.md`), 'bounded fixture\n'.repeat(20000))
    await call(a!, 'index'); await tools.stop(a!, 'documents')
    expect((await tools.list(a!))[0]!.status).toBe('stopped')
    expect((await call(linked!, 'query', { query: 'amberfield' })).hits).toHaveLength(1)
    expect((await call(a!, 'query', { query: 'currentorchard' })).hits).toHaveLength(1)
  } finally { await tools.close(); await rm(root, { recursive: true, force: true }) }
}, 60000)

it.skipIf(!process.env.DONWELLS_DOCUMENT_EMBEDDING_MODEL || !process.env.DONWELLS_DOCUMENT_RERANKING_MODEL)('loads admitted semantic models in the native worker and recovers a stopped service', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'donwells-document-model-')))
  const project = join(root, 'project'); await mkdir(project)
  await writeFile(join(project, 'memory.md'), '# Shared decision\nThe copperorchard project uses SQLite for durable shared memory.\n')
  const program = process.env.DONWELLS_DOCUMENT_TEST_EXECUTABLE ?? process.execPath
  const worker = process.env.DONWELLS_DOCUMENT_TEST_WORKER ?? join(process.cwd(), 'out/main/project-document-worker.js')
  const tools = new ProjectTools(async path => { if (path !== project) throw new Error('Unregistered'); return { path, projectPath: path } }, [createDocumentDefinition({ program, worker, cache: join(root, 'cache'), qmdPackage: process.env.DONWELLS_QMD_PACKAGE!, lancePackage: process.env.DONWELLS_LANCE_PACKAGE!, embeddingModel: process.env.DONWELLS_DOCUMENT_EMBEDDING_MODEL, rerankingModel: process.env.DONWELLS_DOCUMENT_RERANKING_MODEL })])
  const call = async (operation: string, input = {}): Promise<any> => {
    const result: any = await tools.call(project, 'documents', operation, input)
    if (result.isError) throw new Error(JSON.stringify(result.content))
    return result.structuredContent
  }
  const evidence: Record<string, unknown> = { program, worker }
  try {
    let start = performance.now(); await call('index')
    await expect.poll(async () => (await call('status')).phase, { timeout: 90000 }).toBe('ready')
    evidence.indexMs = performance.now() - start; evidence.status = await call('status')
    start = performance.now(); const first = await call('query', { query: 'copperorchard shared memory' }); evidence.firstQueryMs = performance.now() - start
    expect(first).toMatchObject({ mode: 'hybrid', hits: [{ path: 'memory.md', stale: false }] })
    expect(await call('get', { id: first.hits[0].id })).toMatchObject({ content: expect.stringContaining('SQLite'), stale: false })
    await tools.stop(project, 'documents')
    start = performance.now(); const recovered = await call('query', { query: 'copperorchard shared memory' }); evidence.restartAndQueryMs = performance.now() - start
    expect(recovered).toMatchObject({ mode: 'hybrid', hits: [{ path: 'memory.md', stale: false }] })
    evidence.first = first; evidence.recovered = recovered
    const archive = worker.includes('.asar/') ? worker.slice(0, worker.indexOf('.asar/') + 5) : null
    for (const [key, path] of [['programSha256', program], [archive ? 'workerArchiveSha256' : 'workerSha256', archive ?? worker]]) {
      const hash = createHash('sha256'); for await (const bytes of createReadStream(path!)) hash.update(bytes); evidence[key!] = hash.digest('hex')
    }
  } finally { await tools.close(); evidence.ownedServicesClosed = true; await rm(root, { recursive: true, force: true }) }
  if (process.env.DONWELLS_DOCUMENT_SERVICE_EVIDENCE) await writeFile(process.env.DONWELLS_DOCUMENT_SERVICE_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' })
}, 120000)
