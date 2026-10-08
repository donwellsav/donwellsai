/**
 * How the Terminal settings section is grouped.
 *
 * Sections render from a curated list rather than from the schema, so a setting
 * can exist in `SETTING_DEFINITIONS` and never appear in the UI - which happened
 * twice while the terminal renderer was built. Keeping the list here, free of
 * React, lets a test assert that every terminal setting is rendered somewhere.
 */
export const TERMINAL_SETTING_GROUPS: readonly (readonly [string, readonly string[]])[] = [
  ['Terminal surface', ['terminalRenderer', 'terminalUseGhosttyConfig']],
  ['Text', ['terminalFontFamily', 'terminalFontSize', 'terminalFontWeight', 'terminalLigatures', 'terminalFontFeatures', 'terminalFontVariations', 'terminalLineHeight']],
  ['Colors and cursor', ['terminalTheme', 'terminalGhosttyTheme', 'cursorStyle', 'cursorBlink']],
  ['Behavior', ['scrollback', 'copyOnSelect']]
]
