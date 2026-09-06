import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { hash, sourceIdentity, validateOptions } from './workspace-baseline.mjs'
import { cleanupOwnedSmokeDaemon } from '../helpers/smoke-processes.mjs'

const { values } = parseArgs({ options: { app: { type: 'string' }, profile: { type: 'string' }, evidence: { type: 'string' }, playwright: { type: 'string' } } })
assert(values.playwright, '--playwright is required')
const { app: executable, resources, profile, evidence } = validateOptions(values)
mkdirSync(profile, { mode: 0o700 }); mkdirSync(evidence, { mode: 0o700 })
const fixture = mkdtempSync(join(profile, 'project-'))
execFileSync('git', ['init', '-q', fixture])
const { _electron } = await import(pathToFileURL(resolve(values.playwright)))
const { callRuntime } = await import(pathToFileURL(join(resources, 'dist-cli/cli/rpc-client.js')))
const invoke = async (method, params = {}) => {
  const response = await callRuntime(method, params, profile, 10000)
  assert(response.ok, response.error)
  return response.result
}
const env = { ...process.env, DONWELLS_USER_DATA: profile }
delete env.ELECTRON_RUN_AS_NODE; delete env.DONWELLS_SMOKE; delete env.ELECTRON_RENDERER_URL
const report = { source: sourceIdentity(), artifactSha256: hash(readFileSync(join(resources, 'app.asar'))), profile, fixture }
let app
try {
  app = await _electron.launch({ executablePath: executable, env })
  const page = await app.firstWindow()
  await page.getByRole('navigation', { name: 'Workspace tools' }).waitFor()
  await invoke('settings.set', { theme: 'dark' })
  await invoke('repo.add', { dir: fixture })
  await page.getByRole('button', { name: /Main checkout/ }).click()
  const request = { workspacePath: fixture, kind: 'decision', title: 'Shared terminal workspace', content: 'Keep terminal controls in side panels.', attribution: { harness: 'cli' } }
  const entry = await invoke('memory.create', request)
  const originalHash = hash(readFileSync(join(profile, 'project-memory.json')))
  await page.getByRole('button', { name: 'Terminal', exact: true }).click()
  await page.getByRole('button', { name: 'Layout', exact: true }).click()
  const split = page.getByRole('button', { name: 'Split terminal right', exact: true })
  assert(await split.evaluate(element => !!element.closest('.workspace-layout-popover')))
  assert.equal(await page.locator('.workspace-docking-surface button[aria-label="Split terminal right"]').count(), 0)
  const beforeSplit = (await invoke('terminal.list')).sessions.length
  await split.click()
  await page.waitForFunction(count => document.querySelectorAll('[data-pane-kind="terminal"]').length > count, beforeSplit)
  assert.equal((await invoke('terminal.list')).sessions.length, beforeSplit + 1)
  report.sidePanelSplitPassed = true
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Project memory', exact: true }).click()
  await page.locator('.memory-storage > summary').click()
  await page.getByRole('button', { name: 'Upgrade to SQLite', exact: true }).click()
  await page.getByText('Shared memory now uses SQLite.', { exact: true }).waitFor()
  const authority = JSON.parse(readFileSync(join(profile, 'project-memory-active.json'), 'utf8'))
  assert.equal(authority.state, 'sqlite')
  assert.equal(hash(readFileSync(join(profile, authority.directory, 'project-memory.json.backup'))), originalHash)
  assert.deepEqual(await invoke('memory.get', { workspacePath: fixture, id: entry.id }), entry)
  report.guiUpgradePassed = true
  await page.getByRole('button', { name: 'Export current memory', exact: true }).click()
  await page.locator('.memory-storage [role="status"]').filter({ hasText: 'Export saved:' }).waitFor()
  const message = await page.locator('.memory-storage [role="status"]').innerText()
  const exportPath = message.replace(/^Export saved: /, '')
  assert.equal(JSON.parse(readFileSync(exportPath, 'utf8')).projects[0].entries[0].current.id, entry.id)
  report.guiExportPassed = true
  report.exportPath = exportPath
  const changed = await invoke('memory.update', { ...request, id: entry.id, expectedRevision: 1, content: 'Written after SQLite upgrade' })
  await page.getByRole('button', { name: 'Return current memory to JSON', exact: true }).click()
  await page.getByText('Current memory now uses JSON.', { exact: true }).waitFor()
  assert.deepEqual(await invoke('memory.get', { workspacePath: fixture, id: entry.id }), changed)
  assert.equal(JSON.parse(readFileSync(join(profile, 'project-memory.json'), 'utf8')).projects[0].entries[0].current.content, changed.content)
  assert.equal(hash(readFileSync(join(profile, authority.directory, 'project-memory.json.backup'))), originalHash)
  report.guiReversePreservedNewWrites = true

  await page.screenshot({ path: join(evidence, 'memory-storage.png') })
  report.storageWithinSidePanel = await page.locator('.memory-storage').evaluate(element => !!element.closest('.right-sidebar'))
  assert(report.storageWithinSidePanel)
} catch (error) { report.error = String(error); process.exitCode = 1 }
finally {
  if (app) {
    for (const session of (await invoke('terminal.list')).sessions) await invoke('terminal.close', { sessionId: session.id })
    await app.close()
  }
  report.idleDaemonStopped = await cleanupOwnedSmokeDaemon(profile)
  if (!report.idleDaemonStopped) process.exitCode = 1
  writeFileSync(join(evidence, 'memory-storage-ui.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(report))
}
