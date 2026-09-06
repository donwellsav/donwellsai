import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { ProcessExecutionError, runProcess } from '@shared/child-process/run-process'
import { sanitizedProcessEnv } from '@shared/child-process/process-environment'
import type { ProjectToolDefinition } from './project-tools'

/** Opt-in, admitted macOS ARM64 release. No installer or agent configuration writes. */
export function createCodeGraphDefinition(binary: string, cachePath: string): ProjectToolDefinition {
  const env = { CBM_CACHE_DIR: cachePath, CBM_WORKERS: '2', CBM_MEM_BUDGET_MB: '512' }
  let setupQueue = Promise.resolve()
  return {
    id: 'code-graph', version: '0.10.8', scope: 'checkout',
    prepare: (scope, signal) => {
      // ponytail: serialize this cache's native configuration writes; parallel
      // setup needs upstream configuration locking before removing this queue.
      const setup = setupQueue.catch(error => {
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
      })
      setupQueue = setup
      return setup
    },
    launch: scope => ({ program: binary, args: ['--ui=false'], env: { ...env, CBM_ALLOWED_ROOT: scope.checkoutPath } }),
    operations: {
      index: { tool: 'index_repository', readOnly: false, parameters: {}, targets: scope => ({ repo_path: scope.checkoutPath, name: scope.indexKey, persistence: false, mode: 'fast' }) },
      callers: {
        tool: 'trace_path', readOnly: true,
        parameters: { function_name: value => {
          if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\0\r\n]/.test(value)) throw new Error('Expected a bounded function name')
          return value
        } },
        targets: scope => ({ project: scope.indexKey, direction: 'inbound', depth: 1, format: 'json', include_evidence: true })
      }
    }
  }
}
