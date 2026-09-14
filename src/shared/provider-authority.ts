import type { AgentExecutable, AgentProviderDefinition, AgentProviderId, AgentMemorySupport, AgentHookSupport, AgentSkillConsumer } from './agent-runtime'
export type { AgentExecutable }
export type AgentDriverId = AgentProviderId | 'custom-command'
export type StoredDriverId = string
export type ProviderCredentialMode = 'external' | 'managed' | 'none'
export type ProviderCommandSpec =
  | { kind: 'driver'; driverId: AgentDriverId }
  | { kind: 'external-argv'; executable: AgentExecutable }
  | { kind: 'external-shell'; program: string }
export type ProviderAccount = { id: string; driverId: AgentDriverId; displayLabel: string; verifiedSubject?: string; revision: number }
export type ProviderSelection = { driverId: AgentDriverId; providerInstanceId: string; instanceRevision: number; accountId: string | null; accountRevision: number | null }
export type ProviderInstanceInput = { id?: string; driverId: AgentDriverId; displayName: string; command: ProviderCommandSpec; credentialMode: ProviderCredentialMode; accountId: string | null; enabled: boolean }
export type ProviderManagedSupport =
  | { kind: 'unsupported'; reason: string }
  | { kind: 'certified'; modes: readonly ('managed' | 'none')[]; supportedVersionRange: string; platform: 'darwin' | 'linux' | 'win32'; architecture: string }
export type ProviderDriverProjection =
  | { kind: 'known'; id: AgentDriverId; displayName: string; installed: boolean; executable?: string; hooks: AgentHookSupport; skills: AgentSkillConsumer; memorySupport: AgentMemorySupport; credentialModes: readonly ProviderCredentialMode[]; managedSupport: ProviderManagedSupport; problem?: string }
  | { kind: 'unknown'; rawDriverId: string; availability: 'unavailable'; problem: string }
export type ProviderInstanceProjection = { id: string; driver: ProviderDriverProjection; displayName: string; command: ProviderCommandSpec; credentialMode: ProviderCredentialMode; account: ProviderAccount | null; enabled: boolean; revision: number; availability: 'available' | 'unavailable'; problem?: string }
export type ProviderCatalogSnapshot = { revision: number; defaultInstanceId: string | null; drivers: readonly ProviderDriverProjection[]; accounts: readonly ProviderAccount[]; instances: readonly ProviderInstanceProjection[] }
export type BindCredentialInput = { providerInstanceId: string; accountId: string; expectedInstanceRevision: number; expectedAccountRevision: number; credentialRef: string; expectedBindingGeneration: number }
export type UnbindCredentialInput = { providerInstanceId: string; accountId: string; expectedInstanceRevision: number; expectedAccountRevision: number; expectedBindingGeneration: number }
export type PrepareProviderLaunchInput = { selection: ProviderSelection; attemptId: string; sessionId: string; purpose: 'agent-launch' }
export type ProviderLaunchPreparation = { id: string; selection: ProviderSelection; command: ProviderCommandSpec; credentialMode: ProviderCredentialMode; credentialRequest: null | { credentialRef: string; bindingGeneration: number; driverId: AgentDriverId; providerInstanceId: string; accountId: string; accountRevision: number }; attemptId: string; sessionId: string; purpose: 'agent-launch'; expiresAt: string }
export interface ProviderCatalog { snapshot(): ProviderCatalogSnapshot; createAccount(input: { driverId: AgentDriverId; displayLabel: string }): ProviderAccount; updateAccount(input: { id: string; expectedRevision: number; displayLabel: string }): ProviderAccount; removeAccount(input: { id: string; expectedRevision: number }): void; create(input: ProviderInstanceInput): ProviderInstanceProjection; update(id: string, expectedRevision: number, input: ProviderInstanceInput): ProviderInstanceProjection; remove(id: string, expectedRevision: number): void; setDefault(id: string | null, expectedRevision: number): ProviderCatalogSnapshot; bindCredential(input: BindCredentialInput): ProviderInstanceProjection; retireCredentialBindingForOperation(input: UnbindCredentialInput & { credentialOperationId: string }): ProviderInstanceProjection; prepareLaunch(input: PrepareProviderLaunchInput): ProviderLaunchPreparation }
export class ProviderCatalogError extends Error { readonly code: 'INSTANCE_NOT_FOUND' | 'INSTANCE_DISABLED' | 'INSTANCE_CHANGED' | 'ACCOUNT_CHANGED' | 'INSTANCE_HAS_CREDENTIAL' | 'ACCOUNT_NOT_FOUND' | 'ACCOUNT_MISMATCH' | 'ACCOUNT_HAS_CREDENTIAL' | 'DRIVER_UNAVAILABLE' | 'DRIVER_MODE_UNCERTIFIED' | 'COMMAND_NOT_ALLOWED' | 'CREDENTIAL_REQUIRED' | 'PREPARATION_NOT_FOUND' | 'PREPARATION_EXPIRED' | 'PREPARATION_CONSUMED' | 'CORRUPT_CATALOG'
  constructor(code: ProviderCatalogError['code'], message: string) { super(message); this.name = 'ProviderCatalogError'; this.code = code }
}

export function isAgentDriverId(value: unknown): value is AgentDriverId {
  return value === 'custom-command' || (typeof value === 'string' && ['codex','claude','pi','opencode','cursor-agent','qwen-code','goose','omp','hermes','kimi','deepseek-harness'].includes(value))
}
export function parseAgentDriverId(value: unknown, label = 'driverId'): AgentDriverId {
  if (!isAgentDriverId(value)) throw new Error(`${label} must identify a known agent driver`)
  return value
}
export function parseProviderCommandSpec(value: unknown): ProviderCommandSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid provider command')
  const input = value as Record<string, unknown>
  if (input['kind'] === 'driver') return { kind: 'driver', driverId: parseAgentDriverId(input['driverId'], 'command.driverId') }
  if (input['kind'] === 'external-argv') {
    if (!input['executable']) throw new Error('external argv requires executable')
    const launch = input['executable'] as Record<string, unknown>
    if (typeof launch['executable'] !== 'string' || !Array.isArray(launch['args'])) throw new Error('Invalid external argv executable')
    if (launch['args'].length > 256 || launch['args'].some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Invalid external argv arguments')
    return { kind: 'external-argv', executable: { executable: launch['executable'], args: [...launch['args'] as string[]] } }
  }
  if (input['kind'] === 'external-shell' && typeof input['program'] === 'string' && input['program'].length > 0 && input['program'].length <= 16 * 1024 && !/[\0\r\n]/.test(input['program'])) return { kind: 'external-shell', program: input['program'] }
  throw new Error('Invalid provider command')
}
export function parseProviderInstanceInput(value: unknown): ProviderInstanceInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid provider instance')
  const input = value as Record<string, unknown>
  if (input['id'] !== undefined && (typeof input['id'] !== 'string' || !input['id'] || input['id'].length > 128)) throw new Error('Invalid provider instance id')
  if (typeof input['driverId'] !== 'string' || !isAgentDriverId(input['driverId'])) throw new Error('Unknown provider driver')
  if (typeof input['displayName'] !== 'string' || !input['displayName'].trim() || input['displayName'].length > 256) throw new Error('Invalid provider display name')
  if (input['credentialMode'] !== 'external' && input['credentialMode'] !== 'managed' && input['credentialMode'] !== 'none') throw new Error('Invalid provider credential mode')
  if (typeof input['enabled'] !== 'boolean') throw new Error('Invalid provider enabled state')
  if (input['accountId'] !== null && typeof input['accountId'] !== 'string') throw new Error('Invalid provider account')
  return { ...(input['id'] === undefined ? {} : { id: input['id'] as string }), driverId: input['driverId'], displayName: input['displayName'].trim(), command: parseProviderCommandSpec(input['command']), credentialMode: input['credentialMode'], accountId: input['accountId'] as string | null, enabled: input['enabled'] }
}

export type ProviderDefinitionMetadata = AgentProviderDefinition
export function parseProviderCatalogSnapshot(value: unknown): ProviderCatalogSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid provider catalog snapshot')
  const input = value as Record<string, unknown>
  if (!Number.isSafeInteger(input['revision']) || (input['defaultInstanceId'] !== null && typeof input['defaultInstanceId'] !== 'string') || !Array.isArray(input['drivers']) || !Array.isArray(input['accounts']) || !Array.isArray(input['instances'])) throw new Error('Invalid provider catalog snapshot')
  if (/credentialRef|bindingGeneration|credentialRevision|environment|authFile/i.test(JSON.stringify(value))) throw new Error('Provider catalog snapshot contains credential material')
  return structuredClone(value) as ProviderCatalogSnapshot
}
