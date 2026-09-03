import type { TerminalThemeName } from '@shared/types'

/**
 * Terminal ANSI palettes (Orca's terminalTheme setting). `swatch` drives the
 * settings picker preview; `xterm` is the xterm.js ITheme. Every palette
 * carries the same key set so live theme swaps are total.
 */
export const TERMINAL_THEMES: Record<TerminalThemeName, { label: string; swatch: string[]; xterm: Record<string, string> }> = {
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

export const DEFAULT_TERMINAL_THEME: TerminalThemeName = 'tomorrow-night'

export const terminalThemeOf = (name: TerminalThemeName | undefined): Record<string, string> =>
  TERMINAL_THEMES[name ?? DEFAULT_TERMINAL_THEME].xterm
