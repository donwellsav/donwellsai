import type { AppSettings } from '@shared/types'
import { terminalThemeOf } from '../renderer/src/terminal-themes'

/** ANSI palette order; the index is the value Ghostty's `palette` key expects. */
const ANSI_COLORS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'
] as const

/**
 * Build the Ghostty configuration for a native surface from app settings.
 *
 * The font family is the only free-form value here, so quotes and control
 * characters are stripped and the result is JSON-encoded: a family containing a
 * newline must never become a second configuration line.
 */
export function nativeTerminalConfiguration(settings: AppSettings): string {
  const theme = terminalThemeOf(settings.terminalTheme)
  const font = settings.terminalFontFamily.split(',')[0]!.trim().replace(/^['"]|['"]$/g, '').replace(/[\r\n\0]/g, '') || 'Menlo'
  return [
    `font-family = ${JSON.stringify(font)}`, `font-size = ${settings.terminalFontSize}`,
    `adjust-cell-height = ${Math.round((settings.terminalLineHeight - 1) * 100)}%`,
    `scrollback-limit-lines = ${settings.scrollback}`,
    `copy-on-select = ${settings.copyOnSelect ? 'clipboard' : 'false'}`,
    `cursor-style = ${settings.cursorStyle}`, `cursor-style-blink = ${settings.cursorBlink}`,
    `background = ${theme['background']}`, `foreground = ${theme['foreground']}`,
    `cursor-color = ${theme['cursor']}`, `cursor-text = ${theme['cursorAccent']}`,
    `selection-background = ${theme['selectionBackground']}`,
    ...ANSI_COLORS.map((color, index) => `palette = ${index}=${theme[color]}`),
    'clipboard-read = deny', 'clipboard-write = ask', 'window-padding-x = 0', 'window-padding-y = 0'
  ].join('\n') + '\n'
}
