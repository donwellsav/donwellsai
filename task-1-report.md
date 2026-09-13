# Task 1 report

## Delivered

- Added the typed runtime identity contract and authority for capture/verification across the Donwells app, terminal daemon, and ACP agent families.
- Added the Node-API native addon with macOS, Linux, and Windows process identity paths, operation-specific absence classification, bounded private-file reads, PID/start-time/executable checks, symlink/replacement defenses, and fail-closed Windows owner/DACL validation.
- Preserved full-width Windows volume serial identities and made all post-target-acquisition observation failures indeterminate native errors rather than authoritative process absence.
- Added atomic native staging plus a platform/architecture/hash manifest, byte-exact packaged manifest checks, unique packaged-resource discovery, install/build lifecycle wiring, and native CI matrix coverage.
- Added authority tests plus real native process and private-file contract tests.

## Verification

- pnpm exec vitest run src/main/runtime-identity.test.ts src/main/runtime-identity-native.test.ts — 2 files, 29 tests passed.
- pnpm run test:native-identity — native build passed; 1 file, 6 tests passed.
- pnpm run typecheck — passed in 0.89 seconds.
- pnpm run build — passed in 2.35 seconds.
- Native addon/hash probe — passed on darwin/arm64; process contract 1; private-file security contract 1; staged artifact 53,304 bytes; manifest SHA-256 9e8cc1ee6a78e8e3c3d02a9cca8b9cdbb00767c2c1183721b60bfc833049a8b2 matched the staged bytes; self identity, out-of-range PID classification, and secure private-file read passed.
- Synthetic CI discovery probe — zero, one, and multiple candidate trees produced counts 0, 1, and 2 respectively, including a path containing spaces.
- pnpm run package:prepare — application build and native identity rebuild passed; stopped at the pre-existing notices assertion: Missing license text: lazy-val@1.0.5.
- pnpm run package:check — stopped at the same pre-existing notices assertion.
- Baseline proof: clean disposable archive of baseline 26d6fd489b56076dba03ae1e2e2a55ae6c1ce082 with the workspace dependency tree produced the identical lazy-val@1.0.5 assertion before the task changes.

## Residual

- Linux and Windows runtime execution was not available on this macOS runner; those platform paths remain CI evidence only and are not claimed as locally verified.
- Full packaging completion remains blocked only by the baseline dependency-notices failure above; no notice-source workaround was added to this task.
