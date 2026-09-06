import { StringDecoder } from 'node:string_decoder'
import { basename, join } from 'node:path'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { ProcessExecutionError, runProcess } from '@shared/child-process/run-process'
import { sanitizedProcessEnv } from '@shared/child-process/process-environment'
import { isObject } from '@shared/command-catalog'
import type { ProjectSearchHit, ProjectToolScope, ProjectCodeSearchRequest, ProjectCodeSearchResult } from '@shared/project-tools'
import { AgentRegistry } from './agents/registry'
import { validateRelativePath, WorktreeFiles } from './worktree-files'

export type { ProjectCodeSearchRequest } from '@shared/project-tools'

/** Native content/syntax search. Scope and executable discovery remain in the main process. */
export async function searchProjectCode(
  workspacePath: string,
  request: ProjectCodeSearchRequest,
  resolveScope: (path: string) => Promise<ProjectToolScope>,
  onHit?: (hit: ProjectSearchHit) => void,
  signal?: AbortSignal
): Promise<ProjectCodeSearchResult> {
  if (!request || typeof request.query !== 'string' || !request.query.trim() || request.query.length > 1000 || (request.language ? /\0/ : /[\0\r\n]/).test(request.query)) throw new Error('Invalid content search query')
  if (request.language !== undefined && (typeof request.language !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(request.language))) throw new Error('Invalid structural search language')
  if (typeof request.showHidden !== 'boolean' || typeof request.includeIgnored !== 'boolean') throw new Error('Invalid content search options')
  const limit = request.maxResults ?? 200
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid content search result limit')
  const scope = await resolveScope(workspacePath)
  if (signal?.aborted) throw new ProcessExecutionError('cancelled', 'Search cancelled')
  const executable = new AgentRegistry().findExecutable(request.language ? 'ast-grep' : 'rg')
  if (!executable) throw new Error(request.language ? 'Structural search unavailable: install ast-grep' : 'Content search unavailable: install ripgrep')
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
    let data: Record<string, unknown>
    if (request.language) {
      if (!isObject(event) || !isObject(event.range) || !isObject(event.range.start) || !Number.isSafeInteger(event.range.start.line) || Number(event.range.start.line) < 0 || typeof event.file !== 'string' || typeof event.lines !== 'string') throw new Error('Invalid ast-grep match')
      data = { path: { text: event.file }, lines: { text: event.lines }, line_number: Number(event.range.start.line) + 1 }
    } else {
      if (!isObject(event) || event.type !== 'match') return
      if (!isObject(event.data)) throw new Error('Invalid ripgrep match')
      data = event.data
    }
    if (!isObject(data.path) || !isObject(data.lines) || !Number.isSafeInteger(data.line_number) || Number(data.line_number) < 1) throw new Error('Invalid search match')
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
  const configDirectory = request.language ? await mkdtemp(join(tmpdir(), 'donwells-ast-config-')) : null
  try {
    if (configDirectory) await writeFile(join(configDirectory, 'sgconfig.yml'), 'ruleDirs: []\n', { mode: 0o600 })
    await runProcess({
      program: executable,
      args: request.language
        ? ['run', '--config', join(configDirectory!, 'sgconfig.yml'), '--lang', request.language, '--pattern', request.query, '--json=stream', '--color', 'never', '--globs', '!.git', ...(request.showHidden ? ['--no-ignore', 'hidden'] : ['--globs', '!**/.*']), ...(request.includeIgnored ? ['dot', 'exclude', 'global', 'parent', 'vcs'].flatMap(kind => ['--no-ignore', kind]) : []), '--', '.']
        : ['--no-config', '--json', '--line-buffered', '--fixed-strings', '--line-number', '--color', 'never', '--no-follow', '--glob', '!.git', ...(request.showHidden ? ['--hidden'] : []), ...(request.includeIgnored ? ['--no-ignore'] : []), '--', request.query, '.'],
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
  } finally { if (configDirectory) await rm(configDirectory, { recursive: true, force: true }) }
  await pending
  if (processError instanceof ProcessExecutionError && processError.kind === 'termination-unverified') throw processError
  if (consumerError) throw consumerError
  if (signal?.aborted) throw new ProcessExecutionError('cancelled', 'Search cancelled')
  if (processError && !(truncated && processError instanceof ProcessExecutionError && processError.kind === 'cancelled')) throw processError
  if (!truncated && buffer.trim()) throw new Error('Incomplete ripgrep response')
  if ((await resolveScope(workspacePath)).indexKey !== scope.indexKey) throw new Error('Search checkout changed')
  return { hits, truncated, skipped }
}
