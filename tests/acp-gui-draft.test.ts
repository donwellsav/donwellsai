import { expect, it, vi } from 'vitest'
const hooks = vi.hoisted(() => ({ values: [] as unknown[], refs: [] as { current: unknown }[], stateIndex: 0, refIndex: 0, effects: [] as Array<() => void | (() => void)> }))
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect) },
  useState: (initial: unknown) => {
    const index = hooks.stateIndex++
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? initial() : initial
    return [hooks.values[index], (next: unknown) => { hooks.values[index] = typeof next === 'function' ? next(hooks.values[index]) : next }]
  },
  useRef: (initial: unknown) => hooks.refs[hooks.refIndex++] ?? (hooks.refs[hooks.refIndex - 1] = { current: initial })
}))
import { AcpSessions } from '../src/renderer/src/components/runs/AcpSessions'
type Element = { type: unknown; props: Record<string, any> }
function elements(node: any): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  return node?.props ? [node, ...elements(node.props.children)] : []
}
function render() { hooks.effects = []; hooks.stateIndex = hooks.refIndex = 0; return elements(AcpSessions({ workspacePath: '/draft-fixture' })) }
function mount() { hooks.values = [[{ id: 'a' }, { id: 'b' }]]; hooks.refs = []; return render() }
const observation = { snapshot: { id: 'a', state: 'ready', permissions: [] }, requests: [], updates: [], truncated: false }
it('retains pending/uncertain delivery and separates messages by session across remounts', async () => {
  let resolve!: (value: unknown) => void
  const prompt = vi.fn((_path: string, _session: string, _requestId: string, _text: string) => new Promise(done => { resolve = done }))
  vi.stubGlobal('window', { donwells: { agentAcpPrompt: prompt } })
  try {
    let tree = mount()
    tree.find(node => node.type === 'select')!.props.onChange({ target: { value: 'a' } })
    hooks.values[2] = observation
    tree = render()
    tree.find(node => node.type === 'textarea')!.props.onChange({ target: { value: 'retained message' } })
    tree = render()
    tree.find(node => node.type === 'form')!.props.onSubmit({ preventDefault() {} })
    expect(prompt).toHaveBeenCalledTimes(1)
    hooks.refs[0]!.current = false // The sending presentation unmounts while IPC is pending.
    mount()
    expect(hooks.values[3]).toBe('retained message')
    expect(hooks.values[4]).toBe(true)
    resolve({ state: 'uncertain' })
    await Promise.resolve(); await Promise.resolve()
    tree = mount()
    expect(hooks.values[6]).toBe(true)
    Object.assign(window.donwells, {
      agentAcpList: async () => [{ id: 'a' }],
      agentAcpObserve: async () => ({ ...observation, sequence: 1, requests: [{ requestId: prompt.mock.calls[0]![2], state: 'completed' }] })
    })
    const cleanup = hooks.effects[0]!()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(hooks.values[6]).toBe(false)
    expect(hooks.values[3]).toBe('')
    cleanup?.()
    tree.find(node => node.type === 'select')!.props.onChange({ target: { value: 'b' } })
    mount()
    expect(hooks.values[3]).toBe('')
    expect(hooks.values[6]).toBe(false)
    expect(prompt).toHaveBeenCalledTimes(1)
  } finally { vi.unstubAllGlobals() }
})
