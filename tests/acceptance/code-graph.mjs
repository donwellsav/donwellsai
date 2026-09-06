import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'
const { values } = parseArgs({ options: { binary: { type: 'string' }, evidence: { type: 'string' } } })
assert(values.binary && values.evidence)
const binary = realpathSync(values.binary), evidence = resolve(values.evidence)
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const processes = () => execFileSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' }).split('\n').filter(line => line.trim().endsWith('/codebase-memory-mcp'))
assert.equal(processes().length, 0, 'Close existing graph-tool processes before this isolated trial')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'donwells-code-graph-')))
const first = join(root, 'first'), second = join(root, 'second'), source = join(root, 'source')
const env = { ...process.env, CBM_CACHE_DIR: join(root, 'cache'), CBM_ALLOWED_ROOT: root, CBM_WORKERS: '2', CBM_MEM_BUDGET_MB: '512' }
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8' })
const report = { binary, binarySha256: sha(binary), runnerSha256: sha(import.meta.filename), sourceCommit: git(process.cwd(), 'rev-parse', 'HEAD').trim(), operations: [] }
const invoke = async (tool, params) => {
  const args = join(root, 'args.json'); writeFileSync(args, JSON.stringify(params))
  const start = performance.now()
  const { stdout, stderr } = await promisify(execFile)(binary, ['cli', '--json', tool, '--args-file', args], { env, timeout: 60000, maxBuffer: 8 * 1024 * 1024 })
  const result = JSON.parse(stdout)
  report.operations.push({ tool, params, elapsedMs: performance.now() - start, result, stderr })
  assert(!result.isError, JSON.stringify(result))
  if (result.structuredContent) return result.structuredContent
  const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n')
  try { return JSON.parse(text) } catch { return text }
}
const trace = (project, name) => invoke('trace_path', { project, function_name: name, direction: 'inbound', format: 'json', include_evidence: true })
const callers = result => result.callers.groups.flatMap(group => group.rows.map(row => row[0]))
try {
  mkdirSync(first); git(first, 'init', '-q')
  writeFileSync(join(first, 'format.ts'), "export function formatName(name: string): string { return name.trim() }\n")
  writeFileSync(join(first, 'main.ts'), "import { formatName } from './format'\nexport function greet(): string { return formatName('fixture') }\n")
  git(first, 'add', '.'); git(first, 'commit', '-qm', 'fixture')
  git(first, 'worktree', 'add', '-qb', 'fixture-other', second)
  writeFileSync(join(second, 'format.ts'), "export function formatLabel(name: string): string { return name.trim() }\n")
  writeFileSync(join(second, 'main.ts'), "import { formatLabel } from './format'\nexport function welcome(): string { return formatLabel('fixture') }\n")
  git(second, 'add', '.'); git(second, 'commit', '-qm', 'diverged fixture')
  const a = await invoke('index_repository', { repo_path: first }), b = await invoke('index_repository', { repo_path: second })
  assert.equal(a.status, 'indexed'); assert.equal(b.status, 'indexed'); assert.notEqual(a.project, b.project)
  assert.deepEqual(callers(await trace(a.project, 'formatName')), ['greet'])
  assert.deepEqual(callers(await trace(b.project, 'formatLabel')), ['welcome'])
  const schema = await invoke('get_graph_schema', { project: a.project })
  report.fixtureSchema = schema
  report.imports = await invoke('query_graph', { project: a.project, query: 'MATCH (a)-[:IMPORTS]->(b) RETURN a.name, b.name' })
  assert.match(report.imports, /rows: 1[\s\S]*main\.ts format\.ts[\s\S]*total: 1/)
  writeFileSync(join(second, 'format.ts'), "export function formatTitle(name: string): string { return name.trim() }\n")
  writeFileSync(join(second, 'main.ts'), "import { formatTitle } from './format'\nexport function welcome(): string { return formatTitle('fixture') }\n")
  await invoke('index_repository', { repo_path: second })
  assert.deepEqual(callers(await trace(b.project, 'formatTitle')), ['welcome'])
  assert.deepEqual(callers(await trace(a.project, 'formatName')), ['greet'])
  const removed = await invoke('query_graph', { project: b.project, query: "MATCH (f:Function) WHERE f.name = 'formatLabel' RETURN f.name" })
  assert.match(removed, /total: 0/)
  report.divergedRenamePassed = true
  mkdirSync(source)
  const archive = execFileSync('git', ['archive', '--format=tar', report.sourceCommit, 'src', 'package.json', 'tsconfig.web.json'], { maxBuffer: 32 * 1024 * 1024 })
  execFileSync('tar', ['-xf', '-', '-C', source], { input: archive })
  git(source, 'init', '-q'); git(source, 'add', '.'); git(source, 'commit', '-qm', 'frozen source')
  const indexed = await invoke('index_repository', { repo_path: source }); assert.equal(indexed.status, 'indexed')
  const real = await trace(indexed.project, 'fuzzyPathMatch')
  assert(callers(real).includes('rankWorkspaceFiles'))
  report.realSourceCallerPassed = true
} catch (error) { report.error = String(error); process.exitCode = 1 }
finally {
  const cleanupStart = performance.now()
  while (processes().length && performance.now() - cleanupStart < 5000) await new Promise(resolve => setTimeout(resolve, 100))
  report.cleanupWaitMs = performance.now() - cleanupStart
  report.remainingProcesses = processes()
  const log = join(root, 'cache/logs/cbm-daemon.log')
  try { report.daemonLog = readFileSync(log, 'utf8') } catch {}
  if (report.remainingProcesses.length) { report.retainedRoot = root; process.exitCode = 1 }
  else { rmSync(root, { recursive: true, force: true }); report.fixtureRemoved = true }
  writeFileSync(evidence, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ error: report.error, divergedRenamePassed: report.divergedRenamePassed, realSourceCallerPassed: report.realSourceCallerPassed, remainingProcesses: report.remainingProcesses, evidence }))
}
