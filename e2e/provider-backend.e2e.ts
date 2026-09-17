import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { callTerminalDaemon } from '../src/cli/rpc-client'
import { assertNoDisclosure } from '../src/main/test-utils/disclosure-census'

/**
 * Runs against the built app, or the directory package when CI supplies its
 * executable. The real async safeStorage round trip is backend evidence only:
 * it does not certify a driver, prove a managed launch, or prove signed-update
 * continuity. Built-ins remain external-only.
 *
 * Linux basic_text/unknown is reported as unprotected, never round-trip success.
 * The app must report that state and refuse the external credential write.
 * BACKEND_UNPROTECTED persistence refusal is separately exercised by the real
 * authority unit suite; no managed write reaches that seam in the shipped app.
 */

const DISPOSABLE_MARKER = 'disposable-provider-backend-marker-0123456789abcdef'

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
  try {
    await app?.close()
  } finally {
    if (userData) rmSync(userData, { recursive: true, force: true })
  }
})

test('reports real backend evidence and refuses external credential persistence', async ({}, testInfo) => {
  const backend = await app.evaluate(async ({ app, safeStorage }) => ({
    packaged: app.isPackaged,
    platform: process.platform,
    available: await safeStorage.isAsyncEncryptionAvailable(),
    selected: process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : null
  }))
  if (process.env['DONWELLS_ELECTRON_EXECUTABLE'] !== undefined) expect(backend.packaged).toBe(true)
  const unprotected = backend.platform === 'linux' && (backend.selected === 'basic_text' || backend.selected === 'unknown')
  testInfo.annotations.push({
    type: 'provider-backend',
    description: JSON.stringify({ ...backend, evidence: unprotected ? 'unprotected; refusal-only; no protected roundtrip' : 'protected roundtrip required' })
  })

  // No built-in driver is certified, so `managed` cannot be authored. This
  // asserts the shipped matrix rather than assuming it.
  const snapshot = await page.evaluate(() => window.donwells.providerCatalogRead())
  for (const driver of snapshot.drivers) {
    if (driver.kind !== 'known') continue
    expect(driver.managedSupport.kind).toBe('unsupported')
  }

  // Account creation is an existing authenticated daemon operation, not a
  // renderer API. A real account prevents ACCOUNT_NOT_FOUND from making this
  // external-mode refusal test vacuously pass.
  const accountReply = await callTerminalDaemon('agent.providers.account.create', {
    input: { driverId: 'custom-command', displayLabel: 'Disposable backend account' }
  }, userData, 10_000)
  expect(accountReply.ok, accountReply.error).toBe(true)
  const withAccount = await page.evaluate(() => window.donwells.providerCatalogRead())
  const account = withAccount.accounts.find(candidate => candidate.displayLabel === 'Disposable backend account')
  if (!account) throw new Error('Disposable provider account was not created')
  const refused = await page.evaluate(async ({ marker, account }) => {
    const created = await window.donwells.providerCatalogCreate({
      driverId: 'custom-command',
      displayName: 'Backend probe',
      command: { kind: 'external-shell', program: 'echo probe' },
      credentialMode: 'external',
      accountId: account.id,
      enabled: true
    })
    const instance = created.instances.find(candidate => candidate.displayName === 'Backend probe')
    if (!instance) throw new Error('Disposable provider instance was not created')
    const status = await window.donwells.providerCredentialStatus({ providerInstanceId: instance.id, accountId: account.id })
    try {
      await window.donwells.providerCredentialWrite({
        providerInstanceId: instance.id,
        accountId: account.id,
        expectedInstanceRevision: instance.revision,
        expectedAccountRevision: account.revision,
        secret: marker
      })
      return { refused: false, message: 'the write unexpectedly succeeded', status: status.status }
    } catch (error) {
      return { refused: true, message: error instanceof Error ? error.message : String(error), status: status.status }
    }
  }, { marker: DISPOSABLE_MARKER, account })
  expect(refused.refused).toBe(true)
  expect(refused.message).not.toContain(DISPOSABLE_MARKER)
  // Electron drops the catalog error's code at this boundary; require the
  // actual mode refusal, not an arbitrary IPC/account/backend error.
  expect(refused.message).toContain('external providers do not accept managed credentials')
  if (unprotected) {
    expect(refused.status).toMatchObject({ state: 'unavailable', backend: 'unprotected' })
  } else {
    expect(backend.available, `BACKEND_UNAVAILABLE: ${JSON.stringify(backend)}; protected backend is required, not skipped`).toBe(true)
    const roundtrip = await app.evaluate(async ({ safeStorage }, marker) => {
      const ciphertext = await safeStorage.encryptStringAsync(marker)
      const decrypted = await safeStorage.decryptStringAsync(ciphertext)
      return { matches: decrypted.result === marker, ciphertextContainsMarker: ciphertext.includes(Buffer.from(marker)) }
    }, DISPOSABLE_MARKER)
    expect(roundtrip).toEqual({ matches: true, ciphertextContainsMarker: false })
    testInfo.annotations.push({ type: 'provider-backend', description: 'Real async safeStorage protected roundtrip passed; not a managed credential or launch proof' })
  }

  // Scan live profile files (including DB/WAL/logs) and renderer projections.
  const storePath = join(userData, 'provider-secrets.enc.json')
  expect(existsSync(storePath)).toBe(false)
  const after = await page.evaluate(() => window.donwells.providerCatalogRead())
  expect(JSON.stringify(after)).not.toContain(DISPOSABLE_MARKER)
  expect(await page.locator('body').innerText()).not.toContain(DISPOSABLE_MARKER)
  assertNoDisclosure(userData, [DISPOSABLE_MARKER])
})
