#!/usr/bin/env node
import assert from 'node:assert/strict'
import { parseArgs } from 'node:util'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { cleanupOwnedSmokeDaemon, connectDaemon, delay } from '../helpers/smoke-processes.mjs'
import { hash, sourceIdentity } from './workspace-baseline.mjs'
const { values } = parseArgs({ options: { app: { type: 'string' }, playwright: { type: 'string' }, evidence: { type: 'string' } } })
assert(values.app && values.playwright && values.evidence)
const executable = resolve(values.app), evidence = resolve(values.evidence)
mkdirSync(evidence, { mode: 0o700 })
const profile = mkdtempSync(join(tmpdir(), 'donwells-recovery-profile-'))
const fixture = mkdtempSync(join(tmpdir(), 'donwells-recovery-project-'))
execFileSync('git', ['init', '-b', 'main', fixture], { stdio: 'ignore' })
const starts = join(fixture, 'starts.txt'), program = join(fixture, 'terminal.mjs')
writeFileSync(program, `import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(starts)}, process.pid + '\\n')
let inputs = 0
process.stdin.setRawMode(true); process.stdin.resume()
const draw = () => process.stdout.write('\\x1b[?1049h\\x1b[2J\\x1b[HRECOVERED ' + process.pid + ' INPUTS ' + inputs)
process.stdin.on('data', data => { inputs += data.length; draw() })
process.on('SIGWINCH', draw)
process.stdout.write(' '.repeat(600000), draw)
setInterval(() => {}, 1000)
`)
const { _electron } = await import(pathToFileURL(resolve(values.playwright)).href)
const resources = resolve(dirname(executable), '../Resources')
const { callRuntime } = await import(pathToFileURL(join(resources, 'dist-cli/cli/rpc-client.js')).href)
const invoke = async (method, params = {}) => {
  const response = await callRuntime(method, params, profile, 15000)
  assert(response.ok, `${method}: ${response.error}`)
  return response.result
}
const until = async (predicate, message, timeout = 20000) => {
  const deadline = Date.now() + timeout
  while (!(await predicate())) { assert(Date.now() < deadline, message); await delay(100) }
}
const env = { ...process.env, DONWELLS_USER_DATA: profile }
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.DONWELLS_SMOKE
const report = { source: sourceIdentity(), executable, profile, fixture, artifact: { asarSha256: hash(readFileSync(join(resources, 'app.asar'))) }, cycles: [], limitations: ['Custom TUI fixture exercises transport and redraw, not native-agent conversation quality.', 'Window hide/show exercises visibility recovery; physical system sleep is not induced on the user workstation.'] }
let app, page, sessionId, fixturePid
const launch = async () => {
  app = await _electron.launch({ executablePath: executable, env })
  page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  await page.getByRole('navigation', { name: 'Workspace tools' }).waitFor()
}
const verifyScreen = async () => {
  const pane = page.locator(`[data-pane-key="term:${sessionId}"]`)
  await pane.getByText('Terminal history is incomplete', { exact: true }).waitFor()
  await pane.getByRole('button', { name: 'Request redraw', exact: true }).click()
  await pane.getByText('Redraw requested. Check the screen before continuing.', { exact: true }).waitFor()
  await pane.getByRole('button', { name: 'Dismiss notice', exact: true }).click()
  await pane.locator('.xterm-helper-textarea').focus()
  await page.keyboard.press('Meta+f')
  const search = pane.locator('.terminal-search')
  await search.getByRole('textbox', { name: 'Find in terminal' }).fill(`RECOVERED ${fixturePid} INPUTS 0`)
  await until(async () => {
    await search.getByTitle('Next result (Enter)', { exact: true }).click()
    return /\d+ of [1-9]\d*/.test(await search.locator('.terminal-search-results').innerText())
  }, 'Native redraw did not restore the same untouched TUI process')
  await page.keyboard.press('Escape')
  assert.deepEqual(readFileSync(starts, 'utf8').trim().split('\n'), [String(fixturePid)])
}
try {
  await launch()
  await invoke('settings.set', { theme: 'dark' })
  await invoke('repo.add', { dir: fixture })
  await page.getByRole('button', { name: /Main checkout/ }).click()
  const started = await invoke('agent.start', { workspacePath: fixture, launch: { executable: process.execPath, args: [program] } })
  sessionId = started.run.sessionId
  await page.getByRole('button', { name: 'Add agent', exact: true }).click()
  await page.getByRole('button', { name: 'Open terminal', exact: true }).click()
  await until(async () => (await page.evaluate(id => window.donwells.attachTerminal(id), sessionId)).truncated, 'Output never overflowed')
  fixturePid = Number(readFileSync(starts, 'utf8').trim())
  report.sessionId = sessionId; report.fixturePid = fixturePid
  for (let cycle = 1; cycle <= 20; cycle++) {
    if (cycle % 2) await app.close()
    else { const child = app.process(); child.kill('SIGKILL'); app = null; await until(async () => child.exitCode !== null || child.signalCode !== null, 'App did not exit') }
    app = null
    await launch()
    await verifyScreen()
    const session = (await invoke('terminal.list')).sessions.find(item => item.id === sessionId)
    assert(session && !session.exited)
    report.cycles.push({ cycle, shutdown: cycle % 2 ? 'graceful' : 'SIGKILL', sameProcess: true, renderedRedraw: true, resubmittedInput: false })
    console.log(JSON.stringify(report.cycles.at(-1)))
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide())
  await until(async () => app.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].isVisible()), 'Window did not become hidden')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show())
  await until(async () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), 'Window did not become visible')
  const pane = page.locator(`[data-pane-key="term:${sessionId}"]`)
  await pane.locator('.xterm-helper-textarea').focus()
  await page.keyboard.press('x')
  await page.keyboard.press('Meta+f')
  const search = pane.locator('.terminal-search')
  await search.getByRole('textbox', { name: 'Find in terminal' }).fill(`RECOVERED ${fixturePid} INPUTS 1`)
  await until(async () => { await search.getByTitle('Next result (Enter)', { exact: true }).click(); return /\d+ of [1-9]\d*/.test(await search.locator('.terminal-search-results').innerText()) }, 'Visible TUI did not redraw after real input')
  await page.keyboard.press('Escape')
  assert.deepEqual(readFileSync(starts, 'utf8').trim().split('\n'), [String(fixturePid)])
  report.visibilityRecovery = { hidden: true, shown: true, sameProcess: true, inputProducedRedraw: true }
  await page.screenshot({ path: join(evidence, 'recovered.png') })
  const runtime = JSON.parse(readFileSync(join(profile, 'terminal-daemon/runtime.json'), 'utf8'))
  const daemon = await connectDaemon(runtime)
  const status = await daemon.request('daemon.status')
  assert.equal(status.pid, runtime.pid)
  daemon.socket.destroy()
  process.kill(runtime.pid, 'SIGKILL')
  await page.locator(`[data-pane-key="term:${sessionId}"]`).getByText('Terminal disconnected', { exact: true }).waitFor()
  await page.locator(`[data-pane-key="term:${sessionId}"]`).getByRole('button', { name: 'Reattach terminal', exact: true }).click()
  await until(async () => !(await page.getByRole('button', { name: 'Reattaching…', exact: true }).count()), 'Reconnect never completed')
  await page.locator(`[data-pane-key="term:${sessionId}"]`).getByText('Terminal disconnected', { exact: true }).waitFor()
  assert.deepEqual(readFileSync(starts, 'utf8').trim().split('\n'), [String(fixturePid)])
  report.daemonLoss = { visible: true, didNotRelaunch: true }
  await page.screenshot({ path: join(evidence, 'daemon-lost.png') })
} catch (error) { report.error = error.stack; process.exitCode = 1 }
finally {
  if (app) {
    try {
      for (const run of (await invoke('agent.list')).agents) {
        if (run.liveness !== 'exited') await invoke('agent.stop', { sessionId: run.sessionId })
        await until(async () => (await invoke('agent.list')).agents.find(item => item.sessionId === run.sessionId)?.liveness === 'exited', 'Fixture agent did not stop')
        await invoke('agent.dismiss', { sessionId: run.sessionId })
      }
      for (const session of (await invoke('terminal.list')).sessions) await invoke('terminal.close', { sessionId: session.id })
    }
    catch (error) { report.cleanupError = error.message; process.exitCode = 1 }
    await app.close().catch(() => app.process().kill('SIGKILL'))
  }
  try {
    const runtime = JSON.parse(readFileSync(join(profile, 'terminal-daemon/runtime.json'), 'utf8'))
    const daemon = await connectDaemon(runtime)
    try {
      for (const run of (await daemon.request('agent.list')).runs) {
        await daemon.request('agent.stop', { sessionId: run.sessionId })
        await until(async () => (await daemon.request('agent.list')).runs.find(item => item.sessionId === run.sessionId)?.liveness === 'exited', 'Fixture agent did not stop')
        await daemon.request('agent.dismiss', { sessionId: run.sessionId })
      }
      for (const session of (await daemon.request('session.list')).sessions) await daemon.request('session.close', { sessionId: session.id })
    } finally { daemon.socket.destroy() }
  } catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) { report.cleanupError = error.message; process.exitCode = 1 } }
  report.idleDaemonStopped = await cleanupOwnedSmokeDaemon(profile)
  if (!report.idleDaemonStopped) process.exitCode = 1
  if (fixturePid) {
    try { process.kill(fixturePid, 0); report.fixtureStillAlive = true; process.kill(fixturePid, 'SIGTERM'); process.exitCode = 1 }
    catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  writeFileSync(join(evidence, 'terminal-recovery.json'), JSON.stringify(report, null, 2) + '\n')
}
