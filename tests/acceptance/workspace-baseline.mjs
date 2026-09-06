#!/usr/bin/env node
// Packaged macOS launch evidence. Full user journeys remain separate acceptance gates.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { readFileSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { cpus, release, totalmem } from 'node:os'
import { resolve, dirname, basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { cleanupOwnedSmokeDaemon, delay } from '../helpers/smoke-processes.mjs'

const root = resolve(import.meta.dirname, '../..')
const hash = value => createHash('sha256').update(value).digest('hex')
function sourceIdentity() {
  const git = args => execFileSync('git', args, { cwd: root })
  const files = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).toString().split('\0').filter(Boolean)
  const digest = createHash('sha256')
  for (const name of [...new Set(files)].sort()) {
    digest.update(name + '\0')
    try {
      // Include content hashes rather than storing source or diffs in evidence.
      digest.update(hash(readFileSync(join(root, name))))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      digest.update('deleted')
    }
  }
  return { commit: git(['rev-parse', 'HEAD']).toString().trim(),
    dirty: git(['status', '--porcelain']).length > 0, contentHash: digest.digest('hex') }
}

export function validateOptions(values) {
  for (const key of ['app', 'profile', 'evidence']) assert(values[key], `--${key} is required`)
  const app = realpathSync(resolve(values.app))
  assert(app.endsWith('.app/Contents/MacOS/donwells'), '--app must be the packaged macOS donwells executable')
  assert(lstatSync(app).isFile(), 'App executable is not a file')
  const resources = resolve(dirname(app), '../Resources')
  assert(lstatSync(join(resources, 'app.asar')).isFile(), 'Packaged app.asar is missing')
  const freshDirectory = value => {
    const requested = resolve(value)
    const path = join(realpathSync(dirname(requested)), basename(requested))
    try { lstatSync(path) } catch (error) { if (error.code === 'ENOENT') return path; throw error }
    throw new Error('Acceptance directory already exists: ' + path)
  }
  const profile = freshDirectory(values.profile), evidence = freshDirectory(values.evidence)
  assert(profile !== evidence && !profile.startsWith(evidence + '/') && !evidence.startsWith(profile + '/'), 'Profile and evidence must be separate directories')
  return { app, resources, profile, evidence }
}

async function main() {
  const { values } = parseArgs({ options: {
    app: { type: 'string' }, profile: { type: 'string' }, evidence: { type: 'string' }
  } })
  const { app, resources, profile, evidence } = validateOptions(values)
  // Exclusive creation refuses existing user data and prior evidence; never auto-delete either.
  mkdirSync(evidence, { mode: 0o700 })
  mkdirSync(profile, { mode: 0o700 })
  const report = {
    schemaVersion: 1, startedAt: new Date().toISOString(), checkout: root,
    sourceBefore: sourceIdentity(),
    artifact: { executable: app, executableSha256: hash(readFileSync(app)), asarSha256: hash(readFileSync(join(resources, 'app.asar'))) },
    host: { platform: process.platform, arch: process.arch, osRelease: release(), cpu: cpus()[0]?.model, memoryBytes: totalmem() },
    profile, checks: {},
    journeys: Object.fromEntries(['start', 'collaborate', 'handoff', 'understand', 'build-and-verify', 'return-and-ship'].map(name => [name, 'not-run'])),
    limitations: ['RPC readiness is not visual or native-agent acceptance.', 'One launch is not a performance distribution.', 'Process RSS below excludes renderer/GPU/agent/model services.', 'Source fingerprint describes this checkout; artifact hashes identify the supplied app but do not alone prove a source/build relationship.']
  }
  const { callRuntime } = await import(pathToFileURL(join(resources, 'dist-cli/cli/rpc-client.js')).href)
  const env = { ...process.env, DONWELLS_USER_DATA: profile }
  delete env.DONWELLS_SMOKE
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  let child, ended = false, childError, output = ''
  const start = performance.now()
  try {
    child = spawn(app, [], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.once('exit', () => { ended = true })
    child.once('error', error => { childError = error; ended = true })
    // Bounded tail is for local diagnostics only, never copy native transcripts into evidence.
    const tail = chunk => { output = (output + String(chunk)).slice(-16384) }
    child.stdout.on('data', tail); child.stderr.on('data', tail)
    let meta, lastError
    while (performance.now() - start < 30000 && !ended) {
      try {
        const result = await callRuntime('meta.get', {}, profile, 1000)
        if (result.ok) { meta = result.result; break }
        lastError = result.error
      } catch (error) { lastError = error.message }
      await delay(100)
    }
    assert(meta, childError?.message ?? `Packaged runtime did not become ready: ${lastError ?? 'process exited'}`)
    assert.equal(realpathSync(meta.userDataDir), realpathSync(profile), 'Runtime used the wrong profile')
    report.checks.runtimeReadyMs = performance.now() - start
    report.checks.version = meta.version
    const ui = await callRuntime('ui.state', {}, profile, 10000)
    assert(ui.ok, ui.error)
    report.checks.rendererRpcReady = true
    report.checks.rendererReadyMs = performance.now() - start
    report.checks.ui = ui.result
    report.checks.mainProcess = execFileSync('ps', ['-p', String(child.pid), '-o', 'pid=,rss=,%cpu='], { encoding: 'utf8' }).trim()
    report.checks.packagedLaunch = 'passed'
  } catch (error) {
    report.error = error.message
    process.exitCode = 1
  } finally {
    if (child && !ended) {
      child.kill('SIGTERM')
      for (let i = 0; i < 50 && !ended; i++) await delay(100)
      if (!ended) { child.kill('SIGKILL'); report.checks.forcedAppStop = true; process.exitCode = 1 }
    }
    report.checks.idleDaemonStopped = await cleanupOwnedSmokeDaemon(profile)
    if (!report.checks.idleDaemonStopped) process.exitCode = 1
    report.sourceAfter = sourceIdentity()
    report.checks.sourceUnchangedDuringRun = report.sourceBefore.contentHash === report.sourceAfter.contentHash
    if (!report.checks.sourceUnchangedDuringRun) process.exitCode = 1
    report.elapsedMs = performance.now() - start
    writeFileSync(join(evidence, 'baseline.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    // Redact the disposable profile's runtime credential if Electron happened to log it.
    try {
      const token = JSON.parse(readFileSync(join(profile, 'donwells-runtime.json'))).authToken
      if (token) output = output.replaceAll(token, '[redacted]')
    } catch {}
    writeFileSync(join(evidence, 'app.log'), output, { mode: 0o600, flag: 'wx' })
    console.log(JSON.stringify({ evidence, checks: report.checks, error: report.error }, null, 2))
  }
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
