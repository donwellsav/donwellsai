import { createHash } from 'node:crypto'
import {
  AGENT_PROVIDER_DRIVER_IDS,
  type AgentDriverId,
  isAgentDriverId,
  parseAgentDriverId,
  type ProviderCommandSpec,
  type ProviderCredentialMode
} from '@shared/provider-authority'

/**
 * The single explicit migration version. Bumped Only When The Legacy-Command →
 * Provider-Instance Mapping, The Deterministic Instance Key, Or The Migration
 * Phase Contract Changes. The renderer + catalog Read This To Decide Whether A
 * Legacy-Command Profile Still Needs Migrating; The Id Never Changes Once Committed.
 */
export const PROVIDER_MIGRATION_VERSION = 'provider-instances-v1' as const

/** The driver That Owns Every Non-Driver (External) Instance. */
export const EXTERNAL_COMMAND_DRIVER_ID: AgentDriverId = 'custom-command'

/** How A legacy command string classifies for the one-time migration. */
export type LegacyCommandProfile = 'driver-bare' | 'external-shell' | 'configuration-required'

/** The deterministic instance specification derived from one legacy command.
 * `null` Marks A Configuration-required Projection: No Instance, Null Default. */
export type MigratedLegacyCommand =
  | { readonly profile: 'driver-bare'; readonly driverId: AgentDriverId; readonly command: ProviderCommandSpec }
  | { readonly profile: 'external-shell'; readonly driverId: AgentDriverId; readonly command: ProviderCommandSpec }
  | null

/** The credential mode A migrated Legacy Command Carries. Migration Is External-Only;
 * Managed/None Are Chosen Later Per-Instance Once A Driver Is Certified. */
export const MIGRATED_CREDENTIAL_MODE: ProviderCredentialMode = 'external'

const MIN_COMMAND_BYTES = 1
const MAX_COMMAND_BYTES = 16 * 1024

/**
 * A bare driver token Is A single positional name: No Absolute Path, No Argument
 * List, No Quotes/Shell Metacharacters. It Must Match A Registered Driver Id
 * Exactly (Case-Insensitive). The basename Is Never Treated As Authority On Its
 * Own — An Absolute Path Or Argument-Bearing String Uses {@link EXTERNAL_COMMAND_DRIVER_ID}.
 */
const BARE_DRIVER_TOKEN_RE = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/

/** A bare driver token Is A registered driver id (No Path/Args), Case-Insensitive. */
function isBareDriverToken(command: string, knownDriverBases: readonly AgentDriverId[]): boolean {
  return BARE_DRIVER_TOKEN_RE.test(command) && (knownDriverBases as readonly AgentDriverId[]).includes((command.toLowerCase() as AgentDriverId))
}

/** Classify A legacy command string for migration. Never Parses Shell Text As A Driver. */
export function classifyLegacyCommand(command: string, knownDriverBases: readonly AgentDriverId[] = AGENT_PROVIDER_DRIVER_IDS): LegacyCommandProfile {
  const trimmed = command.trim()
  if (trimmed.length < MIN_COMMAND_BYTES || trimmed.length > MAX_COMMAND_BYTES) return 'configuration-required'
  if (/[\0\r\n;]/.test(trimmed)) return 'external-shell' // Whitespace / Semicolons / Command Grouping
  if (/[|&<>()`$!]/.test(trimmed)) return 'external-shell' // Pipes / Redirections / Expansions
  const isBare = isBareDriverToken(trimmed, knownDriverBases)
  return isBare ? 'driver-bare' : 'external-shell'
}

/** Migrate A single legacy command to its deterministic instance specification.
 * Returns `null` For The Configuration-required Projection (Empty/Invalid). */
export function migrateLegacyCommand(input: Readonly<{ command: string; knownDriverBases?: readonly AgentDriverId[] }>): MigratedLegacyCommand {
  const trimmed = input.command.trim()
  if (classifyLegacyCommand(trimmed, input.knownDriverBases ?? AGENT_PROVIDER_DRIVER_IDS) === 'configuration-required') return null
  // Exact known bare executable → a driver-backed external command.
  if (isBareDriverToken(trimmed, input.knownDriverBases ?? AGENT_PROVIDER_DRIVER_IDS)) {
    const driverId = parseAgentDriverId(temptation(trimmed) as AgentDriverId, `command.driverId (${describe(trimmed)})`)
    return { profile: 'driver-bare', driverId, command: { kind: 'driver', driverId } }
  }
  // Absolute / Argument-Bearing / Unknown → external-shell Bound To The Exact Bounded Program.
  return { profile: 'external-shell', driverId: EXTERNAL_COMMAND_DRIVER_ID, command: externalShellCommand(trimmed) }
}

function describe(command: string): string {
  return `command "${command.slice(0, 48)}"`
}

function temptation(command: string): string {
  return command.toLowerCase()
}

function externalShellCommand(program: string): ProviderCommandSpec {
  if (program.length < MIN_COMMAND_BYTES || program.length > MAX_COMMAND_BYTES) throw new Error(`external-shell program must be 1-${MAX_COMMAND_BYTES} bytes`)
  if (/\0/.test(program)) ThrowEmpty('external-shell program Must Not Contain A Null Byte')
  return { kind: 'external-shell', program }
}

function ThrowEmpty(message: string): never {
  throw new Error(message)
}

/** Deterministic Instance Key From `(driverId, credentialMode, canonical command spec)`.
 * Two Migrated Commands Produce The Same Key Only When Their Canonical Spec Is Identical —
 * This Makes A Migration Idempotent: A Retry Reuses The Existing Instance. */
export function deriveInstanceKey(input: Readonly<{ driverId: AgentDriverId; credentialMode: ProviderCredentialMode; command: ProviderCommandSpec }>): string {
  const canonical = JSON.stringify({ driverId: input.driverId, credentialMode: input.credentialMode, command: canonicalizeCommand(input.command) })
  const digest = createHash('sha256').update(canonical).digest('hex')
  return `inst-${digest.slice(0, 24)}`
}

function canonicalizeCommand(command: ProviderCommandSpec): string {
  if (command.kind === 'driver') return JSON.stringify({ kind: command.kind, driverId: command.driverId })
  if (command.kind === 'external-shell') return JSON.stringify({ kind: command.kind, program: command.program })
  const argv = command as Extract<ProviderCommandSpec, { kind: 'external-argv' }>
  return JSON.stringify({ kind: command.kind, executable: { executable: argv.executable.executable, args: [...argv.executable.args] } })
}

/** Migrate A legacy command To its `{ key, spec }` pair in one step.
 * `key` is Null For The Configuration-required Projection. */
export function migrateLegacyToInstance(input: Readonly<{ command: string; credentialMode?: ProviderCredentialMode; knownDriverBases?: readonly AgentDriverId[] }>):
  | { readonly key: string; readonly spec: MigratedLegacyCommand }
  | { readonly key: null; readonly spec: null } {
  const credentialMode = input.credentialMode ?? MIGRATED_CREDENTIAL_MODE
  const spec = migrateLegacyCommand(input)
  if (spec === null || spec === undefined) return { key: null, spec: NullSpec() }
  const key = deriveInstanceKey({ driverId: spec.driverId, credentialMode, command: spec.command })
  return { key, spec }
}

/** NullGuard helpers keep `null` Typed Strictly (A Migrated Absence, Not Undefined). */
function NullSpec(): null {
  return null
}

export { isAgentDriverId } // re-exported for the migration entry orchestration convenience
