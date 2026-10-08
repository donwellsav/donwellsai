import { describe, expect, it } from 'vitest'
import { resolveSettings } from '@shared/settings'
import type { AppSettings } from '@shared/types'
import { mergeGhosttyConfig, nativeTerminalConfiguration } from './native-terminal-config'

const settings = (overrides: Partial<AppSettings> = {}): AppSettings => ({ ...resolveSettings(), ...overrides })
const lines = (config: string): string[] => config.trimEnd().split('\n')

describe('native Ghostty configuration', () => {
  it('carries the terminal settings Ghostty applies to a surface', () => {
    const config = nativeTerminalConfiguration(settings({
      terminalFontFamily: 'JetBrains Mono', terminalFontSize: 15, terminalLineHeight: 1.25,
      scrollback: 50000, cursorStyle: 'bar', cursorBlink: false
    }))
    expect(config).toContain('font-family = "JetBrains Mono"')
    expect(config).toContain('font-size = 15')
    expect(config).toContain('adjust-cell-height = 25%')
    expect(config).toContain('scrollback-limit-lines = 50000')
    expect(config).toContain('cursor-style = bar')
    expect(config).toContain('cursor-style-blink = false')
  })

  it('maps copy-on-select to the Ghostty value rather than a boolean', () => {
    expect(nativeTerminalConfiguration(settings({ copyOnSelect: true }))).toContain('copy-on-select = clipboard\n')
    expect(nativeTerminalConfiguration(settings({ copyOnSelect: false }))).toContain('copy-on-select = false\n')
  })

  it('keeps a hostile font family inside one quoted value', () => {
    // 32 lines is the full key set. Plain interpolation instead of JSON encoding
    // would let the embedded newline add a 33rd line, so the count is the guard.
    const config = nativeTerminalConfiguration(settings({ terminalFontFamily: 'Menlo\nclipboard-write = allow\r\0x' }))
    expect(lines(config)).toHaveLength(32)
    expect(lines(config).find((line) => line.startsWith('font-family'))).toBe('font-family = "Menloclipboard-write = allowx"')
    expect(lines(config).filter((line) => line === 'clipboard-write = allow')).toHaveLength(0)
  })

  it('normalises font family quoting, lists and blanks', () => {
    expect(nativeTerminalConfiguration(settings({ terminalFontFamily: '"SF Mono", monospace' }))).toContain('font-family = "SF Mono"')
    expect(nativeTerminalConfiguration(settings({ terminalFontFamily: '   ' }))).toContain('font-family = "Menlo"')
  })

  it('keeps the clipboard defaults that guard the terminal', () => {
    const config = nativeTerminalConfiguration(settings())
    expect(config).toContain('clipboard-read = deny\n')
    expect(config).toContain('clipboard-write = ask\n')
  })

  it('asks for nothing about features when ligatures are on and none are set', () => {
    const emitted = lines(nativeTerminalConfiguration(settings()))
    expect(emitted.filter((line) => line.startsWith('font-feature'))).toHaveLength(0)
    expect(emitted.filter((line) => line.startsWith('font-variation'))).toHaveLength(0)
    expect(emitted).toHaveLength(32)
  })

  it('cannot add a configuration line through features or variations either', () => {
    // A hand-edited profile bypasses settings validation, so the builder defends itself.
    const hostile = 'wght=500\nclipboard-write = allow'
    const config = nativeTerminalConfiguration(settings({ terminalFontFeatures: hostile, terminalFontVariations: hostile }))
    const emitted = lines(config)
    expect(emitted.filter((line) => line === 'clipboard-write = allow')).toHaveLength(0)
    expect(emitted).toHaveLength(34)
    expect(emitted.filter((line) => line.startsWith('clipboard-write'))).toEqual(['clipboard-write = ask'])
  })

  it('disables ligatures through the shared font-feature key', () => {
    expect(nativeTerminalConfiguration(settings({ terminalLigatures: false }))).toContain('font-feature = -liga\n')
  })

  it('merges disabled ligatures with explicit features into one key', () => {
    const config = nativeTerminalConfiguration(settings({ terminalLigatures: false, terminalFontFeatures: '+ss01,cv01=2' }))
    expect(lines(config).filter((line) => line.startsWith('font-feature'))).toEqual(['font-feature = -liga, +ss01, cv01=2'])
  })

  it('emits variation axes on their own key', () => {
    const config = nativeTerminalConfiguration(settings({ terminalFontVariations: 'wght=500, slnt=-10' }))
    expect(lines(config).filter((line) => line.startsWith('font-variation'))).toEqual(['font-variation = wght=500, slnt=-10'])
  })

  it('emits the whole palette with ANSI indices matching the theme', () => {
    const config = nativeTerminalConfiguration(settings({ terminalTheme: 'donwells' }))
    const palette = lines(config).filter((line) => line.startsWith('palette = '))
    expect(palette).toHaveLength(16)
    expect(palette[0]).toBe('palette = 0=#16161d')
    expect(palette[1]).toBe('palette = 1=#e28d89')
    expect(new Set(palette).size).toBe(16)
  })
})

describe('user Ghostty configuration', () => {
  const generated = nativeTerminalConfiguration(settings())

  it('keeps the options the app does not manage', () => {
    const merged = mergeGhosttyConfig('# my notes\nkeybind = cmd+t=new_tab\nmouse-hide-while-typing = true\n', generated)
    expect(merged).toContain('keybind = cmd+t=new_tab')
    expect(merged).toContain('mouse-hide-while-typing = true')
    expect(merged).toContain('# my notes')
  })

  it('drops anything Settings is authoritative for, including themes', () => {
    const merged = mergeGhosttyConfig(
      'font-size = 22\ntheme = Catppuccin Mocha\nbackground = 000000\npalette = 1=ff0000\nwindow-padding-x = 9\nkeybind = cmd+k=clear_screen\n',
      generated
    )
    for (const dropped of ['font-size = 22', 'theme = Catppuccin Mocha', 'background = 000000', 'palette = 1=ff0000', 'window-padding-x = 9']) {
      expect(merged).not.toContain(dropped)
    }
    expect(merged).toContain('keybind = cmd+k=clear_screen')
    // The generated block is unchanged and still authoritative.
    expect(merged).toContain(`font-size = ${settings().terminalFontSize}`)
  })

  it('is a no-op when the user has nothing that applies', () => {
    expect(mergeGhosttyConfig('', generated)).toBe(generated)
    expect(mergeGhosttyConfig('font-size = 22\n\n', generated)).toBe(generated)
  })

  it('cannot smuggle a managed key past the filter with case or spacing', () => {
    const merged = mergeGhosttyConfig('  FONT-SIZE   =  99  \nclipboard-read = allow\n', generated)
    expect(merged).not.toContain('99')
    expect(merged).not.toContain('clipboard-read = allow')
  })
})
