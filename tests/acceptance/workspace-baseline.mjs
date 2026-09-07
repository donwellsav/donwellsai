#!/usr/bin/env node
// Packaged macOS launch evidence. Full user journeys remain separate acceptance gates.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { readFileSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { cpus, release, totalmem, tmpdir } from 'node:os'
import { resolve, dirname, basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { cleanupOwnedSmokeDaemon, delay } from '../helpers/smoke-processes.mjs'
import { externalResourcesIdentity } from '../helpers/package-evidence.mjs'

const root = resolve(import.meta.dirname, '../..')
export const hash = value => createHash('sha256').update(value).digest('hex')
const externalResources = JSON.parse(readFileSync(join(root, 'build/electron-builder.json'), 'utf8')).extraResources
export function artifactIdentity(app, resources) {
  return { executable: app, executableSha256: hash(readFileSync(app)), asarSha256: hash(readFileSync(join(resources, 'app.asar'))), externalResources: externalResourcesIdentity(resources, externalResources) }
}
export function sourceIdentity() {
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
    app: { type: 'string' }, profile: { type: 'string' }, evidence: { type: 'string' }, playwright: { type: 'string' }
  } })
  const { app, resources, profile, evidence } = validateOptions(values)
  // Exclusive creation refuses existing user data and prior evidence; never auto-delete either.
  mkdirSync(evidence, { mode: 0o700 })
  mkdirSync(profile, { mode: 0o700 })
  const report = {
    schemaVersion: 1, startedAt: new Date().toISOString(), checkout: root,
    sourceBefore: sourceIdentity(),
    artifact: artifactIdentity(app, resources),
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
  let child, desktop, ended = false, childError, output = ''
  const start = performance.now()
  try {
    if (values.playwright) {
      const { _electron } = await import(pathToFileURL(realpathSync(values.playwright)).href)
      desktop = await _electron.launch({ executablePath: app, env })
      child = desktop.process()
    } else child = spawn(app, [], { env, stdio: ['ignore', 'pipe', 'pipe'] })
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
    if (desktop) await measureWorkspace(desktop, callRuntime, profile, evidence, report)
  } catch (error) {
    report.error = error.message
    process.exitCode = 1
  } finally {
    if (desktop) {
      try {
        const sessions = await callRuntime('terminal.list', {}, profile, 10000)
        assert(sessions.ok && Array.isArray(sessions.result.sessions), 'Could not inspect fixture terminals for cleanup')
        for (const session of sessions.result.sessions) {
          const closed = await callRuntime('terminal.close', { sessionId: session.id }, profile, 10000)
          assert(closed.ok, 'Could not close fixture terminal')
        }
      } catch (error) { report.cleanupError = error.message; process.exitCode = 1 }
    }
    if (child && !ended) {
      child.kill('SIGTERM')
      for (let i = 0; i < 50 && !ended; i++) await delay(100)
      if (!ended) { child.kill('SIGKILL'); report.checks.forcedAppStop = true; process.exitCode = 1 }
    }
    try { report.checks.idleDaemonStopped = await cleanupOwnedSmokeDaemon(profile) }
    catch (error) { report.cleanupError = String(error); report.checks.idleDaemonStopped = false }
    if (!report.checks.idleDaemonStopped) process.exitCode = 1
    report.sourceAfter = sourceIdentity()
    report.checks.sourceUnchangedDuringRun = report.sourceBefore.contentHash === report.sourceAfter.contentHash
    if (!report.checks.sourceUnchangedDuringRun) process.exitCode = 1
    try {
      report.artifactAfter = artifactIdentity(app, resources)
      report.checks.artifactUnchangedDuringRun = JSON.stringify(report.artifact) === JSON.stringify(report.artifactAfter)
    } catch (error) { report.artifactIdentityError = String(error); report.checks.artifactUnchangedDuringRun = false }
    if (!report.checks.artifactUnchangedDuringRun) process.exitCode = 1
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

async function measureWorkspace(desktop, callRuntime, profile, evidence, report) {
  const page = await desktop.firstWindow()
  page.setDefaultTimeout(15000)
  const window = await desktop.browserWindow(page)
  await window.evaluate(win => win.setTitle('Donwells — disposable baseline measurement'))
  const invoke = async (method, params = {}) => {
    const response = await callRuntime(method, params, profile, 10000)
    assert(response.ok, `${method}: ${response.error}`)
    return response.result
  }
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'donwells-baseline-project-')))
  report.fixture = fixture
  writeFileSync(join(fixture, 'README.md'), '# Baseline fixture\n\nLocal terminal measurements.\n')
  execFileSync('git', ['init', '-b', 'main', fixture], { stdio: 'ignore' })
  const registered = await invoke('repo.add', { dir: fixture })
  const workspacePath = registered.worktrees.find(worktree => realpathSync(worktree.path) === fixture)?.path
  assert(workspacePath, 'Registered project did not expose its main checkout')
  const deadline = performance.now() + 15000
  while (!(await invoke('ui.state')).repos.some(repo => repo.worktrees.includes(workspacePath))) {
    assert(performance.now() < deadline, 'Fixture registration did not reach the renderer')
    await delay(50)
  }
  await invoke('ui.activate', { worktreePath: workspacePath })
  await invoke('settings.set', { theme: 'dark' })
  assert.equal((await invoke('ui.state')).settingsOpen, false, 'Settings obscures the measurement')
  await page.locator('.xterm-helper-textarea').first().waitFor({ state: 'attached' })
  const sessions = (await invoke('terminal.list')).sessions
  assert.equal(sessions.length, 1, 'Expected only the disposable project terminal')
  const sessionId = sessions[0].id
  const measurements = await page.evaluate(async sessionId => {
    const samples = []
    for (const condition of ['idle', '4KiB-output']) for (let index = 0; index < 200; index++) {
      if (document.querySelector('.settings-modal')) throw new Error('Settings opened during terminal measurement')
      const marker = `BASELINE_ECHO_${index}_END`
      let dispose, timer
      const start = performance.now()
      try {
        await new Promise((resolve, reject) => {
          let output = ''
          timer = setTimeout(() => reject(new Error('Local echo timeout')), 5000)
          dispose = window.donwells.on('terminal:data', event => {
            if (event.sessionId !== sessionId) return
            output = (output + event.data).slice(-8192)
            if (output.includes(marker)) resolve()
          })
          // Escaped first character prevents the command echo from satisfying the result.
          const load = condition === '4KiB-output' ? "printf '%4096s\\n' x; " : ''
          window.donwells.terminalWrite(sessionId, `${load}printf '\\102ASELINE_ECHO_${index}_END\\n'\r`).catch(reject)
        })
        const outputMs = performance.now() - start
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        samples.push({ condition, outputMs, nextFrameMs: performance.now() - start })
      } finally { clearTimeout(timer); dispose?.() }
    }
    return samples
  }, sessionId)
  const summary = samples => {
    const sorted = [...samples].sort((a, b) => a - b)
    return { count: sorted.length, medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1] }
  }
  report.measurements = {
    terminal: { samples: measurements, conditions: Object.fromEntries(['idle', '4KiB-output'].map(condition => {
      const samples = measurements.filter(sample => sample.condition === condition)
      return [condition, { output: summary(samples.map(sample => sample.outputMs)), nextFrame: summary(samples.map(sample => sample.nextFrameMs)) }]
    })) },
    method: 'Renderer terminalWrite to matching PTY output event, then two animation frames. This excludes keyboard event dispatch and does not prove xterm paint completion.'
  }
  await page.evaluate(id => window.donwells.terminalWrite(id, "stty raw -echo; printf '\\113EY_READY'; /bin/cat\r"), sessionId)
  const readyDeadline = performance.now() + 5000
  while (!(await page.evaluate(id => window.donwells.attachTerminal(id), sessionId)).scrollback.includes('KEY_READY')) {
    assert(performance.now() < readyDeadline, 'Raw echo fixture did not start')
    await delay(25)
  }
  await page.locator('.xterm-helper-textarea').first().focus()
  await page.evaluate(id => {
    let start, resolveSample, rejectSample, timer
    const keydown = event => { if (event.key === 'x' && resolveSample) start = performance.now() }
    document.addEventListener('keydown', keydown, true)
    const unsubscribe = window.donwells.on('terminal:data', event => {
      if (event.sessionId !== id || start === undefined || !event.data.includes('x') || !resolveSample) return
      const began = start, outputMs = performance.now() - began, done = resolveSample
      resolveSample = undefined
      requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); done({ outputMs, nextFrameMs: performance.now() - began }) }))
    })
    window.__baselineKeyboard = {
      arm() {
        start = undefined
        this.pending = new Promise((resolve, reject) => { resolveSample = resolve; rejectSample = reject })
        this.pending.catch(() => {})
        timer = setTimeout(() => rejectSample(new Error('Keyboard echo timeout')), 5000)
      },
      dispose() { clearTimeout(timer); unsubscribe(); document.removeEventListener('keydown', keydown, true) }
    }
  }, sessionId)
  const keyboardSamples = []
  try {
    for (let index = 0; index < 200; index++) {
      await page.evaluate(() => window.__baselineKeyboard.arm())
      await page.keyboard.press('x')
      keyboardSamples.push(await page.evaluate(() => window.__baselineKeyboard.pending))
    }
  } finally {
    await page.evaluate(() => { window.__baselineKeyboard.dispose(); delete window.__baselineKeyboard })
  }
  report.measurements.keyboard = { samples: keyboardSamples, output: summary(keyboardSamples.map(sample => sample.outputMs)), nextFrame: summary(keyboardSamples.map(sample => sample.nextFrameMs)), method: 'Playwright keyboard input through the focused xterm. Renderer keydown to raw-mode /bin/cat echo; two animation frames also recorded. Physical display latency and xterm paint completion are not measured.' }
  await invoke('ui.terminal.open', { worktreePath: workspacePath })
  await page.locator('.flexlayout__tab_button').nth(1).waitFor()
  const focusSamples = await page.evaluate(async () => {
    const inputs = [...document.querySelectorAll('.xterm-helper-textarea')]
    // Pane visibility is controlled through actual dock tabs, not hidden textareas.
    const tabs = [...document.querySelectorAll('.flexlayout__tab_button')]
    if (tabs.length < 2 || inputs.length < 2) throw new Error('Two terminal tabs required for focus baseline')
    const samples = []
    for (let index = 0; index < 200; index++) {
      if (document.querySelector('.settings-modal')) throw new Error('Settings opened during tab measurement')
      const start = performance.now()
      tabs[index % 2].click()
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      if (!tabs[index % 2].classList.contains('flexlayout__tab_button--selected')) throw new Error('Target tab did not become selected')
      samples.push(performance.now() - start)
    }
    return samples
  })
  report.measurements.tabSwitch = { samples: focusSamples, ...summary(focusSamples), method: 'Dock-tab DOM click to two animation frames; keyboard focus qualification remains separate.' }
  // Sample Electron processes separately from the profile-owned daemon and model services.
  await delay(3000)
  await desktop.evaluate(({ app }) => app.getAppMetrics())
  await delay(1000)
  report.measurements.idleElectron = await desktop.evaluate(({ app }) => app.getAppMetrics())
  const runtime = JSON.parse(readFileSync(join(profile, 'terminal-daemon/runtime.json'), 'utf8'))
  report.measurements.daemon = execFileSync('ps', ['-p', String(runtime.pid), '-o', 'pid=,rss=,%cpu='], { encoding: 'utf8' }).trim()
  report.measurements.modelResources = 'No model launched by this measurement; existing model services excluded.'
  assert.equal((await invoke('ui.state')).settingsOpen, false, 'Settings obscured the workspace baseline')
  writeFileSync(join(evidence, 'workspace.png'), Buffer.from(await window.evaluate(async win => (await win.webContents.capturePage()).toPNG().toString('base64')), 'base64'))
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
