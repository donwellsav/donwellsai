#!/usr/bin/env node
// Preliminary renderer/layout fixture gate; never reports native PTY/agent qualification.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
const { values } = parseArgs({ options: { playwright: { type: 'string' }, evidence: { type: 'string' } } })
assert(values.playwright && values.evidence, 'Supply --playwright /absolute/path/index.mjs and --evidence /new/directory')
const { chromium } = await import(pathToFileURL(resolve(values.playwright)).href)
const evidence = resolve(values.evidence)
mkdirSync(evidence, { mode: 0o700 })
const browser = await chromium.launch({ headless: true })
const results = []
try {
  for (const renderer of ['xterm', 'ghostty']) for (const layout of ['flexlayout', 'dockview']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
    const result = { renderer, layout, fixtureOnly: true, errors: [] }
    results.push(result)
    page.on('pageerror', error => result.errors.push(error.message))
    try {
      await page.goto(`http://127.0.0.1:8766/?renderer=${renderer}&layout=${layout}`)
      await page.waitForFunction(() => Object.keys(window.trialReport?.mounts ?? {}).length === 2)
      await page.waitForFunction(() => window.trialProbe().terminals.every(terminal => terminal.markerPresent))
      const before = await page.evaluate(() => window.trialProbe())
      const samples = []
      for (let i = 0; i < 100; i++) {
        const start = performance.now()
        await page.getByRole('button', { name: 'Move terminal to other group' }).click()
        samples.push(performance.now() - start)
      }
      const after = await page.evaluate(() => window.trialProbe())
      assert.deepEqual(after.report.terminalIds, before.report.terminalIds)
      assert.deepEqual(after.report.mounts, before.report.mounts)
      assert.equal(after.scratch, before.scratch)
      assert(after.terminals.every(terminal => terminal.connected && terminal.markerPresent))
      result.moves = 100; result.retainedTerminalObjects = true; result.retainedScratch = true
      result.search = await page.evaluate(() => window.trialSearch())
      result.searchCompatible = ['terminal-a:find', 'terminal-b:find'].every(key => result.search.checks[key] === true)
      result.candidateStatus = result.searchCompatible ? 'preliminary fixture gates passed; native qualification pending' : 'blocked: required search compatibility failed'
      assert.deepEqual(result.errors, [], 'Unexpected page errors')
      // Wall-clock automation timing includes Playwright waits; it is not input-feedback latency.
      result.automationMoveMs = { median: samples.sort((a,b)=>a-b)[50], p95: samples[94] }
      await page.screenshot({ path: `${evidence}/${renderer}-${layout}.png` })
      await page.setViewportSize({ width: 1280, height: 800 })
      result.horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
    } catch (error) { result.failure = error.message; process.exitCode = 1 }
    finally { await page.close() }
  }
} finally {
  await browser.close()
  writeFileSync(`${evidence}/results.json`, JSON.stringify({ measuredAt: new Date().toISOString(), scope: 'Browser fixture only; native agents, daemon reattachment, keyboard/VoiceOver and installed Electron remain unqualified.', results }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  console.log(JSON.stringify(results, null, 2))
}
