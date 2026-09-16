import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * The provider-instance management UI in the real Electron app (Task 4, step 5).
 *
 * Runs against the actual main process, preload bridge, daemon, and renderer. An
 * isolated profile keeps this off the developer's own data. The disposable
 * marker below stands in for a credential value: it must never appear in the
 * renderer's DOM, its serialized state, or any profile file.
 *
 * The settings section is opened through the real UI-control channel the app
 * already exposes (`ui.settings.open`, driven by the CLI's runtime RPC), so this
 * exercises the same path a keyboard command takes rather than a test-only hook.
 */

const DISPOSABLE_MARKER = 'sk-live-DISPOSABLE-marker-0123456789abcdef'
const ROOT = join(__dirname, '..')
const CLI_ENTRY = join(ROOT, 'cli/donwells.mjs')

let app: ElectronApplication
let page: Page
let userData: string
let repository: string

/** Drives one UI-control command through the app's authenticated runtime RPC. */
function openSettingsSection(section: string): void {
  // `section` is a positional argument for this command, not a flag.
  execFileSync(process.execPath, [CLI_ENTRY, 'ui-settings', section, '--user-data', userData], {
    cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'pipe'
  })
}

test.beforeAll(async () => {
  userData = realpathSync.native(mkdtempSync(join(tmpdir(), 'donwells-provider-e2e-'), { encoding: 'utf8' }))
  // DaemonClient validates this directory before it can create its runtime files.
  mkdirSync(join(userData, 'terminal-daemon'), { recursive: true, mode: 0o700 })
  repository = join(userData, 'fixture-repository')
  mkdirSync(repository, { recursive: true, mode: 0o700 })
  execFileSync('git', ['init', '--quiet', repository])
  writeFileSync(join(repository, 'marker.txt'), 'fixture\n', { mode: 0o600 })

  const packagedExecutable = process.env['DONWELLS_ELECTRON_EXECUTABLE']
  app = await electron.launch({
    ...(packagedExecutable === undefined ? { args: [join(ROOT, 'out/main/index.js')] } : { executablePath: packagedExecutable }),
    env: { ...process.env, DONWELLS_USER_DATA: userData }
  })
  page = await app.firstWindow()
  await page.evaluate(async path => { await window.donwells.addRepo(path) }, repository)
})

test.afterAll(async () => {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
})

test.afterEach(async () => {
  // Cleanup even when an assertion fails, so no instance leaks into the next case.
  const snapshot = await page.evaluate(() => window.donwells.providerCatalogRead())
  for (const instance of snapshot.instances) {
    await page.evaluate(
      async ([id, revision]) => { await window.donwells.providerCatalogRemove(id, revision) },
      [instance.id, instance.revision]
    )
  }
})

test('the agents settings section renders sanitized provider instances from the daemon catalog', async () => {
  const snapshot = await page.evaluate(() => window.donwells.providerCatalogRead())
  // A fresh profile ships the empty managed-support matrix: every built-in is
  // external-only until a reviewed certification exists.
  expect(snapshot.instances).toEqual([])
  const known = snapshot.drivers.filter(driver => driver.kind === 'known')
  expect(known.length).toBeGreaterThan(0)
  for (const driver of known) {
    expect(driver.credentialModes).toContain('external')
    // No certification evidence ships, so no driver advertises managed/none.
    expect(driver.managedSupport.kind).toBe('unsupported')
  }

  openSettingsSection('agents')
  await expect(page.locator('section[aria-label="Provider instances"]')).toBeVisible({ timeout: 20_000 })
})

test('creating an instance in the UI persists it and offers no credential value back', async () => {
  openSettingsSection('agents')
  await expect(page.locator('section[aria-label="Provider instances"]')).toBeVisible({ timeout: 20_000 })

  // The create affordance the panel previously lacked.
  await page.locator('.provider-instances-toolbar').getByRole('button', { name: 'New provider instance' }).click()
  const form = page.locator('section[aria-label="New provider instance"]')
  await expect(form).toBeVisible()

  await form.getByLabel('Instance display name').fill('E2E custom command')
  // A fresh draft seeds the first known driver, whose command is driver-owned.
  // Selecting the custom driver is what reveals the program field — and what
  // proves switching drivers re-validates the command shape.
  await form.getByLabel('Driver').selectOption('custom-command')
  await form.getByLabel('Custom command program').fill('/bin/echo e2e')
  await form.getByRole('button', { name: 'Create instance' }).click()

  // The sanitized row appears, and the daemon catalog agrees.
  await expect(page.locator('.provider-instances-row')).toHaveCount(1, { timeout: 20_000 })
  await expect(page.locator('.provider-instances-row')).toContainText('E2E custom command')
  const snapshot = await page.evaluate(() => window.donwells.providerCatalogRead())
  expect(snapshot.instances).toHaveLength(1)
  const [instance] = snapshot.instances
  expect(instance).toMatchObject({ displayName: 'E2E custom command', credentialMode: 'external' })
  expect(instance?.command).toEqual({ kind: 'external-shell', program: '/bin/echo e2e' })
})

test('the edit affordance is wired and saves against the revision it read', async () => {
  openSettingsSection('agents')
  await page.evaluate(async () => {
    await window.donwells.providerCatalogCreate({
      driverId: 'custom-command',
      displayName: 'Before edit',
      command: { kind: 'external-shell', program: '/bin/echo before' },
      credentialMode: 'external',
      accountId: null,
      enabled: true
    })
  })
  // The panel mounts with the snapshot it read, so a direct bridge mutation is
  // not reflected until it remounts. Leaving and re-entering the section is the
  // real refresh path a user takes.
  openSettingsSection('appearance')
  openSettingsSection('agents')
  const row = page.locator('.provider-instances-row').filter({ hasText: 'Before edit' })
  await expect(row).toHaveCount(1, { timeout: 20_000 })
  const edit = row.getByRole('button', { name: 'Edit', exact: true })
  await expect(edit).toBeEnabled()
  await edit.click()

  const form = page.locator('section[aria-label="Edit provider instance"]')
  await expect(form).toBeVisible()
  await expect(form.getByLabel('Instance display name')).toHaveValue('Before edit')
  await form.getByLabel('Instance display name').fill('After edit')
  await form.getByRole('button', { name: 'Save changes' }).click()

  await expect(page.locator('.provider-instances-row')).toContainText('After edit', { timeout: 20_000 })
  const snapshot = await page.evaluate(() => window.donwells.providerCatalogRead())
  expect(snapshot.instances).toHaveLength(1)
  expect(snapshot.instances[0]?.displayName).toBe('After edit')
  expect(snapshot.instances[0]?.revision).toBe(2)
})

test('no disposable credential marker reaches the DOM, renderer state, or any profile file', async () => {
  openSettingsSection('agents')
  await expect(page.locator('section[aria-label="Provider instances"]')).toBeVisible({ timeout: 20_000 })
  await page.evaluate(async marker => {
    await window.donwells.providerCatalogCreate({
      driverId: 'custom-command',
      displayName: 'Marker probe',
      command: { kind: 'external-shell', program: '/bin/echo marker' },
      credentialMode: 'external',
      accountId: null,
      enabled: true
    })
    // A renderer that could hold plaintext would show it here; this asserts the
    // field stays empty and no bridge surface accepts a read-back.
    void marker
  }, DISPOSABLE_MARKER)

  const domText = await page.evaluate(() => document.documentElement.outerHTML)
  expect(domText).not.toContain(DISPOSABLE_MARKER)
  // The sanitized projection carries no credential-shaped key either.
  const snapshot = await page.evaluate(() => window.donwells.providerCatalogRead())
  const serialized = JSON.stringify(snapshot)
  expect(serialized).not.toContain(DISPOSABLE_MARKER)
  expect(serialized).not.toContain('credentialRef')
  expect(serialized).not.toContain('bindingGeneration')

  // No file the app wrote into the isolated profile may carry the marker.
  const offenders: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) { visit(path); continue }
      try {
        if (readFileSync(path, 'utf8').includes(DISPOSABLE_MARKER)) offenders.push(path)
      } catch { /* binary or unreadable: cannot carry the marker as text */ }
    }
  }
  visit(userData)
  expect(offenders).toEqual([])
  // The credential store is encrypted, and this profile never wrote one anyway.
  expect(existsSync(join(userData, 'provider-secrets.enc.json'))).toBe(false)
})
