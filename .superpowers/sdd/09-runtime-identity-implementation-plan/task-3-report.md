# Task 3 report

## Delivered

- Replaced ACP snapshots’ top-level PID with the complete `ProcessIdentity` contract and migrated version-1 journals transactionally to schema version 2, removing legacy PID data, clearing permissions, and marking non-exited work uncertain.
- Injected the runtime identity authority into ACP process/session ownership, captured identity before the first starting or ready publication, and prevented any ready ACP session from carrying a null identity.
- Made startup cleanup ownership-safe: failed identity capture retains the daemon’s starting reservation until an unverified child actually exits, first-publication failures terminate and verify the detached child before rejection, and missing-executable spawn errors are consumed before PID capture instead of becoming uncaught daemon errors.
- Centralized ACP owner-stop classification across direct stop, deferred stop, prior-session replacement, and failed prompt cleanup. Every stale verdict is accepted as exited; valid and non-legacy indeterminate verdicts retain fail-closed uncertain ownership, including when `owner.stop()` rejects.
- Applied identity verdicts consistently to retained ownership, protocol-history reuse, authentication, startup-failure classification, ownerless stop, and dismissal. Journal-only legacy dismissal releases history reuse without granting runtime ownership or signaling a PID.
- Cut ACP daemon traffic over to `agent-acp-v2`, added strict wire decoders for snapshots, observations, prompt records, and mode-switch receipts, and rejected old PID-shaped payloads at every response and unsolicited-event boundary.
- Removed ACP and terminal-daemon dependence on PID-only liveness probing; the obsolete execution-host probe has no remaining production callers.

## Verification

- `pnpm exec vitest run src/main/agents/acp-runtime-identity.test.ts` — **1 file, 26 tests passed** at the accepted head, including real detached-child cleanup, delayed unverified exit ownership, missing-executable spawn failure, all stale stop verdicts, and valid/indeterminate stop rejection.
- `pnpm exec vitest run src/main/terminal-daemon.test.ts` — **1 file, 11 tests passed**, including a real protocol-3 socket handshake from an ACP-v1-only daemon that remains connectable for compatible operations but is rejected for ACP-v2 calls, plus PID-shaped response/event rejection.
- `pnpm test` — **11 files, 126 tests passed, 2 platform-conditional tests skipped**.
- `pnpm run typecheck` — passed with no errors.
- `pnpm run build` — passed; the terminal daemon, main/preload/renderer bundles, and CLI output were emitted successfully.
- `pnpm run test:native-identity` — native identity rebuilt on Darwin arm64; **16 tests passed, 2 platform-conditional tests skipped**. The staged runtime-identity artifact manifest SHA-256 was `dadee6535376347a62d50916ac813bbfafc9edb387c54727d076658f288ff17d`.
- Independent final review at `e650aec0ed3e107023fc99ac94a6d8e8613b70a7` — standards **PASS**, scope/acceptance **PASS**, runtime verification **PASS**, `approval=true`, zero findings.
- `git diff --check` passed and the implementation worktree was clean at the accepted head.
- `pnpm run package:check` reached only the independently established baseline notices gate and stopped with `Missing license text: lazy-val@1.0.5`; no licensing data or package check was weakened or bypassed.

## Residual

- ACP migration, daemon wire compatibility, detached-child cleanup, SQLite ownership/history decisions, full TypeScript gates, and native identity behavior were executed locally on Darwin arm64. Linux and Windows were not executed locally; their process-identity paths remain source-reviewed and platform-conditional/CI evidence only.
- Full package-boundary completion remains blocked only by the pre-existing `lazy-val@1.0.5` missing-license-text assertion.
- TypeScript LSP reference initialization was unavailable because the workspace language server could not locate a valid TypeScript installation; exact Git/grep censuses and the successful project typecheck supplied the callsite and compiler evidence.
