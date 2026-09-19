import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * The provider-authority launch cutover in the real Electron app (Task 4, step 5).
 *
 * Runs against the actual main process, preload bridge, daemon, and renderer, in
 * an isolated profile. It proves the two launch surfaces the cutover produced:
 *
 *  - an interactive agent launch is admitted from a provider instance and the
 *    run carries that exact instance identity;
 *  - the dynamic-arity native open (the resume/memory-setup flow) records no
 *    provider identity at all — it is not a provider launch.
 *
 * The negative half is the point of the cutover: no surface may derive provider
 * authority from a command string any more, so the bridge must no longer expose
 * a command-based agent start.
 */

const ROOT = join(__dirname, '..')

let app: ElectronApplication
let page: Page
let userData: string
let repository: string

test.beforeAll(async () => {
  userData = realpathSync.native(mkdtempSync(join(tmpdir(), 'donwells-cutover-e2e-'), { encoding: 'utf8' }))
  // DaemonClient validates this directory before it can create its runtime files.
  mkdirSync(join(userData, 'terminal-daemon'), { recursive: true, mode: 0o700 })
  repository = join(userData, 'fixture-repository')
  mkdirSync(repository, { recursive: true, mode: 0o700 })
  execFileSync('git', ['init', '--quiet', repository])
  writeFileSync(join(repository, 'marker.txt'), 'fixture\n', { mode: 0o600 })
  execFileSync('git', ['-C', repository, 'add', '.'])
  execFileSync('git', ['-C', repository, '-c', 'user.email=e2e@example.com', '-c', 'user.name=E2E', 'commit', '--quiet', '-m', 'fixture'])

  // The profile is seeded before boot: the app's store reads `donwells-data.json`
  // and republishes the project registry the daemon resolves workspaces against.
  // Interactive launches must work without opting into Backlog migration.
  writeFileSync(join(userData, 'donwells-data.json'), JSON.stringify({
    schemaVersion: 2,
    repos: [{ id: 'e2e-cutover-repo', path: repository, addedAt: new Date().toISOString() }],
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

test('the renderer bridge no longer exposes a command-based agent start', async () => {
  const surface = await page.evaluate(() => Object.keys(window.donwells))
  // The cutover deleted `agentStart(workspacePath, command)`: a command string
  // is no longer a way to start an agent. What remains is the explicit native
  // open and the provider-instance launch.
  expect(surface).not.toContain('agentStart')
  expect(surface).toContain('agentNativeOpen')
  expect(surface).toContain('providerInstanceLaunch')
})

test('an interactive launch is admitted from a provider instance and records its identity', async () => {
  // A bounded external custom command stands in for a provider CLI.
  const script = join(userData, 'instance-child.cjs')
  writeFileSync(script, 'process.stdout.write("instance-child-ready\\n"); setInterval(() => {}, 1000)\n', { mode: 0o600 })
  chmodSync(script, 0o600)

  const created = await page.evaluate(async input => {
    return await window.donwells.providerCatalogCreate(input)
  }, {
    driverId: 'custom-command',
    displayName: 'E2E cutover instance',
    command: { kind: 'external-shell', program: `${process.execPath} ${script}` },
    credentialMode: 'external',
    accountId: null,
    enabled: true
  } as never)

  // Select by identity: the catalog snapshot is not ordered by insertion, so a
  // positional pick would launch whichever instance happens to sort last.
  const instance = (created as { instances: Array<{ id: string; displayName: string }> }).instances.find(candidate => candidate.displayName === 'E2E cutover instance')
  expect(instance).toBeDefined()

  // The real launch: instance named, nothing else. The daemon derives the lease,
  // preparation, and admission itself.
  const run = await page.evaluate(async ({ workspacePath, providerInstanceId }) => {
    return await window.donwells.providerInstanceLaunch(workspacePath, providerInstanceId)
  }, { workspacePath: repository, providerInstanceId: instance!.id }) as {
    sessionId: string
    provider?: { driverId: string; providerInstanceId: string; providerInstanceRevision: number; accountId: string | null }
    presetId?: string
  }

  // The run's identity is the admitted instance — not a command family, and no
  // legacy `presetId` written beside it.
  expect(run.provider).toMatchObject({
    driverId: 'custom-command',
    providerInstanceId: instance!.id,
    accountId: null
  })
  expect(run.provider?.providerInstanceRevision).toBeGreaterThan(0)
  expect(run.presetId).toBeUndefined()
  expect(run.sessionId).toBeTruthy()
})

test('the native open is not a provider launch and records no provider identity', async () => {
  const script = join(userData, 'native-child.cjs')
  writeFileSync(script, 'process.stdout.write("native-child-ready\\n"); setInterval(() => {}, 1000)\n', { mode: 0o600 })

  const result = await page.evaluate(async ({ workspacePath, executable }) => {
    return await window.donwells.agentNativeOpen(workspacePath, { executable, args: ['--resume', 'fixture-session'] })
  }, { workspacePath: repository, executable: process.execPath }) as {
    run: { sessionId: string; provider?: unknown; presetId?: unknown }
  }

  // Explicit argv, no admission, and no provider identity derived from the
  // executable name — this is the resume/memory-setup lane, not launch authority.
  expect(result.run.provider).toBeUndefined()
  expect(result.run.presetId).toBeUndefined()
  expect(result.run.sessionId).toBeTruthy()
})

test('a custom-command instance carries no driver-owned arguments', async () => {
  // The project-memory MCP patch is a codex/claude driver argument that exists
  // only on the command line: those drivers write no config file, so losing it
  // silently disables project memory. It is computed in main from the instance's
  // driver and appended to the driver-resolved invocation.
  //
  // codex itself is not installed on every machine, so this asserts the argument
  // policy through a custom-command instance's launch instead: the recorded run
  // command shows exactly what the daemon resolved, and a custom command must
  // carry none of the driver's arguments.
  const created = await page.evaluate(async () => {
    return await window.donwells.providerCatalogCreate({
      driverId: 'custom-command',
      displayName: 'E2E argv policy instance',
      command: { kind: 'external-shell', program: '/bin/echo policy-probe' },
      credentialMode: 'external',
      accountId: null,
      enabled: true
    } as never)
  }) as { instances: Array<{ id: string; displayName: string }> }

  const instance = created.instances.find(candidate => candidate.displayName === 'E2E argv policy instance')!
  const run = await page.evaluate(async ({ workspacePath, providerInstanceId }) => {
    return await window.donwells.providerInstanceLaunch(workspacePath, providerInstanceId)
  }, { workspacePath: repository, providerInstanceId: instance.id }) as { command?: string }

  // A custom-command instance runs exactly its own spec: no driver argument is
  // injected, so an instance can never become an argv channel.
  expect(run.command).toContain('policy-probe')
  expect(run.command).not.toContain('mcp_servers.donwells-project-memory')
})

test('Advanced opens an explicit local tool with separately supplied arguments', async () => {
  const marker = join(userData, 'native-tool-ui-marker')
  await page.getByRole('button', { name: 'fixture-repository main Open', exact: true }).click()
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name: 'New agent', exact: true }).click()
  const setup = page.getByRole('dialog', { name: 'New agent', exact: true })
  await setup.getByText('Advanced launch and integrations', { exact: true }).click()
  await setup.getByRole('checkbox', { name: 'Pass arguments separately', exact: true }).check()
  await setup.getByLabel('Executable', { exact: true }).fill('/usr/bin/touch')
  await setup.getByRole('button', { name: 'Add argument', exact: true }).click()
  await setup.getByLabel('Argument 1', { exact: true }).fill(marker)
  await setup.getByRole('button', { name: 'Start agent & open terminal', exact: true }).click()
  await expect.poll(() => existsSync(marker)).toBe(true)
})

test('template loading failures remain visible and recover after retry', async () => {
  const templates = await page.evaluate(() => window.donwells.sessionTemplateList())
  expect(templates[0]).toBeDefined()
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('sessionTemplate:list')
    ipcMain.handle('sessionTemplate:list', () => { throw new Error('Template storage temporarily unavailable') })
  })
  try {
    await page.reload()
    await page.getByRole('button', { name: 'fixture-repository main', exact: true }).click()
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Agents', exact: true }).click()
    await page.getByRole('button', { name: 'New agent', exact: true }).click()
    const setup = page.getByRole('dialog', { name: 'New agent', exact: true })
    await expect(setup.getByRole('alert')).toContainText('Template storage temporarily unavailable')
    await app.evaluate(({ ipcMain }, saved) => {
      ipcMain.removeHandler('sessionTemplate:list')
      ipcMain.handle('sessionTemplate:list', () => saved)
    }, templates)
    await setup.getByRole('button', { name: 'Retry templates', exact: true }).click()
    await expect(setup.getByRole('button', { name: templates[0]!.name, exact: true })).toBeVisible()
    await expect(setup.getByRole('alert')).not.toBeVisible()
  } finally {
    await app.evaluate(({ ipcMain }, saved) => {
      ipcMain.removeHandler('sessionTemplate:list')
      ipcMain.handle('sessionTemplate:list', () => saved)
    }, templates)
  }
})

test('unchecked shell commands cannot be submitted as native launches', async () => {
  await page.reload()
  await page.getByRole('button', { name: 'fixture-repository main', exact: true }).click()
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name: 'New agent', exact: true }).click()
  const setup = page.getByRole('dialog', { name: 'New agent', exact: true })
  await expect(setup.getByLabel('Provider instance', { exact: true })).toHaveValue('')
  await setup.getByText('Advanced launch and integrations', { exact: true }).click()
  await setup.getByRole('checkbox', { name: 'Pass arguments separately', exact: true }).uncheck()
  await setup.getByLabel('Shell command', { exact: true }).fill('/usr/bin/true')
  await expect(setup.getByRole('button', { name: 'Start agent & open terminal', exact: true })).toBeDisabled()
  await setup.getByRole('button', { name: 'Close agent setup', exact: true }).click()
})

test('templates remain available without installed agent presets', async () => {
  const presets = await page.evaluate(() => window.donwells.listAgents())
  const templates = await page.evaluate(() => window.donwells.sessionTemplateList())
  expect(templates[0]).toBeDefined()
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('listAgents')
    ipcMain.handle('listAgents', () => [])
  })
  try {
    await page.reload()
    await page.getByRole('button', { name: 'fixture-repository main', exact: true }).click()
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Agents', exact: true }).click()
    await page.getByRole('button', { name: 'New agent', exact: true }).click()
    const setup = page.getByRole('dialog', { name: 'New agent', exact: true })
    await expect(setup.getByText('No supported agent was found.', { exact: true })).toBeVisible()
    await expect(setup.getByRole('button', { name: templates[0]!.name, exact: true })).toBeVisible()
    await setup.getByRole('button', { name: templates[0]!.name, exact: true }).click()
    await setup.getByRole('button', { name: 'No template', exact: true }).click()
    await setup.getByRole('button', { name: 'Close agent setup', exact: true }).click()
  } finally {
    await app.evaluate(({ ipcMain }, saved) => {
      ipcMain.removeHandler('listAgents')
      ipcMain.handle('listAgents', () => saved)
    }, presets)
  }
})
