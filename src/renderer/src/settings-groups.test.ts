// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { SETTINGS_METADATA } from '@shared/settings'
import { TERMINAL_SETTING_GROUPS } from './settings-groups'

describe('terminal settings coverage', () => {
  it('renders every setting the schema defines for the terminal section', () => {
    const grouped = new Set(TERMINAL_SETTING_GROUPS.flatMap(([, keys]) => keys))
    const missing = SETTINGS_METADATA.filter((item) => item.section === 'terminal' && !grouped.has(item.key)).map((item) => item.key)
    expect(missing).toEqual([])
  })

  it('groups nothing that is not a terminal setting, and lists each once', () => {
    const terminal = new Set<string>(SETTINGS_METADATA.filter((item) => item.section === 'terminal').map((item) => item.key))
    const listed = TERMINAL_SETTING_GROUPS.flatMap(([, keys]) => keys)
    expect(listed.filter((key) => !terminal.has(key))).toEqual([])
    expect(listed.length).toBe(new Set(listed).size)
  })
})
