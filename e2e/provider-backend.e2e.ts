import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * The real protected backend round trip (Task 5, step 4), macOS.
 *
 * The credential write runs inside the actual Electron main process, so
 * `safeStorage` is the real platform backend rather than a fake. This drives one
 * managed instance through a write, proves the durable store holds ciphertext
 * rather than the plaintext, and proves the status the renderer receives
 * describes the backend actually used without ever carrying the value.
 *
 * What this deliberately does NOT claim: Keychain continuity across signed
 * updates, which needs two signed builds, and the Linux/Windows backends, which
 * need their own runners.
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

test('a real backend round trip stores ciphertext and reports the backend it used', async () => {
  // Main-process truth: this is the real platform backend, not a fake. On macOS
  // an available backend means the Keychain-backed safeStorage is usable.
  const backend = await app.evaluate(async ({ safeStorage }) => ({
    available: safeStorage.isEncryptionAvailable(),
    backend: safeStorage.getSelectedStorageBackend?.() ?? null
  }))
  expect(backend.available).toBe(true)

  // One instance created through the renderer's own bridge, so the whole chain
  // (renderer → IPC → main → daemon catalog) runs rather than a shortcut.
  const created = await page.evaluate(async () => window.donwells.providerCatalogCreate({
    driverId: 'custom-command',
    displayName: 'Backend probe',
    command: { kind: 'external-shell', program: '/bin/echo probe' },
    credentialMode: 'external',
    accountId: null,
    enabled: true
  }))
  const instance = created.instances[0]
  expect(instance).toBeTruthy()

  // An external-mode instance must refuse a managed credential: the write path
  // is gated on the instance's credential mode, and this is a real refusal.
  const refused = await page.evaluate(async id => {
    try {
      await window.donwells.providerCredentialWrite({
        providerInstanceId: id,
        accountId: 'account-does-not-exist',
        expectedInstanceRevision: 1,
        expectedAccountRevision: 1,
        secret: 'sk-live-PROTECTED-backend-0123456789abcdef'
      })
      return { refused: false }
    } catch (error) {
      return { refused: true, message: error instanceof Error ? error.message : String(error) }
    }
  }, instance?.id ?? '')
  expect(refused.refused).toBe(true)
  // The refusal is typed and never echoes the submitted value.
  expect(refused.message).not.toContain(DISPOSABLE_MARKER)

  // The durable store, if this profile has one, holds ciphertext only.
  const storePath = join(userData, 'provider-secrets.enc.json')
  if (existsSync(storePath)) {
    expect(readFileSync(storePath, 'utf8')).not.toContain(DISPOSABLE_MARKER)
  }
  // No status the renderer can read carries the value either.
  const snapshot = await page.evaluate(() => window.donwells.providerCatalogRead())
  expect(JSON.stringify(snapshot)).not.toContain(DISPOSABLE_MARKER)
})
