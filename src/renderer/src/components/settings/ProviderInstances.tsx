import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProviderCatalogSnapshot, ProviderInstanceProjection } from '@shared/provider-authority'
import type { CredentialStatus } from '@shared/provider-secret-broker'
import { Icon } from '../Icon'
import { ModalDialog } from '../ModalDialog'
import {
  EMPTY_CREDENTIAL_VALUE,
  buildInstanceRowProps,
  credentialSaveOutcome,
  freshCredentialDraft,
  providerInstancesError,
  updateCredentialDraft,
  type CredentialPasswordDraft,
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
    return { kind: 'available', message: 'External Authentication; No Managed Account Is Required' }
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
      setRowErrors(current => ({ ...current, [key]: 'This Account Is No Longer In The Provider Catalog. Refresh provider instances And Try Again.' }))
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
      setRevocationError('This Account Is No Longer In The Provider Catalog. Close This Confirmation And Refresh provider instances.')
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
        Instances Come From The Daemon-Owned Provider Catalog. This View Shows Its Sanitized Projection Only:
        A Stored Credential Value Is Never Sent To This Window And Never Rendered Here.
      </p>

      {unavailableDefault && (
        <p className="provider-instances-notice" role="status">
          <Icon name="alert" size={14} />
          <span>
            The Default Instance <strong>{unavailableDefault.displayName}</strong> Is Available.
            Launch Stays Blocked Until It Is Repaired; No Other Instance Was Selected For You.
          </span>
        </p>
      )}

      {rows.length === 0 && <p className="provider-instances-empty" role="status">No provider instances Are Configured.</p>}

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
                      title={onEdit ? 'Edit ' + item.displayName : 'Provider catalog editing Is Not Available In This Build'}
                      onClick={() => onEdit?.(instance)}
                    >Edit</button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={busy === key || !onSetDefault || isDefault}
                      title={onSetDefault ? (isDefault ? 'Already The Default Instance' : 'Make ' + item.displayName + ' The Default') : 'Provider catalog selection Is Not Available In This Build'}
                      onClick={() => onSetDefault?.(instance)}
                    >Set as default</button>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      disabled={busy === key || !onRemove}
                      title={onRemove ? 'Remove ' + item.displayName : 'Provider catalog removal Is Not Available In This Build'}
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
                            ? 'Revoke The Stored Credential For ' + item.displayName + ' (' + account.id + ')'
                            : 'No Stored Credential To Revoke'}
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
                      <span>Link An Account Before Storing A Managed Credential For This Instance.</span>
                    </p>
                  )}
                  {!managed && (
                    <p className="provider-instances-hint">
                      <span>External Authentication: This Instance Signs In With Its Own Credentials, So None Is Stored Here.</span>
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
          <h3 id="provider-instance-revoke-title" className="modal-title">Revoke This Stored Credential?</h3>
          <p>
            The Next Launch Of Exactly This Instance And Account Is Blocked Until A New Credential Is Saved.
            Every Other Instance And Account Is Unaffected.
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
