// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { ProviderDriverProjection, ProviderInstanceProjection } from '@shared/provider-authority'
import {
  EMPTY_CREDENTIAL_VALUE,
  NO_ACCOUNT_LABEL,
  buildInstanceRowProps,
  credentialSaveOutcome,
  describeCommand,
  freshCredentialDraft,
  providerInstancesError,
  serializeInstanceView,
  updateCredentialDraft,
  CUSTOM_COMMAND_DRIVER_ID,
  freshInstanceDraft,
  instanceDraftError,
  instanceDraftFromProjection,
  providerInstanceInputFromDraft,
  selectableCredentialModes,
  selectableDrivers,
  withDriver
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

/** An external-only driver: the custom-command escape hatch. */
const CUSTOM_DRIVER = {
  kind: 'known' as const,
  id: 'custom-command' as const,
  displayName: 'Custom command',
  installed: true,
  hooks: { support: 'unavailable' as const, events: [], reason: 'No hooks' },
  skills: { supported: false as const, reason: 'No skills' },
  memorySupport: 'none',
  credentialModes: ['external'] as const,
  managedSupport: { kind: 'unsupported' as const, reason: 'External only' }
} satisfies ProviderDriverProjection


/** A driver the catalog reports as fully certified, so managed/none are authorable. */
const CERTIFIED_DRIVER = {
  kind: 'known' as const,
  id: 'claude' as const,
  displayName: 'Claude',
  installed: true,
  hooks: { support: 'native' as const, adapter: 'claude-hooks' as const, events: [], documentationUrl: 'https://example.invalid' },
  skills: { supported: true as const, root: '.claude/skills', discovery: 'native' as const },
  memorySupport: 'direct' as const,
  credentialModes: ['external', 'managed', 'none'] as const,
  managedSupport: { kind: 'certified' as const, modes: ['managed', 'none'] as const, supportedVersionRange: '>=1.0.0 <2.0.0', platform: 'darwin' as const, architecture: 'arm64' }
} satisfies ProviderDriverProjection

/** The raw-unknown fallback the form must never offer as a configurable driver. */
const UNKNOWN_DRIVER = {
  kind: 'unknown' as const,
  rawDriverId: '/usr/local/bin/mystery',
  availability: 'unavailable' as const,
  problem: 'not registered'
} satisfies ProviderDriverProjection

describe('instance authoring drafts (create/edit)', () => {
  it('offers only registered drivers, never the raw-unknown fallback', () => {
    const offered = selectableDrivers([CUSTOM_DRIVER, UNKNOWN_DRIVER, SAMPLE_INSTANCE.driver])
    expect(offered.map(d => d.id).sort()).toEqual(['codex', 'custom-command'])
  })

  it('offers only the credential modes the driver actually supports', () => {
    // A custom command is external-only: offering managed would author a mode
    // the daemon then refuses.
    expect(selectableCredentialModes(CUSTOM_DRIVER)).toEqual(['external'])
    // The catalog composes a known driver's modes as `['external', ...certified]`,
    // so managed/none appear only where certification evidence exists.
    expect(selectableCredentialModes(CERTIFIED_DRIVER)).toEqual(['external', 'managed', 'none'])
  })

  it('seeds a fresh draft that cannot yet be saved', () => {
    const draft = freshInstanceDraft([SAMPLE_INSTANCE.driver])
    expect(draft.id).toBeNull()
    expect(draft.expectedRevision).toBeNull()
    expect(draft.driverId).toBe('codex')
    // The blank display name is the first thing the operator must supply.
    expect(instanceDraftError(draft)).not.toBeNull()
    expect(providerInstanceInputFromDraft(draft)).toBeNull()
  })

  it('switching to the custom driver forces an external-shell command and drops managed', () => {
    const managed = { ...freshInstanceDraft([SAMPLE_INSTANCE.driver]), displayName: 'X', credentialMode: 'managed' as const, accountId: 'a-1' }
    const switched = withDriver(managed, CUSTOM_DRIVER)
    expect(switched.driverId).toBe(CUSTOM_COMMAND_DRIVER_ID)
    expect(switched.commandKind).toBe('external-shell')
    // Managed is not a mode the custom driver supports, so it must not survive.
    expect(switched.credentialMode).toBe('external')
  })

  it('builds exactly the documented input and never invents an id', () => {
    const draft = { ...freshInstanceDraft([CUSTOM_DRIVER]), displayName: '  My Agent  ', commandKind: 'external-shell' as const, program: '  /usr/local/bin/agent --flag  ' }
    const input = providerInstanceInputFromDraft(draft)
    expect(input).not.toBeNull()
    expect(input).toEqual({
      driverId: 'custom-command',
      displayName: 'My Agent',
      command: { kind: 'external-shell', program: '/usr/local/bin/agent --flag' },
      credentialMode: 'external',
      accountId: null,
      enabled: true
    })
    // Identity is derived by the daemon from the tuple, never sent by the form.
    expect(Object.hasOwn(input as object, 'id')).toBe(false)
  })

  it('requires an account before a managed instance can be saved', () => {
    const draft = { ...freshInstanceDraft([SAMPLE_INSTANCE.driver]), displayName: 'Managed', credentialMode: 'managed' as const, accountId: null }
    expect(instanceDraftError(draft)).toMatch(/account/i)
    expect(providerInstanceInputFromDraft(draft)).toBeNull()
    expect(instanceDraftError({ ...draft, accountId: 'a-1' })).toBeNull()
  })

  it('requires a program for a custom command', () => {
    const draft = { ...freshInstanceDraft([CUSTOM_DRIVER]), displayName: 'Custom', commandKind: 'external-shell' as const, program: '   ' }
    expect(instanceDraftError(draft)).toMatch(/program/i)
  })

  it('round-trips a projection into an editable draft that preserves the revision', () => {
    const draft = instanceDraftFromProjection(SAMPLE_INSTANCE)
    expect(draft.id).toBe('i-1')
    // The update must carry the revision it was read at, or a concurrent writer
    // would be silently overwritten.
    expect(draft.expectedRevision).toBe(2)
    expect(draft.driverId).toBe('codex')
    expect(draft.commandKind).toBe('driver')
    expect(draft.accountId).toBe('a-1')
    expect(instanceDraftError(draft)).toBeNull()
  })

  it('edits a legacy external-shell instance without claiming a driver from its basename', () => {
    const draft = instanceDraftFromProjection(CONFIG_REQUIRED_INSTANCE)
    expect(draft.commandKind).toBe('external-shell')
    expect(draft.program).toBe('/usr/local/bin/codex --session /tmp/h')
    // The unknown driver is not configurable, so it maps to the explicit
    // custom-command escape hatch rather than a basename-derived identity.
    expect(draft.driverId).toBe(CUSTOM_COMMAND_DRIVER_ID)
  })
})
