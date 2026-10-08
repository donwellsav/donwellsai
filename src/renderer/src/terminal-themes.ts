import type { TerminalThemeName } from '@shared/types'
import type { GhosttyTheme } from '@shared/native-terminal'

/**
 * The app's own ANSI palette, and the only one left: Ghostty's bundled catalog
 * already ships the palettes this module used to duplicate (Dracula, GitHub
 * Dark, Tomorrow Night) under those exact names - Solarized Dark has no exact
 * counterpart - and a selected Ghostty theme wins over an app palette. This palette therefore only backs the
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
 * Retired app palette names, mapped to the catalog themes that ship the same
 * colours. The app's own copies were duplicates and are gone, but a profile that
 * still names one must keep rendering that palette rather than silently turning
 * into the fallback. `solarized-dark` is the one inexact entry.
 */
export const RETIRED_PALETTE_THEMES: Record<string, string> = {
  dracula: 'Dracula',
  'github-dark': 'GitHub Dark',
  'tomorrow-night': 'Tomorrow Night',
  // No exact "Solarized Dark" ships in the catalog. A near-match is the better
  // failure: the user chose a Solarized dark palette, and handing them the
  // unrelated donwells palette is less honest than the closest variant.
  'solarized-dark': 'Solarized Dark Patched'
}

export function terminalThemeOf(name: TerminalThemeName | undefined, themes: readonly GhosttyTheme[] = []): Record<string, string> {
  const catalogName = name ? RETIRED_PALETTE_THEMES[name] : undefined
  const theme = catalogName ? themes.find((item) => item.name === catalogName) : undefined
  return theme ? ghosttyPaletteOf(theme) : DONWELLS_TERMINAL_PALETTE
}

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
  return chosen ? ghosttyPaletteOf(chosen) : terminalThemeOf(choice.terminalTheme, ghosttyThemes)
}
