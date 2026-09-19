import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let app: ElectronApplication
let page: Page
let userData: string
let repository: string

test.beforeAll(async () => {
  userData = realpathSync.native(mkdtempSync(join(tmpdir(), 'donwells-task-authority-e2e-'), { encoding: 'utf8' }))
  // DaemonClient validates this directory before it can create its runtime files.
  mkdirSync(join(userData, 'terminal-daemon'), { recursive: true, mode: 0o700 })
  repository = join(userData, 'fixture-repository')
  mkdirSync(repository, { recursive: true, mode: 0o700 })
  execFileSync('git', ['init', '--quiet', repository])
  writeFileSync(join(repository, 'backlog.config.yml'), 'version: 1\n', { mode: 0o600 })
  writeFileSync(join(repository, 'backlog-fixture.md'), '# Bounded fixture\n- [ ] TASK-1 Import proof\n', { mode: 0o600 })
  const packagedExecutable = process.env['DONWELLS_ELECTRON_EXECUTABLE']
  app = await electron.launch({
    ...(packagedExecutable === undefined ? { args: [join(__dirname, '../out/main/index.js')] } : { executablePath: packagedExecutable }),
    env: { ...process.env, DONWELLS_USER_DATA: userData, DONWELLS_PERF: '1' },
  })
  page = await app.firstWindow()
  await page.evaluate(async path => { await window.donwells.addRepo(path) }, repository)
})

test.afterAll(async () => {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
})

test('app launches with isolated task-authority profile and disposable repository', async () => {
  expect(page).toBeTruthy()
  const title = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.title)
  expect(title).toContain('donwells')
  const repos = await page.evaluate(() => window.donwells.listRepos())
  expect(repos).toHaveLength(1)
  const databasePath = join(userData, 'terminal-daemon', 'task-authority.sqlite')
  const databasePaths = ['', '-wal', '-shm'].map(suffix => databasePath + suffix)
  expect(existsSync(databasePath)).toBe(true)
  for (const path of databasePaths) {
    expect(path).not.toContain('app.asar')
    if (existsSync(path)) accessSync(path, constants.W_OK)
  }
  expect(repos[0]?.repo.path).toBe(repository)
  const inspection = await page.evaluate(path => window.donwells.projectTasksInspect(path), repository)
  expect(inspection.authority).toBeNull()
  expect(inspection.tools.map(tool => tool.id)).toEqual(expect.arrayContaining(['backlog', 'lazygit']))
})

test('opt-in performance monitoring counts completed IPC calls', async () => {
  const counts = await page.evaluate(async () => {
    const before = await window.donwells.perfGetStats()
    await window.donwells.listRepos()
    const after = await window.donwells.perfGetStats()
    return { before: before.ipcCalls, after: after.ipcCalls }
  })
  expect(counts.after - counts.before).toBeGreaterThanOrEqual(2)
})

test('command palette opens on keyboard shortcut', async () => {
  await page.bringToFront()
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Settings', exact: true }).focus()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+KeyP' : 'Control+Shift+KeyP')
  await expect(page.locator('dialog.palette-dialog')).toBeVisible()
})
