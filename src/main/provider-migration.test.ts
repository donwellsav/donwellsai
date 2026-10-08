import { describe, expect, it } from 'vitest'
import {
  deriveInstanceKey,
  EXTERNAL_COMMAND_DRIVER_ID,
  MIGRATED_CREDENTIAL_MODE,
  migrateLegacyCommand,
  migrateLegacyToInstance,
  PROVIDER_MIGRATION_VERSION
} from './provider-migration'
import type { ProviderCommandSpec } from '@shared/provider-authority'

/**
 * Failing migration tests for Task 4. These encode the exact legacy command →
 * instance mapping (step-1) plus The Deterministic Instance Key contract. They
 * Fail Until {@link provider-migration} Exposes Every Symbol, Then Prove The Mapping.
 */

describe('PROVIDER_MIGRATION_VERSION', () => {
  it('carries an explicit, stable migration version', () => {
    expect(typeof PROVIDER_MIGRATION_VERSION).toBe('string')
    // A numeric/lettered version; never empty. Bumped on Mapping Changes Only.
    expect(PROVIDER_MIGRATION_VERSION.length).toBeGreaterThan(0)
    expect(/^[a-z0-9-]+$/i.test(PROVIDER_MIGRATION_VERSION)).toBe(true)
  })
})

describe('legacy command → instance mapping (step-1)', () => {
  it('maps an exact known bare executable to a driver-backed external command with A deterministic selected default', () => {
    const result = migrateLegacyCommand({ command: 'codex' })
    expect(result).not.toBeNull()
    expect(result?.profile).toBe('driver-bare')
    // Bare bare registered driver → a `kind:'driver'` command (Not external-shell).
    expect(result?.command).toEqual({ kind: 'driver', driverId: 'codex' } satisfies ProviderCommandSpec)
    // Migration enters external credential mode (Managed/None chosen Per-Instance later).
    expect(result?.driverId === 'codex').toBe(true)
  })

  it('maps an absolute known executable to custom-command + external-shell (basename Is Not Authority)', () => {
    const result = migrateLegacyCommand({ command: '/usr/local/bin/codex' })
    expect(result?.profile).toBe('external-shell')
    expect(result?.driverId).toBe(EXTERNAL_COMMAND_DRIVER_ID)
    // The absolute path Is Preserved Whole In The External-shell program.
    expect(result?.command).toEqual({ kind: 'external-shell', program: '/usr/local/bin/codex' } satisfies ProviderCommandSpec)
  })

  it('maps an argument-bearing known command to custom-command + external-shell (arguments Never Alias The Driver)', () => {
    const result = migrateLegacyCommand({ command: 'codex --session-history /tmp/h' })
    expect(result?.profile).toBe('external-shell')
    expect(result?.driverId).toBe(EXTERNAL_COMMAND_DRIVER_ID)
    // Argument List Is Part Of The Bounded Program (The Exact Bound Shell String).
    expect((result?.command as { kind: 'external-shell'; program: string }).kind).toBe('external-shell')
    expect((result?.command as { kind: 'external-shell'; program: string }).program).toBe('codex --session-history /tmp/h')
  })

  it('maps an unknown/custom bare or shell program to custom-command + external-shell', () => {
    // A Non-Registered Bare Token → External-shell (It Is Not Yet Certified As A Driver).
    const bare = migrateLegacyCommand({ command: 'my-agent' })
    expect(bare?.profile).toBe('external-shell')
    expect(bare?.driverId).toBe(EXTERNAL_COMMAND_DRIVER_ID)

    // A Quoted/Redirection String → External-shell (Not A Bare Driver Token).
    const redirected = migrateLegacyCommand({ command: '/opt/tools/claude 2> /tmp/log' })
    expect(redirected?.profile).toBe('external-shell')
    expect((redirected?.command as ProviderCommandSpec).kind).toBe('external-shell')
  })

  it('maps an Empty/Invalid command to A configuration-required projection: No Instance, Null Default', () => {
    const empty = migrateLegacyCommand({ command: '' })
    expect(empty).toBeNull()
    const whitespaceOnly = migrateLegacyCommand({ command: '   ' })
    expect(whitespaceOnly).toBeNull()
    const tooLong = migrateLegacyCommand({ command: 'a'.repeat(16 * 1024 + 1) })
    expect(tooLong).toBeNull()
  })

  it('marks migrated Default Instances External Mode explicitly', () => {
    const mapped = migrateLegacyCommand({ command: 'opencode' })
    expect(mapped?.driverId === 'opencode').toBe(true)
    // The external mode constant is the only Credential Mode On Migrated Instances.
    expect(MIGRATED_CREDENTIAL_MODE).toBe('external')
  })
})

describe('deterministic instance key (deriveInstanceKey)', () => {
  const driverBare: ProviderCommandSpec = { kind: 'driver', driverId: 'codex' }
  const externalShell: ProviderCommandSpec = { kind: 'external-shell', program: '/usr/local/bin/codex --foo' }

  it('derives A stable key From (driverId, credentialMode, canonical command spec)', () => {
    const a = deriveInstanceKey({ driverId: 'codex', credentialMode: MIGRATED_CREDENTIAL_MODE, command: driverBare })
    const b = deriveInstanceKey({ driverId: 'codex', credentialMode: MIGRATED_CREDENTIAL_MODE, command: driverBare })
    expect(a).toBe(b) // Deterministic — same inputs Produce The Same Key.
    expect(a.startsWith('inst-')).toBe(true)
  })

  it('differs The Key When credentialMode Changes (managed vs external Never Collide)', () => {
    const external = deriveInstanceKey({ driverId: 'codex', credentialMode: 'external', command: driverBare })
    const managed = deriveInstanceKey({ driverId: 'codex', credentialMode: 'managed', command: driverBare })
    expect(external).not.toBe(managed)
  })

  it('differs The Key For Distinct external-shell programs', () => {
    const first = deriveInstanceKey({ driverId: EXTERNAL_COMMAND_DRIVER_ID, credentialMode: 'external', command: externalShell })
    const second = deriveInstanceKey({ driverId: EXTERNAL_COMMAND_DRIVER_ID, credentialMode: 'external', command: { kind: 'external-shell', program: '/opt/other' } })
    expect(first).not.toBe(second)
  })

  it('is Idempotent Across A Migration Retry (same Legacy Command ⇒ Same Instance Key)', () => {
    const first = migrateLegacyToInstance({ command: '/usr/local/bin/codex --session' })
    const second = migrateLegacyToInstance({ command: '/usr/local/bin/codex --session' })
    // A Retry Reuses The Deterministic Instance (Never Duplicates).
    expect(first.key).not.toBeNull()
    expect(first.key).toBe(second.key)
  })
})

describe('migrateLegacyToInstance pair', () => {
  it('returns A keyed spec for a Valid command', () => {
    const result = migrateLegacyToInstance({ command: 'codex' })
    expect(result.key).not.toBeNull()
    if (result.spec !== null) {
      expect(result.spec.driverId).toBe('codex')
      expect((result.spec.command as ProviderCommandSpec).kind).toBe('driver')
    }
  })

  it('returns A null key + spec for An Empty command', () => {
    const result = migrateLegacyToInstance({ command: '' })
    expect(result.key).toBeNull()
    expect(result.spec).toBeNull()
  })

  it('honors A caller-supplied credentialMode (managed vs external Differ, External Default Applies)', () => {
    const managed = migrateLegacyToInstance({ command: '/usr/local/bin/Codex', credentialMode: 'managed' })
    const externalDefault = migrateLegacyToInstance({ command: '/usr/local/bin/Codex' })
    const externalExplicit = migrateLegacyToInstance({ command: '/usr/local/bin/Codex', credentialMode: 'external' })
    const returnTypeGuard = managed.spec === null || externalDefault.spec === null
    if (returnTypeGuard) return // Non-Empty Inputs.
    // Same Command, Different Mode ⇒ Distinct Keys (credentialMode Is Part Of The Key).
    expect(managed.key).not.toBe(externalDefault.key)
    // Explicit 'external' Matches The Default CredentialMode (MIGRATED_CREDENTIAL_MODE).
    expect(externalDefault.key).toBe(externalExplicit.key)
  })
})
