import { StringDecoder } from 'node:string_decoder'
import { basename } from 'node:path'
import { ProcessExecutionError, runProcess } from '@shared/child-process/run-process'
import { sanitizedProcessEnv } from '@shared/child-process/process-environment'
import { isObject } from '@shared/command-catalog'
import type { ProjectSearchHit, ProjectToolScope } from '@shared/project-tools'
import { AgentRegistry } from './agents/registry'
import { validateRelativePath, WorktreeFiles } from './worktree-files'

export type ProjectCodeSearchRequest = { query: string; showHidden: boolean; includeIgnored: boolean; maxResults?: number }

/** Native literal content search. Scope and executable discovery remain in the main process. */
export async function searchProjectCode(
  workspacePath: string,
  request: ProjectCodeSearchRequest,
  resolveScope: (path: string) => Promise<ProjectToolScope>,
  onHit?: (hit: ProjectSearchHit) => void,
  signal?: AbortSignal
): Promise<{ hits: ProjectSearchHit[]; truncated: boolean; skipped: number }> {
  if (!request || typeof request.query !== 'string' || !request.query.trim() || request.query.length > 1000 || /[\0\r\n]/.test(request.query)) throw new Error('Invalid content search query')
  if (typeof request.showHidden !== 'boolean' || typeof request.includeIgnored !== 'boolean') throw new Error('Invalid content search options')
  const limit = request.maxResults ?? 200
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid content search result limit')
  const scope = await resolveScope(workspacePath)
  if (signal?.aborted) throw new ProcessExecutionError('cancelled', 'Search cancelled')
  const executable = new AgentRegistry().findExecutable('rg')
  if (!executable) throw new Error('Content search unavailable: install ripgrep')
  const controller = new AbortController()
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const files = new WorktreeFiles()
  const hits: ProjectSearchHit[] = []
  const decoder = new StringDecoder('utf8')
  let buffer = '', skipped = 0, truncated = false
  let pending = Promise.resolve()
  let consumerError: unknown, processError: unknown
  const consume = (line: string): void => {
    const event: unknown = JSON.parse(line)
    if (!isObject(event) || event.type !== 'match') return
    const data = event.data
    if (!isObject(data) || !isObject(data.path) || !isObject(data.lines) || !Number.isSafeInteger(data.line_number) || Number(data.line_number) < 1) throw new Error('Invalid ripgrep match')
    // Native JSON uses base64 for non-UTF-8 names/content; these cannot be opened by the text editor.
    if (typeof data.path.text !== 'string' || typeof data.lines.text !== 'string') { skipped++; return }
    const path = validateRelativePath(data.path.text.replace(/^\.\//, ''))
    const excerpt = data.lines.text.replace(/\r?\n$/, '')
    const hit: ProjectSearchHit = { source: 'code', id: `code:${scope.indexKey}:${encodeURIComponent(path)}:${data.line_number}`, title: basename(path), excerpt: excerpt.slice(0, 4096), path, line: Number(data.line_number), revision: null, indexedAt: null, stale: false }
    pending = pending.then(async () => {
      if (combined.aborted) return
      if (!await files.isSafeListedPath(scope.checkoutPath, path)) { skipped++; return }
      if ((await resolveScope(workspacePath)).indexKey !== scope.indexKey) throw new Error('Search checkout changed')
      if (combined.aborted) return
      if (hits.length === limit) { truncated = true; controller.abort(); return }
      hits.push(hit); onHit?.(hit)
    }).catch(error => { consumerError ??= error; controller.abort() })
  }
  await runProcess({
    program: executable,
    args: ['--no-config', '--json', '--fixed-strings', '--line-number', '--color', 'never', '--no-follow', '--glob', '!.git', ...(request.showHidden ? ['--hidden'] : []), ...(request.includeIgnored ? ['--no-ignore'] : []), '--', request.query, '.'],
    cwd: scope.checkoutPath, env: sanitizedProcessEnv(process.env), signal: combined,
    maxOutputBytes: 8 * 1024 * 1024, timeoutMs: 30_000, acceptExitCodes: [0, 1],
    onStdout: chunk => {
      buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
        if (line) consume(line)
      }
    }
  }).catch(error => { processError = error; controller.abort() })
  await pending
  if (processError instanceof ProcessExecutionError && processError.kind === 'termination-unverified') throw processError
  if (consumerError) throw consumerError
  if (signal?.aborted) throw new ProcessExecutionError('cancelled', 'Search cancelled')
  if (processError && !(truncated && processError instanceof ProcessExecutionError && processError.kind === 'cancelled')) throw processError
  if (!truncated && buffer.trim()) throw new Error('Incomplete ripgrep response')
  if ((await resolveScope(workspacePath)).indexKey !== scope.indexKey) throw new Error('Search checkout changed')
  return { hits, truncated, skipped }
}
