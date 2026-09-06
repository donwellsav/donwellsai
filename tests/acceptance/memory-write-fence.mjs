// Packaged RPC/process acceptance; does not claim visual or native-agent qualification.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { hash, sourceIdentity, validateOptions } from './workspace-baseline.mjs'
import { delay, cleanupOwnedSmokeDaemon } from '../helpers/smoke-processes.mjs'
const { values } = parseArgs({ options: { app: { type: 'string' }, profile: { type: 'string' }, evidence: { type: 'string' } } })
const { app: appPath, resources, profile, evidence } = validateOptions(values)
mkdirSync(profile, { mode: 0o700 }); mkdirSync(evidence, { mode: 0o700 })
const { callRuntime } = await import(pathToFileURL(join(resources, 'dist-cli/cli/rpc-client.js')))
const fixture = mkdtempSync(join(profile, 'fixture-'))
execFileSync('git', ['init', '-q', fixture])
const started = performance.now()
const report = { executableSha256: hash(readFileSync(appPath)), source: sourceIdentity(), profile, fixture, artifactSha256: hash(readFileSync(join(resources, 'app.asar'))), appPids: [] }
const env = { ...process.env, DONWELLS_USER_DATA: profile }
delete env.ELECTRON_RUN_AS_NODE; delete env.DONWELLS_SMOKE; delete env.ELECTRON_RENDERER_URL
let app, owner
const rpc = async (method, params = {}) => {
  const response = await callRuntime(method, params, profile, 5000)
  assert(response.ok, JSON.stringify(response))
  return response.result
}
async function launch() {
  app = spawn(appPath, [], { env, stdio: 'ignore' })
  report.appPids.push(app.pid)
  for (let i = 0; i < 150; i++) {
    try { const meta = await rpc('meta.get'); assert.equal(meta.userDataDir, profile); return } catch {}
    assert(app.exitCode === null && app.signalCode === null, 'App exited before readiness')
    await delay(100)
  }
  throw new Error('App readiness timed out')
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000)
  try { await exited } finally { clearTimeout(timeout) }
}
try {
  await launch()
  await rpc('repo.add', { dir: fixture })
  const request = { workspacePath: fixture, kind: 'decision', title: 'Packaged lock proof', content: 'decision survives process restart', attribution: { harness: 'cli' } }
  const entry = await rpc('memory.create', request)
  owner = spawn(appPath, ['--input-type=module', '-e', `import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN EXCLUSIVE'); console.log('locked'); setTimeout(() => { db.close(); process.exit(0); }, 15000);`, join(profile, 'project-memory.lock.sqlite')], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  const ready = await Promise.race([once(owner.stdout, 'data'), once(owner, 'exit').then(() => { throw new Error('Lock owner exited before readiness') })])
  assert.match(String(ready[0]), /locked/)
  report.lockOwnerPid = owner.pid
  const rejected = await callRuntime('memory.create', request, profile, 5000)
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'PROJECT_MEMORY_MAINTENANCE')
  report.maintenanceRejected = true
  const exited = once(owner, 'exit'); owner.kill('SIGKILL'); await exited
  await rpc('memory.create', { ...request, title: 'After lock owner exit' })
  await stop(app)
  await launch()
  assert.deepEqual(await rpc('memory.get', { workspacePath: fixture, id: entry.id }), entry)
  report.restartRecallPassed = true
  report.lockReleaseAfterKillPassed = true
} catch (error) {
  report.error = String(error); process.exitCode = 1
} finally {
  await stop(owner); await stop(app)
  report.idleDaemonStopped = await cleanupOwnedSmokeDaemon(profile)
  assert(report.idleDaemonStopped)
  report.durationMs = Math.round(performance.now() - started)
  writeFileSync(join(evidence, 'memory-write-fence.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
}
console.log(JSON.stringify(report))
