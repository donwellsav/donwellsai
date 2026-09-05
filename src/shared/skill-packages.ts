export const SKILL_PACKAGE_PROVIDERS = [
  {
    id: 'codex',
    label: 'Codex',
    relativeRoot: '.agents/skills',
    discovery: 'Native workspace discovery',
    documentationUrl: 'https://developers.openai.com/codex/skills'
  },
  {
    id: 'claude',
    label: 'Claude Code',
    relativeRoot: '.claude/skills',
    discovery: 'Native workspace discovery',
    documentationUrl: 'https://code.claude.com/docs/en/skills'
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    relativeRoot: '.opencode/skills',
    discovery: 'Native workspace discovery',
    documentationUrl: 'https://opencode.ai/docs/skills/'
  }
] as const

export type SkillPackageProviderId = (typeof SKILL_PACKAGE_PROVIDERS)[number]['id']
export type SkillPackageProvider = (typeof SKILL_PACKAGE_PROVIDERS)[number]

export type SkillPackageSource =
  | { kind: 'local'; path: string }
  | { kind: 'https'; url: string }
  | { kind: 'git'; url: string; revision?: string; subpath?: string }

export type ResolvedSkillPackageSource = {
  kind: SkillPackageSource['kind']
  location: string
  requestedRevision?: string
  revision: string
  contentHash: string
}

export type SkillPackageManifest = {
  name: string
  description: string
  version?: string
  license?: string
  compatibility?: string
}

export type SkillPackageFileKind = 'instructions' | 'script' | 'reference' | 'asset' | 'other'
export type SkillPackagePlanFileAction = 'create' | 'update' | 'remove' | 'unchanged' | 'missing' | 'protect' | 'conflict'

export type SkillPackageFile = {
  path: string
  bytes: number
  sha256: string
  kind: SkillPackageFileKind
}

export type SkillPackagePlanFile = SkillPackageFile & {
  action: SkillPackagePlanFileAction
  detail?: string
}

export type SkillPackageTarget = {
  workspacePath: string
  providerId: SkillPackageProviderId
  providerLabel: string
  consumerRoot: string
  packagePath?: string
}

export type SkillPackageConflictKind =
  | 'existing-package'
  | 'owned-file-modified'
  | 'owned-file-type-changed'
  | 'unmanaged-file'
  | 'unsafe-path'
  | 'stale-plan'

export type SkillPackageConflict = {
  path: string
  kind: SkillPackageConflictKind
  detail: string
}

export type SkillPackagePlanOperation = 'install' | 'update' | 'remove'
export type SkillPackagePlanState = 'ready' | 'blocked' | 'no-changes'

export type SkillPackagePlan = {
  id: string
  confirmationToken: string
  confirmationPhrase: string
  expiresAt: string
  operation: SkillPackagePlanOperation
  state: SkillPackagePlanState
  manifest: SkillPackageManifest
  source: ResolvedSkillPackageSource
  target: SkillPackageTarget
  files: SkillPackagePlanFile[]
  totalBytes: number
  conflicts: SkillPackageConflict[]
  warnings: string[]
}

export type SkillPackageHealth = 'ready' | 'modified' | 'missing' | 'blocked'

export type InstalledSkillPackage = {
  manifest: SkillPackageManifest
  source: SkillPackageSource
  resolvedSource: ResolvedSkillPackageSource
  target: SkillPackageTarget
  files: SkillPackageFile[]
  totalBytes: number
  installedAt: string
  updatedAt: string
  health: SkillPackageHealth
  issues: string[]
}

export type LegacySkillDocument = {
  id: string
  name: string
  fileName: string
  source?: string
  bytes: number
  preserved: true
}

export type SkillPackagesListRequest = {
  workspacePath?: string
  providerId?: SkillPackageProviderId
}

export type SkillPackagesListResult = {
  providers: readonly SkillPackageProvider[]
  target?: SkillPackageTarget
  packages: InstalledSkillPackage[]
  legacyDocuments: LegacySkillDocument[]
}

export type SkillPackagePrepareRequest = {
  workspacePath: string
  providerId: SkillPackageProviderId
  source: SkillPackageSource
}

export type SkillPackageIdentityRequest = {
  workspacePath: string
  providerId: SkillPackageProviderId
  name: string
}

export type SkillPackageApplyRequest = {
  planId: string
  confirmationToken: string
}

export type SkillPackageMutationResult = {
  operation: SkillPackagePlanOperation
  name: string
  target: SkillPackageTarget
  removed: boolean
  package?: InstalledSkillPackage
  protectedPaths: string[]
}

export type SkillPackageReadRequest =
  | (SkillPackageIdentityRequest & { kind: 'package'; path?: string })
  | { kind: 'legacy'; id: string }

export type SkillPackageReadResult = {
  name: string
  path: string
  bytes: number
  sha256: string
  encoding: 'utf8' | 'binary'
  content?: string
  truncated: boolean
}

export interface SkillPackagesApi {
  skillPackagesList(request?: SkillPackagesListRequest): Promise<SkillPackagesListResult>
  skillPackagesPrepare(request: SkillPackagePrepareRequest): Promise<SkillPackagePlan>
  skillPackagesApply(request: SkillPackageApplyRequest): Promise<SkillPackageMutationResult>
  skillPackagesRead(request: SkillPackageReadRequest): Promise<SkillPackageReadResult>
  skillPackagesPrepareUpdate(request: SkillPackageIdentityRequest): Promise<SkillPackagePlan>
  skillPackagesPrepareRemove(request: SkillPackageIdentityRequest): Promise<SkillPackagePlan>
  skillPackagesRemove(request: SkillPackageApplyRequest): Promise<SkillPackageMutationResult>
}

export function skillPackageProvider(providerId: SkillPackageProviderId): SkillPackageProvider {
  const provider = SKILL_PACKAGE_PROVIDERS.find((candidate) => candidate.id === providerId)
  if (!provider) throw new Error(`Unsupported skill consumer: ${String(providerId)}`)
  return provider
}
