import { type ProviderCommandSpec, type ProviderInstanceProjection } from '@shared/provider-authority'

/** The password field is Empty By Design (`autocomplete="new-password"`). It NEVER Seeds A Current Value. */
export const EMPTY_CREDENTIAL_VALUE = ''

/** Shown When A Provider Instance Has No Bound Account (The Configuration-Required Projection). */
export const NO_ACCOUNT_LABEL = 'No Account'

/** Renderer-safe display projection of one provider instance.
 * It Carries NO Stored Credential Ref Or Disposable Secret Marker — The Daemon-Side Snapshot Already Strips These. */
export type ProviderInstanceListItem = {
  instanceId: string
  driverId: string
  displayName: string
  commandLabel: string
  credentialMode: ProviderInstanceProjection['credentialMode']
  accountLabel: string
  enabled: boolean
  availability: ProviderInstanceProjection['availability']
  problem?: string
  credentialStatusLabel: string
}

/** The render-safe props for one management row (the component maps projections onto These). */
export type ProviderInstancesRowProps = { readonly rowId: string; readonly item: ProviderInstanceListItem }

/** A credential-password draft. The Value Is Empty Until Typed (Never Copied From A Stored Ref). */
export type CredentialPasswordDraft = { readonly instanceId: string; readonly value: string }

/** The outcome Of A Successful Credential Write. The Draft Clears (A `finally` Reset). */
export type CredentialSaveOutcome = { readonly draft: CredentialPasswordDraft; readonly clearsField: boolean }

/** A readable label For The Instance's Command (driver id OR External Program/Arguments). */
export function describeCommand(command: ProviderCommandSpec): string {
  if (command.kind === 'driver') return command.driverId
  if (command.kind === 'external-shell') return command.program
  const argv = `${command.executable.executable} ${command.executable.args.join(' ')}`.trim()
  return argv.length > 0 ? argv : command.executable.executable
}

/** Map A provider projection Onto Its display-only list item (Credential Material Already Stripped By The Daemon). */
export function serializeInstanceView(instance: ProviderInstanceProjection): ProviderInstanceListItem {
  return {
    instanceId: instance.id,
    driverId: labelOfDriver(instance.driver),
    displayName: instance.displayName,
    commandLabel: describeCommand(instance.command),
    credentialMode: instance.credentialMode,
    accountLabel: instance.account ? instance.account.displayLabel : NO_ACCOUNT_LABEL,
    enabled: instance.enabled,
    availability: instance.availability,
    ...(instance.problem === undefined ? {} : { problem: instance.problem }),
    credentialStatusLabel: credentialStatusLabel(instance)
  }
}

function labelOfDriver(driver: ProviderInstanceProjection['driver']): string {
  if (driver.kind === 'known') return driver.displayName
  // An Unregistered Driver Barely Maps; Fall Back To Its Raw Identifier.
  return driver.rawDriverId.split('/').at(-1) ?? driver.rawDriverId
}

function credentialStatusLabel(instance: ProviderInstanceProjection): string {
  if (instance.credentialMode === 'managed' && instance.account !== null) return 'Configured'
  if (instance.credentialMode === 'managed') return 'Needs Account'
  return instance.credentialMode.toUpperCase() + ' (external)'
}

/** Build The render-safe row props. Unavailable Instances Stay Row-Listed (The UI Never Silently Removes/Replaces). */
export function buildInstanceRowProps(instances: readonly ProviderInstanceProjection[]): ProviderInstancesRowProps[] {
  return instances.map(instance => ({ rowId: instance.id, item: serializeInstanceView(instance) }))
}

/** The Fresh Credential Draft Is Empty (The Field Never Pre-Fills With A Stored Value). */
export function freshCredentialDraft(instanceId: string): CredentialPasswordDraft {
  return { instanceId, value: EMPTY_CREDENTIAL_VALUE }
}

/** Typing Updates The Draft In Place. The Field Never Reflects A Seeded Current Value (Bound To The Typed Input). */
export function updateCredentialDraft(draft: CredentialPasswordDraft, value: string): CredentialPasswordDraft {
  return { ...draft, value }
}

/** After A Successful Write The Draft Clears (The `finally` Reset). */
export function credentialSaveOutcome(draft: CredentialPasswordDraft): CredentialSaveOutcome {
  return { draft: freshCredentialDraft(draft.instanceId), clearsField: true }
}

/** The Render-Safe Error Projection. Its Message Carries NO Byte Marker (`REDACTED`/REF) — Only Literal Words. */
export type ProviderInstancesError = { readonly kind: 'missing-config' | 'available' | 'unavailable'; readonly message: string }

export function providerInstancesError(instance: ProviderInstanceProjection): ProviderInstancesError {
  // An Instance Without A Bound Account Needs Configuration (The Configuration-Required Projection).
  if (instance.account === null) {
    return { kind: 'missing-config', message: `No account linked for ${instance.displayName}` }
  }
  if (instance.availability === 'available') {
    return { kind: 'available', message: `${instance.displayName} ready to launch` }
  }
  return { kind: 'unavailable', message: `${instance.displayName} unavailable (review credentials)` }
}

/** Re-export A Command-Spec Negator For Optional External-Argv Rows (Keeps The Module Self-Contained). */
export function externalArgs(command: Extract<ProviderCommandSpec, { kind: 'external-argv' }>): { executable: string; args: readonly String[] } {
  return { executable: command.executable.executable, args: [...command.executable.args] }
}
