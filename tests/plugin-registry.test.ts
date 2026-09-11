import { describe, it, expect, beforeEach } from 'vitest'
import { PluginRegistry, registerAppCapability } from '../src/main/plugins/plugin-registry'
import { pluginCommandId } from '../src/shared/plugin-command'

describe('PluginRegistry', () => {
  let registry: PluginRegistry

  beforeEach(() => {
    registry = new PluginRegistry()
  })

  it('loads and activates a plugin', async () => {
    const manifest = {
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '1.0.0',
      main: 'index.js',
      apiVersion: '1.0.0' as const
    }

    let activated = false
    const module = {
      activate: () => { activated = true }
    }

    await registry.load(manifest, module)
    expect(activated).toBe(true)
    expect(registry.getPlugin('test-plugin')).toBeDefined()
  })

  it('invokes plugin commands', async () => {
    const manifest = {
      id: 'cmd-plugin',
      name: 'Command Plugin',
      version: '1.0.0',
      main: 'index.js',
      apiVersion: '1.0.0' as const
    }

    const module = {
      commands: {
        greet: (name: string) => `Hello, ${name}!`
      }
    }

    await registry.load(manifest, module)
    const result = await registry.invokeCommand('cmd-plugin.greet', 'World')
    expect(result).toBe('Hello, World!')
  })

  it('enforces capability permissions', async () => {
    registerAppCapability('test-cap', { data: 'secret' })

    const manifest = {
      id: 'cap-plugin',
      name: 'Capability Plugin',
      version: '1.0.0',
      main: 'index.js',
      apiVersion: '1.0.0' as const,
      permissions: ['test-cap']
    }

    let capturedCap: unknown = null
    const module = {
      activate: (ctx: { getCapability: (c: string) => unknown }) => {
        capturedCap = ctx.getCapability('test-cap')
      }
    }

    await registry.load(manifest, module)
    expect(capturedCap).toEqual({ data: 'secret' })
  })

  it('denies capabilities not in permissions', async () => {
    registerAppCapability('admin-cap', { data: 'top-secret' })

    const manifest = {
      id: 'denied-plugin',
      name: 'Denied Plugin',
      version: '1.0.0',
      main: 'index.js',
      apiVersion: '1.0.0' as const,
      permissions: ['other-cap']
    }

    let capturedCap: unknown = null
    const module = {
      activate: (ctx: { getCapability: (c: string) => unknown }) => {
        capturedCap = ctx.getCapability('admin-cap')
      }
    }

    await registry.load(manifest, module)
    expect(capturedCap).toBeNull()
  })

  it('unloads plugins and cleans up commands', async () => {
    const manifest = {
      id: 'unload-plugin',
      name: 'Unload Plugin',
      version: '1.0.0',
      main: 'index.js',
      apiVersion: '1.0.0' as const
    }

    let deactivated = false
    const module = {
      deactivate: () => { deactivated = true },
      commands: { foo: () => 'bar' }
    }

    await registry.load(manifest, module)
    await registry.unload('unload-plugin')

    expect(deactivated).toBe(true)
    expect(registry.getPlugin('unload-plugin')).toBeUndefined()
    await expect(registry.invokeCommand('unload-plugin.foo')).rejects.toThrow()
  })

  describe('invoke wire contract (R1.1)', () => {
    it('pluginCommandId composes the registry key format', () => {
      expect(pluginCommandId('rpc', 'run')).toBe('rpc.run')
    })

    it('commands resolve only via the composed pluginId.method id', async () => {
      const manifest = {
        id: 'rpc-plugin',
        name: 'RPC Plugin',
        version: '1.0.0',
        main: 'index.js',
        apiVersion: '1.0.0' as const
      }
      await registry.load(manifest, {
        commands: {
          run: (args: unknown) => ({ echoed: args })
        }
      })

      await expect(registry.invokeCommand(pluginCommandId('rpc-plugin', 'run'), { x: 1 })).resolves.toEqual({
        echoed: { x: 1 }
      })
      await expect(registry.invokeCommand('rpc-plugin')).rejects.toThrow(/Unknown plugin command/)
    })
  })
})
