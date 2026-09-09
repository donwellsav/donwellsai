import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, validateSettingsPatch, resolveSettings, sparseSettings } from '../src/shared/settings'
import { resetSettingsAtRevision, searchSettingsCatalog, SETTINGS_SECTION_PRESENTATION } from '../src/renderer/src/settings-workspace'
import { renderToStaticMarkup } from 'react-dom/server'
import { Icon } from '../src/renderer/src/components/Icon'
import { TERMINAL_THEMES, TERMINAL_THEME_NAMES } from '../src/renderer/src/terminal-themes'

describe('settings workspace catalog', () => {
  it('renders a nonempty icon for every settings destination', () => {
    for (const section of SETTINGS_SECTION_PRESENTATION) {
      expect(renderToStaticMarkup(Icon({ name: section.icon })), section.id).toMatch(/<(path|rect|circle|polyline|line)/)
    }
  })
  it('finds actual application commands and privacy controls', () => {
    expect(searchSettingsCatalog('Quick Open').map((group) => group.section.id)).toEqual(['shortcuts'])
    expect(searchSettingsCatalog('external agent access').map((group) => group.section.id)).toEqual(['privacy'])
    for (const query of ['Skills', 'Hindsight', 'documents', 'backup']) expect(searchSettingsCatalog(query).some(group => group.section.id === 'project')).toBe(true)
    expect(searchSettingsCatalog('not a real preference')).toEqual([])
  })

  it('rejects shortcut overrides outside the actual command registry or in conflict', () => {
    expect(() => validateSettingsPatch({ keyboardShortcutOverrides: { imaginary: 'Mod+I' } })).toThrow('Invalid value')
    expect(() => validateSettingsPatch({ keyboardShortcutOverrides: { 'add-repo': 'Mod+N' } })).toThrow('Invalid value')
    expect(validateSettingsPatch({ keyboardShortcutOverrides: { 'add-repo': 'Mod+Shift+U' } })).toEqual({
      keyboardShortcutOverrides: { 'add-repo': 'Mod+Shift+U' }
    })
  })

  it('offers every supported terminal palette in the picker', () => {
    expect(TERMINAL_THEME_NAMES.toSorted()).toEqual(Object.keys(TERMINAL_THEMES).toSorted())
  })
})

describe('settings reset response ordering', () => {
  it('does not apply a reset response after a newer settings revision wins', async () => {
    let revision = 8
    const sync = vi.fn()
    const reset = Promise.withResolvers<typeof DEFAULT_SETTINGS>()
    const pending = resetSettingsAtRevision({
      request: { section: 'terminal' },
      revision,
      reset: () => reset.promise,
      currentRevision: () => revision,
      currentSettings: () => ({ ...DEFAULT_SETTINGS, terminalFontSize: 18 }),
      sync
    })

    revision += 1
    reset.resolve(DEFAULT_SETTINGS)

    await expect(pending).resolves.toBe(false)
    expect(sync).not.toHaveBeenCalled()
  })
})


it('accepts its own reset broadcast without overwriting an unrelated newer preference', async () => {
  const sync = vi.fn()
  const current = { ...DEFAULT_SETTINGS, editorMinimap: true }
  await expect(resetSettingsAtRevision({ request: { keys: ['uiScale'] }, revision: 1, reset: async () => DEFAULT_SETTINGS, currentRevision: () => 2, currentSettings: () => current, sync })).resolves.toBe(true)
  expect(sync).not.toHaveBeenCalled()
  expect(current.editorMinimap).toBe(true)
})

it('persists appearance and automation choices and rejects unsupported values', () => {
  const preferences = { recordBrowserHistory: false, externalAgentAccess: false, interfaceFont: 'system', interfaceMotion: 'reduced', interfaceDensity: 'comfortable', navigationLabels: 'labels', toolPanelSide: 'left', browserAutoPreview: false } as const
  const resolved = resolveSettings(preferences)
  expect(resolveSettings(sparseSettings(resolved))).toEqual(resolved)
  expect(resolved).toMatchObject(preferences)
  expect(() => validateSettingsPatch({ interfaceDensity: 'tiny' })).toThrow()
  expect(() => validateSettingsPatch({ interfaceFont: 'unavailable' })).toThrow()
  expect(() => validateSettingsPatch({ interfaceMotion: 'fast' })).toThrow()
  expect(() => validateSettingsPatch({ navigationLabels: 'off' })).toThrow()
  expect(() => validateSettingsPatch({ browserAutoPreview: 'yes' })).toThrow()
})
