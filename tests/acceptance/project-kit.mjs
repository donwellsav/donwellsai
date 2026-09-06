import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { hash, sourceIdentity, validateOptions } from './workspace-baseline.mjs'
import { cleanupOwnedSmokeDaemon, delay } from '../helpers/smoke-processes.mjs'
const { values } = parseArgs({ options: { app: { type: 'string' }, profile: { type: 'string' }, evidence: { type: 'string' }, playwright: { type: 'string' } } })
const { app: executable, resources, profile, evidence } = validateOptions(values)
mkdirSync(profile); mkdirSync(evidence)
const restoreProfile = profile + '-restore'; mkdirSync(restoreProfile)
mkdirSync(join(profile, 'source')); const source = realpathSync(join(profile, 'source'))
const destination = join(restoreProfile, 'restored-project'), archive = join(evidence, 'project-kit.json')
writeFileSync(join(source, 'task.md'), 'KIT_ARTIFACT_20 password=fixture-private-value\n')
const { _electron } = await import(pathToFileURL(resolve(values.playwright)))
const { callRuntime } = await import(pathToFileURL(join(resources, 'dist-cli/cli/rpc-client.js')))
let app, page, activeProfile = profile
const report = { source: sourceIdentity(), artifactSha256: hash(readFileSync(join(resources, 'app.asar'))), sourceProject: source, destination }
const invoke = async (method, params = {}) => { const result = await callRuntime(method, params, activeProfile, 45000); assert(result.ok, result.error); return result.result }
const open = async target => {
  activeProfile = target
  const env = { ...process.env, DONWELLS_USER_DATA: target }
  for (const key of Object.keys(env)) if (key.startsWith('DONWELLS_DOCUMENT_') || ['DONWELLS_HISTORY_BINARY','DONWELLS_HISTORY_ROOTS','DONWELLS_BACKLOG_BINARY','DONWELLS_CODE_GRAPH_BINARY','DONWELLS_BROWSER_TOOL_PACKAGE','DONWELLS_BROWSER_TOOL_EXECUTABLE','DONWELLS_COMPUTER_TOOL_BINARY','ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','DONWELLS_SMOKE'].includes(key)) delete env[key]
  app = await _electron.launch({ executablePath: executable, env, timeout: 30000 }); page = await app.firstWindow()
  await page.getByRole('navigation', { name: 'Workspace tools' }).waitFor()
}
const close = async () => {
  if (!app) return
  for (const session of (await invoke('terminal.list')).sessions) await invoke('terminal.close', { sessionId: session.id })
  await app.close(); app = null
}
try {
  await open(profile); await invoke('settings.set', { theme: 'dark' }); await invoke('repo.add', { dir: source })
  await page.getByTitle(source, { exact: true }).and(page.getByRole('button')).click()
  await invoke('ui.terminal.open', { worktreePath: source }); await invoke('ui.split', { worktreePath: source })
  const memory = { workspacePath: source, kind: 'fact', title: 'Portable project memory', content: 'KIT_MEMORY_FIRST_20', attribution: { harness: 'omp' } }
  const created = await invoke('memory.create', memory)
  await invoke('memory.update', { ...memory, id: created.id, expectedRevision: 1, content: 'KIT_MEMORY_CURRENT_20' })
  await page.evaluate(() => window.donwells.projectMemoryStorageAction('migrate'))
  await invoke('ui.workspace.flush')
  report.originalSessions = (await invoke('terminal.list')).sessions.map(session => session.id)
  await invoke('ui.settings.open', { section: 'advanced' })
  let panel = page.getByRole('region', { name: 'Project backup and restore' })
  await panel.getByText('Export current project', { exact: true }).click()
  await panel.getByLabel('New kit file', { exact: true }).fill(archive)
  await panel.getByLabel('Selected text artifacts, one relative path per line').fill('task.md')
  await panel.getByRole('button', { name: 'Export project kit', exact: true }).click()
  await panel.getByRole('status').filter({ hasText: 'Saved 1 memories' }).waitFor()
  const bytes = readFileSync(archive, 'utf8'); assert(!bytes.includes('fixture-private-value')); assert(!bytes.includes(source))
  const exported = JSON.parse(bytes); assert(exported.payload.layout.panes.filter(pane => pane.kind === 'terminal').length >= 2)
  report.exported = await invoke('project.kit.preview', { archivePath: archive })
  await page.screenshot({ path: join(evidence, 'export.png') }); await close()
  await open(restoreProfile); await invoke('settings.set', { theme: 'dark' })
  await invoke('ui.settings.open', { section: 'advanced' }); panel = page.getByRole('region', { name: 'Project backup and restore' })
  await panel.getByText('Restore into a new project', { exact: true }).click()
  await panel.getByLabel('Kit file to restore').fill(archive)
  await panel.getByRole('button', { name: 'Review project kit', exact: true }).click()
  await panel.getByText('Source identity:', { exact: false }).waitFor()
  await panel.getByLabel('New destination folder').fill(destination)
  await page.screenshot({ path: join(evidence, 'restore-preview.png') })
  await panel.getByRole('button', { name: 'Restore reviewed kit', exact: true }).click()
  await panel.getByRole('status').filter({ hasText: 'Restored to' }).waitFor({ timeout: 45000 })
  report.restored = await invoke('project.kit.report', { workspacePath: destination })
  report.memory = await invoke('memory.list', { workspacePath: destination, query: 'KIT_MEMORY_CURRENT_20' })
  assert.equal(report.memory.entries.length, 1)
  report.history = await invoke('memory.history', { workspacePath: destination, id: report.memory.entries[0].id })
  assert.deepEqual(report.history.revisions.map(value => value.content), ['KIT_MEMORY_CURRENT_20','KIT_MEMORY_FIRST_20'])
  assert(readFileSync(join(destination, 'task.md'), 'utf8').includes('password=[redacted]'))
  report.newSessions = (await invoke('terminal.list')).sessions.filter(session => session.worktreePath === realpathSync(destination)).map(session => session.id)
  assert(report.newSessions.length >= 2); assert(report.newSessions.every(id => !report.originalSessions.includes(id)))
  await page.screenshot({ path: join(evidence, 'restored-report.png') }); await page.keyboard.press('Escape')
  await page.locator('.xterm-screen').first().waitFor({ state: 'visible', timeout: 10000 })
  for (const sessionId of report.newSessions) await invoke('terminal.write', { sessionId, data: "printf 'RESTORED_TERMINAL_20\\n'", enter: true })
  await delay(1500)
  report.renderedTerminals = await page.evaluate(() => [...document.querySelectorAll('.xterm-screen')].map(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })))
  assert(report.renderedTerminals.filter(value => value.width > 100 && value.height > 100).length >= 2)
  await page.screenshot({ path: join(evidence, 'restored-terminals.png') })
  const duplicate = await callRuntime('project.kit.import', { archivePath: archive, destinationPath: destination, expectedSha256: report.exported.sha256, sourceProjectKey: report.exported.sourceProjectKey }, activeProfile, 45000)
  assert.equal(duplicate.ok, false); report.duplicateRefused = true
  await invoke('ui.workspace.flush'); await app.close(); app = null
  await open(restoreProfile)
  report.afterRestart = await invoke('memory.list', { workspacePath: destination, query: 'KIT_MEMORY_CURRENT_20' }); assert.equal(report.afterRestart.entries.length, 1)
  const sessions = (await invoke('terminal.list')).sessions.map(session => session.id); assert(report.newSessions.every(id => sessions.includes(id)))
  await page.evaluate(async path => { const report = await window.donwells.projectDoctorInspect(path); if (report.configuration.disabled.length !== 6) throw new Error('Imported tools were enabled') }, destination)
  report.verified = true
} catch (error) { report.error = error.stack; process.exitCode = 1; if (page) await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {}) }
finally {
  try { await close() } catch (error) { report.cleanupError = String(error); await app?.close().catch(() => {}) }
  report.idleDaemonsStopped = await Promise.all([profile, restoreProfile].map(cleanupOwnedSmokeDaemon))
  writeFileSync(join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n')
}
