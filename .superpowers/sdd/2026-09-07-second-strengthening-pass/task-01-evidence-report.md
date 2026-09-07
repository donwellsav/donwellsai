# Task 01 evidence enforcement report

## Changed files

- `scripts/check-package.mjs`: rejects extra files and symlinks in packaged `extraResources` directories before comparing bytes.
- `tests/helpers/package-evidence.mjs`: shared deterministic external-resource file-set/content identity and exact directory check.
- `tests/helpers/smoke-processes.mjs`: shared strict clean-shutdown receipt predicate.
- `tests/acceptance/workspace-baseline.mjs`: records external-resource identity before and after the run and fails if it changes.
- `tests/acceptance/keyboard-journeys.mjs`: defers `verified:true` until workflow, source, artifact, shutdown and daemon cleanup checks finish; preserves `result.json` when cleanup/identity checks throw; checks page-two pixels.
- `tests/acceptance/terminal-recovery.mjs`: verifies actual hidden/shown window state and an input-produced redraw from the same TUI PID.
- `tests/workspace-baseline.test.ts`: regression coverage for stale files, symlinks, external identity changes and invalid shutdown receipts.

## Checks

- `node --check` passed for all changed `.mjs` files.
- `pnpm exec vitest run tests/workspace-baseline.test.ts` passed: 3 tests.
- `pnpm run package:check` passed: 187 production dependency notices verified, static package checks passed.

## Limits

- No application was launched. Installed package byte comparison, keyboard journeys, PDF rendering and terminal recovery remain for the controller's installed acceptance.
- Source and artifact identities are separate evidence. Matching packaged output still does not prove the current source produced it.
- Physical system sleep was not induced.
- Task 01 remains open pending installed acceptance and review.
