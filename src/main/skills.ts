import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  InstalledSkillPackage,
  LegacySkillDocument,
  ResolvedSkillPackageSource,
  SkillPackageApplyRequest,
  SkillPackageConflict,
  SkillPackageFile,
  SkillPackageFileKind,
  SkillPackageHealth,
  SkillPackageIdentityRequest,
  SkillPackageManifest,
  SkillPackageMutationResult,
  SkillPackagePlan,
  SkillPackagePlanFile,
  SkillPackagePrepareRequest,
  SkillPackageReadRequest,
  SkillPackageReadResult,
  SkillPackagesListRequest,
  SkillPackagesListResult,
  SkillPackageSource,
  SkillPackageTarget
} from '@shared/skill-packages'
import { SKILL_PACKAGE_PROVIDERS, skillPackageProvider } from '@shared/skill-packages'
import {
  MAX_SKILL_PACKAGE_FILE_BYTES,
  acquireSkillPackage,
  normalizeSkillPackagePath
} from './skill-package-source'
import type { AcquiredSkillPackage } from './skill-package-source'

const REGISTRY_SCHEMA_VERSION = 1
const REGISTRY_FILE = 'skill-packages-v1.json'
const LEGACY_DIRECTORY = 'skills'
const LEGACY_INDEX = '_index.json'
const MAX_LEGACY_DOCUMENTS = 200
const MAX_LEGACY_INDEX_BYTES = 1024 * 1024
const MAX_READ_PREVIEW_BYTES = 256 * 1024
const MAX_TARGET_ENTRIES = 1024
const PLAN_TTL_MS = 10 * 60 * 1000
const MAX_PENDING_PLANS = 12
const SHA256 = /^[0-9a-f]{64}$/
const PACKAGE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export type ResolveSkillPackageWorkspace = (requestedPath: string) => Promise<string> | string

export type SkillPackagesManagerOptions = {
  resolveWorkspace: ResolveSkillPackageWorkspace
  now?: () => number
}

export type SkillPackageLifecycleErrorCode =
  | 'invalid-request'
  | 'unauthorized-workspace'
  | 'registry-corrupt'
  | 'package-not-found'
  | 'plan-not-found'
  | 'plan-expired'
  | 'plan-blocked'
  | 'plan-stale'
  | 'unsafe-path'

export class SkillPackageLifecycleError extends Error {
  readonly code: SkillPackageLifecycleErrorCode

  constructor(code: SkillPackageLifecycleErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'SkillPackageLifecycleError'
    this.code = code
  }
}

type StoredSkillPackage = {
  manifest: SkillPackageManifest
  source: SkillPackageSource
  resolvedSource: ResolvedSkillPackageSource
  workspacePath: string
  providerId: SkillPackageTarget['providerId']
  consumerRoot: string
  files: SkillPackageFile[]
  totalBytes: number
  installedAt: string
  updatedAt: string
}

type SkillPackageRegistry = {
  schemaVersion: typeof REGISTRY_SCHEMA_VERSION
  packages: StoredSkillPackage[]
}

type RegistrySnapshot = {
  registry: SkillPackageRegistry
  fingerprint: string
}

type TargetFile = {
  path: string
  type: 'file' | 'symlink' | 'other'
  bytes: number
  sha256?: string
  fingerprint: string
}

type TargetSnapshot = {
  exists: boolean
  files: TargetFile[]
  fingerprint: string
  unsafe?: string
}

type PackageInspection = {
  health: SkillPackageHealth
  issues: string[]
  snapshot: TargetSnapshot
}

type PendingPlan = {
  plan: SkillPackagePlan
  requestedWorkspacePath: string
  registryFingerprint: string
  targetFingerprint: string
  acquired?: AcquiredSkillPackage
  existing?: StoredSkillPackage
}

function normalizePackageName(name: string): string {
  const trimmed = name.trim()
  if (!PACKAGE_NAME.test(trimmed) || trimmed.length > 64) {
    throw new SkillPackageLifecycleError('invalid-request', 'Skill package name is invalid')
  }
  return trimmed
}

function assertSource(value: unknown, code: SkillPackageLifecycleErrorCode = 'invalid-request'): SkillPackageSource {
  const message = code === 'registry-corrupt'
    ? 'Skill package registry contains an invalid source'
    : 'Skill package source is invalid'
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SkillPackageLifecycleError(code, message)
  }
  const source = value as Record<string, unknown>
  if (source.kind === 'local' && typeof source.path === 'string' && source.path.trim()) {
    return { kind: 'local', path: source.path.trim() }
  }
  if (source.kind === 'https' && typeof source.url === 'string' && source.url.trim()) {
    return { kind: 'https', url: source.url.trim() }
  }
  if (source.kind === 'git' && typeof source.url === 'string' && source.url.trim()
    && (source.revision === undefined || typeof source.revision === 'string')
    && (source.subpath === undefined || typeof source.subpath === 'string')) {
    return {
      kind: 'git',
      url: source.url.trim(),
      ...(typeof source.revision === 'string' && source.revision.trim() ? { revision: source.revision.trim() } : {}),
      ...(typeof source.subpath === 'string' && source.subpath.trim() ? { subpath: source.subpath.trim() } : {})
    }
  }
  throw new SkillPackageLifecycleError(code, message)
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function fileKind(path: string): SkillPackageFileKind {
  if (path === 'SKILL.md') return 'instructions'
  if (path.startsWith('scripts/')) return 'script'
  if (path.startsWith('references/')) return 'reference'
  if (path.startsWith('assets/')) return 'asset'
  return 'other'
}

function pathIsInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function safeTokenMatch(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected)
  const actualBytes = Buffer.from(actual)
  return expectedBytes.byteLength === actualBytes.byteLength && timingSafeEqual(expectedBytes, actualBytes)
}

function resolvedSourceFromStored(value: unknown): ResolvedSkillPackageSource {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SkillPackageLifecycleError('registry-corrupt', 'Skill package registry contains an invalid resolved source')
  }
  const source = value as Record<string, unknown>
  if ((source.kind !== 'local' && source.kind !== 'https' && source.kind !== 'git')
    || typeof source.location !== 'string' || typeof source.revision !== 'string'
    || typeof source.contentHash !== 'string' || !SHA256.test(source.contentHash)
    || (source.requestedRevision !== undefined && typeof source.requestedRevision !== 'string')) {
    throw new SkillPackageLifecycleError('registry-corrupt', 'Skill package registry contains an invalid resolved source')
  }
  return {
    kind: source.kind,
    location: source.location,
    ...(typeof source.requestedRevision === 'string' && source.requestedRevision ? { requestedRevision: source.requestedRevision } : {}),
    revision: source.revision,
    contentHash: source.contentHash
  }
}

function manifestFromStored(value: unknown): SkillPackageManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SkillPackageLifecycleError('registry-corrupt', 'Skill package registry contains an invalid manifest')
  }
  const manifest = value as Record<string, unknown>
  if (typeof manifest.name !== 'string' || typeof manifest.description !== 'string') {
    throw new SkillPackageLifecycleError('registry-corrupt', 'Skill package registry contains an invalid manifest')
  }
  let name: string
  try {
    name = normalizePackageName(manifest.name)
  } catch (error) {
    throw new SkillPackageLifecycleError('registry-corrupt', 'Skill package registry contains an invalid package name', { cause: error })
  }
  if (!manifest.description || manifest.description.length > 1024) {
    throw new SkillPackageLifecycleError('registry-corrupt', 'Skill package registry contains an invalid description')
  }
  for (const field of ['version', 'license', 'compatibility']) {
    if (manifest[field] !== undefined && typeof manifest[field] !== 'string') {
      throw new SkillPackageLifecycleError('registry-corrupt', `Skill package registry contains an invalid ${field}`)
    }
  }
  return {
    name,
    description: manifest.description,
    ...(typeof manifest.version === 'string' ? { version: manifest.version } : {}),
    ...(typeof manifest.license === 'string' ? { license: manifest.license } : {}),
    ...(typeof manifest.compatibility === 'string' ? { compatibility: manifest.compatibility } : {})
  }
}

function filesFromStored(value: unknown): SkillPackageFile[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    throw new SkillPackageLifecycleError('registry-corrupt', 'Skill package registry contains an invalid file list')
  }
  const files: SkillPackageFile[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new SkillPackageLifecycleError('registry-corrupt', 'Skill package registry contains invalid file metadata')
    }
    const candidate = item as Record<string, unknown>
    if (typeof candidate.path !== 'string' || typeof candidate.bytes !== 'number'
      || !Number.isSafeInteger(candidate.bytes) || candidate.bytes < 0 || candidate.bytes > MAX_SKILL_PACKAGE_FILE_BYTES
      || typeof candidate.sha256 !== 'string' || !SHA256.test(candidate.sha256)
      || (candidate.kind !== 'instructions' && candidate.kind !== 'script' && candidate.kind !== 'reference'
        && candidate.kind !== 'asset' && candidate.kind !== 'other')) {
      throw new SkillPackageLifecycleError('registry-corrupt', 'Skill package registry contains invalid file metadata')
    }
    let path: string
    try {
      path = normalizeSkillPackagePath(candidate.path)
    } catch (error) {
      throw new SkillPackageLifecycleError('registry-corrupt', 'Skill package registry contains an unsafe file path', { cause: error })
    }
    if (seen.has(path)) throw new SkillPackageLifecycleError('registry-corrupt', `Skill package registry duplicates ${path}`)
    seen.add(path)
    files.push({ path, bytes: candidate.bytes, sha256: candidate.sha256, kind: candidate.kind })
  }
  if (!files.some((file) => file.path === 'SKILL.md')) {
    throw new SkillPackageLifecycleError('registry-corrupt', 'Skill package registry omits SKILL.md')
  }
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}

function storedPackageFromUnknown(value: unknown): StoredSkillPackage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SkillPackageLifecycleError('registry-corrupt', 'Skill package registry contains an invalid package record')
  }
  const record = value as Record<string, unknown>
  if (typeof record.workspacePath !== 'string' || !isAbsolute(record.workspacePath)
    || typeof record.providerId !== 'string' || typeof record.consumerRoot !== 'string'
    || typeof record.totalBytes !== 'number' || !Number.isSafeInteger(record.totalBytes) || record.totalBytes < 0
    || typeof record.installedAt !== 'string' || typeof record.updatedAt !== 'string') {
    throw new SkillPackageLifecycleError('registry-corrupt', 'Skill package registry contains an invalid package record')
  }
  const provider = SKILL_PACKAGE_PROVIDERS.find((candidate) => candidate.id === record.providerId)
  if (!provider) {
    throw new SkillPackageLifecycleError('registry-corrupt', 'Skill package registry contains an unsupported target agent')
  }
  if (record.consumerRoot !== provider.relativeRoot) {
    throw new SkillPackageLifecycleError('registry-corrupt', 'Skill package registry contains an unexpected consumer root')
  }
  const files = filesFromStored(record.files)
  const computedBytes = files.reduce((sum, file) => sum + file.bytes, 0)
  if (computedBytes !== record.totalBytes) {
    throw new SkillPackageLifecycleError('registry-corrupt', 'Skill package registry byte totals do not match')
  }
  return {
    manifest: manifestFromStored(record.manifest),
    source: assertSource(record.source, 'registry-corrupt'),
    resolvedSource: resolvedSourceFromStored(record.resolvedSource),
    workspacePath: resolve(record.workspacePath),
    providerId: provider.id,
    consumerRoot: provider.relativeRoot,
    files,
    totalBytes: computedBytes,
    installedAt: record.installedAt,
    updatedAt: record.updatedAt
  }
}

function fsyncDirectory(path: string): void {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, 'r')
    fsyncSync(descriptor)
  } catch {
    // Some filesystems do not support directory fsync; file contents are already flushed.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function writeNewFile(path: string, content: Buffer): void {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, 'wx', 0o600)
    writeFileSync(descriptor, content)
    fsyncSync(descriptor)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function removeEmptyDirectories(root: string, filePaths: readonly string[]): void {
  const directories = new Set<string>()
  for (const filePath of filePaths) {
    let current = dirname(join(root, ...filePath.split('/')))
    while (current !== root && pathIsInside(root, current)) {
      directories.add(current)
      current = dirname(current)
    }
  }
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    try {
      rmdirSync(directory)
    } catch {
      // Non-empty directories contain unowned data and must remain untouched.
    }
  }
  try {
    rmdirSync(root)
  } catch {
    // The package root can remain when it contains unowned data.
  }
}

export class SkillPackagesManager {
  readonly registryPath: string
  private readonly legacyDirectory: string
  private readonly resolveWorkspace: ResolveSkillPackageWorkspace
  private readonly now: () => number
  private readonly pendingPlans = new Map<string, PendingPlan>()
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(userDataDir: string, options: SkillPackagesManagerOptions) {
    if (!options?.resolveWorkspace) throw new Error('SkillPackagesManager requires an authorized workspace resolver')
    this.registryPath = join(userDataDir, REGISTRY_FILE)
    this.legacyDirectory = join(userDataDir, LEGACY_DIRECTORY)
    this.resolveWorkspace = options.resolveWorkspace
    this.now = options.now ?? Date.now
  }

  async list(request: SkillPackagesListRequest = {}): Promise<SkillPackagesListResult> {
    const legacyDocuments = this.listLegacyDocuments()
    const hasWorkspace = typeof request.workspacePath === 'string' && request.workspacePath.trim().length > 0
    const hasProvider = typeof request.providerId === 'string'
    if (hasWorkspace !== hasProvider) {
      throw new SkillPackageLifecycleError('invalid-request', 'Workspace and target agent must be selected together')
    }
    if (!hasWorkspace || !request.providerId) {
      return { providers: SKILL_PACKAGE_PROVIDERS, packages: [], legacyDocuments }
    }

    const workspacePath = await this.authorizeWorkspace(request.workspacePath ?? '')
    const target = this.targetFor(workspacePath, request.providerId)
    this.assertExistingComponentsSafe(workspacePath, target.consumerRoot)
    const registry = this.readRegistrySnapshot().registry
    const packages = registry.packages
      .filter((record) => record.workspacePath === workspacePath && record.providerId === request.providerId)
      .sort((left, right) => left.manifest.name < right.manifest.name ? -1 : left.manifest.name > right.manifest.name ? 1 : 0)
      .map((record) => this.viewForRecord(record))
    return { providers: SKILL_PACKAGE_PROVIDERS, target, packages, legacyDocuments }
  }

  async prepare(request: SkillPackagePrepareRequest): Promise<SkillPackagePlan> {
    if (typeof request !== 'object' || request === null || Array.isArray(request)
      || typeof request.workspacePath !== 'string' || typeof request.providerId !== 'string') {
      throw new SkillPackageLifecycleError('invalid-request', 'Install plan request is invalid')
    }
    const workspacePath = await this.authorizeWorkspace(request.workspacePath)
    const provider = skillPackageProvider(request.providerId)
    const source = assertSource(request.source)
    const acquired = await acquireSkillPackage(source)
    const target = this.targetFor(workspacePath, provider.id, acquired.manifest.name)
    const registrySnapshot = this.readRegistrySnapshot()
    const existing = this.findRecord(registrySnapshot.registry, workspacePath, provider.id, acquired.manifest.name)
    const targetSnapshot = this.snapshotForTarget(target)
    const conflicts: SkillPackageConflict[] = []
    if (existing) {
      conflicts.push({
        path: target.packagePath ?? '',
        kind: 'existing-package',
        detail: 'This package is already managed for the selected workspace and agent. Prepare an update instead.'
      })
    } else if (targetSnapshot.exists) {
      conflicts.push({
        path: target.packagePath ?? '',
        kind: 'existing-package',
        detail: 'The target package directory already exists and will not be overwritten.'
      })
    }
    if (targetSnapshot.unsafe) {
      conflicts.push({ path: target.packagePath ?? '', kind: 'unsafe-path', detail: targetSnapshot.unsafe })
    }
    const blocked = conflicts.length > 0
    const files: SkillPackagePlanFile[] = acquired.files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
      kind: file.kind,
      action: blocked ? 'conflict' : 'create',
      ...(blocked ? { detail: 'Target collision must be resolved before installation.' } : {})
    }))
    const warnings = this.packageWarnings(acquired)
    return this.rememberPlan({
      operation: 'install',
      state: blocked ? 'blocked' : 'ready',
      manifest: acquired.manifest,
      source: acquired.source,
      target,
      files,
      totalBytes: acquired.totalBytes,
      conflicts,
      warnings
    }, request.workspacePath, registrySnapshot.fingerprint, targetSnapshot.fingerprint, acquired)
  }

  async apply(request: SkillPackageApplyRequest): Promise<SkillPackageMutationResult> {
    return this.withMutation(() => this.applyPreparedPlan(request, false))
  }

  async read(request: SkillPackageReadRequest): Promise<SkillPackageReadResult> {
    if (typeof request !== 'object' || request === null || Array.isArray(request)
      || (request.kind !== 'package' && request.kind !== 'legacy')) {
      throw new SkillPackageLifecycleError('invalid-request', 'Skill package read request is invalid')
    }
    if (request.kind === 'legacy') {
      if (typeof request.id !== 'string') throw new SkillPackageLifecycleError('invalid-request', 'Legacy skill document id is invalid')
      return this.readLegacyDocument(request.id)
    }
    if (typeof request.workspacePath !== 'string' || typeof request.providerId !== 'string' || typeof request.name !== 'string'
      || (request.path !== undefined && typeof request.path !== 'string')) {
      throw new SkillPackageLifecycleError('invalid-request', 'Skill package read request is invalid')
    }
    const workspacePath = await this.authorizeWorkspace(request.workspacePath)
    const provider = skillPackageProvider(request.providerId)
    const name = normalizePackageName(request.name)
    const registry = this.readRegistrySnapshot().registry
    const record = this.findRecord(registry, workspacePath, provider.id, name)
    if (!record) throw new SkillPackageLifecycleError('package-not-found', `Skill package ${name} is not managed for this target`)
    const target = this.targetFor(workspacePath, provider.id, name)
    this.assertExistingComponentsSafe(workspacePath, target.consumerRoot)
    const packagePath = target.packagePath ?? ''
    const relativePath = normalizeSkillPackagePath(request.path ?? 'SKILL.md')
    const file = record.files.find((candidate) => candidate.path === relativePath)
    if (!file) throw new SkillPackageLifecycleError('package-not-found', `${relativePath} is not an owned package file`)
    return this.readPreview(name, packagePath, file)
  }

  async prepareUpdate(request: SkillPackageIdentityRequest): Promise<SkillPackagePlan> {
    const identity = await this.resolveIdentity(request)
    const registrySnapshot = this.readRegistrySnapshot()
    const existing = this.findRecord(registrySnapshot.registry, identity.workspacePath, identity.providerId, identity.name)
    if (!existing) throw new SkillPackageLifecycleError('package-not-found', `Skill package ${identity.name} is not managed for this target`)
    const acquired = await acquireSkillPackage(existing.source)
    if (acquired.manifest.name !== existing.manifest.name) {
      throw new SkillPackageLifecycleError('plan-blocked', `Update source now declares ${acquired.manifest.name}; expected ${existing.manifest.name}`)
    }
    const target = this.targetFor(identity.workspacePath, identity.providerId, identity.name)
    const inspection = this.inspectRecord(existing)
    const conflicts = this.conflictsForInspection(existing, inspection)
    const oldByPath = new Map(existing.files.map((file) => [file.path, file]))
    const incomingByPath = new Map(acquired.files.map((file) => [file.path, file]))
    const files: SkillPackagePlanFile[] = []
    for (const incoming of acquired.files) {
      const old = oldByPath.get(incoming.path)
      files.push({
        path: incoming.path,
        bytes: incoming.bytes,
        sha256: incoming.sha256,
        kind: incoming.kind,
        action: conflicts.length > 0 ? 'conflict' : !old ? 'create' : old.sha256 === incoming.sha256 ? 'unchanged' : 'update',
        ...(conflicts.length > 0 ? { detail: 'Current package files must match the installed revision before updating.' } : {})
      })
    }
    for (const old of existing.files) {
      if (!incomingByPath.has(old.path)) files.push({ ...old, action: conflicts.length > 0 ? 'conflict' : 'remove' })
    }
    files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    const changed = files.some((file) => file.action !== 'unchanged')
    const state = conflicts.length > 0 ? 'blocked' : changed ? 'ready' : 'no-changes'
    return this.rememberPlan({
      operation: 'update',
      state,
      manifest: acquired.manifest,
      source: acquired.source,
      target,
      files,
      totalBytes: acquired.totalBytes,
      conflicts,
      warnings: this.packageWarnings(acquired)
    }, request.workspacePath, registrySnapshot.fingerprint, inspection.snapshot.fingerprint, acquired, existing)
  }

  async prepareRemove(request: SkillPackageIdentityRequest): Promise<SkillPackagePlan> {
    const identity = await this.resolveIdentity(request)
    const registrySnapshot = this.readRegistrySnapshot()
    const existing = this.findRecord(registrySnapshot.registry, identity.workspacePath, identity.providerId, identity.name)
    if (!existing) throw new SkillPackageLifecycleError('package-not-found', `Skill package ${identity.name} is not managed for this target`)
    const target = this.targetFor(identity.workspacePath, identity.providerId, identity.name)
    const snapshot = this.snapshotForTarget(target)
    const actualByPath = new Map(snapshot.files.map((file) => [file.path, file]))
    const ownedPaths = new Set(existing.files.map((file) => file.path))
    const conflicts: SkillPackageConflict[] = []
    const files: SkillPackagePlanFile[] = existing.files.map((owned) => {
      const actual = actualByPath.get(owned.path)
      if (!actual) return { ...owned, action: 'missing', detail: 'Already absent; no deletion will be attempted.' }
      if (actual.type !== 'file') {
        conflicts.push({ path: owned.path, kind: 'owned-file-type-changed', detail: 'Owned file changed type and is protected from removal.' })
        return { ...owned, action: 'protect', detail: 'Changed file type will not be removed.' }
      }
      if (actual.sha256 !== owned.sha256) {
        conflicts.push({ path: owned.path, kind: 'owned-file-modified', detail: 'Owned file has user edits and is protected from removal.' })
        return { ...owned, action: 'protect', detail: 'Edited file will not be removed.' }
      }
      return { ...owned, action: 'remove' }
    })
    for (const actual of snapshot.files) {
      if (ownedPaths.has(actual.path)) continue
      files.push({
        path: actual.path,
        bytes: actual.bytes,
        sha256: actual.sha256 ?? hashText(actual.fingerprint),
        kind: fileKind(actual.path),
        action: 'protect',
        detail: 'Unowned file remains in place.'
      })
    }
    if (snapshot.unsafe) conflicts.push({ path: target.packagePath ?? '', kind: 'unsafe-path', detail: snapshot.unsafe })
    files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    return this.rememberPlan({
      operation: 'remove',
      state: conflicts.length > 0 ? 'blocked' : 'ready',
      manifest: existing.manifest,
      source: existing.resolvedSource,
      target,
      files,
      totalBytes: files.filter((file) => file.action === 'remove').reduce((sum, file) => sum + file.bytes, 0),
      conflicts,
      warnings: files.some((file) => file.action === 'protect')
        ? ['Unowned files are outside package ownership and remain untouched.']
        : []
    }, request.workspacePath, registrySnapshot.fingerprint, snapshot.fingerprint, undefined, existing)
  }

  async remove(request: SkillPackageApplyRequest): Promise<SkillPackageMutationResult> {
    return this.withMutation(() => this.applyPreparedPlan(request, true))
  }

  private async resolveIdentity(request: SkillPackageIdentityRequest): Promise<{
    workspacePath: string
    providerId: SkillPackageTarget['providerId']
    name: string
  }> {
    if (typeof request !== 'object' || request === null || Array.isArray(request)
      || typeof request.workspacePath !== 'string' || typeof request.providerId !== 'string'
      || typeof request.name !== 'string') {
      throw new SkillPackageLifecycleError('invalid-request', 'Skill package target is invalid')
    }
    const workspacePath = await this.authorizeWorkspace(request.workspacePath)
    const provider = skillPackageProvider(request.providerId)
    return { workspacePath, providerId: provider.id, name: normalizePackageName(request.name) }
  }

  private async authorizeWorkspace(requestedPath: string): Promise<string> {
    if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
      throw new SkillPackageLifecycleError('invalid-request', 'Workspace path is required')
    }
    let requestedRealPath: string
    try {
      const absolutePath = resolve(requestedPath)
      if (!statSync(absolutePath).isDirectory()) throw new Error('not a directory')
      requestedRealPath = resolve(realpathSync(absolutePath))
    } catch (error) {
      throw new SkillPackageLifecycleError('unauthorized-workspace', 'Workspace path is unavailable', { cause: error })
    }
    let authorizedPath: string
    try {
      authorizedPath = await this.resolveWorkspace(requestedPath)
    } catch (error) {
      throw new SkillPackageLifecycleError('unauthorized-workspace', 'Workspace is not an authorized local workspace', { cause: error })
    }
    let authorizedRealPath: string
    try {
      const absolutePath = resolve(authorizedPath)
      if (!statSync(absolutePath).isDirectory()) throw new Error('not a directory')
      authorizedRealPath = resolve(realpathSync(absolutePath))
    } catch (error) {
      throw new SkillPackageLifecycleError('unauthorized-workspace', 'Authorized workspace path is unavailable', { cause: error })
    }
    if (requestedRealPath !== authorizedRealPath) {
      throw new SkillPackageLifecycleError('unauthorized-workspace', 'Workspace is not an authorized local workspace')
    }
    return authorizedRealPath
  }

  private targetFor(workspacePath: string, providerId: SkillPackageTarget['providerId'], name?: string): SkillPackageTarget {
    const provider = skillPackageProvider(providerId)
    const consumerRoot = join(workspacePath, ...provider.relativeRoot.split('/'))
    if (!pathIsInside(workspacePath, consumerRoot)) {
      throw new SkillPackageLifecycleError('unsafe-path', 'Skill consumer root escaped the workspace')
    }
    const packagePath = name ? join(consumerRoot, normalizePackageName(name)) : undefined
    if (packagePath && !pathIsInside(consumerRoot, packagePath)) {
      throw new SkillPackageLifecycleError('unsafe-path', 'Skill package path escaped the consumer root')
    }
    return {
      workspacePath,
      providerId: provider.id,
      providerLabel: provider.label,
      consumerRoot,
      ...(packagePath ? { packagePath } : {})
    }
  }

  private assertExistingComponentsSafe(workspacePath: string, targetPath: string): void {
    if (!pathIsInside(workspacePath, targetPath)) {
      throw new SkillPackageLifecycleError('unsafe-path', 'Skill target escaped the authorized workspace')
    }
    const rel = relative(workspacePath, targetPath)
    let current = workspacePath
    for (const segment of rel.split(sep).filter(Boolean)) {
      current = join(current, segment)
      if (!existsSync(current)) continue
      const entry = lstatSync(current)
      if (entry.isSymbolicLink()) {
        throw new SkillPackageLifecycleError('unsafe-path', `Symbolic link blocks skill target: ${current}`)
      }
      if (!entry.isDirectory() && current !== targetPath) {
        throw new SkillPackageLifecycleError('unsafe-path', `Non-directory blocks skill target: ${current}`)
      }
    }
  }

  private ensureConsumerRoot(target: SkillPackageTarget): void {
    this.assertExistingComponentsSafe(target.workspacePath, target.consumerRoot)
    mkdirSync(target.consumerRoot, { recursive: true, mode: 0o700 })
    this.assertExistingComponentsSafe(target.workspacePath, target.consumerRoot)
    const rootRealPath = realpathSync(target.consumerRoot)
    if (!pathIsInside(target.workspacePath, rootRealPath)) {
      throw new SkillPackageLifecycleError('unsafe-path', 'Skill consumer root escaped the authorized workspace')
    }
  }

  private snapshotForTarget(target: SkillPackageTarget): TargetSnapshot {
    try {
      this.assertExistingComponentsSafe(target.workspacePath, target.consumerRoot)
      return this.snapshotTarget(target.packagePath ?? '')
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return {
        exists: false,
        files: [],
        fingerprint: hashText(`unsafe:${detail}`),
        unsafe: detail
      }
    }
  }
  private snapshotTarget(packagePath: string): TargetSnapshot {
    const fingerprint = createHash('sha256')
    if (!existsSync(packagePath)) {
      fingerprint.update('absent')
      return { exists: false, files: [], fingerprint: fingerprint.digest('hex') }
    }
    const root = lstatSync(packagePath)
    if (root.isSymbolicLink() || !root.isDirectory()) {
      const type = root.isSymbolicLink() ? 'symbolic link' : 'non-directory'
      fingerprint.update(`${type}:${root.size}:${root.mtimeMs}`)
      return {
        exists: true,
        files: [],
        fingerprint: fingerprint.digest('hex'),
        unsafe: `Target package path is a ${type}`
      }
    }

    const files: TargetFile[] = []
    const directories = ['']
    let entries = 0
    let unsafe: string | undefined
    while (directories.length > 0 && !unsafe) {
      const relativeDirectory = directories.pop()
      if (relativeDirectory === undefined) break
      const directory = relativeDirectory ? join(packagePath, ...relativeDirectory.split('/')) : packagePath
      for (const name of readdirSync(directory).sort()) {
        entries += 1
        if (entries > MAX_TARGET_ENTRIES) {
          unsafe = `Target package contains more than ${MAX_TARGET_ENTRIES} entries`
          break
        }
        const rawPath = relativeDirectory ? `${relativeDirectory}/${name}` : name
        let path: string
        try {
          path = normalizeSkillPackagePath(rawPath)
        } catch {
          unsafe = `Target package contains an unsafe path: ${rawPath}`
          break
        }
        const absolutePath = join(packagePath, ...path.split('/'))
        const entry = lstatSync(absolutePath)
        if (entry.isDirectory()) {
          directories.push(path)
          fingerprint.update(`directory\0${path}\0${entry.mtimeMs}\0`)
          continue
        }
        if (entry.isSymbolicLink()) {
          const link = readlinkSync(absolutePath)
          const linkFingerprint = `symlink\0${path}\0${link}\0${entry.mtimeMs}`
          files.push({ path, type: 'symlink', bytes: entry.size, fingerprint: linkFingerprint })
          fingerprint.update(linkFingerprint)
          continue
        }
        if (!entry.isFile()) {
          const otherFingerprint = `other\0${path}\0${entry.size}\0${entry.mtimeMs}`
          files.push({ path, type: 'other', bytes: entry.size, fingerprint: otherFingerprint })
          fingerprint.update(otherFingerprint)
          continue
        }
        const sha256 = entry.size <= MAX_SKILL_PACKAGE_FILE_BYTES
          ? createHash('sha256').update(readFileSync(absolutePath)).digest('hex')
          : undefined
        const fileFingerprint = `file\0${path}\0${entry.size}\0${entry.mtimeMs}\0${sha256 ?? 'oversize'}`
        files.push({ path, type: 'file', bytes: entry.size, ...(sha256 ? { sha256 } : {}), fingerprint: fileFingerprint })
        fingerprint.update(fileFingerprint)
      }
    }
    return { exists: true, files, fingerprint: fingerprint.digest('hex'), ...(unsafe ? { unsafe } : {}) }
  }

  private inspectRecord(record: StoredSkillPackage): PackageInspection {
    const target = this.targetFor(record.workspacePath, record.providerId, record.manifest.name)
    let snapshot: TargetSnapshot
    try {
      this.assertExistingComponentsSafe(record.workspacePath, target.consumerRoot)
      snapshot = this.snapshotTarget(target.packagePath ?? '')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        health: 'blocked',
        issues: [message],
        snapshot: { exists: false, files: [], fingerprint: hashText(`unsafe:${message}`), unsafe: message }
      }
    }
    if (snapshot.unsafe) return { health: 'blocked', issues: [snapshot.unsafe], snapshot }
    if (!snapshot.exists) return { health: 'missing', issues: ['Package directory is missing.'], snapshot }

    const actualByPath = new Map(snapshot.files.map((file) => [file.path, file]))
    const expectedPaths = new Set(record.files.map((file) => file.path))
    const issues: string[] = []
    let present = 0
    for (const expected of record.files) {
      const actual = actualByPath.get(expected.path)
      if (!actual) {
        issues.push(`${expected.path} is missing.`)
        continue
      }
      present += 1
      if (actual.type !== 'file') issues.push(`${expected.path} is no longer a regular file.`)
      else if (actual.sha256 !== expected.sha256) issues.push(`${expected.path} differs from the installed revision.`)
    }
    for (const actual of snapshot.files) {
      if (!expectedPaths.has(actual.path)) issues.push(`${actual.path} is unowned and will not be changed.`)
    }
    if (issues.length === 0) return { health: 'ready', issues, snapshot }
    return { health: present === 0 ? 'missing' : 'modified', issues, snapshot }
  }

  private conflictsForInspection(record: StoredSkillPackage, inspection: PackageInspection): SkillPackageConflict[] {
    if (inspection.health === 'ready') return []
    const expectedByPath = new Map(record.files.map((file) => [file.path, file]))
    const actualByPath = new Map(inspection.snapshot.files.map((file) => [file.path, file]))
    const conflicts: SkillPackageConflict[] = []
    if (inspection.snapshot.unsafe) {
      conflicts.push({ path: record.manifest.name, kind: 'unsafe-path', detail: inspection.snapshot.unsafe })
    }
    for (const expected of record.files) {
      const actual = actualByPath.get(expected.path)
      if (!actual) {
        conflicts.push({ path: expected.path, kind: 'owned-file-modified', detail: 'Owned file is missing.' })
      } else if (actual.type !== 'file') {
        conflicts.push({ path: expected.path, kind: 'owned-file-type-changed', detail: 'Owned file changed type.' })
      } else if (actual.sha256 !== expected.sha256) {
        conflicts.push({ path: expected.path, kind: 'owned-file-modified', detail: 'Owned file has user edits.' })
      }
    }
    for (const actual of inspection.snapshot.files) {
      if (!expectedByPath.has(actual.path)) {
        conflicts.push({ path: actual.path, kind: 'unmanaged-file', detail: 'Unowned file is present in the managed package directory.' })
      }
    }
    return conflicts
  }

  private viewForRecord(record: StoredSkillPackage): InstalledSkillPackage {
    const inspection = this.inspectRecord(record)
    return {
      manifest: { ...record.manifest },
      source: structuredClone(record.source),
      resolvedSource: { ...record.resolvedSource },
      target: this.targetFor(record.workspacePath, record.providerId, record.manifest.name),
      files: record.files.map((file) => ({ ...file })),
      totalBytes: record.totalBytes,
      installedAt: record.installedAt,
      updatedAt: record.updatedAt,
      health: inspection.health,
      issues: [...inspection.issues]
    }
  }

  private packageWarnings(acquired: AcquiredSkillPackage): string[] {
    const warnings = [...acquired.warnings]
    if (acquired.files.some((file) => file.kind === 'script')) {
      warnings.push('Package scripts are copied as inert files. The package manager never executes them.')
    }
    return warnings
  }

  private rememberPlan(
    partial: Omit<SkillPackagePlan, 'id' | 'confirmationToken' | 'confirmationPhrase' | 'expiresAt'>,
    requestedWorkspacePath: string,
    registryFingerprint: string,
    targetFingerprint: string,
    acquired?: AcquiredSkillPackage,
    existing?: StoredSkillPackage
  ): SkillPackagePlan {
    this.purgePlans()
    while (this.pendingPlans.size >= MAX_PENDING_PLANS) {
      const oldest = this.pendingPlans.keys().next().value
      if (typeof oldest !== 'string') break
      this.pendingPlans.delete(oldest)
    }
    const id = randomUUID()
    const confirmationToken = randomBytes(24).toString('base64url')
    const verb = partial.operation === 'install' ? 'INSTALL' : partial.operation === 'update' ? 'UPDATE' : 'REMOVE'
    const plan: SkillPackagePlan = {
      ...partial,
      id,
      confirmationToken,
      confirmationPhrase: `${verb} ${partial.manifest.name} IN ${partial.target.workspacePath}`,
      expiresAt: new Date(this.now() + PLAN_TTL_MS).toISOString()
    }
    this.pendingPlans.set(id, {
      plan,
      requestedWorkspacePath,
      registryFingerprint,
      targetFingerprint,
      ...(acquired ? { acquired } : {}),
      ...(existing ? { existing } : {})
    })
    return structuredClone(plan)
  }

  private purgePlans(): void {
    const now = this.now()
    for (const [id, pending] of this.pendingPlans) {
      if (Date.parse(pending.plan.expiresAt) <= now) this.pendingPlans.delete(id)
    }
  }

  private async applyPreparedPlan(request: SkillPackageApplyRequest, removeOnly: boolean): Promise<SkillPackageMutationResult> {
    if (typeof request !== 'object' || request === null || Array.isArray(request)
      || typeof request.planId !== 'string' || typeof request.confirmationToken !== 'string') {
      throw new SkillPackageLifecycleError('invalid-request', 'Plan confirmation is invalid')
    }
    const pending = this.pendingPlans.get(request.planId)
    if (!pending) throw new SkillPackageLifecycleError('plan-not-found', 'Skill package plan was not found or was already used')
    this.pendingPlans.delete(request.planId)
    if (Date.parse(pending.plan.expiresAt) <= this.now()) {
      throw new SkillPackageLifecycleError('plan-expired', 'Skill package plan expired; prepare it again')
    }
    if (!safeTokenMatch(pending.plan.confirmationToken, request.confirmationToken)) {
      throw new SkillPackageLifecycleError('invalid-request', 'Skill package confirmation token does not match the plan')
    }
    if (pending.plan.state !== 'ready') {
      throw new SkillPackageLifecycleError('plan-blocked', 'Blocked or unchanged plans cannot be applied')
    }
    if (removeOnly !== (pending.plan.operation === 'remove')) {
      throw new SkillPackageLifecycleError('invalid-request', 'Plan operation does not match this confirmation action')
    }

    const workspacePath = await this.authorizeWorkspace(pending.requestedWorkspacePath)
    if (workspacePath !== pending.plan.target.workspacePath) {
      throw new SkillPackageLifecycleError('plan-stale', 'Workspace target changed after the plan was prepared')
    }
    const registrySnapshot = this.readRegistrySnapshot()
    const currentTarget = this.snapshotForTarget(pending.plan.target)
    if (registrySnapshot.fingerprint !== pending.registryFingerprint || currentTarget.fingerprint !== pending.targetFingerprint) {
      throw new SkillPackageLifecycleError('plan-stale', 'Package files or ownership changed after the plan was prepared')
    }

    if (pending.plan.operation === 'remove') {
      if (!pending.existing) throw new SkillPackageLifecycleError('plan-stale', 'Removal plan lost its ownership record')
      return this.commitRemove(pending, registrySnapshot.registry)
    }
    if (!pending.acquired) throw new SkillPackageLifecycleError('plan-stale', 'Install plan lost its acquired package')
    return this.commitInstallOrUpdate(pending, registrySnapshot.registry)
  }

  private commitInstallOrUpdate(pending: PendingPlan, registry: SkillPackageRegistry): SkillPackageMutationResult {
    const target = pending.plan.target
    const packagePath = target.packagePath ?? ''
    this.ensureConsumerRoot(target)
    const stagePath = join(target.consumerRoot, `.${pending.plan.manifest.name}.${randomUUID()}.stage`)
    const backupPath = join(target.consumerRoot, `.${pending.plan.manifest.name}.${randomUUID()}.backup`)
    const acquired = pending.acquired
    if (!acquired) throw new SkillPackageLifecycleError('plan-stale', 'Acquired package is unavailable')
    let targetActivated = false
    let backupActive = false
    let registryCommitted = false
    mkdirSync(stagePath, { mode: 0o700 })
    try {
      for (const file of acquired.files) {
        const destination = join(stagePath, ...file.path.split('/'))
        if (!pathIsInside(stagePath, destination)) throw new SkillPackageLifecycleError('unsafe-path', `Package file escaped staging: ${file.path}`)
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
        writeNewFile(destination, file.content)
      }
      fsyncDirectory(stagePath)
      if (pending.plan.operation === 'install') {
        if (existsSync(packagePath)) throw new SkillPackageLifecycleError('plan-stale', 'Target package appeared after confirmation')
        renameSync(stagePath, packagePath)
        targetActivated = true
      } else {
        if (!existsSync(packagePath)) throw new SkillPackageLifecycleError('plan-stale', 'Managed package disappeared after confirmation')
        renameSync(packagePath, backupPath)
        backupActive = true
        renameSync(stagePath, packagePath)
        targetActivated = true
      }
      fsyncDirectory(target.consumerRoot)

      const now = new Date(this.now()).toISOString()
      const record: StoredSkillPackage = {
        manifest: { ...acquired.manifest },
        source: structuredClone(acquired.requestedSource),
        resolvedSource: { ...acquired.source },
        workspacePath: target.workspacePath,
        providerId: target.providerId,
        consumerRoot: skillPackageProvider(target.providerId).relativeRoot,
        files: acquired.files.map((file) => ({
          path: file.path,
          bytes: file.bytes,
          sha256: file.sha256,
          kind: file.kind
        })),
        totalBytes: acquired.totalBytes,
        installedAt: pending.existing?.installedAt ?? now,
        updatedAt: now
      }
      const next: SkillPackageRegistry = {
        schemaVersion: REGISTRY_SCHEMA_VERSION,
        packages: registry.packages
          .filter((candidate) => !(candidate.workspacePath === record.workspacePath
            && candidate.providerId === record.providerId
            && candidate.manifest.name === record.manifest.name))
          .concat(record)
          .sort((left, right) => this.recordKey(left) < this.recordKey(right) ? -1 : this.recordKey(left) > this.recordKey(right) ? 1 : 0)
      }
      this.writeRegistry(next)
      registryCommitted = true
      const installed = this.viewForRecord(record)
      return {
        operation: pending.plan.operation,
        name: record.manifest.name,
        target: installed.target,
        removed: false,
        package: installed,
        protectedPaths: []
      }
    } catch (error) {
      if (!registryCommitted) {
        try {
          if (targetActivated && existsSync(packagePath)) rmSync(packagePath, { recursive: true, force: true })
          if (backupActive && existsSync(backupPath) && !existsSync(packagePath)) {
            renameSync(backupPath, packagePath)
            backupActive = false
          }
          fsyncDirectory(target.consumerRoot)
        } catch (rollbackError) {
          throw new SkillPackageLifecycleError(
            'plan-stale',
            `Package transaction failed and its recovery copy remains at ${backupPath}`,
            { cause: rollbackError }
          )
        }
      }
      throw error
    } finally {
      try {
        rmSync(stagePath, { recursive: true, force: true })
      } catch {
        // Cleanup cannot change the already decided transaction outcome.
      }
      if (registryCommitted) {
        try {
          rmSync(backupPath, { recursive: true, force: true })
        } catch {
          // A recovery copy is safer than reporting a committed update as failed.
        }
      }
    }
  }

  private commitRemove(pending: PendingPlan, registry: SkillPackageRegistry): SkillPackageMutationResult {
    const existing = pending.existing
    if (!existing) throw new SkillPackageLifecycleError('plan-stale', 'Ownership record is unavailable')
    const target = pending.plan.target
    const packagePath = target.packagePath ?? ''
    this.ensureConsumerRoot(target)
    const backupPath = join(target.consumerRoot, `.${existing.manifest.name}.${randomUUID()}.remove`)
    const moved: string[] = []
    let registryCommitted = false
    let preserveBackup = false
    mkdirSync(backupPath, { mode: 0o700 })
    try {
      for (const file of existing.files) {
        const source = join(packagePath, ...file.path.split('/'))
        if (!existsSync(source)) continue
        const current = lstatSync(source)
        if (!current.isFile()) throw new SkillPackageLifecycleError('plan-stale', `${file.path} changed type after confirmation`)
        const currentHash = createHash('sha256').update(readFileSync(source)).digest('hex')
        if (currentHash !== file.sha256) throw new SkillPackageLifecycleError('plan-stale', `${file.path} changed after confirmation`)
        const destination = join(backupPath, ...file.path.split('/'))
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
        renameSync(source, destination)
        moved.push(file.path)
      }
      const next: SkillPackageRegistry = {
        schemaVersion: REGISTRY_SCHEMA_VERSION,
        packages: registry.packages.filter((candidate) => !(candidate.workspacePath === existing.workspacePath
          && candidate.providerId === existing.providerId
          && candidate.manifest.name === existing.manifest.name))
      }
      this.writeRegistry(next)
      registryCommitted = true
      removeEmptyDirectories(packagePath, moved)
      fsyncDirectory(target.consumerRoot)
      return {
        operation: 'remove',
        name: existing.manifest.name,
        target,
        removed: true,
        protectedPaths: pending.plan.files.filter((file) => file.action === 'protect').map((file) => file.path)
      }
    } catch (error) {
      if (!registryCommitted) {
        try {
          for (const filePath of [...moved].reverse()) {
            const source = join(backupPath, ...filePath.split('/'))
            const destination = join(packagePath, ...filePath.split('/'))
            if (existsSync(destination)) throw new Error(`Rollback target appeared: ${destination}`)
            mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
            renameSync(source, destination)
          }
        } catch (rollbackError) {
          preserveBackup = true
          throw new SkillPackageLifecycleError(
            'plan-stale',
            `Removal transaction failed and its recovery copy remains at ${backupPath}`,
            { cause: rollbackError }
          )
        }
      }
      throw error
    } finally {
      if (!preserveBackup) {
        try {
          rmSync(backupPath, { recursive: true, force: true })
        } catch {
          // A recovery copy is safer than reporting a committed removal as failed.
        }
      }
    }
  }

  private withMutation<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.mutationTail.then(operation, operation)
    this.mutationTail = result.then(() => undefined, () => undefined)
    return result
  }

  private findRecord(
    registry: SkillPackageRegistry,
    workspacePath: string,
    providerId: SkillPackageTarget['providerId'],
    name: string
  ): StoredSkillPackage | undefined {
    return registry.packages.find((record) => record.workspacePath === workspacePath
      && record.providerId === providerId
      && record.manifest.name === name)
  }

  private recordKey(record: StoredSkillPackage): string {
    return `${record.workspacePath}\0${record.providerId}\0${record.manifest.name}`
  }

  private readRegistrySnapshot(): RegistrySnapshot {
    let raw: string
    try {
      raw = readFileSync(this.registryPath, 'utf8')
    } catch (error) {
      const filesystemError = error as NodeJS.ErrnoException
      if (filesystemError.code === 'ENOENT') {
        return {
          registry: { schemaVersion: REGISTRY_SCHEMA_VERSION, packages: [] },
          fingerprint: hashText('absent')
        }
      }
      throw new SkillPackageLifecycleError('registry-corrupt', 'Skill package registry could not be read', { cause: error })
    }
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch (error) {
      throw new SkillPackageLifecycleError('registry-corrupt', 'Skill package registry is not valid JSON', { cause: error })
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new SkillPackageLifecycleError('registry-corrupt', 'Skill package registry schema is invalid')
    }
    const envelope = value as Record<string, unknown>
    if (envelope.schemaVersion !== REGISTRY_SCHEMA_VERSION || !Array.isArray(envelope.packages)) {
      throw new SkillPackageLifecycleError('registry-corrupt', 'Skill package registry schema is invalid')
    }
    const packages = envelope.packages.map(storedPackageFromUnknown)
    const seen = new Set<string>()
    for (const record of packages) {
      const key = this.recordKey(record)
      if (seen.has(key)) throw new SkillPackageLifecycleError('registry-corrupt', 'Skill package registry contains duplicate ownership records')
      seen.add(key)
    }
    return {
      registry: { schemaVersion: REGISTRY_SCHEMA_VERSION, packages },
      fingerprint: hashText(raw)
    }
  }

  private writeRegistry(registry: SkillPackageRegistry): void {
    const directory = dirname(this.registryPath)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporary = `${this.registryPath}.${process.pid}.${randomUUID()}.tmp`
    let descriptor: number | undefined
    try {
      descriptor = openSync(temporary, 'wx', 0o600)
      writeFileSync(descriptor, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      renameSync(temporary, this.registryPath)
      fsyncDirectory(directory)
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor)
      rmSync(temporary, { force: true })
      throw error
    }
  }

  private listLegacyDocuments(): LegacySkillDocument[] {
    if (!existsSync(this.legacyDirectory)) return []
    let sourceByName: Record<string, string> = {}
    const indexPath = join(this.legacyDirectory, LEGACY_INDEX)
    try {
      if (statSync(indexPath).size <= MAX_LEGACY_INDEX_BYTES) {
        const value: unknown = JSON.parse(readFileSync(indexPath, 'utf8'))
        if (Array.isArray(value)) {
          for (const entry of value) {
            if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
            const metadata = entry as Record<string, unknown>
            if (typeof metadata.name === 'string' && typeof metadata.source === 'string') {
              sourceByName[metadata.name] = metadata.source
            }
          }
        }
      }
    } catch {
      sourceByName = {}
    }
    const documents: LegacySkillDocument[] = []
    for (const fileName of readdirSync(this.legacyDirectory).sort()) {
      if (documents.length >= MAX_LEGACY_DOCUMENTS || !fileName.toLowerCase().endsWith('.md')) continue
      const path = join(this.legacyDirectory, fileName)
      const entry = lstatSync(path)
      if (!entry.isFile() || entry.isSymbolicLink()) continue
      const name = fileName.slice(0, -3)
      documents.push({
        id: fileName,
        name,
        fileName,
        ...(sourceByName[name] ? { source: sourceByName[name] } : {}),
        bytes: entry.size,
        preserved: true
      })
    }
    return documents
  }

  private readLegacyDocument(id: unknown): SkillPackageReadResult {
    if (typeof id !== 'string' || !/^[^/\\]+\.md$/i.test(id) || id === LEGACY_INDEX) {
      throw new SkillPackageLifecycleError('invalid-request', 'Legacy document identifier is invalid')
    }
    const path = join(this.legacyDirectory, id)
    if (!pathIsInside(this.legacyDirectory, path)) throw new SkillPackageLifecycleError('unsafe-path', 'Legacy document escaped its library')
    const entry = lstatSync(path)
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new SkillPackageLifecycleError('unsafe-path', 'Legacy document must be a regular file')
    }
    if (entry.size > MAX_SKILL_PACKAGE_FILE_BYTES) {
      throw new SkillPackageLifecycleError('unsafe-path', 'Legacy document exceeds the safe preview limit')
    }
    const content = readFileSync(path)
    return this.previewResult(id.slice(0, -3), id, content)
  }

  private readPreview(name: string, packagePath: string, file: SkillPackageFile): SkillPackageReadResult {
    const path = join(packagePath, ...file.path.split('/'))
    if (!pathIsInside(packagePath, path)) throw new SkillPackageLifecycleError('unsafe-path', 'Package preview escaped its root')
    const entry = lstatSync(path)
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new SkillPackageLifecycleError('unsafe-path', 'Package preview target must be a regular file')
    }
    if (entry.size > MAX_SKILL_PACKAGE_FILE_BYTES) {
      throw new SkillPackageLifecycleError('unsafe-path', 'Package file exceeds the safe preview limit')
    }
    const content = readFileSync(path)
    return this.previewResult(name, file.path, content)
  }

  private previewResult(name: string, path: string, content: Buffer): SkillPackageReadResult {
    const sha256 = createHash('sha256').update(content).digest('hex')
    let decoded: string
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(content)
    } catch {
      return { name, path, bytes: content.byteLength, sha256, encoding: 'binary', truncated: false }
    }
    const preview = Buffer.from(decoded).subarray(0, MAX_READ_PREVIEW_BYTES).toString('utf8')
    return {
      name,
      path,
      bytes: content.byteLength,
      sha256,
      encoding: 'utf8',
      content: preview,
      truncated: Buffer.byteLength(decoded, 'utf8') > MAX_READ_PREVIEW_BYTES
    }
  }
}
