import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionTemplateManager } from './session-template-manager'
import { logger } from '../../shared/logger'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

it('loads valid saved templates when another template file is malformed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'template-recovery-'))
  const warning = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
  directories.push(directory)
  await writeFile(join(directory, '00-broken.json'), '{')
  await writeFile(join(directory, 'zz-valid.json'), JSON.stringify({
    id: 'saved-review', name: 'Saved review', description: 'My review', category: 'development',
    systemPrompt: 'Review my changes', env: { REVIEW_MODE: 'local' }
  }))
  const manager = new SessionTemplateManager({ userDir: directory })
  await manager.load()
  expect(manager.get('saved-review')).toMatchObject({ systemPrompt: 'Review my changes', env: { REVIEW_MODE: 'local' } })
  expect(warning).toHaveBeenCalledWith(expect.objectContaining({ file: '00-broken.json', err: expect.any(SyntaxError) }), 'session-templates: failed to load user template')
  expect(manager.get('code-review')?.builtin).toBe(true)
})

it('refuses a template id that would write outside the user templates directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'template-id-'))
  directories.push(directory)
  const userDir = join(directory, 'templates')
  const manager = new SessionTemplateManager({ userDir })
  await manager.load()
  await manager.create({ id: 'seed', name: 'Seed', description: '', category: 'development' })

  // A caller-supplied id becomes the file name, so traversal must not name a
  // file beside the templates directory.
  await expect(manager.create({
    id: '../donwells-data', name: 'Escape', description: '', category: 'development'
  })).rejects.toThrow(/Invalid template id/)
  expect(existsSync(join(directory, 'donwells-data.json'))).toBe(false)

  // `delete` resolves through the same guard, so a hostile id can only reach it
  // by arriving in the map, which is what a hand-placed template file does.
  await writeFile(join(userDir, 'planted.json'), JSON.stringify({
    id: '../../donwells-data', name: 'Planted', description: '', category: 'development'
  }))
  const reloaded = new SessionTemplateManager({ userDir })
  await reloaded.load()
  await expect(reloaded.delete('../../donwells-data')).rejects.toThrow(/Invalid template id/)
  expect(existsSync(join(directory, 'donwells-data.json'))).toBe(false)
})

it('generates an id when the caller supplies an empty one', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'template-generated-'))
  directories.push(directory)
  const manager = new SessionTemplateManager({ userDir: directory })
  await manager.load()
  const created = await manager.create({ id: '', name: 'Generated', description: '', category: 'development' })
  expect(created.id).toMatch(/^tmpl-\d+$/)
  expect(existsSync(join(directory, `${created.id}.json`))).toBe(true)
})
