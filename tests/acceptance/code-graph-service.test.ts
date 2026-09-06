import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { ProjectTools, resolveProjectToolScope, type ProjectToolDefinition } from '../../src/main/project-tools'

it.skipIf(!process.env.DONWELLS_CODE_GRAPH_BINARY)('binds concurrent native graph clients to checkout hashes and preserves siblings on stop', async () => {
  const binary = realpathSync(process.env.DONWELLS_CODE_GRAPH_BINARY!)
  expect(execFileSync('ps', ['-axo', 'comm='], { encoding: 'utf8' }).split('\n').filter(line => line.trim().endsWith('/codebase-memory-mcp'))).toEqual([])
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'donwells-graph-service-')))
  const paths = [join(root, 'a-b'), join(root, 'a/b')]
  for (const [index, path] of paths.entries()) {
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'code.ts'), `export function target() { return ${index} }\nexport function ${index ? 'secondCaller' : 'firstCaller'}() { return target() }\n`)
  }
  const resolveWorkspace = async (path: string) => { if (!paths.includes(path)) throw new Error('Unknown checkout'); return { path, projectPath: path } }
  const text = (value: unknown) => { if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new Error('Expected function name'); return value }
  const definition: ProjectToolDefinition = {
    id: 'code-graph', version: '0.10.8', scope: 'checkout',
    launch: scope => ({ program: binary, args: ['--ui=false'], env: { CBM_CACHE_DIR: join(root, 'cache'), CBM_ALLOWED_ROOT: scope.checkoutPath, CBM_WORKERS: '2', CBM_MEM_BUDGET_MB: '512' } }),
    operations: {
      index: { tool: 'index_repository', readOnly: false, parameters: {}, targets: scope => ({ repo_path: scope.checkoutPath, name: scope.indexKey, persistence: false, mode: 'fast' }) },
      callers: { tool: 'trace_path', readOnly: true, parameters: { function_name: text }, targets: scope => ({ project: scope.indexKey, direction: 'inbound', depth: 1, format: 'json', include_evidence: true }) }
    }
  }
  const tools = new ProjectTools(resolveWorkspace, [definition], 30000)
  const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
  const report: Record<string, unknown> = { binary, binarySha256: hash(binary), runnerSha256: hash(import.meta.filename), sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), operations: [] }
  const unwrap = (value: any) => { expect(value.isError, JSON.stringify(value)).not.toBe(true); return value.structuredContent ?? JSON.parse(value.content[0].text) }
  const call = async (path: string, operation: string, args = {}) => {
    const start = performance.now(), result = unwrap(await tools.call(path, 'code-graph', operation, args))
    ;(report.operations as unknown[]).push({ path, operation, elapsedMs: performance.now() - start, result })
    return result
  }
  try {
    mkdirSync(join(root, 'cache'), { mode: 0o700 })
    execFileSync(binary, ['config', 'set', 'ui_enabled', 'false'], {
      env: { ...process.env, CBM_CACHE_DIR: join(root, 'cache') }, timeout: 10000
    })
    // Native workers inherit the first daemon environment. Register only these
    // selected roots in the private cache; requests still bind a checkout hash.
    for (const path of paths) execFileSync(binary, ['allow-root', path], {
      env: { ...process.env, CBM_CACHE_DIR: join(root, 'cache') }, timeout: 10000
    })
    report.start = await Promise.all(paths.map(path => tools.start(path, 'code-graph')))
    await Promise.all(paths.map(async path => {
      const result = await call(path, 'index')
      expect(result.project).toBe((await resolveProjectToolScope(path, resolveWorkspace)).indexKey)
    }))
    const names = (result: any) => result.callers.groups.flatMap((group: any) => group.rows.map((row: any[]) => row[0]))
    expect(names(await call(paths[0]!, 'callers', { function_name: 'target' }))).toEqual(['firstCaller'])
    expect(names(await call(paths[1]!, 'callers', { function_name: 'target' }))).toEqual(['secondCaller'])
    await expect(tools.call(paths[0]!, 'code-graph', 'callers', { function_name: 'target', project: (await resolveProjectToolScope(paths[1]!, resolveWorkspace)).indexKey })).rejects.toThrow('not permitted')
    await expect(tools.call(paths[0]!, 'code-graph', 'index', { repo_path: paths[1] })).rejects.toThrow('not permitted')
    await expect(tools.call(root, 'code-graph', 'index', {})).rejects.toThrow('Unknown checkout')
    await tools.stop(paths[0]!, 'code-graph')
    expect(names(await call(paths[1]!, 'callers', { function_name: 'target' }))).toEqual(['secondCaller'])
    report.siblingSurvived = true
  } catch (error) { report.error = String(error); throw error }
  finally {
    await tools.close()
    const started = performance.now()
    const processes = () => execFileSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' }).split('\n').filter(line => line.trim().endsWith(binary))
    while (processes().length && performance.now() - started < 5000) await new Promise(resolve => setTimeout(resolve, 100))
    report.remainingProcesses = processes()
    try { report.daemonLog = readFileSync(join(root, 'cache/logs/cbm-daemon.log'), 'utf8') } catch {}
    if (!(report.remainingProcesses as string[]).length) { rmSync(root, { recursive: true, force: true }); report.fixtureRemoved = true }
    else report.retainedRoot = root
    if (process.env.DONWELLS_CODE_GRAPH_SERVICE_EVIDENCE) writeFileSync(process.env.DONWELLS_CODE_GRAPH_SERVICE_EVIDENCE, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    expect(report.remainingProcesses).toEqual([])
    if (!report.error) {
      expect(String(report.daemonLog).match(/msg=daemon.start /g)).toHaveLength(1)
      expect(String(report.daemonLog).match(/method=initialize /g)).toHaveLength(2)
      expect(String(report.daemonLog)).not.toContain('msg=ui.serving')
    }
  }
}, 120000)
