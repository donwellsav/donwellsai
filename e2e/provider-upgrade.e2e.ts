import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * The production upgrade path: a real app boot against a pre-Stage-3 profile.
 *
 * This is the ordering the unit tests cannot see. `index.ts` constructs the
 * `Store` at :780 and connects the terminal bus at :901, so the store loads and
 * may rewrite the envelope BEFORE the daemon reads the legacy command. A store
 * that owned that key would delete the migration's own source, and every real
 * upgrade would migrate nothing while silently dropping the user's agent
 * configuration.
 *
 * Verified in both directions against the real artifacts: with the buggy store
 * code this test fails because no instance is migrated, and with the fix it
 * passes. A daemon-only boot proof could not catch the bug, because no Store
 * runs in it.
 */

let app: ElectronApplication
let page: Page
let userData: string

test.beforeAll(async () => {
  userData = realpathSync.native(mkdtempSync(join(tmpdir(), 'donwells-upgrade-e2e-'), { encoding: 'utf8' }))
  mkdirSync(join(userData, 'terminal-daemon'), { recursive: true, mode: 0o700 })
  // A profile exactly as a pre-Stage-3 user would have it.
  writeFileSync(join(userData, 'donwells-data.json'), JSON.stringify({
    schemaVersion: 2,
    repos: [],
    settings: { agentCommand: 'claude --print', theme: 'dark', uiScale: 1 }
  }, null, 2), { mode: 0o600 })

  const packagedExecutable = process.env['DONWELLS_ELECTRON_EXECUTABLE']
  app = await electron.launch({
    ...(packagedExecutable === undefined ? { args: [join(__dirname, '../out/main/index.js')] } : { executablePath: packagedExecutable }),
    env: { ...process.env, DONWELLS_USER_DATA: userData }
  })
  page = await app.firstWindow()
})

test.afterAll(async () => {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
})

test('a real upgrade migrates the legacy command into a provider instance', async () => {
  // The daemon migration runs at startup; the catalog is the observation point.
  await expect.poll(async () => page.evaluate(async () => {
    const snapshot = await window.donwells.providerCatalogRead()
    return snapshot.instances.length
  }), { timeout: 30_000 }).toBeGreaterThan(0)

  const snapshot = await page.evaluate(() => window.donwells.providerCatalogRead())
  const instance = snapshot.instances[0]
  // The exact legacy string becomes the program, and the instance is external.
  expect(instance?.command).toEqual({ kind: 'external-shell', program: 'claude --print' })
  expect(instance?.credentialMode).toBe('external')
  // The migration selects the default, which is what the run-agent command reads.
  expect(snapshot.defaultInstanceId).toBe(instance?.id)

  // The daemon removes the legacy setting once the Catalog is authoritative.
  await expect.poll(async () => {
    const document = JSON.parse(readFileSync(join(userData, 'donwells-data.json'), 'utf8')) as { settings: Record<string, unknown> }
    return Object.hasOwn(document.settings, 'agentCommand')
  }, { timeout: 30_000 }).toBe(false)

  // Nothing else in the envelope moved.
  const document = JSON.parse(readFileSync(join(userData, 'donwells-data.json'), 'utf8')) as { settings: Record<string, unknown>; schemaVersion: number }
  expect(document.settings['theme']).toBe('dark')
  expect(document.settings['uiScale']).toBe(1)
  expect(document.schemaVersion).toBe(2)
})
