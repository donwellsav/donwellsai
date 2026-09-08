#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { cleanupOwnedSmokeDaemon, closeOwnedSmokeApp, cleanSmokeAppShutdown } from '../helpers/smoke-processes.mjs'

const root = resolve(import.meta.dirname, '../..')
const { values } = parseArgs({ options: { app: { type: 'string' }, evidence: { type: 'string' }, source: { type: 'boolean', default: false }, playwright: { type: 'string' } } })
assert(values.app, '--app is required')
assert(values.evidence, '--evidence is required')
const executable = realpathSync(resolve(values.app))
assert(lstatSync(executable).isFile(), '--app must name an executable file')
mkdirSync(resolve(values.evidence), { mode: 0o700 })
const evidence = realpathSync(resolve(values.evidence))
const profile = join(evidence, 'profile'), project = join(evidence, 'project')
mkdirSync(profile, { mode: 0o700 }); mkdirSync(project, { mode: 0o700 })
writeFileSync(join(project, 'README.md'), '# Palette fixture\n')

const resources = values.source ? root : resolve(dirname(executable), '../Resources')
const rpcClient = values.source ? join(root, 'dist-cli/cli/rpc-client.js') : join(resources, 'dist-cli/cli/rpc-client.js')
const { callRuntime } = await import(pathToFileURL(rpcClient).href)
const { _electron } = await import(values.playwright ? pathToFileURL(resolve(values.playwright)).href : import.meta.resolve('playwright'))
const invoke = async (method, params = {}) => { const response = await callRuntime(method, params, profile, 10000); assert(response.ok, response.error); return response.result }
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const env = { ...process.env, DONWELLS_USER_DATA: profile }
delete env.DONWELLS_SMOKE; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
const report = {
  schemaVersion: 1,
  sourceMode: values.source,
  executable,
  executableSha256: sha256(executable),
  profile,
  project,
  expectedPaneKey: `memory:${project}`,
  renderedOptionsBeforeAssertion: []
}
let app, child, page
try {
  app = await _electron.launch({ executablePath: executable, args: values.source ? [root] : [], env, timeout: 30000 })
  child = app.process()
  page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  await page.getByRole('navigation', { name: 'Workspace tools' }).waitFor()
  await invoke('repo.add', { dir: project })
  await page.waitForFunction(path => window.__store.getState().repos.some(repo => repo.repo.path === path), project)
  const opened = await page.evaluate(path => {
    const state = window.__store.getState()
    state.setActiveRepo(state.repos.find(repo => repo.repo.path === path).repo.id)
    state.setActiveWorktree(path)
    state.openWorkspaceModule(path, 'memory')
    return { activePane: window.__store.getState().activePane[path], panes: window.__store.getState().panes[path].map(pane => ({ key: pane.key, kind: pane.kind })) }
  }, project)
  assert.equal(opened.activePane, report.expectedPaneKey)
  assert(opened.panes.some(pane => pane.key === report.expectedPaneKey && pane.kind === 'memory'))

  await page.keyboard.press('Meta+p')
  const palette = page.locator('.palette-dialog')
  await palette.waitFor()
  await palette.getByRole('button', { name: 'Everywhere', exact: true }).click()
  const options = palette.getByRole('option')
  report.renderedOptionsBeforeAssertion = await options.allTextContents()
  assert(!report.renderedOptionsBeforeAssertion.some(label => /Diff\s*·?\s*Source Control/i.test(label)), 'Memory module is mislabeled as Diff · Source Control')
  assert(report.renderedOptionsBeforeAssertion.some(label => /Project memory/i.test(label)), 'Project memory is absent from the palette')

  const input = palette.getByRole('combobox')
  await input.fill('memory')
  const memoryOption = palette.getByRole('option').filter({ hasText: 'Project memory' })
  await memoryOption.waitFor()
  assert.equal(await memoryOption.count(), 1, 'Memory search must identify exactly one retained module pane')
  report.filteredOption = await memoryOption.innerText()
  await memoryOption.click()
  await palette.waitFor({ state: 'detached' })
  report.activePaneAfterSelection = await page.evaluate(path => window.__store.getState().activePane[path], project)
  assert.equal(report.activePaneAfterSelection, report.expectedPaneKey)

  // Persisted-layout compatibility proof: a retired 'environments' pane in the saved session must restore as a closable removal note.
  const retiredPaneKey = `environments:${project}`
  await page.waitForFunction(async path => {
    const session = await window.donwells.getWorkspaceSession()
    const state = window.__store.getState().activeRepoId
    return Boolean(session?.repos?.[state]?.panes?.[path]?.some(pane => pane.kind === 'memory'))
  }, project)

  // Inject while the app is closed so no renderer snapshot can overwrite the edit.
  report.relaunchShutdown = await closeOwnedSmokeApp(app, child)
  app = null
  assert(cleanSmokeAppShutdown(report.relaunchShutdown), 'Relaunch shutdown was not clean')
  const dataFile = join(profile, 'donwells-data.json')
  const data = JSON.parse(readFileSync(dataFile, 'utf8'))
  const repoId = data.workspaceSession.activeRepoId
  const panes = data.workspaceSession.repos[repoId].panes[project]
  const source = panes.find(pane => pane.kind === 'memory')
  assert(source, 'Memory pane must persist before injection')
  panes.push({ ...source, key: retiredPaneKey, kind: 'environments' })
  writeFileSync(dataFile, JSON.stringify(data, null, 2) + '\n', 'utf8')
  report.injectedRetiredPane = { repoId, panes: panes.map(pane => pane.key) }

  app = await _electron.launch({ executablePath: executable, args: values.source ? [root] : [], env, timeout: 30000 })
  child = app.process()
  page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  await page.getByRole('navigation', { name: 'Workspace tools' }).waitFor()
  await page.waitForFunction(path => window.__store.getState().repos.some(repo => repo.repo.path === path), project)
  await page.evaluate(path => {
    const state = window.__store.getState()
    state.setActiveRepo(state.repos.find(repo => repo.repo.path === path).repo.id)
    state.setActiveWorktree(path)
  }, project)
  const retiredTab = page.locator('.flexlayout__tab_button').filter({ hasText: 'Project environments' })
  await retiredTab.waitFor()
  assert.equal(await retiredTab.count(), 1, 'Restored environments pane must render exactly one retained tab')
  await retiredTab.click()
  const retiredPane = page.locator('[data-pane-kind="environments"]')
  const note = retiredPane.locator('.empty-note')
  await note.getByText('Project environments were removed from Donwells. This view can be closed.', { exact: true }).waitFor()
  report.environmentsRestore = { paneKey: retiredPaneKey, emptyNote: await note.innerText() }
  await page.screenshot({ path: join(evidence, 'environments-restored.png') })
  await note.getByRole('button', { name: 'Close this view', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('[data-pane-kind="environments"]'))
  report.environmentsRestore.closedViaButton = true
  report.passed = true
} catch (error) {
  report.error = String(error)
  process.exitCode = 1
} finally {
  if (app) {
    try {
      for (const session of (await invoke('terminal.list')).sessions) await invoke('terminal.close', { sessionId: session.id })
    } catch (error) { report.sessionCleanupError = String(error); process.exitCode = 1 }
    try { report.appShutdown = await closeOwnedSmokeApp(app, child); assert(cleanSmokeAppShutdown(report.appShutdown)) }
    catch (error) { report.appShutdownError = String(error); process.exitCode = 1 }
  }
  try { report.daemonCleanup = await cleanupOwnedSmokeDaemon(profile); assert(report.daemonCleanup) }
  catch (error) { report.daemonCleanupError = String(error); process.exitCode = 1 }
  writeFileSync(join(evidence, 'module-palette.json'), JSON.stringify(report, null, 2) + '\n')
}

console.log(JSON.stringify(report, null, 2))
