import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { hash, sourceIdentity, validateOptions } from './workspace-baseline.mjs'
import { cleanupOwnedSmokeDaemon, delay } from '../helpers/smoke-processes.mjs'

const { values } = parseArgs({ options: { app: { type: 'string' }, profile: { type: 'string' }, evidence: { type: 'string' }, playwright: { type: 'string' }, 'code-graph-binary': { type: 'string' } } })
assert(values.playwright)
const { app: executable, resources, profile, evidence } = validateOptions(values)
mkdirSync(profile, { mode: 0o700 }); mkdirSync(evidence, { mode: 0o700 })
const first = join(profile, 'first-project'), second = join(profile, 'second-project')
for (const path of [first, second]) { mkdirSync(path); execFileSync('git', ['init', '-q', path]) }
writeFileSync(join(first, 'alpha.ts'), 'const first = 1\nconst second = 2\nconst needle = "searchfixture"\n')
writeFileSync(join(first, '.gitignore'), 'ignored.ts\n')
writeFileSync(join(first, 'ignored.ts'), '// searchfixture ignored\n')
writeFileSync(join(second, 'beta.ts'), '// searchfixture second project\n')
if (values['code-graph-binary']) writeFileSync(join(first, 'graph.ts'), 'export function graphTarget() { return 1 }\nexport function graphCaller() { return graphTarget() }\n')
const { _electron } = await import(pathToFileURL(resolve(values.playwright)))
const { callRuntime } = await import(pathToFileURL(join(resources, 'dist-cli/cli/rpc-client.js')))
const invoke = async (method, params = {}) => { const response = await callRuntime(method, params, profile, 10000); assert(response.ok, response.error); return response.result }
const env = { ...process.env, DONWELLS_USER_DATA: profile }
if (values['code-graph-binary']) env.DONWELLS_CODE_GRAPH_BINARY = resolve(values['code-graph-binary'])
else delete env.DONWELLS_CODE_GRAPH_BINARY
delete env.ELECTRON_RUN_AS_NODE; delete env.DONWELLS_SMOKE; delete env.ELECTRON_RENDERER_URL
const report = { source: sourceIdentity(), artifactSha256: hash(readFileSync(join(resources, 'app.asar'))) }
let app, page
const start = performance.now()
try {
  app = await _electron.launch({ executablePath: executable, env })
  page = await app.firstWindow()
  await page.getByRole('navigation', { name: 'Workspace tools' }).waitFor()
  await invoke('settings.set', { theme: 'dark' })
  await invoke('repo.add', { dir: first }); await invoke('repo.add', { dir: second })
  if (values['code-graph-binary']) {
    const scoped = { workspacePath: first, id: 'code-graph' }
    const indexed = await invoke('tool.call', { ...scoped, operation: 'index', arguments: {} })
    assert(!indexed.isError, JSON.stringify(indexed))
    const response = await invoke('tool.call', { ...scoped, operation: 'callers', arguments: { function_name: 'graphTarget' } })
    assert(!response.isError, JSON.stringify(response))
    const result = response.structuredContent ?? JSON.parse(response.content[0].text)
    assert.deepEqual(result.callers.groups.flatMap(group => group.rows.map(row => row[0])), ['graphCaller'])
    assert.equal(result.freshness.state, 'current')
    writeFileSync(join(first, 'graph.ts'), 'export function graphTarget() { return 2 }\nexport function graphRenamedCaller() { return graphTarget() }\n')
    const stale = await invoke('tool.call', { ...scoped, operation: 'callers', arguments: { function_name: 'graphTarget' } })
    assert.equal(stale.structuredContent.freshness.state, 'stale')
    const rebuilt = await invoke('tool.call', { ...scoped, operation: 'index', arguments: {} })
    assert.equal(rebuilt.structuredContent.freshness.state, 'current')
    const renamed = await invoke('tool.call', { ...scoped, operation: 'callers', arguments: { function_name: 'graphTarget' } })
    assert.deepEqual(renamed.structuredContent.callers.groups.flatMap(group => group.rows.map(row => row[0])), ['graphRenamedCaller'])
    report.packagedGraph = { stale: stale.structuredContent, rebuilt: rebuilt.structuredContent, renamed: renamed.structuredContent, indexed: indexed.structuredContent ?? JSON.parse(indexed.content[0].text), callers: result }
    await invoke('tool.stop', scoped)
  }
  await page.getByTitle(first, { exact: true }).and(page.getByRole('button')).click()
  await page.getByRole('button', { name: 'Content search', exact: true }).click()
  await page.evaluate(() => { window.searchEvents = []; window.donwells.on('project-search:hit', event => window.searchEvents.push(event)) })
  const query = page.getByRole('searchbox', { name: 'Search text', exact: true })
  const results = page.getByRole('list', { name: 'Content matches' })
  await page.locator('.project-graph-disclosure > summary').click()
  const graph = page.getByLabel('Code graph', { exact: true })
  if (values['code-graph-binary']) {
    await graph.getByRole('button', { name: 'Rebuild code index' }).click()
    await graph.getByRole('status').filter({ hasText: 'Indexed' }).waitFor()
    await graph.getByLabel('Function name', { exact: true }).fill('graphTarget')
    await graph.getByRole('button', { name: 'Find callers', exact: true }).click()
    await graph.getByRole('list', { name: 'Caller matches' }).getByText('graphRenamedCaller', { exact: true }).waitFor()
    writeFileSync(join(first, 'graph.ts'), 'export function graphTarget() { return 3 }\nexport function sidebarCaller() { return graphTarget() }\n')
    await graph.getByRole('button', { name: 'Find callers', exact: true }).click()
    await graph.getByRole('status').filter({ hasText: 'Source changed' }).waitFor()
    await graph.getByRole('button', { name: 'Rebuild code index' }).click()
    await graph.getByRole('status').filter({ hasText: 'Indexed' }).waitFor()
    await graph.getByRole('button', { name: 'Find callers', exact: true }).click()
    await graph.getByRole('list', { name: 'Caller matches' }).getByText('sidebarCaller', { exact: true }).waitFor()
    await graph.getByRole('button', { name: 'Find in text', exact: true }).click()
    await results.getByRole('button', { name: /graph.ts:2/ }).waitFor()
    assert.equal(await query.inputValue(), 'sidebarCaller')
    await page.screenshot({ path: join(evidence, 'graph-sidebar.png') })
    await graph.getByRole('button', { name: 'Rebuild code index' }).click()
    await graph.getByRole('status').filter({ hasText: 'Building code index' }).waitFor()
    await page.getByTitle(second, { exact: true }).and(page.getByRole('button')).click()
    await graph.getByText('Graph service: stopped', { exact: true }).waitFor()
    assert.equal(await graph.getByLabel('Function name', { exact: true }).inputValue(), 'graphTarget')
    assert.equal(await graph.getByRole('list', { name: 'Caller matches' }).count(), 0)
    await page.getByTitle(first, { exact: true }).and(page.getByRole('button')).click()
    await graph.getByText('Graph service: ready', { exact: true }).waitFor()
    await graph.getByRole('button', { name: 'Stop graph', exact: true }).click()
    await graph.getByText('Graph service: stopped', { exact: true }).waitFor()
    report.graphSidebar = { rebuilt: true, staleVisible: true, renamedCaller: true, findInText: true, projectSwitchFenced: true, queryRetained: true, stopped: true }
  } else {
    await graph.getByRole('status').filter({ hasText: 'Code graph is not enabled' }).waitFor()
    report.graphUnavailableVisible = true
  }
  await page.locator('.project-graph-disclosure > summary').click()
  await query.fill('searchfixture')
  await results.getByRole('button', { name: /alpha.ts:3/ }).waitFor()
  assert.equal(await results.getByRole('button').count(), 1)
  const oldEvent = await page.evaluate(() => window.searchEvents[0])
  assert(oldEvent)
  await page.getByLabel('Ignored files', { exact: true }).check()
  await results.getByRole('button', { name: /ignored.ts:1/ }).waitFor()
  await page.getByLabel('Ignored files', { exact: true }).uncheck()
  await page.waitForFunction(() => document.querySelectorAll('.project-search-results li').length === 1)
  await results.getByRole('button', { name: /alpha.ts:3/ }).click()
  const editor = page.locator('.monaco-editor textarea').first()
  await editor.waitFor()
  await page.waitForFunction(() => document.activeElement?.closest('.monaco-editor'))
  report.editorInputClass = await page.evaluate(() => document.activeElement.className)
  await page.keyboard.type('UI_LINE_CHECK ')
  await page.keyboard.press('Meta+s')
  for (let i = 0; i < 50 && !readFileSync(join(first, 'alpha.ts'), 'utf8').includes('UI_LINE_CHECK'); i++) await delay(100)
  assert.equal(readFileSync(join(first, 'alpha.ts'), 'utf8').split('\n')[2], 'UI_LINE_CHECK const needle = "searchfixture"')
  report.openedAndEditedRequestedLine = true
  rmSync(join(first, 'alpha.ts'))
  await results.getByRole('button', { name: /alpha.ts:3/ }).click()
  await page.locator('.project-search-error').waitFor()
  report.missingSourceVisible = true
  await page.getByTitle(second, { exact: true }).and(page.getByRole('button')).click()
  await results.getByRole('button', { name: /beta.ts:1/ }).waitFor()
  assert.equal(await query.inputValue(), 'searchfixture')
  await app.evaluate(({ BrowserWindow }, event) => BrowserWindow.getAllWindows()[0].webContents.send('project-search:hit', event), oldEvent)
  await delay(200)
  assert.equal(await results.getByRole('button', { name: /alpha.ts/ }).count(), 0)
  report.previousProjectEventSuppressed = true
  await query.fill('cancel-before-debounce')
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await delay(400)
  assert.match(await page.locator('.project-search > .project-search-status').innerText(), /Stopped/)
  report.stoppedBeforeLaunch = true
  await query.fill('searchfixture')
  await results.getByRole('button', { name: /beta.ts:1/ }).waitFor()
  await page.screenshot({ path: join(evidence, 'search-sidebar.png') })
  await page.getByRole('button', { name: 'Move panel into workspace', exact: true }).click()
  await page.locator('[data-pane-kind="search"]').waitFor()
  assert.equal(await page.getByRole('searchbox', { name: 'Search text', exact: true }).inputValue(), 'searchfixture')
  await page.getByRole('list', { name: 'Content matches' }).getByRole('button', { name: /beta.ts:1/ }).waitFor()
  if (values['code-graph-binary']) {
    const moved = page.locator('[data-pane-kind="search"]')
    await moved.locator('.project-graph-disclosure > summary').click()
    await moved.getByText('Graph service: stopped', { exact: true }).waitFor()
    assert.equal(await moved.getByLabel('Function name', { exact: true }).inputValue(), 'graphTarget')
    await moved.locator('.project-graph-disclosure > summary').click()
    report.graphQuerySurvivesMove = true
  }
  report.searchSurvivesMove = true
  report.movableSearchPanel = true
  await page.getByTitle(first, { exact: true }).and(page.getByRole('button')).click()
  await page.getByRole('button', { name: 'Content search', exact: true }).click()
  await page.evaluate(() => { window.searchEvents = [] })
  await page.getByRole('searchbox', { name: 'Search text', exact: true }).fill('search')
  await delay(500)
  assert.equal(await page.evaluate(path => window.searchEvents.filter(event => event.workspacePath === path).length, second), 0)
  report.hiddenProjectSearchPaused = true
  report.ignoredOptIn = true
} catch (error) {
  report.error = String(error); process.exitCode = 1
  await page?.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {})
} finally {
  if (app) {
    try {
      for (const session of (await invoke('terminal.list')).sessions) await invoke('terminal.close', { sessionId: session.id })
    } catch (error) { report.terminalCleanupError = String(error); process.exitCode = 1 }
  }
  await app?.close().catch(() => {})
  report.idleDaemonStopped = await cleanupOwnedSmokeDaemon(profile)
  if (!report.idleDaemonStopped) process.exitCode = 1
  report.elapsedMs = performance.now() - start
  writeFileSync(join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify(report))
}
