#!/usr/bin/env node
import assert from 'node:assert/strict'
import { parseArgs, stripVTControlCharacters } from 'node:util'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { hash, sourceIdentity, validateOptions } from './workspace-baseline.mjs'
import { cleanupOwnedSmokeDaemon, delay } from '../helpers/smoke-processes.mjs'

const { values } = parseArgs({ options: {
  app: { type: 'string' }, profile: { type: 'string' }, evidence: { type: 'string' },
  playwright: { type: 'string' }, query: { type: 'boolean', default: false }, agents: { type: 'string' }
} })
assert(values.playwright, '--playwright is required')
const agentIds = values.agents?.split(',') ?? ['omp', 'hermes', 'kimi', 'deepseek-harness']
assert(agentIds.length && agentIds.every(id => ['omp', 'hermes', 'kimi', 'deepseek-harness'].includes(id)), 'Unknown agent selection')
const { app: executable, resources, profile, evidence } = validateOptions(values)
mkdirSync(profile, { mode: 0o700 }); mkdirSync(evidence, { mode: 0o700 })
const fixture = mkdtempSync(join(tmpdir(), 'donwells-native-agents-'))
const verificationWord = `native-${randomUUID()}`
writeFileSync(join(fixture, 'README.md'), `# Native agent acceptance\n\nVerification word: ${verificationWord}\n`)
execFileSync('git', ['init', '-b', 'main', fixture], { stdio: 'ignore' })
const { _electron } = await import(pathToFileURL(resolve(values.playwright)).href)
const { callRuntime } = await import(pathToFileURL(join(resources, 'dist-cli/cli/rpc-client.js')).href)
const invoke = async (method, params = {}) => {
  const result = await callRuntime(method, params, profile, 10000)
  assert(result.ok, `${method}: ${result.error}`)
  return result.result
}
const env = { ...process.env, DONWELLS_USER_DATA: profile, KIMI_CODE_NO_AUTO_UPDATE: '1', KIMI_CLI_NO_AUTO_UPDATE: '1' }
delete env.DONWELLS_SMOKE; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
const start = performance.now()
const report = {
  startedAt: new Date().toISOString(), source: sourceIdentity(), executable, profile, fixture,
  artifact: { executableSha256: hash(readFileSync(executable)), asarSha256: hash(readFileSync(join(resources, 'app.asar'))) },
  agents: {}, limitations: ['Startup/output evidence alone does not qualify model authentication. Native resume and shared memory require separate checks.']
}
let app
try {
  app = await _electron.launch({ executablePath: executable, env })
  const page = await app.firstWindow()
  await page.getByRole('navigation', { name: 'Workspace tools' }).waitFor()
  await invoke('settings.set', { theme: 'dark' })
  await invoke('repo.add', { dir: fixture })
  await page.getByRole('button', { name: /Main checkout/ }).click()
  const providers = (await invoke('agent.providers')).providers
  for (const id of agentIds) {
    const provider = providers.find(item => item.id === id)
    if (!provider?.executablePath) { report.agents[id] = { installed: false, startup: 'unavailable' }; continue }
    const result = report.agents[id] = { installed: true, executable: provider.executablePath, query: 'not-run', memory: 'not-run', resume: 'not-run' }
    try {
      result.executableSha256 = hash(readFileSync(provider.executablePath))
      const existing = new Set((await invoke('agent.list')).agents.map(run => run.sessionId))
      await page.getByRole('button', { name: 'Add agent', exact: true }).click()
      await page.getByRole('checkbox', { name: 'Pass arguments separately', exact: true }).check()
      await page.getByLabel('Executable', { exact: true }).fill(provider.executablePath)
      if (id === 'hermes') {
        await page.getByRole('button', { name: 'Add argument', exact: true }).click()
        await page.getByRole('textbox', { name: 'Argument 1', exact: true }).fill('--tui')
      }
      await page.getByRole('button', { name: 'Start agent & open terminal', exact: true }).click()
      const deadline = Date.now() + 10000
      while (!result.sessionId) {
        result.sessionId = (await invoke('agent.list')).agents.find(run => !existing.has(run.sessionId))?.sessionId
        assert(Date.now() < deadline, 'Agent did not start from launcher')
        if (!result.sessionId) await delay(50)
      }
      await page.locator(`[data-pane-key="term:${result.sessionId}"]`).waitFor()
      await delay(4000)
      const snapshot = await page.evaluate(async sessionId => window.donwells.attachTerminal(sessionId), result.sessionId)
      const run = (await invoke('agent.list')).agents.find(item => item.sessionId === result.sessionId)
      result.liveness = run?.liveness
      result.exitCode = run?.exitCode
      result.outputBytes = Buffer.byteLength(snapshot.scrollback)
      result.startup = run?.liveness === 'live' && result.outputBytes > 0 ? 'output-observed' : 'failed'
      if (run?.liveness === 'live' && !run.hook.connected) {
        await page.locator('.flexlayout__tab_button_content:visible').filter({ hasText: /· Running$/ }).first().waitFor()
        result.processOnlyLabel = 'Running'
      }
      const text = stripVTControlCharacters(snapshot.scrollback)
      result.diagnostics = ['login', 'authenticate', 'API key', 'error', 'trust'].filter(word => text.toLowerCase().includes(word.toLowerCase()))
      if (values.query && run?.liveness === 'live') {
        if (id === 'hermes') {
          const deadline = Date.now() + 30000
          while (true) {
            const output = await page.evaluate(async sessionId => (await window.donwells.attachTerminal(sessionId)).scrollback, result.sessionId)
            // session.info supplies the versioned banner and enables input in the native TUI.
            if (/ready\s*[│|]|Hermes Agent v\d+\./.test(stripVTControlCharacters(output))) break
            assert(Date.now() < deadline, 'Hermes input did not become ready')
            await delay(250)
          }
        }
        const input = page.locator(`[data-pane-key="term:${result.sessionId}"] .xterm-helper-textarea`)
        await input.focus()
        if (id === 'kimi' && text.includes('Trust this folder?') && text.includes(fixture.replace(/^\/var\//, '/private/var/'))) {
          await page.keyboard.press('Enter')
          await delay(2000)
          result.disposableProjectTrusted = true
        }
        await page.keyboard.type('Read README.md in the current project and reply with its verification word. Do not edit files or call external tools. Use only a local file read and your configured model.')
        // Native paste-burst protection intentionally turns an immediate Enter into a newline.
        await delay(500)
        await page.keyboard.press('Enter')
        const deadline = Date.now() + 30000
        result.query = 'no-verified-response'
        while (Date.now() < deadline) {
          const output = await page.evaluate(async sessionId => (await window.donwells.attachTerminal(sessionId)).scrollback, result.sessionId)
          if (output.includes(verificationWord)) { result.query = 'fixture-word-observed'; break }
          if ((await invoke('agent.list')).agents.find(item => item.sessionId === result.sessionId)?.liveness === 'exited') break
          await delay(250)
        }
      }
      const window = await app.browserWindow(page)
      writeFileSync(join(evidence, `${id}.png`), Buffer.from(await window.evaluate(async win => (await win.webContents.capturePage()).toPNG().toString('base64')), 'base64'), { mode: 0o600 })
      // Local diagnostic output stays private; receipts contain observations, not conversation transcripts.
      const finalOutput = await page.evaluate(async sessionId => (await window.donwells.attachTerminal(sessionId)).scrollback, result.sessionId)
      writeFileSync(join(evidence, `${id}.txt`), stripVTControlCharacters(finalOutput), { mode: 0o600 })
      result.binaryUnchanged = result.executableSha256 === hash(readFileSync(provider.executablePath))
      assert(result.binaryUnchanged, `${id} executable changed during qualification`)
      console.log(JSON.stringify({ agent: id, startup: result.startup, query: result.query }))
    } catch (error) {
      result.error = error.message
      if (!result.startup) result.startup = 'failed'
      if (result.sessionId) {
        try {
          const output = await page.evaluate(async sessionId => (await window.donwells.attachTerminal(sessionId)).scrollback, result.sessionId)
          writeFileSync(join(evidence, `${id}-error.txt`), stripVTControlCharacters(output), { mode: 0o600 })
        } catch { /* The original error remains authoritative if the session is gone. */ }
      }
    }
  }
} catch (error) { report.error = error.message; process.exitCode = 1 }
finally {
  if (app) {
    try {
      for (const run of (await invoke('agent.list')).agents) {
        if (run.liveness !== 'exited') await invoke('agent.stop', { sessionId: run.sessionId })
        const deadline = Date.now() + 15000
        while ((await invoke('agent.list')).agents.find(item => item.sessionId === run.sessionId)?.liveness !== 'exited') {
          assert(Date.now() < deadline, `Agent stop timed out: ${run.sessionId}`)
          await delay(100)
        }
        await invoke('agent.dismiss', { sessionId: run.sessionId })
      }
      for (const session of (await invoke('terminal.list')).sessions) await invoke('terminal.close', { sessionId: session.id })
    }
    catch (error) { report.cleanupError = error.message; process.exitCode = 1 }
    let timer
    try { await Promise.race([app.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('App shutdown timed out')), 10000) })]) }
    catch (error) { report.cleanupError = error.message; app.process().kill('SIGKILL'); process.exitCode = 1 }
    finally { clearTimeout(timer) }
  }
  report.idleDaemonStopped = await cleanupOwnedSmokeDaemon(profile)
  if (!report.idleDaemonStopped) process.exitCode = 1
  report.durationMs = performance.now() - start
  writeFileSync(join(evidence, 'native-agents.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(report, null, 2))
}
