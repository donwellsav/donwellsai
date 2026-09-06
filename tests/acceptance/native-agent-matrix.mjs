#!/usr/bin/env node
import assert from 'node:assert/strict'
import { parseArgs, stripVTControlCharacters } from 'node:util'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { hash, sourceIdentity, validateOptions } from './workspace-baseline.mjs'
import { cleanupOwnedSmokeDaemon, delay } from '../helpers/smoke-processes.mjs'

const { values } = parseArgs({ options: {
  app: { type: 'string' }, profile: { type: 'string' }, evidence: { type: 'string' },
  playwright: { type: 'string' }, query: { type: 'boolean', default: false }, agents: { type: 'string' }, memory: { type: 'boolean', default: false },
  'native-write': { type: 'boolean', default: false }, 'hermes-home': { type: 'string' }, 'hermes-python': { type: 'string' }, managed: { type: 'boolean', default: false }, sqlite: { type: 'boolean', default: false }, 'dsh-profile': { type: 'string' }, 'response-timeout-ms': { type: 'string', default: '60000' }
} })
assert(values.playwright, '--playwright is required')
const responseTimeout = Number(values['response-timeout-ms'])
assert(Number.isSafeInteger(responseTimeout) && responseTimeout >= 1000 && responseTimeout <= 180000, 'Response timeout must be between 1000 and 180000 ms')
assert(!values.sqlite || values.memory, '--sqlite requires --memory')
const agentIds = values.agents?.split(',') ?? ['omp', 'hermes', 'kimi', 'deepseek-harness']
assert(agentIds.length && agentIds.every(id => ['omp', 'hermes', 'kimi', 'deepseek-harness'].includes(id)), 'Unknown agent selection')
assert(!(values.memory && agentIds.includes('deepseek-harness')) || values['dsh-profile'], 'DSH memory trial requires a configured native --dsh-profile')
assert(!values.managed || (values.memory && agentIds.every(id => ['omp', 'kimi', 'hermes', 'deepseek-harness'].includes(id))), 'Managed setup supports all four providers in disposable profiles')
assert(!values['native-write'] || (values.memory && values.managed && agentIds[0] === 'omp' && agentIds.length > 1), '--native-write requires managed memory with OMP first and at least one reader')
const hermesMemory = values.memory && agentIds.includes('hermes')
assert(!hermesMemory || (values['hermes-home'] && values['hermes-python']), 'Hermes memory trial requires --hermes-home and --hermes-python')
const { app: executable, resources, profile, evidence } = validateOptions(values)
mkdirSync(profile, { mode: 0o700 }); mkdirSync(evidence, { mode: 0o700 })
const fixture = mkdtempSync(join(tmpdir(), 'donwells-native-agents-'))
const verificationWord = `native-${randomUUID()}`
const memoryWord = `memory-${randomUUID()}`
const memoryTitle = values['native-write'] ? 'Native agent saved decision' : 'Native bridge verification'
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
const hermesProfile = hermesMemory
  ? join(resolve(values['hermes-home']), 'profiles', `donwells-acceptance-${randomUUID()}`)
  : join(profile, 'profiles', 'hermes')
if (hermesMemory) env.HERMES_HOME = hermesProfile
delete env.DONWELLS_SMOKE; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
const start = performance.now()
const report = {
  startedAt: new Date().toISOString(), source: sourceIdentity(), executable, profile, fixture,
  artifact: { executableSha256: hash(readFileSync(executable)), asarSha256: hash(readFileSync(join(resources, 'app.asar'))) },
  agents: {}, limitations: [values['native-write'] ? 'Native create and cross-agent recall only; revision replacement, resumption, linked-worktree recall and explicit handoff require separate checks.' : values.memory ? 'Recall only; native writes, resumption, linked-worktree recall and handoff require separate checks.' : 'Startup/output evidence alone does not qualify model authentication. Native resume and shared memory require separate checks.']
}
let app
let ownsHermesProfile = false
try {
  app = await _electron.launch({ executablePath: executable, env })
  let page = await app.firstWindow()
  await page.getByRole('navigation', { name: 'Workspace tools' }).waitFor()
  await invoke('settings.set', { theme: 'dark' })
  await invoke('repo.add', { dir: fixture })
  if (values.memory) {
    const entry = await invoke('memory.create', { workspacePath: fixture, kind: 'decision', title: 'Native bridge verification', content: values.sqlite || values['native-write'] ? 'Before SQLite upgrade' : memoryWord, attribution: { harness: 'cli' } })
    if (values.sqlite) {
      const original = hash(readFileSync(join(profile, 'project-memory.json')))
      await page.getByRole('button', { name: /Main checkout/ }).click()
      await page.getByRole('button', { name: 'Project memory', exact: true }).click()
      await page.locator('.memory-storage > summary').click()
      await page.getByRole('button', { name: 'Upgrade to SQLite', exact: true }).click()
      await page.getByText('Shared memory now uses SQLite.', { exact: true }).waitFor()
      const authority = JSON.parse(readFileSync(join(profile, 'project-memory-active.json'), 'utf8'))
      assert.equal(authority.state, 'sqlite')
      assert.equal(hash(readFileSync(join(profile, authority.directory, 'project-memory.json.backup'))), original)
      const updated = await invoke('memory.update', { workspacePath: fixture, id: entry.id, kind: entry.kind, title: entry.title, expectedRevision: 1, content: values['native-write'] ? 'App-created migration baseline' : memoryWord, attribution: { harness: 'cli' } })
      const previousPid = app.process().pid
      await app.close()
      app = await _electron.launch({ executablePath: executable, env })
      page = await app.firstWindow()
      await page.getByRole('navigation', { name: 'Workspace tools' }).waitFor()
      assert.notEqual(app.process().pid, previousPid)
      assert.deepEqual(await invoke('memory.get', { workspacePath: fixture, id: entry.id }), updated)
      report.migratedMemory = { backend: 'sqlite', entryId: entry.id, revision: updated.revision, originalBackupUnchanged: true, appPids: [previousPid, app.process().pid], postUpgradeWriteRecalledAfterRestart: true }
    }
    for (const id of agentIds) {
      if (values.managed && ['omp', 'kimi', 'deepseek-harness'].includes(id)) continue
      const audit = join(evidence, `${id}-memory-methods.jsonl`)
      const bridge = join(profile, `${id}-memory-bridge.mjs`)
      // Reuse the packaged MCP server; record method names only to prove native calls without retaining payloads.
      writeFileSync(bridge, `import { appendFileSync } from 'node:fs';
import { runProjectMemoryMcp } from ${JSON.stringify(pathToFileURL(join(resources, 'dist-cli/cli/project-memory-mcp.js')).href)};
import { callRuntime } from ${JSON.stringify(pathToFileURL(join(resources, 'dist-cli/cli/rpc-client.js')).href)};
await runProjectMemoryMcp({ workspacePath: ${JSON.stringify(fixture)}, harness: ${JSON.stringify(id)}, invoke: async (method, params) => {
  const response = await callRuntime(method, params, ${JSON.stringify(profile)}, 30000);
  appendFileSync(${JSON.stringify(audit)}, JSON.stringify({ method, ok: response.ok, pid: process.pid }) + '\\n', { mode: 0o600 });
  if (!response.ok) throw new Error(response.error);
  return response.result;
}});
`, { mode: 0o600 })
      const servers = { 'donwells-project-memory': { command: executable, args: [bridge], env: { ELECTRON_RUN_AS_NODE: '1' } } }
      if (id === 'deepseek-harness') {
        writeFileSync(join(profile, 'dsh-memory.patch.yml'), JSON.stringify([{ insert: [{ id: 'donwells-project-memory', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'donwells-project-memory', transport: 'stdio', ...servers['donwells-project-memory'], failOnStartupError: true, reconnect: { enabled: false } } }] }], null, 2) + '\n', { mode: 0o600, flag: 'wx' })
      } else if (id === 'hermes') {
        mkdirSync(join(resolve(values['hermes-home']), 'profiles'), { recursive: true, mode: 0o700 })
        mkdirSync(hermesProfile, { mode: 0o700 })
        ownsHermesProfile = true
        // Use Hermes's installed YAML parser and a private profile; never rewrite the user's source files.
        execFileSync(values['hermes-python'], ['-c', 'import json, pathlib, sys, yaml; source, target, servers = sys.argv[1:]; config = yaml.safe_load(pathlib.Path(source).read_text()); config["mcp_servers"] = json.loads(servers); p = pathlib.Path(target); p.touch(mode=0o600, exist_ok=False); p.write_text(yaml.safe_dump(config, allow_unicode=True)); yaml.load(p.read_text(), Loader=getattr(yaml, "CSafeLoader", yaml.SafeLoader))', join(resolve(values['hermes-home']), 'config.yaml'), join(hermesProfile, 'config.yaml'), JSON.stringify(values.managed ? { 'existing-disabled': { command: 'donwells-disabled-fixture', enabled: false } } : servers)], { stdio: 'pipe' })
        writeFileSync(join(hermesProfile, '.env'), readFileSync(join(resolve(values['hermes-home']), '.env')), { mode: 0o600, flag: 'wx' })
      } else {
        const directory = join(fixture, id === 'omp' ? '.omp' : '.kimi-code')
        mkdirSync(directory)
        writeFileSync(join(directory, 'mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2), { mode: 0o600 })
      }
    }
  }
  await page.getByRole('button', { name: /Main checkout/ }).click()
  const providers = (await invoke('agent.providers')).providers
  for (const id of agentIds) {
    const nativeWriter = values['native-write'] && id === agentIds[0]
    if (values['native-write'] && !nativeWriter) assert(report.nativeWrite, 'Do not test recall before a native write is verified')
    const managedMemory = values.managed
    const provider = providers.find(item => item.id === id)
    if (!provider?.executablePath) { report.agents[id] = { installed: false, startup: 'unavailable' }; continue }
    const result = report.agents[id] = { installed: true, executable: provider.executablePath, query: 'not-run', memory: 'not-run', resume: 'not-run' }
    try {
      result.executableSha256 = hash(readFileSync(provider.executablePath))
      const existing = new Set((await invoke('agent.list')).agents.map(run => run.sessionId))
      await page.getByRole('button', { name: 'Add agent', exact: true }).click()
      await page.getByRole('checkbox', { name: 'Pass arguments separately', exact: true }).check()
      await page.getByLabel('Executable', { exact: true }).fill(provider.executablePath)
      if (managedMemory && id !== 'hermes') {
        await page.getByRole('button', { name: 'Set up shared project memory', exact: true }).click()
        await page.getByText(id === 'deepseek-harness' ? 'Project memory patch ready for this launch. Keep your native profile arguments below.' : 'Project memory setup saved. New agent sessions will load it.', { exact: true }).waitFor()
        const configPath = join(fixture, id === 'omp' ? '.omp/mcp.json' : id === 'kimi' ? '.kimi-code/mcp.json' : '.dsh/donwells-memory.patch.json')
        const config = JSON.parse(readFileSync(configPath, 'utf8'))
        const server = id === 'deepseek-harness' ? config[0].insert[0].config : config.mcpServers['donwells-project-memory']
        assert.equal(server.command, executable)
        assert.deepEqual(server.args, [join(resources, 'cli/donwells.mjs'), 'memory-mcp', '--workspace', fixture.replace(/^\/var\//, '/private/var/'), '--harness', id, '--user-data', profile])
        result.managedConfiguration = configPath
      }
      if (managedMemory && id === 'hermes') {
        const configPath = join(hermesProfile, 'config.yaml')
        const settingsHash = () => execFileSync(values['hermes-python'], ['-c', 'import hashlib,json,sys,yaml; c=yaml.safe_load(open(sys.argv[1])); c.pop("mcp_servers",None); print(hashlib.sha256(json.dumps(c,sort_keys=True).encode()).hexdigest())', configPath], { encoding: 'utf8' }).trim()
        const beforeSettings = settingsHash()
        await page.getByRole('button', { name: 'Set up shared project memory', exact: true }).click()
        const setupDeadline = Date.now() + 45000
        let setupSession
        while (!setupSession) {
          setupSession = (await invoke('agent.list')).agents.find(run => !existing.has(run.sessionId))?.sessionId
          assert(Date.now() < setupDeadline, 'Hermes native setup did not start')
          if (!setupSession) await delay(100)
        }
        existing.add(setupSession)
        let approved = false
        while (true) {
          const output = stripVTControlCharacters((await page.evaluate(async id => window.donwells.attachTerminal(id), setupSession)).scrollback)
          assert(!output.includes('Failed to connect:'), output)
          if (!approved && output.includes('Enable all 6 tools?')) {
            await page.locator(`[data-pane-key="term:${setupSession}"] .xterm-helper-textarea`).focus()
            await page.keyboard.press('Enter')
            approved = true
          }
          if (output.includes('6/6 tools enabled')) break
          assert(Date.now() < setupDeadline, 'Hermes native setup did not save its discovered tools')
          await delay(200)
        }
        assert.equal(settingsHash(), beforeSettings, 'Native setup changed unrelated Hermes settings')
        const servers = JSON.parse(execFileSync(values['hermes-python'], ['-c', 'import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))["mcp_servers"]))', configPath], { encoding: 'utf8' }))
        assert.deepEqual(servers['existing-disabled'], { command: 'donwells-disabled-fixture', enabled: false })
        result.existingHermesSettingsPreserved = true
        const config = servers['donwells-project-memory']
        assert.equal(config.command, executable)
        assert(config.args.includes('${workspaceFolder}'))
        result.managedConfiguration = configPath
        result.nativeSetupSession = setupSession
        result.nativeToolsApproved = 6
        await invoke('agent.stop', { sessionId: setupSession })
        await page.getByRole('button', { name: 'Add agent', exact: true }).click()
        await page.getByRole('checkbox', { name: 'Pass arguments separately', exact: true }).check()
        await page.getByLabel('Executable', { exact: true }).fill(provider.executablePath)
      }
      const args = id === 'hermes' ? ['--tui'] : id === 'deepseek-harness' && values['dsh-profile'] ? ['--profile', values['dsh-profile'], ...(values.memory && !managedMemory ? ['--patch', join(profile, 'dsh-memory.patch.yml')] : [])] : []
      for (const [index, value] of args.entries()) {
        await page.getByRole('button', { name: 'Add argument', exact: true }).click()
        await page.getByRole('textbox', { name: `Argument ${index + 1}`, exact: true }).fill(value)
      }

      await page.getByRole('button', { name: 'Start agent & open terminal', exact: true }).click()
      const deadline = Date.now() + 10000
      while (!result.sessionId) {
        result.sessionId = (await invoke('agent.list')).agents.find(run => !existing.has(run.sessionId))?.sessionId
        assert(Date.now() < deadline, 'Agent did not start from launcher')
        if (!result.sessionId) await delay(50)
      }
      await page.locator(`[data-pane-key="term:${result.sessionId}"]`).waitFor()
      result.terminalBackground = await page.locator(`[data-pane-key="term:${result.sessionId}"] .terminal-host-wrap`).evaluate(element => getComputedStyle(element).backgroundColor)
      assert.equal(result.terminalBackground, 'rgb(22, 22, 29)', 'Fresh terminals must use the Donwells main surface')
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
      if ((values.query || values.memory) && run?.liveness === 'live') {
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
        await page.keyboard.type(nativeWriter
          ? `Call the donwells-project-memory MCP server memory_record tool exactly once with kind decision, title ${JSON.stringify(memoryTitle)}, and content ${JSON.stringify(memoryWord)}. Save that decision to shared project memory. Do not edit files or use another memory server. Do not repeat a write if its outcome is uncertain.`
          : values.memory
          ? `Call the ${['kimi', 'deepseek-harness'].includes(id) ? 'mcp__donwells-project-memory__memory_search' : 'donwells-project-memory MCP server memory_search'} tool to search for "${memoryTitle}" and reply with the decision content. Do not read files, edit anything, or use another memory server.`
          : 'Read README.md in the current project and reply with its verification word. Do not edit files or call external tools. Use only a local file read and your configured model.', { delay: id === 'hermes' ? 10 : 0 })
        // Native paste-burst protection intentionally turns an immediate Enter into a newline.
        await delay(500)
        await page.keyboard.press('Enter')
        const deadline = Date.now() + responseTimeout
        const outcome = values.memory ? 'memory' : 'query'
        result[outcome] = 'no-verified-response'
        while (Date.now() < deadline) {
          const output = await page.evaluate(async sessionId => (await window.donwells.attachTerminal(sessionId)).scrollback, result.sessionId)
          if (values.memory && id === 'kimi' && !result.fixtureMemoryReadApproved && output.includes('Approve mcp__donwells-project-memory__memory_search?') && output.includes(memoryTitle) && output.includes('1. Approve once')) {
            // Approve only this disposable fixture's requested read, never a session-wide permission.
            await input.focus()
            await page.keyboard.press('Enter')
            result.fixtureMemoryReadApproved = true
          }
          if (nativeWriter) {
            const saved = (await invoke('memory.list', { workspacePath: fixture, query: memoryTitle })).entries.filter(entry => entry.title === memoryTitle)
            if (saved.length) {
              assert.equal(saved.length, 1, 'Native writer created duplicate decisions')
              const entry = await invoke('memory.get', { workspacePath: fixture, id: saved[0].id })
              assert.equal(entry.content, memoryWord)
              assert.equal(entry.provenance.harness, id)
              assert.equal(entry.revision, 1)
              report.nativeWrite = { id: entry.id, revision: entry.revision, provenance: entry.provenance, contentSha256: hash(entry.content), writerSession: result.sessionId }
              result[outcome] = 'native-write-persisted'
              break
            }
          }
          if (!nativeWriter && output.includes(values.memory ? memoryWord : verificationWord)) {
            if (values.memory && !managedMemory) {
              const calls = readFileSync(join(evidence, `${id}-memory-methods.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line))
              assert(calls.some(call => call.method === 'memory.list' && call.ok), 'Native memory search was not observed')
              result.memoryCalls = calls
            }
            if (managedMemory) assert(output.includes('memory_search'), 'Native memory tool output was not observed')
            result[outcome] = 'fixture-word-observed'; break
          }
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
      console.log(JSON.stringify({ agent: id, startup: result.startup, query: result.query, memory: result.memory }))
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
  if (values['native-write'] && report.nativeWrite) {
    const previousPid = app.process().pid
    await app.close()
    app = await _electron.launch({ executablePath: executable, env })
    page = await app.firstWindow()
    await page.getByRole('navigation', { name: 'Workspace tools' }).waitFor()
    assert.notEqual(app.process().pid, previousPid)
    const saved = (await invoke('memory.list', { workspacePath: fixture, query: memoryTitle })).entries.filter(entry => entry.title === memoryTitle)
    assert.equal(saved.length, 1, 'Native decision was duplicated or lost')
    assert.equal(saved[0].id, report.nativeWrite.id)
    const entry = await invoke('memory.get', { workspacePath: fixture, id: report.nativeWrite.id })
    assert.equal(hash(entry.content), report.nativeWrite.contentSha256)
    assert.deepEqual(entry.provenance, report.nativeWrite.provenance)
    report.nativeWrite.appPids = [previousPid, app.process().pid]
    report.nativeWrite.recalledAfterRestart = true
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
  if (ownsHermesProfile && report.idleDaemonStopped) {
    rmSync(hermesProfile, { recursive: true, force: true })
    report.temporaryHermesConfigurationRemoved = true
    report.hermesProfile = hermesProfile
    await delay(10000)
    report.hermesProfileRemainedAbsent = !existsSync(hermesProfile)
    if (!report.hermesProfileRemainedAbsent) process.exitCode = 1
  }
  report.requestedChecksPassed = agentIds.every(id => {
    const result = report.agents[id]
    return result && !result.error && result.startup === 'output-observed'
      && (!(values.query || values.memory) || result[values.memory ? 'memory' : 'query'] === (values['native-write'] && id === agentIds[0] ? 'native-write-persisted' : 'fixture-word-observed'))
  })
  if (!report.requestedChecksPassed) process.exitCode = 1
  report.durationMs = performance.now() - start
  writeFileSync(join(evidence, 'native-agents.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(report, null, 2))
}
