import qmdLock from '@shared/project-tool-locks/qmdPackage.json'
import lanceLock from '@shared/project-tool-locks/lancePackage.json'
import browserLock from '@shared/project-tool-locks/browserPackage.json'
import { AgentRegistry } from './agents/registry'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { PROJECT_AUTOMATIC_TOOL_FILES as AUTOMATIC_TOOL_FILES } from '@shared/project-doctor'
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, statfs, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import downloads from '@shared/project-tool-downloads.json'
import { runProcess } from '@shared/child-process/run-process'

export async function installProjectTool(field: string, directory: string): Promise<{ path: string; directory: string }> {
  if (!Object.hasOwn(AUTOMATIC_TOOL_FILES, field)) throw new Error('This component has no supported automatic installation recipe')
  const key = field as keyof typeof AUTOMATIC_TOOL_FILES
  const binary = AUTOMATIC_TOOL_FILES[key], metadata = downloads[key]
  if (binary && (process.platform !== 'darwin' || process.arch !== 'arm64')) throw new Error('This pinned binary is qualified only for macOS Apple silicon')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const disk = await statfs(directory)
  if (disk.bavail * disk.bsize < metadata.bytes * 3) throw new Error('Not enough free space to download and extract this component')
  const stage = await mkdtemp(join(directory, `${key}-`))
  try {
    const response = await fetch(metadata.url, { signal: AbortSignal.timeout(15 * 60 * 1000) })
    if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`)
    const packageInstall = ['qmdPackage', 'lancePackage', 'browserPackage'].includes(key)
    const browserInstall = key === 'browserExecutable'
    const archive = join(stage, browserInstall ? 'browser.zip' : binary ? 'download.tar.gz' : metadata.file)
    const file = await open(archive, 'wx', 0o600), hash = createHash('sha256')
    let bytes = 0
    try {
      for await (const chunk of response.body) {
        bytes += chunk.byteLength
        if (bytes > metadata.bytes) throw new Error('Download exceeded the pinned size')
        hash.update(chunk)
        let offset = 0
        while (offset < chunk.byteLength) offset += (await file.write(chunk, offset, chunk.byteLength - offset)).bytesWritten
      }
      await file.sync()
    } finally { await file.close() }
    if (bytes !== metadata.bytes || hash.digest('hex') !== metadata.sha256) throw new Error('Downloaded component failed checksum verification')
    if (!binary) return { path: archive, directory: stage }
    if (packageInstall) {
      const npm = new AgentRegistry().findExecutable('npm')
      if (!npm) throw new Error('Install Node.js to enable automatic package setup, then reopen Donwells. No package paths need to be entered.')
      const lock = key === 'qmdPackage' ? qmdLock : key === 'lancePackage' ? lanceLock : browserLock
      await writeFile(join(stage, 'package.json'), JSON.stringify(lock.packages['']), { mode: 0o600 })
      await writeFile(join(stage, 'package-lock.json'), JSON.stringify(lock), { mode: 0o600 })
      await runProcess({ program: npm, args: ['ci', '--prefix', stage, '--ignore-scripts', '--no-audit', '--no-fund'], timeoutMs: 15 * 60 * 1000, maxOutputBytes: 1024 * 1024 })
      const path = await realpath(join(stage, 'node_modules', binary))
      await rm(archive)
      return { path, directory: stage }
    }
    if (browserInstall) {
      const listing = await runProcess({ program: '/usr/bin/unzip', args: ['-Z1', archive], timeoutMs: 30000, maxOutputBytes: 8 * 1024 * 1024 })
      const entries = listing.stdout.split('\n').filter(Boolean)
      if (entries.length > 30000 || entries.some(path => isAbsolute(path) || path.split('/').includes('..'))) throw new Error('Browser archive contains unsafe or excessive paths')
      await runProcess({ program: '/usr/bin/ditto', args: ['-x', '-k', archive, stage], timeoutMs: 120000, maxOutputBytes: 1024 * 1024 })
      const path = await realpath(join(stage, binary)), hash = createHash('sha256')
      if (!path.startsWith(stage + '/')) throw new Error('Browser executable escaped its installation folder')
      for await (const chunk of createReadStream(path)) hash.update(chunk)
      if (hash.digest('hex') !== 'a596b1cfc6353e987fcec8d71a23a28cd6a9e7a6b4e20b908e4c4fcffe51158e') throw new Error('Browser executable does not match the qualified runtime')
      await rm(archive)
      return { path, directory: stage }
    }
    const listing = await runProcess({ program: '/usr/bin/tar', args: ['-tzf', archive], timeoutMs: 30000, maxOutputBytes: 1024 * 1024 })
    const entries = listing.stdout.split('\n').filter(Boolean)
    if (entries.length > 10000 || entries.some(path => isAbsolute(path) || path.split('/').includes('..'))) throw new Error('Archive contains unsafe or excessive paths')
    const unpacked = join(stage, 'files'); await mkdir(unpacked)
    await runProcess({ program: '/usr/bin/tar', args: ['-xzf', archive, '-C', unpacked], timeoutMs: 60000, maxOutputBytes: 1024 * 1024 })
    const candidates: string[] = [], pending = [unpacked]
    let visited = 0
    while (pending.length) {
      for (const entry of await readdir(pending.pop()!, { withFileTypes: true })) {
        if (++visited > 10000) throw new Error('Extracted component exceeds the inspection limit')
        const path = join(entry.parentPath, entry.name), info = await lstat(path)
        if (info.isSymbolicLink()) throw new Error('Standalone component archive contains a symbolic link')
        if (info.isDirectory()) pending.push(path)
        else if (info.isFile() && entry.name === binary) candidates.push(path)
      }
    }
    if (candidates.length !== 1) throw new Error(`Expected one ${binary} executable; found ${candidates.length}`)
    const path = await realpath(candidates[0]!)
    const executableHash = createHash('sha256')
    for await (const chunk of createReadStream(path)) executableHash.update(chunk)
    if (!('executableSha256' in metadata) || executableHash.digest('hex') !== metadata.executableSha256) throw new Error('Extracted executable does not match the qualified runtime build')
    await chmod(path, 0o700)
    await rm(archive)
    return { path, directory: stage }
  } catch (cause) {
    await rm(stage, { recursive: true, force: true })
    throw cause
  }
}
