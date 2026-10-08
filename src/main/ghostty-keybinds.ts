import { appCommand, normalizedChord, parseChord, type AppCommandPlatform } from '@shared/app-commands'

/**
 * Ghostty keybind actions that have an equivalent app command.
 *
 * Everything else is left to Ghostty itself: terminal-level actions such as
 * `copy_to_clipboard`, `paste_from_clipboard` and `select_all` are performed by
 * the embedded surface, so intercepting them here would only duplicate it.
 */
const ACTION_COMMANDS: Readonly<Record<string, string>> = Object.freeze({
  new_tab: 'new-terminal',
  new_window: 'new-terminal',
  close_surface: 'close-active-pane',
  close_tab: 'close-active-pane',
  'new_split:right': 'split-terminal',
  'new_split:down': 'split-terminal',
  'new_split:left': 'split-terminal',
  'new_split:up': 'split-terminal',
  'new_split:auto': 'split-terminal',
  toggle_command_palette: 'command-palette',
  search: 'find'
})

/** `goto_tab:3` maps onto the app's numbered tab commands. */
function actionCommand(action: string): string | undefined {
  const direct = ACTION_COMMANDS[action]
  if (direct) return direct
  // Ghostty accepts an optional step, e.g. `increase_font_size:2`.
  if (/^increase_font_size(?::\d+)?$/.test(action)) return 'increase-terminal-font-size'
  if (/^decrease_font_size(?::\d+)?$/.test(action)) return 'decrease-terminal-font-size'
  if (action === 'reset_font_size') return 'reset-terminal-font-size'
  const tab = /^goto_tab:(\d+)$/.exec(action)
  if (!tab) return undefined
  const command = `select-tab-${tab[1]}`
  return appCommand(command) ? command : undefined
}

/**
 * Read the keybinds a user's own Ghostty configuration defines.
 *
 * A `keybind = cmd+t=new_tab` line is what a Ghostty user reaches for, and
 * since that configuration now applies here, those chords must do something:
 * this returns the subset that maps onto an app command, keyed by the same
 * normalised chord the native surface matches against. Ghostty spells its own
 * triggers (`super`, `opt`, `arrow_up`), which the shared chord parser accepts.
 */
export function ghosttyKeybindCommands(userConfig: string, platform: AppCommandPlatform): Record<string, string> {
  const commands: Record<string, string> = {}
  for (const line of userConfig.split('\n')) {
    const assignment = /^\s*keybind\s*=\s*(.+?)\s*$/.exec(line)
    if (!assignment) continue
    const separator = assignment[1]!.indexOf('=')
    if (separator < 1) continue
    const trigger = assignment[1]!.slice(0, separator).trim()
    const action = assignment[1]!.slice(separator + 1).trim()
    // Prefixed forms (`global:`, `unshift:`, `performable:`) are surface-scoped
    // in Ghostty and have no equivalent here.
    if (trigger.includes(':')) continue
    const command = actionCommand(action)
    if (!command) continue
    // Ghostty's `plus` is what a US layout produces for shift+equal, and the
    // surface reports the unshifted character, so translate before parsing.
    const chord = trigger.split('+').map((part) => part.trim().toLowerCase()).includes('plus')
      ? trigger.replace(/plus/i, 'shift+equal')
      : trigger
    const parsed = parseChord(chord)
    if (!parsed) continue
    commands[normalizedChord(parsed, platform)] = command
  }
  return commands
}
