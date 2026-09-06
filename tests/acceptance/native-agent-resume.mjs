#!/usr/bin/env node
import assert from 'node:assert/strict'
import { parseArgs } from 'node:util'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { cleanupOwnedSmokeDaemon, delay } from '../helpers/smoke-processes.mjs'
import { hash, sourceIdentity } from './workspace-baseline.mjs'

const { values } = parseArgs({ options: { receipt: { type: 'string' }, playwright: { type: 'string' }, evidence: { type: 'string' }, agents: { type: 'string' }, 'dsh-sessions': { type: 'string' } } })
const agents = values.agents?.split(',') ?? ['omp', 'hermes', 'kimi', 'deepseek-harness']
assert(agents.length && agents.every(id => ['omp', 'hermes', 'kimi', 'deepseek-harness'].includes(id)))
assert(values.receipt && values.playwright && values.evidence && (!agents.includes('deepseek-harness') || values['dsh-sessions']), 'Supply --receipt from a disposable native query, --playwright, --evidence and --dsh-sessions for DSH')
const prior = JSON.parse(readFileSync(resolve(values.receipt), 'utf8'))
assert(prior.idleDaemonStopped && !prior.cleanupError)
for (const id of agents) assert.equal(prior.agents[id]?.query, 'fixture-word-observed', `${id} has no qualified query to resume`)
const fixture = realpathSync(prior.fixture), profile = realpathSync(prior.profile)
assert(fixture.startsWith(realpathSync(tmpdir()) + '/') && basename(fixture).startsWith('donwells-native-agents-'), 'Only disposable native-matrix projects may be resumed')
assert([tmpdir(), '/tmp'].some(root => profile.startsWith(realpathSync(root) + '/')), 'Only disposable profiles may be resumed')
const evidence = resolve(values.evidence)
mkdirSync(evidence, { mode: 0o700 })
const executable = prior.executable, resources = resolve(dirname(executable), '../Resources')
assert.equal(hash(readFileSync(join(resources, 'app.asar'))), prior.artifact.asarSha256, 'Use the original qualified package')
const readmePath = join(fixture, 'README.md'), original = readFileSync(readmePath, 'utf8')
const word = original.match(/Verification word: (native-[\w-]+)/)?.[1]
assert(word, 'Original fixture word missing')
const { _electron } = await import(pathToFileURL(resolve(values.playwright)).href)
const { callRuntime } = await import(pathToFileURL(join(resources, 'dist-cli/cli/rpc-client.js')).href)
const invoke = async (method, params = {}) => {
  const response = await callRuntime(method, params, profile, 15000)
  assert(response.ok, `${method}: ${response.error}`)
  return response.result
}
const env = { ...process.env, DONWELLS_USER_DATA: profile, KIMI_CODE_NO_AUTO_UPDATE: '1', KIMI_CLI_NO_AUTO_UPDATE: '1' }
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.DONWELLS_SMOKE
const report = { startedAt: new Date().toISOString(), source: sourceIdentity(), artifact: prior.artifact, fixture, profile, priorReceipt: resolve(values.receipt), agents: {} }
let app, page
const until = async (predicate, label, timeout = 15000) => {
  const deadline = Date.now() + timeout
  while (!(await predicate())) { assert(Date.now() < deadline, label); await delay(200) }
}
try {
  // The answer is now available only in the native session history, not the project file.
  writeFileSync(readmePath, '# Resume acceptance\nThe earlier verification word has been removed.\n')
  app = await _electron.launch({ executablePath: executable, env })
  page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  await page.getByRole('navigation', { name: 'Workspace tools' }).waitFor()
  for (const id of agents) {
    const previous = prior.agents[id]
    assert.equal(previous?.query, 'fixture-word-observed', `${id} has no qualified query to resume`)
    const result = report.agents[id] = { resumed: false }
    try {
      let args = ['--continue']
      if (id === 'hermes') args = ['--tui', '--continue']
      if (id === 'deepseek-harness') {
        const root = resolve(values['dsh-sessions'])
        const projects = readdirSync(root).filter(name => name.endsWith(`-${basename(fixture)}--`))
        assert.equal(projects.length, 1)
        const sessions = readdirSync(join(root, projects[0])).filter(name => name.startsWith('session-'))
        assert.equal(sessions.length, 1)
        result.nativeSessionId = sessions[0].slice('session-'.length)
        args = ['--profile', 'tui', '--resume', result.nativeSessionId]
      }
      assert.equal(hash(readFileSync(previous.executable)), previous.executableSha256)
      result.args = args
      const started = await invoke('agent.start', { workspacePath: fixture, launch: { executable: previous.executable, args } })
      result.sessionId = started.run.sessionId
      assert.notEqual(result.sessionId, previous.sessionId, 'Resume must start a new process against native history')
      await page.getByRole('button', { name: 'Add agent', exact: true }).click()
      await page.getByRole('button', { name: /^(Open|Resume) terminal$/ }).click()
      const input = page.locator(`[data-pane-key="term:${result.sessionId}"] .xterm-helper-textarea`)
      await input.waitFor({ state: 'attached' })
      const output = async () => (await page.evaluate(id => window.donwells.attachTerminal(id), result.sessionId)).scrollback
      await until(async () => {
        const text = await output()
        return id === 'deepseek-harness' ? text.includes(result.nativeSessionId) && text.includes('Read README.md') : text.includes(word)
      }, `${id}: native history was not restored`, 45000)
      result.historyRestored = true
      const suffix = `_resumed_${randomUUID()}`
      await input.focus()
      await page.keyboard.type(`From our previous conversation, reply with the exact README verification word immediately followed by ${suffix}, with no space between them. Do not read files or call tools. The README no longer contains the word.`, { delay: id === 'hermes' ? 10 : 0 })
      await delay(500)
      await page.keyboard.press('Enter')
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f')
      const search = page.locator(`[data-pane-key="term:${result.sessionId}"] .terminal-search`)
      await search.getByRole('textbox', { name: 'Find in terminal' }).fill(word + suffix)
      await until(async () => {
        await search.getByTitle('Next result (Enter)', { exact: true }).click()
        return /\d+ of [1-9]\d*/.test(await search.locator('.terminal-search-results').innerText())
      }, `${id}: no fresh answer using resumed context`, 180000)
      result.resumed = true
      result.answerFoundInRenderedTerminal = true
      result.answerSha256 = hash(word + suffix)
      assert.equal(hash(readFileSync(previous.executable)), previous.executableSha256)
      await page.screenshot({ path: join(evidence, `${id}.png`) })
    } catch (error) {
      result.error = error.message
      if (result.sessionId) writeFileSync(join(evidence, `${id}-output.txt`), (await page.evaluate(id => window.donwells.attachTerminal(id), result.sessionId)).scrollback, { mode: 0o600 })
      process.exitCode = 1
    } finally {
      if (result.sessionId) {
        await invoke('agent.stop', { sessionId: result.sessionId })
        await until(async () => (await invoke('agent.list')).agents.find(run => run.sessionId === result.sessionId)?.liveness === 'exited', `${id}: stop timed out`)
        await invoke('agent.dismiss', { sessionId: result.sessionId })
      }
    }
    console.log(JSON.stringify({ agent: id, ...result }))
  }
} catch (error) { report.error = error.message; process.exitCode = 1 }
finally {
  writeFileSync(readmePath, original)
  if (app) {
    for (const session of (await invoke('terminal.list')).sessions) await invoke('terminal.close', { sessionId: session.id })
    let timer
    try { await Promise.race([app.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('App shutdown timed out')), 10000) })]) }
    catch (error) { report.cleanupError = error.message; app.process().kill('SIGKILL'); process.exitCode = 1 }
    finally { clearTimeout(timer) }
  }
  report.idleDaemonStopped = await cleanupOwnedSmokeDaemon(profile)
  if (!report.idleDaemonStopped) process.exitCode = 1
  writeFileSync(join(evidence, 'native-resume.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
}
