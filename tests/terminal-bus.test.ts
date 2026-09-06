import { describe, expect, it } from 'vitest'
import { TerminalBus } from '../src/renderer/src/terminal-bus'

describe('TerminalBus sequenced handoff', () => {
  it('suspends on contact loss and replaces the snapshot boundary before accepting live output', () => {
    const bus = new TerminalBus(), output: string[] = []
    let lost = 0
    const subscription = bus.subscribe('session', data => output.push(data), () => lost++)
    subscription.acceptSnapshot('before', 2)
    bus.disconnect()
    bus.emitData('session', 'ignored while disconnected', 4)
    expect(lost).toBe(1)
    subscription.prepareSnapshot()
    bus.emitData('session', 'new output', 6)
    subscription.acceptSnapshot('complete snapshot', 5)
    expect(output).toEqual(['before', 'complete snapshot', 'new output'])
    subscription.dispose()
    subscription.acceptSnapshot('late result', 8)
    expect(output).not.toContain('late result')
  })

  it('bounds output waiting for a missing sequence and requires a fresh snapshot', () => {
    const bus = new TerminalBus()
    let lost = 0
    const output: string[] = []
    const subscription = bus.subscribe('session', data => output.push(data), () => lost++)
    subscription.acceptSnapshot('start', 1)
    bus.emitData('session', 'x'.repeat(1024 * 1024 + 1), 3)
    bus.emitData('session', 'late gap', 2)
    expect(lost).toBe(1)
    expect(output).toEqual(['start'])
    subscription.prepareSnapshot()
    subscription.acceptSnapshot('recovered', 3)
    bus.emitData('session', 'live', 4)
    expect(output).toEqual(['start', 'recovered', 'live'])
  })

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
