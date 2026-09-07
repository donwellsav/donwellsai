import type { GitWorktrees } from './git'
import type { ProjectToolScope } from '@shared/project-tools'
import { validateRelativePath } from './worktree-files'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { AgentRegistry } from './agents/registry'
import type { ProjectToolDefinition } from './project-tools'
import type { DocumentWorkerConfiguration } from './project-document-worker'
import type { DocumentRetrievalMode } from '@shared/project-doctor'

export function createDocumentDefinition(config: { program: string; worker: string; cache: string; qmdPackage: string; lancePackage: string; embeddingModel?: string; rerankingModel?: string; references?: string; retrievalMode?: DocumentRetrievalMode }): ProjectToolDefinition {
  const prepared = new Map<string, DocumentWorkerConfiguration>()
  const text = (value: unknown, limit = 1000): string => {
    if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) throw new Error('Expected bounded document text')
    return value
  }
  const line = (value: unknown, fallback: number, max: number): number => {
    const result = value ?? fallback
    if (!Number.isSafeInteger(result) || Number(result) < 1 || Number(result) > max) throw new Error('Invalid document line range')
    return Number(result)
  }
  return {
    id: 'documents', version: '1', scope: 'checkout',
    prepare: async (scope, signal) => {
      if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Document engine is currently qualified only on macOS ARM64')
      const ripgrep = new AgentRegistry().findExecutable('rg')
      if (!ripgrep) throw new Error('Document indexing requires ripgrep')
      if ([config.program, config.worker, config.cache, config.qmdPackage, config.lancePackage].some(path => !isAbsolute(path))) throw new Error('Document engine paths must be absolute')
      if (config.references && Buffer.byteLength(config.references) > 65536) throw new Error('Document root configuration is too large')
      const selections: unknown = JSON.parse(config.references || '{}')
      if (!selections || typeof selections !== 'object' || Array.isArray(selections)) throw new Error('Invalid document reference configuration')
      const selected = (selections as Record<string, unknown>)[scope.projectPath] ?? []
      if (!Array.isArray(selected) || selected.length > 15 || selected.some(path => typeof path !== 'string' || !isAbsolute(path))) throw new Error('Select at most 15 absolute reference roots per project')
      const home = await realpath(homedir())
      const roots: DocumentWorkerConfiguration['roots'] = []
      for (const [offset, selectedPath] of [scope.checkoutPath, ...selected].entries()) {
        signal.throwIfAborted()
        const path = await realpath(selectedPath), homeRelative = relative(path, home)
        if (!(await stat(path)).isDirectory() || !homeRelative || (homeRelative !== '..' && !homeRelative.startsWith('..' + sep) && !isAbsolute(homeRelative))) throw new Error('Select a project/reference folder, not the whole home directory or its parent')
        const collection = createHash('sha256').update(offset === 0 ? scope.indexKey : scope.projectKey + '\0reference\0' + path).digest('hex')
        if (!roots.some(root => root.collection === collection)) roots.push({ collection, path, shared: offset !== 0 })
      }
      const native = createRequire(join(config.lancePackage, 'package.json')).resolve('@lancedb/lancedb-darwin-arm64')
      const nativeHash = createHash('sha256')
      for await (const bytes of createReadStream(native, { signal })) nativeHash.update(bytes)
      if (nativeHash.digest('hex') !== 'a4f262311509ef1a33ad7279e75736b0077a14b01f9534e1b8dcb0ea35ef5892') throw new Error('Document native binding does not match the admitted artifact')
      let modelBytes = 0, modelsAvailable = config.retrievalMode !== 'lexical' && Boolean(config.embeddingModel && config.rerankingModel)
      for (const [path, expected] of config.retrievalMode === 'lexical' ? [] : [[config.embeddingModel, 'b60ae5ce2dd6a0b77f82cadf21def1f310a3e10cde380ad0081b07a9d416949d'], [config.rerankingModel, '22c9979ce4fbcdc5acdc310c6641c32797eff1aa980b8f7a2db8a8ea23429a48']]) {
        if (!path) continue
        if (!isAbsolute(path)) throw new Error('Document model paths must be absolute')
        const info = await stat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error })
        if (!info) { modelsAvailable = false; continue }
        if (!info.isFile()) throw new Error('Document model must be a regular file')
        const hash = createHash('sha256')
        for await (const bytes of createReadStream(path, { signal })) hash.update(bytes)
        if (hash.digest('hex') !== expected) throw new Error('Document model does not match the admitted artifact')
        modelBytes += info.size
      }
      if (config.retrievalMode === 'hybrid' && !modelsAvailable) throw new Error('Hybrid retrieval requires both admitted local models. Select the embedding and reranking files in Project tools, or choose lexical retrieval.')
      const database = join(config.cache, scope.projectKey, 'qwen3-4b-v1')
      await mkdir(database, { recursive: true, mode: 0o700 })
      // ponytail: root selections are fixed for this service lifetime; Task 19 owns interactive configuration and restart.
      prepared.set(scope.indexKey, { qmdPackage: config.qmdPackage, lancePackage: config.lancePackage, retrievalMode: config.retrievalMode ?? 'auto', database, collections: roots.map(root => root.collection), roots, indexKey: scope.indexKey, ripgrep, modelBytes, ...(modelsAvailable ? { embeddingModel: config.embeddingModel, rerankingModel: config.rerankingModel } : {}) })
    },
    launch: scope => ({ program: config.program, args: [config.worker], env: { ELECTRON_RUN_AS_NODE: '1', QMD_EMBED_PARALLELISM: '2', DONWELLS_DOCUMENT_CONFIG: JSON.stringify(prepared.get(scope.indexKey)) } }),
    operations: {
      status: { tool: 'status', readOnly: true, parameters: {}, targets: () => ({}) },
      index: { tool: 'index', readOnly: false, parameters: {}, targets: () => ({}) },
      progress: { tool: 'status', readOnly: true, requiresRunning: true, parameters: {}, targets: () => ({}) },
      cancel: { tool: 'cancel', readOnly: false, requiresRunning: true, parameters: {}, targets: () => ({}) },
      pause: { tool: 'pause', readOnly: false, requiresRunning: true, parameters: {}, targets: () => ({}) },
      resume: { tool: 'resume', readOnly: false, requiresRunning: true, parameters: {}, targets: () => ({}) },
      query: { tool: 'query', readOnly: true, parameters: { query: value => text(value), requestId: value => { if(value===undefined)return undefined; const id=text(value,80);if(!/^[a-zA-Z0-9_-]+$/.test(id))throw new Error('Invalid document request ID');return id } }, targets: () => ({}) },
      cancelQuery: { tool: 'cancel_query', readOnly: false, requiresRunning: true, parameters: { requestId: value => {const id=text(value,80);if(!/^[a-zA-Z0-9_-]+$/.test(id))throw new Error('Invalid document request ID');return id} }, targets: () => ({}) },
      get: { tool: 'get', readOnly: true, parameters: { id: value => text(value, 8192), fromLine: value => line(value, 1, 1000000), maxLines: value => line(value, 120, 400) }, targets: () => ({}) },
      multiGet: { tool: 'multi_get', readOnly: true, parameters: { ids: value => { if (!Array.isArray(value) || !value.length || value.length > 5) throw new Error('Expected up to five document IDs'); return value.map(id => text(id, 8192)) } }, targets: () => ({}) }
    }
  }
}

/** QMD references are index identifiers, never permission to read arbitrary filesystem paths. */
export function projectDocumentReference(scope: ProjectToolScope, reference: string, documentRoot: string): string {
  if (typeof reference !== 'string' || reference.length > 4096) throw new Error('Invalid document reference')
  const prefix = reference.startsWith('qmd://') ? 'qmd://project/' : 'project/'
  if (!reference.startsWith(prefix)) throw new Error('Document is outside the project collection')
  const value = reference.slice(prefix.length)
  const path = validateRelativePath(prefix.startsWith('qmd://') ? decodeURIComponent(value) : value)
  // QMD interprets trailing colon numbers as line ranges, so those references are ambiguous.
  if (/:\d+(?::\d+)?$/.test(path)) throw new Error('Document line ranges require a separate line argument')
  const root = validateRelativePath(documentRoot, true)
  return `document:${scope.indexKey}:${encodeURIComponent(root ? `${root}/${path}` : path)}`
}

export async function readProjectDocument(
  workspacePath: string,
  id: string,
  resolveScope: (path: string) => Promise<ProjectToolScope>,
  files: Pick<GitWorktrees, 'readFile'>,
  documentRoot: string
) {
  const scope = await resolveScope(workspacePath)
  const prefix = `document:${scope.indexKey}:`
  if (typeof id !== 'string' || id.length > 8192 || !id.startsWith(prefix)) throw new Error('Document belongs to another checkout')
  const path = validateRelativePath(decodeURIComponent(id.slice(prefix.length)))
  const root = validateRelativePath(documentRoot, true)
  if (root && !path.startsWith(`${root}/`)) throw new Error('Document is outside the selected document root')
  const file = await files.readFile(scope.checkoutPath, path)
  if ((await resolveScope(workspacePath)).indexKey !== scope.indexKey) throw new Error('Document checkout changed while opening')
  return file
}
