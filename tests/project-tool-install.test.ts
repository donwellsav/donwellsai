import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, realpath, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const binaryFixture = vi.hoisted(() => ({ url: 'https://example.invalid/binary', file: 'binary.tgz', bytes: 0, sha256: '', executableSha256: '0'.repeat(64) }))
vi.mock('../src/shared/project-tool-downloads.json', async () => {
  const { createHash } = await import('node:crypto')
  return { default: { codeGraphBinary: binaryFixture, embeddingModel: { url: 'https://example.invalid/pinned-model', file: 'model.gguf', bytes: 5, sha256: createHash('sha256').update('model').digest('hex') } } }
})
import { ProjectDoctor } from '../src/main/project-doctor'
import { installProjectTool } from '../src/main/project-tool-install'
const directories: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
it('installs verified bytes and removes incomplete or mismatched downloads', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'donwells-install-'))); directories.push(root)
  const fetch = vi.fn(async () => new Response('model')); vi.stubGlobal('fetch', fetch)
  const result = await installProjectTool('embeddingModel', root)
  expect(await readFile(result.path, 'utf8')).toBe('model')
  expect(createHash('sha256').update(await readFile(result.path)).digest('hex')).toBe(createHash('sha256').update('model').digest('hex'))
  for (const body of ['wrong', 'too long', 'tiny']) {
    fetch.mockResolvedValueOnce(new Response(body))
    await expect(installProjectTool('embeddingModel', root)).rejects.toThrow()
    expect(await readdir(root)).toHaveLength(1)
  }
  await expect(installProjectTool('../../arbitrary', root)).rejects.toThrow('no supported')
  await expect(installProjectTool('historyBinary', root)).rejects.toThrow('no supported')
  expect(fetch).toHaveBeenCalledTimes(4)
})


it('configures a downloaded component through the existing revision-checked owner', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'donwells-setup-'))); directories.push(root)
  const doctor = new ProjectDoctor(join(root, 'configuration'), async path => ({ path, projectPath: path }), () => ({ disabled: [], referenceRoots: [] }), () => [])
  vi.stubGlobal('fetch', vi.fn(async () => new Response('model')))
  try {
    const before = await doctor.inspect(root)
    const after = await doctor.setup(root, 'embeddingModel', before.revision)
    expect(await readFile(after.configuration.embeddingModel!, 'utf8')).toBe('model')
    await expect(doctor.setup(root, 'embeddingModel', after.revision)).rejects.toThrow('already has a configured path')
    await expect(doctor.setup(root, 'rerankingModel', before.revision)).rejects.toThrow('Configuration changed')
    expect((await doctor.inspect(root)).configuration).toEqual(after.configuration)
  } finally { await doctor.close() }
})

it.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')('rejects a checksum-valid archive containing an incompatible executable', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'donwells-runtime-pin-'))); directories.push(root)
  const files = join(root, 'files'); await mkdir(files)
  await writeFile(join(files, 'codebase-memory-mcp'), 'incompatible executable')
  const archive = join(root, 'binary.tgz')
  execFileSync('/usr/bin/tar', ['-czf', archive, '-C', files, 'codebase-memory-mcp'])
  const bytes = await readFile(archive)
  Object.assign(binaryFixture, { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes)))
  const destination = join(root, 'installed')
  await expect(installProjectTool('codeGraphBinary', destination)).rejects.toThrow('qualified runtime build')
  expect(await readdir(destination)).toEqual([])
})

it.skipIf(!process.env.DONWELLS_VERIFY_TOOL_INSTALL)('installs real document and browser components without path entry', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'donwells-real-install-')))
  // Kept only for the explicit installation acceptance run so native service checks can reuse its output.
  const { default: realDownloads } = await vi.importActual<typeof import('../src/shared/project-tool-downloads.json')>('../src/shared/project-tool-downloads.json')
  const mocked = (await import('../src/shared/project-tool-downloads.json')).default
  Object.assign(mocked, realDownloads)
  const installed: Record<string, string> = {}
  for (const field of ['qmdPackage', 'lancePackage', 'browserPackage', 'browserExecutable']) {
    installed[field] = (await installProjectTool(field, root)).path
    await writeFile(join(root, 'installed.json'), JSON.stringify(installed))
  }
  console.log('Installed tool acceptance artifacts:', root)
}, 15 * 60 * 1000)
