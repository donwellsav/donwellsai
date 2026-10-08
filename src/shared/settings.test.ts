import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN, resolveSettings, steppedTerminalFontSize } from './settings'

describe('terminal font settings', () => {
  it('accepts the OpenType feature and variation syntax the renderer writes out', () => {
    expect(resolveSettings({ terminalFontFeatures: '+ss01, -calt' }).terminalFontFeatures).toBe('+ss01, -calt')
    expect(resolveSettings({ terminalFontFeatures: 'cv01=2' }).terminalFontFeatures).toBe('cv01=2')
    expect(resolveSettings({ terminalFontVariations: 'wght=500, slnt=-10' }).terminalFontVariations).toBe('wght=500, slnt=-10')
    expect(resolveSettings({ terminalFontVariations: 'opsz=14.5' }).terminalFontVariations).toBe('opsz=14.5')
    expect(resolveSettings({ terminalFontFeatures: '  ' }).terminalFontFeatures).toBe('  ')
  })

  it('refuses values that could add a line to the terminal configuration', () => {
    // These are free-form fields, so the line-oriented config they feed is the
    // reason the grammar is this strict.
    expect(() => resolveSettings({ terminalFontFeatures: '+ss01\nclipboard-write = allow' })).toThrow(/Invalid value/)
    expect(() => resolveSettings({ terminalFontFeatures: 'rm -rf /' })).toThrow(/Invalid value/)
    expect(() => resolveSettings({ terminalFontVariations: 'wght=500\nclipboard-write = allow' })).toThrow(/Invalid value/)
    expect(() => resolveSettings({ terminalFontVariations: 'weight=500' })).toThrow(/Invalid value/)
  })

  it('treats ligatures as a boolean and ignores anything else', () => {
    expect(resolveSettings({ terminalLigatures: false }).terminalLigatures).toBe(false)
    expect(() => resolveSettings({ terminalLigatures: 'no' })).toThrow(/Invalid value/)
  })

  it('defaults to ligatures on with no explicit features', () => {
    const defaults = resolveSettings()
    expect(defaults.terminalLigatures).toBe(true)
    expect(defaults.terminalFontFeatures).toBe('')
    expect(defaults.terminalFontVariations).toBe('')
  })
})

describe('terminal font size steps', () => {
  it('steps by one and stays inside the bounds the setting accepts', () => {
    expect(steppedTerminalFontSize(13, 1)).toBe(14)
    expect(steppedTerminalFontSize(13, -1)).toBe(12)
    expect(steppedTerminalFontSize(TERMINAL_FONT_SIZE_MAX, 1)).toBe(TERMINAL_FONT_SIZE_MAX)
    expect(steppedTerminalFontSize(TERMINAL_FONT_SIZE_MIN, -1)).toBe(TERMINAL_FONT_SIZE_MIN)
  })

  it('produces values the setting itself validates', () => {
    for (let step = 0; step < 40; step += 1) {
      const next = steppedTerminalFontSize(TERMINAL_FONT_SIZE_MIN, step)
      expect(resolveSettings({ terminalFontSize: next }).terminalFontSize).toBe(next)
    }
  })

  it('falls back to the default when the current size is unusable', () => {
    expect(steppedTerminalFontSize(Number.NaN, 0)).toBe(DEFAULT_SETTINGS.terminalFontSize)
  })
})
