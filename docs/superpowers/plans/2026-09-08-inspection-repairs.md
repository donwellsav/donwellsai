# Inspection Repairs Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task by task. Default to inline execution. Do not dispatch subagents unless the user chooses that workflow. Steps use checkboxes for tracking.

**Goal:** Repair the failures reproduced in the September 8 inspection and produce one verified local macOS artifact matching the repaired source.

**Architecture:** Preserve Electron, React/Zustand, daemon-owned PTYs, native Ghostty/Xterm, and the existing local service boundaries. Fix the shared owner of each defect; reuse existing tests, process helpers and packaging checks. Add no new runtime dependency or broad service abstraction.

**Tech Stack:** Electron 44, React 19, TypeScript 7.0.2, Node, Swift/AppKit/Ghostty, pnpm and Vitest.

**Spec:** [Detailed inspection report](/Users/muzikfirst/Documents/donwellsai/workingfolder/inspection-2026-09-08/REPORT.md).

## Global constraints

- Work in `/Users/muzikfirst/Documents/donwellsai/donwellsai`, currently clean `main` at `f95d4d7`. Recheck HEAD and changes before execution; preserve newer work. Do not recreate old checkouts.
- The user approved execution with “go”. The status table and evidence below distinguish implemented work from pending qualification.
- No architecture rewrite, new framework, speculative cleanup, deletion of research/trash, remote-work resurrection, or compiler downgrade to hide incompatibility.
- Preserve existing projects, profiles, secrets, PTY identities, unsaved work and terminal history. Use isolated profiles and disposable fixtures for mutations.
- Use one desktop app at a time. Record and clean up only test-owned processes, windows and mounts. Do not submit model requests or use paid inference for these checks.
- Do not push, open a PR, publish, notarize with new credentials or replace `/Applications` without explicit authorization. Build and verify the local release candidate before requesting any such action.
- A bounded local commit per completed repair is appropriate during execution. Stage exact changed files; do not commit generated builds or unrelated changes.
- Tests validate logic. Visual acceptance requires observing the repaired app. Never mark terminal rendering complete from daemon liveness or copied text alone.
- Keep existing 01–26 product records; this is the defect-repair checklist, not a replacement product roadmap.

## Starting evidence and completion tracking

Baseline: build/typecheck pass; 563 tests pass, 1 fails, 15 skip. The failed CLI test is independently reproduced. Source is 0.5.0; unpacked app is 0.4.0; the 0.5.0 DMG also lacks current UI changes.

| Order | Repair | Depends on | Status |
|---|---|---|---|
| 1 | Restore project language tools with installed TypeScript | None | Implemented; 7 focused checks; desktop diagnostic, definition, references, edit and restart pass |
| 2 | Fix development resource roots for all callers | None | Implemented; 4 focused checks; root/direct-file/preview desktop launches, terminal input and metadata pass |
| 3 | Reproduce and repair terminal replay geometry | 2 | Implemented; source desktop restart/resize passes; packaged renderer switch exposed stale resize callbacks, corrected in 207361e; final visual retest blocked by locked Mac |
| 4 | Make terminal settings truthful and functional | 2; recheck 3 | Implemented; 11 focused checks; native spacing/copy-on-select and packaged Xterm weight/spacing visually verified; final replay qualification remains under task 3 |
| 5 | Repair parallel-run CLI argument compatibility | None | Implemented; all 9 CLI checks and typecheck pass |
| 6 | Honor Git ignores in Explorer and file search | None | Complete; 19 Git checks; Explorer ignored toggle verified in desktop; search already honored rules |
| 7 | Preserve credentials on corruption/write failure | None | Implemented; synthetic corruption and atomic failure checks pass; typecheck passes |
| 8 | Reconcile launch, handoff and release documentation | 1–7 | Current continuation, signing claims and candidate identity documented; final desktop acceptance remains open |
| 9 | Build and qualify the matching local release | 1–8 | Candidate built and package/DMG/shipped CLI checks pass; final desktop qualification pending manual Mac unlock |

After each row: update this table and report the complete nine-row checklist, local commit, user-visible result, focused check, visual proof and remaining limitations. Commit completion alone is not a stop condition during an authorized execution run.

## 1. Restore project TypeScript support

**Files:** `src/main/project-language-tools.ts` owns launch/transport and language operations; `tests/project-language-tools.test.ts` owns focused coverage; `tests/acceptance/language-editor.mjs` owns the real editor workflow. Change renderer error formatting in `src/renderer/src/project-language-tools.ts` only if needed to avoid duplicate/raw error text.

**Interface:** Keep `ProjectLanguageTools.open/change/diagnostics/definition/references/restart/stopProject/close` and shared result types. Preserve checkout scoping, version checks, one owner per checkout, bounded requests and verified shutdown.

**Decision already verified:** A bounded local probe of installed TypeScript 7.0.2 using `node node_modules/typescript/bin/tsc --lsp --stdio` returned an LSP initialize response advertising UTF-16 positions, definitions, references and pull diagnostics. This proves a compatible server entry exists, not that the full editor integration works. Retain the existing tsserver path when a project provides it; use the installed native LSP path when the legacy entry is absent. Do not install a second server or silently substitute a different project's TypeScript.

- [ ] Extend existing tests to cover legacy tsserver, native LSP, no TypeScript, installed-but-unusable TypeScript, and restart isolation. Replace the blanket “Install TypeScript” error with a distinction between absent package and unsupported/unlaunchable server.
- [ ] Reuse current Content-Length response framing and pending-request ownership. Select protocol at launch from verified local package entries. Legacy requests remain unchanged; LSP sends initialize/initialized, versioned didOpen/didChange/didClose, textDocument/diagnostic, definition and references, then shutdown/exit. Convert LSP zero-based UTF-16 ranges to existing one-based results; handle both Location and LocationLink definitions and diagnostic unchanged reports.
- [ ] Keep server-originated messages separate from request replies; bound headers, bodies and errors. Reject late replies from replaced generations. Resolve returned file URIs with Node URL helpers and verify they remain in the registered checkout.
- [ ] Run the focused check:

```sh
pnpm exec vitest run tests/project-language-tools.test.ts tests/language-tools.test.ts
```

- [ ] Extend the existing real acceptance runner beyond its hard-coded 5.9.3 fixture. With installed 7.0.2, show an actual type error, follow a definition into an unopened file, list references, edit the buffer, and stop/restart the service without losing the editor. Keep one legacy-server case. Commit only after both protocol paths meet their applicable checks.

**Done:** This repo opens its TypeScript files without the false missing-TypeScript warning and provides project-aware results. A compiler version string or initialize reply alone cannot close this task.

## 2. Make development launch roots consistent

**Files:** `src/main/native-terminals.ts`, `src/main/index.ts`, `tests/native-terminal-lifetime.test.ts`, `README.md`. If a shared helper is needed, add only `src/main/app-resources.ts`, used by the existing native and CLI-path callers.

**Interface:** Resource lookup must return the same native/CLI files for `electron .`, `pnpm preview`, and the documented direct-file debug launch. Packaged lookup continues using `process.resourcesPath`.

- [ ] Search every `app.getAppPath()` caller again. The inspection found native loading plus runtime metadata and harness memory CLI paths in `index.ts`; fix them together rather than patching Ghostty alone.
- [ ] Anchor the development root to the known bundled `out/main` location, not the runtime launch argument. The intended invariant is:

```ts
const resourcesRoot = app.isPackaged
  ? process.resourcesPath
  : resolve(__dirname, '../..')
```

Keep this logic once if all three callers need it. Do not add recursive directory searching or fallbacks to archived checkouts.

- [ ] Extend the native lifetime test to assert the requested binding path under both development launch roots; verify `meta` and Connect harness point to the existing CLI file. Run `pnpm exec vitest run tests/native-terminal-lifetime.test.ts`.
- [ ] Build once, launch each development form sequentially with an isolated profile, and run a harmless terminal marker. Verify native rendering and CLI resource existence, then quit before the next form. Preserve the same retained PTY when checking reconnect.
- [ ] Correct the README's supported launch instructions as part of this repair and commit.

**Done:** All documented launch forms work; no native or harness resource is resolved beneath `out/main/resources` or `out/main/cli`.

## 3. Repair native terminal replay without replacing the shell

**Files to trace:** `src/main/native-terminals.ts`, `src/main/terminal-daemon.ts`, `src/main/daemon-client.ts`, `src/main/pty.ts`, `src/shared/terminal-stream.ts`, `src/renderer/src/components/NativeTerminalPane.tsx`, `native/ghostty/Sources/DonwellsGhostty/DonwellsGhostty.swift`. Modify only the owner demonstrated by the reproduction. Checks belong in `tests/native-terminal-lifetime.test.ts`, `tests/terminal-bus.test.ts`, and existing `tests/acceptance/native-terminal.mjs` / `terminal-recovery.mjs` as appropriate.

**Interface:** Retain session ID and child PID; sequence snapshot/live output exactly once. Surface replacement must not restart or resubmit the process.

- [ ] Reproduce the recorded sequence: native shell → print marker → open/close side panels → open editor → return to terminal → quit → direct-file launch → project-root launch. Also isolate resize-only, restart-only and renderer-switch cases. Use numbered lines and a long wrapping line:

```sh
printf 'REPLAY-01\nREPLAY-02\n'
printf '%160s\n' 'REPLAY-WRAP-END'
```

- [ ] Record terminal columns/rows and event ordering at snapshot replay, surface reset, bounds assignment and PTY resize. Compare Xterm/native with the same process. Do not assume a GPU defect or change the Swift bridge from a screenshot alone.
- [ ] Correct the smallest demonstrated owner: geometry must be established before replay where required; snapshot/live sequences must not duplicate; stale generation updates must be ignored. If raw historical cursor movement cannot be faithfully replayed after geometry changes, determine whether the existing renderer can serialize canonical terminal state or whether ordered resize events are required. Do not substitute a cleared screen or a warning for the requested history preservation. An unresolved representational limit stays open.
- [ ] Add one focused regression at the proven failure boundary and run its existing test file. Extend the native acceptance sequence to exercise the actual width/restart trigger; do not create a parallel acceptance harness.
- [ ] Visually inspect restored numbered lines, wrapping, prompt position, fresh keyboard input, selection/copy and one redraw-capable TUI at narrow/wide widths. Assert unchanged session/PID and no repeated command execution, then commit.

**Done:** Clean visible restoration and continued input under the reproduced trigger. This is the highest-uncertainty task; evidence determines the patch, not a predetermined rewrite.

## 4. Make terminal settings work across renderers

**Files:** `src/renderer/src/components/TerminalPane.tsx`, `src/main/native-terminals.ts`, `src/shared/settings.ts`, `src/renderer/src/components/SettingsModal.tsx`; touch the existing Swift host only if required by a verified native capability. Extend `tests/native-terminal-lifetime.test.ts` and the existing settings/native acceptance checks.

**Interface:** Retain `AppSettings` names and persisted values. Settings changes must not restart PTYs.

- [ ] Wire Xterm creation and live updates to the existing fields:

```ts
fontWeight: settings.terminalFontWeight,
lineHeight: settings.terminalLineHeight,
```

Subscribe to both values in the existing effect and refit the surface after geometry changes. Do not introduce a second settings store.

- [ ] Read the pinned Ghostty configuration API before mapping font weight, line height, copy-on-select and scrollback. Use native equivalents where supported. Do not equate a line count with a byte limit. If an exact setting is unsupported, make its renderer-specific limitation explicit in the existing settings UI and disable only that unsupported control; preserve its value for Xterm. Report that limitation for review rather than silently ignoring it.
- [ ] Extend existing tests with non-default values; for supported native settings inspect emitted configuration, and for unsupported settings check the visible applicability rule. Validate that unrelated settings are preserved.
- [ ] Visually verify default/non-default font weight and line height in Xterm; verify supported native equivalents and truthful unsupported controls. Check copy-on-select and newly-created-terminal scrollback using disposable output and restore test clipboard state.
- [ ] Recheck task 3's resize/restart sequence after geometry changes, then commit.

**Done:** Every shown enabled control has the stated effect in the active renderer. No false cross-renderer parity claim.

## 5. Restore the CLI input contract

**Files:** `src/cli/arguments.ts`, `tests/cli.test.ts`; adjust command help/examples only if they currently contradict the chosen compatible forms. Preserve `src/shared/command-catalog.ts` validation.

**Interface:** `parallel-start` accepts its existing bare input object and an explicit parameter envelope. `--params` always means the full envelope. Adding optional `options` must not reinterpret a previously valid input object.

- [ ] Add the compact regression to the existing test:

```ts
const input = {
  name: 'Local', command: 'echo ok', concurrency: 1,
  targets: [{ kind: 'local', root: '.', label: 'local' }]
}
for (const value of [input, { input }]) {
  expect(parseCliArguments(['parallel-start', JSON.stringify(value)])
    .params.input).toMatchObject({ name: 'Local' })
}
```

- [ ] Disambiguate using the command's declared outer fields, not only total field count. Preserve wrapped `{input, options}`, explicit `--params`, ordinary multi-field JSON commands, duplicate-key rejection and duplicate positional/flag checks. Do not catch and retry validation with a different interpretation after a possibly meaningful error.
- [ ] Replace the stale accepted-remote-target assertion with explicit rejection; keep scheduled local-path resolution and delivery-confirmation coverage intact.
- [ ] Run `pnpm exec vitest run tests/cli.test.ts`; run equivalent CLI `--dry-run` forms to inspect normalized payloads without launching jobs.
- [ ] Commit the parser fix and its focused regression together.

**Done:** Both supported forms normalize identically, invalid input stays rejected, and the previously failing test is green for the correct local-only contract.

## 6. Honor Git ignores in Explorer and filename search

**Files:** `src/main/worktree-files.ts`, its callers in `src/main/git.ts`, and existing coverage in `tests/filesystem-confinement.test.ts` / `tests/git.test.ts`. Keep `includeIgnored` and `showHidden` separate.

**Interface:** Registered Git workspaces use Git's own ignore semantics; non-Git folders retain the documented fixed exclusions. No JavaScript glob dependency or unbounded per-file Git process.

- [ ] Add a temporary Git fixture with ignored build folders, a negated rule, spaces in a name, an ignored-looking tracked file and a nested directory. Verify listing and filename search with the toggle both ways, plus non-Git behavior.
- [ ] Reuse `runProcess` and ask Git in bounded batches:

```sh
git -C /path/to/registered/checkout check-ignore -z --stdin
```

Feed NUL-separated checkout-relative paths; output is NUL-separated. Exit 1 means no matches; treat operational failures explicitly. Respect tracked files, nested rules and `.git/info/exclude`; do not add `--no-index`, which would hide tracked files matching ignore patterns.

- [ ] Fix listing and filename search through their shared path. Preserve cancellation, result caps, hidden-file handling and symlink confinement. Do not silently treat a Git failure as successful ignore filtering.
- [ ] Run `pnpm exec vitest run tests/filesystem-confinement.test.ts tests/git.test.ts`. In the app, `dist`, `out` and `dist-cli` disappear with Ignored off and return when enabled; tracked source remains visible.
- [ ] Commit after both callers meet the same policy.

**Done:** The toggle matches Git behavior and does not merely change a label to conceal the missing capability.

## 7. Prevent credential loss on corrupt storage

**Files:** `src/main/secret-store.ts`, `tests/secret-store.test.ts`. Follow the existing atomic-write pattern in `src/main/store.ts`; do not refactor unrelated stores or add a general persistence framework.

**Interface:** `set/get/delete/available` remain unchanged. SafeStorage-unavailable behavior remains memory-only. Missing files are empty; malformed or unreadable existing files fail without overwriting their bytes.

- [ ] Extend the existing safeStorage mock test with malformed JSON and a protected backend:

```ts
const file = join(directory, 'secrets.enc.json')
writeFileSync(file, '{broken')
vi.mocked(safeStorage.getSelectedStorageBackend).mockReturnValue('gnome_libsecret')
expect(() => new SecretStore(directory).set('new', 'fixture')).toThrow()
expect(readFileSync(file, 'utf8')).toBe('{broken')
```

- [ ] Catch only ENOENT as absent. Validate a plain string-valued map and reject unsafe keys. Preserve read/parse errors; never replace corrupt content with an empty map and then persist it.
- [ ] Write encrypted values to a unique same-directory file with restrictive permissions, fsync, then rename; remove only a failed owned temporary file. Preserve the old file on encryption/write/rename failure. Never emit secret values in errors or logs.
- [ ] Run `pnpm exec vitest run tests/secret-store.test.ts`, covering corrupt-file preservation, interrupted replacement and memory-only fallback. Use only synthetic values; do not touch the normal user's credentials.
- [ ] Commit as a separate data-preservation repair.

**Done:** Corruption is reported and remains recoverable; a later set operation cannot erase other stored entries silently.

## 8. Reconcile current documentation

**Files:** `README.md`, `START-NEXT-SESSION.txt`, `HANDOFF.md`, `docs/handoff/CURRENT-STATE.md`, and the existing release/GUI records referenced there. Keep the inspection report as historical evidence.

- [ ] Align current branch/folder instructions, task 02's delivery, task 24's removal, and actual open work. Remove contradictory current continuation instructions; retain historical records as clearly historical.
- [ ] Document the supported development launch roots and the verified language-server behavior, including limits. Correct the current signing description; do not claim Developer ID or notarization from an ad hoc signature.
- [ ] Explain residual `native/lume` policy/reference material as retained history if that is its verified role; do not delete it or restore removed remote features as part of this repair plan.
- [ ] Audit links and current claims with:

```sh
rg -n 'workspace/terminal-foundation|Open tasks|Only02|SSH|Lume|Developer ID|Debug build' README.md START-NEXT-SESSION.txt HANDOFF.md docs/handoff
```

Review each hit in context rather than blindly replacing historical text.

- [ ] Update the original relevant task records with actual repair outcomes and limitations, then commit. Keep release hashes provisional until task 9 produces the final candidate.

**Done:** A new session can follow one consistent current set of instructions without reactivating removed work or opening a stale checkout.

## 9. Produce and qualify a source-matched local release

**Files:** Existing `scripts/check-package.mjs`, `build/electron-builder.json`, `tests/helpers/package-evidence.mjs`, `tests/acceptance/workspace-baseline.mjs` and current release documentation. Change scripts/config only if the checks expose a concrete packaging defect.

- [ ] Run the complete gates once after repairs; stop and fix failures before packaging:

```sh
pnpm typecheck
pnpm test
pnpm build
```

All tests must pass apart from explicitly reviewed environment skips; do not retain the known CLI failure or increase skips to make the run green.

- [ ] Preserve the existing release artifact and its hash in the working folder before replacing build output. Use existing package scripts to build one candidate from the repaired HEAD. Keep 0.5.0 unless the repository's actual release policy requires a version increment; identify the candidate by commit and SHA-256, not filename alone.
- [ ] Verify generated native files and notices before the build, then compare the unpacked bundle and read-only mounted DMG: package version, current left-rail strings, native modules, CLI launcher and key file hashes must agree. Run `hdiutil verify` and inspect actual codesign output. Do not overwrite the installed app.
- [ ] Launch the DMG's app from an isolated local copy. Perform project open → terminal marker → search → language diagnostics/definition → side-panel resize → terminal restart/replay → settings change → memory read → clean quit. Run parser checks with the shipped CLI. Add synthetic file-save/conflict recovery using the existing acceptance runner to protect the final integrated editor workflow. Record source identity, artifact hashes, observed results and honest limits.
- [ ] Clean up only candidate-owned app/daemon/fixture processes and mounts. Recheck source status and ensure no executable source changed after qualification. Update the release record with the final artifact path/hash and return a clickable DMG link.

**Done:** A verified local artifact matches the repaired source; the stale unpacked app cannot be mistaken for the current candidate. Publishing, system installation, signing-identity acquisition and notarization remain separate user-authorized actions.

## Final acceptance checklist

- [ ] All nine repair rows are complete with evidence, or an explicit unresolved defect remains visibly open.
- [ ] TypeScript project diagnostics and navigation work with the installed version.
- [ ] All supported launch forms resolve native and CLI resources correctly.
- [ ] Native terminal historical rendering and new input pass the reproduced restart/resize sequence without a process restart or command replay.
- [ ] Terminal settings work or show a precise renderer limitation.
- [ ] CLI input compatibility, Git-ignore behavior and corrupt-secret preservation have focused regressions.
- [ ] Full suite/typecheck/build are green with reviewed skip reasons.
- [ ] Source, unpacked app, DMG and release documentation agree.
- [ ] No research/trash/user data was removed and no publish/install action occurred.

**Scope intentionally excluded:** bundle-size optimization without a measured latency defect, splitting large files for size alone, unrelated UI redesign, external tool/model installation, and cleanup of pre-existing user/test daemons. Computer control's missing external driver is a setup prerequisite, not a reason to install it during these repairs.

## Execution evidence — September 8

- Local branch: `codex/inspection-repairs`. Focused commits: language `d24f753`, resource roots `4b97f5b`, settings `d85dbc6`, CLI `e0dea27`, credentials `646ba9b`, ignores `79bdb17`.
- Full suite after replay changes: 569 pass, zero failures, 15 existing skips (92 files); build and all three typechecks pass. Logs: `../workingfolder/inspection-2026-09-08/repair-{build,typecheck,tests}.log` relative to the repository.
- CUA desktop: project-root launch then direct-file restart, native markers REPLAY_ONE/TWO/THREE all show the same PID 21896. Files panel narrowed the terminal between markers. Restored prompts and history aligned; no shell restart or injected redraw command was used. Both owned source-test profiles and their daemons were cleaned up.
- CUA editor: installed TypeScript 7 project error 2322 shown; project-definition action opened previously unopened `definition.ts`; next-project-reference returned to consumer; corrected buffer survived language restart. This fixture used auto-save, so unsaved persistence relies on the focused service test rather than this visual check.
- CUA settings: native line height 1 → 1.5 visibly changed row spacing; copy-on-select copied `REPLAY_THREE pid=21896` into the disposable editor. Native numeric weight and approximate scrollback limits have visible explanations.
- CUA Explorer: `dist`, `dist-cli`, `out` hidden with Ignored off and visible with it on. Filename search found the ignored test file when opted in.
- Replay geometry is recorded by the new daemon. Old daemon histories lack original resize information; their legacy replay remains best effort without terminating their processes. Existing truncated-history handling remains. This repair does not claim reconstruction of information an older daemon never retained.
- The Git-ignore defect was in `GitWorktrees.listFiles` filesystem fallback. Existing Git-aware filename search already respected rules; no second ignore engine was added.

## Current release candidate and remaining acceptance

> **CLOSED — delivered as 0.5.1 on `main` (commit `1f0304c`).** The outstanding final visual renderer-switch/restart desktop check was completed on 2026-09-11 and the full suite is green (650 passing, 0 failing / 17 skipped). The repair branch `codex/inspection-repairs` and this candidate are historical; the packaged release moved to 0.5.1. Historical candidate record below is retained as evidence.

- Runtime source commit: `207361e3670c7465d4c19255109f09468f84675d`. Later checklist-only commits do not change the packaged runtime.
- Candidate: [donwells-0.5.0-mac-arm64.dmg](/Users/muzikfirst/Documents/donwellsai/donwellsai/dist/donwells-0.5.0-mac-arm64.dmg).
- SHA-256: `7c849a96169f0e7dd179f59566442f26541196cfa33bc75c3a5133fa65d457df`.
- Final source suite: 569 passed, 15 skipped, zero failures. Build and typecheck passed. DMG verification passed; mounted bundle matched 720 application files and 138 external resources, with 188 production dependency notices checked. Critical hashes match the unpacked and copied candidate.
- Shipped CLI checks passed for bare/wrapped/explicit input, options, duplicate rejection, project memory read and revision-guarded file save. A stale revision preserved the external edit; the current revision saved successfully. These are shipped API checks, not a completed visual editor acceptance run.
- Signing remains ad hoc/linker-signed, with no Developer ID, sealed resources or notarization claim. No installation, push or publication occurred.
- The first packaged renderer-switch check exposed a transient native 50x13 resize callback that damaged retained output. Commit `207361e` rejects callbacks that do not match current native geometry and flushes native bounds layout. Five focused native checks pass. **Its final visual renderer-switch/restart check has not passed yet:** the Mac locked before the retest and requires manual unlock.
- Remaining desktop work: repeat native/Xterm switching, narrow/wide replay, restart with the same PID and fresh input; finish the packaged language/editor workflow and redraw-capable TUI check. Then clean up the final candidate-owned app and daemon. The isolated candidate is left available for this continuation; its profile is `/tmp/donwells-release-profile-0908`.
- Full machine-readable hashes and verification details: `../workingfolder/inspection-2026-09-08/release-evidence.json`; shipped checks: `shipped-cli-checks.json` in that directory. Earlier source and candidate observations do not substitute for the outstanding final visual check.
