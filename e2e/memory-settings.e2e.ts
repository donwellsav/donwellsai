import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Real renderer → preload → main/daemon workflows. IPC only seeds fixtures or
// observes persisted outcomes; every memory/settings action under test uses UI.
// Each case owns its profile and repository, including retries. No agent starts,
// provider credentials, external pages, or configuration in the real home are used.
let app: ElectronApplication | undefined
let page: Page
let userData: string | undefined
let repository: string
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

async function launch(): Promise<void> {
  const packagedExecutable = process.env['DONWELLS_ELECTRON_EXECUTABLE']
  app = await electron.launch({
    ...(packagedExecutable === undefined ? { args: [join(__dirname, '../out/main/index.js')] } : { executablePath: packagedExecutable }),
    env: { ...process.env, DONWELLS_USER_DATA: userData }
  })
  page = await app.firstWindow()
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()
}

test.beforeEach(async () => {
  userData = realpathSync.native(mkdtempSync(join(tmpdir(), 'donwells-memory-settings-e2e-'), { encoding: 'utf8' }))
  mkdirSync(join(userData, 'terminal-daemon'), { recursive: true, mode: 0o700 })
  repository = join(userData, 'fixture-repository')
  mkdirSync(repository, { mode: 0o700 })
  execFileSync('git', ['init', '--quiet', repository])
  writeFileSync(join(repository, 'marker.txt'), 'Disposable memory/settings fixture\n', { mode: 0o600 })
  await launch()
  await page.evaluate(path => window.donwells.addRepo(path), repository)
  // Reload consumes the registered fixture through the ordinary startup path.
  // Project activation itself is a real checkout click, not a store injection.
  await page.reload()
  await page.locator('.workspace-checkout-open').filter({ hasText: 'fixture-repository' }).click()
})

test.afterEach(async () => {
  try { await app?.close() }
  finally {
    app = undefined
    if (userData) rmSync(userData, { recursive: true, force: true })
    userData = undefined
  }
})

async function openMemory(): Promise<void> {
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Files', exact: true }).click()
  await page.getByLabel('Workspace tool', { exact: true }).selectOption('memory')
  await expect(page.getByRole('region', { name: 'Project memory', exact: true })).toBeVisible()
}

async function openSettings(section: string): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await selectSettingsSection(section)
}

async function selectSettingsSection(section: string): Promise<void> {
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: section, exact: true }).click()
}

function settingsDialog() { return page.getByRole('dialog', { name: 'Settings', exact: true }) }
function memoryPanel() { return page.getByRole('region', { name: 'Project memory', exact: true }) }
function memoryEditor() { return page.getByRole('dialog', { name: /^(Record|Review) project knowledge$/ }) }
function memoryRow(title: string) { return memoryPanel().locator('.memory-entry-row').filter({ has: page.getByText(title, { exact: true }) }) }
async function memoryEntries() {
  return page.evaluate(workspacePath => window.donwells.projectMemoryList({ workspacePath, includeArchived: true }), repository)
}

// Rows 83–85: catches lost authored fields, stale list rendering, destructive
// archive, editable archived records, and restore failing to republish an entry.
test('authored memory keeps revisions through edit, archive, and restore', async () => {
  await openMemory()
  await memoryPanel().getByRole('button', { name: 'New memory', exact: true }).click()
  const editor = memoryEditor()
  await expect(editor.getByRole('button', { name: 'Save memory', exact: true })).toBeDisabled()
  await editor.getByLabel(/^Title/).fill('Build contract')
  await editor.getByRole('combobox', { name: 'Kind', exact: true }).selectOption('procedure')
  await editor.getByLabel('Tags', { exact: true }).fill('build, local')
  await editor.getByLabel(/^Knowledge/).fill('Use the local fixture build; do not fetch dependencies.')
  await editor.getByLabel(/^Source reference/).fill('marker.txt')
  await editor.getByRole('button', { name: 'Save memory', exact: true }).click()
  await expect(editor).not.toBeVisible()
  await expect(memoryRow('Build contract')).toBeVisible()
  const saved = (await memoryEntries()).entries
  expect(saved).toHaveLength(1)
  expect(saved[0]).toMatchObject({ title: 'Build contract', kind: 'procedure', tags: ['build', 'local'], revision: 1, archivedAt: null, provenance: { harness: 'human', sourceRef: 'marker.txt' } })

  await memoryRow('Build contract').click()
  await editor.getByLabel(/^Title/).fill('Reviewed build contract')
  await editor.getByLabel(/^Knowledge/).fill('Review marker.txt before running the local build.')
  await expect(editor.getByRole('button', { name: 'Archive entry', exact: true })).toBeDisabled()
  await editor.getByRole('button', { name: 'Save memory', exact: true }).click()
  await expect(memoryRow('Reviewed build contract')).toBeVisible()
  await expect(memoryRow('Build contract')).toHaveCount(0)
  await memoryRow('Reviewed build contract').click()
  await editor.getByRole('button', { name: 'Revision history', exact: true }).click()
  await editor.locator('summary').filter({ hasText: /^Revision 1 ·/ }).click()
  await expect(editor.locator('.memory-history-list')).toContainText('Use the local fixture build; do not fetch dependencies.')
  await editor.getByRole('button', { name: 'Archive entry', exact: true }).click()
  await expect(editor).not.toBeVisible()
  await expect(memoryRow('Reviewed build contract')).toHaveCount(0)
  expect((await memoryEntries()).entries[0]?.archivedAt).not.toBeNull()

  await memoryPanel().locator('summary').filter({ hasText: /^Filters/ }).click()
  await memoryPanel().getByLabel('Archived', { exact: true }).check()
  await memoryRow('Reviewed build contract').click()
  await expect(editor.getByLabel(/^Knowledge/)).toBeDisabled()
  await expect(editor.getByLabel(/^Knowledge/)).toHaveValue('Review marker.txt before running the local build.')
  await editor.getByRole('button', { name: 'Restore entry', exact: true }).click()
  await expect(editor).not.toBeVisible()
  await memoryPanel().getByLabel('Archived', { exact: true }).uncheck()
  await expect(memoryRow('Reviewed build contract')).toBeVisible()
  expect((await memoryEntries()).entries).toEqual([expect.objectContaining({ id: saved[0]?.id, revision: 4, archivedAt: null, title: 'Reviewed build contract', content: 'Review marker.txt before running the local build.' })])
})

// Rows 84–85: catches drafts discarded before confirmation and erasure occurring
// on the first click or leaving authoritative content reachable after approval.
test('memory discard and erase require the explicit final decision', async () => {
  const entry = await page.evaluate(workspacePath => window.donwells.projectMemoryCreate({ workspacePath, kind: 'fact', title: 'Retained fact', content: 'Original content', attribution: { harness: 'fixture' } }), repository)
  await openMemory()
  await memoryRow('Retained fact').click()
  const editor = memoryEditor()
  await editor.getByLabel(/^Knowledge/).fill('Unsaved replacement')
  await editor.getByRole('button', { name: 'Close', exact: true }).click()
  await editor.getByRole('button', { name: 'Keep editing', exact: true }).click()
  await expect(editor.getByLabel(/^Knowledge/)).toHaveValue('Unsaved replacement')
  expect((await memoryEntries()).entries[0]?.content).toBe('Original content')
  await editor.getByRole('button', { name: 'Close', exact: true }).click()
  await editor.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await memoryRow('Retained fact').click()
  await expect(editor.getByLabel(/^Knowledge/)).toHaveValue('Original content')
  await editor.getByRole('button', { name: 'Erase…', exact: true }).click()
  await editor.getByRole('button', { name: 'Keep entry', exact: true }).click()
  expect((await memoryEntries()).entries.map(value => value.id)).toEqual([entry.id])
  await editor.getByRole('button', { name: 'Erase…', exact: true }).click()
  await editor.getByRole('button', { name: 'Erase entry and history', exact: true }).click()
  await expect(editor).not.toBeVisible()
  await expect(memoryRow('Retained fact')).toHaveCount(0)
  expect((await memoryEntries()).entries).toEqual([])
  const readable = await page.evaluate(async ({ workspacePath, id }) => {
    try { await window.donwells.projectMemoryHistory({ workspacePath, id }); return true }
    catch { return false }
  }, { workspacePath: repository, id: entry.id })
  expect(readable).toBe(false)
})

// Row 84: a real concurrent writer, not a mock. Reapplying the retained draft
// must not write until the operator separately presses Save memory again.
test('memory conflict retains the draft and requires review before reapplying', async () => {
  const entry = await page.evaluate(workspacePath => window.donwells.projectMemoryCreate({ workspacePath, kind: 'decision', title: 'Competing decision', content: 'Initial decision', attribution: { harness: 'fixture' } }), repository)
  await openMemory()
  await memoryRow('Competing decision').click()
  const editor = memoryEditor()
  await editor.getByLabel(/^Knowledge/).fill('Operator reviewed decision')
  await page.evaluate(({ workspacePath, id }) => window.donwells.projectMemoryUpdate({ workspacePath, id, expectedRevision: 1, kind: 'decision', title: 'Competing decision', content: 'Concurrent writer decision', attribution: { harness: 'fixture-writer' } }), { workspacePath: repository, id: entry.id })
  await editor.getByRole('button', { name: 'Save memory', exact: true }).click()
  await expect(editor.getByRole('alert')).toBeVisible()
  await expect(editor.getByLabel(/^Knowledge/)).toHaveValue('Operator reviewed decision')
  await editor.getByRole('button', { name: 'Compare latest…', exact: true }).click()
  await expect(editor.getByRole('region', { name: 'Review latest revision before resolving' })).toContainText('Concurrent writer decision')
  await editor.getByRole('button', { name: 'Reapply draft to latest revision', exact: true }).click()
  expect((await memoryEntries()).entries[0]).toMatchObject({ revision: 2, content: 'Concurrent writer decision' })
  await editor.getByRole('button', { name: 'Save memory', exact: true }).click()
  await expect(editor).not.toBeVisible()
  expect((await memoryEntries()).entries[0]).toMatchObject({ id: entry.id, revision: 3, content: 'Operator reviewed decision' })
})

// Row 83: crosses the actual 100-entry page boundary; query and kind filtering
// must reset pagination and must not return another kind's matching text.
test('memory search and kind filters reset paging without losing entries', async () => {
  test.setTimeout(90_000)
  await page.evaluate(async workspacePath => {
    for (let index = 0; index < 101; index++) {
      await window.donwells.projectMemoryCreate({ workspacePath, kind: 'convention', title: `Paging fixture ${String(index).padStart(3, '0')}`, content: 'A reviewed paging convention.', attribution: { harness: 'fixture' } })
    }
    await window.donwells.projectMemoryCreate({ workspacePath, kind: 'gotcha', title: 'Other kind fixture', content: 'Paging fixture 100 is only a search phrase here.', attribution: { harness: 'fixture' } })
  }, repository)
  await openMemory()
  await memoryPanel().locator('summary').filter({ hasText: /^Filters/ }).click()
  await memoryPanel().getByLabel('Filter memory kind').selectOption('convention')
  const rows = memoryPanel().locator('.memory-entry-row')
  await expect(rows).toHaveCount(100)
  const firstTitles = await rows.locator('strong').allTextContents()
  const pages = memoryPanel().getByRole('navigation', { name: 'Memory pages' })
  await pages.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(rows).toHaveCount(1)
  expect(firstTitles).not.toContain(await rows.locator('strong').innerText())
  await expect(pages.getByRole('button', { name: 'Next', exact: true })).toBeDisabled()
  await pages.getByRole('button', { name: 'Previous', exact: true }).click()
  await expect(rows.locator('strong')).toHaveText(firstTitles)
  await pages.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(rows).toHaveCount(1)
  await memoryPanel().getByLabel('Search project memory').fill('Paging fixture 100')
  await expect(rows.locator('strong')).toHaveText(['Paging fixture 100'])
  await expect(pages).not.toBeVisible()
  await memoryPanel().getByLabel('Filter memory kind').selectOption('all')
  await expect(rows).toHaveCount(2)
  await memoryPanel().getByLabel('Search project memory').fill('no-such-fixture-knowledge')
  await expect(rows).toHaveCount(0)
  await memoryPanel().getByRole('button', { name: 'Clear filters', exact: true }).click()
  await expect(rows).toHaveCount(100)
})

// Rows 86–87, bounded no-provider branches only. Exporting the connection is
// self-contained; native harness setup and handoff delivery intentionally aren't.
test('memory connection export is scoped to this profile and handoff authoring needs a session', async () => {
  await openMemory()
  await memoryPanel().locator('summary').filter({ hasText: 'Memory integrations' }).click()
  await memoryPanel().getByRole('button', { name: 'Connect agent', exact: true }).click()
  const connection = page.getByRole('dialog', { name: 'Connect a coding harness', exact: true })
  await connection.getByRole('combobox', { name: 'Harness', exact: true }).selectOption('omp')
  await connection.locator('summary').filter({ hasText: 'Advanced: export connection' }).click()
  const config = JSON.parse(await connection.getByLabel('Project memory MCP configuration').inputValue())
  expect(config.mcpServers.donwells_project_memory.args).toEqual(expect.arrayContaining(['memory-mcp', '--workspace', repository, '--harness', 'omp', '--user-data', userData]))
  await connection.getByRole('combobox', { name: 'Harness', exact: true }).selectOption('kimi')
  const changed = JSON.parse(await connection.getByLabel('Project memory MCP configuration').inputValue())
  expect(changed.mcpServers.donwells_project_memory.args).toContain('kimi')
  expect(changed.mcpServers.donwells_project_memory.args).not.toContain('omp')
  await connection.getByRole('button', { name: 'Close', exact: true }).click()
  await memoryPanel().locator('summary').filter({ hasText: /^Agent handoffs/ }).click()
  await memoryPanel().locator('summary').filter({ hasText: 'Write a handoff' }).click()
  await expect(memoryPanel().getByRole('button', { name: 'New agent', exact: true })).toBeVisible()
  await expect(memoryPanel().getByRole('form', { name: 'Save agent handoff' })).not.toBeVisible()
  expect(await page.evaluate(path => window.donwells.projectHandoffList(path), repository)).toEqual([])
})

// Rows 91–93: catches eager persistence before Apply, navigation/close dropping
// a draft, Discard saving it, and UI-only changes that vanish after a new process.
test('settings apply and discard guard drafts and appearance survives relaunch', async () => {
  test.setTimeout(60_000)
  await openSettings('Terminal')
  const original = await page.evaluate(() => window.donwells.getSettings())
  const field = settingsDialog().locator('[data-setting-key="terminalFontSize"]')
  const changedSize = original.terminalFontSize === 18 ? 19 : 18
  await field.getByLabel('Font size', { exact: true }).fill(String(changedSize))
  expect((await page.evaluate(() => window.donwells.getSettings())).terminalFontSize).toBe(original.terminalFontSize)
  await selectSettingsSection('Appearance')
  await expect(field.getByLabel('Font size', { exact: true })).toHaveValue(String(changedSize))
  await settingsDialog().getByRole('button', { name: 'Close settings', exact: true }).click()
  await expect(field).toBeVisible()
  await field.getByRole('button', { name: 'Discard', exact: true }).click()
  await expect(field.getByLabel('Font size', { exact: true })).toHaveValue(String(original.terminalFontSize))
  await field.getByLabel('Font size', { exact: true }).fill(String(changedSize))
  await field.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(field.getByRole('button', { name: 'Apply', exact: true })).not.toBeVisible()
  expect((await page.evaluate(() => window.donwells.getSettings())).terminalFontSize).toBe(changedSize)
  await selectSettingsSection('Appearance')
  await settingsDialog().getByRole('combobox', { name: 'Theme', exact: true }).selectOption({ label: 'Light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await settingsDialog().getByRole('combobox', { name: 'Control spacing', exact: true }).selectOption({ label: 'Comfortable' })
  await expect(page.locator('html')).toHaveAttribute('data-density', 'comfortable')
  await settingsDialog().getByRole('combobox', { name: 'Theme', exact: true }).selectOption({ label: 'Dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await settingsDialog().getByRole('button', { name: 'Close settings', exact: true }).click()
  await app!.close()
  app = undefined
  await launch()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('html')).toHaveAttribute('data-density', 'comfortable')
  await openSettings('Terminal')
  await expect(settingsDialog().getByRole('spinbutton', { name: 'Font size', exact: true })).toHaveValue(String(changedSize))
  await settingsDialog().getByRole('button', { name: 'Reset Font size to default', exact: true }).click()
  await expect(settingsDialog().getByRole('spinbutton', { name: 'Font size', exact: true })).toHaveValue(String(original.terminalFontSize))
})

// Rows 91,94: captures real keys rather than filling canonical strings. The
// observable contract is the command opening at the new binding after restart.
test('shortcut capture rejects conflicts, discards edits, and persists an operational binding', async () => {
  test.setTimeout(60_000)
  await openSettings('Keyboard Shortcuts')
  await settingsDialog().getByLabel('Filter application commands').fill('command-palette')
  const row = settingsDialog().locator('.shortcut-row').filter({ has: page.getByLabel('Custom shortcut for Show Command Palette…', { exact: true }) })
  const input = row.getByLabel('Custom shortcut for Show Command Palette…', { exact: true })
  await input.focus()
  await page.keyboard.press(`${modifier}+KeyP`)
  await row.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(row.getByRole('alert')).toBeVisible()
  expect((await page.evaluate(() => window.donwells.getSettings())).keyboardShortcutOverrides['command-palette']).toBeUndefined()
  await row.getByRole('button', { name: 'Discard', exact: true }).click()
  await expect(input).toHaveValue('')
  await input.focus()
  await page.keyboard.press(`${modifier}+Shift+KeyY`)
  await expect(input).toHaveValue('Mod+Shift+Y')
  await row.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(row.getByRole('button', { name: 'Apply', exact: true })).not.toBeVisible()
  await settingsDialog().getByRole('button', { name: 'Close settings', exact: true }).click()
  await app!.close()
  app = undefined
  await launch()
  await page.bringToFront()
  await page.getByRole('button', { name: 'Settings', exact: true }).focus()
  await page.keyboard.press(`${modifier}+Shift+KeyY`)
  await expect(page.locator('dialog.palette-dialog')).toBeVisible()
  expect((await page.evaluate(() => window.donwells.getSettings())).keyboardShortcutOverrides['command-palette']).toBe('Mod+Shift+Y')
})

// Rows 91,95: turning recording off must retain old data; cancelling erasure
// must retain it too. Only the final confirmation removes saved addresses.
test('privacy history opt-out preserves existing visits until confirmed clearing', async () => {
  await page.evaluate(() => window.donwells.browserHistoryRecord({ url: 'http://127.0.0.1:54321/fixture-history', title: 'Disposable history entry' }))
  await openSettings('Privacy & Security')
  const recording = settingsDialog().getByRole('switch', { name: 'Save browsing history', exact: true })
  await expect(recording).toHaveAttribute('aria-checked', 'true')
  await recording.click()
  await expect(recording).toHaveAttribute('aria-checked', 'false')
  expect((await page.evaluate(() => window.donwells.getSettings())).recordBrowserHistory).toBe(false)
  expect(await page.evaluate(() => window.donwells.browserHistoryList())).toEqual([expect.objectContaining({ url: 'http://127.0.0.1:54321/fixture-history', title: 'Disposable history entry' })])
  await settingsDialog().getByRole('button', { name: 'Clear browsing history…', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: 'Clear browsing history?', exact: true })
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await page.evaluate(() => window.donwells.browserHistoryList())).toHaveLength(1)
  await settingsDialog().getByRole('button', { name: 'Clear browsing history…', exact: true }).click()
  await confirmation.getByRole('button', { name: 'Clear history permanently', exact: true }).click()
  await expect(confirmation).not.toBeVisible()
  expect(await page.evaluate(() => window.donwells.browserHistoryList())).toEqual([])
  await settingsDialog().getByRole('button', { name: 'Close settings', exact: true }).click()
  await openSettings('Privacy & Security')
  await expect(recording).toHaveAttribute('aria-checked', 'false')
})
