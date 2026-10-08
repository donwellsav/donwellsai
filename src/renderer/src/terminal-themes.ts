import type { TerminalThemeName } from '@shared/types'
import type { GhosttyTheme } from '@shared/native-terminal'

/**
 * Terminal ANSI palettes. `swatch` drives the settings picker preview; `xterm`
 * is the xterm.js ITheme. Every palette carries the same key set for total live swaps.
 */
export const TERMINAL_THEMES: Record<TerminalThemeName, { label: string; swatch: string[]; xterm: Record<string, string> }> = {
  donwells: {
    label: 'Donwells',
    swatch: ['#16161d', '#e28d89', '#a9bd8c', '#94abc8', '#d6b985'],
    xterm: {
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
  },
  'tomorrow-night': {
    label: 'Tomorrow Night',
    swatch: ['#1d1f21', '#cc6666', '#b5bd68', '#81a2be', '#f0c674'],
    xterm: {
      background: '#1d1f21',
      foreground: '#c5c8c6',
      cursor: '#f2f2f2',
      cursorAccent: '#1d1f21',
      selectionBackground: '#373b41',
      black: '#1d1f21',
      brightBlack: '#969896',
      red: '#cc6666',
      green: '#b5bd68',
      yellow: '#f0c674',
      blue: '#81a2be',
      magenta: '#b294bb',
      cyan: '#8abeb7',
      white: '#c5c8c6',
      brightRed: '#d54e53',
      brightGreen: '#b9ca4a',
      brightYellow: '#e7c547',
      brightBlue: '#7aa6da',
      brightMagenta: '#c397d8',
      brightCyan: '#70c0b1',
      brightWhite: '#eaeaea'
    }
  },
  dracula: {
    label: 'Dracula',
    swatch: ['#282a36', '#ff5555', '#50fa7b', '#bd93f9', '#f1fa8c'],
    xterm: {
      background: '#282a36',
      foreground: '#f8f8f2',
      cursor: '#f8f8f0',
      cursorAccent: '#282a36',
      selectionBackground: '#44475a',
      black: '#21222c',
      brightBlack: '#6272a4',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#bd93f9',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#f8f8f2',
      brightRed: '#ff6e6e',
      brightGreen: '#69ff94',
      brightYellow: '#ffffa5',
      brightBlue: '#d6acff',
      brightMagenta: '#ff92df',
      brightCyan: '#a4ffff',
      brightWhite: '#ffffff'
    }
  },
  'solarized-dark': {
    label: 'Solarized Dark',
    swatch: ['#002b36', '#dc322f', '#859900', '#268bd2', '#b58900'],
    xterm: {
      background: '#002b36',
      foreground: '#93a1a1',
      cursor: '#93a1a1',
      cursorAccent: '#002b36',
      selectionBackground: '#073642',
      black: '#002b36',
      brightBlack: '#586e75',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightRed: '#cb4b16',
      brightGreen: '#586e75',
      brightYellow: '#657b83',
      brightBlue: '#839496',
      brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1',
      brightWhite: '#fdf6e3'
    }
  },
  'github-dark': {
    label: 'GitHub Dark',
    swatch: ['#0d1117', '#ff7b72', '#3fb950', '#58a6ff', '#d29922'],
    xterm: {
      background: '#0d1117',
      foreground: '#c9d1d9',
      cursor: '#c9d1d9',
      cursorAccent: '#0d1117',
      selectionBackground: '#264f78',
      black: '#484f58',
      brightBlack: '#6e7681',
      red: '#ff7b72',
      green: '#3fb950',
      yellow: '#d29922',
      blue: '#58a6ff',
      magenta: '#bc8cff',
      cyan: '#39c5cf',
      white: '#b1bac4',
      brightRed: '#ffa198',
      brightGreen: '#56d364',
      brightYellow: '#e3b341',
      brightBlue: '#79c0ff',
      brightMagenta: '#d2a8ff',
      brightCyan: '#56d4dd',
      brightWhite: '#f0f6fc'
    }
  }
}

export const TERMINAL_THEME_NAMES: readonly TerminalThemeName[] = Object.freeze<TerminalThemeName[]>([
  'donwells',
  'tomorrow-night',
  'dracula',
  'solarized-dark',
  'github-dark'
])

export const DEFAULT_TERMINAL_THEME: TerminalThemeName = 'donwells'

export const terminalThemeOf = (name: TerminalThemeName | undefined): Record<string, string> =>
  TERMINAL_THEMES[name ?? DEFAULT_TERMINAL_THEME].xterm

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
