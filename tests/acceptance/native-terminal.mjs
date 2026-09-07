#!/usr/bin/env node
import assert from 'node:assert/strict'
import { parseArgs } from 'node:util'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { cleanupOwnedSmokeDaemon, delay, closeOwnedSmokeApp } from '../helpers/smoke-processes.mjs'
import { hash, sourceIdentity } from './workspace-baseline.mjs'

const { values } = parseArgs({ options: { app: { type: 'string' }, playwright: { type: 'string' }, evidence: { type: 'string' }, agent: { type: 'string' } } })
assert(process.platform === 'darwin' && values.app && values.playwright && values.evidence)
const executable = resolve(values.app), evidence = resolve(values.evidence)
mkdirSync(evidence, { mode: 0o700 })
const resources = resolve(dirname(executable), '../Resources')
const { _electron } = await import(pathToFileURL(resolve(values.playwright)).href)
const { callRuntime } = await import(pathToFileURL(join(resources, 'dist-cli/cli/rpc-client.js')).href)
const profile = mkdtempSync(join(tmpdir(), 'donwells-native-profile-'))
const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'donwells-native-project-')))
const probe = join(evidence, 'native-probe.node')
const electronVersion = createRequire(import.meta.url)('electron/package.json').version
execFileSync('clang++', ['-shared', '-undefined', 'dynamic_lookup', '-fobjc-arc', '-framework', 'AppKit', '-I', join(homedir(), '.electron-gyp', electronVersion, 'include/node'), join(import.meta.dirname, '../helpers/native-terminal-probe.mm'), '-o', probe])
execFileSync('git', ['init', '-b', 'main', fixture], { stdio: 'ignore' })
const program = join(fixture, 'screen.mjs')
writeFileSync(program, String.raw`process.stdin.setRawMode(true); process.stdin.resume(); process.stdout.write('\x1b[?1049h');
let input=''; const draw=()=>process.stdout.write('\x1b[2J\x1b[HNATIVE GHOSTTY '+process.pid+'\r\nFind this needle twice: needle\r\nINPUT: '+input);
process.stdin.on('data', data=>{ input+=data.toString(); draw() }); process.on('SIGWINCH',draw); draw(); setInterval(()=>{},1000)`)
writeFileSync(join(fixture, 'app.js'), '// saved original\n')
const server = createServer((_req, res) => res.end('<title>Project preview</title><p>Native workspace preview</p>'))
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const previewUrl = `http://127.0.0.1:${server.address().port}`
const env = { ...process.env, DONWELLS_USER_DATA: profile }
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.DONWELLS_SMOKE
const invoke = async (method, params = {}) => {
  const response = await callRuntime(method, params, profile, 15000)
  assert(response.ok, `${method}: ${response.error}`); return response.result
}
const until = async (predicate, message) => {
  const deadline = Date.now() + 15000
  while (!(await predicate())) { assert(Date.now() < deadline, message); await delay(100) }
}
let app, page, id, instance
const report = { source: sourceIdentity(), executable, profile, fixture, artifacts: Object.fromEntries(['app.asar', 'native/libDonwellsGhostty.dylib', 'native/ghostty.node'].map(file => [file, hash(readFileSync(join(resources, file)))])), checks: [], limitations: ['Native AppKit events are dispatched in process; physical mouse, keyboard and rendered Metal pixels require an unlocked desktop.', 'The TUI fixture verifies transport and renderer lifecycle, not model inference.'] }
const launch = async () => {
  app = await _electron.launch({ executablePath: executable, env }); page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  await page.getByRole('navigation', { name: 'Workspace tools' }).waitFor()
}
const surface = async () => {
  const host = page.locator(`[data-pane-key="term:${id}"] .native-terminal-host`)
  await host.waitFor(); instance = await host.getAttribute('data-native-instance')
}
const read = () => app.evaluate((_electron, { id, instance }) => {
  const path = process.resourcesPath + '/native/ghostty.node'
  return JSON.parse(process.getBuiltinModule('module').createRequire(path)(path).request(JSON.stringify({ op: 'read', id: id + '/' + instance })))
}, { id, instance })
const action = (op, text) => app.evaluate((_electron, { path, op, text }) => process.getBuiltinModule('module').createRequire(path)(path).action(op, text), { path: probe, op, text })
try {
  await launch(); await invoke('repo.add', { dir: fixture })
  await page.getByRole('button', { name: /Main checkout/ }).click()
  await invoke('settings.set', { theme: 'dark', terminalRenderer: 'ghostty' })
  id = (await invoke('agent.start', { workspacePath: fixture, launch: { executable: process.execPath, args: [program] } })).run.sessionId
  await page.getByRole('button', { name: 'Add agent', exact: true }).click()
  await page.getByRole('button', { name: 'Open terminal', exact: true }).click()
  await surface()
  await until(async () => { const result = await read(); return result.visible && /NATIVE GHOSTTY \d+/.test(result.text) }, 'Native TUI did not appear')
  const pid = (await read()).text.match(/NATIVE GHOSTTY (\d+)/)[1]
  report.checks.push('Packaged native renderer displays daemon-owned TUI')
  await action('key', 'x')
  await until(async () => /INPUT: x/.test((await read()).text), 'Native input did not reach PTY')
  report.checks.push('Native keyDown reaches the retained PTY')
  await page.evaluate(({ id, instance }) => window.donwells.nativeTerminal({ op: 'find', sessionId: id, instance }), { id, instance })
  await action('search', 'needle')
  await until(async () => (await read()).searchTotal === 2, 'Native search did not find exact matches')
  report.checks.push('Native search finds exactly two matches')
  await action('shortcut', 'k')
  await page.locator('.palette-dialog').waitFor()
  await until(async () => !(await read()).visible, 'Native surface obscures command palette')
  await page.keyboard.press('Escape')
  report.checks.push('Native Cmd+K opens unobscured app command palette')
  await page.getByRole('button', { name: 'Project memory', exact: true }).click()
  await page.getByRole('button', { name: 'Close workspace panel', exact: true }).click()
  await until(() => action('focused', ''), 'Closing a tool did not return native terminal focus')
  await page.locator('.workspace-session.is-current').click()
  await until(() => action('focused', ''), 'Selecting the current session did not restore native terminal focus')
  report.checks.push('Closing a tool and selecting the current session both restore native terminal focus')
  const sameProcess = async () => { const result = await read(); return result.visible && result.text.includes(`NATIVE GHOSTTY ${pid}`) && result.text.includes('INPUT: x') }
  await invoke('settings.set', { terminalRenderer: 'xterm' })
  await page.locator(`[data-pane-key="term:${id}"] .xterm-screen`).waitFor()
  await invoke('settings.set', { terminalRenderer: 'ghostty' }); await surface()
  await until(sameProcess, 'Renderer switch lost the original process or input')
  report.checks.push('Renderer switch preserves PID and input')
  if (values.agent) {
    await invoke('agent.stop', { sessionId: id }); await delay(300); await invoke('agent.dismiss', { sessionId: id })
    id = (await invoke('agent.start', { workspacePath: fixture, launch: { executable: resolve(values.agent), args: [] } })).run.sessionId
    await page.getByRole('button', { name: 'Add agent', exact: true }).click()
    await page.getByRole('button', { name: 'Open terminal', exact: true }).click(); await surface()
    await until(async () => (await read()).visible && (await read()).text.trim().length > 30, 'Native agent did not start')
    await action('key', 'unsubmitted native input')
    await until(async () => (await read()).text.includes('unsubmitted native input'), 'Native agent did not receive input')
    report.checks.push('Real native agent receives input without submitting a model request')
  }
  const fact = await invoke('memory.create', { workspacePath: fixture, kind: 'decision', title: 'Native ownership', content: 'Daemon retains agent ownership while native views change.', attribution: { harness: 'cli' } })
  await invoke('settings.set', { editorAutoSaveMode: 'manual' })
  await invoke('ui.editor.open', { worktreePath: fixture, relPath: 'app.js' })
  await page.locator('.editor-host .monaco-editor').click({ position: { x: 120, y: 20 } })
  await page.keyboard.press('Meta+a'); await page.keyboard.insertText('// unsaved native draft\n')
  await page.getByText('Unsaved · Recoverable', { exact: true }).waitFor()
  assert.equal(readFileSync(join(fixture, 'app.js'), 'utf8'), '// saved original\n')
  await invoke('browser.open', { worktreePath: fixture, url: previewUrl })
  await until(async () => JSON.stringify(await invoke('browser.snapshot', { key: fixture })).includes('Native workspace preview'), 'Project browser did not load')
  await until(async () => JSON.stringify(await page.evaluate(() => window.donwells.getWorkspaceSession())).includes(previewUrl), 'Browser location was not persisted')
  report.checks.push('Embedded browser works alongside recoverable unsaved editor and shared project fact')
  const child = app.process(); child.kill('SIGKILL')
  await until(async () => child.exitCode !== null || child.signalCode !== null, 'Owned app did not exit')
  app = null; await launch()
  assert(JSON.stringify(await page.evaluate(() => window.donwells.editorRecoveryList())).includes('unsaved native draft'))
  assert(JSON.stringify(await invoke('memory.list', { workspacePath: fixture })).includes(fact.id))
  await until(async () => {
    try { return JSON.stringify(await invoke('browser.snapshot', { key: fixture })).includes('Native workspace preview') }
    catch (error) { if (String(error).includes('no browser host')) return false; throw error }
  }, 'Project browser did not recover')
  report.checks.push('Unsaved editor, shared memory and project browser recover after GUI crash')
  await page.getByRole('button', { name: 'Add agent', exact: true }).click()
  await page.getByRole('button', { name: 'Open terminal', exact: true }).click(); await surface()
  await until(values.agent ? async () => (await read()).visible && (await read()).text.includes('unsubmitted native input') : sameProcess, 'GUI crash recovery lost original process or input')
  report.checks.push('GUI crash recovery preserves PID and input without resubmission')
} catch (error) { report.error = String(error); throw error }
finally {
  if (app) {
    if (id) { await invoke('agent.stop', { sessionId: id }); await delay(300); await invoke('agent.dismiss', { sessionId: id }) }
    for (const session of (await invoke('terminal.list')).sessions) await page.evaluate(id => window.donwells.closeTerminal(id), session.id)
    report.appCleanup = await closeOwnedSmokeApp(app)
  }
  report.daemonCleanup = await cleanupOwnedSmokeDaemon(profile)
  server.close()
  writeFileSync(join(evidence, 'result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
