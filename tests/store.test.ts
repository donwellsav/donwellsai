import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SettingsValidationError } from '../src/shared/settings'
import { Store, StoreLoadError } from '../src/main/store'

let dirs: string[] = []

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'donwells-test-'))
  dirs.push(dir)
  return dir
}

function readEnvelope(store: Store): Record<string, unknown> {
  return JSON.parse(readFileSync(store.path, 'utf8'))
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

describe('Store', () => {
  it('keeps window geometry across workspace saves and rejects malformed stored bounds', () => {
    const store = new Store(tmp())
    const bounds = { x: -1400, y: 40, width: 1100, height: 720, maximized: true }
    store.setWindowState(bounds)
    store.setWorkspaceSession({ activeRepoId: null, repos: {} })
    expect(new Store(dirname(store.path)).getWindowState()).toEqual(bounds)
    const copy = store.getWindowState()!
    copy.width = 1
    expect(store.getWindowState()).toEqual(bounds)
    writeFileSync(store.path, JSON.stringify({ ...readEnvelope(store), windowState: { ...bounds, width: '1100' } }))
    expect(new Store(dirname(store.path)).getWindowState()).toBeUndefined()
  })

  it('round-trips repos and sparse settings through an owner-only file', () => {
    const store = new Store(tmp())
    store.addRepo({ id: 'r1', path: '/tmp/one', addedAt: 't1' })
    store.addRepo({ id: 'r2', path: '/tmp/two', addedAt: 't2' })
    store.updateSettings({ agentCommand: 'claude', terminalFontSize: 16 })

    const envelope = readEnvelope(store)
    expect(envelope.schemaVersion).toBe(2)
    expect(envelope.settings).toEqual({ agentCommand: 'claude', terminalFontSize: 16 })
    if (process.platform !== 'win32') expect(statSync(store.path).mode & 0o777).toBe(0o600)

    const again = new Store(dirname(store.path))
    expect(again.listRepos().map((repo) => repo.id)).toEqual(['r1', 'r2'])
    expect(again.getSettings()).toMatchObject({ agentCommand: 'claude', terminalFontSize: 16, theme: 'dark' })
  })

  it('treats a missing profile as new without manufacturing a file', () => {
    const store = new Store(tmp())
    expect(store.getSettings()).toMatchObject({
      agentCommand: 'codex',
      theme: 'dark',
      terminalFontSize: 13,
      browserHomeUrl: 'http://localhost:3000'
    })
    expect(existsSync(store.path)).toBe(false)
  })

  it('migrates legacy conflated fonts without changing their effective values', () => {
    const dir = tmp()
    const path = join(dir, 'donwells-data.json')
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      repos: [{ id: 'r1', path: '/tmp/one', addedAt: 't1' }],
      settings: {
        fontSize: 17,
        fontFamily: 'Commit Mono',
        terminalTheme: 'dracula',
        editorMinimap: true
      },
      retiredNames: { r1: ['old-name'] },
      worktreeLineage: { r1: { feature: 'main' } },
      independentOwnerState: { keep: 7 }
    }))

    const store = new Store(dir)
    expect(store.getSettings().markdownPreviewDefault).toBe(true)
    expect(store.getSettings()).toMatchObject({
      theme: 'dark',
      terminalFontSize: 17,
      terminalFontFamily: 'Commit Mono',
      editorFontSize: null,
      editorFontFamily: null,
      terminalTheme: 'dracula',
      editorMinimap: true
    })
    expect(store.getRetiredNames('r1')).toEqual(new Set(['old-name']))
    expect(store.getLineage('r1')).toEqual({ feature: 'main' })

    const migrated = readEnvelope(store)
    expect(migrated.schemaVersion).toBe(2)
    expect(migrated.independentOwnerState).toEqual({ keep: 7 })
    expect(migrated.settings).toEqual({
      terminalFontFamily: 'Commit Mono',
      terminalFontSize: 17,
      terminalTheme: 'dracula',
      editorMinimap: true
    })
  })

  it('preserves an explicit legacy Markdown reading preference', () => {
    for (const markdownPreviewDefault of [false, true]) {
      const dir = tmp()
      writeFileSync(join(dir, 'donwells-data.json'), JSON.stringify({ schemaVersion: 1, repos: [], settings: { markdownPreviewDefault } }))
      const store = new Store(dir)
      expect(store.getSettings().markdownPreviewDefault).toBe(markdownPreviewDefault)
      expect(new Store(dir).getSettings().markdownPreviewDefault).toBe(markdownPreviewDefault)
    }
  })

  it('rejects an invalid patch atomically without changing memory or disk', () => {
    const store = new Store(tmp())
    store.updateSettings({ terminalFontSize: 15 })
    const beforeSettings = store.getSettings()
    const beforeDisk = readFileSync(store.path, 'utf8')

    for (const patch of [
      { terminalFontSize: 8 },
      { terminalTheme: 'unknown' },
      { unexpected: true }
    ]) {
      expect(() => store.updateSettings(patch)).toThrow(SettingsValidationError)
      expect(store.getSettings()).toEqual(beforeSettings)
      expect(readFileSync(store.path, 'utf8')).toBe(beforeDisk)
    }
  })

  it('resets selected keys and complete metadata sections without densifying settings', () => {
    const store = new Store(tmp())
    store.updateSettings({
      terminalFontFamily: 'Commit Mono',
      terminalFontSize: 18,
      cursorBlink: false,
      editorMinimap: true
    })

    expect(store.resetSettings({ keys: ['terminalFontSize'] })).toMatchObject({
      terminalFontFamily: 'Commit Mono',
      terminalFontSize: 13,
      cursorBlink: false,
      editorMinimap: true
    })
    expect(store.resetSettings({ section: 'terminal' })).toMatchObject({
      terminalFontFamily: '',
      terminalFontSize: 13,
      cursorBlink: true,
      editorMinimap: true
    })
    expect(readEnvelope(store).settings).toEqual({ editorMinimap: true })
  })

  it('keeps the in-memory snapshot unchanged when the durable write fails', () => {
    const dir = tmp()
    const store = new Store(dir)
    const before = store.getSettings()
    rmSync(dir, { recursive: true })
    writeFileSync(dir, 'blocks directory recreation')

    expect(() => store.updateSettings({ terminalFontSize: 18 })).toThrow()
    expect(store.getSettings()).toEqual(before)
  })

  it('surfaces corrupt and unsupported profiles without overwriting them', () => {
    const corruptDir = tmp()
    const corruptPath = join(corruptDir, 'donwells-data.json')
    const corruptContent = '{not json'
    writeFileSync(corruptPath, corruptContent)
    let corruptError: unknown
    try {
      new Store(corruptDir)
    } catch (error) {
      corruptError = error
    }
    expect(corruptError).toBeInstanceOf(StoreLoadError)
    expect((corruptError as StoreLoadError).kind).toBe('corrupt')
    expect(readFileSync(corruptPath, 'utf8')).toBe(corruptContent)

    const unsupportedDir = tmp()
    const unsupportedPath = join(unsupportedDir, 'donwells-data.json')
    const unsupportedContent = JSON.stringify({ schemaVersion: 99, repos: [], settings: {} })
    writeFileSync(unsupportedPath, unsupportedContent)
    let unsupportedError: unknown
    try {
      new Store(unsupportedDir)
    } catch (error) {
      unsupportedError = error
    }
    expect(unsupportedError).toBeInstanceOf(StoreLoadError)
    expect((unsupportedError as StoreLoadError).kind).toBe('unsupported-schema')
    expect(readFileSync(unsupportedPath, 'utf8')).toBe(unsupportedContent)
  })

  it('rejects unknown settings already present on disk without healing the profile', () => {
    const dir = tmp()
    const path = join(dir, 'donwells-data.json')
    const content = JSON.stringify({ schemaVersion: 2, repos: [], settings: { _raw: 'bad input' } })
    writeFileSync(path, content)

    expect(() => new Store(dir)).toThrow(StoreLoadError)
    expect(readFileSync(path, 'utf8')).toBe(content)
  })

  it('keeps repo insertion idempotent by id', () => {
    const store = new Store(tmp())
    store.addRepo({ id: 'r1', path: '/p', addedAt: 'a' })
    store.addRepo({ id: 'r1', path: '/p', addedAt: 'b' })
    expect(store.listRepos()).toEqual([{ id: 'r1', path: '/p', addedAt: 'a' }])
  })
})

it('retains one legacy layout backup across docking writes and store restart', () => {
  const dir = tmp(), store = new Store(dir)
  const layouts = { '/tmp/project': { kind: 'leaf' as const, pane: 'term:a' } }
  const repo = { panes: {}, activePane: {}, activeTerminal: {}, terminalOrder: {}, layouts, activeWorktreePath: '/tmp/project' }
  store.setWorkspaceSession({ activeRepoId: 'r', repos: { r: repo } })
  store.setWorkspaceSession({ activeRepoId: 'r', repos: { r: { ...repo, docking: {} } } })
  const reopened = new Store(dir)
  reopened.setWorkspaceSession({ activeRepoId: 'r', repos: { r: { ...repo, layouts: {}, docking: {} } } })
  expect(reopened.getWorkspaceSession()?.repos.r?.preDockingLayouts).toEqual(layouts)
})
