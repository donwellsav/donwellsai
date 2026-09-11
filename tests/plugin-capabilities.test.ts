import { describe, it, expect, vi, beforeEach } from 'vitest'

const { notificationInstances } = vi.hoisted(() => ({
  notificationInstances: [] as Array<{ options: { title?: string; body?: string }; shown: boolean }>
}))

vi.mock('electron', () => ({
  Notification: class MockNotification {
    options: { title?: string; body?: string }
    shown = false
    static isSupported(): boolean {
      return true
    }
    constructor(options: { title?: string; body?: string }) {
      this.options = options
      notificationInstances.push(this)
    }
    show(): void {
      this.shown = true
    }
  }
}))

import { PluginRegistry, type PluginContext } from '../src/main/plugins/plugin-registry'
import { registerPluginCapabilities } from '../src/main/plugins/app-capabilities'
import { pluginCommandId } from '../src/shared/plugin-command'

type NotificationCapability = (options?: { title?: string; body?: string }) => boolean

interface EventStoreCapability {
  append(event: unknown): Promise<void>
  query(filter?: { sessionId?: string; type?: string; since?: number }): Promise<unknown[]>
}

function makeManifest(id: string, permissions: string[]) {
  return {
    id,
    name: id,
    version: '1.0.0',
    main: 'index.js',
    apiVersion: '1.0.0' as const,
    permissions
  }
}

describe('plugin capabilities (R1.2)', () => {
  let registry: InstanceType<typeof PluginRegistry>
  let fakeStore: { append: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    registry = new PluginRegistry()
    fakeStore = { append: vi.fn(async () => {}), query: vi.fn(async () => []) }
    registerPluginCapabilities(fakeStore as never)
  })

  it('grants notification capability when permitted', async () => {
    notificationInstances.length = 0
    let capability: unknown = undefined
    await registry.load(
      makeManifest('notifier', ['notification']),
      {
        activate: async (ctx: PluginContext) => {
          capability = ctx.getCapability('notification')
        }
      }
    )

    expect(typeof capability).toBe('function')
    const result = (capability as NotificationCapability)({ title: 'Build done', body: 'tests passed' })
    expect(result).toBe(true)
    expect(notificationInstances).toHaveLength(1)
    expect(notificationInstances[0]!.options).toEqual({ title: 'Build done', body: 'tests passed' })
    expect(notificationInstances[0]!.shown).toBe(true)
  })

  it('denies notification when permission not declared', async () => {
    let capability: unknown = 'untouched'
    await registry.load(makeManifest('quiet', []), {
      activate: async (ctx: PluginContext) => {
        capability = ctx.getCapability('notification')
      }
    })
    expect(capability).toBe(null)
  })

  it('event-store capability routes append and query to the backing store', async () => {
    let capability: unknown = undefined
    await registry.load(makeManifest('recorder', ['event-store']), {
      activate: async (ctx: PluginContext) => {
        capability = ctx.getCapability('event-store')
      }
    })

    expect(capability).toBeTruthy()
    const store = capability as EventStoreCapability
    const event = { id: 'e1', type: 'agent:start', sessionId: 's1', ts: 1, payload: {} }
    await store.append(event)
    expect(fakeStore.append).toHaveBeenCalledWith(event)
    await store.query()
    expect(fakeStore.query).toHaveBeenCalledWith({})
    await store.query({ sessionId: 's1' })
    expect(fakeStore.query).toHaveBeenCalledWith({ sessionId: 's1' })
  })

  it('capability gating and command invocation coexist', async () => {
    await registry.load(makeManifest('combo', ['notification']), {
      activate: async () => {},
      commands: {
        ping: async () => 'pong'
      }
    })
    await expect(registry.invokeCommand(pluginCommandId('combo', 'ping'))).resolves.toBe('pong')
  })
})
