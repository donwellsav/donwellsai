# Stage 3 Task 2 — Provider Secret Authority

## Status

Complete. Commits on `roadmap/stage-3-provider-authority`:

| Commit | Subject |
|---|---|
| `7372ecd` | feat: add provider secret authority |
| `c35dae0` | feat: add the authenticated provider secret broker |
| `8d14167` | feat: delete raw renderer secret authority |
| `e181efa` | feat: deliver the Graphiti password over bounded child stdin |
| `dd05737` | docs: record the Task 2 secret authority report |

Base: `722752b` (Task 1 catalog complete).

## Scope

Electron main now owns Secret Authority and the daemon keeps owning Catalog
selection. Provider credential material lives in a separate versioned
`provider-secrets.enc.json`, unrelated Graphiti secrets keep their existing
authority, the renderer has no raw secret surface at all, and the Graphiti
worker password travels only on a bounded anonymous stdin pipe. Task 2 does not
change live provider launch selection, renderer launch controls, or any
production launch caller.

## What was built

### `src/shared/provider-secret-broker.ts` (new)

Renderer-safe credential contract plus the versioned `provider-secret-broker-v1`
frame types. Decoders are field-by-field against exact key sets: a malformed,
extended, or foreign frame is refused rather than partially read. The transport
envelope keys `id`/`op` are the only tolerated extras on a response, and a
credential value is bounded and must be free of every C0 control and DEL.

### `src/main/provider-secret-authority.ts` (new)

Two classes:

- `ProviderSecretAuthority` — the protected store. Electron 44 async
  `safeStorage` only (`isAsyncEncryptionAvailable`, `encryptStringAsync`,
  `decryptStringAsync`); Linux `basic_text` classifies as `unprotected` and
  refuses persistence and materialization; a temporarily unavailable backend
  never falls back to plaintext. Writes use an exclusive temporary file, fsync,
  atomic rename, and parent-directory fsync, and an invalid store is preserved
  and fails closed. The full binding tuple lives inside the encrypted payload,
  so copying ciphertext or cleartext metadata between records can never retarget
  a credential; `shouldReEncrypt` is honoured with an atomic replacement. One
  serialized queue means a revoke blocks every later materialization.
- `ProviderCredentialAuthority` — the saga orchestrator. It returns only a
  sanitized projection plus a `CredentialStatus`, and never a ref, generation,
  or operation id.

### `src/main/provider-secret-broker.ts` (new) + `src/main/provider-catalog.ts`, `schema.ts`

`ProviderSecretBrokerHost` is the daemon side: one live broker, registered only
after Runtime Identity verifies the current app owner against the daemon's own
ownership row; daemon-created request IDs and connection epochs; bounded
deadline; exactly one schema-validated response; disconnect invalidation with
late-response drop; fresh epoch on reconnect. The broker op surface dispatches
before ordinary command handling, and the client consumes broker frames before
pending correlation, so no secret-bearing response is reachable from
`DaemonClient.call`, renderer/runtime RPC, CLI, plugins, event replay, or debug
serializers.

Schema v4 widens the credential-operation state machine with the
`catalog-bound` checkpoint. SQLite cannot alter a CHECK constraint, so existing
databases get a replay-safe table rebuild; fresh databases take the widened DDL
directly.

### Renderer surface

`secretSet`/`secretGet`/`secretDelete`/`secretAvailable` are deleted from
`IpcApi`, preload, and main with no alias. Three action-specific methods
(`providerCredentialWrite`, `providerCredentialStatus`,
`providerCredentialRevoke`) authorize the exact main window and frame and return
only the sanitized projection plus `CredentialStatus`.

### Graphiti channel

`projectTemporalKnowledgePasswordSet` and the `graphiti:<project>:neo4j` durable
secret authority are preserved. `DONWELLS_NEO4J_PASSWORD` is removed: trusted
main resolves the bounded password immediately before each finite worker spawn,
writes it only to the child's anonymous stdin pipe, closes the pipe, and
releases its plaintext reference. The Python worker performs one bounded startup
read and rejects missing, oversized, invalid-UTF-8, and control-bearing input;
it never forwards the bytes.

## Provenance and non-vacuity

Every defect below was found by the tests written for this task, not by
inspection, and each was fixed at the source:

1. **Non-reentrant authority-lock deadlock.** The governed-mutation saga guard
   opened a second connection inside the caller's transaction. The process-wide
   authority lock is not reentrant, so every governed mutation hung. The guard
   now reads the caller's own `DatabaseSync` handle. This was caught by the test
   run hanging for 600s.
2. **Sealed tuple authenticated the pre-bind revision.** The record authenticated
   the instance revision the caller saw, but a winning bind publishes
   `revision + 1`, so the credential could never materialize for its own launch.
   The orchestrator now seals the published revision, and
   `bindStagedCredential` asserts the increment is exactly one.
3. **Non-monotonic credential revision.** Every replacement restarted at 1, so a
   renderer could not order credential states. The revision now continues the
   store's monotonic counter.
4. **Revocation returned `absent`.** Reading status after retirement reported
   the account as never having had a credential. Revoke now returns the status
   read at the moment of revocation.
5. **Broker response parser rejected its own transport envelope**, and a
   stale-epoch frame threw where it should have been discarded. Both fixed: the
   envelope keys are tolerated and a stale epoch or unknown request ID is
   dropped without settling anything.

Earlier crash-injection tests were themselves wrong (bad ledger rewrites, a
double-close) and were rewritten to drive the real saga steps at each crash
boundary rather than to assert on fabricated state.

## Verification

| Gate | Result |
|---|---|
| `vitest run src/main/provider-secret-authority.test.ts` | 22 passed |
| `vitest run src/main/provider-secret-broker.test.ts` | 10 passed |
| `vitest run src/main/project-temporal-knowledge.test.ts` | 7 passed |
| `vitest run src/main/provider-catalog.test.ts src/main/task-authority/task-authority.test.ts` | 59 passed |
| `vitest run src/main/terminal-daemon.test.ts src/main/daemon-client.test.ts` | 32 passed |
| `pnpm test` (full) | 407 passed / 6 skipped (baseline 368/6) |
| `pnpm typecheck` | passed |
| `pnpm build` | passed |
| `pnpm package:check` | passed |

### Tracked-source census (the brief's Step 5 requirement)

```
git grep -n "secretSet|secretGet|secretDelete|secretAvailable" -- 'src/**'   → NONE
git grep -n "DONWELLS_NEO4J_PASSWORD" -- 'src/**'                            → NONE
git grep -n "os.environ" -- 'src/main/project-knowledge-worker.py'           → NONE
git grep -rn <removed methods> -- 'src/renderer/**'                          → NONE
git grep -n "secret" -- 'src/preload/**'                                     → NONE
git grep -c "DONWELLS_NEO4J_PASSWORD" -- out                                → out clean
```

The Graphiti authority is intact at `src/main/index.ts:117/926/1054/1058/1060`.

## Test coverage against the brief's Step 1 list

| Required case | Where |
|---|---|
| put → inspect returns status, never plaintext | secret-authority: round-trip test |
| put → materialize exact tuple returns only driver-declared environment | secret-authority: round-trip test |
| wrong instance / account / account revision / instance revision / binding generation | secret-authority: mismatch test |
| encrypted-record and Catalog-binding swap across two accounts | secret-authority: mismatch + record-copying tests |
| credential-ref substitution and stale binding generation | secret-authority: mismatch test |
| revoke → future materialization denied | secret-authority: race test |
| materialize/revoke race → one serialized result | secret-authority: race test |
| missing/corrupt ciphertext → unavailable, original preserved | secret-authority: corrupt-store test |
| `shouldReEncrypt` → atomic replacement | secret-authority: rotation test |
| Linux `basic_text` → unavailable | secret-authority: unprotected test |
| backend unavailable → no plaintext fallback | secret-authority: unavailable test |
| write interruption → old complete store readable | secret-authority: interrupted test |
| create/replace crash at every boundary → exactly one active ref | secret-authority: three crash-boundary cases |
| bound update/removal crash → completes or blocks, no orphan | secret-authority: revoke reconciliation, third-binding blocked, identity-mutation guards |
| duplicate registration, timeout, disconnect, stale epoch, wrong correlation, malformed response, reconnect, marker absence | broker suite |
| Graphiti marker on stdin only; missing secret, worker failure, cancellation, timeout, output overflow | temporal-knowledge suite |

## Concerns

1. **`taskWireInteger` for generation fields.** The daemon's credential ops use
   `taskWireInteger(..., 1, Number.MAX_SAFE_INTEGER)` rather than
   `taskWireEntityVersion`, because the latter has no maximum parameter. The
   wire result is equivalent; the naming is slightly off for a credential
   generation. Low risk, cosmetic.
2. **`retireCredentialBindingForOperation` returns `void` on the wire facade**
   while the in-process interface returns a projection. The projection is
   discarded deliberately — the orchestrator re-reads status anyway — but the
   asymmetry is worth folding into one shape when Task 3 touches the seam.
3. **Reconciliation blocked states need an operator path.** A third-binding
   conflict is left intact and reported (`reconcile().blocked`), and main logs
   it as a warning. There is no UI surface for resolving it yet; Task 4 owns the
   sanitized management UI. Until then the affected tuple stays fail-closed for
   credential operations, which is the intended behaviour.
4. **The in-flight limit is documented, not solved.** Revocation prevents every
   future materialization but cannot retract bytes already consumed by an
   admitted OS child spawn. No admission path consumes the broker during Task 2
   (that is Task 3), so this is a documented boundary rather than a live gap.
5. **No production managed driver is certified**, so `PROVIDER_CREDENTIAL_ENVIRONMENTS`
   ships empty and every managed materialization fails closed with
   `AUTHORIZATION_INVALID` until a driver is reviewed into the table. This is
   the intended Stage 3 state; the managed path is proven by tests that inject a
   reviewed certification, exactly as the plan requires.
6. **Pre-existing teardown noise.** The full suite still emits
   `profile maintenance disconnect bookkeeping failed` warnings during daemon
   teardown. They were present on the exercised daemon path before Task 2 and do
   not fail any test.
