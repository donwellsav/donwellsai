import { describe, expect, it } from 'vitest'
import { RendererCommandRouter } from '../src/main/renderer-command-router'

function rendererTarget() {
  const requests: string[] = []
  const target = {
    isDestroyed: () => false,
    send(_channel: string, message: unknown) {
      if (!message || typeof message !== 'object' || !('id' in message) || typeof message.id !== 'string') throw new Error('Invalid command envelope')
      requests.push(message.id)
    }
  }
  return { target, requests }
}

describe('renderer command lifecycle', () => {
  it('keeps a cold-start request queued through initial navigation and unrelated readiness', async () => {
    const { target, requests } = rendererTarget()
    const router = new RendererCommandRouter(() => target)
    const pending = router.call('ui:command', { op: 'state' })
    const result = expect(pending).resolves.toEqual({ ready: true })
    router.reset(new Error('Initial navigation'), true)
    router.ready('browser:command', target)
    expect(requests).toEqual([])
    router.ready('ui:command', target)
    expect(requests).toHaveLength(1)
    router.resolve('ui:command', requests[0]!, { ok: true, result: { ready: true } }, target)
    await result
  })

  it('rejects dispatched work on reload and ignores replies from the previous renderer', async () => {
    const first = rendererTarget()
    const second = rendererTarget()
    let current = first.target
    const router = new RendererCommandRouter(() => current)
    router.bind(first.target)
    router.ready('ui:command', first.target)
    const oldResult = expect(router.call('ui:command', { op: 'state' })).rejects.toThrow('Reloaded')
    router.reset(new Error('Reloaded'), true)
    await oldResult
    current = second.target
    const pending = router.call('ui:command', { op: 'state' })
    let settled = false
    void pending.then(() => { settled = true }, () => { settled = true })
    router.ready('ui:command', first.target)
    expect(second.requests).toEqual([])
    router.ready('ui:command', second.target)
    router.resolve('ui:command', second.requests[0]!, { ok: true, result: 'stale' }, first.target)
    await Promise.resolve()
    expect(settled).toBe(false)
    router.resolve('ui:command', second.requests[0]!, { ok: true, result: 'current' }, second.target)
    await expect(pending).resolves.toBe('current')
  })
})
