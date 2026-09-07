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
  expectedPaneKey: `environments:${project}`,
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
    state.openWorkspaceModule(path, 'environments')
    return { activePane: window.__store.getState().activePane[path], panes: window.__store.getState().panes[path].map(pane => ({ key: pane.key, kind: pane.kind })) }
  }, project)
  assert.equal(opened.activePane, report.expectedPaneKey)
  assert(opened.panes.some(pane => pane.key === report.expectedPaneKey && pane.kind === 'environments'))

  await page.keyboard.press('Meta+p')
  const palette = page.locator('.palette-dialog')
  await palette.waitFor()
  await palette.getByRole('button', { name: 'Everywhere', exact: true }).click()
  const options = palette.getByRole('option')
  report.renderedOptionsBeforeAssertion = await options.allTextContents()
  assert(!report.renderedOptionsBeforeAssertion.some(label => /Diff\s*·?\s*Source Control/i.test(label)), 'Environment module is mislabeled as Diff · Source Control')
  assert(report.renderedOptionsBeforeAssertion.some(label => /Project environments/i.test(label)), 'Project environments is absent from the palette')

  const input = palette.getByRole('combobox')
  await input.fill('environment')
  const environmentOption = palette.getByRole('option').filter({ hasText: 'Project environments' })
  await environmentOption.waitFor()
  assert.equal(await environmentOption.count(), 1, 'Environment search must identify exactly one retained module pane')
  report.filteredOption = await environmentOption.innerText()
  await environmentOption.click()
  await palette.waitFor({ state: 'detached' })
  report.activePaneAfterSelection = await page.evaluate(path => window.__store.getState().activePane[path], project)
  assert.equal(report.activePaneAfterSelection, report.expectedPaneKey)
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
