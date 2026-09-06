import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
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
  const codeCalls = [
    ['code_search', { query: 'searchfixture' }],
    ['code_graph_status', {}],
    ['code_graph_index', {}],
    ['code_graph_callers', { function_name: 'graphTarget' }],
    ['code_search', { query: 'searchfixture', workspacePath: second }],
    ['code_graph_callers', { function_name: 'graphTarget', project: 'other' }],
    ['memory_search', {}]
  ]
  const packets = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'code-acceptance', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ...codeCalls.map(([name, args], index) => ({ jsonrpc: '2.0', id: index + 3, method: 'tools/call', params: { name, arguments: args } }))
  ]
  const mcpOutput = await new Promise((resolve, reject) => {
    const child = execFile(executable, [join(resources, 'cli/donwells.mjs'), 'memory-mcp', '--workspace', first, '--harness', 'custom', '--user-data', profile], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 45000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout))
    child.stdin.end(packets.map(packet => JSON.stringify(packet)).join('\n') + '\n')
  })
  const mcpResponses = String(mcpOutput).trim().split('\n').map(line => JSON.parse(line))
  const responseFor = id => { const response = mcpResponses.find(response => response.id === id); assert(response && !response.error, JSON.stringify(response)); return response.result }
  for (const name of ['code_search', 'code_graph_status', 'code_graph_index', 'code_graph_callers', 'memory_search']) assert(responseFor(2).tools.some(tool => tool.name === name))
  const sourceHits = JSON.parse(responseFor(3).content[0].text)
  assert.equal(sourceHits.hits.length, 1)
  assert.equal(sourceHits.hits[0].path, 'alpha.ts')
  assert.equal(sourceHits.hits[0].line, 3)
  assert.equal(JSON.parse(responseFor(4).content[0].text).available, !!values['code-graph-binary'])
  if (values['code-graph-binary']) {
    assert.equal(responseFor(5).structuredContent.freshness.state, 'current')
    assert.equal(responseFor(6).structuredContent.freshness.state, 'current')
    assert.deepEqual(responseFor(6).structuredContent.callers.groups.flatMap(group => group.rows.map(row => row[0])), ['graphCaller'])
  } else {
    assert.equal(responseFor(5).isError, true)
    assert.equal(responseFor(6).isError, true)
  }
  assert.equal(responseFor(7).isError, true)
  assert.equal(responseFor(8).isError, true)
  assert.equal(responseFor(9).isError, false)
  report.codeMcp = { realCliProcess: true, toolsDiscovered: true, sourceLineVerified: true, graphAvailable: !!values['code-graph-binary'], scopeOverridesRejected: true, memoryStillAvailable: true, responses: mcpResponses }
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
  await page.getByRole('button', { name: 'Project search', exact: true }).click()
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
  await page.getByRole('button', { name: 'Project search', exact: true }).click()
  await page.evaluate(() => { window.searchEvents = [] })
  await page.getByRole('searchbox', { name: 'Search text', exact: true }).fill('search')
  await delay(500)
  assert.equal(await page.evaluate(path => window.searchEvents.filter(event => event.workspacePath === path).length, second), 0)
  report.hiddenProjectSearchPaused = true
  report.ignoredOptIn = true
  const panel = page.getByRole('region', { name: 'Project search', exact: true })
  const choose = async name => panel.getByRole('group', { name: 'Search sources' }).getByRole('button', { name, exact: true }).click()
  await page.keyboard.press('Meta+Shift+f')
  await page.waitForFunction(() => document.activeElement?.getAttribute('type') === 'search')
  for (let i = 0; i < 35; i++) writeFileSync(join(first, `paginated-${String(i).padStart(2, '0')}.txt`), 'Small source file\n')
  await choose('Files')
  await query.fill('paginated')
  await panel.getByRole('button', { name: 'Show more · 25 of 35', exact: true }).waitFor()
  assert.equal(await results.getByRole('button').count(), 25)
  await panel.getByRole('button', { name: 'Show more · 25 of 35', exact: true }).click()
  assert.equal(await results.getByRole('button').count(), 35)
  await app.evaluate(({ BrowserWindow }, event) => BrowserWindow.getAllWindows()[0].webContents.send('project-search:hit', event), oldEvent)
  await delay(100)
  assert.equal(await results.getByRole('button').count(), 35)
  report.obsoleteQueryEventSuppressed = true
  await query.focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('End')
  assert.match(await page.evaluate(() => document.activeElement.textContent), /paginated-34/)
  await page.keyboard.press('Home'); await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.activeElement?.closest('.monaco-editor'))
  report.filePaginationAndKeyboardOpen = true
  const receiver = await invoke('agent.start', { workspacePath: first, command: '/bin/cat' })
  await page.getByRole('button', { name: 'Agent sessions', exact: true }).click()
  await page.getByRole('button', { name: 'Open terminal', exact: true }).click()
  await page.keyboard.press('Meta+Shift+f')
  await page.waitForFunction(() => document.activeElement?.getAttribute('type') === 'search')
  await results.getByRole('button').first().waitFor()
  report.keyboardStage = 'open-source'
  report.beforeSourceKey = await page.evaluate(() => ({ tag: document.activeElement?.tagName, type: document.activeElement?.getAttribute('type'), text: document.activeElement?.textContent?.slice(0, 100) }))
  await page.keyboard.press('ArrowDown')
  report.afterSourceArrow = await page.evaluate(() => ({ tag: document.activeElement?.tagName, type: document.activeElement?.getAttribute('type'), text: document.activeElement?.textContent?.slice(0, 100) }))
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.activeElement?.closest('.monaco-editor'), undefined, { timeout: 3000 })
  report.keyboardStage = 'copy-source'
  await page.keyboard.press('Meta+a'); await page.keyboard.press('Meta+c')
  for (let attempt = 0; attempt < 12; attempt++) {
    await page.keyboard.press('Meta+Alt+ArrowRight'); await delay(80)
    if (await page.evaluate(id => document.activeElement?.closest('[data-pane-key]')?.getAttribute('data-pane-key') === `term:${id}`, receiver.run.sessionId)) break
  }
  assert(await page.evaluate(id => document.activeElement?.closest('[data-pane-key]')?.getAttribute('data-pane-key') === `term:${id}`, receiver.run.sessionId))
  await page.keyboard.press('Meta+Alt+ArrowLeft')
  await page.waitForFunction(() => document.activeElement?.closest('.monaco-editor'))
  await page.keyboard.press('Meta+Alt+ArrowRight')
  await page.waitForFunction(id => document.activeElement?.closest('[data-pane-key]')?.getAttribute('data-pane-key') === `term:${id}`, receiver.run.sessionId)
  report.previousAndNextPaneFocus = true
  report.keyboardStage = 'paste-to-receiver'
  await page.keyboard.press('Meta+v')
  await page.waitForFunction(async id => (await window.donwells.attachTerminal(id)).scrollback.includes('Small source file'), receiver.run.sessionId)
  report.keyboardSourceToTerminal = { sessionId: receiver.run.sessionId, explicitSingleFileCopy: true, fixture: 'cat receiver; native model continuation separately qualified in Task 10' }
  await invoke('agent.stop', { sessionId: receiver.run.sessionId })
  await page.keyboard.press('Meta+Shift+f')

  const savedMemory = await page.evaluate(path => window.donwells.projectMemoryCreate({ workspacePath: path, kind: 'decision', title: 'Shared search decision', content: 'searchmemorycanary', attribution: { harness: 'fixture' } }), first)
  await choose('Memory'); await query.fill('searchmemorycanary')
  await results.getByRole('button', { name: /Shared search decision/ }).waitFor()
  const updatedMemory = await page.evaluate(({ path, entry }) => window.donwells.projectMemoryUpdate({ workspacePath: path, id: entry.id, expectedRevision: entry.revision, kind: entry.kind, title: entry.title, content: 'searchmemorycanary current revision', attribution: { harness: 'fixture' } }), { path: first, entry: savedMemory })
  await query.focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter')
  await page.getByRole('dialog').waitFor()
  assert.equal(await page.getByRole('dialog').count(), 1)
  assert.equal(await page.getByRole('dialog').locator('textarea').inputValue(), 'searchmemorycanary current revision')
  await page.getByRole('dialog').getByText('Revision 2', { exact: true }).waitFor()
  await page.keyboard.press('Escape')
  report.memoryOpenedCurrentRevision = updatedMemory.revision
  await choose('Sessions')
  await panel.getByText(/Session history unavailable: configure/).waitFor()
  assert.equal(await panel.getByRole('button', { name: 'Index sessions', exact: true }).count(), 0)
  await panel.getByRole('button', { name: 'Configure session history', exact: true }).focus()
  await page.keyboard.press('Enter')
  await page.getByRole('region', { name: 'Project tools', exact: true }).waitFor()
  await page.keyboard.press('Escape')
  report.sessionsUnavailableVisible = true
  report.sessionSetupReachableByKeyboard = true
  await choose('Documents'); await query.fill('Small source')
  if (env.DONWELLS_DOCUMENT_QMD_PACKAGE && env.DONWELLS_DOCUMENT_LANCE_PACKAGE) {
    await panel.getByRole('button', { name: 'Index documents', exact: true }).click()
    await results.getByRole('button').first().waitFor({ timeout: 30000 })
    await results.getByRole('button').first().click()
    const sourceDialog = page.getByRole('dialog')
    await sourceDialog.getByText('Small source file', { exact: true }).waitFor()
    await page.keyboard.press('Escape')
    report.documentIndexedAndOpened = true
  } else {
    await panel.getByText('Documents unavailable · configure the document engine', { exact: true }).waitFor()
    report.documentsUnavailableVisible = true
  }
  await page.screenshot({ path: join(evidence, 'unified-search.png') })

} catch (error) {
  report.error = error.stack || String(error); process.exitCode = 1
  report.failureFocus = await page?.evaluate(() => ({ active: document.activeElement?.outerHTML.slice(0, 300), panes: [...document.querySelectorAll('[data-pane-key]')].map(pane => ({ key: pane.getAttribute('data-pane-key'), width: pane.getBoundingClientRect().width, height: pane.getBoundingClientRect().height, body: pane.firstElementChild?.className })), tabs: [...document.querySelectorAll('.flexlayout__tab_button--selected')].map(tab => tab.textContent) })).catch(() => null)
  await page?.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {})
} finally {
  if (app) {
    try {
      for (const agent of (await invoke('agent.list')).agents) {
        if (agent.liveness !== 'exited') await invoke('agent.stop', { sessionId: agent.sessionId })
        for (let i = 0; i < 50 && (await invoke('agent.list')).agents.find(item => item.sessionId === agent.sessionId)?.liveness !== 'exited'; i++) await delay(100)
        await invoke('agent.dismiss', { sessionId: agent.sessionId })
      }
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
