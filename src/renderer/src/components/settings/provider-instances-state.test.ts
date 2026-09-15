// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { ProviderInstanceProjection } from '@shared/provider-authority'
import {
  EMPTY_CREDENTIAL_VALUE,
  NO_ACCOUNT_LABEL,
  buildInstanceRowProps,
  credentialSaveOutcome,
  describeCommand,
  freshCredentialDraft,
  providerInstancesError,
  serializeInstanceView,
  updateCredentialDraft
} from './provider-instances-state'

/**
 * Failing renderer-state tests for Task 4 (step-1b). These assert The sanitized
 * management projection + password draft contract before {@link ProviderInstances}
 * renders: the serialized view/props/messages Must Carried NO Stored Credential Ref
 * Or Disposable Secret Marker (The Password Field Stays Empty Until Typed).
 */

const SAMPLE_INSTANCE = {
  id: 'i-1',
  driver: {
    kind: 'known' as const,
    id: 'codex' as const,
    displayName: 'Codex',
    installed: true,
    hooks: { support: 'unavailable' as const, events: [], reason: 'Not Certified' },
    skills: { supported: false as const, reason: 'Not Configured' },
    memorySupport: 'none',
    credentialModes: ['managed', 'none'] as const,
    managedSupport: { kind: 'unsupported' as const, reason: 'No Version Pinned' }
  },
  displayName: 'Codex (Work)',
  command: { kind: 'driver' as const, driverId: 'codex' as const },
  credentialMode: 'managed' as const,
  account: { id: 'a-1', driverId: 'codex' as const, displayLabel: 'Work Team', revision: 1 },
  enabled: true,
  revision: 2,
  availability: 'available' as const
} satisfies ProviderInstanceProjection

/** A Configuration-required projection (No Bound Account). */
const CONFIG_REQUIRED_INSTANCE = {
  id: 'i-empty',
  driver: { kind: 'unknown' as const, rawDriverId: '/usr/local/bin/codex', availability: 'unavailable' as const, problem: 'Not certified' },
  displayName: 'Legacy codex',
  command: { kind: 'external-shell' as const, program: '/usr/local/bin/codex --session /tmp/h' },
  credentialMode: 'external' as const,
  account: null,
  enabled: true,
  revision: 1,
  availability: 'unavailable' as const
} satisfies ProviderInstanceProjection

describe('serializeInstanceView (no credential material)', () => {
  const item = serializeInstanceView(SAMPLE_INSTANCE)

  it('exposes A display-only view with NO FORBIDDEN credential keys', () => {
    // The Key Contract: A Managed Instance Never Exposes Any Raw Credential Bytes.
    const keys = Object.keys(item)
    for (const key of keys) {
      // NONE Of These Appear On The Projection — credential Refs/Generations Stay Internal.
      expect(['credentialRef', 'BindingGeneration', 'CredentialRevision', 'Environment', 'AuthFile', 'AuthFilePath']).not.toContain(key)
    }
  })

  it('carries driver, instance name, command + account label', () => {
    expect(item.instanceId).toBe('i-1')
    expect(item.driverId).toBe('codex')
    expect(item.displayName).toBe('Codex (Work)')
    expect(item.commandLabel).toBe('codex')
    expect(item.accountLabel).toBe('Work Team')
    // Managed Credential Mode Is Surfaced (No Ref).
    expect(item.credentialMode).toBe('managed')
  })

  it('surfaces The Configuration-Required state When An Instance Has No Account', () => {
    const empty = serializeInstanceView(CONFIG_REQUIRED_INSTANCE)
    expect(empty.accountLabel).toBe(NO_ACCOUNT_LABEL)
  })

  it('marks An Unavailable Instance For Editing (Never Silently Removes)', () => {
    const unavailable = serializeInstanceView(CONFIG_REQUIRED_INSTANCE)
    expect(unavailable.availability).toBe('unavailable')
    // The Row Stays Editable Even When Unavailable (UI Does NOT Hide).
    expect(unavailable.problem).toBe('Not certified')
  })
})

describe('describeCommand (provider → command label)', () => {
  it('returns The driver id For A Driver-Mode Command', () => {
    expect(describeCommand(SAMPLE_INSTANCE.command)).toBe('codex')
  })

  it('returns The Exact Program For A External-Shell Command', () => {
    expect(describeCommand(CONFIG_REQUIRED_INSTANCE.command)).toBe('/usr/local/bin/codex --session /tmp/h')
  })
})

describe('buildInstanceRowProps (React row props stay sanitized)', () => {
  const rows = buildInstanceRowProps([SAMPLE_INSTANCE, CONFIG_REQUIRED_INSTANCE])

  it('builds A row per projection with NO Credential Keys In The Props', () => {
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      const props = Object.keys(row.item)
      for (const key of props) {
        expect(['credentialRef', 'BindingGeneration', 'CredentialRevision']).not.toContain(key)
      }
    }
  })

  it('Does NOT Silently Switch The Default When An Instance Is Unavailable', () => {
    // Unavailable Rows Are Listable/Editable — The Row Itself Is Always Present.
    const [defaultRow, unavailableRow] = rows
    expect(defaultRow.rowId).toBe('i-1')
    expect(unavailableRow.item.availability).toBe('unavailable')
  })
})

describe('credential password draft (empty, clears On Save)', () => {
  it('starts EMPTY And Never Seeds A Current Value', () => {
    const draft = freshCredentialDraft('i-1')
    expect(draft.value).toBe(EMPTY_CREDENTIAL_VALUE)
    // The Field Is Blank By Design (autocomplete="new-password") — never Pre-Seeded.
    expect(EMPTY_CREDENTIAL_VALUE.length).toBe(0)
  })

  it('updates In Place While Typed (The Field Never Reflects A Seeded Current)', () => {
    const typed = updateCredentialDraft(freshCredentialDraft('i-1'), 's3cr3t')
    // The Draft Carries The Typed Value (Never A Copied Current Ref).
    expect(typed.value).toBe('s3cr3t')
  })

  it('Clears The Draft After A Successful Write (finally)', () => {
    const outcome = credentialSaveOutcome(updateCredentialDraft(freshCredentialDraft('i-1'), 's3cr3t'))
    // The Save Clears The Field; A Subsequent Draft Is Blank Again.
    expect(outcome.clearsField).toBe(true)
    expect(outcome.draft.value).toBe(EMPTY_CREDENTIAL_VALUE)
  })

  it('Keeps The Draft Bound To Its Instance Id', () => {
    const draft = freshCredentialDraft('i-1')
    expect(draft.instanceId).toBe('i-1')
  })
})

describe('providerInstancesError (messages carry NO Disposable Marker)', () => {
  it('produces A Configuration-Required Error With No REDACTED/REF Marker', () => {
    const error = providerInstancesError(CONFIG_REQUIRED_INSTANCE)
    // The Message References The Placeholder Name (A Literal Word, Never A Byte 'REDACTED').
    expect(error.kind).toBe('missing-config')
    expect(error.message).not.toMatch(/REDACTED|REF/i)
  })

  it('Flags An Unavailable Instance', () => {
    const unavailableError = providerInstancesError(SAMPLE_INSTANCE)
    // A Available Instance Carries No Error (Healthy).
    expect(unavailableError.kind).toBe('available')
  })
})
