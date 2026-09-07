import { afterEach, expect, it, vi } from 'vitest'
import { switchAgentMode } from '../src/renderer/src/agent-mode-switch'

afterEach(() => vi.unstubAllGlobals())
it('retains the same switch request identity when a GUI caller retries', async () => {
  const saved = new Map<string, string>()
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => saved.get(key), setItem: (key: string, value: string) => saved.set(key, value) })
  const start = vi.fn(async (workspacePath, sessionId, target, requestId) => ({ workspacePath, sessionId, target, requestId, state: 'completed' }))
  vi.stubGlobal('window', { donwells: { agentSwitchMode: start } })
  await switchAgentMode('/first', 'native-one', 'acp')
  await switchAgentMode('/first', 'native-one', 'acp')
  await switchAgentMode('/second', 'native-one', 'acp')
  expect(start.mock.calls[0]![3]).toBe(start.mock.calls[1]![3])
  expect(start.mock.calls[0]![3]).not.toBe(start.mock.calls[2]![3])
})
