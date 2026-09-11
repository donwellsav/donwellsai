import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PluginLoader } from '../src/main/plugins/plugin-loader'
import { getPluginRegistry } from '../src/main/plugins/plugin-registry'
import { pluginCommandId } from '../src/shared/plugin-command'

let seq = 0
const nextId = (): string => `r13-consent-${seq++}`

const dirs: string[] = []

function makePluginRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'donwells-plugins-'))
  dirs.push(root)
  return root
}

function writePlugin(root: string, id: string, opts: { invalidManifest?: boolean } = {}): string {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  const manifest: Record<string, unknown> = {
    id,
    name: id,
    version: '1.0.0',
    main: 'index.js',
    type: 'module'
  }
  if (opts.invalidManifest) delete manifest.version
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  const sentinel = join(root, `${id}.sentinel`)
  writeFileSync(
    join(dir, 'index.js'),
    [
      "import { writeFileSync } from 'node:fs'",
      `writeFileSync(${JSON.stringify(sentinel)}, 'imported')`,
      'export function activate(ctx) { ctx.log.info("r13 fixture activated") }',
      'export const commands = { ping: async () => "pong" }'
    ].join('\n')
  )
  return sentinel
}

function activationFile(root: string): string {
  return join(root, '.donwells-activation.json')
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('plugin loader consent-gated activation (R1.3)', () => {
  it('startup does not import disabled plugins', async () => {
    const root = makePluginRoot()
    const id = nextId()
    const sentinel = writePlugin(root, id)

    const loader = new PluginLoader({ pluginDir: root })
    await expect(loader.loadAll()).resolves.toBe(0)

    const views = await loader.list()
    expect(views).toHaveLength(1)
    expect(views[0].manifest.id).toBe(id)
    expect(views[0].enabled).toBe(false)
    expect(views[0].active).toBe(false)
    expect(existsSync(sentinel)).toBe(false)
    expect(getPluginRegistry().getPlugin(id)).toBeUndefined()
  })

  it('enable imports, activates, and persists consent', async () => {
    const root = makePluginRoot()
    const id = nextId()
    const sentinel = writePlugin(root, id)

    const loader = new PluginLoader({ pluginDir: root })
    await loader.enable(id)

    expect(existsSync(sentinel)).toBe(true)
    const views = await loader.list()
    expect(views[0].enabled).toBe(true)
    expect(views[0].active).toBe(true)
    expect(getPluginRegistry().getPlugin(id)).toBeDefined()
    expect(JSON.parse(readFileSync(activationFile(root), 'utf-8'))).toEqual({ enabled: [id] })
    await expect(getPluginRegistry().invokeCommand(pluginCommandId(id, 'ping'))).resolves.toBe('pong')
  })

  it('a fresh loader imports only previously-enabled plugins', async () => {
    const root = makePluginRoot()
    const enabledId = nextId()
    const disabledId = nextId()
    const enabledSentinel = writePlugin(root, enabledId)
    const disabledSentinel = writePlugin(root, disabledId)
    writeFileSync(activationFile(root), JSON.stringify({ enabled: [enabledId] }))

    const loader = new PluginLoader({ pluginDir: root })
    await expect(loader.loadAll()).resolves.toBe(1)
    expect(existsSync(enabledSentinel)).toBe(true)
    expect(existsSync(disabledSentinel)).toBe(false)

    // A second loadAll in the same process treats the active plugin as consent-satisfied.
    await expect(loader.loadAll()).resolves.toBe(1)
  })

  it('disable unregisters commands and revokes consent', async () => {
    const root = makePluginRoot()
    const id = nextId()
    writePlugin(root, id)

    const loader = new PluginLoader({ pluginDir: root })
    await loader.enable(id)
    await loader.disable(id)

    const views = await loader.list()
    expect(views[0].enabled).toBe(false)
    expect(views[0].active).toBe(false)
    expect(getPluginRegistry().getPlugin(id)).toBeUndefined()
    expect(JSON.parse(readFileSync(activationFile(root), 'utf-8'))).toEqual({ enabled: [] })
    await expect(getPluginRegistry().invokeCommand(pluginCommandId(id, 'ping'))).rejects.toThrow(
      'Unknown plugin command'
    )
  })

  it('invalid manifest subdirs are discovered silently and never loaded', async () => {
    const root = makePluginRoot()
    const validId = nextId()
    writePlugin(root, validId)
    writePlugin(root, nextId(), { invalidManifest: true })

    const loader = new PluginLoader({ pluginDir: root })
    const views = await loader.list()
    expect(views).toHaveLength(1)
    expect(views[0].manifest.id).toBe(validId)
    await expect(loader.loadAll()).resolves.toBe(0)
  })

  it('enable of an unknown plugin rejects', async () => {
    const root = makePluginRoot()
    const loader = new PluginLoader({ pluginDir: root })
    await expect(loader.enable('nope-xyz')).rejects.toThrow('Plugin not found: nope-xyz')
  })

  it('missing plugin dir yields empty state', async () => {
    const root = makePluginRoot()
    const loader = new PluginLoader({ pluginDir: join(root, 'does-not-exist') })
    await expect(loader.list()).resolves.toEqual([])
    await expect(loader.loadAll()).resolves.toBe(0)
  })

  it('corrupt activation file treats nothing as enabled', async () => {
    const root = makePluginRoot()
    const id = nextId()
    const sentinel = writePlugin(root, id)
    writeFileSync(activationFile(root), '{not json')

    const loader = new PluginLoader({ pluginDir: root })
    await expect(loader.loadAll()).resolves.toBe(0)
    expect(existsSync(sentinel)).toBe(false)
    const views = await loader.list()
    expect(views[0].enabled).toBe(false)
  })
})
