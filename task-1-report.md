# Task 1 report

## Delivered

- Added the typed runtime identity contract and authority for capture/verification across the Donwells app, terminal daemon, and ACP agent families.
- Added the Node-API native addon with macOS, Linux, and Windows process identity paths, bounded private-file reads, PID/start-time/executable checks, symlink/replacement defenses, and fail-closed Windows owner/DACL validation.
- Added deterministic native staging plus a platform/architecture/hash manifest, package checks, install/build lifecycle wiring, and native CI matrix coverage.
- Added authority and native smoke tests.

## Verification

- pnpm run typecheck — passed.
- pnpm run build — passed.
- pnpm exec vitest run src/main/runtime-identity.test.ts src/main/runtime-identity-native.test.ts — 2 files, 25 tests passed.
- pnpm run test:native-identity — native build passed; 1 file, 2 tests passed.
- Native addon probe — passed on darwin/arm64; contract 1; staged artifact 53,304 bytes; manifest SHA-256 97b2dc91fd864cd4f0666fbbfeb4718fd4183747b1ea531a62861f6f84fc83a2 matched bytes.
- pnpm run package:prepare — build, native-terminal/history steps, and native identity passed; stopped at pre-existing notices assertion: Missing license text: lazy-val@1.0.5.
- pnpm run package:check — same pre-existing notices assertion.
- Baseline proof: clean disposable archive of baseline 26d6fd489b56076dba03ae1e2e2a55ae6c1ce082 with the workspace dependency tree produced the identical lazy-val@1.0.5 assertion before the task changes.

## Residual

- Windows cross-compilation/runtime execution was not available on this macOS runner; Windows code is guarded in the native source and configured in the CI matrix.
- Full packaging completion remains blocked only by the baseline dependency-notices failure above; no notice-source workaround was added to this task.
