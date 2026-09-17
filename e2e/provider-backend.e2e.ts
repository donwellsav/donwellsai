import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * The real protected backend in the packaged app (Task 5, step 4), macOS.
 *
 * SCOPE, stated precisely because the obvious overclaim is easy here. The
 * shipped certification matrix is empty, so no built-in driver accepts
 * `managed` and a packaged app cannot reach a successful managed credential
 * write at all. The encrypt/decrypt round trip is therefore proved where it is
 * reachable — the unit suite (`provider-secret-authority.test.ts`, 31 tests,
 * including "round-trips put -> inspect -> materialize without exposing
 * plaintext" and the ciphertext/disclosure assertions).
 *
 * What this file proves about the REAL app is the part that only the real app
 * can: the platform backend exists and is selected in this process, and the
 * reachable credential path is refused with a typed error that never echoes the
 * submitted value, leaving nothing in the durable store or the sanitized
 * projection. It deliberately does NOT claim Keychain continuity across signed
 * updates (needs two signed builds) or the Linux/Windows backends (need those
 * runners).
 */

const DISPOSABLE_MARKER = 'sk-live-PROTECTED-backend-0123456789abcdef'

let app: ElectronApplication
let page: Page
let userData: string

test.beforeAll(async () => {
  userData = realpathSync.native(mkdtempSync(join(tmpdir(), 'donwells-backend-e2e-'), { encoding: 'utf8' }))
  mkdirSync(join(userData, 'terminal-daemon'), { recursive: true, mode: 0o700 })
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

test('the packaged app has a real encryption backend and refuses an unauthorized credential write without echoing it', async () => {
  // Main-process truth: this is the real platform backend, not a fake. On macOS
  // an available backend means the Keychain-backed safeStorage is usable.
  const backend = await app.evaluate(async ({ safeStorage }) => ({
    available: safeStorage.isEncryptionAvailable(),
    // Reported where the platform exposes it (Linux); null elsewhere.
    selected: safeStorage.getSelectedStorageBackend?.() ?? null
  }))
  expect(backend.available).toBe(true)

  // No built-in driver is certified, so `managed` cannot be authored. This
  // asserts the shipped matrix rather than assuming it.
  const snapshot = await page.evaluate(() => window.donwells.providerCatalogRead())
  for (const driver of snapshot.drivers) {
    if (driver.kind !== 'known') continue
    expect(driver.managedSupport.kind).toBe('unsupported')
  }

  // The reachable credential path is an external instance, which must refuse a
  // managed write with a typed error and never surface the value.
  const refused = await page.evaluate(async marker => {
    const created = await window.donwells.providerCatalogCreate({
      driverId: 'custom-command',
      displayName: 'Backend probe',
      command: { kind: 'external-shell', program: '/bin/echo probe' },
      credentialMode: 'external',
      accountId: null,
      enabled: true
    })
    const instance = created.instances[0]
    if (!instance) return { refused: false, message: 'no instance was created' }
    try {
      await window.donwells.providerCredentialWrite({
        providerInstanceId: instance.id,
        accountId: 'account-probe',
        expectedInstanceRevision: instance.revision,
        expectedAccountRevision: 1,
        secret: marker
      })
      return { refused: false, message: 'the write unexpectedly succeeded' }
    } catch (error) {
      return { refused: true, message: error instanceof Error ? error.message : String(error) }
    }
  }, DISPOSABLE_MARKER)
  expect(refused.refused).toBe(true)
  expect(refused.message).not.toContain(DISPOSABLE_MARKER)

  // Nothing durable was created, and no sanitized projection carries the value.
  const storePath = join(userData, 'provider-secrets.enc.json')
  if (existsSync(storePath)) expect(readFileSync(storePath, 'utf8')).not.toContain(DISPOSABLE_MARKER)
  const after = await page.evaluate(() => window.donwells.providerCatalogRead())
  expect(JSON.stringify(after)).not.toContain(DISPOSABLE_MARKER)
})
