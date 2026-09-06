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
const until = async (predicate, label) => {
  const deadline = Date.now() + 15000
  while (!(await predicate())) { assert(Date.now() < deadline, `Timed out: ${label}`); await delay(50) }
}
const start = performance.now()
const report = { startedAt: new Date().toISOString(), source: sourceIdentity(), artifact: { executableSha256: hash(readFileSync(executable)), asarSha256: hash(readFileSync(resolve(dirname(executable), '../Resources/app.asar'))) }, profile, fixture, executable, checks: {}, errors: [], limitations: ['VoiceOver speech/navigation needs native manual qualification.', 'This exercises the workspace shell, not all six completed product journeys.'] }
try {
  app = await _electron.launch({ executablePath: executable, env })
  page = await app.firstWindow()
  page.setDefaultTimeout(15000)
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
  const arrange = async name => { await page.getByRole('button', { name: 'Layout', exact: true }).click(); await page.getByRole('button', { name, exact: true }).click() }
  let sessions = await invoke('terminal.list')
  assert.equal(sessions.length, 1)
  const session = sessions[0].id
  // The typed command does not contain its final output marker, avoiding an echo-only false pass.
  await page.locator('.xterm-helper-textarea').first().focus()
  await page.keyboard.type("printf '\\104\\117\\116\\127\\105\\114\\114\\123_GUI_OK\\n'")
  await page.keyboard.press('Enter')
  await until(() => page.evaluate(async id => (await window.donwells.attachTerminal(id)).scrollback.includes('DONWELLS_GUI_OK'), session), 'fresh terminal output')
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
  const sessionIds = sessions.map(item => item.id).sort()
  await arrange('Pair')
  await page.waitForFunction(() => document.querySelectorAll('.flexlayout__tabset').length === 2)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+w' : 'Control+w')
  await page.getByRole('button', { name: 'Layout', exact: true }).click()
  await page.getByText('Hidden (1)', { exact: true }).waitFor()
  assert.deepEqual((await invoke('terminal.list')).map(item => item.id).sort(), sessionIds)
  await page.getByText('Hidden (1)', { exact: true }).click()
  await page.locator('.workspace-hidden-views button').click()
  await page.getByText('Hidden (1)', { exact: true }).waitFor({ state: 'detached' })
  for (let move = 0; move < 100; move++) {
    await arrange(move % 2 ? 'Pair' : 'Focus')
  }
  assert.deepEqual((await invoke('terminal.list')).map(item => item.id).sort(), sessionIds)
  const targetPath = (await invoke('ui.state')).activeWorktreePath
  await invoke('ui.pane.focus', { worktreePath: targetPath, key: `term:${sessionIds[1]}` })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.locator(`[data-pane-key="term:${sessionIds[1]}"] .xterm-helper-textarea`).focus()
  await page.keyboard.type("printf '\\104\\117\\103\\113_LAYOUT_OK\\n'")
  await page.keyboard.press('Enter')
  await until(() => page.evaluate(async ids => (await Promise.all(ids.map(id => window.donwells.attachTerminal(id)))).some(result => result.scrollback.includes('DOCK_LAYOUT_OK')), sessionIds), 'terminal output after layout changes')
  report.checks.hideReopenAnd100LayoutChangesRetainLiveSessions = true
  await page.getByRole('button', { name: 'Add agent', exact: true }).click()
  await page.getByRole('region', { name: 'Agent supervision and operational runs' }).waitFor()
  await page.getByRole('button', { name: 'Close runs', exact: true }).click()
  report.checks.agentLauncherAccessible = true
  const window = await app.browserWindow(page)
  await window.evaluate(win => win.setSize(1440, 960))
  const capture = async name => {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await delay(100)
    writeFileSync(join(evidence, name), Buffer.from(await window.evaluate(async win => (await win.webContents.capturePage()).toPNG().toString('base64')), 'base64'))
  }
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
  report.checks.zoomLayout = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: devicePixelRatio, elements: [...document.querySelectorAll('.workspace-rail, .workspace-desk, .workspace-docking-body')].map(element => ({ name: element.className, rect: element.getBoundingClientRect().toJSON() })) }))
  for (const { name, rect } of report.checks.zoomLayout.elements) {
    assert(rect.width > 0 && rect.height > 0 && rect.right <= report.checks.zoomLayout.width + 1 && rect.bottom <= report.checks.zoomLayout.height + 1, `${name} is clipped at 200%`)
  }
  const terminalArea = report.checks.zoomLayout.elements.find(element => element.name === 'workspace-docking-body').rect
  assert.equal(terminalArea.top, 0)
  assert.equal(terminalArea.bottom, report.checks.zoomLayout.height)
  report.checks.terminalWorkspaceUsesFullHeight = true
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
  await invoke('settings.set', { editorAutoSaveMode: 'manual', theme: 'dark' })
  const workspacePath = (await invoke('ui.state')).activeWorktreePath
  await invoke('ui.editor.open', { worktreePath: workspacePath, relPath: 'README.md' })
  await page.locator('.editor-host .monaco-editor').waitFor()
  await page.locator('.editor-host .monaco-editor').click({ position: { x: 120, y: 20 } })
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End')
  const draft = '\nUNSAVED_LAYOUT_RESTART_PROOF'
  await page.keyboard.insertText(draft)
  await page.getByText('Unsaved · Recoverable', { exact: true }).waitFor()
  const before = await invoke('ui.editor.read', { worktreePath: workspacePath, relPath: 'README.md' })
  assert(before.content.includes(draft))
  const editorElement = await page.locator('.editor-host .monaco-editor').elementHandle()
  for (let move = 0; move < 100; move++) {
    await window.evaluate((win, action) => win.webContents.send('menu:action', { action }), move % 2 ? 'move-pane-left' : 'move-pane-right')
    await invoke('ui.state')
  }
  for (const name of ['Review', 'Build & preview', 'Pair', 'Focus']) await arrange(name)
  await invoke('ui.pane.focus', { worktreePath: workspacePath, key: 'preview:README.md' })
  await page.locator('.editor-host .monaco-editor').waitFor()
  assert(await editorElement.evaluate(element => element === document.querySelector('.editor-host .monaco-editor')))
  assert.equal((await invoke('ui.editor.read', { worktreePath: workspacePath, relPath: 'README.md' })).content, before.content)
  await page.locator('.editor-host .monaco-editor').click({ position: { x: 120, y: 20 } })
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  assert.equal((await invoke('ui.editor.read', { worktreePath: workspacePath, relPath: 'README.md' })).content, readFileSync(join(fixture, 'README.md'), 'utf8'))
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z')
  assert.equal((await invoke('ui.editor.read', { worktreePath: workspacePath, relPath: 'README.md' })).content, before.content)
  await page.getByText('Unsaved · Recoverable', { exact: true }).waitFor()
  report.checks.editorUndoRedoSurvives100Moves = true
  await invoke('ui.pane.close', { worktreePath: workspacePath, key: `term:${sessionIds[0]}` })
  await until(() => page.evaluate(async ({ path, hidden }) => {
    const saved = await window.donwells.getWorkspaceSession()
    return Object.values(saved?.repos ?? {}).some(repo => repo.docking?.[path]?.hidden?.length === 1 && repo.docking[path].hidden[0] === hidden && repo.panes?.[path]?.some(pane => pane.key === 'preview:README.md') && repo.activePane?.[path] === 'preview:README.md')
  }, { path: workspacePath, hidden: `term:${sessionIds[0]}` }), 'saved editor and hidden layout')
  assert(!readFileSync(join(fixture, 'README.md'), 'utf8').includes(draft))
  report.checks.unsavedEditorRetainsDomAndContentAcross100Moves = true
  const savedBeforeRestart = JSON.parse(readFileSync(join(profile, 'donwells-data.json'), 'utf8')).workspaceSession
  assert(Object.values(savedBeforeRestart.repos).some(repo => repo.panes[workspacePath]?.some(pane => pane.key === 'preview:README.md')))
  const exited = new Promise(resolve => app.process().once('exit', resolve))
  app.process().kill('SIGKILL') // Deliberate crash of only this disposable acceptance app.
  await exited
  app = await _electron.launch({ executablePath: executable, env })
  page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => report.errors.push(error.message))
  await page.getByRole('navigation', { name: 'Workspace tools' }).waitFor()
  await page.getByRole('button', { name: 'Layout', exact: true }).click()
  await page.getByText('Hidden (1)', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Layout', exact: true }).click()
  await page.getByText('Unsaved · Recoverable', { exact: true }).waitFor()
  assert.equal((await invoke('ui.editor.read', { worktreePath: workspacePath, relPath: 'README.md' })).content, before.content)
  assert(!readFileSync(join(fixture, 'README.md'), 'utf8').includes(draft))
  assert.deepEqual((await invoke('terminal.list')).map(item => item.id).sort(), sessionIds)
  report.checks.crashRestartRetainsHiddenLayoutUnsavedDraftAndSessions = true
  for (const [label, kind] of [['Files', 'explorer'], ['Changes', 'git-status'], ['Project memory', 'memory'], ['Recover unsaved files', 'recovery']]) {
    await page.getByRole('navigation', { name: 'Workspace tools' }).getByRole('button', { name: label, exact: true }).click()
    await page.getByRole('button', { name: 'Move panel into workspace', exact: true }).click()
    await page.locator(`[data-pane-kind="${kind}"]`).waitFor()
    const current = await invoke('ui.state')
    assert.equal(current.panes[workspacePath].filter(pane => pane.kind === kind).length, 1)
  }
  assert.deepEqual((await invoke('terminal.list')).map(item => item.id).sort(), sessionIds)
  report.checks.filesChangesMemoryRecoveryDockWithoutNewProcesses = true
  await page.getByRole('button', { name: 'Add agent', exact: true }).click()
  await page.getByRole('checkbox', { name: 'Pass arguments separately', exact: true }).check()
  await page.getByLabel('Executable', { exact: true }).fill('/usr/bin/printf')
  const nativeArgs = ['%s\\n', 'two words', '', '$(not-a-command); 世界']
  for (let index = 0; index < nativeArgs.length; index++) {
    await page.getByRole('button', { name: 'Add argument', exact: true }).click()
    await page.getByRole('textbox', { name: `Argument ${index + 1}`, exact: true }).fill(nativeArgs[index])
  }
  await page.getByRole('button', { name: 'Start agent & open terminal', exact: true }).click()
  let nativeRun
  await until(async () => {
    nativeRun = (await invoke('agent.list')).agents.find(run => run.launch?.executable === '/usr/bin/printf')
    return nativeRun?.liveness === 'exited'
  }, 'native argv process exit')
  assert.equal(nativeRun.exitCode, 0)
  assert.deepEqual(nativeRun.launch.args, nativeArgs)
  const output = await page.evaluate(async id => (await window.donwells.attachTerminal(id)).scrollback, nativeRun.sessionId)
  assert(output.replaceAll('\r', '').includes('two words\n\n$(not-a-command); 世界\n'))
  report.checks.nativeArgvFromLauncher = { sessionId: nativeRun.sessionId, exitCode: nativeRun.exitCode, literalArgumentsPreserved: true }
  await invoke('agent.dismiss', { sessionId: nativeRun.sessionId })
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
