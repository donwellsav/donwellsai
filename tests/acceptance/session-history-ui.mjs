import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { hash, sourceIdentity, validateOptions } from './workspace-baseline.mjs'
import { cleanupOwnedSmokeDaemon, delay } from '../helpers/smoke-processes.mjs'

const { values } = parseArgs({ options: { app: { type: 'string' }, profile: { type: 'string' }, evidence: { type: 'string' }, playwright: { type: 'string' }, project: { type: 'string' }, binary: { type: 'string' }, 'omp-root': { type: 'string' } } })
assert(values.playwright && values.project && values.binary && values['omp-root'])
const { app: executable, resources, profile, evidence } = validateOptions(values)
mkdirSync(profile, { mode: 0o700 }); mkdirSync(evidence, { mode: 0o700 })
const project = realpathSync(values.project), foreign = join(profile, 'foreign'); mkdirSync(foreign)
const { _electron } = await import(pathToFileURL(resolve(values.playwright)))
const { callRuntime } = await import(pathToFileURL(join(resources, 'dist-cli/cli/rpc-client.js')))
const invoke = async (method, params = {}) => { const response = await callRuntime(method, params, profile, 150000); assert(response.ok, response.error); return response.result }
const env = { ...process.env, DONWELLS_USER_DATA: profile, DONWELLS_HISTORY_BINARY: resolve(values.binary), DONWELLS_HISTORY_ROOTS: JSON.stringify({ omp: [resolve(values['omp-root'])], 'deepseek-harness': [] }) }
delete env.ELECTRON_RUN_AS_NODE; delete env.DONWELLS_SMOKE; delete env.ELECTRON_RENDERER_URL
const report = { source: sourceIdentity(), artifactSha256: hash(readFileSync(join(resources, 'app.asar'))) }
let app, page
try {
  app = await _electron.launch({ executablePath: executable, env }); page = await app.firstWindow()
  await page.getByRole('navigation', { name: 'Workspace tools' }).waitFor()
  await invoke('settings.set', { theme: 'dark' }); await invoke('repo.add', { dir: project }); await invoke('repo.add', { dir: foreign })
  await page.getByTitle(project, { exact: true }).and(page.getByRole('button')).click()
  await page.keyboard.press('Meta+Shift+f')
  const panel = page.getByRole('region', { name: 'Project search', exact: true })
  await panel.getByRole('group', { name: 'Search sources' }).getByRole('button', { name: 'Sessions', exact: true }).click()
  await panel.getByRole('searchbox').fill('HISTORY_ORNITH_27')
  await panel.getByRole('button', { name: 'Index sessions', exact: true }).click()
  const results = panel.getByRole('list', { name: 'Content matches' })
  await results.getByRole('button').first().waitFor({ timeout: 30000 })
  await panel.getByText('Native history support', { exact: true }).click()
  await panel.getByText(/hermes: Unavailable/).waitFor()
  await panel.getByText('Native history support', { exact: true }).click()
  const search = await invoke('history.search', { workspacePath: project, query: 'HISTORY_ORNITH_27' })
  assert(search.hits.length > 0)
  const denied = await callRuntime('history.get', { workspacePath: foreign, id: search.hits[0].id }, profile, 10000)
  assert(!denied.ok)
  report.crossProjectLookupDenied = true
  await panel.getByRole('searchbox').focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog'); await dialog.waitFor()
  assert.match(await dialog.innerText(), /HISTORY_ORNITH_27/)
  assert.match(await dialog.innerText(), /untrusted/)
  report.nativeExcerptMatches = true
  await page.screenshot({ path: join(evidence, 'native-history-source.png') })
  const source = await invoke('history.get', { workspacePath: project, id: search.hits[0].id })
  const before = readFileSync(source.source, 'utf8')
  await dialog.getByRole('button', { name: 'Open native conversation', exact: true }).click()
  await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'))
  let runs
  for (let n = 0; n < 100; n++) {
    runs = (await invoke('agent.list')).agents
    if (runs?.length) break
    await delay(100)
  }
  assert(runs?.length === 1)
  assert(runs[0].launch.args.includes(source.source))
  await delay(2000)
  await page.keyboard.type('What exact verification token did I ask for earlier? Reply with that token only. Do not use tools.')
  await page.keyboard.press('Enter')
  for (let n = 0; n < 600; n++) {
    const added = readFileSync(source.source, 'utf8').slice(before.length)
    if (added.includes('HISTORY_ORNITH_27') && added.includes('"role":"assistant"')) { report.nativeResumeRecalledToken = true; break }
    await delay(100)
  }
  assert(report.nativeResumeRecalledToken)
  await invoke('agent.stop', { sessionId: runs[0].sessionId })
  const stale = await callRuntime('history.get', { workspacePath: project, id: search.hits[0].id }, profile, 10000)
  assert(!stale.ok); report.changedTranscriptRejected = true
  await invoke('history.index', { workspacePath: project })
  assert((await invoke('history.search', { workspacePath: project, query: 'HISTORY_ORNITH_27' })).hits.length > 0)
  report.refreshedTranscript = true
} catch (error) {
  report.error = error.stack; process.exitCode = 1
  if (page) await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {})
} finally {
  if (app) {
    try {
      const agents = await invoke('agent.list')
      for (const run of agents.agents ?? []) {
        if (run.liveness !== 'exited') await invoke('agent.stop', { sessionId: run.sessionId })
        for (let n = 0; n < 100; n++) {
          const current = (await invoke('agent.list')).agents.find(candidate => candidate.sessionId === run.sessionId)
          if (current?.liveness === 'exited') break
          await delay(50)
        }
        await invoke('agent.dismiss', { sessionId: run.sessionId })
      }
      for (const session of (await invoke('terminal.list')).sessions) await invoke('terminal.close', { sessionId: session.id })
      await app.close()
    } catch (error) { report.cleanupError = String(error); process.exitCode = 1 }
    finally { await app.close().catch(() => {}) }
  }
  report.idleDaemonStopped = await cleanupOwnedSmokeDaemon(profile)
  writeFileSync(join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n')
}
