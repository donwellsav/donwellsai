import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SETTINGS,
  StaleSettingsDraftError,
  beginSettingsDraft,
  patchFromSettingsDraft,
  resolveSettings
} from '../src/shared/settings'
import type { AppSettings } from '../src/shared/types'
import { useAppStore } from '../src/renderer/src/store'

beforeEach(() => {
  useAppStore.setState({
    settings: structuredClone(DEFAULT_SETTINGS),
    settingsRevision: 0,
    error: null
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('renderer settings synchronization', () => {
  it('does not let an older request response overwrite a newer RPC snapshot', async () => {
    const pending = Promise.withResolvers<AppSettings>()
    vi.stubGlobal('window', {
      donwells: {
        setSettings: () => pending.promise
      }
    })

    const request = useAppStore.getState().setSettings({ terminalFontSize: 16 })
    const rpcSettings = resolveSettings({ terminalFontSize: 18 })
    useAppStore.getState().syncSettings(rpcSettings)
    pending.resolve(resolveSettings({ terminalFontSize: 16 }))
    await request

    expect(useAppStore.getState().settings.terminalFontSize).toBe(18)
  })

  it('invalidates a field draft when settings change externally', () => {
    const state = useAppStore.getState()
    const draft = beginSettingsDraft(state.settings, state.settingsRevision, 'terminalFontFamily')
    draft.value = 'Commit Mono'

    state.syncSettings(resolveSettings({ terminalFontFamily: 'Berkeley Mono' }))

    expect(() => patchFromSettingsDraft(draft, useAppStore.getState().settingsRevision)).toThrow(StaleSettingsDraftError)
  })
})
