import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * The command palette's Run Agent availability in the real app.
 *
 * Availability depends on the catalog's default instance, so the palette must
 * read it from the store rather than a partial CommandContext. Without the
 * catalog in context, Run default agent is disabled with a configuration hint
 * even when a default instance is configured.
 */

const ROOT = join(__dirname, '..')

let app: ElectronApplication
let page: Page
let userData: string
let repository: string

test.beforeAll(async () => {
  userData = realpathSync.native(mkdtempSync(join(tmpdir(), 'donwells-palette-e2e-'), { encoding: 'utf8' }))
  mkdirSync(join(userData, 'terminal-daemon'), { recursive: true, mode: 0o700 })
  repository = join(userData, 'fixture-repository')
  mkdirSync(repository, { recursive: true, mode: 0o700 })
  execFileSync('git', ['init', '--quiet', repository])
  writeFileSync(join(repository, 'marker.txt'), 'fixture\n', { mode: 0o600 })
  execFileSync('git', ['-C', repository, 'add', '.'])
  execFileSync('git', ['-C', repository, '-c', 'user.email=e2e@example.com', '-c', 'user.name=E2E', 'commit', '--quiet', '-m', 'fixture'])
  writeFileSync(join(userData, 'donwells-data.json'), JSON.stringify({
    schemaVersion: 2,
    repos: [{ id: 'e2e-palette-repo', path: repository, addedAt: new Date().toISOString() }],
    settings: {}
  }, null, 2), { mode: 0o600 })

  app = await electron.launch({
    args: [join(ROOT, 'out/main/index.js')],
    env: { ...process.env, DONWELLS_USER_DATA: userData, DONWELLS_E2E: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
  })
  page = await app.firstWindow()
})

test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  rmSync(userData, { recursive: true, force: true })
})
async function openCommandPalette(): Promise<void> {
  await page.bringToFront()
  await expect(page.getByRole('navigation', { name: 'Workspace navigation' })).toBeVisible()
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+KeyP' : 'Control+Shift+KeyP')
    try {
      await expect(page.locator('dialog.palette-dialog')).toBeVisible({ timeout: 2_000 })
      break
    } catch {
      if (attempt === 4) throw new Error('command palette did not open')
    }
  }
  await page.getByRole('combobox', { name: 'Commands', exact: true }).fill('Run default agent')
}

test('run agent reflects the configured default provider instance', async () => {
  // With a project registered the Projects sidebar owns the checkout entry.
  await page.getByRole('button', { name: 'fixture-repository main', exact: true }).click()
  // No default yet: the command is disabled with the configuration hint.
  await openCommandPalette()
  const item = page.locator('dialog.palette-dialog .palette-item', { hasText: 'Run default agent' })
  await expect(item).toBeVisible({ timeout: 20_000 })
  await expect(item).toHaveAttribute('aria-disabled', 'true')

  // Register an instance and select it as the default, exactly as settings does.
  const created = await page.evaluate(async input => await window.donwells.providerCatalogCreate(input), {
    driverId: 'custom-command',
    displayName: 'Palette default instance',
    command: { kind: 'external-shell', program: '/bin/echo palette-default' },
    credentialMode: 'external',
    accountId: null,
    enabled: true
  } as never) as { instances: Array<{ id: string; revision: number }> }
  // The create round trip advances the revision; re-read before the guarded write.
  // The guarded default write checks the catalog's own revision, not the instance's.
  const snapshot = await page.evaluate(() => window.donwells.providerCatalogRead()) as { revision: number; instances: Array<{ id: string }> }
  const instanceId = created.instances[0]!.id
  await page.evaluate(async ({ instanceId, revision }) => {
    await window.donwells.providerCatalogSetDefault(instanceId, revision)
  }, { instanceId, revision: snapshot.revision })

  // Direct IPC bypasses the settings store action; reload to hydrate the saved catalog.
  await page.reload()
  await page.getByRole('navigation', { name: 'Workspace navigation' }).waitFor()
  await openCommandPalette()
  await expect(item).toBeVisible({ timeout: 20_000 })
  await expect(item).not.toHaveAttribute('aria-disabled', 'true')
})

test('named palette entry launches the selected instance rather than the default', async () => {
  const marker = join(userData, 'selected-instance-ran')
  await page.evaluate(async command => {
    await window.donwells.providerCatalogCreate({
      driverId: 'custom-command',
      displayName: 'Palette selected instance',
      command: { kind: 'external-shell', program: command },
      credentialMode: 'external',
      accountId: null,
      enabled: true
    })
  }, `/usr/bin/touch '${marker}'`)
  await page.reload()
  await openCommandPalette()
  await page.getByRole('combobox', { name: 'Commands', exact: true }).fill('Run agent: Palette selected instance')
  const item = page.getByRole('option', { name: /Run agent: Palette selected instance/ })
  await expect(item).toBeVisible()
  await expect(item).not.toHaveAttribute('aria-disabled', 'true')
  await item.click()
  await expect.poll(() => existsSync(marker)).toBe(true)
})
