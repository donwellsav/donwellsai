// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { isLegacySessionsProfile } from './workspace-ui-migration'

describe('legacy sessions panel migration', () => {
  it('redirects profiles that had the retired Sessions panel open', () => {
    expect(isLegacySessionsProfile({ rightSidebarTab: 'sessions', rightSidebarOpen: true })).toBe(true)
  })

  it('leaves a closed Sessions panel alone so the saved runs preference survives', () => {
    expect(isLegacySessionsProfile({ rightSidebarTab: 'sessions', rightSidebarOpen: false, runsOpen: false })).toBe(false)
    // Released builds could persist the tab with no recorded open state.
    expect(isLegacySessionsProfile({ rightSidebarTab: 'sessions' })).toBe(false)
  })

  it('ignores current tabs and profiles with no saved UI', () => {
    expect(isLegacySessionsProfile({ rightSidebarTab: 'explorer', rightSidebarOpen: true })).toBe(false)
    expect(isLegacySessionsProfile({ rightSidebarOpen: true, runsOpen: true })).toBe(false)
    expect(isLegacySessionsProfile(undefined)).toBe(false)
  })
})
