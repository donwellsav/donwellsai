// Task 16 native-agent entry point: a real `donwells memory-mcp` stdio session drives the
// admitted Cua Driver through the running app daemon against the disposable fixture.
// The root operator supplies image coordinates after inspecting native-target.png; no guessed points.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { cleanupOwnedSmokeDaemon, closeOwnedSmokeApp, cleanSmokeAppShutdown } from '../helpers/smoke-processes.mjs'

const { values } = parseArgs({ options: Object.fromEntries(['evidence', 'fixture', 'driver', 'playwright'].map(name => [name, { type: 'string' }])) })
for (const name of ['evidence', 'fixture', 'driver', 'playwright']) assert(values[name], `--${name} is required`)
const { _electron } = await import(pathToFileURL(resolve(values.playwright)).href)
const evidence = resolve(values.evidence); mkdirSync(evidence, { mode: 0o700 })
const checkpoint = join(evidence, 'checkpoint.json'), coordinates = join(evidence, 'coordinates.json')
const root = resolve(import.meta.dirname, '../..'), profile = realpathSync(mkdtempSync(join(tmpdir(), 'donwells-control-mcp-'))), project = join(profile, 'project'), receipt = join(profile, 'actions.json'); mkdirSync(project)
const fixture = resolve(values.fixture), driver = resolve(values.driver)
assert(existsSync(fixture), 'Existing compiled fixture is missing'); assert(existsSync(driver), 'Admitted driver is missing')

const env = { ...process.env, DONWELLS_USER_DATA: profile, DONWELLS_COMPUTER_TOOL_BINARY: driver }
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL

function mcpSession(label) {
  const child = spawn(process.execPath, [join(root, 'cli/donwells.mjs'), 'memory-mcp', '--workspace', project, '--harness', label, '--user-data', profile], { env, stdio: ['pipe', 'pipe', 'inherit'] })
  let nextId = 1, buffer = ''
  const pending = new Map()
  child.stdout.on('data', chunk => {
    buffer += chunk
    let i
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1)
      if (!line) continue
      let msg; try { msg = JSON.parse(line) } catch { continue }
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
    }
  })
  const call = (method, params) => new Promise((resolvePromise, reject) => {
    const id = nextId++
    pending.set(id, resolvePromise)
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('MCP timeout ' + method)) } }, 60000)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  const tool = async (name, args = {}) => {
    const response = await call('tools/call', { name, arguments: args })
    if (response.error) throw new Error(`${name}: ${response.error.message}`)
    const result = response.result
    if (result?.isError) { const text = result.content?.find(part => part.type === 'text')?.text ?? ''; throw new Error(`${name}: ${text}`) }
    return result
  }
  const notify = method => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n')
  const ready = async () => {
    const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'acceptance', version: '0' } })
    assert.equal(init.result?.serverInfo?.name, 'donwells-project-memory')
    notify('notifications/initialized')
    await new Promise(r => setTimeout(r, 300))
    return init
  }
  return { child, call, tool, ready }
}

let app, page, target, agent, intruder
const report = { profile, project, evidence, fixture, fixtureHash: createHash('sha256').update(readFileSync(fixture)).digest('hex'), checks: [] }
const fixtureExit = async () => { if (target && target.exitCode === null && target.signalCode === null) return new Promise(done => { const timer = setTimeout(() => done('timeout'), 10000); target.once('exit', (code, signal) => { clearTimeout(timer); done({ code, signal }) }); target.kill() }) ; return target ? { code: target.exitCode, signal: target.signalCode } : undefined }

try {
  app = await _electron.launch({ executablePath: createRequire(join(root, 'package.json'))('electron'), args: [root], env })
  page = await app.firstWindow(); page.setDefaultTimeout(12000)
  await page.waitForFunction(() => window.__store?.getState().loading === false)
  await page.evaluate(p => window.__store.getState().addRepo(p), project)
  target = spawn(fixture, [receipt], { stdio: 'ignore' })

  agent = mcpSession('acceptance-agent')
  await agent.ready()
  const tools = (await agent.call('tools/list', {})).result?.tools ?? []
  for (const name of ['computer_attach', 'computer_screenshot', 'computer_pixel_click', 'computer_stop']) assert(tools.some(tool => tool.name === name), `Missing ${name}`)
  report.checks.push('MCP session exposes computer control tools')

  const permissions = (await agent.tool('computer_permissions')).structuredContent
  assert.equal(permissions?.accessibility, true, 'Accessibility must be granted')
  const windows = (await agent.tool('computer_windows')).structuredContent?.windows ?? []
  const window = windows.find(entry => entry.pid === target.pid && String(entry.title).includes('Fixture A'))
  assert(window, 'Fixture A window not listed')
  const attached = (await agent.tool('computer_attach', { pid: target.pid, window: window.window_id, foreground: false })).structuredContent?.attachment
  assert(attached?.generation >= 1 && attached?.revision >= 1, 'Attach must return generation/revision')
  report.attachment = attached

  const shot = await agent.tool('computer_screenshot')
  const image = shot.content?.find(part => part.type === 'image' && part.mimeType === 'image/png')
  assert(image?.data, 'Screenshot must carry a PNG image')
  const png = Buffer.from(image.data, 'base64')
  writeFileSync(join(evidence, 'native-target.png'), png)
  const dimensions = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
  const revision = shot.structuredContent?.attachment?.revision
  assert(Number.isSafeInteger(revision), 'Screenshot must report the consumed observation revision')
  writeFileSync(checkpoint, JSON.stringify({ ...report, stage: 'ready-for-visual-coordinates', dimensions, targetPid: target.pid, instruction: 'Inspect native-target.png, then write coordinates.json with integer x,y for visible Record A button. Native image pixel coordinates only.' }, null, 2) + '\n')
  console.log('READY: visually inspect ' + join(evidence, 'native-target.png') + ' and write ' + coordinates)
  const deadline = Date.now() + 240000
  while (!existsSync(coordinates)) { assert(Date.now() < deadline, 'Timed out waiting for root visual coordinates'); assert(target.exitCode === null && target.signalCode === null, 'Fixture exited while awaiting coordinates'); await new Promise(r => setTimeout(r, 250)) }
  const point = JSON.parse(readFileSync(coordinates, 'utf8'))
  assert(Number.isInteger(point.x) && Number.isInteger(point.y) && point.x >= 0 && point.y >= 0 && point.x < dimensions.width && point.y < dimensions.height, 'Coordinates must lie inside the observed native image')
  report.point = point

  // A second connection holds a different private controller identity; it must not drive the attached target.
  intruder = mcpSession('acceptance-intruder')
  await intruder.ready()
  await assert.rejects(() => intruder.tool('computer_pixel_click', { x: point.x, y: point.y, generation: attached.generation, revision }), /does not own the attached target/)
  report.checks.push('Second MCP connection cannot act on the owned target')

  const clicked = await agent.tool('computer_pixel_click', { x: point.x, y: point.y, generation: attached.generation, revision })
  assert(clicked.structuredContent?.attachment, 'Click must return attachment state')
  const actionDeadline = Date.now() + 30000
  let actions = null
  while (!actions) {
    if (existsSync(receipt)) { const recorded = JSON.parse(readFileSync(receipt, 'utf8')); if (Array.isArray(recorded) && recorded.length) actions = recorded }
    if (!actions) { assert(Date.now() < actionDeadline, 'Timed out waiting for the fixture to record the native point action'); assert(target.exitCode === null && target.signalCode === null, 'Fixture exited without recording the point action'); await new Promise(r => setTimeout(r, 250)) }
  }
  report.actions = actions
  const presses = actions.filter(entry => entry.target === 'A' || entry.target === 'B')
  assert(presses.length > 0 && presses.every(entry => entry.target === 'A'), 'Point action must press only fixture A; sibling window B must stay untouched')
  report.checks.push('MCP screenshot point action reaches selected native fixture A')

  report.fixtureExitBeforeObserve = await fixtureExit()
  await assert.rejects(() => agent.tool('computer_observe'), /closed|changed owner/)
  report.checks.push('Closed target fails later input until a fresh target is selected')
  const stopped = await agent.tool('computer_stop')
  const stoppedText = stopped?.content?.find(part => part.type === 'text')?.text ?? ''
  assert(stopped?.stopped === true || /"stopped":\s*true/.test(stoppedText), 'Stop must report the controller released')
  report.checks.push('Stop releases the controller')
  report.passed = true
} catch (error) { report.error = String(error); process.exitCode = 1 }
finally {
  if (intruder) intruder.child.kill()
  if (agent) agent.child.kill()
  report.fixtureExit = report.fixtureExitBeforeObserve ?? await fixtureExit()
  if (app) {
    await page.evaluate(async p => { await window.donwells.projectToolStop(p, 'computer-control'); for (const t of await window.donwells.terminalSessions()) if (t.worktreePath === p) await window.donwells.closeTerminal(t.id) }, project).catch(error => { report.cleanupError = String(error); process.exitCode = 1 })
    report.appCleanup = await closeOwnedSmokeApp(app)
  }
  report.daemonCleanup = await cleanupOwnedSmokeDaemon(profile)
  try { assert(report.daemonCleanup, 'Owned daemon did not stop'); assert(cleanSmokeAppShutdown(report.appCleanup ?? {}), 'App shutdown was not clean') } catch (error) { report.shutdownError = String(error); process.exitCode = 1 }
  report.verified = report.passed && !report.error && !report.cleanupError && !report.shutdownError && report.fixtureExit !== 'timeout'
  writeFileSync(join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n')
  writeFileSync(checkpoint, JSON.stringify({ ...report, stage: report.verified ? 'completed' : 'failed' }, null, 2) + '\n')
}
console.log(report)
