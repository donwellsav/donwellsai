import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isProviderCertificationPlatform, parseAgentDriverId, type AgentDriverId, type ProviderCertificationPlatform, type ProviderCredentialMode } from '@shared/provider-authority'

/**
 * A certification is executable provenance, not a user setting. An entry is
 * static reviewed code: it binds one driver ID, the credential modes it may
 * serve, and the exact executable/version/platform/architecture tuple those
 * modes were reviewed against.
 */
export type ProviderCertification = Readonly<{
  driverId: AgentDriverId
  modes: readonly ('managed' | 'none')[]
  executablePath: string
  executableSha256?: string
  supportedVersionRange: string
  version?: string
  platform: ProviderCertificationPlatform
  architecture: string
  allowedArgs?: readonly string[]
  verify?: (executable: string, args: readonly string[]) => boolean
  versionProbe?: (executable: string) => string | undefined
}>

/** The shipped support matrix is empty until a reviewed procedure passes. */
export const PROVIDER_CERTIFICATIONS: readonly ProviderCertification[] = []

const CERTIFICATION_MODES: readonly ('managed' | 'none')[] = ['managed', 'none']

/**
 * The sole decoder for a certification entry. An unreviewed platform, mode, or
 * driver is rejected here instead of being coerced onto a reviewed tuple, so a
 * malformed registration can never widen supported credential modes.
 */
export function parseProviderCertification(value: unknown): ProviderCertification {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('provider certification must be an object')
  const input = value as Record<string, unknown>
  const driverId = parseAgentDriverId(input['driverId'], 'certification.driverId')
  const modes = input['modes']
  if (!Array.isArray(modes) || modes.length === 0 || modes.some(mode => !CERTIFICATION_MODES.includes(mode as 'managed' | 'none'))) throw new Error('certification.modes must list reviewed managed/none modes')
  if (typeof input['executablePath'] !== 'string' || !input['executablePath'] || input['executablePath'].includes('\0')) throw new Error('certification.executablePath must be a non-empty path')
  if (typeof input['supportedVersionRange'] !== 'string' || !input['supportedVersionRange']) throw new Error('certification.supportedVersionRange must be a non-empty range')
  if (!isProviderCertificationPlatform(input['platform'])) throw new Error(`certification.platform must be a reviewed platform, not ${String(input['platform'])}`)
  if (typeof input['architecture'] !== 'string' || !input['architecture']) throw new Error('certification.architecture must be a non-empty architecture')
  const optional: {
    executableSha256?: string
    version?: string
    allowedArgs?: readonly string[]
    verify?: ProviderCertification['verify']
    versionProbe?: ProviderCertification['versionProbe']
  } = {}
  if (input['executableSha256'] !== undefined) {
    if (typeof input['executableSha256'] !== 'string' || !/^[a-f0-9]{64}$/.test(input['executableSha256'])) throw new Error('certification.executableSha256 must be a lowercase sha256 digest')
    optional.executableSha256 = input['executableSha256']
  }
  if (input['version'] !== undefined) {
    if (typeof input['version'] !== 'string' || !input['version']) throw new Error('certification.version must be a non-empty version')
    optional.version = input['version']
  }
  if (input['allowedArgs'] !== undefined) {
    if (!Array.isArray(input['allowedArgs']) || input['allowedArgs'].some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('certification.allowedArgs must be a list of exact argument strings')
    optional.allowedArgs = [...input['allowedArgs'] as string[]]
  }
  if (input['verify'] !== undefined) {
    if (typeof input['verify'] !== 'function') throw new Error('certification.verify must be a function')
    optional.verify = input['verify'] as ProviderCertification['verify']
  }
  if (input['versionProbe'] !== undefined) {
    if (typeof input['versionProbe'] !== 'function') throw new Error('certification.versionProbe must be a function')
    optional.versionProbe = input['versionProbe'] as ProviderCertification['versionProbe']
  }
  return Object.freeze({
    driverId,
    modes: [...new Set(modes as ('managed' | 'none')[])],
    executablePath: input['executablePath'],
    supportedVersionRange: input['supportedVersionRange'],
    platform: input['platform'],
    architecture: input['architecture'],
    ...optional
  })
}

function executableDigest(executable: string): string | undefined {
  try {
    return createHash('sha256').update(readFileSync(executable)).digest('hex')
  } catch {
    return undefined
  }
}

/**
 * The single certification matcher. Driver, mode, executable identity, exact
 * argument vector, supported version, platform, architecture, and the caller's
 * extra verifier must ALL hold; any drift misses rather than falling back to a
 * less strict entry or to external mode.
 */
export function certificationFor(driverId: AgentDriverId, mode: ProviderCredentialMode, executable: string, args: readonly string[], platform = process.platform, architecture = process.arch, certifications: readonly ProviderCertification[] = PROVIDER_CERTIFICATIONS): ProviderCertification | undefined {
  if (mode === 'external' || !isProviderCertificationPlatform(platform)) return undefined
  return certifications.find(candidate => {
    if (candidate.driverId !== driverId || !candidate.modes.includes(mode) || candidate.executablePath !== executable || candidate.architecture !== architecture) return false
    // A candidate whose platform was not reviewed is never a match for any host.
    if (!isProviderCertificationPlatform(candidate.platform) || candidate.platform !== platform) return false
    if (candidate.allowedArgs !== undefined && JSON.stringify(candidate.allowedArgs) !== JSON.stringify(args)) return false
    if (candidate.executableSha256 !== undefined && executableDigest(executable) !== candidate.executableSha256) return false
    if (candidate.version !== undefined && candidate.versionProbe?.(executable) !== candidate.version) return false
    return candidate.verify === undefined || candidate.verify(executable, args)
  })
}
