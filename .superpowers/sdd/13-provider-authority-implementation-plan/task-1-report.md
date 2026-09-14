# Stage 3 Task 1 — Provider Catalog

## Scope

Implemented the daemon-owned Provider Catalog on the existing Stage 2 Task Authority SQLite database. The catalog owns provider accounts, configured instances, defaults, opaque binding metadata/generations, and short-lived launch preparations. No secret material is returned in projections. Built-in managed-support certification remains empty, so built-in drivers and `custom-command` are external-only.

## Baseline and provenance

- Branch: `roadmap/stage-3-provider-authority`
- Accepted Stage 2 base: `e6f3ca5e536201086df1b5a16302d62035bcc752`
- Lockfile SHA-1 at start: `ec60067c758737506d86e7e154304b3a7ae908d6`
- The repository had a clean status at the start of implementation.
- LSP reference tooling was not available through this harness. Tracked-source census was performed with repository search for `AgentProviderId`, `AgentPreset`, `RunningAgent.presetId`, `AgentRuntime.start`, `DaemonClient.startAgent`, and `AgentRegistry.list`; existing seams were retained and the catalog was added without changing live launch selection.

## Implementation

- Added `src/shared/provider-authority.ts` with public catalog contracts, known-driver parsing, sanitized snapshot parsing, and catalog error codes.
- Added `src/main/provider-catalog.ts` with a transactional `SqliteProviderCatalog` using the Stage 2 `TaskAuthorityDatabase` connection and its WAL/locking/durability settings.
- Extended the existing schema (without a second database) with account, instance, binding, catalog state, launch preparation, credential-operation, and launch-admission tables. Existing schema version remains compatible and idempotently installs the additional tables on open.
- Added `src/main/agents/provider-certifications.ts`; the production certification registry is intentionally empty and static.
- Added daemon capability `provider-catalog-v1` and sanitized `agent.providers` read plus typed `DaemonClient.providerCatalogSnapshot()`.
- Added focused catalog and certification tests.
- Preserved unknown persisted driver IDs as unavailable projections; malformed persisted command data raises `CORRUPT_CATALOG`; public parsers accept known driver IDs only.

## Verification

- `pnpm exec vitest run src/main/provider-catalog.test.ts`: 5 passed.
- `pnpm exec vitest run src/main/agents/provider-certifications.test.ts`: passed as part of full suite.
- `pnpm exec vitest run src/main/task-authority/task-authority.test.ts src/main/task-authority/task-authority-migration.test.ts`: 68 passed.
- `pnpm exec vitest run src/main/daemon-client.test.ts`: 8 passed.
- `pnpm typecheck`: passed (Node, web, and CLI projects).
- `pnpm build`: passed.
- `pnpm test`: 339 passed, 6 skipped across 26 files.

The full suite emits existing profile-maintenance disconnect bookkeeping warnings during daemon teardown; they do not fail tests and were present on the exercised daemon path.

## Review notes

The catalog does not alter renderer settings, Secret Authority, provider-backed production callers, or live agent launch selection. Launch preparation is internal and captures exact revisions/attempt/session/purpose with bounded expiry. Credential references are retained only in authority tables and launch preparations, never in catalog snapshots or instance/account projections.

## Fix round 1 (review findings)

Two workers crashed mid-edit (OpenRouter credit limits) and left the tree uncompilable: `provider-catalog.ts` had been rewritten from baseline while `shared/provider-authority.ts`, the certification module, the daemon, and the client had been edited separately. Both streams' intent was reconciled rather than one being reverted.

### Compile restoration

- `terminal-daemon.ts`: restored the deleted `export const TASK_AUTHORITY_CAPABILITY = 'task-authority-v1'`, and replaced five calls to a nonexistent `taskWireRequiredInteger` with the repo's `taskWireEntityVersion`.
- `provider-catalog.ts`: annotated `managedSupport` with the imported `ProviderManagedSupport` rather than indexing the union (`ProviderDriverProjection['managedSupport']` is invalid on the `unknown` branch).
- Capability literal de-duplicated: `AGENT_PROVIDER_CATALOG_CAPABILITY` now lives only in `shared/provider-authority.ts`; `agent-runtime.ts` no longer declares it and both daemon and client import the single source.

### P1 — foreign-key correctness

1. **Default-instance removal.** `remove` clears a matching `default_instance_id` before deleting the row; the previous order violated the state table's foreign key and threw a raw SQLite error. The pointer is cleared, never silently re-pointed at a surviving sibling.
2. **Instance update.** Update mutates the existing row in place. The previous delete-and-reinsert under `foreign_keys=ON` failed on any child reference (bindings, preparations, default pointer) and destroyed `created_at`.
3. **Account removal.** Retired binding history owned by the account is deleted with it; a referencing instance remains a typed `ACCOUNT_HAS_CREDENTIAL` refusal instead of an untyped constraint crash.
4. **Preparation purge.** `purgePreparations` removes expired/consumed preparations and their admission receipts inside the caller's transaction, so launch intent can neither FK-block an instance edit/removal nor accumulate unbounded. A *live* preparation now yields a typed `PREPARATION_ACTIVE` on removal instead of an opaque constraint failure.

### P2/P3 — contract and coverage

- **Typed errors.** `ProviderCatalogError` gained `PREPARATION_ACTIVE`, `FOREIGN_KEY_CONFLICT`, and `INVALID_INPUT`; every mutation path routes raw FK failures through `guardForeignKeys` and the daemon maps the catalog `code` onto the wire. `DaemonClient` gained `DaemonRequestError`, carrying `operation` and `code`, so callers switch on the contract instead of matching message text.
- **Wire correlation bug (found while testing).** `agent.providers.update/remove/default` used a wire parameter named `id`, which collides with the transport's correlation id — the daemon read `message['id']` (the request id) as the instance id and overwrote it in the reply, so `DaemonClient` could never correlate the response and every such call timed out. The instance is now carried in `instanceId`; a test asserts the envelope id is not the instance id.
- **Certification.** One matcher (`certificationFor`) now consults executable path, sha256, version probe, exact `allowedArgs`, platform, architecture, and the reviewer's `verify` before reporting managed/none. `parseProviderCertification` is the single decoder and **rejects** an unreviewed platform, mode, driver, or digest rather than coercing it. The projection reports the reviewed tuple as-is; the previous `platform === 'darwin' || … : 'darwin'` clamp is gone.
- **Driver IDs derived.** `AGENT_PROVIDER_DRIVER_IDS` is computed from `AGENT_PROVIDER_DEFINITIONS` plus `custom-command`, replacing the hand-maintained literal list that could drift from the registry.
- **Projection validation.** `parseProviderCatalogSnapshot` now decodes field by field (exact keys, types, enums) as the ACP decoders do, and credential detection is key-membership based — the previous substring regex could false-positive on any legitimate string.

### Tests

New and expanded coverage in `provider-catalog.test.ts` (19), `provider-certifications.test.ts` (7), `terminal-daemon.test.ts` (+4 wire cases), `daemon-client.test.ts` (+2 client cases): concurrent revision winner, corrupt row typed failure with the database untouched, exact certification tuple plus eight drift modes, preparation exact fields/stale/expired/live-immutability, default-instance removal, free-standing unbind rejection, retired-binding account removal, and no projection leaks (asserted through the sanitized decoder, not just a substring scan).

Non-vacuity was proven, not assumed: the P1 tests were run against the committed HEAD implementation in a throwaway worktree, where **4 failed** with exactly the reported foreign-key defects (`remove`, `update`, `removeAccount`, consumed-preparation purge). Post-fix all pass; the worktree was removed.

### Gates

| Gate | Result |
| --- | --- |
| `pnpm exec vitest run` (focused, 4 files) | 57 passed |
| `pnpm test` | 26 files, 365 passed, 6 skipped (baseline 339 passed, 6 skipped) |
| `pnpm run typecheck` | passed (node, web, cli) |
| `pnpm run build` | passed |
| `pnpm run package:check` | passed (310 notices, darwin/arm64 identity) |

## Fix round 1 concerns

- `task_launch_admissions` rows are deleted with their expired preparation by design (documented at `purgePreparations`): the durable execution record is the Stage 2 attempt row, and the preparation is bounded-TTL launch intent. The admission receipt references the preparation with a foreign key, so retention would otherwise make the purge impossible. No consumer reads the admission ledger yet (it has no reader outside the schema today), so this is a design decision for Task 2 rather than an integration break.
- Instance removal refuses while a live preparation names the instance. Today an operator must let it expire (≤30s) or wait for the admission to consume it; there is no explicit cancel path. If Task 2 needs immediate removal, the admission/consume surface should grow one.
- `pnpm test` emits pre-existing profile-maintenance disconnect warnings during daemon teardown (`open runtime authority name lock failed`); they are present on the exercised daemon path, do not fail tests, and are unrelated to this change.
- The catalog remains unwired to renderer settings and live launch selection, as scoped for Task 1.

## Fix round 2 (re-review High finding)

One High finding against 1c7c297: my field-by-field `parseProviderCatalogSnapshot` was **stricter than the catalog it decodes**. `decodeInstance` → `decodeCommand` called `parseAgentDriverId` on an instance's `command.driverId`, which throws for an id the running build no longer registers. The catalog deliberately preserves those ids (`jsonCommand` restores the raw id; `instanceFromRow` reports an `unknown`/`unavailable` projection), so `providerCatalogSnapshot()` rejected the **entire snapshot** whenever any legacy instance existed — directly violating the brief's "invalid persisted raw driver IDs survive only as unavailable `unknown` projections". This was a regression introduced by round 1's stricter decoder, not a pre-existing defect.

### Fix

- `decodeCommand` gained an explicit `tolerateUnknownDriver` flag. It is scoped **precisely** to the case the catalog actually produces: an instance whose driver projection is `kind: 'unknown'`. The id is still validated as a bounded string, and command **structure** is still validated — only the id's registration is tolerated.
- Deliberately not taken: skipping command decoding wholesale for unavailable instances. That would have let arbitrary malformed command JSON through on any `unavailable` row (including a *known* driver whose mode is merely uncertified). The narrower fix keeps structure enforcement intact.
- Round 1's strictness is unchanged everywhere else: known-driver instances, driver projections, and certification tuples still reject an unregistered id.

### Tests

- `preserves an unknown persisted driver as unavailable instead of remapping it` now asserts the snapshot round-trips through the sanitized decoder.
- New `keeps a snapshot decodable when an unknown-driver instance is present alongside known ones`: a known instance plus three unavailable legacy rows (`driver`, `external-argv`, and `external-shell` commands) all decode, so one legacy row cannot blank out the catalog.
- New `still refuses a structurally malformed command on an unavailable instance`: pins the narrow scope — tolerance is for an unknown driver id, not for malformed structure.
- New client round-trip `decodes a snapshot holding an unknown-driver unavailable instance`, exactly as the finding requested: the real `DaemonClient.providerCatalogSnapshot()` receives a daemon frame containing an unavailable unknown-driver instance and returns it intact.
- One draft test of mine incorrectly asserted the in-process catalog returns `CORRUPT_CATALOG` for an unknown driver id; `jsonCommand` preserves it instead, so I corrected the test to the real behavior rather than changing the code to match a wrong expectation.

Non-vacuity re-proven: the three new decode tests were run against 1c7c297 in a throwaway worktree, where **3 failed** (`must identify a known agent driver`), and pass after the fix. The worktree was removed.

### Gates

| Gate | Result |
| --- | --- |
| focused (provider-catalog, provider-certifications, terminal-daemon, daemon-client) | 60 passed |
| `pnpm test` | 26 files, 368 passed, 6 skipped (round-1 baseline 365/6) |
| `pnpm run typecheck` | passed (node, web, cli) |
| `pnpm run build` | passed |
| `pnpm run package:check` | passed (310 notices, darwin/arm64 identity) |

Prior findings confirmed still fixed: all round-1 P1/P2/P3 tests remain green (per-test verification above), including default-instance removal, in-place update, retired-binding account removal, preparation purge, the `instanceId` wire-collision fix, typed errors, and certification drift rejection.

### Fix round 2 concerns

- The `command.driverId` type remains `AgentDriverId`, so a decoded unavailable instance's command id is a `string` asserted into that slot. This mirrors the catalog's own in-process `jsonCommand` behaviour (which already types the raw persisted id as `AgentDriverId`), so no new unsoundness is introduced, but the honest model would be a separate stored-command type on the `unknown` projection branch. That is a contract change for Task 2, not a fix-round change.
- Round-1 concerns are unchanged: `task_launch_admissions` is purged with its preparation by design and needs a Task 2 decision; instance removal still waits out a live preparation's ≤30s TTL; the pre-existing profile-maintenance teardown warnings persist.


