import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { sourceIdentity, hash } from './workspace-baseline.mjs'
import { closeOwnedSmokeApp, cleanupOwnedSmokeDaemon } from '../helpers/smoke-processes.mjs'
const { values } = parseArgs({ options: Object.fromEntries(['profile', 'evidence', 'playwright', 'project', 'history', 'history-root'].map(key => [key, { type: 'string' }])) })
for (const key of ['profile', 'evidence', 'playwright', 'project', 'history', 'history-root']) assert(values[key])
const profile = resolve(values.profile), evidence = resolve(values.evidence), project = resolve(values.project), root = resolve(import.meta.dirname, '../..')
mkdirSync(profile); mkdirSync(evidence)
const { _electron } = await import(pathToFileURL(resolve(values.playwright)))
const { callRuntime } = await import(pathToFileURL(join(root, 'dist-cli/cli/rpc-client.js')))
const invoke = async (method, params = {}) => { const result = await callRuntime(method, params, profile, 150000); assert(result.ok, result.error); return result.result }
const env = { ...process.env, DONWELLS_USER_DATA: profile, DONWELLS_HISTORY_BINARY: resolve(values.history), DONWELLS_HISTORY_ROOTS: JSON.stringify({ omp: [resolve(values['history-root'])] }) }
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'DONWELLS_SMOKE']) delete env[key]
const report = { source: sourceIdentity(), builtMainSha256: hash(readFileSync(join(root, 'out/main/index.js'))), qualification: 'Built Electron checkout; not a packaged-release claim' }
let app
try {
  app = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [root], env })
  const page = await app.firstWindow()
  await page.getByRole('navigation', { name: 'Workspace tools' }).waitFor()
  await invoke('repo.add', { dir: project })
  await page.getByRole('button', { name: /Main checkout/ }).click()
  await invoke('settings.set', { theme: 'dark' })
  await invoke('history.index', { workspacePath: project })
  report.analytics = await invoke('history.analytics', { workspacePath: project })
  assert(report.analytics.sessions > 0)
  await invoke('ui.sidebar', { side: 'right', open: true, tab: 'search', width: 480 })
  const search = page.getByRole('region', { name: 'Project search' })
  await search.getByRole('button', { name: 'Sessions', exact: true }).click()
  const summary = search.locator('summary').filter({ hasText: 'Usage and outcomes' })
  await summary.focus(); await page.keyboard.press('Enter')
  await search.getByRole('table', { name: 'Native session usage' }).waitFor()
  await search.getByText('Cost unavailable: these sessions contain no billing events.', { exact: true }).waitFor()
  await search.getByRole('button', { name: 'Refresh analytics' }).focus(); await page.keyboard.press('Enter')
  await page.waitForFunction(() => {
    const panel = document.querySelector('.project-analytics')
    return panel?.querySelector('table') && !panel.querySelector('button')?.disabled && !panel.textContent.includes('Reading project records')
  })
  await search.getByRole('table', { name: 'Native session usage' }).waitFor()
  await page.screenshot({ path: join(evidence, 'analytics.png') })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 720))
  await page.waitForFunction(() => {
    const panel = document.querySelector('.project-analytics')?.getBoundingClientRect()
    const search = document.querySelector('.project-search')?.getBoundingClientRect()
    return panel && search && panel.height >= 28 && panel.bottom <= search.bottom + 1
  })
  await page.screenshot({ path: join(evidence, 'analytics-small-window.png') })
  report.smallWindowPanelContained = true
  report.keyboardDisclosureAndRefresh = true
  report.complete = true
} catch (error) { report.error = String(error); process.exitCode = 1 }
finally {
  if (app) {
    try { for (const session of (await invoke('terminal.list')).sessions) await invoke('terminal.close', { sessionId: session.id }) } catch (error) { report.cleanupError = String(error); process.exitCode = 1 }
    report.appShutdown = await closeOwnedSmokeApp(app)
  }
  report.daemonStopped = await cleanupOwnedSmokeDaemon(profile)
  writeFileSync(join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n')
}
