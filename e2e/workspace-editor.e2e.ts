import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let app: ElectronApplication | undefined
let page: Page
let userData: string

const workspaceNavigation = () => page.getByRole('navigation', { name: 'Workspace navigation' })

/** The rail exposes one Tools button; the tool panel's own selector picks the tool. */
async function openToolPanel(): Promise<void> {
  const tools = workspaceNavigation().getByRole('button', { name: 'Tools', exact: true })
  if ((await tools.getAttribute('aria-pressed')) !== 'true') await tools.click()
  await expect(page.getByLabel('Workspace tool', { exact: true })).toBeVisible()
}

async function selectTool(tool: 'explorer' | 'git' | 'search' | 'memory' | 'recovery' | 'computer'): Promise<void> {
  await page.getByLabel('Workspace tool', { exact: true }).selectOption(tool)
}

// Each scenario owns a fresh profile and all project files it can mutate.
test.beforeEach(async () => {
  userData = realpathSync.native(mkdtempSync(join(tmpdir(), 'donwells-workspace-editor-e2e-')))
  mkdirSync(join(userData, 'terminal-daemon'), { recursive: true, mode: 0o700 })
  const packagedExecutable = process.env['DONWELLS_ELECTRON_EXECUTABLE']
  app = await electron.launch({
    ...(packagedExecutable === undefined
      ? { args: [join(__dirname, '../out/main/index.js')] }
      : { executablePath: packagedExecutable }),
    env: { ...process.env, DONWELLS_USER_DATA: userData, XDG_CONFIG_HOME: join(userData, 'config') }
  })
  page = await app.firstWindow()
  await page.bringToFront()
  // A profile with no projects opens on the empty Landing surface.
  await expect(page.getByRole('button', { name: 'New project', exact: true })).toBeVisible()
})

test.afterEach(async () => {
  await app?.close()
  app = undefined
  if (userData) rmSync(userData, { recursive: true, force: true })
})

test('creates a local Git project through the workspace controls', async () => {
  const projectPath = join(userData, 'created-workspace')
  await page.getByRole('button', { name: 'New project', exact: true }).click()
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
  // The new project enables the workspace tool surface and offers both tools.
  await expect(workspaceNavigation().getByRole('button', { name: 'Tools', exact: true })).toBeEnabled()
  await openToolPanel()
  const tool = page.getByLabel('Workspace tool', { exact: true })
  await expect(tool.locator('option', { hasText: 'Files' })).toHaveCount(1)
  await expect(tool.locator('option', { hasText: 'Git' })).toHaveCount(1)
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

  // With the Projects sidebar visible, the checkout actions menu owns worktree creation.
  await page.getByRole('button', { name: 'Actions for worktree-fixture', exact: true }).click()
  await page.getByRole('menuitem', { name: 'New worktree…', exact: true }).click()
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
  await selectTool('git')
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
  await openToolPanel()
  await selectTool('explorer')
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
  // macOS renders the native terminal surface (see TerminalPane): it paints PTY
  // output outside the DOM and exposes no read-back, so only the xterm surface
  // used on other platforms can prove the echoed command reached the terminal.
  if (process.platform === 'darwin') {
    await expect(host).toHaveClass(/native-terminal-host/)
    await host.focus()
  } else {
    await host.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type('echo terminal-through-keyboard')
    await page.keyboard.press('Enter')
    await expect(host).toContainText('terminal-through-keyboard')
  }
  const activeTerminalTab = page.getByRole('tab', { name: 'Terminal 2' })
  await activeTerminalTab.hover()
  await activeTerminalTab.getByRole('button', { name: /Close .*Terminal/ }).click()
  const dialog = page.getByRole('dialog', { name: /Stop/ })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Stop terminal', exact: true }).click()
  await expect(dialog).not.toBeVisible()
})

// Ghostty is the default terminal, so this asserts the default itself instead of
// only the pane that happens to render. A missing or unloadable native module
// fails here rather than silently degrading every pane to xterm.
test('renders the native Ghostty terminal by default', async () => {
  test.skip(process.platform !== 'darwin', 'the native Ghostty surface ships on macOS')
  const availability = await page.evaluate(() => window.donwells.nativeTerminalAvailability())
  expect(availability.available).toBe(true)
  await expect(page.getByLabel('Workspace tool', { exact: true })).toBeHidden()

  await openFixtureProject()
  await page.getByRole('button', { name: 'New terminal', exact: true }).click()
  const host = page.locator('.pane-body-terminal:not(.terminal-hidden) .native-terminal-host')
  await expect(host).toBeVisible()
  await expect(page.locator('.pane-body-terminal:not(.terminal-hidden) .xterm-helper-textarea')).toHaveCount(0)
  // The native surface reports failures through this banner: create, configuration
  // and focus must all have round-tripped through the C bridge without error.
  await expect(page.getByText('Native terminal unavailable')).toHaveCount(0)
  // A second surface proves create/config are repeatable, not one-shot.
  await page.getByRole('button', { name: 'New terminal', exact: true }).click()
  await expect(host).toBeVisible()
  await expect(page.getByText('Native terminal unavailable')).toHaveCount(0)
})

// The theme catalog is compiled into the vendored wrapper, so reaching it proves
// the native module exposes Ghostty's own set rather than an app-side imitation.
test('reaches the Ghostty theme collection through the native module', async () => {
  test.skip(process.platform !== 'darwin', 'the theme catalog comes from the native module')
  const themes = await page.evaluate(() => window.donwells.nativeTerminalThemes())
  expect(themes.length).toBeGreaterThan(400)
  const mocha = themes.find((theme) => theme.name === 'Catppuccin Mocha')
  expect(mocha?.background).toMatch(/^[0-9A-Fa-f]{6}$/)
  expect(Object.keys(mocha?.palette ?? {})).toHaveLength(16)

  // The Settings picker is populated from the same catalog, plus the app palette.
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Terminal', exact: true }).click()
  await expect(page.getByLabel('Ghostty theme', { exact: true }).locator('option')).toHaveCount(themes.length + 1)
  // This section renders from a curated group list, so a setting can exist in the
  // schema and still be missing from the UI. Guard the whole renderer surface.
  await expect(page.getByRole('combobox', { name: 'Renderer', exact: true })).toBeVisible()
  await expect(page.getByRole('switch', { name: 'Ligatures', exact: true })).toBeVisible()
  await expect(page.getByRole('switch', { name: 'Use my Ghostty config', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Font features', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Font variations', exact: true })).toBeVisible()
})

// A user's own Ghostty configuration now feeds the generated one, so a bad merge
// would break every terminal. The file is read per surface, which this relies on.
test('applies a real Ghostty config without breaking the surface', async () => {
  test.skip(process.platform !== 'darwin', 'the native Ghostty surface ships on macOS')
  const directory = join(userData, 'config', 'ghostty')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'config'), [
    '# preferences this app does not manage',
    'keybind = cmd+t=new_tab',
    'keybind = cmd+d=new_split:right',
    'mouse-hide-while-typing = true',
    '# managed keys must be dropped, not honoured',
    'font-size = 99',
    'theme = Catppuccin Mocha'
  ].join('\n'))

  await openFixtureProject()
  await page.getByRole('button', { name: 'New terminal', exact: true }).click()
  await expect(page.locator('.pane-body-terminal:not(.terminal-hidden) .native-terminal-host')).toBeVisible()
  await expect(page.getByText('Native terminal unavailable')).toHaveCount(0)
})

// The quick terminal is an in-window overlay driven by a command, since there is
// no global shortcut. This covers the overlay, its native surface and disposal.
test('summons and disposes the quick terminal', async () => {
  test.skip(process.platform !== 'darwin', 'the native Ghostty surface ships on macOS')
  await openFixtureProject()
  await page.keyboard.press(`${modifier}+Shift+KeyP`)
  const palette = page.locator('dialog.palette-dialog')
  await expect(palette).toBeVisible()
  await palette.getByRole('combobox', { name: 'Commands', exact: true }).fill('Toggle quick terminal')
  await palette.locator('.palette-item', { hasText: 'Toggle quick terminal' }).first().click()

  const overlay = page.getByRole('dialog', { name: 'Quick terminal', exact: true })
  await expect(overlay).toBeVisible()
  await expect(overlay.locator('.native-terminal-host')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(overlay).toHaveCount(0)
  // The workspace layout is untouched: it never became a pane.
  await expect(page.getByRole('button', { name: 'New terminal', exact: true })).toBeVisible()
})

// The native surface draws outside the DOM, so rendered output is only
// observable through the surface's own read-back. This drives a real command
// through the PTY and asserts the surface rendered its output - the closest
// available replacement for the deleted acceptance harness, which dispatched
// events into the real view.
test('renders command output in the native Ghostty surface', async () => {
  test.skip(process.platform !== 'darwin', 'the native Ghostty surface ships on macOS')
  await openFixtureProject()
  await page.getByRole('button', { name: 'New terminal', exact: true }).click()
  await expect(page.locator('.pane-body-terminal:not(.terminal-hidden) .native-terminal-host')).toBeVisible()

  const marker = 'ghostty-rendered-marker'
  const sessionId = await page.evaluate(async () => {
    const sessions = await window.donwells.terminalSessions()
    return sessions[sessions.length - 1]?.id ?? null
  })
  expect(sessionId).toBeTruthy()
  await page.evaluate(async ({ id, command }) => window.donwells.terminalWrite(id, command), { id: sessionId!, command: `echo ${marker}\n` })

  await expect.poll(
    () => page.evaluate(async (id) => {
      try { return (await window.donwells.nativeTerminalRead(id)).text } catch { return '' }
    }, sessionId!),
    { timeout: 20_000 }
  ).toContain(marker)
})

// The fallback to xterm is the design's safety net, but only the resolver was
// unit tested - nothing proved a pane actually renders an xterm surface when
// the renderer is set to one. This exercises the whole path.
test('renders an xterm surface when the renderer is set to xterm', async () => {
  test.skip(process.platform !== 'darwin', 'the fallback exists because the native surface ships on macOS')
  await page.evaluate(() => window.donwells.setSettings({ terminalRenderer: 'xterm' }))
  await openFixtureProject()
  await page.getByRole('button', { name: 'New terminal', exact: true }).click()
  const pane = page.locator('.pane-body-terminal:not(.terminal-hidden)')
  await expect(pane.locator('.xterm-helper-textarea')).toBeAttached()
  await expect(pane.locator('.native-terminal-host')).toHaveCount(0)
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
  await expect(workspaceNavigation().getByRole('button', { name: 'Tools', exact: true })).toBeVisible()
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
  await openToolPanel()
  await selectTool('explorer')
  await expect(page.getByRole('tree', { name: 'Workspace files' })).toBeVisible()
  await page.getByRole('treeitem', { name: 'tracked.txt', exact: true }).click()
  await expect(page.locator('.editor-host .monaco-editor:visible')).toBeVisible()
  await page.locator('.editor-host .monaco-editor:visible .view-lines').click()
  await page.keyboard.press(`${modifier}+KeyA`)
  await page.keyboard.type('Modified content')
  await page.keyboard.press(`${modifier}+KeyS`)

  // Open the diff from the Git pane.
  await selectTool('git')
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
