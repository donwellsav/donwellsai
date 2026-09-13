# Task 2 report

## Delivered

- Replaced socket/token-only discovery with a version-2 runtime locator that is accepted only when every owner ID, generation, endpoint, token, process-identity, and SHA-256 field matches the active SQLite authority row.
- Added strict same-handle native runtime-file reads, canonical private-directory validation, stable file identities, fail-closed POSIX ownership/mode checks, and Windows owner/DACL/reparse validation.
- Added compare-bound runtime ownership with `BEGIN IMMEDIATE`, `busy_timeout=1000`, WAL, `synchronous=FULL`, durable generation watermarks, endpoint-history non-reuse, audit rows, schema migration through version 4, and canonical authority identity checks before commit.
- Made writable authority access use a same-inode stable hardlink while the native name lock is held, then require `wal_checkpoint(TRUNCATE)` to reach an empty durable state before reporting success. A blocked or incomplete checkpoint fails closed with `DATABASE_UNSAFE`.
- Made read-only authority access filesystem-nonmutating: POSIX uses an immutable SQLite URI backed by the validated open `/dev/fd` descriptor; Windows holds the validated canonical handle without delete sharing and reads the canonical path. Missing authorities, callback failure, and killed readers create no database, alias, WAL, SHM, or lock artifacts.
- Implemented idempotent app and terminal-daemon claim, bind, locator publication, activation, active republish, and exact-generation release. Startup failures retain preparing evidence and the same server/daemon instance resumes the same owner, generation, and endpoint; shutdown retains locator evidence while releasing authority.
- Added exact runtime identity handshakes and active-owner resolution to daemon and CLI clients. Ordinary CLI commands and `memory-mcp` reject locator/authority mismatch before endpoint connection.
- Added resumable evidence-first legacy/orphan recovery behind the sole `runtime-recovery inspect|quarantine` command; the former `runtime-inspect` and `runtime-quarantine` aliases are absent.
- Added deterministic CLI compilation with emitted shared-module resolution plus permanent built-output coverage for the app, terminal daemon entry, ordinary CLI entry, and memory MCP path.

## Verification

- `pnpm exec vitest run src/main/runtime-identity.test.ts src/main/runtime-identity-native.test.ts src/main/local-runtime.test.ts src/main/runtime-ownership.test.ts src/main/runtime-rpc.test.ts src/main/terminal-daemon.test.ts src/shared/runtime-ownership.test.ts src/cli/runtime-recovery.test.ts src/cli/rpc-client.test.ts src/main/daemon-client.test.ts` — **10 files, 98 tests passed, 2 platform-conditional tests skipped**.
- `pnpm test` — **10 files, 98 tests passed, 2 skipped**.
- `pnpm run typecheck` — passed with no errors.
- `pnpm run build` — passed; emitted the canonical `out/main/terminal-daemon-entry.js`, app main/preload/renderer artifacts, and resolved `dist-cli` output.
- `pnpm run build:native-identity && pnpm run check:native-identity` — passed on Darwin arm64. The implementation gate verified SHA-256 `625a95ab0ae292ae9d4ecae73343e200e06f038da53403bdc60b20e50dfc9794`; the independent accepted review rebuilt and verified SHA-256 `279ec390fe77aa9d8e3fe1847c57c41726525bb3b6476e196047649199596d46` against its staged manifest.
- `pnpm exec playwright test e2e/runtime-identity.e2e.ts --project=electron` — **4 tests passed**: built app publication/close/locator retention, built terminal daemon handshake/stop/locator retention, actual ordinary `cli/donwells.mjs` success through a `0500` profile, and initialized memory MCP mismatch rejection before connection.
- Direct existing-authority probe in a private `0500` directory — read-only query succeeded; directory mtime, entry set, and bytes were unchanged. Direct missing-authority probe returned `not-found` with no file and an empty directory.
- Native callback failure and SIGKILL probes — no read-only alias or sidecar existed before, during, or after termination. The Windows-conditional native test requires canonical rename to fail while the read-only handle is held.
- Concurrent reader/writer probe — a reader-held snapshot prevented WAL truncation; the writer returned typed `DATABASE_UNSAFE`, and the committed authority was recoverable after the reader released and checkpoint completed.
- Built CLI smoke — `memory-mcp --help` exited 0; the initialized mismatch probe exited 0 with `mismatch=true` and `connections=0`; `runtime-inspect` and `runtime-quarantine` exited 2 as unknown while `runtime-recovery --help` exited 0.
- Independent eighth review at `e763ccf1bd3f5a249c296588374250ce8a858307` — runtime correctness **PASS**, scope compliance **PASS**, `approval=true`, zero findings.
- `git diff --check` passed, generated Playwright reports were removed, and the implementation worktree was clean at the accepted head.
- `pnpm run package:check` reached the pre-existing notices gate and stopped before Task 2 package checks with `Missing license text: lazy-val@1.0.5`. No licensing data or notice checks were changed to bypass it.

## Residual

- Runtime behavior was executed locally on Darwin arm64. POSIX descriptor lifetime, immutable SQLite URI reads, `0500` access, callback throw/SIGKILL behavior, WAL checkpointing, built CLI, app, terminal, and MCP paths are grounded there.
- Windows `GENERIC_READ`/`OPEN_EXISTING`, no-`FILE_SHARE_DELETE` fencing, owner/DACL/reparse validation, and zero-alias behavior are source-reviewed and covered by Windows-conditional native tests in the Darwin/Linux/Windows CI matrix, but no current Windows runtime receipt is claimed. Linux was not executed locally.
- Full package-boundary completion remains blocked only by the independent `lazy-val@1.0.5` notice-source failure above. TypeScript LSP reference/diagnostic initialization was unavailable in this workspace; the successful project typecheck is the compiler evidence.