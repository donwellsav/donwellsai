import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, rm, readFile, readdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionTemplateManager } from '../src/main/templates/session-template-manager'

describe('SessionTemplateManager', () => {
  let manager: SessionTemplateManager
  let userDir: string

  beforeEach(async () => {
    const base = process.env.TMPDIR || '/tmp'
    userDir = await mkdtemp(join(base, 'donwells-templates-'))
    manager = new SessionTemplateManager({ userDir })
  })

  afterEach(async () => {
    if (userDir) await rm(userDir, { recursive: true, force: true })
  })

  it('loads built-in templates on start', async () => {
    await manager.load()
    const templates = manager.getAll()
    expect(templates.length).toBeGreaterThan(0)
    expect(templates.every(t => t.builtin)).toBe(true)
  })

  it('gets templates by category', async () => {
    await manager.load()
    const dev = manager.getByCategory('development')
    expect(dev.length).toBeGreaterThan(0)
    expect(dev.every(t => t.category === 'development')).toBe(true)
  })

  it('searches templates by name and tags', async () => {
    await manager.load()
    const results = manager.search('code')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].name.toLowerCase()).toContain('code')
  })

  it('creates a user template', async () => {
    await manager.load()
    const template = await manager.create({
      name: 'Custom Workflow',
      description: 'A custom workflow',
      category: 'custom',
      systemPrompt: 'You are a helpful assistant.',
    })

    expect(template.id).toBeDefined()
    expect(template.builtin).toBeUndefined()
    expect(manager.get(template.id)).toBeDefined()

    // Verify it was persisted
    const files = await readdir(userDir)
    expect(files.length).toBe(1)
  })

  it('updates a user template', async () => {
    await manager.load()
    const template = await manager.create({
      name: 'Original',
      description: 'Original description',
      category: 'custom',
    })

    const updated = await manager.update(template.id, { name: 'Updated' })
    expect(updated.name).toBe('Updated')
    expect(manager.get(template.id)!.name).toBe('Updated')
  })

  it('deletes a user template', async () => {
    await manager.load()
    const template = await manager.create({
      name: 'To Delete',
      description: 'Will be deleted',
      category: 'custom',
    })

    await manager.delete(template.id)
    expect(manager.get(template.id)).toBeUndefined()
  })

  it('cannot delete built-in templates', async () => {
    await manager.load()
    await expect(manager.delete('code-review')).rejects.toThrow('built-in')
  })

  it('cannot modify built-in templates', async () => {
    await manager.load()
    await expect(manager.update('code-review', { name: 'Hacked' })).rejects.toThrow('built-in')
  })

  it('creates a session from a template', async () => {
    await manager.load()
    const session = await manager.createSession('code-review')

    expect(session.systemPrompt).toBeDefined()
    expect(session.systemPrompt).toContain('code reviewer')
  })
})
