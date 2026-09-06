// Packaged RPC/process acceptance; does not claim visual or native-agent qualification.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { hash, sourceIdentity, validateOptions } from './workspace-baseline.mjs'
import { delay, cleanupOwnedSmokeDaemon } from '../helpers/smoke-processes.mjs'
const { values } = parseArgs({ options: { app: { type: 'string' }, profile: { type: 'string' }, evidence: { type: 'string' }, cutover: { type: 'boolean' }, 'cutover-boundary': { type: 'string' }, 'corrupt-start': { type: 'boolean' } } })
const boundary = values['cutover-boundary'] ?? 'legacy-fenced'
assert(['candidate-prepared', 'manifest-prepared', 'legacy-retired', 'legacy-fenced', 'manifest-active', 'abort-marked', 'json-restored', 'reverse-prepared', 'reverse-marked', 'reverse-unfenced', 'reverse-published', 'reverse-active'].includes(boundary), 'Unknown cutover boundary')
assert(!values['cutover-boundary'] || values.cutover, '--cutover-boundary requires --cutover')
const { app: appPath, resources, profile, evidence } = validateOptions(values)
mkdirSync(profile, { mode: 0o700 }); mkdirSync(evidence, { mode: 0o700 })
if (values['corrupt-start']) writeFileSync(join(profile, 'project-memory.json'), '{corrupt acceptance fixture', { mode: 0o600 })
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
  if (values['corrupt-start']) {
    const failure = await callRuntime('memory.list', { workspacePath: fixture }, profile, 5000)
    assert.equal(failure.ok, false)
    assert.match(failure.error, /invalid JSON/)
    assert.equal(readFileSync(join(profile, 'project-memory.json'), 'utf8'), '{corrupt acceptance fixture')
    const { session } = await rpc('terminal.open', { cwd: fixture })
    try {
      await rpc('terminal.write', { sessionId: session.id, data: "printf terminal-still-works > terminal-proof.txt\r" })
      for (let attempt = 0; attempt < 100 && !existsSync(join(fixture, 'terminal-proof.txt')); attempt++) await delay(50)
      assert.equal(readFileSync(join(fixture, 'terminal-proof.txt'), 'utf8'), 'terminal-still-works')
    } finally { await rpc('terminal.close', { sessionId: session.id }) }
    report.terminalWorkedWithCorruptMemory = true
    // Repair only this deliberately corrupt disposable fixture, then retry the same app service.
    writeFileSync(join(profile, 'project-memory.json'), JSON.stringify({ schemaVersion: 1, projects: [] }), { mode: 0o600 })
    assert.equal((await rpc('memory.list', { workspacePath: fixture })).total, 0)
    report.memoryRecoveredWithoutAppRestart = true
  }
  const request = { workspacePath: fixture, kind: 'decision', title: 'Packaged lock proof', content: 'decision survives process restart', attribution: { harness: 'cli' } }
  let entry = await rpc('memory.create', request)
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
  if (values.cutover) {
    report.preMigrationSourceSha256 = hash(readFileSync(join(profile, 'project-memory.json')))
    if (boundary.startsWith('reverse-')) {
      execFileSync(process.execPath, [resolve(import.meta.dirname, '../fixtures/memory-cutover-child.mjs'), profile, 'upgrade-only'], { encoding: 'utf8', timeout: 30000 })
      await launch()
      entry = await rpc('memory.update', { ...request, id: entry.id, expectedRevision: 1, content: 'SQLite write before reverse migration' })
      await stop(app)
      report.postUpgradeWriteBeforeReverse = true
    }

    // The source fixture process dies holding the lock; recovery and later writes run in the supplied package.
    try {
      execFileSync(process.execPath, [resolve(import.meta.dirname, '../fixtures/memory-cutover-child.mjs'), profile, boundary], { encoding: 'utf8', timeout: 30000 })
      assert.fail('Migration fixture unexpectedly survived')
    } catch (error) {
      assert.equal(error.signal, 'SIGKILL')
      const marker = String(error.stdout).split('\n').find(line => line.startsWith('DONWELLS_BOUNDARY:'))
      assert(marker, 'Migration child did not report its crash boundary')
      report.killedMigrationProcess = JSON.parse(marker.slice('DONWELLS_BOUNDARY:'.length))
      assert.equal(report.killedMigrationProcess.boundary, boundary)
    }
  }
  await launch()
  assert.deepEqual(await rpc('memory.get', { workspacePath: fixture, id: entry.id }), entry)
  if (values.cutover) {
    let directory
    if (['candidate-prepared', 'abort-marked', 'json-restored', 'reverse-marked', 'reverse-unfenced', 'reverse-published', 'reverse-active'].includes(boundary)) {
      assert.equal(existsSync(join(profile, 'project-memory-active.json')), false)
      const candidates = readdirSync(profile).filter(name => name.startsWith('project-memory-migration-'))
      assert.equal(candidates.length, 1)
      directory = candidates[0]
      report.recoveredBackend = 'json'
    } else {
      const authority = JSON.parse(readFileSync(join(profile, 'project-memory-active.json'), 'utf8'))
      assert.equal(authority.state, 'sqlite')
      directory = authority.directory
      report.recoveredBackend = 'sqlite'
    }
    const backup = join(profile, directory, 'project-memory.json.backup')
    const before = hash(readFileSync(backup))
    assert.equal(before, report.preMigrationSourceSha256)
    const updated = await rpc('memory.update', { ...request, id: entry.id, expectedRevision: entry.revision, content: 'written after recovery to ' + report.recoveredBackend })
    await stop(app)
    await launch()
    assert.deepEqual(await rpc('memory.get', { workspacePath: fixture, id: entry.id }), updated)
    assert.equal(hash(readFileSync(backup)), before)
    report.recoveryAndNewWriteRestartPassed = true
    report.originalBackupUnchanged = true
  }
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
