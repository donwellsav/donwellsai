import { describe, expect, it } from 'vitest'
import { resolveSettings } from '@shared/settings'
import type { AppSettings } from '@shared/types'
import { nativeTerminalConfiguration } from './native-terminal-config'

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

  it('emits the whole palette with ANSI indices matching the theme', () => {
    const config = nativeTerminalConfiguration(settings({ terminalTheme: 'donwells' }))
    const palette = lines(config).filter((line) => line.startsWith('palette = '))
    expect(palette).toHaveLength(16)
    expect(palette[0]).toBe('palette = 0=#16161d')
    expect(palette[1]).toBe('palette = 1=#e28d89')
    expect(new Set(palette).size).toBe(16)
  })
})
