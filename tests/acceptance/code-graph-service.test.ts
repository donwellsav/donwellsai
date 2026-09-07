import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { resolveProjectToolScope } from '../../src/main/project-tools'
import { ProjectDoctor } from '../../src/main/project-doctor'
import { createCodeGraphDefinition } from '../../src/main/project-code-graph'
import { GitWorktrees } from '../../src/main/git'
import { Store } from '../../src/main/store'

it.skipIf(!process.env.DONWELLS_CODE_GRAPH_BINARY)('binds concurrent native graph clients to checkout hashes and preserves siblings on stop', async () => {
  const binary = realpathSync(process.env.DONWELLS_CODE_GRAPH_BINARY!)
  expect(execFileSync('ps', ['-axo', 'comm='], { encoding: 'utf8' }).split('\n').filter(line => line.trim().endsWith('/codebase-memory-mcp'))).toEqual([])
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'donwells-graph-service-')))
  const paths = [join(root, 'a-b'), join(root, 'a/b')]
  const git = new GitWorktrees(new Store(join(root, 'profile')))
  for (const [index, path] of paths.entries()) {
    mkdirSync(path, { recursive: true })
    execFileSync('git', ['init', '-b', 'main'], { cwd: path })
    writeFileSync(join(path, 'code.ts'), `export function target() { return ${index} }\nexport function ${index ? 'secondCaller' : 'firstCaller'}() { return target() }\n`)
    execFileSync('git', ['add', '.'], { cwd: path })
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture'], { cwd: path })
    await git.addRepo(path)
  }
  const resolveWorkspace = async (path: string) => { if (!paths.includes(path)) throw new Error('Unknown checkout'); return { path, projectPath: path } }
  const tools = new ProjectDoctor(join(root, 'config'), resolveWorkspace,
    () => ({ codeGraphBinary: binary, referenceRoots: [], disabled: [] }),
    () => [createCodeGraphDefinition(binary, join(root, 'cache'), path => git.handoffSource(path))])
  const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
  const report: Record<string, unknown> = { binary, binarySha256: hash(binary), runnerSha256: hash(import.meta.filename), sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), operations: [] }
  const unwrap = (value: any) => { expect(value.isError, JSON.stringify(value)).not.toBe(true); return value.structuredContent ?? JSON.parse(value.content[0].text) }
  const call = async (path: string, operation: string, args = {}) => {
    const start = performance.now(), result = unwrap(await tools.call(path, 'code-graph', operation, args))
    ;(report.operations as unknown[]).push({ path, operation, elapsedMs: performance.now() - start, result })
    return result
  }
  try {
    report.start = await Promise.all(paths.map(path => tools.start(path, 'code-graph')))
    const conflicting = new ProjectDoctor(join(root, 'conflicting-config'), resolveWorkspace,
      () => ({ referenceRoots: [], disabled: [] }),
      () => [createCodeGraphDefinition(binary, join(root, 'other-cache'))])
    try { await expect(conflicting.start(paths[0]!, 'code-graph')).rejects.toThrow('Another code-graph installation is active') }
    finally { await conflicting.close() }
    report.foreignCacheConflictReportedWithoutStoppingOwners = true
    const beforeIndex = await tools.call(paths[0]!, 'code-graph', 'callers', { function_name: 'target' }) as { isError?: boolean }
    expect(beforeIndex.isError).toBe(true)
    report.unbuiltIndexRejected = true
    await Promise.all(paths.map(async path => {
      const result = await call(path, 'index')
      expect(result.freshness.state).toBe('current')
      expect(result.project).toBe((await resolveProjectToolScope(path, resolveWorkspace)).indexKey)
    }))
    const names = (result: any) => result.callers.groups.flatMap((group: any) => group.rows.map((row: any[]) => row[0]))
    expect(names(await call(paths[0]!, 'callers', { function_name: 'target' }))).toEqual(['firstCaller'])
    expect(names(await call(paths[1]!, 'callers', { function_name: 'target' }))).toEqual(['secondCaller'])
    writeFileSync(join(paths[0]!, 'code.ts'), 'export function target() { return 42 }\nexport function renamedCaller() { return target() }\n')
    expect((await call(paths[0]!, 'callers', { function_name: 'target' })).freshness.state).toBe('stale')
    expect((await call(paths[1]!, 'callers', { function_name: 'target' })).freshness.state).toBe('current')
    expect((await call(paths[0]!, 'index')).freshness.state).toBe('current')
    const rebuilt = await call(paths[0]!, 'callers', { function_name: 'target' })
    expect(rebuilt.freshness.state).toBe('current')
    expect(names(rebuilt)).toEqual(['renamedCaller'])
    await expect(tools.call(paths[0]!, 'code-graph', 'callers', { function_name: 'target', project: (await resolveProjectToolScope(paths[1]!, resolveWorkspace)).indexKey })).rejects.toThrow('not permitted')
    await expect(tools.call(paths[0]!, 'code-graph', 'index', { repo_path: paths[1] })).rejects.toThrow('not permitted')
    await expect(tools.call(root, 'code-graph', 'index', {})).rejects.toThrow('Unknown checkout')
    await tools.stop(paths[0]!, 'code-graph')
    expect(names(await call(paths[1]!, 'callers', { function_name: 'target' }))).toEqual(['secondCaller'])
    report.siblingSurvived = true
    const sibling = (await tools.list(paths[1]!))[0]!
    await tools.start(paths[0]!, 'code-graph')
    expect((await tools.list(paths[1]!))[0]!.pid).toBe(sibling.pid)
    expect(names(await call(paths[1]!, 'callers', { function_name: 'target' }))).toEqual(['secondCaller'])
    report.siblingSurvivedRestart = true
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
      expect(String(report.daemonLog).match(/method=initialize /g)).toHaveLength(3)
      expect(String(report.daemonLog)).not.toContain('msg=ui.serving')
    }
  }
}, 120000)
