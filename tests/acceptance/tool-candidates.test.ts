import { expect, it } from 'vitest'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ProjectTools, type ProjectToolDefinition } from '../../src/main/project-tools'

const candidateRoot = process.env.DONWELLS_BROWSER_CANDIDATES
const browser = process.env.DONWELLS_BROWSER_EXECUTABLE
const evidence = process.env.DONWELLS_BROWSER_EVIDENCE

it.skipIf(!candidateRoot || !browser || !evidence)('compares native browser tools on disposable project targets', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'donwells-browser-candidates-')))
  const projects = [join(root, 'a'), join(root, 'b')]
  for (const project of projects) mkdirSync(project)
  const report: Record<string, unknown> = { root, browser, browserSha256: createHash('sha256').update(readFileSync(browser!)).digest('hex'), limitations: ['Local fixture qualification; no existing login/profile or external website used.'] }
  let pendingNavigations = 0
  const heldResponses = new Set<ServerResponse>()
  let releaseSlow = false
  const server = createServer((request, response) => {
    if (request.url === '/slow-a' && !releaseSlow) {
      pendingNavigations++; heldResponses.add(response)
      response.on('close', () => heldResponses.delete(response))
      return
    }
    const target = request.url === '/a' ? 'a' : 'b'
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(`<title>Fixture ${target}</title><label>Task name<input id="name"></label><button id="save">Save task</button><p id="result">Project ${target} ready</p><script>document.querySelector('#save').onclick=()=>document.querySelector('#result').textContent='Saved '+document.querySelector('#name').value+' in project ${target}'</script>`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server unavailable')
  const base = `http://127.0.0.1:${address.port}`
  const cli = join(candidateRoot!, 'node_modules/@playwright/mcp/cli.js')
  const text = (value: unknown): string => { if (typeof value !== 'string' || value.length > 1000) throw new Error('Expected bounded text'); return value }
  const definition: ProjectToolDefinition = {
    id: 'playwright-trial', version: '1.63.0-alpha-2026-08-31', scope: 'checkout',
    launch: () => ({ program: process.execPath, args: [cli, '--headless', '--isolated', '--executable-path', browser!] }),
    operations: {
      navigate: { tool: 'browser_navigate', readOnly: false, parameters: {}, targets: scope => ({ url: base + '/' + (scope.checkoutPath === projects[0] ? 'a' : 'b') }) },
      navigateSlow: { tool: 'browser_navigate', readOnly: false, parameters: {}, targets: () => ({ url: base + '/slow-a' }) },
      snapshot: { tool: 'browser_snapshot', readOnly: true, parameters: {}, targets: () => ({}) },
      type: { tool: 'browser_type', readOnly: false, parameters: { target: text, text }, targets: () => ({ element: 'Task name' }) },
      click: { tool: 'browser_click', readOnly: false, parameters: { target: text }, targets: () => ({ element: 'Save task' }) },
      close: { tool: 'browser_close', readOnly: false, parameters: {}, targets: () => ({}) }
    }
  }
  const tools = new ProjectTools(async path => {
    if (!projects.includes(path)) throw new Error('Unknown fixture project')
    return { path, projectPath: path }
  }, [definition], 30000)
  const results: unknown[] = []
  const nativeResults: unknown[] = []
  const agentBinary = join(candidateRoot!, `node_modules/agent-browser/bin/agent-browser-${process.platform}-${process.arch}`)
  report.agentBinarySha256 = createHash('sha256').update(readFileSync(agentBinary)).digest('hex')
  const config = join(root, 'agent-browser.json')
  writeFileSync(config, '{}\n')
  const namespace = 'donwells-trial-' + Date.now()
  const activeNative = new Set<string>()
  const nativeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'HOME', 'LANG', 'TMPDIR', 'USER'].includes(key)))
  const native = async (session: string, ...args: string[]) => {
    const start = performance.now()
    const { stdout } = await promisify(execFile)(agentBinary, ['--namespace', namespace, '--session', session, '--config', config, '--executable-path', browser!, '--profile', join(root, 'native-' + session), '--idle-timeout', '30s', '--json', ...args], { cwd: root, env: nativeEnv, timeout: args[0] === 'close' ? 5000 : 25000, maxBuffer: 1024 * 1024 }).catch(error => {
      nativeResults.push({ session, args, elapsedMs: performance.now() - start, error: String(error), stdout: error.stdout, stderr: error.stderr, killed: error.killed })
      throw error
    })
    const result = JSON.parse(stdout)
    nativeResults.push({ session, args, elapsedMs: performance.now() - start, result })
    expect(result.success, stdout).toBe(true)
    return result
  }
  const call = async (path: string, operation: string, arguments_: Record<string, unknown> = {}) => {
    const start = performance.now()
    const result = await tools.call(path, definition.id, operation, arguments_) as { isError?: boolean; content?: Array<{ type: string; text?: string }> }
    expect(result.isError, JSON.stringify(result)).not.toBe(true)
    const output = result.content?.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? ''
    const link = output.match(/\[Snapshot\]\(([^)]+)\)/)?.[1]
    let snapshot = '', snapshotSha256: string | undefined
    if (link) {
      const file = realpathSync(join(path, link))
      expect(file.startsWith(path + '/')).toBe(true)
      expect(statSync(file).size).toBeLessThan(1024 * 1024)
      snapshot = readFileSync(file, 'utf8')
      snapshotSha256 = createHash('sha256').update(snapshot).digest('hex')
    }
    results.push({ project: path, operation, elapsedMs: performance.now() - start, output, snapshot, snapshotSha256 })
    return output + '\n' + snapshot
  }
  try {
    expect(JSON.parse(readFileSync(join(candidateRoot!, 'node_modules/@playwright/mcp/package.json'), 'utf8')).version).toBe('0.0.80')
    for (const [index, project] of projects.entries()) {
      const snapshot = await call(project, 'navigate')
      const input = snapshot.match(/textbox "Task name" \[ref=([^\]]+)\]/)?.[1]
      const button = snapshot.match(/button "Save task" \[ref=([^\]]+)\]/)?.[1]
      expect(input).toBeTruthy(); expect(button).toBeTruthy()
      await call(project, 'type', { target: input, text: `task-${index}` })
      const saved = await call(project, 'click', { target: button })
      expect(saved).toContain(`Saved task-${index} in project ${index === 0 ? 'a' : 'b'}`)
    }
    expect(await call(projects[0]!, 'snapshot')).toContain('Saved task-0 in project a')
    await expect(tools.call(projects[0]!, definition.id, 'navigate', { url: base + '/b' })).rejects.toThrow('not permitted')
    const interrupted = tools.call(projects[0]!, definition.id, 'navigateSlow', {}).then(
      value => ({ value, error: null }), error => ({ error: String(error), code: error.code }))
    await expect.poll(() => pendingNavigations).toBe(1)
    await tools.stop(projects[0]!, definition.id)
    const interruption = await interrupted
    expect(interruption).toMatchObject({ code: 'TOOL_OUTCOME_UNCERTAIN' })
    expect(await call(projects[1]!, 'snapshot')).toContain('Saved task-1 in project b')
    expect(await call(projects[0]!, 'navigate')).toContain('Project a ready')
    await call(projects[0]!, 'close')
    await call(projects[1]!, 'close')
    report.playwright = { passed: true, results, interruption, explicitRestart: true, siblingPreserved: true }
    expect(JSON.parse(readFileSync(join(candidateRoot!, 'node_modules/agent-browser/package.json'), 'utf8')).version).toBe('0.36.0')
    for (const session of ['a', 'b']) {
      activeNative.add(session)
      await native(session, 'open', base + '/' + session)
      await native(session, 'fill', '#name', 'native-' + session)
      await native(session, 'click', '#save')
      expect(JSON.stringify(await native(session, 'get', 'text', '#result'))).toContain(`Saved native-${session} in project ${session}`)
    }
    expect(JSON.stringify(await native('a', 'get', 'text', '#result'))).toContain('Saved native-a in project a')
    const nativeInterrupted = native('a', 'open', base + '/slow-a').then(
      value => ({ value, error: null }), error => ({ error: String(error) }))
    await expect.poll(() => pendingNavigations).toBe(2)
    const closeStarted = performance.now()
    const closeResult = await native('a', 'close').then(() => ({ interrupted: true }), error => ({ interrupted: false, error: String(error) }))
    const closeElapsedMs = performance.now() - closeStarted
    releaseSlow = true
    for (const response of heldResponses) response.end('<title>Released fixture</title>Released')
    const nativeInterruption = await nativeInterrupted
    await native('a', 'close'); activeNative.delete('a')
    expect(JSON.stringify(await native('b', 'get', 'text', '#result'))).toContain('Saved native-b in project b')
    activeNative.add('a')
    await native('a', 'open', base + '/a')
    expect(JSON.stringify(await native('a', 'get', 'text', '#result'))).toContain('Project a ready')
    await native('a', 'close'); activeNative.delete('a')
    await native('b', 'close'); activeNative.delete('b')
    report.agentBrowser = { passed: closeResult.interrupted, workflowPassed: true, namespace, results: nativeResults, interruption: { ...closeResult, closeElapsedMs, navigation: nativeInterruption }, explicitRestart: true, siblingPreserved: true }
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error)
    report.playwright ??= { passed: false, results }
    report.agentBrowser ??= { passed: false, namespace, results: nativeResults }
    throw error
  } finally {
    for (const session of activeNative) await native(session, 'close').catch(error => { report.nativeCleanupError = String(error) })
    await tools.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    writeFileSync(evidence!, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  }
}, 120000)
