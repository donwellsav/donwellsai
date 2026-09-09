import { afterEach, expect, it, vi } from 'vitest'
import { createReadStream } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import downloads from '../src/shared/project-tool-downloads.json'
import { AUTOMATIC_TOOL_FILES, installProjectTool } from '../src/main/project-tool-install'
// Run explicitly with the directory of downloaded, pinned archives. Never fetch from the test suite.
const archives = process.env.DONWELLS_TOOL_ARCHIVE_FIXTURE
const roots: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
it.skipIf(!archives || process.platform !== 'darwin' || process.arch !== 'arm64')('extracts the three compatible pinned binaries and rejects unsupported history setup', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'donwells-extract-'))); roots.push(root)
  await expect(installProjectTool('historyBinary', root)).rejects.toThrow('no supported automatic')
  for (const field of ['codeGraphBinary', 'computerBinary', 'backlogBinary'] as const) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(url).toBe(downloads[field].url)
      return new Response(Readable.toWeb(createReadStream(join(archives!, field + '.tgz'))) as ReadableStream)
    }))
    const installed = await installProjectTool(field, root)
    expect(installed.path.endsWith('/' + AUTOMATIC_TOOL_FILES[field])).toBe(true)
    expect((await stat(installed.path)).mode & 0o100).toBe(0o100)
    expect((await readFile(installed.path)).byteLength).toBeGreaterThan(1000)
  }
}, 120000)
