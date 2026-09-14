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
| `6d77d9c` | docs: correct the Task 2 commit list |
| `078837d` | fix: close provider secret authority review findings |
| `605f0ce` | docs: append the Task 2 fix-round-1 section |
| `aa6fdd3` | fix: never abort a saga whose staged secret still decrypts |
| `3224388` | docs: append the Task 2 fix-round-2 section |
| `26d1709` | test: observe staged credential state instead of scanning bytes |
| `b95f6d4` | docs: append the Task 2 fix-round-3 section |
| `0eaf238` | test: extend record-state assertions to the remaining byte scans |

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

## Fix round 1

Three findings from `Stage3Task2Reviewer` (`approved=false`), all confirmed at
source and all fixed at the source rather than at the symptom. Non-vacuity was
proven, not assumed: with the source fixes stashed back to `6d77d9c`, the five
new tests fail **5 failed / 22 passed**; with the fixes restored they are
**27 passed**.

### P1 — materialize consumed the plaintext it was about to hand the launch

`materializeProviderLaunch` sealed `opened.credential` in its rotation branch,
and `seal()` wipes `record.secret = ''` on that same object. The environment loop
then read `opened.credential.secret`, so **every driver-declared variable
materialized as an empty string, silently**. The rotation `persist` also ran
before the driver-environment check, so a call that then failed with
`AUTHORIZATION_INVALID` had already mutated the store.

Fix: the no-environment refusal is now evaluated **before** any write, the
plaintext is captured into a local, rotation seals an explicit copy
(`{ ...opened.credential, secret }`), and the environment is built from that
local.

Tests: rotation yields `{ OPENAI_API_KEY: MARKER }` — asserted non-empty — with a
higher store revision and a clean second materialization; a no-environment driver
is refused with the store revision unchanged.

### P2 — reconciliation swallowed revocation failures and closed anyway

`reconcile()` used `.catch(() => undefined)` on three `revokeProviderCredential`
calls and then unconditionally closed the operation to `complete` or `aborted`.
`revokeProviderCredential` can genuinely throw (`load()` →
`CORRUPT_SECRET_STORE`; `persist` → I/O), so **a superseded or revoked credential
could survive as decryptable material forever with no blocked report**.

Fix: every revocation in the loop now sits in a real catch that pushes
`operation.id` onto `blocked` and `continue`s **without closing the operation**,
mirroring the retirement handling already present in the same loop. No
`.catch(() => undefined)` remains in the file.

Tests: a corrupt store during reconcile yields
`{ resolved: 0, blocked: ['failing-revoke'] }` with the operation still
incomplete and the binding not retired; once the store is readable again,
reconciliation completes it idempotently.

### P3 — `abandon()` rewrote intents that had already published a binding

`abandon()` closed any operation in `pending` **or** `catalog-bound` as
`aborted`. So a saga whose superseded-ref revoke failed after the Catalog had
already published the target generation was recorded as a terminal falsehood that
reconciliation would never revisit. The same applied to `revoke()`: if
`retireCredentialBindingForOperation` threw after a successful revocation,
`abandon` closed the `pending` row and **the active Catalog binding kept naming a
revoked ref with no incomplete row left to finish it**.

Fix: `abandon()` now closes only a pre-bind `pending` intent, so a bound saga
stays incomplete for reconciliation to finish (revoke prior, then complete);
`revoke()` no longer calls `abandon` at all and rethrows with its `pending` intent
intact; and the lost-compare-and-set branch aborts only once the staged ref is
provably revoked, rethrowing without aborting if that revoke fails.

Tests: a `catalog-bound` operation whose superseded revoke fails stays
`catalog-bound` and blocked, then reaches `complete` once the store is readable;
a failed `revoke()` leaves exactly one incomplete operation with the binding
still live, and reconciliation completes the exact revoke-then-retire path.

### Gates (fix round)

| Gate | Result |
|---|---|
| `vitest run src/main/provider-secret-authority.test.ts` | 27 passed |
| `vitest run provider-catalog + task-authority + provider-secret-broker + project-temporal-knowledge` | 76 passed |
| `pnpm typecheck` | passed |

Full `pnpm test`, `pnpm build`, and `pnpm package:check` are deferred to the
round owner as instructed.

Constraints held: no raw renderer secret surface was restored, no plaintext is
persisted or rendered, and launch selection and renderer launch controls are
untouched.

## Fix round 2

One same-class hole remained from round 1, reported by Main and confirmed at
source: an **`aborted` row must never coexist with a live sealed staged record**,
because `incompleteCredentialOperations()` skips terminal rows and reconciliation
therefore never revokes it.

Non-vacuity was re-established in fix round 3 after two of these tests were
found to prove nothing (see below). Against the pre-round-2 source
(`605f0ce`) the corrected tests fail **2 failed / 28 passed**, on the correct
grounds — a surviving live staged record and the wrong refusal code — and pass
**30 passed** with the fix. Focused suites (provider-secret-authority +
provider-catalog + task-authority) are **89 passed**, and `pnpm typecheck` is
clean.

### Instance 1 — the Catalog aborted its own lost compare-and-set

`bindStagedCredential` wrote `state='aborted'` **inside** its lost-CAS branch and
returned `false`, inverting the brief's order (`task-2-brief.md` line 122: revoke
the staged ref, **then** mark `aborted`). When the orchestrator's follow-up
`revokeProviderCredential` then threw, the row was already terminal, so
reconciliation never revisited it and the sealed staged secret survived
indefinitely with no blocked report.

Fix: the lost-CAS branch now only returns `false`; the row stays `pending` and the
orchestrator — which alone owns the staged ref — performs the revocation first.
The return value and the rest of the method are unchanged.

### Instance 2 (general fix) — `abandon()` is now proof-based

If `putProviderCredential` succeeded and `bindStagedCredential` then **threw**
rather than returning false — reachable from `requireRevision`
(`INSTANCE_CHANGED`/`ACCOUNT_CHANGED`), `CREDENTIAL_OPERATION_NOT_FOUND`, or
`guardForeignKeys('the target credential binding could not be published')` — the
catch called `abandon`, which closed the pending row `aborted` and stranded the
durable staged ciphertext.

Rather than patching each site, `abandon(operationId)` is now proof-based: it
reads the operation and, for a `create-replace` intent with a staged ref, revokes
that exact staged ref **before** closing `aborted`; if the revocation throws it
leaves the row incomplete and lets the original error propagate, so the caller
still sees its own failure. A destructive intent (`revoke` kind) stages no
material, so closing it stays safe, and a `catalog-bound` saga is still never
touched. Every write failure now funnels through this one path, so no future
call site can reintroduce the hole.

Reconciliation's `create-replace` branch now states the brief's three cases
explicitly: the published target completes; an **unchanged prior or absent**
binding revokes the staged ref and aborts (an absent binding is distinct from a
changed one); any **third** binding stays blocked for explicit recovery instead
of being guessed at.

### Tests (round 2)

| Test | Asserts |
|---|---|
| `keeps a lost compare-and-set recoverable when the staged revoke fails` | Unreadable store at the bind seam ⇒ the saga stays in `incompleteCredentialOperations()`, `reconcile()` reports it `blocked` with the third binding untouched; once the store is readable it stays blocked while the third binding stands, then reconciles (revoke staged, close) once that binding is gone, with no staged marker left in any profile file. |
| `aborts a lost compare-and-set once the staged ref is provably revoked` | No regression: a provable abort still terminates the saga, `incompleteCredentialOperations()` is empty, `reconcile()` is a no-op. |
| `leaves no decryptable staged material when a throwing bind can still revoke` | A throwing bind with a readable store leaves no incomplete saga and no decryptable staged material; the unreadable-store variant leaves exactly one incomplete saga, blocks, then recovers with no staged marker remaining. |

The existing `refuses a write whose expected revisions no longer match`
expectation stays green, as does the rest of the suite.

A note on the race harness: the two lost-CAS cases replace the binding
**out-of-band with direct SQL**, not through the saga API, because a concurrent
saga on the same tuple is refused by design (one live intent per
tuple). Driving it through the API would have tested that guard instead of the
recovery path.

## Fix round 3

Delta re-review approved all four product defects (`approved=true`) and found no
reachable product defect. Two **test-only** defects were repaired, because these
tests are the durable proof of the invariant and two of them proved nothing. No
product change was needed, which is itself a finding: the corrected assertions
pass against the shipped code.

### Defect A — assertions that could not fail

`FakeEncryption.encrypt` seals as `'sealed:' + base64(plaintext)`, and base64
cannot contain `-`. So every
`expect(profileBytes(directory)).not.toContain('staged-marker')` in the round-2
tests **passed in exactly the states the tests exist to exclude**; the Catalog
ledger stores only the opaque ref, so nothing on disk could ever contain the
literal. Verified directly: `Buffer.from('staged-marker').toString('base64')` is
`c3RhZ2VkLW1hcmtlcg==`, with no hyphen.

Replaced with assertions that discriminate in **both** directions, read through
the store's own records rather than a byte scan:

| Helper | Contract |
|---|---|
| `storeRecords(directory)` | The store's `records` map. **Fails the test when the file is absent**, so a missing store can never be silently read as clean. |
| `liveRefs(directory)` | Refs whose `ciphertext !== null`, i.e. whose material still decrypts. |
| `recordsOf(text)` | The records of a captured store document, for observing state while the file is unreadable. |

Per site the staged record's actual state is now asserted:

- **Abort succeeded** ⇒ the exact staged ref is present with `ciphertext: null`
  (an inert revoked tombstone), and `liveRefs` no longer contains it.
- **Abort could not run / stayed blocked** ⇒ the exact staged ref is present with
  `ciphertext: expect.any(String)` — the decryptable material genuinely survived.
  This is the half that proves the fix.

Refs are never asserted *absent*: `revokeProviderCredential` intentionally leaves
a tombstone, and asserting absence would have re-encoded the same mistake. Every
structural assertion (`incompleteCredentialOperations`, `reconcile`, binding refs)
was kept.

Two further byte scans in older cases (the unavailable-backend refusal and the
replacement lifecycle) had the same inability to fail and were given
discriminating neighbours as well: the refused ref now has no record at all and
only the original ref stays live, and a replacement leaves exactly one live
record with exactly one tombstone. Each surviving `profileBytes(...)` call is
retained solely as a plaintext-leak guard, which is the one thing a byte scan can
actually prove.

### Defect B — the unreadable-store scenario destroyed its own evidence

Both halves wrote `'{corrupt'` over the store path holding the just-sealed staged
record and later called `rmSync(storePath)`. The test therefore observed itself
deleting the material, and the following `reconcile()` "success" was an
idempotent no-op against a nonexistent record — it never observed a live staged
record surviving a failed revoke and then being revoked.

Both halves now capture the sealed bytes **at the corruption seam** and restore
exactly those bytes, so the staged record is genuinely durable while blind and
genuinely revoked afterwards. The strong invariant is asserted: while corrupt the
saga stays incomplete, blocked and untouched; after restoring, `reconcile()`
reports `resolved: 1` and the rewritten store shows `ciphertext: null` for the
exact staged ref.

An initial capture placed *before* the seal would have restored a pre-seal store
and destroyed the evidence a second time; placing the capture at the corruption
seam is what makes the observation real. The interrupted-create-replace boundary
test was also made variant-aware (no seal ⇒ no record at all; a seal ⇒ the
published target or a tombstone, with the superseded prior ref as the other half).

### Re-verified stash result

Only what was actually re-run is claimed here. Both source files were reverted to
`605f0ce` with the corrected tests in place:

```
× keeps a lost compare-and-set recoverable when the staged revoke fails
× leaves no decryptable staged material when a throwing bind can still revoke
Tests  2 failed | 28 passed (30)
```

The first fails on the wrong refusal code (the pre-fix source reported
`CREDENTIAL_ABSENT` where the contract requires `BINDING_CHANGED`); the second on
live records surviving. Both fail for the reason the invariant names, not on
assertion shape. With the fix restored: **30 passed**, focused suites **89
passed**, `pnpm typecheck` clean.

The round-2 commit message's non-vacuity claim was accurate as to *which* cases
failed but was made with the vacuous assertions in place; the corrected claim
above supersedes it.
