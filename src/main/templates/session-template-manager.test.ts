import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { SessionTemplateManager } from './session-template-manager'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

it('loads valid saved templates when another template file is malformed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'template-recovery-'))
  directories.push(directory)
  await writeFile(join(directory, '00-broken.json'), '{')
  await writeFile(join(directory, 'zz-valid.json'), JSON.stringify({
    id: 'saved-review', name: 'Saved review', description: 'My review', category: 'development',
    systemPrompt: 'Review my changes', env: { REVIEW_MODE: 'local' }
  }))
  const manager = new SessionTemplateManager({ userDir: directory })
  await manager.load()
  expect(manager.get('saved-review')).toMatchObject({ systemPrompt: 'Review my changes', env: { REVIEW_MODE: 'local' } })
  expect(manager.get('code-review')?.builtin).toBe(true)
})
