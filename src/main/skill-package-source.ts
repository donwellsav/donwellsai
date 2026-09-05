import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { get } from 'node:https'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type {
  ResolvedSkillPackageSource,
  SkillPackageFile,
  SkillPackageFileKind,
  SkillPackageManifest,
  SkillPackageSource
} from '@shared/skill-packages'
import { ProcessExecutionError, runProcess } from '@shared/child-process/run-process'
import { parseSkillPackageManifest } from './skill-package-manifest'

export const MAX_SKILL_PACKAGE_FILES = 256
export const MAX_SKILL_PACKAGE_BYTES = 8 * 1024 * 1024
export const MAX_SKILL_PACKAGE_FILE_BYTES = 2 * 1024 * 1024
export const MAX_HTTPS_SKILL_BYTES = 512 * 1024
const MAX_GIT_TREE_OUTPUT_BYTES = 2 * 1024 * 1024
const GIT_TIMEOUT_MS = 45_000
const FETCH_TIMEOUT_MS = 15_000
const MAX_REDIRECTS = 5
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const INVALID_PATH_CHARACTER = /[<>:"|?*\u0000-\u001f\u007f]/
const SKIPPED_DIRECTORIES: Record<string, true> = { '.git': true, node_modules: true }
const SKIPPED_FILES: Record<string, true> = { '.DS_Store': true }

export type AcquiredSkillPackageFile = SkillPackageFile & { content: Buffer }

export type AcquiredSkillPackage = {
  manifest: SkillPackageManifest
  requestedSource: SkillPackageSource
  source: ResolvedSkillPackageSource
  files: AcquiredSkillPackageFile[]
  totalBytes: number
  warnings: string[]
}

export class SkillPackageSourceError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'SkillPackageSourceError'
  }
}

function pathKind(path: string): SkillPackageFileKind {
  if (path === 'SKILL.md') return 'instructions'
  if (path.startsWith('scripts/')) return 'script'
  if (path.startsWith('references/')) return 'reference'
  if (path.startsWith('assets/')) return 'asset'
  return 'other'
}

export function normalizeSkillPackagePath(input: string): string {
  const normalized = input.replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/') || normalized.endsWith('/') || normalized.length > 512) {
    throw new SkillPackageSourceError(`Unsafe package path: ${input || '(empty)'}`)
  }
  const segments = normalized.split('/')
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || segment.length > 128 || segment.startsWith('-')
      || segment.endsWith('.') || segment.endsWith(' ') || INVALID_PATH_CHARACTER.test(segment)
      || WINDOWS_RESERVED_NAME.test(segment)) {
      throw new SkillPackageSourceError(`Unsafe package path: ${input}`)
    }
  }
  return segments.join('/')
}

export function hashSkillPackageFiles(files: readonly AcquiredSkillPackageFile[]): string {
  const hash = createHash('sha256')
  for (const file of [...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
    hash.update(file.path)
    hash.update('\0')
    hash.update(String(file.bytes))
    hash.update('\0')
    hash.update(file.content)
    hash.update('\0')
  }
  return hash.digest('hex')
}

function decodeSkillMarkdown(content: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content)
  } catch (error) {
    throw new SkillPackageSourceError('SKILL.md must be valid UTF-8 text', { cause: error })
  }
}

function collectPackageDirectory(sourcePath: string): {
  files: AcquiredSkillPackageFile[]
  totalBytes: number
  warnings: string[]
  sourcePath: string
} {
  const absoluteSource = resolve(sourcePath)
  let root: string
  let sourceStat: Stats
  try {
    sourceStat = lstatSync(absoluteSource)
  } catch (error) {
    throw new SkillPackageSourceError(`Skill source does not exist: ${absoluteSource}`, { cause: error })
  }
  if (sourceStat.isSymbolicLink()) throw new SkillPackageSourceError('Skill source must not be a symbolic link')
  if (sourceStat.isFile()) {
    if (basename(absoluteSource).toLowerCase() !== 'skill.md') {
      throw new SkillPackageSourceError('A local skill file must be named SKILL.md')
    }
    root = resolve(absoluteSource, '..')
  } else if (sourceStat.isDirectory()) {
    root = absoluteSource
  } else {
    throw new SkillPackageSourceError('Skill source must be a directory or SKILL.md file')
  }
  root = realpathSync(root)

  const files: AcquiredSkillPackageFile[] = []
  const warnings: string[] = []
  let totalBytes = 0
  const directories = ['']
  while (directories.length > 0) {
    const relativeDirectory = directories.pop()
    if (relativeDirectory === undefined) break
    const directory = relativeDirectory ? join(root, ...relativeDirectory.split('/')) : root
    for (const name of readdirSync(directory).sort()) {
      const packagePath = relativeDirectory ? `${relativeDirectory}/${name}` : name
      const normalizedPath = normalizeSkillPackagePath(packagePath)
      const absolutePath = join(root, ...normalizedPath.split('/'))
      const entry = lstatSync(absolutePath)
      if (entry.isSymbolicLink()) throw new SkillPackageSourceError(`Symbolic links are not allowed in skill packages: ${normalizedPath}`)
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES[name]) {
          warnings.push(`${normalizedPath}/ was excluded from the package plan`)
          continue
        }
        directories.push(normalizedPath)
        continue
      }
      if (SKIPPED_FILES[name]) {
        warnings.push(`${normalizedPath} was excluded from the package plan`)
        continue
      }
      if (!entry.isFile()) throw new SkillPackageSourceError(`Only regular files are allowed in skill packages: ${normalizedPath}`)
      if (entry.size > MAX_SKILL_PACKAGE_FILE_BYTES) {
        throw new SkillPackageSourceError(`${normalizedPath} exceeds the ${MAX_SKILL_PACKAGE_FILE_BYTES}-byte per-file limit`)
      }
      if (files.length >= MAX_SKILL_PACKAGE_FILES) {
        throw new SkillPackageSourceError(`Skill package exceeds the ${MAX_SKILL_PACKAGE_FILES}-file limit`)
      }
      totalBytes += entry.size
      if (totalBytes > MAX_SKILL_PACKAGE_BYTES) {
        throw new SkillPackageSourceError(`Skill package exceeds the ${MAX_SKILL_PACKAGE_BYTES}-byte total limit`)
      }
      const content = readFileSync(absolutePath)
      const after = statSync(absolutePath)
      if (after.size !== entry.size || after.mtimeMs !== entry.mtimeMs || after.ino !== entry.ino) {
        throw new SkillPackageSourceError(`Skill source changed while it was being read: ${normalizedPath}`)
      }
      files.push({
        path: normalizedPath,
        bytes: content.byteLength,
        sha256: createHash('sha256').update(content).digest('hex'),
        kind: pathKind(normalizedPath),
        content
      })
    }
  }
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  if (!files.some((file) => file.path === 'SKILL.md')) {
    throw new SkillPackageSourceError('Skill package root must contain SKILL.md')
  }
  return { files, totalBytes, warnings, sourcePath: root }
}

function validatedHttpsUrl(rawUrl: string, label: string): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch (error) {
    throw new SkillPackageSourceError(`${label} must be a valid HTTPS URL`, { cause: error })
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new SkillPackageSourceError(`${label} must use HTTPS without embedded credentials`)
  }
  url.hash = ''
  return url
}

function fetchHttpsDocument(rawUrl: string, redirects = 0): Promise<{ content: Buffer; finalUrl: string }> {
  const url = validatedHttpsUrl(rawUrl, 'Skill document source')
  if (redirects > MAX_REDIRECTS) return Promise.reject(new SkillPackageSourceError('Skill document source redirected too many times'))
  const { promise, resolve: resolvePromise, reject: rejectPromise } = Promise.withResolvers<{ content: Buffer; finalUrl: string }>()
  {
    let settled = false
    const settle = (action: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      action()
    }
    const request = get(url, { headers: { accept: 'text/markdown,text/plain;q=0.9,*/*;q=0.1', 'accept-encoding': 'identity' } }, (response) => {
      const location = response.headers.location
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && location) {
        response.resume()
        let redirected: URL
        try {
          redirected = validatedHttpsUrl(new URL(location, url).toString(), 'Skill document redirect')
        } catch (error) {
          settle(() => rejectPromise(error))
          return
        }
        settle(() => {
          void fetchHttpsDocument(redirected.toString(), redirects + 1).then(resolvePromise, rejectPromise)
        })
        return
      }
      if (response.statusCode !== 200) {
        response.resume()
        settle(() => rejectPromise(new SkillPackageSourceError(`Skill document request returned HTTP ${response.statusCode ?? 'unknown'}`)))
        return
      }
      const declaredLength = Number(response.headers['content-length'])
      if (Number.isFinite(declaredLength) && declaredLength > MAX_HTTPS_SKILL_BYTES) {
        response.resume()
        settle(() => rejectPromise(new SkillPackageSourceError(`HTTPS skill document exceeds the ${MAX_HTTPS_SKILL_BYTES}-byte limit`)))
        return
      }
      const chunks: Buffer[] = []
      let bytes = 0
      response.on('data', (chunk: Buffer | string) => {
        if (settled) return
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += buffer.byteLength
        if (bytes > MAX_HTTPS_SKILL_BYTES) {
          request.destroy()
          settle(() => rejectPromise(new SkillPackageSourceError(`HTTPS skill document exceeds the ${MAX_HTTPS_SKILL_BYTES}-byte limit`)))
          return
        }
        chunks.push(buffer)
      })
      response.once('end', () => settle(() => resolvePromise({ content: Buffer.concat(chunks), finalUrl: url.toString() })))
      response.once('error', (error) => settle(() => rejectPromise(new SkillPackageSourceError('Skill document response failed', { cause: error }))))
    })
    const timer = setTimeout(() => {
      request.destroy()
      settle(() => rejectPromise(new SkillPackageSourceError(`Skill document request timed out after ${FETCH_TIMEOUT_MS}ms`)))
    }, FETCH_TIMEOUT_MS)
    timer.unref?.()
    request.once('error', (error) => settle(() => rejectPromise(new SkillPackageSourceError('Skill document request failed', { cause: error }))))
  }
  return promise
}

function validateGitRevision(revision: string | undefined): string | undefined {
  const trimmed = revision?.trim()
  if (!trimmed) return undefined
  if (trimmed.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._/@{}+~-]*$/.test(trimmed)) {
    throw new SkillPackageSourceError('Git revision contains unsupported characters')
  }
  return trimmed
}

function validateGitSubpath(subpath: string | undefined): string | undefined {
  const trimmed = subpath?.trim()
  return trimmed ? normalizeSkillPackagePath(trimmed) : undefined
}

async function runGit(cwd: string, home: string, args: readonly string[], maxOutputBytes = 1024 * 1024): Promise<string> {
  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null'
  try {
    const result = await runProcess({
      program: 'git',
      args: ['-c', 'credential.helper=', '-c', `core.hooksPath=${nullDevice}`, ...args],
      cwd,
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'Never',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: nullDevice,
        GIT_ALLOW_PROTOCOL: 'https',
        HOME: home
      },
      executionHost: { kind: 'local' }
    })
    return result.stdout
  } catch (error) {
    if (error instanceof ProcessExecutionError) {
      const detail = error.result?.stderr.trim() || error.result?.stdout.trim() || error.message
      throw new SkillPackageSourceError(`Git source acquisition failed: ${detail}`, { cause: error })
    }
    throw new SkillPackageSourceError('Git source acquisition failed', { cause: error })
  }
}

function validateGitTree(output: string, subpath: string | undefined): void {
  let files = 0
  let bytes = 0
  const prefix = subpath ? `${subpath}/` : ''
  for (const entry of output.split('\0')) {
    if (!entry) continue
    const match = /^(\d{6}) (?:blob|commit) [0-9a-f]+\s+(-|\d+)\t(.+)$/.exec(entry)
    if (!match) throw new SkillPackageSourceError('Git returned an unreadable package tree')
    const mode = match[1]
    const path = match[3]
    if (mode === '120000') throw new SkillPackageSourceError(`Git package contains a symbolic link: ${path}`)
    if (mode === '160000') throw new SkillPackageSourceError(`Git package contains a submodule: ${path}`)
    if (mode !== '100644' && mode !== '100755') throw new SkillPackageSourceError(`Git package contains unsupported file mode ${mode}: ${path}`)
    const relativePath = prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path
    normalizeSkillPackagePath(relativePath)
    const size = Number(match[2])
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SKILL_PACKAGE_FILE_BYTES) {
      throw new SkillPackageSourceError(`Git package file is too large: ${path}`)
    }
    files += 1
    bytes += size
    if (files > MAX_SKILL_PACKAGE_FILES || bytes > MAX_SKILL_PACKAGE_BYTES) {
      throw new SkillPackageSourceError('Git package exceeds the bounded file or byte limit')
    }
  }
  if (files === 0) throw new SkillPackageSourceError('Git package path contains no files')
}

async function acquireGitPackage(source: Extract<SkillPackageSource, { kind: 'git' }>): Promise<AcquiredSkillPackage> {
  const url = validatedHttpsUrl(source.url, 'Git source').toString()
  const revision = validateGitRevision(source.revision)
  const subpath = validateGitSubpath(source.subpath)
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'skill-package-source-'))
  const checkout = join(temporaryRoot, 'repository')
  const home = join(temporaryRoot, 'home')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  try {
    if (revision) {
      mkdirSync(checkout, { mode: 0o700 })
      await runGit(checkout, home, ['init', '--quiet'])
      await runGit(checkout, home, ['remote', 'add', 'origin', url])
      await runGit(checkout, home, ['fetch', '--quiet', '--depth=1', '--no-tags', 'origin', revision])
      await runGit(checkout, home, ['update-ref', 'HEAD', 'FETCH_HEAD'])
    } else {
      await runGit(temporaryRoot, home, ['clone', '--quiet', '--depth=1', '--no-tags', '--single-branch', '--no-checkout', '--', url, checkout])
    }
    const resolvedRevision = (await runGit(checkout, home, ['rev-parse', '--verify', 'HEAD'])).trim()
    if (!/^[0-9a-f]{40,64}$/.test(resolvedRevision)) throw new SkillPackageSourceError('Git source did not resolve to a commit hash')
    const treeArgs = ['ls-tree', '-r', '-z', '-l', 'HEAD']
    if (subpath) treeArgs.push('--', subpath)
    const tree = await runGit(checkout, home, treeArgs, MAX_GIT_TREE_OUTPUT_BYTES)
    validateGitTree(tree, subpath)
    if (subpath) {
      await runGit(checkout, home, ['sparse-checkout', 'set', '--no-cone', '--', subpath])
    }
    await runGit(checkout, home, ['checkout', '--quiet', '--detach', '--force', 'HEAD'])
    const acquired = collectPackageDirectory(subpath ? join(checkout, ...subpath.split('/')) : checkout)
    const markdown = decodeSkillMarkdown(acquired.files.find((file) => file.path === 'SKILL.md')?.content ?? Buffer.alloc(0))
    const manifest = parseSkillPackageManifest(markdown)
    const contentHash = hashSkillPackageFiles(acquired.files)
    return {
      manifest,
      requestedSource: { kind: 'git', url, ...(revision ? { revision } : {}), ...(subpath ? { subpath } : {}) },
      source: {
        kind: 'git',
        location: url,
        ...(revision ? { requestedRevision: revision } : {}),
        revision: resolvedRevision,
        contentHash
      },
      files: acquired.files,
      totalBytes: acquired.totalBytes,
      warnings: acquired.warnings
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

export async function acquireSkillPackage(source: SkillPackageSource): Promise<AcquiredSkillPackage> {
  if (source.kind === 'git') return acquireGitPackage(source)
  if (source.kind === 'https') {
    const fetched = await fetchHttpsDocument(source.url)
    const markdown = decodeSkillMarkdown(fetched.content)
    const manifest = parseSkillPackageManifest(markdown)
    const file: AcquiredSkillPackageFile = {
      path: 'SKILL.md',
      bytes: fetched.content.byteLength,
      sha256: createHash('sha256').update(fetched.content).digest('hex'),
      kind: 'instructions',
      content: fetched.content
    }
    const contentHash = hashSkillPackageFiles([file])
    return {
      manifest,
      requestedSource: { kind: 'https', url: fetched.finalUrl },
      source: {
        kind: 'https',
        location: fetched.finalUrl,
        revision: `sha256:${contentHash}`,
        contentHash
      },
      files: [file],
      totalBytes: file.bytes,
      warnings: ['HTTPS document sources install SKILL.md only. Relative scripts, references, and assets are not acquired; use a local or Git package source for the complete package.']
    }
  }

  const acquired = collectPackageDirectory(source.path)
  const skillFile = acquired.files.find((file) => file.path === 'SKILL.md')
  if (!skillFile) throw new SkillPackageSourceError('Skill package root must contain SKILL.md')
  const manifest = parseSkillPackageManifest(decodeSkillMarkdown(skillFile.content))
  const contentHash = hashSkillPackageFiles(acquired.files)
  return {
    manifest,
    requestedSource: { kind: 'local', path: acquired.sourcePath },
    source: {
      kind: 'local',
      location: acquired.sourcePath,
      revision: `sha256:${contentHash}`,
      contentHash
    },
    files: acquired.files,
    totalBytes: acquired.totalBytes,
    warnings: acquired.warnings
  }
}
