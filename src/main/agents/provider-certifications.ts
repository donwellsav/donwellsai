import type { AgentDriverId, ProviderCredentialMode } from '@shared/provider-authority'

/**
 * A certification is executable provenance, not a user setting. The shipped
 * matrix is intentionally empty until a reviewed procedure supplies every
 * isolation and materialization proof for an exact driver build.
 */
export type ProviderCertification = Readonly<{
  driverId: AgentDriverId
  modes: readonly ('managed' | 'none')[]
  executablePath: string
  executableSha256?: string
  supportedVersionRange: string
  platform: NodeJS.Platform
  architecture: string
  allowedArgs?: readonly string[]
  verify?: (executable: string, args: readonly string[]) => boolean
}>

export const PROVIDER_CERTIFICATIONS: readonly ProviderCertification[] = []

export function certificationFor(driverId: AgentDriverId, mode: ProviderCredentialMode, executable: string, args: readonly string[], platform = process.platform, architecture = process.arch): ProviderCertification | undefined {
  return PROVIDER_CERTIFICATIONS.find(candidate => candidate.driverId === driverId && candidate.modes.includes(mode as 'managed' | 'none') && candidate.executablePath === executable && candidate.platform === platform && candidate.architecture === architecture && (candidate.allowedArgs === undefined || JSON.stringify(candidate.allowedArgs) === JSON.stringify(args)) && (candidate.verify === undefined || candidate.verify(executable, args)))
}
