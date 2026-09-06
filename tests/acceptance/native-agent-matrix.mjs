#!/usr/bin/env node
import assert from 'node:assert/strict'
import { parseArgs, stripVTControlCharacters } from 'node:util'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, realpathSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { hash, sourceIdentity, validateOptions } from './workspace-baseline.mjs'
import { cleanupOwnedSmokeDaemon, delay } from '../helpers/smoke-processes.mjs'

const { values } = parseArgs({ options: {
  app: { type: 'string' }, profile: { type: 'string' }, evidence: { type: 'string' },
  playwright: { type: 'string' }, query: { type: 'boolean', default: false }, agents: { type: 'string' }, memory: { type: 'boolean', default: false }, resources: { type: 'boolean', default: false },
  'hermes-cli': { type: 'boolean', default: false },
  'omp-model': { type: 'string' },
  handoff: { type: 'boolean', default: false },
  'dsh-completed-answer': { type: 'boolean', default: false }, 'dsh-sessions': { type: 'string' }, zstd: { type: 'string' }, 'native-write': { type: 'boolean', default: false }, 'hermes-home': { type: 'string' }, 'hermes-python': { type: 'string' }, managed: { type: 'boolean', default: false }, sqlite: { type: 'boolean', default: false }, 'dsh-profile': { type: 'string' }, 'response-timeout-ms': { type: 'string', default: '60000' }
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
assert(!values['dsh-completed-answer'] || (values.memory && agentIds.includes('deepseek-harness') && values['dsh-sessions'] && values.zstd), '--dsh-completed-answer requires memory, DSH, --dsh-sessions and --zstd')
assert(!values.handoff || (values.managed && values.memory && agentIds.length === 2 && !values['native-write']), '--handoff requires exactly two managed memory agents')
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
function completedDshAnswer() {
  const root = resolve(values['dsh-sessions'])
  const projects = readdirSync(root).filter(name => name.endsWith(`-${basename(fixture)}--`))
  if (!projects.length) return null
  assert.equal(projects.length, 1, 'Ambiguous native DSH project logs')
  const directory = join(root, projects[0])
  const sessions = readdirSync(directory).filter(name => name.startsWith('session-'))
  assert.equal(sessions.length, 1, 'Ambiguous native DSH session logs')
  const path = join(directory, sessions[0], 'session.jsonl.zstd')
  let events
  try {
    events = execFileSync(values.zstd, ['-dc', path], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n').map(JSON.parse)
  } catch { return null } // A concurrent append may expose an incomplete compressed frame; retry the same log.
  assert.equal(events[0].cwd, realpathSync(fixture))
  const end = events.findLast(event => event.type === 'turn/end')
  if (!end) return null
  assert.equal(end.data.reason?.kind, 'completed', 'Native DSH turn did not complete normally')
  const messages = events.filter(event => event.type === 'assistant/message' && event.data.turn === end.data.turn)
  const content = messages.at(-1)?.data.message.content ?? []
  assert(!content.some(part => part.type === 'tool-call'), 'Last assistant message still requests a tool')
  const answer = content.filter(part => part.type === 'text').map(part => part.text).join('')
  assert(answer.includes(memoryWord), 'Completed DSH answer did not contain the saved decision')
  const errors = events.filter(event => event.type === 'tool/result' && event.data.turn === end.data.turn).flatMap(event => event.data.message.content).filter(part => part.type === 'tool-result' && part.isError)
  assert.equal(errors.length, 0, 'Native DSH recall included a failed tool call')
  return { nativeSessionId: events[0].id, turnReason: end.data.reason, answerSha256: hash(answer), failedToolCalls: errors.length, transcript: path }
}
const start = performance.now()
const report = {
  startedAt: new Date().toISOString(), source: sourceIdentity(), executable, profile, fixture,
  artifact: { executableSha256: hash(readFileSync(executable)), asarSha256: hash(readFileSync(join(resources, 'app.asar'))), memoryMcpSha256: hash(readFileSync(join(resources, 'dist-cli/cli/project-memory-mcp.js'))) },
  agents: {}, limitations: [values.handoff ? 'Bounded two-agent file continuation; broader app-building, native resume and linked-worktree handoff remain separate gates.' : values['native-write'] ? 'Native create and cross-agent recall only; revision replacement, resumption, linked-worktree recall and explicit handoff require separate checks.' : values.memory ? 'Recall only; native writes, resumption, linked-worktree recall and handoff require separate checks.' : 'Startup/output evidence alone does not qualify model authentication. Native resume and shared memory require separate checks.']
}
let app
let ownsHermesProfile = false
try {
  app = await _electron.launch({ executablePath: executable, env })
  let page = await app.firstWindow()
  await app.evaluate(({ app, BrowserWindow }, path) => {
    const { appendFileSync } = process.getBuiltinModule('node:fs')
    const log = (event, detail = '') => appendFileSync(path, JSON.stringify({ event, detail, at: Date.now(), stack: new Error().stack }) + '\n', { mode: 0o600 })
    for (const event of ['before-quit', 'will-quit', 'window-all-closed']) app.on(event, () => log(event))
    for (const window of BrowserWindow.getAllWindows()) {
      window.on('close', () => log('window-close'))
      window.webContents.on('render-process-gone', (_event, detail) => log('renderer-gone', detail.reason))
      window.webContents.on('before-input-event', (_event, input) => { if (input.meta && ['w', 'q'].includes(input.key.toLowerCase())) log('window-shortcut', input.key) })
    }
  }, join(evidence, 'window-lifecycle.jsonl'))

  report.windowEvents = []
  page.on('close', () => report.windowEvents.push({ event: 'closed', atMs: performance.now() - start }))
  page.on('crash', () => report.windowEvents.push({ event: 'crashed', atMs: performance.now() - start }))
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
    const handoffSource = values.handoff && id === agentIds[0]
    let handoff
    const nativeWriter = values['native-write'] && id === agentIds[0]
    if (values['native-write'] && !nativeWriter) assert(report.nativeWrite, 'Do not test recall before a native write is verified')
    const managedMemory = values.managed
    const provider = providers.find(item => item.id === id)
    if (!provider?.executablePath) { report.agents[id] = { installed: false, startup: 'unavailable' }; continue }
    const result = report.agents[id] = { installed: true, executable: provider.executablePath, query: 'not-run', memory: 'not-run', resume: 'not-run' }
    if (id === 'hermes') result.interface = values['hermes-cli'] ? 'cli' : 'tui'
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
        result.nativeSetupSession = setupSession
        let approvedTools = 0
        while (true) {
          const output = stripVTControlCharacters((await page.evaluate(async id => window.donwells.attachTerminal(id), setupSession)).scrollback)
          writeFileSync(join(evidence, 'hermes-setup.txt'), output, { mode: 0o600 })
          assert(!output.includes('Failed to connect:'), output)
          const offeredTools = Number(output.match(/Enable all (\d+) tools\?/)?.[1])
          if (!approvedTools && offeredTools) {
            assert(offeredTools >= 8, 'Native setup did not discover the required memory/handoff tools')
            await page.locator(`[data-pane-key="term:${setupSession}"] .xterm-helper-textarea`).focus()
            await page.keyboard.press('Enter')
            approvedTools = offeredTools
          }
          if (approvedTools && output.includes(`${approvedTools}/${approvedTools} tools enabled`)) break
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
        assert(config.env.ELECTRON_RUN_AS_NODE === '1', 'Hermes setup lost Node mode')
        for (const name of ['DONWELLS_AGENT_HOOK_RUN_ID', 'DONWELLS_AGENT_HOOK_SESSION_ID', 'DONWELLS_AGENT_HOOK_TOKEN']) assert(config.env[name] === '${' + name + '}', 'Hermes configuration must retain credential references, not values')
        result.managedConfiguration = configPath
        result.nativeSetupSession = setupSession
        result.nativeToolsApproved = approvedTools
        const exitDeadline = Date.now() + 15000
        while ((await invoke('agent.list')).agents.find(run => run.sessionId === setupSession)?.liveness !== 'exited') {
          assert(Date.now() < exitDeadline, 'Hermes setup did not finish its native shutdown')
          await delay(100)
        }
        await page.getByRole('button', { name: 'Add agent', exact: true }).click()
        await page.getByRole('checkbox', { name: 'Pass arguments separately', exact: true }).check()
        await page.getByLabel('Executable', { exact: true }).fill(provider.executablePath)
      }
      const args = id === 'hermes' ? (values['hermes-cli'] ? [] : ['--tui']) : id === 'deepseek-harness' && values['dsh-profile'] ? ['--profile', values['dsh-profile'], ...(values.memory && !managedMemory ? ['--patch', join(profile, 'dsh-memory.patch.yml')] : [])] : []
      if (id === 'omp' && values['omp-model']) args.push('--model', values['omp-model'])
      result.nativeArguments = args
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
      if (id === 'hermes' && values['hermes-python']) {
        result.mcpProcesses = []
        for (let probe = 0; probe < 8; probe++) {
          await delay(400)
          const found = JSON.parse(execFileSync(values['hermes-python'], ['-c', `import json,os,psutil,sys
rows=[]
for p in psutil.process_iter(['pid','ppid','cmdline']):
 try:
  args=p.info['cmdline'] or []
  if 'memory-mcp' not in args or sys.argv[1] not in args: continue
  e=p.environ()
  rows.append({'pid':p.pid,'ppid':p.ppid(),'pgid':os.getpgid(p.pid),'nodeMode':e.get('ELECTRON_RUN_AS_NODE'),'bound':all(bool(e.get(k)) for k in ['DONWELLS_AGENT_HOOK_RUN_ID','DONWELLS_AGENT_HOOK_SESSION_ID','DONWELLS_AGENT_HOOK_TOKEN'])})
 except (psutil.NoSuchProcess,psutil.AccessDenied): pass
print(json.dumps(rows))`, profile], { encoding: 'utf8' }))
          result.mcpProcesses.push(...found)
        }
      } else await delay(4000)
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
        if (id === 'hermes' && !values['hermes-cli']) {
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
        if (values.handoff && !handoffSource) {
          assert(report.handoffSource, 'Source agent must finish its fixture step first')
          handoff = await page.evaluate(async ({ workspacePath, source, recipient, word }) => {
            const saved = await window.donwells.projectHandoffCreate(workspacePath, { taskId: null, fromSessionId: source, toAgent: null, goal: 'Finish the two-agent fixture', summary: 'The source agent wrote handoff-source.txt. Continue its work in this checkout.', openQuestions: [], nextSteps: [`Read handoff-source.txt, then write handoff-result.txt containing exactly ${word} with no newline. Do not edit other files.`], evidenceIds: [] })
            return window.donwells.projectHandoffAccept(workspacePath, saved.id, saved.revision, recipient, crypto.randomUUID())
          }, { workspacePath: fixture, source: report.handoffSource.sessionId, recipient: result.sessionId, word: memoryWord })
          report.handoff = { id: handoff.id, from: report.handoffSource.sessionId, to: result.sessionId }
        }
        await page.keyboard.type(values.handoff
          ? handoffSource
            ? `Write handoff-source.txt in this current checkout containing exactly ${verificationWord} with no newline. Do not edit any other file. This is the first step of a two-agent fixture. Stop after writing it.`
            : `Call the ${id === 'deepseek-harness' ? 'mcp__donwells-project-memory__handoff_receive' : 'donwells-project-memory handoff_receive'} tool with id ${handoff.id} and expectedRevision ${handoff.revision}. Read the returned context and acknowledge it with ${id === 'deepseek-harness' ? 'mcp__donwells-project-memory__handoff_acknowledge' : 'handoff_acknowledge'} using its id and returned revision, then complete its next steps. Do not retry an uncertain receive.`
          : nativeWriter
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
          if (values.handoff) {
            const outputPath = join(fixture, handoffSource ? 'handoff-source.txt' : 'handoff-result.txt')
            if (existsSync(outputPath) && readFileSync(outputPath, 'utf8') === (handoffSource ? verificationWord : memoryWord)) {
              if (handoffSource) {
                report.handoffSource = { sessionId: result.sessionId, contentSha256: hash(readFileSync(outputPath)) }
              } else {
                const status = await page.evaluate(({ workspacePath, id }) => window.donwells.projectHandoffGet(workspacePath, id), { workspacePath: fixture, id: handoff.id })
                assert.equal(status.handoff.delivery, 'confirmed', 'Receiver edited output without acknowledging receipt')
                report.handoff.delivery = status.handoff.delivery
                report.handoff.outputSha256 = hash(readFileSync(outputPath))
              }
              result[outcome] = 'handoff-step-completed'; break
            }
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
          if (!values.handoff && !nativeWriter && output.includes(values.memory ? memoryWord : verificationWord)) {
            if (values.memory && !managedMemory) {
              const calls = readFileSync(join(evidence, `${id}-memory-methods.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line))
              assert(calls.some(call => call.method === 'memory.list' && call.ok), 'Native memory search was not observed')
              result.memoryCalls = calls
            }
            if (managedMemory) assert(output.includes('memory_search'), 'Native memory tool output was not observed')
            if (id === 'deepseek-harness' && values['dsh-completed-answer']) {
              result.completedAnswer = completedDshAnswer()
              if (!result.completedAnswer) { await delay(250); continue }
            }
            result[outcome] = 'fixture-word-observed'; break
          }
          if ((await invoke('agent.list')).agents.find(item => item.sessionId === result.sessionId)?.liveness === 'exited') break
          await delay(250)
        }
      }
      await page.screenshot({ path: join(evidence, `${id}.png`) })
      // Local diagnostic output stays private; receipts contain observations, not conversation transcripts.
      const finalOutput = await page.evaluate(async sessionId => (await window.donwells.attachTerminal(sessionId)).scrollback, result.sessionId)
      writeFileSync(join(evidence, `${id}.txt`), stripVTControlCharacters(finalOutput), { mode: 0o600 })
      result.binaryUnchanged = result.executableSha256 === hash(readFileSync(provider.executablePath))
      assert(result.binaryUnchanged, `${id} executable changed during qualification`)
      console.log(JSON.stringify({ agent: id, startup: result.startup, query: result.query, memory: result.memory }))
    } catch (error) {
      result.error = error.message
      result.errorStack = error.stack
      if (!result.startup) result.startup = 'failed'
      if (result.sessionId) {
        try {
          const output = await page.evaluate(async sessionId => (await window.donwells.attachTerminal(sessionId)).scrollback, result.sessionId)
          writeFileSync(join(evidence, `${id}-error.txt`), stripVTControlCharacters(output), { mode: 0o600 })
        } catch { /* The original error remains authoritative if the session is gone. */ }
      }
    }
  }
  if (values.resources) {
    await app.evaluate(({ app }) => app.getAppMetrics())
    await delay(10000)
    const daemon = JSON.parse(readFileSync(join(profile, 'terminal-daemon/runtime.json'), 'utf8'))
    const roots = new Set([app.process().pid, daemon.pid])
    const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,%cpu=,comm='], { encoding: 'utf8' }).trim().split('\n').map(line => {
      const [pid, ppid, rssKiB, lifetimeCpuPercent, ...command] = line.trim().split(/\s+/)
      return { pid: Number(pid), ppid: Number(ppid), rssKiB: Number(rssKiB), lifetimeCpuPercent: Number(lifetimeCpuPercent), command: command.join(' ') }
    })
    const parents = new Map(rows.map(row => [row.pid, row.ppid]))
    const owned = rows.filter(row => {
      const seen = new Set()
      for (let pid = row.pid; pid && !seen.has(pid); pid = parents.get(pid)) { if (roots.has(pid)) return true; seen.add(pid) }
      return false
    })
    report.resources = { method: 'After ten seconds without submitted queries. Electron CPU is sampled separately; ps CPU is lifetime average. Only fixture app/daemon descendants included; pre-existing model services excluded.', electron: await app.evaluate(({ app }) => app.getAppMetrics()), ownedProcesses: owned, daemonPid: daemon.pid }
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
    const child = app.process()
    let timer
    try { await Promise.race([app.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('App shutdown timed out')), 10000) })]) }
    catch (error) { report.cleanupError = error.message; child.kill('SIGKILL'); process.exitCode = 1 }
    finally { clearTimeout(timer) }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      const deadline = Date.now() + 5000
      while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(50)
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); report.cleanupError = 'App did not exit after termination'; process.exitCode = 1 }
    }
  }
  report.idleDaemonStopped = await cleanupOwnedSmokeDaemon(profile)
  if (!report.idleDaemonStopped) process.exitCode = 1
  if (ownsHermesProfile && report.idleDaemonStopped) {
    const stderrPath = join(hermesProfile, 'logs', 'mcp-stderr.log')
    if (existsSync(stderrPath)) writeFileSync(join(evidence, 'hermes-mcp-stderr.log'), readFileSync(stderrPath), { mode: 0o600 })
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
      && (!(values.query || values.memory) || result[values.memory ? 'memory' : 'query'] === (values.handoff ? 'handoff-step-completed' : values['native-write'] && id === agentIds[0] ? 'native-write-persisted' : 'fixture-word-observed'))
  })
  if (!report.requestedChecksPassed) process.exitCode = 1
  report.durationMs = performance.now() - start
  writeFileSync(join(evidence, 'native-agents.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(report, null, 2))
}
