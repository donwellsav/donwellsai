import { describe, expect, it } from 'vitest'
import { resolveSettings } from './settings'

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
