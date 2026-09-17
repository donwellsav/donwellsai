import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * The Store's WRITE path against a profile that still carries the legacy command.
 *
 * The upgrade test only covers a clean boot, where the store never writes — so it
 * cannot catch a `writeState` that drops the daemon's migration source. This
 * drives an actual settings write from the renderer and asserts the key survives
 * on disk, which is what `agentCommand` being tolerated-but-not-persisted has to
 * guarantee. Falsified by making `writeState` serialize the in-memory state
 * instead of merging the on-disk foreign keys.
 */

let app: ElectronApplication
let page: Page
let userData: string

test.beforeAll(async () => {
  userData = realpathSync.native(mkdtempSync(join(tmpdir(), 'donwells-writepath-e2e-'), { encoding: 'utf8' }))
  mkdirSync(join(userData, 'terminal-daemon'), { recursive: true, mode: 0o700 })
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

test('a settings write does not drop the legacy command the daemon still needs', async () => {
  // The daemon migration runs at startup and removes the key in this profile, so
  // re-seed it to model the window the store must survive: the daemon has not yet
  // read it, and a settings write happens first.
  writeFileSync(join(userData, 'donwells-data.json'), JSON.stringify({
    schemaVersion: 2,
    repos: [],
    settings: { agentCommand: 'claude --print', theme: 'dark', uiScale: 1 }
  }, null, 2), { mode: 0o600 })

  // A real settings write through the app's own bridge, which calls writeState.
  await page.evaluate(async () => {
    await window.donwells.setSettings({ uiScale: 1.25 })
  })

  const document = JSON.parse(readFileSync(join(userData, 'donwells-data.json'), 'utf8')) as { settings: Record<string, unknown> }
  // The write landed...
  expect(document.settings['uiScale']).toBe(1.25)
  // ...and the daemon's migration source is still there for it to read. This is
  // the assertion that fails when writeState serializes the in-memory state.
  expect(document.settings['agentCommand']).toBe('claude --print')
})
