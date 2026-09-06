#!/usr/bin/env node
import assert from 'node:assert/strict'
import { sourceIdentity, hash } from './workspace-baseline.mjs'
import { parseArgs } from 'node:util'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { cleanupOwnedSmokeDaemon, delay } from '../helpers/smoke-processes.mjs'
const { values } = parseArgs({ options: { app: { type: 'string' }, playwright: { type: 'string' }, evidence: { type: 'string' } } })
assert(values.app && values.playwright && values.evidence, 'Supply --app, --playwright and --evidence')
const executable = resolve(values.app), evidence = resolve(values.evidence)
mkdirSync(evidence, { mode: 0o700 })
const profile = mkdtempSync(join(tmpdir(), 'donwells-gui-profile-'))
const fixture = mkdtempSync(join(tmpdir(), 'donwells-gui-project-'))
writeFileSync(join(fixture, 'README.md'), '# Workspace acceptance\n\nA disposable project for real terminal and navigation checks.\n')
execFileSync('git', ['init', '-b', 'main', fixture], { stdio: 'ignore' })
const { _electron } = await import(pathToFileURL(resolve(values.playwright)).href)
const { callRuntime } = await import(pathToFileURL(resolve(dirname(executable), '../Resources/dist-cli/cli/rpc-client.js')).href)
const invoke = async (method, params = {}) => {
  const response = await callRuntime(method, params, profile, 10000)
  assert(response.ok, `${method}: ${response.error}`)
  return method === 'terminal.list' ? response.result.sessions : response.result
}
const env = { ...process.env, DONWELLS_USER_DATA: profile }
delete env.DONWELLS_SMOKE; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
let app, page
const start = performance.now()
const report = { startedAt: new Date().toISOString(), source: sourceIdentity(), artifact: { executableSha256: hash(readFileSync(executable)), asarSha256: hash(readFileSync(resolve(dirname(executable), '../Resources/app.asar'))) }, profile, fixture, executable, checks: {}, errors: [], limitations: ['VoiceOver speech/navigation needs native manual qualification.', 'This exercises the workspace shell, not all six completed product journeys.'] }
try {
  app = await _electron.launch({ executablePath: executable, env })
  page = await app.firstWindow()
  page.on('pageerror', error => report.errors.push(error.message))
  await page.getByRole('navigation', { name: 'Workspace tools' }).waitFor()
  await invoke('settings.set', { theme: 'dark' })
  await invoke('repo.add', { dir: fixture })
  assert.deepEqual(await invoke('tool.list', { workspacePath: fixture }), [])
  const rejectedTool = await callRuntime('tool.start', { workspacePath: fixture, id: 'unadmitted-fixture' }, profile, 10000)
  assert.equal(rejectedTool.ok, false)
  report.checks.admittedToolRegistry = true
  await page.getByRole('button', { name: /Main checkout/ }).waitFor()
  await page.getByRole('button', { name: /Main checkout/ }).click()
  await page.locator('.xterm-helper-textarea').first().waitFor({ state: 'attached' })
  let sessions = await invoke('terminal.list')
  assert.equal(sessions.length, 1)
  const session = sessions[0].id
  // The typed command does not contain its final output marker, avoiding an echo-only false pass.
  await page.locator('.xterm-helper-textarea').first().focus()
  await page.keyboard.type("printf '\\104\\117\\116\\127\\105\\114\\114\\123_GUI_OK\\n'")
  await page.keyboard.press('Enter')
  await page.waitForFunction(async id => (await window.donwells.attachTerminal(id)).scrollback.includes('DONWELLS_GUI_OK'), session)
  report.checks.realTerminalInput = true
  for (const label of ['Files', 'Changes', 'Project memory', 'Recover unsaved files']) {
    const button = page.getByRole('navigation', { name: 'Workspace tools' }).getByRole('button', { name: label, exact: true })
    await button.focus(); await page.keyboard.press('Enter')
    assert.equal(await button.getAttribute('aria-pressed'), 'true')
    await page.keyboard.press('Enter')
    assert.equal(await button.getAttribute('aria-pressed'), 'false')
  }
  sessions = await invoke('terminal.list')
  assert.deepEqual(sessions.map(item => item.id), [session])
  report.checks.toolKeyboardNavigationRetainsSession = true
  await page.getByRole('button', { name: 'Terminal', exact: true }).click()
  sessions = await invoke('terminal.list')
  assert.equal(sessions.length, 2)
  report.checks.openSecondTerminal = true
  await page.getByRole('button', { name: 'Add agent', exact: true }).click()
  await page.getByRole('region', { name: 'Agent supervision and operational runs' }).waitFor()
  await page.getByRole('button', { name: 'Close runs', exact: true }).click()
  report.checks.agentLauncherAccessible = true
  const window = await app.browserWindow(page)
  await window.evaluate(win => win.setSize(1440, 960))
  const capture = async name => writeFileSync(join(evidence, name), Buffer.from(await window.evaluate(async win => (await win.webContents.capturePage()).toPNG().toString('base64')), 'base64'))
  report.checks.darkBackground = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--background').trim())
  assert.equal(report.checks.darkBackground.toLowerCase(), '#16161d')
  const colors = await page.evaluate(() => ['--background', '--foreground', '--muted-fg', '--ring'].map(name => getComputedStyle(document.documentElement).getPropertyValue(name).trim()))
  const luminance = color => {
    const channels = color.slice(1).match(/../g).map(hex => parseInt(hex, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2]
  }
  const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05) }
  report.checks.contrast = { text: contrast(colors[0],colors[1]), muted: contrast(colors[0],colors[2]), focus: contrast(colors[0],colors[3]) }
  assert(report.checks.contrast.text >= 4.5 && report.checks.contrast.muted >= 4.5 && report.checks.contrast.focus >= 3)
  await capture('workspace-1440.png')
  await window.evaluate(win => win.setSize(1280, 800))
  await capture('workspace-1280.png')
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await invoke('settings.set', { uiScale: 2 })
  await delay(250)
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await capture('workspace-200-percent.png')
  report.checks.zoomLayout = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: devicePixelRatio, elements: [...document.querySelectorAll('.workspace-masthead, .workspace-desk, .workspace-context-actions, .workbench, .workspace-footing')].map(element => ({ name: element.className, rect: element.getBoundingClientRect().toJSON() })) }))
  for (const { name, rect } of report.checks.zoomLayout.elements) {
    assert(rect.width > 0 && rect.height > 0 && rect.right <= report.checks.zoomLayout.width + 1 && rect.bottom <= report.checks.zoomLayout.height + 1, `${name} is clipped at 200%`)
  }
  for (const name of ['Find a command', 'Terminal', 'Add agent', 'Recover unsaved files']) {
    const button = page.getByRole('button', { name, exact: true })
    await button.focus()
    await button.scrollIntoViewIfNeeded()
    const rect = await button.evaluate(element => element.getBoundingClientRect().toJSON())
    assert(rect && rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= report.checks.zoomLayout.width + 1 && rect.y + rect.height <= report.checks.zoomLayout.height + 1, `${name} is unreachable at 200%: ${JSON.stringify(rect)}`)
  }
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'Close workspace panel' }).click()
  report.checks.keyboardControlsAt200Percent = true
  await invoke('settings.set', { uiScale: 1, theme: 'light' })
  await capture('workspace-light.png')
  assert.deepEqual(report.errors, [])
} catch (error) { report.failure = error.message; process.exitCode = 1 }
finally {
  if (app) {
    try { for (const session of await invoke('terminal.list')) await invoke('terminal.close', { sessionId: session.id }) }
    catch (error) { report.cleanupError = error.message; process.exitCode = 1 }
    const closing = app.close()
    let timer
    try {
      await Promise.race([closing, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Packaged app shutdown timed out')), 10000) })])
    } catch (error) {
      report.cleanupError = error.message; process.exitCode = 1
      app.process().kill('SIGKILL')
      await Promise.race([closing.catch(() => {}), delay(3000)])
    } finally { clearTimeout(timer) }
  }
  report.checks.idleDaemonStopped = await cleanupOwnedSmokeDaemon(profile)
  if (!report.checks.idleDaemonStopped) process.exitCode = 1
  report.durationMs = performance.now() - start
  writeFileSync(join(evidence, 'workspace-shell.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(report, null, 2))
}
