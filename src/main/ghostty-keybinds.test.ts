import { describe, expect, it } from 'vitest'
import { ghosttyKeybindCommands } from './ghostty-keybinds'

describe('Ghostty keybind passthrough', () => {
  it('maps Ghostty actions onto app commands in the surface chord format', () => {
    const commands = ghosttyKeybindCommands(
      ['keybind = cmd+t=new_tab', 'keybind = cmd+w=close_surface', 'keybind = cmd+d=new_split:right', 'keybind = cmd+shift+p=toggle_command_palette'].join('\n'),
      'mac'
    )
    expect(commands).toEqual({
      'command+t': 'new-terminal',
      'command+w': 'close-active-pane',
      'command+d': 'split-terminal',
      'command+shift+p': 'command-palette'
    })
  })

  it('accepts Ghostty spellings for modifiers and keys', () => {
    const commands = ghosttyKeybindCommands('keybind = super+shift+arrow_up=new_tab\nkeybind = opt+enter=new_tab', 'mac')
    expect(commands['command+shift+arrowup']).toBe('new-terminal')
    expect(commands['alt+enter']).toBe('new-terminal')
  })

  it('maps numbered tab jumps onto the app commands that exist', () => {
    // The catalog defines select-tab-1 through select-tab-9; anything beyond it
    // must be dropped rather than emit a command the app cannot run.
    const commands = ghosttyKeybindCommands('keybind = cmd+1=goto_tab:1\nkeybind = cmd+9=goto_tab:9\nkeybind = cmd+0=goto_tab:99', 'mac')
    expect(commands['command+1']).toBe('select-tab-1')
    expect(commands['command+9']).toBe('select-tab-9')
    expect(commands['command+0']).toBeUndefined()
  })

  it('leaves terminal-level actions to the embedded surface', () => {
    const commands = ghosttyKeybindCommands(
      ['keybind = cmd+c=copy_to_clipboard', 'keybind = cmd+v=paste_from_clipboard', 'keybind = cmd+a=select_all'].join('\n'),
      'mac'
    )
    expect(commands).toEqual({})
  })

  it('maps the font-size actions, including the punctuation chords they are bound to', () => {
    const commands = ghosttyKeybindCommands(
      [
        'keybind = cmd+plus=increase_font_size:1',
        'keybind = cmd+minus=decrease_font_size:1',
        'keybind = cmd+equal=increase_font_size:2',
        'keybind = cmd+0=reset_font_size'
      ].join('\n'),
      'mac'
    )
    // The surface reports shift+equal for `plus`, so that is the chord it matches.
    expect(commands['command+shift+equal']).toBe('increase-terminal-font-size')
    expect(commands['command+minus']).toBe('decrease-terminal-font-size')
    expect(commands['command+equal']).toBe('increase-terminal-font-size')
    expect(commands['command+0']).toBe('reset-terminal-font-size')
  })

  it('ignores prefixed triggers, comments and unrelated configuration', () => {
    const commands = ghosttyKeybindCommands(
      ['# keybind = cmd+t=new_tab', 'keybind = global:cmd+t=new_tab', 'keybind = cmd+b=new_split:auto', 'font-size = 22'].join('\n'),
      'mac'
    )
    expect(commands).toEqual({ 'command+b': 'split-terminal' })
  })

  it('wires the quick terminal action', () => {
    expect(ghosttyKeybindCommands('keybind = cmd+enter=toggle_quick_terminal', 'mac')['command+enter']).toBe('toggle-quick-terminal')
  })

  it('honours the platform when the same file is used elsewhere', () => {
    expect(ghosttyKeybindCommands('keybind = ctrl+t=new_tab', 'windows')['control+t']).toBe('new-terminal')
  })
})
