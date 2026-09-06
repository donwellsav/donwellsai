#!/usr/bin/env node
// Optional packaged-daemon mode proves live PTY continuity; native-agent and accessibility gates remain separate.
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { connectDaemon, cleanupOwnedSmokeDaemon } from '../helpers/smoke-processes.mjs'
import { sourceIdentity, hash } from './workspace-baseline.mjs'
import { mkdirSync, writeFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
const { values } = parseArgs({ options: { app: { type: 'string' }, playwright: { type: 'string' }, evidence: { type: 'string' } } })
assert(values.playwright && values.evidence, 'Supply --playwright /absolute/path/index.mjs and --evidence /new/directory')
const { chromium, _electron } = await import(pathToFileURL(resolve(values.playwright)).href)
const evidence = resolve(values.evidence)
mkdirSync(evidence, { mode: 0o700 })
const browser = await chromium.launch({ headless: true })
const results = []
const report = { measuredAt: new Date().toISOString(), source: sourceIdentity(), fixtureOnly: !values.app, results, limitations: ['Native IME and VoiceOver qualification remains pending.', 'Browser comparison uses packaged daemon PTYs; final docking integration is separate.'] }
let app, profile, runtime, client, currentPage
const sessions = new Map()
const processes = () => execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,lstart=']).toString().split('\n').filter(line => Number(line.trim().split(/\s+/)[1]) === runtime.pid).map(line => line.trim()).sort()
try {
  if (values.app) {
    const executable = resolve(values.app)
    report.artifact = { executable, executableSha256: hash(readFileSync(executable)), asarSha256: hash(readFileSync(resolve(dirname(executable), '../Resources/app.asar'))) }
    profile = mkdtempSync(join(tmpdir(), 'donwells-layout-profile-'))
    const fixture = mkdtempSync(join(tmpdir(), 'donwells-layout-project-'))
    report.profile = profile; report.fixture = fixture
    execFileSync('git', ['init', '-b', 'main', fixture], { stdio: 'ignore' })
    const { callRuntime } = await import(pathToFileURL(resolve(dirname(executable), '../Resources/dist-cli/cli/rpc-client.js')).href)
    const invoke = async (method, params) => { const response = await callRuntime(method, params, profile, 10000); assert(response.ok, response.error); return response.result }
    const env = { ...process.env, DONWELLS_USER_DATA: profile }
    delete env.ELECTRON_RUN_AS_NODE; delete env.DONWELLS_SMOKE; delete env.ELECTRON_RENDERER_URL
    app = await _electron.launch({ executablePath: executable, env })
    await (await app.firstWindow()).getByRole('navigation', { name: 'Workspace tools' }).waitFor()
    await invoke('repo.add', { dir: fixture })
    for (const id of ['terminal-a', 'terminal-b']) sessions.set(id, (await invoke('terminal.open', { cwd: fixture })).session)
    runtime = JSON.parse(readFileSync(join(profile, 'terminal-daemon/runtime.json')))
    client = await connectDaemon(runtime, frame => {
      if (frame.event !== 'data' || !currentPage) return
      const id = [...sessions].find(([, session]) => session.id === frame.sessionId)?.[0]
      if (id) void currentPage.evaluate(({ id, frame }) => window.trialNativeOutput?.(id, frame), { id, frame }).catch(() => {})
    })
    report.processesBefore = processes()
    assert.equal(report.processesBefore.length, 2, 'Expected two daemon-owned shells')
  }
  // Compare renderers in the same layout first, then the compatible renderer across layouts.
  for (const [renderer, layout] of [['xterm', 'flexlayout'], ['ghostty', 'flexlayout'], ['xterm', 'dockview']]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
    page.setDefaultTimeout(15000)
    currentPage = page
    const result = { renderer, layout, fixtureOnly: !values.app, errors: [] }
    results.push(result)
    page.on('pageerror', error => { result.errors.push(error.message); console.error(layout, error.message) })
    try {
      if (client) {
        // Refresh fixture markers after output-load runs exceed the renderer scrollback limit.
        for (const session of sessions.values()) await client.request('session.write', { sessionId: session.id, data: "printf '\\106\\111\\116\\104_THIS_MARKER\\n日本語 café é → ✓\\n'\r" })
        const owned = id => { const session = sessions.get(id); assert(session, 'Unknown terminal resource'); return session.id }
        await page.exposeFunction('__trialAttach', id => client.request('session.attach', { sessionId: owned(id) }))
        await page.exposeFunction('__trialInput', (id, data) => { assert(typeof data === 'string' && data.length <= 65536); return client.request('session.write', { sessionId: owned(id), data }) })
        await page.exposeFunction('__trialResize', (id, size) => client.request('session.resize', { sessionId: owned(id), ...size }))
      }
      console.log('Starting', renderer, layout)
      await page.goto(`http://127.0.0.1:8766/?renderer=${renderer}&layout=${layout}`)
      await page.waitForFunction(() => Object.keys(window.trialReport?.mounts ?? {}).length === 2)
      await page.waitForFunction(() => window.trialProbe().terminals.every(terminal => terminal.markerPresent))
      await page.evaluate(() => window.trialMoveEditor())
      await page.evaluate(() => window.trialFocusEditor())
      await page.keyboard.press('Meta+A')
      await page.keyboard.insertText('Unsaved Monaco draft — 日本語, preserved across movement.')
      await page.waitForFunction(() => window.trialProbe().scratch.includes('Unsaved Monaco draft'))
      await page.evaluate(() => window.trialMoveEditor())
      const before = await page.evaluate(() => window.trialProbe())
      const samples = []
      for (let i = 0; i < 100; i++) {
        const start = performance.now()
        await page.getByRole('button', { name: 'Move terminal to other group' }).click()
        samples.push(performance.now() - start)
        if (i % 2 === 1) { await page.evaluate(() => window.trialMoveEditor()); await page.evaluate(() => window.trialMoveEditor()) }
      }
      const after = await page.evaluate(() => window.trialProbe())
      assert.deepEqual(after.report.terminalIds, before.report.terminalIds)
      assert.deepEqual(after.report.mounts, before.report.mounts)
      assert.equal(after.scratch, before.scratch)
      assert.equal(after.scratchModelId, before.scratchModelId)
      assert(after.scratch.includes('Unsaved Monaco draft'))
      assert(after.terminals.every(terminal => terminal.markerPresent))
      for (const id of ['terminal-a', 'terminal-b']) {
        await page.evaluate(id => window.trialFocus(id), id)
        assert(await page.evaluate(id => window.trialProbe().terminals.find(item => item.id === id).connected, id))
      }
      result.moves = 100; result.retainedTerminalObjects = true; result.retainedMonacoModelAndDraft = true; result.editorMoves = 102
      result.search = await page.evaluate(() => window.trialSearch())
      result.searchCompatible = ['terminal-a:find', 'terminal-b:find'].every(key => result.search.checks[key] === true)
      result.candidateStatus = result.searchCompatible ? values.app ? 'automated native continuity passed; accessibility pending' : 'preliminary fixture gates passed; native qualification pending' : 'blocked: required search compatibility failed'
      if (!result.searchCompatible) {
        result.remainingFidelity = 'Not qualified: required existing search addon failed; candidate rejected.'
        await page.screenshot({ path: `${evidence}/${renderer}-${layout}-rejected.png` })
        continue
      }
      assert(['terminal-a', 'terminal-b'].every(id => result.search.checks[id + ':webLinksAddon'] === 'activated'), 'Existing web links addon failed')
      for (const id of ['terminal-a', 'terminal-b']) assert.equal(await page.evaluate(id => window.trialSelectMarker(id), id), 'FIND_THIS_MARKER')
      result.selection = 'exact marker selected in both terminal buffers'
      result.webLinks = 'Existing addon activated; pointer activation remains separate'
      await page.waitForFunction(() => [...document.querySelectorAll('.xterm-accessibility')].some(node => node.textContent.includes('FIND_THIS_MARKER')))
      const accessibility = await page.locator('body').ariaSnapshot()
      assert(accessibility.includes('FIND_THIS_MARKER'), 'Terminal output absent from accessibility tree')
      result.accessibleOutput = 'screenReaderMode exposes terminal rows; native VoiceOver navigation remains unqualified'
      writeFileSync(`${evidence}/${renderer}-${layout}-accessibility.txt`, accessibility)
      if (client) {
        assert.deepEqual(after.report.nativeSessions, before.report.nativeSessions)
        assert.deepEqual(processes(), report.processesBefore)
        await page.evaluate(() => window.trialFocus('terminal-a'))
        result.focusedElement = await page.evaluate(() => window.trialFocusedElement())
        assert(result.focusedElement?.includes('xterm-helper-textarea'), 'Terminal did not receive keyboard focus')
        const start = performance.now()
        const marker = 'PTY_' + layout.toUpperCase()
        const encoded = [...marker].map(character => '\\' + character.charCodeAt(0).toString(8)).join('')
        await page.keyboard.type("printf '" + encoded + "\\n'")
        await page.keyboard.press('Enter')
        await page.waitForFunction(marker => window.trialText('terminal-a').split('\n').some(line => line.trim() === marker), marker)
        result.inputToObservedOutputMs = performance.now() - start
        result.sameNativeSessionsAndProcesses = true
        result.nativeUnicode = await page.evaluate(() => window.trialText('terminal-a').includes('日本語 café'))
        assert(result.nativeUnicode)
        await page.evaluate(() => window.trialResize('terminal-a', 90, 28))
        await page.keyboard.type("printf '\\123IZE_" + layout + " '; stty size")
        await page.keyboard.press('Enter')
        await page.waitForFunction(marker => window.trialText('terminal-a').split('\n').some(line => line.trim() === marker), 'SIZE_' + layout + ' 28 90')
        result.nativeResize = true
        await page.keyboard.type("printf '\\033[?1049h\\033[2J\\033[HALT_SCREEN_MARKER'")
        await page.keyboard.press('Enter')
        await page.waitForFunction(() => window.trialProbe().terminals.find(item => item.id === 'terminal-a').alternateScreen)
        await page.keyboard.type("printf '\\033[?1049l'")
        await page.keyboard.press('Enter')
        await page.waitForFunction(() => !window.trialProbe().terminals.find(item => item.id === 'terminal-a').alternateScreen)
        result.alternateScreenRoundTrip = true
        const pasteReady = 'PASTE_READY_' + layout, pasteDone = 'PASTE_DONE_' + layout
        await page.keyboard.type("stty -echo; printf '\\120ASTE_READY_" + layout + "\\n'; /bin/cat")
        await page.keyboard.press('Enter')
        await page.waitForFunction(marker => window.trialText('terminal-a').split('\n').some(line => line.trim() === marker), pasteReady)
        const pasteLines = ['PASTE_LINE_A_' + layout, 'PASTE_LINE_B_' + layout]
        await page.evaluate(lines => window.trialPaste('terminal-a', lines.join('\n') + '\n'), pasteLines)
        await page.waitForFunction(markers => markers.every(marker => window.trialText('terminal-a').split('\n').some(line => line.trim() === marker)), pasteLines)
        await page.keyboard.press('Control+c')
        await page.keyboard.type("stty echo; printf '\\120ASTE_DONE_" + layout + "\\n'")
        await page.keyboard.press('Enter')
        await page.waitForFunction(marker => window.trialText('terminal-a').split('\n').some(line => line.trim() === marker), pasteDone)
        result.multilinePaste = 'Terminal paste API delivered both lines through the real PTY cat fixture'
        const mouseProbe = 'import os,sys,termios,tty,select; old=termios.tcgetattr(0); tty.setraw(0); sys.stdout.write("\\x1b[?1000h\\x1b[?1006h\\x4dOUSE_READY\\r\\n"); sys.stdout.flush(); ready=select.select([0],[],[],5)[0]; data=os.read(0,128) if ready else b""; ready=select.select([0],[],[],1)[0]; data+=os.read(0,128) if ready else b""; termios.tcsetattr(0,termios.TCSANOW,old); sys.stdout.write("\\x1b[?1000l\\x1b[?1006l\\r\\n\\x4dOUSE_HEX_"+data.hex()+"\\r\\n"); sys.stdout.flush()'
        const scopedMouseProbe = mouseProbe.replace('OUSE_READY', 'OUSE_READY_' + layout).replace('OUSE_HEX_', 'OUSE_HEX_' + layout + '_')
        await page.keyboard.type("python3 -c '" + scopedMouseProbe + "'")
        await page.keyboard.press('Enter')
        await page.waitForFunction(marker => window.trialText('terminal-a').includes(marker), 'MOUSE_READY_' + layout)
        const screen = await page.locator('.terminal-resource').filter({ has: page.locator('textarea:focus') }).locator('.xterm-screen').boundingBox()
        assert(screen, 'Focused terminal screen missing')
        await page.mouse.click(screen.x + screen.width / 2, screen.y + screen.height / 2)
        await page.waitForFunction(marker => window.trialText('terminal-a').includes(marker), 'MOUSE_HEX_' + layout + '_1b5b3c')
        result.mouseReporting = 'Real pointer click produced SGR mouse bytes in the PTY'
        const link = await page.evaluate(() => window.trialLink('terminal-a'))
        await page.mouse.move(link.x, link.y)
        await page.mouse.click(link.x, link.y)
        await page.waitForFunction(() => window.trialReport.linkActivated === 'https://example.test/terminal')
        result.webLinks = 'Pointer activated the existing addon; fixture callback captured the URL without opening a browser'
        const echo = await page.evaluate(() => window.trialMeasureEcho('terminal-a'))
        const summarize = values => { const sorted = [...values].sort((a, b) => a - b); return { count: sorted.length, medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1] } }
        result.echo = { method: 'Fixture input bridge to matching native PTY output, plus two frames; includes Playwright bridge overhead, excludes physical keyboard/display latency.', samples: echo, conditions: Object.fromEntries(['idle', '4KiB-output'].map(condition => { const samples = echo.filter(sample => sample.condition === condition); return [condition, { output: summarize(samples.map(sample => sample.outputMs)), nextFrame: summarize(samples.map(sample => sample.nextFrameMs)) }] })) }
        const focus = await page.evaluate(async () => {
          const samples = []
          for (let index = 0; index < 200; index++) {
            const start = performance.now()
            await window.trialFocus(index % 2 ? 'terminal-a' : 'terminal-b')
            if (!document.activeElement?.classList.contains('xterm-helper-textarea')) throw new Error('Terminal keyboard focus lost')
            samples.push(performance.now() - start)
          }
          return samples
        })
        result.focus = { method: 'Select terminal tab, two frames, focus input; 200 alternating selections.', samples: focus, ...summarize(focus) }
      }
      assert.deepEqual(result.errors, [], 'Unexpected page errors')
      // Wall-clock automation timing includes Playwright waits; it is not input-feedback latency.
      result.automationMoveMs = { median: samples.sort((a,b)=>a-b)[50], p95: samples[94] }
      await page.screenshot({ path: `${evidence}/${renderer}-${layout}.png` })
      await page.setViewportSize({ width: 1280, height: 800 })
      result.horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
    } catch (error) {
      result.failure = error.message; process.exitCode = 1
      result.diagnostic = await page.evaluate(() => ({ focus: window.trialFocusedElement?.(), text: window.trialText?.('terminal-a'), probe: window.trialProbe?.() })).catch(() => null)
      await page.screenshot({ path: `${evidence}/${renderer}-${layout}-failure.png` }).catch(() => {})
    }
    finally { currentPage = null; await page.close() }
  }
} catch (error) { report.failure = error.message; process.exitCode = 1 }
finally {
  await browser.close()
  if (client) {
    for (const session of sessions.values()) await client.request('session.close', { sessionId: session.id })
    client.socket.destroy()
  }
  if (app) await app.close()
  if (profile) { report.idleDaemonStopped = await cleanupOwnedSmokeDaemon(profile); assert(report.idleDaemonStopped) }
  writeFileSync(`${evidence}/results.json`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  console.log(JSON.stringify(report, null, 2))
}
