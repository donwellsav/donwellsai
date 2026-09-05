import { describe, expect, it } from 'vitest'
import { TerminalBus } from '../src/renderer/src/terminal-bus'

describe('TerminalBus sequenced handoff', () => {
  it('deduplicates the snapshot boundary and drains out-of-order live data in sequence', () => {
    const bus = new TerminalBus()
    const output: string[] = []
    const subscription = bus.subscribe('session', (data) => output.push(data))

    bus.emitData('session', 'two', 2)
    bus.emitData('session', 'one-duplicate', 1)
    subscription.acceptSnapshot('snapshot-through-one', 1)
    expect(output).toEqual(['snapshot-through-one', 'two'])

    bus.emitData('session', 'four', 4)
    bus.emitData('session', 'three', 3)
    bus.emitData('session', 'three-duplicate', 3)
    expect(output).toEqual(['snapshot-through-one', 'two', 'three', 'four'])
    subscription.dispose()
  })

  it('fails clearly instead of replaying an unsequenced daemon snapshot unsafely', () => {
    const bus = new TerminalBus()
    const subscription = bus.subscribe('old-session', () => {})
    expect(() => subscription.acceptSnapshot('ambiguous replay')).toThrow(/upgrade required/)
    subscription.dispose()
  })

})
