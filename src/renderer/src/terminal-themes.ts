import type { TerminalThemeName } from '@shared/types'
import type { GhosttyTheme } from '@shared/native-terminal'

/**
 * The app's own ANSI palette, and the only one left: Ghostty's bundled catalog
 * already ships the palettes this module used to duplicate (Dracula, GitHub
 * Dark, Tomorrow Night, Solarized Dark) under those names, and a selected
 * Ghostty theme wins over an app palette. This palette therefore only backs the
 * blank/xterm path, where no Ghostty theme is chosen.
 */
export const DONWELLS_TERMINAL_PALETTE: Record<string, string> = {
  background: '#16161d',
  foreground: '#e8e5e1',
  cursor: '#e8e5e1',
  cursorAccent: '#16161d',
  selectionBackground: '#35353f',
  black: '#16161d',
  brightBlack: '#8b8796',
  red: '#e28d89',
  green: '#a9bd8c',
  yellow: '#d6b985',
  blue: '#94abc8',
  magenta: '#bba4cb',
  cyan: '#8ebcbc',
  white: '#e8e5e1',
  brightRed: '#efa6a2',
  brightGreen: '#bfd2a5',
  brightYellow: '#e7cca0',
  brightBlue: '#adc2dc',
  brightMagenta: '#d0b9df',
  brightCyan: '#a9d3d3',
  brightWhite: '#faf9f6'
}

export const DEFAULT_TERMINAL_THEME: TerminalThemeName = 'donwells'

/**
 * A profile written before the app palettes were folded into Ghostty's catalog
 * can still name a retired palette; every app palette name now resolves to the
 * one fallback palette so the xterm path always gets colors.
 */
export const terminalThemeOf = (_name: TerminalThemeName | undefined): Record<string, string> =>
  DONWELLS_TERMINAL_PALETTE

/** ANSI palette order shared with the native configuration builder. */
const ANSI_ORDER = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'
] as const

/**
 * Convert one of Ghostty's themes into the palette shape both renderers read.
 * Ghostty stores bare `RRGGBB`; the app's palettes carry the `#`.
 */
export function ghosttyPaletteOf(theme: GhosttyTheme): Record<string, string> {
  const palette: Record<string, string> = {
    background: `#${theme.background}`,
    foreground: `#${theme.foreground}`,
    cursor: `#${theme.cursor ?? theme.foreground}`,
    cursorAccent: `#${theme.cursorText ?? theme.background}`,
    selectionBackground: `#${theme.selectionBackground ?? theme.foreground}`
  }
  for (const [index, color] of Object.entries(theme.palette)) {
    const name = ANSI_ORDER[Number(index)]
    if (name) palette[name] = `#${color}`
  }
  return palette
}

/**
 * The palette a terminal actually renders with: a chosen Ghostty theme when one
 * is selected, otherwise the app's own palette. The native surface and the
 * xterm fallback both read this, so a theme looks the same either way.
 */
export function resolveTerminalPalette(
  choice: { terminalTheme?: TerminalThemeName; terminalGhosttyTheme?: string },
  ghosttyThemes: readonly GhosttyTheme[]
): Record<string, string> {
  const chosen = choice.terminalGhosttyTheme
    ? ghosttyThemes.find((theme) => theme.name === choice.terminalGhosttyTheme)
    : undefined
  return chosen ? ghosttyPaletteOf(chosen) : terminalThemeOf(choice.terminalTheme)
}
