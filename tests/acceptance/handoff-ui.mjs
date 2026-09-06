import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { hash, sourceIdentity, validateOptions } from './workspace-baseline.mjs'
import { cleanupOwnedSmokeDaemon, delay } from '../helpers/smoke-processes.mjs'

const { values } = parseArgs({ options: { app: { type: 'string' }, profile: { type: 'string' }, evidence: { type: 'string' }, playwright: { type: 'string' } } })
assert(values.playwright, '--playwright is required')
const { app: executable, resources, profile, evidence } = validateOptions(values)
mkdirSync(profile, { mode: 0o700 }); mkdirSync(evidence, { mode: 0o700 })
const fixture = mkdtempSync(join(profile, 'project-'))
execFileSync('git', ['init', '-q', fixture])
writeFileSync(join(fixture, 'README.md'), 'Handoff fixture\n')
execFileSync('git', ['add', '.'], { cwd: fixture })
execFileSync('git', ['-c', 'user.name=Acceptance', '-c', 'user.email=acceptance@example.invalid', 'commit', '-qm', 'Fixture'], { cwd: fixture })
const { _electron } = await import(pathToFileURL(resolve(values.playwright)))
const { callRuntime } = await import(pathToFileURL(join(resources, 'dist-cli/cli/rpc-client.js')))
const invoke = async (method, params = {}) => {
  const response = await callRuntime(method, params, profile, 10000)
  assert(response.ok, response.error)
  return response.result
}
const env = { ...process.env, DONWELLS_USER_DATA: profile }
delete env.ELECTRON_RUN_AS_NODE; delete env.DONWELLS_SMOKE; delete env.ELECTRON_RENDERER_URL
const report = { source: sourceIdentity(), artifactSha256: hash(readFileSync(join(resources, 'app.asar'))), memoryMcpSha256: hash(readFileSync(join(resources, 'dist-cli/cli/project-memory-mcp.js'))), profile, fixture }
let app
const start = performance.now()
try {
  app = await _electron.launch({ executablePath: executable, env })
  const firstPid = app.process().pid
  const page = await app.firstWindow()
  await page.getByRole('navigation', { name: 'Workspace tools' }).waitFor()
  await invoke('settings.set', { theme: 'dark' })
  await invoke('repo.add', { dir: fixture })
  await page.getByRole('button', { name: /Main checkout/ }).click()
  const source = await invoke('agent.start', { workspacePath: fixture, command: '/bin/cat' })
  await page.getByRole('button', { name: 'Agent sessions', exact: true }).click()
  await page.getByRole('button', { name: 'Resume terminal', exact: true }).click()
  const terminalSelector = `[data-pane-key="term:${source.run.sessionId}"] .xterm-helper-textarea`
  await page.locator(terminalSelector).focus()
  for (const closeUsing of ['button', 'rail']) {
    await page.getByRole('button', { name: 'Project memory', exact: true }).click()
    await page.getByRole('button', { name: closeUsing === 'button' ? 'Close workspace panel' : 'Project memory', exact: true }).click()
    await page.waitForFunction(selector => document.activeElement === document.querySelector(selector), terminalSelector, { timeout: 3000 })
  }
  await page.keyboard.type('sidebar-focus-check\n')
  await page.waitForFunction(async sessionId => (await window.donwells.attachTerminal(sessionId)).scrollback.includes('sidebar-focus-check'), source.run.sessionId)
  report.sidebarCloseRestoresTerminalInput = true
  const requestPath = join(profile, 'handoff-request.json'), resultPath = join(profile, 'handoff-receipt.json')
  const quote = value => `'${value.replaceAll("'", `'\\''`)}'`
  const command = [process.execPath, resolve('tests/fixtures/handoff-mcp-receiver.mjs'), executable, join(resources, 'dist-cli/cli/index.js'), profile, fixture, requestPath, resultPath].map(quote).join(' ')
  const receiver = await invoke('agent.start', { workspacePath: fixture, command })
  await page.getByRole('button', { name: 'Project memory', exact: true }).click()
  await page.locator('.handoff-panel > summary').click()
  const panel = page.locator('.handoff-panel')
  assert(await panel.evaluate(element => !!element.closest('.right-sidebar')))
  await panel.getByLabel('Source session', { exact: true }).selectOption(source.run.sessionId)
  await panel.getByLabel('Goal', { exact: true }).fill('Continue terminal workspace')
  await panel.getByLabel('Progress summary').fill('Controls belong in side panels.')
  await panel.getByLabel('Next steps').fill('Verify source freshness\nContinue implementation')
  await panel.getByRole('button', { name: 'Save handoff for review' }).click()
  const review = panel.getByRole('region', { name: 'Handoff review' })
  await review.getByText('Controls belong in side panels.', { exact: true }).waitFor()
  const list = () => page.evaluate(path => window.donwells.projectHandoffList(path), fixture)
  const [saved] = await list()
  assert.equal(saved.state, 'open')
  writeFileSync(join(fixture, 'README.md'), 'Source changed\n')
  await panel.getByRole('button', { name: 'Refresh handoffs' }).click()
  await review.getByRole('status').waitFor()
  assert(await review.getByRole('button', { name: 'Accept handoff' }).isDisabled())
  writeFileSync(join(fixture, 'README.md'), 'Handoff fixture\n')
  await panel.getByRole('button', { name: 'Refresh handoffs' }).click()
  await review.getByRole('status').waitFor({ state: 'detached' })
  await review.getByLabel('Receiving session').selectOption(receiver.run.sessionId)
  await review.getByRole('button', { name: 'Accept handoff' }).click()
  await review.getByText(`Accepted by ${receiver.run.sessionId}`, { exact: true }).waitFor()
  let [accepted] = await list()
  assert.equal(accepted.state, 'accepted')
  assert.equal(accepted.delivery, 'not-sent')
  assert.equal(accepted.revision, 2)
  writeFileSync(requestPath + '.tmp', JSON.stringify({ id: accepted.id, expectedRevision: accepted.revision }), { mode: 0o600 })
  renameSync(requestPath + '.tmp', requestPath)
  const deadline = Date.now() + 20000
  while (!existsSync(resultPath)) { assert(Date.now() < deadline, 'Native MCP receipt missing'); await delay(100) }
  report.nativeMcp = JSON.parse(readFileSync(resultPath, 'utf8'))
  ;[accepted] = await list()
  assert.equal(accepted.delivery, 'confirmed')
  assert.equal(accepted.revision, 4)
  await panel.getByRole('button', { name: 'Refresh handoffs' }).click()
  await review.getByText(/Delivery: confirmed/).waitFor()
  await panel.getByRole('button', { name: 'Export project handoffs' }).click()
  const exportStatus = panel.getByRole('status').filter({ hasText: 'Handoff export saved:' })
  await exportStatus.waitFor()
  const exportPath = (await exportStatus.innerText()).replace('Handoff export saved: ', '')
  assert.deepEqual(JSON.parse(readFileSync(exportPath, 'utf8')).handoffs, [accepted])
  report.exportPreservedConfirmedHandoff = true
  await panel.evaluate(element => { element.scrollTop = 0 })
  await page.screenshot({ path: join(evidence, 'handoff-sidebar.png') })
  for (const run of (await invoke('agent.list')).agents) await invoke('agent.stop', { sessionId: run.sessionId })
  await app.close(); app = null
  app = await _electron.launch({ executablePath: executable, env })
  assert.notEqual(app.process().pid, firstPid)
  const restarted = await app.firstWindow()
  await restarted.getByRole('navigation', { name: 'Workspace tools' }).waitFor()
  assert.deepEqual(await restarted.evaluate(path => window.donwells.projectHandoffList(path), fixture), [accepted])
  Object.assign(report, { createReviewAccept: true, staleSourceDisabled: true, persistedAcrossProcesses: [firstPid, app.process().pid], controlsInSidebar: true, delivery: accepted.delivery })
} catch (error) { report.error = String(error); if (app) await (await app.firstWindow()).screenshot({ path: join(evidence, 'failure.png') }).catch(() => {}); process.exitCode = 1 }
finally {
  if (app) {
    try {
      for (const run of (await invoke('agent.list')).agents) {
        if (run.liveness !== 'exited') await invoke('agent.stop', { sessionId: run.sessionId })
        const deadline = Date.now() + 15000
        while ((await invoke('agent.list')).agents.find(item => item.sessionId === run.sessionId)?.liveness !== 'exited') {
          assert(Date.now() < deadline, 'Agent stop timed out')
          await delay(100)
        }
        await invoke('agent.dismiss', { sessionId: run.sessionId })
      }
      for (const session of (await invoke('terminal.list')).sessions) await invoke('terminal.close', { sessionId: session.id })
    } catch (error) { report.cleanupError = String(error); process.exitCode = 1 }
    await app.close()
  }
  report.idleDaemonStopped = await cleanupOwnedSmokeDaemon(profile)
  if (!report.idleDaemonStopped) process.exitCode = 1
  report.durationMs = performance.now() - start
  writeFileSync(join(evidence, 'handoff-ui.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(report))
}
