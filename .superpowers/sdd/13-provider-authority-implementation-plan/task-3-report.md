# Task 3 — bind provider selection to attempts and launches

Branch: `roadmap/stage-3-provider-authority`
Worktree: `/Users/muzikfirst/Documents/donwellsai/.worktrees/stage-3-provider-authority`
Base: `150b576` (Task 2 complete)
Status: **complete**, all gates green.

## Files created

| File | Purpose |
| --- | --- |
| `src/main/secret-output-redactor.ts` | Bounded streaming redactor + `SecretOutputBoundary` for managed launches. |
| `src/main/secret-output-redactor.test.ts` | 11 tests: every-byte-offset splits, stream independence, bounds, fail-closed close. |
| `src/main/provider-launch.test.ts` | 23 tests: selection binding, admission, isolation, provenance, races, real-child redaction. |

## Files modified

| File | Change |
| --- | --- |
| `src/shared/task-authority.ts` | `AttemptProviderSelection`; immutable `providerSelection` on `AuthenticatedClaimInput`, `AdminRetryFailedTaskInput`, `AttemptSnapshot`; `ProviderBackedLaunchRequest`, `ProviderLaunchAdmission`, `ProviderLaunchAdmissionTuple`, `ProviderLaunchCredential`, `ProviderLaunchMaintenanceClaim`; `admitProviderLaunch` on the interface; new error codes `PROVIDER_ADMISSION_REQUIRED`, `PROVIDER_SELECTION_REQUIRED`, `PREPARATION_STALE`, `MAINTENANCE_ADMISSION_STALE`, `CORRUPT_AUTHORITY`. |
| `src/main/task-authority/schema.ts` | Schema v5: `attempts.provider_selection_json` additive column; `task_launch_admissions` rebuilt as the full broker authorization tuple (v4 rows are transient receipts the Catalog already purges with their preparation, so the upgrade drops rather than backfills authority they never carried). |
| `src/main/task-authority/task-authority.ts` | Selection write-once at attempt insert; `admitProviderLaunch` — the only `claimed -> launching` provider path. |
| `src/main/task-authority/task-execution-coordinator.ts` | `launchProviderBacked` + `ProviderLaunchPorts`/`ProviderChildPort`/`ProviderMaintenancePort`/`ProviderSecretPort`; `resolveProviderLaunchInvocation`. |
| `src/shared/provider-authority.ts` | `parseProviderSelection`, `sameProviderSelection`; `retireCredentialBindingForOperation` async form now returns the projection (Task 2 parked item 1). |
| `src/shared/agent-runtime.ts` | `AgentStartIntent` + `parseAgentStartIntent`; `RunningAgent.provider` (`AgentRunProviderIdentity`) with a strict wire decoder. |
| `src/shared/child-process/process-environment.ts` | `PROVIDER_ISOLATION_ALLOWLIST`, `isolatedProviderEnvironment` — strict allowlist, not a stripped denylist. |
| `src/main/agents/provider-hooks.ts` | `resolveProviderInvocation` + `ResolvedProviderInvocation` + `ProviderInvocationError` (added only; `shellCommand` and the hook builders are unchanged). |
| `src/main/daemon-client.ts` | `providerSelection` on the attempt wire decoder; retire facade folds the projection through. |
| `src/main/terminal-daemon.ts` | `provider.credential.retire` replies with the sanitized snapshot. |
| `src/main/provider-secret-authority.ts` | Local saga adapter retires then returns the same projection the wire form returns. |
| `src/main/provider-catalog.test.ts`, `src/main/provider-secret-authority.test.ts` | v5 out-of-band seed shape; retired-projection symmetry test. |

**Not touched:** `src/shared/operational-runs.ts` (verified `git diff` empty, 0 `ProviderSelection` occurrences); package-verification and generic parallel/scheduled jobs stay provider-free.

## Step 1 / Step 5 invariants and the exact tests proving them

`src/main/provider-launch.test.ts` unless noted.

| Invariant | Test |
| --- | --- |
| Immutable selection incl. `accountRevision`; provider-free variant is explicit `null` | `records an immutable selection on the attempt and refuses a provider-free attempt for provider admission` |
| Retry may choose a different instance/account; history stable | `lets a retry choose a different account and keeps the recorded history stable` |
| Stale lease / foreign owner rejection | `admits the exact unexpired preparation once, ...` |
| Same-database admission consumes the exact unexpired preparation and records `claimed -> launching` | same test (asserts stored row tuple, `launching` state, `consumed_at`) |
| Mismatch on session / attempt / preparation / maintenance epoch / unknown admission / foreign connection changes neither preparation nor attempt | same test |
| Instance revision mismatch ⇒ no admission, no preparation change | `refuses admission when the live instance revision moved after preparation` |
| Credential ref/generation mismatch (out-of-band swap) ⇒ no admission | `refuses admission when the live credential ref or binding generation changed out of band` |
| Rebind after preparation ⇒ stale preparation unconsumed, no broker request, no spawn | `refuses admission when the credential binding was replaced after preparation, and performs no spawn` |
| Unc certified built-in rejects managed/none before any row/materialization | `refuses managed and none for an uncertified built-in before any catalog row exists`; `refuses a managed arbitrary command at creation and again at launch resolution` |
| Driver/executable provenance; basename spoof; driver mismatch; argv/shell shapes | `resolves driver, external-argv, and external-shell invocations from provenance alone` |
| Managed child gets only the broker environment + isolated roots | `gives a managed child only the broker environment, with the home and config roots isolated` |
| Real child cannot read planted home auth files or unregistered variables | `proves a real child cannot read planted parent-home auth files or unregistered credential variables` (real OS child) |
| `none` never calls Secret Authority, still isolated | `never sends a broker request for a none-mode launch and still isolates the child` |
| External never calls Secret Authority; keeps inherited external auth | `never calls Secret Authority for an external launch and keeps inherited external auth` |
| `external-argv` executes only its explicit spec | `executes only the explicit custom command spec for an external-argv instance` |
| Broker absent ⇒ `SECRET_AUTHORITY_UNAVAILABLE`, no child, no fallback | `blocks a managed launch with no broker, records a typed retryable failure, and creates no child` |
| Broker disconnect ⇒ blocks without fallback, exactly one request | `blocks a managed launch when the broker disconnects, without falling back to any other credential` |
| Cancellation before admission ⇒ no child, preparation unconsumed | `creates no child and consumes no preparation when cancellation is committed before admission` |
| Cancellation after admission before the pre-spawn check ⇒ no child | `creates no child when cancellation is committed after admission but before the launch-intent check` |
| Cancellation racing admitted spawn ⇒ stop + quarantine, no fake rollback | `stops and quarantines when a cancellation races an admitted spawn` |
| Refused runtime bind ⇒ stop by identity + quarantine | `converges a refused runtime bind without disclosing anything and without claiming a rollback` |
| Spawn failure ⇒ no admission residue | `converges a child that fails to start without leaving an admission or a preparation behind` |
| Maintenance freeze vs admission has one winner | `refuses a launch whose admission is adopted by a freeze, and lets only one admission win` (real durable gate) |
| Real child whole + every-boundary-split markers absent from all sinks | `redacts whole and every-boundary-split markers a real child wrote to both streams` |

`src/main/secret-output-redactor.test.ts`: `substitutes a secret split at every stdout and stderr byte offset`, `substitutes a secret split across three chunks at a boundary spanning the whole secret`, `resolves overlapping secrets leftmost-longest instead of by pattern order`, `retains at most maxSecretBytes minus one undecided byte per stream`, `keeps stdout and stderr carries independent`, `flushes the residual undecided bytes at terminal close and then refuses further use`, `refuses empty, oversized, and control-bearing secret values before use`, `passes output through unchanged for a session with no managed redactor`, `redacts a managed session across both streams and drops output after close`, `refuses a second redactor for one session`.

## Real-child redaction proof

Standalone harmless script (`/tmp/task3-real-child-proof.mts`, disposable markers, deleted after use) spawned a real OS child that echoed a 40-byte marker **whole and split at every byte offset** on stdout and stderr, pushed every byte through the production `SecretOutputRedactor` **one byte per chunk**, and checked every sink:

```
PASS  child really emitted the marker
PASS  child emitted every split boundary
PASS  no marker reaches stdout sink
PASS  no marker reaches stderr sink
PASS  no marker reaches the combined sink
PASS  no marker prefix survives
PASS  no marker suffix survives
PASS  substitution is constant
PASS  patterns zeroized on close

marker occurrences in raw child output: 80
marker occurrences after redaction: 0
REAL-CHILD REDACTION PROOF: PASS
```

The in-suite counterpart is the real-process test above, which reports both raw and settled bytes per stream.

## Non-vacuity (mutation reverted, tests must fail)

| Mutation | Result |
| --- | --- |
| Remove the `[REDACTED]` substitution | **7 failed** / 26 passed |
| Ignore the maintenance `migration_id` (freeze guard) | **1 failed** / 21 passed |
| Ignore the credential-ref compare | **1 failed** / 22 passed |
| Replace the allowlist with the inherited environment | **1 failed** / 22 passed |

Each mutation was reverted immediately; the tree is clean.

## Gate results

| Gate | Result |
| --- | --- |
| `tsc --noEmit` (node, web, cli) | clean |
| `pnpm test` (full) | **451 passed, 6 skipped** (baseline 417/6, +34) |
| `pnpm build` | passed (electron-vite + CLI) |
| `pnpm run package:check` | passed (310 notices, native identity verified) |

`package:prepare` / `package:mac` were **not** run, per the brief.

## Contract items carried from Task 2

1. **Retire projection asymmetry — closed.** The wire facade folded the projection away while the in-process adapter returned it. Both now return the sanitized `ProviderCatalogSnapshot`, proven by `reports the retired-instance projection as a decodable sanitized document` (catalog) and the 31-test saga suite.
2. **Revocation cannot retract bytes already consumed by an admitted spawn — stated and tested.** The boundary is real in the admission path: `SECRET_AUTHORITY_UNAVAILABLE` and cancellation-after-admission paths record `admitProviderLaunch` committed the preparation before any broker/spawn step, and `stops and quarantines when a cancellation races an admitted spawn` proves convergence stops/quarantines rather than claiming rollback. `admitProviderLaunch`'s doc comment states the in-flight limit.
3. **`command.driverId` cast on the tolerated unknown-driver branch — NOT changed.** My admission work reads `command_spec_json` through the strict `parseProviderCommandSpec` (a persisted unregistered driver fails closed as `CORRUPT_AUTHORITY`), so the tolerant decode is only on the sanitized projection path, which this task does not touch. Fixing it would require widening `ProviderCommandSpec`, which Task 4 owns. **Parked to Task 4**, unchanged from Task 2.

## Concerns and honest limits

- **The managed path is unproven against any real provider.** By design: the shipped support matrix is empty and the fake certification exists only in tests. The managed/none machinery is framework proof, never built-in certification, and it appears in no production projection.
- **This is exact-secret disclosure mitigation, not containment.** A credential-bearing child can transform, encode, derive from, or transmit its own credential. Network/tool sandboxing and adversarial-provider confinement are explicitly outside this stage.
- **Environment isolation redirects home/config resolution; it cannot stop a child reading an absolute path it was handed.** The isolation test asserts the invariant it can actually hold (the driver's fallback *resolution* finds nothing) and says so in a comment rather than overclaiming.
- **The provider path is dormant.** `launchProviderBacked` requires `ProviderLaunchPorts`, which no production caller constructs; the census confirms `providerSelection` appears in production only in the claim/retry/attempt contracts and the wire decoder. Task 4 migrates the callers.
- **`task_launch_admissions` v5 upgrade drops existing rows** rather than backfilling. Those rows are ≤30s transient receipts whose preparations the Catalog already purges; backfilling would have invented authorization tuples for admissions that never carried them.
- **Renderer UI, settings migration, and the LSP-grade census remain Task 4's**, as the brief specifies. The census recorded here is tracked-source evidence, not LSP evidence (LSP remains unavailable, consistent with the preflight note).
