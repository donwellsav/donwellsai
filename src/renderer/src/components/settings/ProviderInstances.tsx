import { useProviderInstances } from '../../hooks/use-provider-instances'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProviderAccount, ProviderCatalogSnapshot, ProviderCredentialMode, ProviderDriverProjection, ProviderInstanceProjection } from '@shared/provider-authority'
import type { CredentialStatus } from '@shared/provider-secret-broker'
import { Icon } from '../Icon'
import { ModalDialog } from '../ModalDialog'
import {
  CUSTOM_COMMAND_DRIVER_ID,
  EMPTY_CREDENTIAL_VALUE,
  buildInstanceRowProps,
  credentialSaveOutcome,
  freshCredentialDraft,
  freshInstanceDraft,
  instanceDraftError,
  instanceDraftFromProjection,
  providerInstanceInputFromDraft,
  providerInstancesError,
  selectableCredentialModes,
  selectableDrivers,
  updateCredentialDraft,
  withDriver,
  type CredentialPasswordDraft,
  type ProviderInstanceDraft,
  type ProviderInstancesError,
  type ProviderInstancesRowProps
} from './provider-instances-state'
import './provider-instances.css'

/**
 * The sanitized provider-instance management surface (Task 4, step 3).
 *
 * Data-flow contract:
 * - `snapshot` is the daemon-owned catalog's sanitized projection. By
 *   construction it carries no credential Reference, Binding Generation,
 *   Launch Environment, Or Auth File (`assertNoCredentialKeys` in
 *   `src/shared/provider-authority.ts`), So this component *Can* Receive A
 *   Stored Credential Value... but the Daemon Projection Strips These, So
 *   None Is Presented Here.
 * - `CredentialStatus` Is The Only Credential-Shaped Data It Ever Reads, And
 *   It Is State/Revision/Backend/Timestamp Only — Never Material.
 * - The One Secret That Ever Exists In Renderer State Is The Value The Operator
 *   Types Into The Password Field. It Is Wiped In `finally` After Every Save
 *   And Is Deliberately NOT Routed Through `guiDraftMap` (Persisted To Disk).
 */

/** A render-safe row paired with The Projection It Was Derived From. */
type RowContext = { readonly instance: ProviderInstanceProjection; readonly props: ProviderInstancesRowProps }

/** The Exact Instance/Account A Pending Revocation Targets. */
type RevocationTarget = {
  readonly instance: ProviderInstanceProjection
  readonly driverId: string
  readonly accountId: string
  readonly accountLabel: string
}

export type ProviderInstancesProps = {
  /** The Daemon-Sanitized Catalog Snapshot: Display Data Only, No Credential Material. */
  snapshot: ProviderCatalogSnapshot
  /** Reports A Refreshed Snapshot After A Credential Write Or Revocation. */
  onSnapshot?(snapshot: ProviderCatalogSnapshot): void
  /**
   * Catalog Identity/Selection Mutations. Supplied By The Caller Once The
   * Renderer Catalog Surface Exists; The Controls Stay Visible (Disabled With A
   * Reason) Rather Than Disappearing, So Every Instance Remains Editable + Removable.
   */
  onEdit?(instance: ProviderInstanceProjection): void
  onRemove?(instance: ProviderInstanceProjection): void
  onSetDefault?(instance: ProviderInstanceProjection): void
}

/** Ids Are Daemon-Generated Opaque Strings That Reject NUL, So NUL Is A Safe Composite Separator. */
function credentialKey(providerInstanceId: string, accountId: string): string {
  return providerInstanceId + '\u0000' + accountId
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** Drop One Key Without Mutating The Previous Record (Keeps React State Referentially Honest). */
function withoutKey(record: Record<string, string>, key: string): Record<string, string> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}

/**
 * The Row's Health Line. `providerInstancesError` Owns The Wording; An External
 * Instance Legitimately Has No Managed Account, So The Helper's
 * Configuration-Required Wording Would Misreport A Healthy External Row.
 */
function rowHealth(instance: ProviderInstanceProjection): ProviderInstancesError {
  const health = providerInstancesError(instance)
  if (health.kind === 'missing-config' && instance.credentialMode !== 'managed') {
    return { kind: 'available', message: 'External authentication; no managed account is required' }
  }
  return health
}

/** Display-Only Credential Status. A Stored Value Has No Representation Here. */
function statusSummary(status: CredentialStatus): string {
  const base = status.state + ' · ' + status.backend + ' · revision ' + status.revision + ' · updated '
    + new Date(status.updatedAt).toLocaleString()
  return status.problem === undefined ? base : base + ' · ' + status.problem
}

export function ProviderInstances({ snapshot, onSnapshot, onEdit, onRemove, onSetDefault }: ProviderInstancesProps) {
  const [drafts, setDrafts] = useState<Record<string, CredentialPasswordDraft>>({})
  const [statuses, setStatuses] = useState<Record<string, CredentialStatus>>({})
  const [statusErrors, setStatusErrors] = useState<Record<string, string>>({})
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [revocation, setRevocation] = useState<RevocationTarget | null>(null)
  const [revocationError, setRevocationError] = useState<string | null>(null)
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot

  const rows = useMemo<RowContext[]>(() => {
    const built = buildInstanceRowProps(snapshot.instances)
    const paired: RowContext[] = []
    for (const [index, instance] of snapshot.instances.entries()) {
      const props = built[index]
      if (props) paired.push({ instance, props })
    }
    return paired
  }, [snapshot])

  /** Managed Instances With A Bound Account Are The Only Rows That Can Hold A Stored Credential. */
  const refreshTargetsRef = useRef<readonly { providerInstanceId: string; accountId: string }[]>([])
  refreshTargetsRef.current = useMemo(
    () => snapshot.instances.flatMap(instance =>
      instance.credentialMode === 'managed' && instance.account !== null
        ? [{ providerInstanceId: instance.id, accountId: instance.account.id }]
        : []),
    [snapshot]
  )

  const refreshStatus = async (providerInstanceId: string, accountId: string): Promise<void> => {
    const key = credentialKey(providerInstanceId, accountId)
    try {
      const result = await window.donwells.providerCredentialStatus({ providerInstanceId, accountId })
      setStatuses(current => ({ ...current, [key]: result.status }))
      setStatusErrors(current => withoutKey(current, key))
    } catch (cause) {
      setStatusErrors(current => ({ ...current, [key]: errorMessage(cause) }))
    }
  }

  // Keyed On The Catalog Revision, Not On The Snapshot Object: A Refreshed
  // Snapshot Is A New Object Each Render, And Keying On Identity Would Loop.
  useEffect(() => {
    let live = true
    for (const target of refreshTargetsRef.current) {
      const key = credentialKey(target.providerInstanceId, target.accountId)
      void window.donwells.providerCredentialStatus(target).then(
        result => {
          if (!live) return
          setStatuses(current => ({ ...current, [key]: result.status }))
          setStatusErrors(current => withoutKey(current, key))
        },
        cause => {
          if (!live) return
          setStatusErrors(current => withoutKey(current, key))
        }
      )
    }
    return () => { live = false }
  }, [snapshot.revision])

  const applyCredentialResult = (key: string, result: { status: CredentialStatus; snapshot: ProviderCatalogSnapshot }): void => {
    setStatuses(current => ({ ...current, [key]: result.status }))
    onSnapshot?.(result.snapshot)
  }

  const saveCredential = async (instance: ProviderInstanceProjection, accountId: string): Promise<void> => {
    const key = credentialKey(instance.id, accountId)
    const draft = drafts[key] ?? freshCredentialDraft(instance.id)
    if (busy !== null || draft.value === EMPTY_CREDENTIAL_VALUE) return
    const account = snapshotRef.current.accounts.find(candidate => candidate.id === accountId)
    if (!account) {
      setRowErrors(current => ({ ...current, [key]: 'This account is no longer in the provider catalog. Refresh provider instances and try again.' }))
      return
    }
    setBusy(key)
    setRowErrors(current => withoutKey(current, key))
    try {
      // Exactly One Action-Specific Write Request. The Response Carries The
      // Sanitized Snapshot And A Status; No Ref, Generation, Or Value Returns.
      const result = await window.donwells.providerCredentialWrite({
        providerInstanceId: instance.id,
        accountId,
        expectedInstanceRevision: instance.revision,
        expectedAccountRevision: account.revision,
        secret: draft.value,
      })
      applyCredentialResult(key, result)
      await refreshStatus(instance.id, accountId)
    } catch (cause) {
      setRowErrors(current => ({ ...current, [key]: errorMessage(cause) }))
    } finally {
      // The Typed Value Is Dropped On Every Outcome, Success Or Failure, So A
      // Failed Or Raced Write Never Leaves Plaintext In Renderer State.
      setDrafts(current => ({
        ...current,
        [key]: credentialSaveOutcome(current[key] ?? freshCredentialDraft(instance.id)).draft
      }))
      setBusy(null)
    }
  }
  const confirmRevocation = async (): Promise<void> => {
    if (!revocation) return
    const { instance, accountId } = revocation
    const key = credentialKey(instance.id, accountId)
    const account = snapshotRef.current.accounts.find(candidate => candidate.id === accountId)
    if (!account) {
      setRevocationError('This account is no longer in the provider catalog. Close this confirmation and refresh provider instances.')
      return
    }
    setBusy(key)
    setRevocationError(null)
    try {
      const result = await window.donwells.providerCredentialRevoke({
        providerInstanceId: instance.id,
        accountId,
        expectedInstanceRevision: instance.revision,
        expectedAccountRevision: account.revision,
      })
      applyCredentialResult(key, result)
      setRevocation(null)
      await refreshStatus(instance.id, accountId)
    } catch (cause) {
      setRevocationError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const unavailableDefault = snapshot.instances.find(
    instance => instance.id === snapshot.defaultInstanceId && instance.availability === 'unavailable'
  ) ?? null

  return (
    <section className="provider-instances" aria-label="Provider instances">
      <p className="provider-instances-intro">
        Instances come from the daemon-owned provider catalog. This view shows its sanitized projection only:
        a stored credential value is never sent to this window and never rendered here.
      </p>

      {unavailableDefault && (
        <p className="provider-instances-notice" role="status">
          <Icon name="alert" size={14} />
          <span>
            The default instance <strong>{unavailableDefault.displayName}</strong> is unavailable.
            Launch stays blocked until it is repaired; no other instance was selected for you.
          </span>
        </p>
      )}

      {rows.length === 0 && <p className="provider-instances-empty" role="status">No provider instances are configured.</p>}

      {rows.length > 0 && (
        <ul className="provider-instances-list">
          {rows.map(({ instance, props }) => {
            const { rowId, item } = props
            const account = instance.account
            const key = account === null ? rowId : credentialKey(instance.id, account.id)
            const isDefault = snapshot.defaultInstanceId === instance.id
            const managed = instance.credentialMode === 'managed'
            const health = rowHealth(instance)
            const status = statuses[key]
            const draft = drafts[key] ?? freshCredentialDraft(instance.id)
            const rowBusy = busy === key
            return (
              <li key={rowId} className={'provider-instances-row is-' + item.availability} data-instance-id={instance.id}>
                <div className="provider-instances-row-head">
                  <div className="provider-instances-identity">
                    <strong>{item.displayName}</strong>
                    <span className="provider-instances-badges">
                      {isDefault && <span className="provider-instances-badge is-default">Default</span>}
                      <span className={'provider-instances-badge is-' + item.availability}>
                        {item.availability === 'available' ? 'Available' : 'Unavailable'}
                      </span>
                      <span className="provider-instances-badge">{item.enabled ? 'Enabled' : 'Disabled'}</span>
                    </span>
                  </div>
                  <div className="provider-instances-row-actions">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={busy === key || !onEdit}
                      title={onEdit ? 'Edit ' + item.displayName : 'Provider catalog editing is not available in this build'}
                      onClick={() => onEdit?.(instance)}
                    >Edit</button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={busy === key || !onSetDefault || isDefault}
                      title={onSetDefault ? (isDefault ? 'Already the default instance' : 'Make ' + item.displayName + ' the default') : 'Provider catalog selection is not available in this build'}
                      onClick={() => onSetDefault?.(instance)}
                    >Set as default</button>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      disabled={busy === key || !onRemove}
                      title={onRemove ? 'Remove ' + item.displayName : 'Provider catalog removal is not available in this build'}
                      onClick={() => onRemove?.(instance)}
                    >Remove</button>
                  </div>
                </div>

                <dl className="provider-instances-facts">
                  <div><dt>Driver</dt><dd>{item.driverId}</dd></div>
                  <div><dt>Command</dt><dd><code title={item.commandLabel}>{item.commandLabel}</code></dd></div>
                  <div><dt>Credential mode</dt><dd>{item.credentialMode}</dd></div>
                  <div><dt>Account</dt><dd>{item.accountLabel}</dd></div>
                  <div><dt>Enabled</dt><dd>{item.enabled ? 'Yes' : 'No'}</dd></div>
                  <div><dt>Credential status</dt><dd>{item.credentialStatusLabel}</dd></div>
                  <div><dt>Health</dt><dd className={'provider-instances-health is-' + health.kind}>{health.message}</dd></div>
                </dl>

                {item.problem && <p className="provider-instances-problem" role="status">{item.problem}</p>}

                <div className="provider-instances-credential">
                  <div className="provider-instances-credential-head">
                    <strong>Credential</strong>
                    <span className="provider-instances-credential-status">{item.credentialStatusLabel}</span>
                  </div>
                  {status && <p className="provider-instances-credential-detail">Stored status: {statusSummary(status)}</p>}
                  {statusErrors[key] && <p className="provider-instances-problem" role="alert">{statusErrors[key]}</p>}
                  {rowErrors[key] && <p className="provider-instances-problem" role="alert">{rowErrors[key]}</p>}

                  {managed && account !== null && (
                    <>
                      <label className="provider-instances-field">
                        <span>New credential</span>
                        <input
                          className="input"
                          type="password"
                          autoComplete="new-password"
                          spellCheck={false}
                          maxLength={4096}
                          placeholder="Enter a new credential"
                          aria-label={'New credential for ' + item.displayName}
                          disabled={busy === key}
                          value={draft.value}
                          onChange={event => {
                            const value = event.currentTarget.value
                            setDrafts(current => ({
                              ...current,
                              [key]: updateCredentialDraft(current[key] ?? freshCredentialDraft(instance.id), value)
                            }))
                          }}
                        />
                      </label>
                      <div className="provider-instances-credential-actions">
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={busy === key || draft.value === EMPTY_CREDENTIAL_VALUE}
                          onClick={() => void saveCredential(instance, account.id)}
                        >{busy === key ? 'Saving…' : 'Save credential'}</button>
                        <button
                          type="button"
                          className="btn btn-danger btn-sm"
                          disabled={busy === key || status?.state !== 'present'}
                          title={status?.state === 'present'
                            ? 'Revoke the stored credential for ' + item.displayName + ' (' + account.id + ')'
                            : 'No stored credential to revoke'}
                          onClick={() => {
                            setRevocationError(null)
                            setRevocation({ instance, driverId: item.driverId, accountId: account.id, accountLabel: item.accountLabel })
                          }}
                        >Revoke…</button>
                      </div>
                    </>
                  )}

                  {managed && account === null && (
                    <p className="provider-instances-hint">
                      <Icon name="alert" size={13} />
                      <span>Link an account before storing a managed credential for this instance.</span>
                    </p>
                  )}
                  {!managed && (
                    <p className="provider-instances-hint">
                      <span>External authentication: this instance signs in with its own credentials, so none is stored here.</span>
                    </p>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {revocation && (
        <ModalDialog
          className="modal provider-instances-confirm"
          labelledBy="provider-instance-revoke-title"
          onClose={() => { if (busy === null) { setRevocation(null); setRevocationError(null) } }}
        >
          <span className="provider-instances-eyebrow">Confirm credential revocation</span>
          <h3 id="provider-instance-revoke-title" className="modal-title">Revoke this stored credential?</h3>
          <p>
            The next launch of exactly this instance and account is blocked until a new credential is saved.
            Every other instance and account is unaffected.
          </p>
          <dl className="provider-instances-target">
            <div><dt>Provider</dt><dd>{revocation.instance.displayName}</dd></div>
            <div><dt>Driver</dt><dd>{revocation.driverId}</dd></div>
            <div><dt>Account</dt><dd>{revocation.accountLabel}</dd></div>
            <div><dt>Instance</dt><dd><code>{revocation.instance.id}</code></dd></div>
            <div><dt>Account ID</dt><dd><code>{revocation.accountId}</code></dd></div>
          </dl>
          {revocationError && <p className="provider-instances-problem" role="alert">{revocationError}</p>}
          <div className="provider-instances-confirm-actions">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy !== null}
              onClick={() => { setRevocation(null); setRevocationError(null) }}
            >Keep credential</button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy !== null}
              onClick={() => { void confirmRevocation() }}
            >{busy !== null ? 'Revoking…' : 'Revoke Credential'}</button>
          </div>
        </ModalDialog>
      )}
    </section>
  )
}
/**
 * The create/edit form (Task 4, step 3).
 *
 * It authors exactly the documented `ProviderInstanceInput` fields through the
 * pure draft helpers, so validation and the request body are unit-testable
 * without a DOM. A refusal from the daemon is shown here rather than replacing
 * the list, and the form stays open so the operator can correct it.
 */
export function ProviderInstanceForm({ draft, drivers, accounts, saving, error, onChange, onSubmit, onCancel }: {
  readonly draft: ProviderInstanceDraft
  readonly drivers: readonly ProviderDriverProjection[]
  readonly accounts: readonly ProviderAccount[]
  readonly saving: boolean
  readonly error: string | null
  onChange(draft: ProviderInstanceDraft): void
  onSubmit(): void
  onCancel(): void
}) {
  const selectable = selectableDrivers(drivers)
  const selectedDriver = selectable.find(driver => driver.id === draft.driverId)
  const modes = selectableCredentialModes(selectedDriver)
  const invalid = instanceDraftError(draft) !== null
  const editing = draft.id !== null

  return (
    <section className="provider-instances-form" aria-label={editing ? 'Edit provider instance' : 'New provider instance'}>
      <h3 className="provider-instances-form-title">{editing ? 'Edit provider instance' : 'New provider instance'}</h3>

      <label className="provider-instances-field">
        <span>Driver</span>
        <select
          className="settings-select"
          value={draft.driverId}
          disabled={saving}
          onChange={event => onChange(withDriver(draft, selectable.find(driver => driver.id === event.currentTarget.value)))}
        >
          {selectable.map(driver => <option key={driver.id} value={driver.id}>{driver.displayName}</option>)}
          {selectable.length === 0 && <option value={CUSTOM_COMMAND_DRIVER_ID}>Custom command</option>}
        </select>
      </label>

      <label className="provider-instances-field">
        <span>Display name</span>
        <input
          className="input"
          type="text"
          maxLength={256}
          disabled={saving}
          value={draft.displayName}
          aria-label="Instance display name"
          onChange={event => onChange({ ...draft, displayName: event.currentTarget.value })}
        />
      </label>

      <label className="provider-instances-field">
        <span>Credential mode</span>
        <select
          className="settings-select"
          value={draft.credentialMode}
          disabled={saving}
          onChange={event => onChange({ ...draft, credentialMode: event.currentTarget.value as ProviderCredentialMode })}
        >
          {modes.map(mode => <option key={mode} value={mode}>{mode}</option>)}
        </select>
      </label>

      {draft.commandKind === 'external-shell' && (
        <label className="provider-instances-field">
          <span>Program</span>
          <input
            className="input"
            type="text"
            maxLength={4096}
            disabled={saving}
            value={draft.program}
            aria-label="Custom command program"
            placeholder="e.g. /usr/local/bin/my-agent --flag"
            onChange={event => onChange({ ...draft, program: event.currentTarget.value })}
          />
        </label>
      )}

      {draft.credentialMode === 'managed' && (
        <label className="provider-instances-field">
          <span>Account</span>
          <select
            className="settings-select"
            value={draft.accountId ?? ''}
            disabled={saving}
            onChange={event => onChange({ ...draft, accountId: event.currentTarget.value === '' ? null : event.currentTarget.value })}
          >
            <option value="">Select an account</option>
            {accounts.map(account => <option key={account.id} value={account.id}>{account.displayLabel}</option>)}
          </select>
        </label>
      )}

      <label className="provider-instances-field provider-instances-field-inline">
        <input
          type="checkbox"
          checked={draft.enabled}
          disabled={saving}
          aria-label="Instance enabled"
          onChange={event => onChange({ ...draft, enabled: event.currentTarget.checked })}
        />
        <span>Enabled</span>
      </label>

      {instanceDraftError(draft) !== null && <p className="provider-instances-hint" role="status">{instanceDraftError(draft)}</p>}
      {error !== null && <p className="provider-instances-problem" role="alert">{error}</p>}

      <div className="provider-instances-form-actions">
        <button type="button" className="btn btn-secondary" disabled={saving} onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={saving || invalid} onClick={onSubmit}>
          {saving ? 'Saving…' : editing ? 'Save changes' : 'Create instance'}
        </button>
      </div>
    </section>
  )
}

/** Mounts the daemon-backed provider catalog and wires the panel's authoring/refresh/remove/setDefault handlers (task-4 steps 3-4). */
export function ProviderInstancesState() {
  const { snapshot, error, refresh, create, update, remove, setDefault } = useProviderInstances()
  const [draft, setDraft] = useState<ProviderInstanceDraft | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = async (): Promise<void> => {
    if (!snapshot || draft === null) return
    const input = providerInstanceInputFromDraft(draft)
    if (input === null) return
    setSaving(true)
    setFormError(null)
    try {
      // A create never invents an id; the daemon derives it from the tuple. An
      // edit sends the revision it was read at, so a concurrent writer loses.
      if (draft.id === null) await create(input)
      else await update(draft.id, draft.expectedRevision ?? 1, input)
      setDraft(null)
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSaving(false)
    }
  }

  if (error !== null && snapshot === null) {
    return (
      <p className="provider-instances-problem" role="alert">
        <span>{error}</span>
      </p>
    )
  }
  if (!snapshot) return <p className="provider-instances-empty" role="status">Loading provider instances…</p>

  if (draft !== null) {
    return (
      <ProviderInstanceForm
        draft={draft}
        drivers={snapshot.drivers}
        accounts={snapshot.accounts}
        saving={saving}
        error={formError}
        onChange={next => setDraft(next)}
        onSubmit={() => void submit()}
        onCancel={() => { setDraft(null); setFormError(null) }}
      />
    )
  }

  return (
    <>
      <div className="provider-instances-toolbar">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => { setFormError(null); setDraft(freshInstanceDraft(snapshot.drivers)) }}
        >New provider instance</button>
      </div>
      <ProviderInstances
        snapshot={snapshot}
        onSnapshot={refresh}
        onEdit={(instance) => { setFormError(null); setDraft(instanceDraftFromProjection(instance)) }}
        onRemove={(instance) => { void remove(instance.id, instance.revision).catch(caught => setFormError(caught instanceof Error ? caught.message : String(caught))) }}
        onSetDefault={(instance) => { void setDefault(instance.id, instance.revision).catch(caught => setFormError(caught instanceof Error ? caught.message : String(caught))) }}
      />
      {formError !== null && <p className="provider-instances-problem" role="alert">{formError}</p>}
    </>
  )
}
