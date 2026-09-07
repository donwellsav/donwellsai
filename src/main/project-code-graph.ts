import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { ProcessExecutionError, runProcess } from '@shared/child-process/run-process'
import { sanitizedProcessEnv } from '@shared/child-process/process-environment'
import { isObject } from '@shared/command-catalog'
import { parseCodeGraphFunctionName, type ProjectToolScope } from '@shared/project-tools'
import type { GitWorktrees } from './git'
import type { ProjectToolDefinition } from './project-tools'

// Native CBM has one account-wide daemon/cache; project definitions share its setup queue.
const setupQueues = new Map<string, Promise<void>>()

/** Opt-in, admitted macOS ARM64 release. No installer or agent configuration writes. */
export function createCodeGraphDefinition(binary: string, cachePath: string, captureSource?: GitWorktrees['handoffSource']): ProjectToolDefinition {
  const env = { CBM_CACHE_DIR: cachePath, CBM_WORKERS: '2', CBM_MEM_BUDGET_MB: '512' }
  type Source = Awaited<ReturnType<GitWorktrees['handoffSource']>>
  // ponytail: receipts live for this app session; persisted indexes require a
  // rebuild after restart before their Git-visible source can be certified.
  const receipts = new Map<string, { source: Source | null; indexedAt: string | null; building: boolean }>()
  const capture = async (scope: ProjectToolScope): Promise<Source | null> => {
    try { return await captureSource?.(scope.checkoutPath) ?? null } catch { return null }
  }
  const data = (result: unknown): Record<string, unknown> | null => {
    if (!isObject(result) || result.isError === true) return null
    if (isObject(result.structuredContent)) return result.structuredContent
    try {
      const text = Array.isArray(result.content) && result.content.find(item => isObject(item) && item.type === 'text')
      const parsed: unknown = text && JSON.parse(text.text)
      return isObject(parsed) ? parsed : null
    } catch { return null }
  }
  const qualifiedName = (value: unknown): string => {
    if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\0\r\n'\\]/.test(value)) throw new Error('Expected a bounded qualified symbol name')
    return value
  }
  const run = (indexing: boolean) => async (scope: ProjectToolScope, request: () => Promise<unknown>): Promise<unknown> => {
    let receipt = receipts.get(scope.indexKey)
    if (indexing) {
      if (receipt?.building) throw new Error('Code graph rebuild is already running for this checkout')
      receipt = { source: null, indexedAt: null, building: true }
      receipts.set(scope.indexKey, receipt)
    }
    const sourceAtStart = receipt?.source
    const buildingAtStart = receipt?.building
    try {
      const before = await capture(scope)
      const result = await request()
      const value = data(result)
      const after = await capture(scope)
      if (indexing && receipt && value?.project === scope.indexKey && value.status === 'indexed' && before && after && before.contentFingerprint === after.contentFingerprint) {
        receipt.source = after
        receipt.indexedAt = new Date().toISOString()
      }
      if (!value || !isObject(result)) return result
      const stable = before && after && before.contentFingerprint === after.contentFingerprint
      const verified = receipt?.source && receipts.get(scope.indexKey) === receipt && (indexing || (!buildingAtStart && !receipt.building && receipt.source === sourceAtStart)) && stable
      const freshness = {
        state: verified ? after.contentFingerprint === receipt!.source!.contentFingerprint ? 'current' : 'stale' : 'unknown',
        indexedAt: receipt?.indexedAt ?? null,
        sourceRevision: receipt?.source?.sourceRevision ?? null,
        basis: 'Git-visible source; ignored files and external dependencies are not verified'
      }
      const enriched = { ...value, freshness }
      return { ...result, structuredContent: enriched, content: [
        { type: 'text', text: JSON.stringify(enriched) },
        ...(Array.isArray(result.content) ? result.content.filter(item => !isObject(item) || item.type !== 'text') : [])
      ] }
    } finally { if (indexing && receipt) receipt.building = false }
  }

  return {
    id: 'code-graph', version: '0.10.8', scope: 'checkout',
    prepare: (scope, signal) => {
      // ponytail: serialize this cache's native configuration writes; parallel
      // setup needs upstream configuration locking before removing this queue.
      const setup = (setupQueues.get(cachePath) ?? Promise.resolve()).catch(error => {
        if (error instanceof ProcessExecutionError && error.kind === 'termination-unverified') throw error
      }).then(async () => {
        signal.throwIfAborted()
        if (!isAbsolute(binary) || !isAbsolute(cachePath)) throw new Error('Code graph requires absolute executable and cache paths')
        if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Code graph is currently qualified only on macOS ARM64')
        if (!(await stat(binary)).isFile()) throw new Error('Code graph executable must be a regular file')
        const hash = createHash('sha256')
        for await (const chunk of createReadStream(binary, { signal })) hash.update(chunk)
        if (hash.digest('hex') !== '2412e017268bef8f847f38d1b0f79f63185b38c27fe6fba637067bfc87c0eedf') throw new Error('Code graph executable does not match the admitted v0.10.8 build')
        await mkdir(cachePath, { recursive: true, mode: 0o700 })
        for (const args of [['config', 'set', 'ui_enabled', 'false'], ['config', 'set', 'auto_watch', 'false'], ['allow-root', scope.checkoutPath]]) {
          await runProcess({ program: binary, args, cwd: cachePath, env: sanitizedProcessEnv(process.env, env), signal, timeoutMs: 10000, maxOutputBytes: 64 * 1024 })
        }
      }).catch(error => {
        if (error instanceof ProcessExecutionError && error.kind === 'exit' && error.result?.stderr.includes('CBM could not start because')) {
          throw new Error('Another code-graph installation is active with a different cache or build. Finish that installation’s work before starting this app’s code graph; its processes were left running.')
        }
        throw error
      })
      setupQueues.set(cachePath, setup)
      return setup
    },
    launch: scope => ({ program: binary, args: ['--ui=false'], env: { ...env, CBM_ALLOWED_ROOT: scope.checkoutPath } }),
    operations: {
      index: { run: run(true), tool: 'index_repository', readOnly: false, parameters: {}, targets: scope => ({ repo_path: scope.checkoutPath, name: scope.indexKey, persistence: false, mode: 'fast' }) },
      callers: {
        tool: 'trace_path', readOnly: true, run: run(false),
        parameters: { function_name: parseCodeGraphFunctionName },
        targets: scope => ({ project: scope.indexKey, direction: 'inbound', depth: 1, format: 'json', include_evidence: true })
      },
      definitions: {
        tool: 'search_graph', readOnly: true,
        parameters: { symbol: parseCodeGraphFunctionName },
        targets: scope => ({ project: scope.indexKey }),
        run: (scope, request, args) => run(false)(scope, () => request(undefined, { project: scope.indexKey, name_pattern: `^${String(args.symbol).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, format: 'json', limit: 50 }))
      },
      imports: {
        tool: 'query_graph', readOnly: true,
        parameters: { qualified_name: qualifiedName },
        targets: scope => ({ project: scope.indexKey }),
        run: (scope, request, args) => run(false)(scope, async () => {
          const result = await request(undefined, { project: scope.indexKey, query: `MATCH (f)-[:DEFINES]->(s) WHERE s.qualified_name = '${args.qualified_name}' MATCH (f)-[:IMPORTS]->(b) RETURN DISTINCT b.qualified_name LIMIT 200` })
          if (!isObject(result) || result.isError === true) return result
          const text = Array.isArray(result.content) ? result.content.find(item => isObject(item) && item.type === 'text' && typeof item.text === 'string')?.text : undefined
          if (typeof text !== 'string') throw new Error('Unsupported import response')
          const lines = text.trimEnd().split('\n'), header = /^rows: (\d+)  \(cols: b\.qualified_name\)$/.exec(lines[0] ?? '')
          const total = /^total: (\d+)$/.exec(lines.at(-1) ?? '')
          if (!header || !total || Number(header[1]) !== Number(total[1])) throw new Error('Unsupported import response')
          const imports = lines.slice(1, -1).map(line => /^  ([^\s]+)$/.exec(line)?.[1])
          if (imports.length !== Number(header[1]) || imports.some(name => !name)) throw new Error('Unsupported import response')
          const value = { imports }
          return { ...result, structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] }
        })
      },
      source: {
        tool: 'get_code_snippet', readOnly: true,
        parameters: { qualified_name: qualifiedName },
        targets: scope => ({ project: scope.indexKey, include_neighbors: false }),
        run: async (scope, request, args) => {
          const result = await run(false)(scope, request)
          const value = data(result)
          if (!value) return result
          if (!isObject(value.freshness) || value.freshness.state !== 'current') throw new Error('Graph source changed or freshness is unverified. Rebuild the code index before opening this symbol.')
          if (value.qualified_name !== args.qualified_name || typeof value.file_path !== 'string') throw new Error('Graph symbol could not be resolved exactly')
          const path = relative(scope.checkoutPath, resolve(scope.checkoutPath, value.file_path))
          if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error('Graph source is outside this checkout')
          const source = { ...value, file_path: path }
          return { ...(result as Record<string, unknown>), structuredContent: source, content: [{ type: 'text', text: JSON.stringify(source) }] }
        }
      }
    }
  }
}
