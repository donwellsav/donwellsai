import { describe, expect, it, vi } from 'vitest'
import type { IpcApi } from '../src/shared/types'

const { invoke, exposed } = vi.hoisted(() => ({
  invoke: vi.fn(),
  exposed: {} as Record<string, unknown>
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown) => {
      exposed[key] = api
    }
  },
  ipcRenderer: {
    invoke,
    on: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn()
  }
}))

describe('preload plugin wire (R1.1/R1.3)', () => {
  it('sends plugin:invoke with the composed commandId and passthrough args', async () => {
    await import('../src/preload/index')
    const api = exposed['donwells'] as Pick<IpcApi, 'pluginInvoke' | 'pluginEnable' | 'pluginDisable'>

    api.pluginInvoke('rpc-plugin', 'run', { x: 1 })
    expect(invoke).toHaveBeenCalledWith('plugin:invoke', 'rpc-plugin.run', { x: 1 })

    invoke.mockClear()
    api.pluginInvoke('rpc-plugin', 'ping')
    expect(invoke).toHaveBeenCalledWith('plugin:invoke', 'rpc-plugin.ping')
  })

  it('routes enable/disable through the plugin:enable and plugin:disable channels', async () => {
    await import('../src/preload/index')
    const api = exposed['donwells'] as Pick<IpcApi, 'pluginEnable' | 'pluginDisable'>

    api.pluginEnable('consent-plugin')
    expect(invoke).toHaveBeenCalledWith('plugin:enable', 'consent-plugin')

    api.pluginDisable('consent-plugin')
    expect(invoke).toHaveBeenCalledWith('plugin:disable', 'consent-plugin')
  })
})

describe('preload autonomous action decision wire (R2.3)', () => {
  it('routes autonomousActionDecide through the autonomous:action-decision channel', async () => {
    await import('../src/preload/index')
    const api = exposed['donwells'] as Pick<IpcApi, 'autonomousActionDecide'>

    api.autonomousActionDecide('act-1', true)
    expect(invoke).toHaveBeenCalledWith('autonomous:action-decision', 'act-1', true)

    invoke.mockClear()
    api.autonomousActionDecide('act-2', false)
    expect(invoke).toHaveBeenCalledWith('autonomous:action-decision', 'act-2', false)
  })
})
