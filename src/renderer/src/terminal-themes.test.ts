// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { GhosttyTheme } from '@shared/native-terminal'
import { ghosttyPaletteOf, resolveTerminalPalette, terminalThemeOf } from './terminal-themes'

const mocha: GhosttyTheme = {
  name: 'Catppuccin Mocha',
  background: '1e1e2e',
  foreground: 'cdd6f4',
  cursor: 'f5e0dc',
  cursorText: '1e1e2e',
  selectionBackground: '585b70',
  palette: { '0': '45475a', '1': 'f38ba8' }
}

describe('terminal palette resolution', () => {
  it('translates a Ghostty theme into the palette shape both renderers read', () => {
    const palette = ghosttyPaletteOf(mocha)
    expect(palette['background']).toBe('#1e1e2e')
    expect(palette['foreground']).toBe('#cdd6f4')
    expect(palette['cursor']).toBe('#f5e0dc')
    expect(palette['cursorAccent']).toBe('#1e1e2e')
    expect(palette['black']).toBe('#45475a')
    expect(palette['red']).toBe('#f38ba8')
  })

  it('falls back to the app palette when no Ghostty theme is chosen', () => {
    expect(resolveTerminalPalette({ terminalTheme: 'donwells' }, [mocha])).toEqual(terminalThemeOf('donwells'))
  })

  it('prefers the chosen Ghostty theme over the app palette', () => {
    const resolved = resolveTerminalPalette({ terminalTheme: 'donwells', terminalGhosttyTheme: 'Catppuccin Mocha' }, [mocha])
    expect(resolved['background']).toBe('#1e1e2e')
    expect(resolved).not.toEqual(terminalThemeOf('donwells'))
  })

  it('ignores a name that is not in the catalog rather than rendering nothing', () => {
    expect(resolveTerminalPalette({ terminalTheme: 'donwells', terminalGhosttyTheme: 'Not A Theme' }, [mocha])).toEqual(terminalThemeOf('donwells'))
  })

  it('uses the app palette when the catalog is unavailable', () => {
    expect(resolveTerminalPalette({ terminalTheme: 'donwells', terminalGhosttyTheme: 'Catppuccin Mocha' }, [])).toEqual(terminalThemeOf('donwells'))
  })

  it('degrades a retired app palette name to the fallback palette', () => {
    // A profile written before the app palettes were folded into Ghostty's
    // catalog can still carry a retired palette name.
    // Without a catalog an unknown or retired name still gets a usable palette.
    expect(terminalThemeOf('tomorrow-night')).toEqual(terminalThemeOf('donwells'))
    // With one, a retired palette resolves to the catalog theme that ships it
    // instead of silently becoming the fallback.
    expect(terminalThemeOf('tomorrow-night', [{ ...mocha, name: 'Tomorrow Night' }])).not.toEqual(terminalThemeOf('donwells'))
    // Solarized Dark has no exact counterpart; the closest variant is used so
    // the choice still means something, and an absent catalog still falls back.
    expect(terminalThemeOf('solarized-dark', [{ ...mocha, name: 'Solarized Dark Patched' }])).not.toEqual(terminalThemeOf('donwells'))
    expect(terminalThemeOf('solarized-dark', [mocha])).toEqual(terminalThemeOf('donwells'))
  })
})
