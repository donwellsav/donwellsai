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

describe('preload plugin invoke wire (R1.1)', () => {
  it('sends plugin:invoke with the composed commandId and passthrough args', async () => {
    await import('../src/preload/index')
    const api = exposed['donwells'] as Pick<IpcApi, 'pluginInvoke'>

    api.pluginInvoke('rpc-plugin', 'run', { x: 1 })
    expect(invoke).toHaveBeenCalledWith('plugin:invoke', 'rpc-plugin.run', { x: 1 })

    invoke.mockClear()
    api.pluginInvoke('rpc-plugin', 'ping')
    expect(invoke).toHaveBeenCalledWith('plugin:invoke', 'rpc-plugin.ping')
  })
})
