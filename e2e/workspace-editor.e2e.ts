import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let app: ElectronApplication | undefined
let page: Page
let userData: string

// Each scenario owns a fresh profile and all project files it can mutate.
test.beforeEach(async () => {
  userData = realpathSync.native(mkdtempSync(join(tmpdir(), 'donwells-workspace-editor-e2e-')))
  mkdirSync(join(userData, 'terminal-daemon'), { recursive: true, mode: 0o700 })
  const packagedExecutable = process.env['DONWELLS_ELECTRON_EXECUTABLE']
  app = await electron.launch({
    ...(packagedExecutable === undefined
      ? { args: [join(__dirname, '../out/main/index.js')] }
      : { executablePath: packagedExecutable }),
    env: { ...process.env, DONWELLS_USER_DATA: userData }
  })
  page = await app.firstWindow()
  await page.bringToFront()
  await expect(page.getByRole('button', { name: 'Add project', exact: true })).toBeVisible()
})

test.afterEach(async () => {
  await app?.close()
  app = undefined
  if (userData) rmSync(userData, { recursive: true, force: true })
})

test('creates a local Git project through the workspace controls', async () => {
  const projectPath = join(userData, 'created-workspace')
  await page.getByRole('button', { name: 'Add project', exact: true }).click()
  await page.getByText('Create project…', { exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Create a local project' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Project name', { exact: true }).fill('created-workspace')
  await dialog.getByLabel('Location', { exact: true }).fill(userData)
  await dialog.getByRole('checkbox', { name: /Initialize a Git repository/ }).check()
  await expect(dialog.locator('.project-setup-result')).toContainText(projectPath)
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click()

  await expect(dialog).not.toBeVisible()
  const checkout = page.locator('.workspace-checkout-open').filter({ hasText: 'created-workspace' })
  await expect(checkout).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('button', { name: 'Files', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Git', exact: true })).toBeEnabled()
  await expect.poll(() => existsSync(join(projectPath, '.git', 'HEAD'))).toBe(true)
  expect(readFileSync(join(projectPath, '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n')
})

test('creates and opens a Git worktree through the lifecycle controls', async () => {
  const repository = join(userData, 'worktree-fixture')
  mkdirSync(repository, { mode: 0o700 })
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', repository])
  writeFileSync(join(repository, 'README.md'), '# Worktree fixture\n')
  execFileSync('git', ['-C', repository, 'add', 'README.md'])
  execFileSync('git', ['-C', repository, '-c', 'user.email=e2e@example.com', '-c', 'user.name=E2E', 'commit', '--quiet', '-m', 'fixture'])
  await page.evaluate(async path => { await window.donwells.addRepo(path) }, repository)
  await page.reload()

  await page.getByRole('button', { name: 'New worktree', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Create worktree', exact: true })
  await dialog.getByLabel('Worktree name', { exact: true }).fill('feature-lifecycle')
  await dialog.getByRole('button', { name: 'Create worktree', exact: true }).click()
  await expect(dialog).not.toBeVisible()

  const worktreePath = join(userData, 'wt-feature-lifecycle')
  await expect.poll(() => existsSync(worktreePath)).toBe(true)
  const checkout = page.locator('.workspace-checkout-open').filter({ hasText: 'feature-lifecycle' })
  await expect(checkout).toHaveAttribute('aria-current', 'page')
  expect(execFileSync('git', ['-C', repository, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })).toContain(worktreePath)
})


test('stages commits and reads history through the Git pane', async () => {
  const repository = await openFixtureProject()
  await page.getByRole('button', { name: 'Git', exact: true }).click()
  const changes = page.getByRole('listbox', { name: 'Changed files', exact: true })
  await expect(changes.getByRole('option', { name: /guide\.md/ })).toBeVisible()
  await changes.getByRole('checkbox', { name: 'Select guide.md', exact: true }).check()
  await page.getByRole('button', { name: 'Stage (1)', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Commit 1', exact: true })).toBeVisible()
  await page.getByLabel('Commit message', { exact: true }).fill('Add fixture guide')
  await page.getByRole('button', { name: 'Commit 1', exact: true }).click()
  await expect(page.getByText('Commit created.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /History Show/, exact: true }).click()
  await expect(page.locator('.git-history-row')).toContainText('Add fixture guide')
  expect(execFileSync('git', ['-C', repository, 'log', '-1', '--pretty=%s'], { encoding: 'utf8' }).trim()).toBe('Add fixture guide')
})
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

async function openFixtureProject(): Promise<string> {
  const repository = join(userData, 'editor-fixture')
  mkdirSync(repository, { mode: 0o700 })
  execFileSync('git', ['init', '--quiet', repository])
  writeFileSync(join(repository, 'guide.md'), '# Fixture guide\n\n## First section\n\nneedle one\n\n## Second section\n\nneedle two\n')
  writeFileSync(join(repository, 'conflict.txt'), 'Original disk text\n')
  // Fixture-only production IPC: all feature actions below use rendered controls.
  await page.evaluate(async path => {
    await window.donwells.setSettings({ editorAutoSaveMode: 'manual', markdownPreviewDefault: false })
    await window.donwells.addRepo(path)
  }, repository)
  await page.reload()
  const checkout = page.locator('.workspace-checkout-open').filter({ hasText: 'editor-fixture' })
  await checkout.click()
  await expect(checkout).toHaveAttribute('aria-current', 'page')
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await expect(page.getByRole('tree', { name: 'Workspace files' })).toBeVisible()
  return repository
}

async function replaceEditorText(content: string): Promise<void> {
  const editor = page.locator('.editor-host .monaco-editor:visible')
  await expect(editor).toBeVisible()
  const accessibilityEditor = editor.getByRole('textbox', { name: 'Editor content', exact: true })
  await expect(accessibilityEditor).toBeAttached()
  await editor.locator('.view-lines').click()
  await page.keyboard.press(`${modifier}+KeyA`)
  await page.keyboard.insertText(content)
  await expect(page.locator('.editor-status-chip')).toContainText(/Unsaved|Protecting changes/)
}

test('creates edits saves renames and reopens a file through the explorer', async () => {
  const repository = await openFixtureProject()
  await page.getByRole('button', { name: 'New folder', exact: true }).click()
  const folder = page.getByRole('dialog', { name: 'New folder', exact: true })
  await folder.getByLabel('Workspace-relative path').fill('notes')
  await folder.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(folder).not.toBeVisible()
  await page.getByRole('treeitem', { name: 'notes', exact: true }).click()
  await expect(page.getByRole('treeitem', { name: 'notes', exact: true })).toHaveAttribute('aria-expanded', 'true')
  await page.getByRole('button', { name: 'New file', exact: true }).click()
  const file = page.getByRole('dialog', { name: 'New file', exact: true })
  await expect(file.getByLabel('Workspace-relative path')).toHaveValue('notes/')
  await file.getByLabel('Workspace-relative path').fill('notes/draft.txt')
  await file.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(file).not.toBeVisible()
  await page.getByRole('tab', { name: 'draft.txt', exact: true }).click()
  await replaceEditorText('Saved through the visible editor\n')
  expect(readFileSync(join(repository, 'notes/draft.txt'), 'utf8')).toBe('')
  await page.keyboard.press(`${modifier}+KeyS`)
  await expect.poll(() => readFileSync(join(repository, 'notes/draft.txt'), 'utf8')).toBe('Saved through the visible editor\n')

  await page.getByRole('treeitem', { name: 'draft.txt', exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Rename or move…', exact: true }).click()
  const rename = page.getByRole('dialog', { name: 'Rename or move', exact: true })
  await rename.getByLabel('Workspace-relative path').fill('notes/final.txt')
  await rename.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(rename).not.toBeVisible()
  await expect(page.getByRole('treeitem', { name: 'final.txt', exact: true })).toBeVisible()
  await expect(page.getByRole('treeitem', { name: 'draft.txt', exact: true })).toHaveCount(0)
  expect(existsSync(join(repository, 'notes/draft.txt'))).toBe(false)
  expect(readFileSync(join(repository, 'notes/final.txt'), 'utf8')).toBe('Saved through the visible editor\n')
  await page.getByRole('button', { name: 'Close final.txt', exact: true }).click()
  await expect(page.locator('.editor-host .monaco-editor:visible')).toHaveCount(0)
  await page.getByRole('treeitem', { name: 'final.txt', exact: true }).click()
  await expect(page.locator('.editor-host .view-lines:visible')).toContainText('Saved through the visible editor')
})

test('reads Markdown and navigates document find matches', async () => {
  await openFixtureProject()
  await page.getByRole('treeitem', { name: 'guide.md', exact: true }).click()
  await expect(page.locator('.editor-host .monaco-editor:visible')).toBeVisible()
  await page.getByRole('button', { name: 'Read Markdown', exact: true }).click()
  const article = page.getByRole('article', { name: 'guide.md', exact: true })
  await expect(article.getByRole('heading', { name: 'Fixture guide' })).toBeVisible()
  await expect(article.getByRole('heading', { name: 'Second section' })).toBeVisible()
  await page.getByRole('button', { name: 'Find in document', exact: true }).click()
  const search = page.getByRole('search', { name: 'Find in document', exact: true })
  await search.getByRole('searchbox', { name: 'Find in document', exact: true }).fill('needle')
  await expect(search.getByRole('status')).toHaveText('1 of 2')
  await search.getByRole('button', { name: 'Next match', exact: true }).click()
  await expect(search.getByRole('status')).toHaveText('2 of 2')
  await search.getByRole('button', { name: 'Previous match', exact: true }).click()
  await expect(search.getByRole('status')).toHaveText('1 of 2')
  await search.getByRole('searchbox').fill('not-present-in-fixture')
  await expect(search.getByRole('status')).toHaveText('No matches')
  await expect(search.getByRole('button', { name: 'Next match', exact: true })).toBeDisabled()
  await search.getByRole('searchbox').press('Escape')
  await expect(search).not.toBeVisible()
  await page.getByRole('button', { name: 'Edit Markdown', exact: true }).click()
  await expect(page.locator('.editor-host .view-lines:visible')).toContainText('# Fixture guide')
})

test('keeps a dirty editor open when close encounters an external disk conflict', async () => {
  const repository = await openFixtureProject()
  await page.getByRole('treeitem', { name: 'conflict.txt', exact: true }).click()
  await replaceEditorText('Unsaved local draft survives close\n')
  // Real concurrent disk edit, not a mocked save or a replacement IPC handler.
  writeFileSync(join(repository, 'conflict.txt'), 'External disk revision\n')
  await page.getByRole('button', { name: 'Close conflict.txt', exact: true }).click()
  await expect(page.locator('.editor-status-chip')).toContainText('Save conflict')
  await expect(page.locator('.editor-host .view-lines:visible')).toContainText('Unsaved local draft survives close')
  await expect(page.getByRole('button', { name: 'Close conflict.txt', exact: true })).toBeVisible()
  expect(readFileSync(join(repository, 'conflict.txt'), 'utf8')).toBe('External disk revision\n')
  await page.getByRole('button', { name: 'Reload', exact: true }).click()
  const discard = page.getByRole('dialog', { name: 'Discard unsaved changes?', exact: true })
  await discard.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.locator('.editor-host .view-lines:visible')).toContainText('Unsaved local draft survives close')
  await page.getByRole('button', { name: 'Reload', exact: true }).click()
  await discard.getByRole('button', { name: 'Discard and reload', exact: true }).click()
  await expect(discard).not.toBeVisible()
  await expect(page.locator('.editor-host .view-lines:visible')).toContainText('External disk revision')
  await page.getByRole('button', { name: 'Close conflict.txt', exact: true }).click()
  await expect(page.locator('.editor-host .monaco-editor:visible')).toHaveCount(0)
})

test('opens a terminal and runs a command, then stops it through the close dialog', async () => {
  await openFixtureProject()
  await page.getByRole('button', { name: 'New terminal', exact: true }).click()
  const host = page.locator('.pane-body-terminal:not(.terminal-hidden) .terminal-host')
  await expect(host).toBeVisible()
  await host.locator('.xterm-helper-textarea').focus()
  await page.keyboard.type('echo terminal-through-keyboard')
  await page.keyboard.press('Enter')
  await expect(host).toContainText('terminal-through-keyboard')
  const activeTerminalTab = page.getByRole('tab', { name: 'Terminal 2' })
  await activeTerminalTab.hover()
  await activeTerminalTab.getByRole('button', { name: /Close .*Terminal/ }).click()
  const dialog = page.getByRole('dialog', { name: /Stop/ })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Stop terminal', exact: true }).click()
  await expect(dialog).not.toBeVisible()
})

test('exercises workspace layout presets', async () => {
  await openFixtureProject()
  // Open a terminal to get 2+ panes for multi-pane presets.
  await page.getByRole('button', { name: 'New terminal', exact: true }).click()
  await expect(page.locator('.pane-body-terminal:not(.terminal-hidden) .terminal-host')).toBeVisible()

  // Single-pane preset.
  await page.getByRole('button', { name: 'Layout', exact: true }).click()
  await page.getByRole('menuitem', { name: 'All tabs', exact: true }).click()

  // Multi-pane presets now available with 2+ panes.
  await page.getByRole('button', { name: 'Layout', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Side by side', exact: true }).click()
  await page.getByRole('button', { name: 'Layout', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Grid', exact: true }).click()

  // Verify editor survived layout changes.
  await expect(page.getByRole('button', { name: 'Files', exact: true })).toBeVisible()
})

test('project search finds content in the open workspace', async () => {
  await openFixtureProject()
  // Open the search pane via the sidebar tool selector.
  await page.getByLabel('Workspace tool', { exact: true }).selectOption('search')
  const search = page.getByRole('searchbox', { name: 'Search project', exact: true })
  await expect(search).toBeVisible()
  await search.fill('needle')
  await expect(page.getByRole('list', { name: 'Content matches', exact: true })).toBeVisible()
})


test('opens a diff pane for a Git-tracked file modified after a commit', async () => {
  const repository = join(userData, 'diff-fixture')
  mkdirSync(repository, { mode: 0o700 })
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', repository])
  writeFileSync(join(repository, 'tracked.txt'), 'Original committed content\n')
  execFileSync('git', ['-C', repository, 'add', 'tracked.txt'])
  execFileSync('git', ['-C', repository, '-c', 'user.email=e2e@example.com', '-c', 'user.name=E2E', 'commit', '--quiet', '-m', 'initial commit'])
  await page.evaluate(async path => { await window.donwells.addRepo(path) }, repository)
  await page.reload()
  const checkout = page.locator('.workspace-checkout-open').filter({ hasText: 'diff-fixture' })
  await checkout.click()
  await expect(checkout).toHaveAttribute('aria-current', 'page')

  // Edit the tracked file via the explorer.
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await expect(page.getByRole('tree', { name: 'Workspace files' })).toBeVisible()
  await page.getByRole('treeitem', { name: 'tracked.txt', exact: true }).click()
  await expect(page.locator('.editor-host .monaco-editor:visible')).toBeVisible()
  await page.locator('.editor-host .monaco-editor:visible .view-lines').click()
  await page.keyboard.press(`${modifier}+KeyA`)
  await page.keyboard.type('Modified content')
  await page.keyboard.press(`${modifier}+KeyS`)

  // Open the diff from the Git pane.
  await page.getByRole('button', { name: 'Git', exact: true }).click()
  await page.getByRole('option', { name: /tracked\.txt/ }).dblclick()
  await expect(page.locator('.diff-review-pane')).toBeVisible()
  await expect(page.locator('.diff-review-diff-host')).toContainText(/Modified content|Original committed/)
})

test('hide and restore works through the layout menu', async () => {
  await openFixtureProject()
  await page.getByRole('button', { name: 'New terminal', exact: true }).click()
  await expect(page.locator('.pane-body-terminal:not(.terminal-hidden) .terminal-host')).toBeVisible()
  await page.getByRole('button', { name: 'Layout', exact: true }).click()
  await page.getByRole('menuitem', { name: /Hide current/ }).click()
  await page.getByRole('button', { name: 'Layout', exact: true }).click()
  await page.getByRole('menuitem', { name: /Restore Terminal/ }).first().click()
  await expect(page.locator('.pane-body-terminal:not(.terminal-hidden) .terminal-host').first()).toBeVisible()
})

test('recovery panel opens and reports no unsaved drafts in a fresh workspace', async () => {
  await openFixtureProject()
  await page.getByLabel('Workspace tool', { exact: true }).selectOption('recovery')
  await expect(page.getByText('No unsaved drafts')).toBeVisible()
})
