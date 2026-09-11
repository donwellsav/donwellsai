import { describe, it, expect, beforeEach, vi } from 'vitest'

describe('perf-monitor', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('exports all required functions', async () => {
    const mod = await import('@shared/perf-monitor')
    expect(typeof mod.initPerfMonitor).toBe('function')
    expect(typeof mod.startIpcTimer).toBe('function')
    expect(typeof mod.recordRender).toBe('function')
    expect(typeof mod.getPerfStats).toBe('function')
  })

  it('startIpcTimer returns a function', async () => {
    const { startIpcTimer } = await import('@shared/perf-monitor')
    const finish = startIpcTimer('test.method')
    expect(typeof finish).toBe('function')
    finish()
  })

  it('getPerfStats returns default shape', async () => {
    const { getPerfStats } = await import('@shared/perf-monitor')
    const stats = getPerfStats()
    expect(stats).toHaveProperty('ipcCalls')
    expect(stats).toHaveProperty('ipcAvg')
    expect(stats).toHaveProperty('ipcP95')
    expect(stats).toHaveProperty('renders')
    expect(stats).toHaveProperty('renderAvg')
    expect(stats).toHaveProperty('renderP95')
    expect(stats).toHaveProperty('memoryMB')
  })

  it('records render durations when enabled', async () => {
    const mod = await import('@shared/perf-monitor')
    mod.initPerfMonitor(true)
    mod.recordRender('TestComponent', 50)
    const stats = mod.getPerfStats()
    expect(stats.renders).toBeGreaterThanOrEqual(1)
  })
})
