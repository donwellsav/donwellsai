# Stage 1 Task 2 — Runtime ownership implementation report

## Scope

Implemented local runtime ownership fencing across the app RPC server, detached terminal daemon, daemon client, CLI discovery/recovery, strict runtime-file reads, and native addon packaging metadata.

## TDD evidence

- RED: authored behavior tests for strict v2/legacy parsing, same-handle runtime-file reads and path replacement, durable POSIX/Windows file identity observations, compare-bound SQLite ownership, stale/active/indeterminate owner outcomes, CLI read-only resolution, and resumable legacy recovery.
- GREEN: `pnpm exec vitest run src/main/local-runtime.test.ts src/shared/runtime-ownership.test.ts src/main/runtime-ownership.test.ts src/main/runtime-identity.test.ts src/cli/runtime-recovery.test.ts src/cli/rpc-client.test.ts` — **6 files, 40 tests passed**.
- GREEN: `pnpm exec tsc --noEmit --pretty false` — no output/errors.
- GREEN: `pnpm run build:native-identity` — native addon rebuilt and manifest includes runtime file security contract v1.
- GREEN: `pnpm exec vitest run src/main/runtime-identity-native.test.ts` — **6 tests passed**.
- Known baseline: `pnpm run package:check` reaches the existing notices assertion and fails on `lazy-val@1.0.5` missing license text before package checks; no runtime-contract failure observed.
- CLI direct smoke via `tsx`/`vite-node` was unavailable because neither executable is installed in this workspace; Vitest and TypeScript exercised the route's compiled source.

## Implemented surfaces

- `src/shared/runtime-file-security.ts`: validates addon contract v1, preserves missing vs invalid outcomes, hashes the exact bytes returned by one native same-handle observation, and validates POSIX/Windows identity shape.
- `src/shared/runtime-ownership.ts`: SQLite WAL/FULL durability, schema v1, compare-bound `BEGIN IMMEDIATE` claims/activation/republish/release, audit rows, read-only resolution, and resumable legacy recovery records.
- `src/main/local-runtime.ts`: exact v2/legacy parser and same-handle runtime record reader/writer.
- `src/main/runtime-ownership.ts`: fresh endpoint generation, owner claim/publication/activation, failure cleanup for internally-created stores.
- `src/main/runtime-rpc.ts`: app RPC startup publishes a v2 locator only after endpoint bind; shutdown releases only its exact generation and preserves preparing evidence.
- `src/main/terminal-daemon.ts`: terminal startup follows the same claim/bind/publish state machine and releases only its exact generation on idle shutdown.
- `src/main/daemon-client.ts`: v2 locator resolution is checked against the read-only active-owner row and process identity; legacy remains explicit/liveness-gated; spawned daemons are discovered through the newly published endpoint.
- `src/cli/index.ts` and `src/cli/runtime-recovery.ts`: early `runtime-recovery inspect|quarantine` path with exact SHA-256 confirmation and evidence-first resumable quarantine.
- `scripts/build-runtime-identity.mjs`, `scripts/check-package.mjs`: manifest/package gate now checks runtime file security contract v1.

## Self-review / concerns

- Shutdown intentionally leaves a preparing row after an interrupted bind so reconciliation has durable evidence; active rows are released generation-scoped.
- Stale orphan v2 locators are not treated as authenticated live owners; daemon-client permits replacement only when the ownership DB has no active row, while locator replacement remains atomic.
- Recovery's optional reachability callback is synchronous by design in this pass; the normal CLI route does not claim a live legacy endpoint and requires exact confirmation.
- Package validation remains blocked by the pre-existing `lazy-val@1.0.5` notices assertion; this is unrelated to runtime ownership changes.
