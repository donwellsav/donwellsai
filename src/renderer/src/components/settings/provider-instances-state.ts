import {
  PROVIDER_CREDENTIAL_MODES,
  type AgentDriverId,
  type ProviderCommandSpec,
  type ProviderCredentialMode,
  type ProviderDriverProjection,
  type ProviderInstanceInput,
  type ProviderInstanceProjection
} from '@shared/provider-authority'

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
  const problem = instance.problem ?? ('problem' in instance.driver ? instance.driver.problem : undefined)
  return {
    instanceId: instance.id,
    driverId: driverIdOf(instance.driver),
    displayName: instance.displayName,
    commandLabel: describeCommand(instance.command),
    credentialMode: instance.credentialMode,
    accountLabel: instance.account ? instance.account.displayLabel : NO_ACCOUNT_LABEL,
    enabled: instance.enabled,
    availability: instance.availability,
    ...(problem === undefined ? {} : { problem }),
    credentialStatusLabel: credentialStatusLabel(instance)
  }
}

function driverIdOf(driver: ProviderInstanceProjection['driver']): string {
  if (driver.kind === 'known') return driver.id
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

// ---------------------------------------------------------------------------
// Instance authoring (create/edit)
//
// A draft holds only what the operator typed. The daemon derives instance
// identity from `(driverId, credentialMode, canonical command spec)`, so a
// create never carries an id, and an edit always carries the revision it was
// read at so a concurrent writer is refused rather than silently overwritten.
// ---------------------------------------------------------------------------

/** The custom-command driver is the only driver whose command is authored text. */
export const CUSTOM_COMMAND_DRIVER_ID = 'custom-command'

/** The command shapes this form can author. A driver instance executes the driver's own policy. */
export type InstanceCommandKind = 'driver' | 'external-shell'

/** One editable instance draft. `id` is null for a create, and `expectedRevision` is null with it. */
export type ProviderInstanceDraft = {
  readonly id: string | null
  readonly expectedRevision: number | null
  readonly driverId: AgentDriverId
  readonly displayName: string
  readonly credentialMode: ProviderCredentialMode
  readonly commandKind: InstanceCommandKind
  readonly program: string
  readonly accountId: string | null
  readonly enabled: boolean
}

/** A driver the catalog can configure: the known projection, never the raw-unknown fallback. */
export type KnownProviderDriver = Extract<ProviderDriverProjection, { kind: 'known' }>

/** True for a driver this form can configure. */
export function isKnownDriver(driver: ProviderDriverProjection): driver is KnownProviderDriver {
  return driver.kind === 'known'
}

/** The drivers this form may offer: only registered drivers can be configured. */
export function selectableDrivers(drivers: readonly ProviderDriverProjection[]): readonly KnownProviderDriver[] {
  return drivers.filter(isKnownDriver)
}

/**
 * The credential modes a driver actually supports. Managed access is offered
 * only where the driver reports certification, so the form cannot author a mode
 * the daemon would then refuse.
 */
export function selectableCredentialModes(driver: KnownProviderDriver | undefined): readonly ProviderCredentialMode[] {
  if (!driver) return ['external']
  return PROVIDER_CREDENTIAL_MODES.filter(mode => driver.credentialModes.includes(mode))
}

/** A blank draft. The first selectable driver seeds it so the form is immediately usable. */
export function freshInstanceDraft(drivers: readonly ProviderDriverProjection[]): ProviderInstanceDraft {
  const driver = selectableDrivers(drivers)[0]
  const driverId = (driver?.id ?? CUSTOM_COMMAND_DRIVER_ID) as AgentDriverId
  return {
    id: null,
    expectedRevision: null,
    driverId,
    displayName: '',
    credentialMode: selectableCredentialModes(driver)[0] ?? 'external',
    commandKind: driverId === CUSTOM_COMMAND_DRIVER_ID ? 'external-shell' : 'driver',
    program: '',
    accountId: null,
    enabled: true
  }
}

/** Project an existing instance into an editable draft, preserving the revision for the update. */
export function instanceDraftFromProjection(instance: ProviderInstanceProjection): ProviderInstanceDraft {
  return {
    id: instance.id,
    expectedRevision: instance.revision,
    driverId: (instance.driver.kind === 'known' ? instance.driver.id : CUSTOM_COMMAND_DRIVER_ID) as AgentDriverId,
    displayName: instance.displayName,
    credentialMode: instance.credentialMode,
    commandKind: instance.command.kind === 'driver' ? 'driver' : 'external-shell',
    program: instance.command.kind === 'external-shell' ? instance.command.program : '',
    accountId: instance.account?.id ?? null,
    enabled: instance.enabled
  }
}

/** Switch the draft's driver, keeping the command shape and credential mode valid for it. */
export function withDriver(draft: ProviderInstanceDraft, driver: KnownProviderDriver | undefined): ProviderInstanceDraft {
  const driverId = (driver?.id ?? CUSTOM_COMMAND_DRIVER_ID) as AgentDriverId
  const modes = selectableCredentialModes(driver)
  return {
    ...draft,
    driverId,
    credentialMode: modes.includes(draft.credentialMode) ? draft.credentialMode : (modes[0] ?? 'external'),
    commandKind: driverId === CUSTOM_COMMAND_DRIVER_ID ? 'external-shell' : 'driver'
  }
}

/** The reason a draft cannot be saved, or null when it is ready. */
export function instanceDraftError(draft: ProviderInstanceDraft): string | null {
  if (draft.displayName.trim().length === 0) return 'Enter a display name for this instance.'
  if (draft.displayName.length > 256) return 'The display name must be 256 characters or fewer.'
  // A managed credential binds to one exact account, so the account is required
  // before the instance can be saved in that mode.
  if (draft.credentialMode === 'managed' && draft.accountId === null) return 'Select an account for a managed credential.'
  if (draft.commandKind === 'external-shell' && draft.program.trim().length === 0) return 'Enter the program this custom command runs.'
  if (draft.commandKind === 'external-shell' && draft.program.length > 4096) return 'The program must be 4096 characters or fewer.'
  return null
}

/**
 * Build the exact request body, or null when the draft is not savable. The
 * result carries exactly the documented `ProviderInstanceInput` fields and
 * never an invented id: the daemon derives identity from the tuple.
 */
export function providerInstanceInputFromDraft(draft: ProviderInstanceDraft): ProviderInstanceInput | null {
  if (instanceDraftError(draft) !== null) return null
  const command: ProviderCommandSpec = draft.commandKind === 'driver'
    ? { kind: 'driver', driverId: draft.driverId }
    : { kind: 'external-shell', program: draft.program.trim() }
  return {
    driverId: draft.driverId,
    displayName: draft.displayName.trim(),
    command,
    credentialMode: draft.credentialMode,
    accountId: draft.credentialMode === 'managed' ? draft.accountId : null,
    enabled: draft.enabled
  }
}
