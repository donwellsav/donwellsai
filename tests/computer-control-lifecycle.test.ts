import { expect, it, vi } from 'vitest'
const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as (() => void | (() => void))[] }))
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect) },
  useId: () => 'control-test',
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => {
    const index = hooks.index++
    if (!(index in hooks.values)) hooks.values[index] = initial
    return [hooks.values[index], (next: unknown) => { hooks.values[index] = typeof next === 'function' ? next(hooks.values[index]) : next }]
  }
}))
import { ComputerControlPanel } from '../src/renderer/src/components/ComputerControlPanel'

it('does not start window discovery after dismissal or overwrite a failed permission check', async () => {
  for (const outcome of ['dismissed', 'failed', 'tool-error', 'success'] as const) {
    let resolve!: (result: unknown) => void
    let reject!: (error: Error) => void
    const call = vi.fn((_path: string, _tool: string, operation: string) => operation === 'permissions'
      ? new Promise((yes, no) => { resolve = yes; reject = no })
      : Promise.resolve({ structuredContent: { windows: [] } }))
    vi.stubGlobal('window', { donwells: { projectToolCall: call } })
    try {
      hooks.index = 0; hooks.values = [true]; hooks.effects = []
      ComputerControlPanel({ workspacePath: '/control-fixture' })
      const cleanup = hooks.effects[1]!()
      expect(call.mock.calls.map(args => args[2])).toEqual(['permissions'])
      if (outcome === 'dismissed') cleanup?.()
      if (outcome === 'failed') reject(new Error('Permissions denied'))
      else resolve({ isError: outcome === 'tool-error', content: [{ type: 'text', text: outcome === 'tool-error' ? 'Permissions denied' : 'Permissions available' }] })
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
      expect(call.mock.calls.map(args => args[2])).toEqual(outcome === 'success' ? ['permissions', 'windows'] : ['permissions'])
      if (outcome === 'failed' || outcome === 'tool-error') expect(hooks.values[2]).toContain('Permissions denied')
      cleanup?.()
    } finally { vi.unstubAllGlobals() }
  }
})
