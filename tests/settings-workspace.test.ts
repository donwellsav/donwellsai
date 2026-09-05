import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, validateSettingsPatch } from '../src/shared/settings'
import { resetSettingsAtRevision, searchSettingsCatalog } from '../src/renderer/src/settings-workspace'
import { TERMINAL_THEMES, TERMINAL_THEME_NAMES } from '../src/renderer/src/terminal-themes'

describe('settings workspace catalog', () => {
  it('finds actual application commands and fixed privacy capabilities', () => {
    expect(searchSettingsCatalog('Quick Open').map((group) => group.section.id)).toEqual(['shortcuts'])
    expect(searchSettingsCatalog('credential').map((group) => group.section.id)).toEqual(['privacy'])
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
      sync
    })

    revision += 1
    reset.resolve(DEFAULT_SETTINGS)

    await expect(pending).resolves.toBe(false)
    expect(sync).not.toHaveBeenCalled()
  })
})
