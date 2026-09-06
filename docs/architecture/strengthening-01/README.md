# Task 01 strengthening pass

Current baseline verified from the execution checkout on 2026-09-06. Existing implementation is preserved; no later task is complete merely because its old code exists.

## Strengthening

`node scripts/check-package.mjs --resources /absolute/app/Contents/Resources` now compares actual shipped application files and external resources with the current build. The 718 application files match in both directions; 29 CLI/launcher/notice resources match. Finder .DS_Store metadata is explicitly excluded. A deliberately stale notice in a disposable copy fails the check. No new dependency: the checker reuses electron-builder's installed ASAR reader. This establishes built-output/package identity, not reproducible-build or release certification.

## Current evidence

- Typechecks, build, packaging input checks pass; 405 tests pass and seven optional native checks skip in the general suite. Their live qualification belongs to the owning tasks.
- The unsigned package at `/tmp/donwells-strengthen-01-package/mac-arm64/donwells.app` launched with isolated profiles. Ten fresh-process launches pass; filesystem caches were not evicted.
- Baseline: 200 idle and 200 loaded echo samples, 200 keyboard/echo samples, 200 tab-switch samples, separate Electron/daemon resource observations. These are not physical key-to-pixel latency measurements.
- Recovery: current terminal identity, hidden views, unsaved drafts, undo/redo and process relaunch exercised by the existing live runner; no renderer errors. Native VoiceOver/additional-language checks are deferred by explicit user instruction.
- The initial native launch found OMP/Hermes/Kimi but not DSH on the shell PATH. The configured rerun adds only the already-admitted DSH trial binary directory and trial-home environment for that child run. All four produce terminal output, preserve executable hashes and clean up. No model prompt was submitted; startup does not qualify model use.
- Source-to-artifact identity is the separately captured output manifest plus successful checker. Receipt source fingerprints include the then-current dirty work; historical source receipts are not relabeled as fresh results.

## Six-journey baseline and remaining ownership

| Journey | Current observation | Remaining work |
|---|---|---|
| Start | Actual four-agent startup in the packaged workspace | Native model turns, configuration and resume: Task 07 |
| Collaborate | Four live agents coexist in one disposable checkout; shell pane continuity passes | Work ownership and conflict coordination: Task 18 |
| Continue elsewhere | Handoff review, stale-source rejection, receiver acknowledgment, export and persistence across app processes pass | Native model continuation: Task 10 |
| Understand | Exact source-line open/edit/save, missing-source message, project isolation, movable search and native MCP routing pass | Unified retrieval/navigation: Tasks 11–13, 27 |
| Build and verify | Current source builds/tests/packages and shipped bytes match | In-app reproduce/fix/replay workflow: Tasks 14–17 |
| Return and ship | Terminal/draft/layout recovery across GUI restart passes | Installed update/rollback and six complete workflows: Tasks 21–22 |

## Admission review

No new runtime dependency was added. Existing package pins/lockfiles are retained. The exact component, LanceDB/model and ast-grep admission receipts remain the provenance record; Task 03 rechecks selected services. Native tools stay externally configured until their delivery requirements and notices are qualified. This pass does not turn a prior rejected bundle into an admitted one. User-directed Task 02 skip retains xterm/FlexLayout and removes native VoiceOver/IME as blockers for the GUI work.

Task 01 records a baseline including unsupported portions; it does not claim the six finished product journeys.
