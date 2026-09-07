import { createRequire } from 'node:module'
import { basename, join } from 'node:path'
import { realpath } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { Writable } from 'node:stream'
import { runProcess } from '@shared/child-process/run-process'
import { sanitizedProcessEnv } from '@shared/child-process/process-environment'
import { WorktreeFiles, validateRelativePath } from './worktree-files'
import { openProjectDocumentIndex, type DocumentIndexConfiguration, type IndexedDocument } from './project-document-index'

export type DocumentWorkerConfiguration = DocumentIndexConfiguration & {
  indexKey: string
  roots: Array<{ collection: string; path: string; shared: boolean }>
  ripgrep: string
  modelBytes: number
}

/** Only the app launches this worker, using inherited private stdio and a bound configuration. */
async function main() {
  const config: DocumentWorkerConfiguration = JSON.parse(process.env.DONWELLS_DOCUMENT_CONFIG ?? 'null')
  delete process.env.DONWELLS_DOCUMENT_CONFIG
  if (!config || !/^[a-f0-9]{64}$/.test(config.indexKey) || !Array.isArray(config.roots) || config.roots.length > 16 || config.roots.some(root => !config.collections.includes(root.collection))) throw new Error('Invalid document worker scope')
  const require = createRequire(join(config.qmdPackage, 'package.json'))
  const { McpServer } = require('@modelcontextprotocol/server')
  const { serveStdio, StdioServerTransport } = require('@modelcontextprotocol/server/stdio')
  const { z } = require('zod')
  const index = await openProjectDocumentIndex(config), files = new WorktreeFiles()
  const prefix = `document:${config.indexKey}:`
  let closed = false
  let paused: ReturnType<typeof Promise.withResolvers<void>> | null = null
  let pauseAcknowledged = false
  const checkpoint = async () => {
    while (paused) { pauseAcknowledged = true; await paused.promise }
    pauseAcknowledged = false
  }
  let state: { phase: string; job: string | null; completed: number; total: number; skipped: number; error: string | null } = { phase: 'idle', job: null, completed: 0, total: 0, skipped: 0, error: null }
  const rootFor = async (collection: string) => {
    const root = config.roots.find(root => root.collection === collection)
    if (!root || await realpath(root.path) !== root.path) throw new Error('Document root is no longer available')
    return root
  }
  const idFor = (collection: string, path: string) => prefix + encodeURIComponent(collection + '/' + path)
  const source = async (id: string) => {
    if (!id.startsWith(prefix) || id.length > 8192) throw new Error('Document belongs to another checkout')
    const value = decodeURIComponent(id.slice(prefix.length)), slash = value.indexOf('/')
    const collection = value.slice(0, slash), path = validateRelativePath(value.slice(slash + 1))
    const root = await rootFor(collection), indexed = await index.get(collection, path)
    if (!indexed) throw new Error('Document is not in the selected index')
    const file = await files.readFile(root.path, path)
    if (file.binary || !file.revision || file.truncated) throw new Error('Document is not complete supported text')
    return { root, indexed, file }
  }
  const read = async (id: string, fromLine = 1, maxLines = 120) => {
    const { root, indexed, file } = await source(id)
    const lines = file.content.split('\n'), content = lines.slice(fromLine - 1, fromLine - 1 + maxLines).join('\n')
    return { id, path: file.path, root: root.path, fromLine, content: content.slice(0, 50000), truncated: content.length > 50000 || lines.length > fromLine - 1 + maxLines, revision: file.revision, indexedAt: indexed.indexedAt, stale: file.revision !== indexed.revision }
  }
  const status = () => ({ ...state, requestedMode: config.retrievalMode ?? 'auto', phase: paused ? (pauseAcknowledged ? 'paused' : 'pausing') : state.phase, mode: config.embeddingModel && config.rerankingModel ? 'hybrid' : 'lexical', modelBytes: config.modelBytes, roots: config.roots, modelSharing: 'One model instance per active checkout service; stopping the service releases it.' })
  const rebuild = async () => {
    for (const selected of config.roots) {
      await checkpoint()
      const root = await rootFor(selected.collection)
      state.phase = 'reading'; state.completed = 0; state.total = 0
      const result = await runProcess({ program: config.ripgrep, args: ['--files', '--null', '--no-config', '--type-add', 'documents:*.{md,mdx,txt,rst,ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,c,h,cpp,hpp,cs,css,json,toml,yaml,yml}', '--type', 'documents', '--glob', '!**/.*', '--glob', '!**/{.git,node_modules,vendor,dist,build,out,target,coverage}/**', ...['.env*', 'credentials.json', 'secrets.json', 'auth.json', 'service-account*.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'Cargo.lock', 'poetry.lock', '*.min.js'].flatMap(pattern => ['--glob', '!' + pattern]), '--', '.'], cwd: root.path, env: sanitizedProcessEnv(), maxOutputBytes: 2 * 1024 * 1024, timeoutMs: 30000, acceptExitCodes: [0, 1] })
      const paths = result.stdout.split('\0').filter(Boolean)
      if (paths.length > 10000) throw new Error('Document root exceeds 10000 files; choose a smaller root')
      state.total = paths.length
      const documents: IndexedDocument[] = []
      let bytes = 0
      for (const candidate of paths) {
        await checkpoint()
        const path = validateRelativePath(candidate.replace(/^\.\//, ''))
        try {
          const file = await files.readFile(root.path, path)
          if (file.binary || file.truncated || !file.revision) state.skipped++
          else { bytes += file.bytes; documents.push({ path, content: file.content, revision: file.revision }) }
        } catch { state.skipped++ }
        if (bytes > 64 * 1024 * 1024) throw new Error('Document root exceeds 64 MiB; choose a smaller root')
        state.completed++
      }
      state.phase = 'indexing'
      await index.replace(root.collection, documents, (completed, total) => { state.completed = completed; state.total = total }, checkpoint)
    }
    state.phase = 'ready'
  }
  const response = (value: unknown) => {
    const result = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }
    if (Buffer.byteLength(JSON.stringify(result)) > 900000) throw new Error('Document response is too large; request fewer lines or documents')
    return result
  }
  const server = new McpServer({ name: 'donwells-documents', version: '1' })
  server.registerTool('status', { description: 'Document index progress, model resources and selected roots.', inputSchema: z.object({}).strict() }, async () => response(status()))
  server.registerTool('index', { description: 'Start rebuilding selected derived indexes; poll status, or stop this service to cancel.', inputSchema: z.object({}).strict() }, async () => {
    if (state.phase === 'reading' || state.phase === 'indexing') throw new Error('Document indexing is already running')
    state = { phase: 'reading', job: randomUUID(), completed: 0, total: 0, skipped: 0, error: null }
    void rebuild().catch(error => { state.phase = 'failed'; state.error = String(error).slice(0, 300) }).finally(() => { const pending = paused; paused = null; pauseAcknowledged = false; pending?.resolve() })
    return response(status())
  })
  server.registerTool('pause', { description: 'Pause at the next file or embedding batch boundary; models remain loaded.', inputSchema: z.object({}).strict() }, async () => {
    if (state.phase !== 'reading' && state.phase !== 'indexing') throw new Error('No document indexing job to pause')
    paused ??= Promise.withResolvers<void>()
    return response(status())
  })
  server.registerTool('resume', { description: 'Resume the same paused document indexing job.', inputSchema: z.object({}).strict() }, async () => {
    const pending = paused; paused = null; pauseAcknowledged = false; pending?.resolve()
    return response(status())
  })
  server.registerTool('query', { description: 'Search only this checkout and explicitly shared references.', inputSchema: z.object({ query: z.string().min(1).max(1000) }).strict() }, async ({ query }: { query: string }) => {
    const result = await index.search(query), hits = []
    for (const hit of result.hits) {
      const id = idFor(hit.collection, hit.path)
      try {
        const current = await source(id)
        hits.push({ source: 'document', id, title: basename(hit.path), path: hit.path, line: hit.line, excerpt: hit.text.slice(0, 4096), revision: hit.revision, indexedAt: hit.indexedAt, stale: current.file.revision !== hit.revision, root: current.root.path })
      } catch { /* A disappeared or inaccessible source is not a resolvable citation. */ }
    }
    return response({ requestedMode: config.retrievalMode ?? 'auto', mode: result.mode, modelError: result.modelError, hits })
  })
  server.registerTool('get', { description: 'Read current source lines for a previously indexed, scoped document.', inputSchema: z.object({ id: z.string().max(8192), fromLine: z.number().int().min(1).max(1000000).default(1), maxLines: z.number().int().min(1).max(400).default(120) }).strict() }, async ({ id, fromLine, maxLines }: { id: string; fromLine: number; maxLines: number }) => response(await read(id, fromLine, maxLines)))
  server.registerTool('multi_get', { description: 'Read up to five scoped documents; each source is independently confined.', inputSchema: z.object({ ids: z.array(z.string().max(8192)).min(1).max(5) }).strict() }, async ({ ids }: { ids: string[] }) => response({ documents: await Promise.all(ids.map(id => read(id))) }))
  const close = async () => { if (closed) return; closed = true; await index.close() }
  // QMD temporarily redirects process.stdout.write during model loading; MCP replies must keep their original pipe.
  const write = process.stdout.write.bind(process.stdout)
  serveStdio(() => server, { transport: new StdioServerTransport(process.stdin, new Writable({ write(chunk, encoding, callback) { write(chunk, encoding, callback) } })) })
  process.stdin.on('end', () => { void close().finally(() => process.exit(0)) })
}

void main().catch(error => { console.error(String(error)); process.exit(1) })
