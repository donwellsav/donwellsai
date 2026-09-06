# Component admission and baseline

Status: Task 01 in progress. The user authorized implementation with “go.” Production replacements have not been selected or installed.

## Reproducible starting point

- Branch: `workspace/terminal-foundation`; isolated checkout: `/Users/muzikfirst/Documents/donwellsai/terminal-foundation`.
- Original checkout remains on `main`, unchanged, with its untracked planning documents preserved.
- Baseline source: `18eddb407008ae36bd157945987dd00e53cafa36`; app version `0.3.0`.
- Setup: `pnpm install --offline --frozen-lockfile`, initialize Electron once with `node -e "require('electron')"`, then build before daemon integration tests.
- Initial pre-build failures were missing daemon output and concurrent Electron initialization. After setup: **55 suites / 331 tests passed**, typechecking passed, `pnpm package:dir` passed.
- Shared smoke cleanup was extracted without changing its ownership rules. The existing live smoke still passes addRepo/createWorktree/terminal-data/terminal-close/removeWorktree.

## Packaged acceptance

Executable: `/Users/muzikfirst/Documents/donwellsai/terminal-foundation/dist/mac-arm64/donwells.app/Contents/MacOS/donwells`.

Executable SHA-256: `cb1ff051972518956849b76293e78136cf60efe7df649075481547a36d052ac7`.

app.asar SHA-256: `76822c4e03bb0ed875bc8c2d11b8006451354d4f10d6844dbe7e147c1e98046c`.

The local package was built from the unchanged production source at the baseline commit. Runner/tests/docs edits followed packaging; they are not represented as production changes in that artifact. Signing was explicitly skipped by the existing package configuration.

Observed on Apple M5 Max, arm64, Darwin 25.6.0: packaged runtime and renderer RPC responded using the requested disposable profile. App stop and idle-daemon cleanup passed. This single run is readiness evidence, not a latency benchmark or complete user-journey acceptance.

Raw local evidence: `/tmp/donwells-foundation-evidence-02/baseline.json`. This temporary location may be cleaned by the OS; the durable receipt is [baseline-launch.json](baseline-launch.json). Profiles are retained for diagnosis and contain runtime credentials; do not commit or export them.

Run again with unused sibling directories (their parents must exist):

```sh
pnpm acceptance:baseline --app /absolute/path/donwells.app/Contents/MacOS/donwells --profile /tmp/donwells-profile-new --evidence /tmp/donwells-evidence-new
```

The runner refuses existing profiles/evidence, launches the supplied executable without smoke mode, imports the packaged RPC client, verifies the actual user-data path, and records source/artifact identities. It stops only its child app and an authenticated idle daemon belonging to that profile. It never kills another app or deletes profile contents.

## Current installed dependency pins

These are the baseline versions resolved by the frozen lockfile, not new adoption decisions. Their existing installation is not a new redistribution audit.

| Package | Resolved version | Package license declaration |
|---|---|---|
| electron | 44.1.1 | MIT |
| react | 19.2.8 | MIT |
| @xterm/xterm | 6.0.0 | MIT |
| @xterm/addon-search | 0.16.0 | MIT |
| node-pty | 1.1.0 | MIT |
| monaco-editor | 0.56.0 | MIT |
| @pierre/diffs | 1.3.6 | apache-2.0 |
| zustand | 5.0.15 | MIT |

Frozen lockfile SHA-256: `4c817b8168c8d654fd31f2c457e9831eef1c8591c44d68b0e3176e9ca40c112c`.

## Candidate admission queue

The entries below preserve pinned research provenance. They are **not admitted**: release artifact checksums, transitive/package notices, runtime requirements and live compatibility remain gates before use. No floating package installation is authorized by a research label. Task 02 selects terminal/docking; Task 03 selects memory/retrieval/control.

| Candidate | Pinned research source | Research license declaration | Missing admission evidence |
|---|---|---|---|
| coder/ghostty-web | [1858a5947767](https://github.com/coder/ghostty-web/tree/1858a5947767a3e1c9e98dbf53b2ff87fedb2aab) | MIT | Release/checksum, package boundary, requirements, fixture and recovery trial |
| tobi/qmd | [dbfd0b4736ae](https://github.com/tobi/qmd/tree/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9) | MIT | Release/checksum, package boundary, requirements, fixture and recovery trial |
| DeusData/codebase-memory-mcp | [7b0f553cbae5](https://github.com/DeusData/codebase-memory-mcp/tree/7b0f553cbae565247aa858a4aba80b194305e7f5) | MIT | Release/checksum, package boundary, requirements, fixture and recovery trial |
| microsoft/playwright-mcp | [8a13ef8e9f73](https://github.com/microsoft/playwright-mcp/tree/8a13ef8e9f7385a0f89477922127f31cbfde9761) | Apache-2.0 | Release/checksum, package boundary, requirements, fixture and recovery trial |
| openclaw/Peekaboo | [08c87b6a8457](https://github.com/openclaw/Peekaboo/tree/08c87b6a845753a5ff132d6f982172024bbdd262) | MIT | Release/checksum, package boundary, requirements, fixture and recovery trial |
| trycua/cua | [5cd40c1d0222](https://github.com/trycua/cua/tree/5cd40c1d0222bc378635f6f65444cf3ececf7979) | MIT | Release/checksum, package boundary, requirements, fixture and recovery trial |
| caplin/FlexLayout | [a848028c73d1](https://github.com/caplin/FlexLayout/tree/a848028c73d13cfaff1b11e6a6b87dadf2b2c98e) | MIT | Exact release/checksum, package notices and compatibility trial |
| dockview/dockview | [f2482528d4e4](https://github.com/dockview/dockview/tree/f2482528d4e4c6f5e97a568fa23581279e425b20) | NOASSERTION | Exact release/checksum, package notices and compatibility trial |
| Gentleman-Programming/engram | Research folder exists; immutable source pin still required | unknown | Exact release/checksum, package notices and compatibility trial |

On this shell PATH, OMP, Hermes and Kimi executables resolve. Neither `dsh` nor `deepseek-harness` resolves; this does not prove DSH is absent under every possible install name. Authentication, actual versions and native MCP/TUI behavior remain unverified. No native agent configuration or credentials were changed.

## Remaining Task 01 gates

- Six live journeys, keyboard/VoiceOver, fixed-workload input/focus latency, cold/warm launch distributions and four-agent/service resource separation remain **not run**.
- Native release discovery and candidate artifact admission are pending; no candidate is called a winner.
- Core product implementation can proceed only through the plan’s stated selection gates. The baseline runner is reusable infrastructure, not completion of the redesign.

## Task 02 preliminary results

The isolated terminal/layout fixture is implemented in `experiments/terminal-layout/`. Exact trial pins: FlexLayout 0.10.8, Dockview 8.2.0 (free package), Ghostty Web 0.4.0. Package integrity values and directly inspected license-file hashes are in its admission record; production dependencies and lockfile are unchanged.

All four renderer/layout combinations completed 100 programmatic panel moves, retained the terminal renderer objects and visible marker, retained unaffected scratch content, and showed no horizontal overflow at 1280×800. No unexpected browser errors occurred. The reproducible [fixture results](terminal-layout-fixture.json) explicitly exclude native-process, provider and installed-app qualification.

**Confirmed blocker:** Ghostty Web 0.4.0 cannot activate the existing xterm SearchAddon: `this._terminal.onWriteParsed is not a function`. Search succeeds on xterm with both layouts. Retain xterm for the next integration step; Ghostty remains a challenger requiring a working search path plus the remaining fidelity/accessibility gates. Both layouts remain candidates; these measurements do not select a docking winner.

The laboratory was also built successfully with the existing Vite toolchain. It is a comparison surface, not the final GUI design. The user's reiterated requirement is a complete GUI rebuild from scratch around native terminal agents, #16161D and a distinct identity. Keeping useful runtime code or xterm does not preserve the current interface.

## Task 04 scoped service foundation

Implemented `ProjectTools` using the existing registered-workspace resolver, process launcher, environment filter, bounded-output sink and process-tree termination helper. Project services resolve to the main project; checkout services use a distinct hash. Every operation has an admitted parameter parser and server-bound target arguments. Direct lookup, history and export use the same boundary; unadmitted batch operations and launch overrides are rejected.

Transport is private inherited MCP stdio, with initialization/version checks and a tools-list readiness response. No callback capabilities are advertised. Requests are bounded to 64 KiB, responses to 1 MiB, logs to 64 KiB and concurrency to 64 outstanding requests. Restarts are capped at three launches per minute per scope. A failed read retries at most once; a sent write with a lost response returns `TOOL_OUTCOME_UNCERTAIN` and is never replayed. Source protocol reference: [MCP stdio](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) and [lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle).

The existing authenticated runtime/CLI catalog exposes `tool-list`, `tool-start`, `tool-stop` and `tool-call`. No external service has been admitted yet: the production catalog is intentionally empty pending Task 03 trials. This is application-level scope enforcement, not an OS sandbox for a malicious executable.

Verification: eight real subprocess tests cover linked/unrelated project identity, duplicate starts, all-operation target override rejection, readiness timeout/malformed/version failure, bounded restarts, read-only retry, uncertain write and process-exit proof on shutdown. Focused runtime/process/memory checks passed; the full suite passed 57 files / 340 tests. Packaged RPC discovery and rejection of an unadmitted tool passed in the GUI acceptance run. Electron quit must be retried in `setImmediate` after asynchronous service shutdown; a same-turn retry was reproduced hanging and corrected.

## Task 05 primary shell in progress

The actual application now mounts a rebuilt `WorkspaceShell`: project/checkout context, labeled tool rail, project navigation with native keyboard controls, an agent-session strip, terminal/agent launch controls and local resource/status information. Primary dark surface is #16161D; terminal colors remain independently configurable. The runtime/store and safe removal flow are reused.

The [packaged acceptance receipt](workspace-shell-acceptance.json) identifies the executable and app.asar. [Current shell screenshot](workspace-shell.png) was captured from Electron itself. Real terminal output, session retention across tool navigation, a second terminal, the agent launcher, light/dark appearance, reachable keyboard controls at 200%, normal app shutdown and idle daemon shutdown passed. Text contrast on the main surface is 14.34:1, muted text 8.63:1 and focus 9.55:1. The test uses native `capturePage`; Playwright screenshots alone cropped Electron zoom incorrectly. The tool rail now scrolls at large scale, and narrow tool panels overlay their content area.

This does not finish Task 05 or the GUI rebuild. Preset compositions, movable persistent modules, pane chrome, remaining secondary surfaces and native VoiceOver qualification are still outstanding. The unused old `WorktreeSidebar` is retained only until project-navigation parity and Task 06 migration are verified; remove it then. No mock terminal output is present in the application.

## Task 02 native continuity comparison

[Native comparison receipt](terminal-layout-native.json): both FlexLayout 0.10.8 and Dockview 8.2.0 retained the same two packaged-daemon shell identities while moving terminals 100 times and the actual unsaved Monaco editor 102 times per layout. Renderer mount count stayed one per terminal. Search, fresh typed-command output, Unicode rendering, `stty size` after PTY resize, alternate-screen entry/exit and profile cleanup passed. The two layouts reused the identical processes. Timings include browser automation and do not establish a rendering-performance winner.

Proceed with **FlexLayout 0.10.8 + existing xterm** for production integration. FlexLayout's React model/factory fits the existing React runtime and provides movable tab groups beyond the old binary split view. Dockview also passed; it remains a comparison artifact only. Native VoiceOver/IME and the final integrated layout still need qualification, so this is not a release claim. Ghostty's required search-addon incompatibility remains disqualifying at the tested version.

The fixture now uses native Monaco input rather than a textarea. Its EditContext target is not a fillable HTML input: focus the editor and send keyboard input. Selection must settle before focusing a moved terminal. Dockview can detach inactive panel DOM, so the test verifies reconnection when selected, alongside unchanged renderer/model and daemon identity.

## Production docking and terminal space

The main workspace now uses exact FlexLayout 0.10.8 with the existing xterm and Monaco resources. Its MIT license is included in `resources/THIRD_PARTY_NOTICES.txt`; React is an existing peer dependency. The superseded split renderer and titlebar-tab component are removed. Legacy split data/helpers remain for migration and old RPC compatibility, with a first-migration backup retained by the main state owner.

User correction: terminals are the centerpiece. The repeated project header, arrangement toolbar and terminal title row have been removed. The subsequent user correction removes the top project bar entirely: launch/search/layout/settings live in the side rail, project identity is in the project sidebar, and the terminal canvas begins with its tab groups. Layout choices and hidden views use a native popover so the rail can scroll at 200% without clipping the controls. The dark main surface remains #16161D.

[Packaged acceptance](workspace-docking-acceptance.json) and [actual compact workspace](workspace-docking-acceptance.png) cover two real PTYs, hide/reopen, 100 arrangement changes, fresh typed output, 100 editor moves through the command dispatcher, unchanged editor DOM/content, undo/redo, deliberate app crash/relaunch, protected unsaved draft restoration, hidden layout persistence, unchanged terminal IDs, and docking Files/Changes/Memory/Recovery. Keyboard checks at 200% and owned-process cleanup pass. Full regression: 58 files, 351 tests. This is an unsigned local package, not an installed or released product.

The acceptance runner now polls asynchronous conditions outside Playwright's `waitForFunction`: the installed implementation treats a returned Promise as truthy before inspecting its resolved boolean. Earlier shell receipts that used async predicates are superseded by this run. Captures wait for layout/terminal repaint after resizing. A narrow old receipt must not be used as evidence for the full product journeys, native VoiceOver/IME, or all later plan tasks.

## Side-panel controls and native executable launch

The remaining bottom status strip is removed. Git status, local process readings and preview-port buttons now live in the project sidebar. The terminal workspace spans the full content height; the packaged check asserts top=0 and bottom=viewport height at 200% scale. Updated docking evidence also retains the real PTY, editor move, crash recovery and keyboard checks.

Task 07 foundation: explicit executable/argv is available through the native launcher, IPC and authenticated RPC. Legacy shell commands remain supported. The daemon advertises `agent-argv-v1`; an older daemon is left running with an upgrade-required error rather than receiving an ambiguous command. Retained runs preserve original argv for retry; native hook arguments append separately. The shared focus helper unhides retained agent panes without creating another process.

The packaged launcher executed `/usr/bin/printf` through a real PTY and preserved spaces, an empty argument, Unicode and literal shell syntax, with exit zero. A separate real-daemon test executes Node from a path containing spaces and Unicode and verifies that a shell substitution argument creates no file. Full regression passed 58 files / 354 tests; typecheck and unsigned local packaging passed. These checks prove executable transport, not authenticated model use or four-agent shared memory.

Native versions initially observed through local version/help commands: OMP 18.1.10; Hermes 0.21.0 (2026.8.31, upstream f1ccf436); Kimi Code 0.39.1. DSH was not on PATH. During subsequent native startup, Kimi's own updater changed its installation to 0.41.0; the user was informed. Later qualification launches set both `KIMI_CODE_NO_AUTO_UPDATE=1` and `KIMI_CLI_NO_AUTO_UPDATE=1` in the test process environment and verify executable hashes before/after. No global update preference or credential configuration was edited. Kimi Code is a different current implementation from the earlier Kimi CLI research: its [official MCP configuration](https://moonshotai.github.io/kimi-code/en/customization/mcp) uses `.kimi-code/mcp.json` and `$KIMI_CODE_HOME/mcp.json`, with project entries overriding matching user entries. The installed help does not expose the old MCP config flag. Native configuration, resume and shared-memory qualification remain in progress.

## Native TUI queries and explicit process stop

The packaged GUI launcher started OMP, Hermes (`--tui`) and Kimi in a disposable Git project. Each native agent read README.md and emitted the random verification word absent from the prompt. Receipts retain source/artifact hashes and session identities: [OMP/Kimi query run](native-agent-query-04.json), [Hermes query run](native-agent-query-05.json). This proves native input, configured-model/tool activity and local file access; the criterion can match tool output before the final answer finishes. It does not prove shared-memory recall, resume, or DSH compatibility. Native output/screenshots remain private in the receipt's local evidence directory rather than committing conversation text.

The probe waits for Hermes's versioned `session.info` banner or Unicode status separator. Its earlier ASCII-only separator check incorrectly timed out. A 500 ms pause between typing and Enter respects native paste-burst handling; immediate Enter previously inserted a newline. These were acceptance-driver defects, not reasons to alter terminal input behavior.

Native trials exposed a product bug: Stop sent Ctrl+C, which a TUI can consume without exiting. The shared Stop path now ends the owned PTY process, escalates after one second if an agent ignores hangup, waits for node-pty exit acknowledgment and retains output until dismissal. Ctrl+C remains an interrupt. Older daemons reject the new operation with an explicit capability error and are left running. Process-only agents display Running rather than claiming task activity.

The real PTY regression consumes Ctrl+C and ignores SIGHUP, then verifies confirmed Stop, rejected post-exit input, retained output, dismissal and idle daemon shutdown. Typecheck and 58 files / 355 tests pass. The unsigned local package was rebuilt; [packaged label verification](native-agent-label-08.json) confirms visible Running text and successful cleanup. Native runs report idle daemon shutdown. This is not yet a descendant-process audit, 20-cycle restart qualification, installed release, or completion of Tasks 07–08.

## Native project-memory format trial

`native-agent-matrix.mjs --memory --agents omp,kimi` creates only disposable project configuration and seeds a random decision through the app's authenticated memory API. The decision is absent from README.md and the native prompt. The two formats are `.omp/mcp.json` and `.kimi-code/mcp.json`, both with a `mcpServers` entry containing executable, argv and `ELECTRON_RUN_AS_NODE=1`. The packaged Electron runtime hosts the packaged `runProjectMemoryMcp` implementation. A private fixture wrapper supplies the same runtime invoker as the CLI and records only RPC method, success and server PID; it does not implement substitute memory behavior.

[OMP native recall](native-memory-omp-09.json) and [Kimi native recall](native-memory-kimi-10.json) each show the random decision in actual TUI output plus a successful server-side `memory.list` call. OMP 18.1.10 and Kimi Code 0.41.0 executable hashes remained unchanged. Kimi initially waited for native tool approval; the second run approved only the exact fixture memory-search request once. App sessions and daemons shut down, and `ps` confirmed both observed memory-server PIDs absent afterward. No existing project configuration or credentials were changed.

These are format/read-path trials, not automatic launcher integration or cross-agent write/restart proof. The current backend is still the existing authority; SQLite migration, Hermes profile configuration, DSH integration, linked-worktree recall and the full four-agent handoff remain outstanding. Hermes's installed implementation reads `get_hermes_home()/config.yaml` and its `mcp_servers` map; a generic MCP config flag is not an adequate substitute for a qualified profile. Do not set production `memoryConnected` from these fixture receipts.

## Hermes native profile and memory recall

[Hermes recall receipt](native-memory-hermes-14.json) now verifies a native `memory_search` against the packaged project-memory server: the random decision appeared in TUI output and the server recorded a successful `memory.list` with PID 75378. The executable hash was unchanged, sessions/daemon shut down, and the memory-server PID was absent afterward. A subsequent filesystem check found two acceptance profile directories recreated with native caches/auth-lock files after removal. Descendant-process cleanup is therefore not proved by the receipt's immediate removal flag and requires investigation before production profile integration.

The trial creates an exclusively owned, randomly named directory under the selected Hermes root's `profiles/` and pins `HERMES_HOME` to it. It serializes the source configuration with Hermes's installed PyYAML, replaces only the disposable copy's `mcp_servers`, and round-trips it with the installed C loader before launch. A private `.env` copy supports the same configured provider. OAuth tokens are not copied: Hermes's native named-profile authentication fallback reads the original credential authority and owns any refresh transaction. The entire temporary profile, including native caches and recovery files, is removed after successful shutdown; original configuration and the active-profile selection are never rewritten.

Two failed experiments establish requirements for production integration. JSON's escaped surrogate pairs were rejected by Hermes's YAML loader, so use an actual YAML serializer and validate before launch. A profile outside the Hermes root could not see the existing Nous login; placing it under the native profile root restored supported authentication fallback. The successful native input used 10 ms per character before Enter; a bulk-typed trial left the prompt unsubmitted. No previous input was blindly replayed into an uncertain running session.

Reproduce with `node tests/acceptance/native-agent-matrix.mjs --app <packaged-executable> --profile <new-directory> --evidence <new-directory> --playwright <installed-playwright-index.mjs> --agents hermes --memory --hermes-home <existing-Hermes-root> --hermes-python <installed-Hermes-python>`. The driver exits nonzero on failed requested recall. This qualifies Hermes's profile/read path, not managed production configuration, concurrent cross-agent writes, linked-worktree recall, restart durability, or the DSH gate.

## Stop includes the native PTY process group

A real regression reproduced a child continuing to append to a fixture file after Stop acknowledged its parent's exit. POSIX agent Stop now uses the existing process-group termination and quiescence helper for the private group created by node-pty's `forkpty`. It force-stops that group while the owned root is still live, then waits for the existing PTY exit acknowledgment. This supersedes the earlier root-only hangup/escalation behavior on POSIX; Interrupt remains native Ctrl+C. Output remains available until dismissal. Ordinary terminal/job behavior is unchanged.

The child-survival regression failed before the change and passes afterward. Typecheck and all 58 files / 356 tests pass. The [rebuilt package's Hermes check](native-memory-hermes-15.json) retrieved the seeded memory, stopped the agent and daemon, removed its private profile, and verified that the profile remained absent ten seconds later. A subsequent `ps` check found the recorded memory-server PID absent. The two earlier trial remnants were removed after no running process environment matched their exact profile paths; a later check found no acceptance profile directories.

This fixes the observed owned-group leak. It does not prove cleanup of a process that deliberately creates a separate session/group, Windows process-tree behavior, or all 20 restart cycles. Those remain explicit lifecycle qualification work; the receipt is not a claim that every possible descendant has been contained.

## Shared-memory setup in the production launcher

The OMP and Kimi launcher now exposes **Set up shared project memory**. Main generates the verified native `mcp.json` format pointing directly to the bundled CLI `memory-mcp` command, with workspace, harness and app profile bound in argv. Native authentication and tool approval remain native. Setup and launch are separate actions; a setup error leaves terminal launch available. Launch is disabled while an explicitly requested setup is still writing.

The implementation reuses `GitWorktrees` registered-project checks and safe file operations. New files are created exclusively; existing files require a complete stable revision and are updated with compare-and-swap. Other top-level fields and servers are preserved. Existing configuration is fsynced to a private backup directory before replacement. Repeating identical setup is a no-op. A different existing `donwells-project-memory` entry is left unchanged, rather than claiming ownership from its name. Managed upgrades/removal and their ownership receipts remain Task 19 work.

[Packaged GUI setup and native recall](managed-native-memory-16.json) used the actual setup button for OMP and Kimi in one disposable project, verified generated argv, and retrieved the same seeded decision through the bundled CLI server. No fixture MCP wrapper was used in this run. Kimi's inspected native screen showed the successful `memory_search` from `donwells-project-memory` and the returned decision. Both binaries stayed unchanged and the owned daemon shut down. The focused regression covers preservation, private backup, idempotence and refusal to replace a user-edited entry. Typecheck and 58 files / 357 tests pass.

Configuration saved is not connection verified: the launcher labels connection status as unverified. Hermes's qualified native-profile path is not yet exposed by this setup action; DSH, cross-agent writes/restarts, migration and the remaining roadmap are still incomplete.
# Memory authority candidate: observed update incompatibility

The isolated Engram MCP trial in [engram-memory-contract.json](engram-memory-contract.json) rejects its current API as our authoritative memory backend. This is a compatibility decision for the pinned source, not a general assessment of Engram or a claim about a later release.

- Source: `Gentleman-Programming/engram`, commit `c859490074a7bad23fdcdbfaada22e05d94a5cef`; source archive SHA-256 `b64616807705044879f5e173220b4123673797c06c2801dcee72aae772e270f8`. The source license is MIT, copyright Alan Buscaglia 2026. Transitive redistribution admission was not completed because the candidate failed the authority gate; no candidate binary is bundled.
- Built with `go1.26.4 darwin/arm64` using `go build -o /tmp/donwells-engram-trial ./cmd/engram` in the isolated research checkout. Binary SHA-256 is recorded in the receipt. Its default MCP version reports `0.1.0`; source identity above is the qualification identity.
- The runner starts a real stdio server with a fresh private HOME/data directory and an explicit synthetic project. It creates one observation, performs two writes both claiming `expectedRevision: 1`, terminates the writer, then starts a distinct reader. Both writes succeed; the reader returns the second writer's stale content at revision 3. The advertised update schema has no revision precondition. Unknown `expectedRevision` is ignored, not enforced.
- No history/revision-named tool is advertised in the full tool list. This naming observation alone does not prove absence of internal journal data or recoverable history. The demonstrated stale-write behavior already fails our required compare-and-swap contract; an adapter cannot atomically enforce that contract through this API. Maintaining another authoritative ledger would defeat the one-authority requirement.

Select SQLite/FTS5 behind the existing ProjectMemoryApi for the next migration implementation. The current JSON authority remains in production and retains only 32 previous revisions. The selection is not migration completion: transactional history, full revision retention, scoped queries, interruption-safe migration and rollback preserving later writes still require implementation and subprocess acceptance. QMD, code graph and control-engine trials remain separate open Task 03 work.

Reproduce the candidate gate with `node tests/acceptance/engram-memory-contract.mjs /tmp/donwells-engram-trial /absolute/new-evidence.json`. It fails if the pinned candidate stops exhibiting the recorded incompatibility, requiring the decision to be reviewed. The disposable profile is removed after the owned processes exit. Existing project-memory and MCP regression files pass: 2 files, 8 tests. No user memory or native-agent installation was changed.
# SQLite migration preparation

`prepareProjectMemoryMigration` now creates an isolated SQLite destination beneath the actual supplied profile, preserves the exact validated schema-v1 source bytes in a read-only private backup, and verifies every imported project's normalized hash and record/history counts after closing and reopening the database. Entries preserve their IDs, archive state and provenance; FTS5 is a derived external-content index maintained by database triggers. SQLite and FTS integrity checks run before the candidate is returned. The existing shared loader handles malformed, unsupported or insecure source files; there is no second JSON validation path.

This is preparation only and has no automatic production caller. A `prepared.json` receipt is not an active-backend manifest. Preparation now holds the shared writer lock across snapshot and validation, and checks source bytes again before returning. The next implementation must keep that same critical section through manifest publication, route the existing API to the new authority, and qualify interrupted cutovers and downgrade after new writes. Until then JSON remains authoritative and candidates must not receive app writes.

The migration regression uses two projects, revisions authored by OMP/Kimi/Hermes, an archived decision, maximum-length content, a missing profile, corrupt/unsupported documents and repeated preparation. It verifies exact source/backup bytes, private modes, project-scoped ID exclusion, FTS results, hashes and retained history. A distinct Node reader process reopens the SQLite file and checks both projects. This proves candidate persistence, not restart of the production API or a completed migration. Focused validation: 3 files, 9 tests; TypeScript checks pass. No dependency was added. The existing 32-history-revision cap is preserved as specified by the retention policy; full unbounded history was not introduced.

## Memory writer fence and packaged restart proof

All current JSON commits and candidate preparation share a profile-wide SQLite exclusive transaction lock. The lock database contains no memory records; it uses native OS locking and is released on process death, avoiding a stale PID lockfile recovery heuristic. Contention produces `PROJECT_MEMORY_MAINTENANCE` without queuing or replaying a write. Before publishing a JSON document, the store compares its cached state with the current validated source under the lock; a stale writer refreshes its cache and rejects with `PROJECT_MEMORY_CHANGED` rather than erasing another writer's data.

The legacy JSON implementation also fails closed on any `project-memory-active.json` presence, including a malformed manifest. Existing instances reject reads/writes and new instances refuse to reopen JSON. No active manifest is published yet. Versions predating this guard do not participate in the lock: actual cutover still needs the legacy-file fence and an explicit downgrade/reverse-migration path. These changes are prerequisites, not a completed authority switch.

`tests/project-memory-migration.test.ts` proves stale-snapshot rejection, live cross-process maintenance contention, release after SIGKILL, and rejection of old-store access following manifest creation. The full suite passes: 59 files, 359 tests; typecheck and package build pass.

[Packaged acceptance receipt](memory-write-fence.json) records two distinct app processes and a separate lock-owner process using the packaged Electron runtime. Authenticated RPC rejects a write while locked, succeeds after the lock owner is killed, and returns the identical decision after app restart. The owned idle daemon shuts down. Reproduce with `node tests/acceptance/memory-write-fence.mjs --app /absolute/donwells.app/Contents/MacOS/donwells --profile /absolute/new-profile --evidence /absolute/new-evidence`. This is RPC/process qualification of the JSON authority and native SQLite lock; GUI/native-agent input and migrated-backend acceptance remain separate.
## SQLite transaction boundary

The candidate database now has shared, validated create/update/export operations in `project-memory-sqlite.ts`; preparation reuses the export reader instead of duplicating it. Exports read one SQLite snapshot. Creates enforce unique IDs and existing per-project/global entry-count limits. Updates select by project plus ID, compare the expected revision within an immediate transaction, preserve creation time and retained historical content, and update the project path and FTS index in the same commit. Unknown database schema versions fail closed.

The regression rejects cross-project updates, stale edits, rewritten history, duplicate IDs across projects and unsupported schemas. An injected failure after the entry/index update but before the project update proves the complete transaction rolls back, including FTS. Successful creation and replacement are also checked against their search results. Focused checks pass: 3 files, 11 tests; typecheck passes.

These primitives operate on the isolated candidate and are not yet selected by the production ProjectMemoryService. Active manifest publication, legacy-file fencing, backend routing and reverse migration remain outstanding. This evidence qualifies transaction behavior; it does not claim the live native-agent memory matrix uses SQLite.
## SQLite cutover and packaged recovery

`migrateProjectMemory` now holds the writer lock through candidate verification, durable pending-manifest publication, source retirement, legacy-path fencing and active-manifest publication. The old JSON filename becomes a directory, which rejects an older implementation's atomic file replacement as well as its JSON reads. The exact source and immutable backup remain in the owned migration directory. Manifest parsing rejects unknown fields, traversal, unsupported state/schema and unsafe filesystem paths. A missing or corrupt selected database does not fall back to the old snapshot.

ProjectMemoryStore now opens the selected SQLite authority through the existing API. Startup resumes a pending cutover; already-open JSON instances reject access after the manifest appears. SQLite reads query the selected project, and read/write operations fence changes to the selected authority. Create/update/archive/history use the existing validators and revision rules; SQLite commits change one entry and its retained history without writing JSON. Search still uses the existing lexical ranking so this storage migration preserves recall behavior; FTS5 is maintained but is not yet the user-facing retrieval algorithm.

Five regression cases interrupt each recorded boundary and resume it, then verify shared-worktree recall, project isolation, unchanged search results, new creates/updates, stale-revision errors and unchanged backups. These five cases inject exceptions, not five subprocess deaths. A separate case simulates an uncooperative old writer: a changed retired source prevents activation, preserves the newer bytes and reports that recovery is required. The recovery/abort UI for that condition remains outstanding.

[Packaged cutover receipt](memory-cutover.json) proves a stronger live case: a distinct source-fixture process is killed with SIGKILL at `legacy-fenced` while holding the lock. The supplied packaged app resumes the pending manifest, writes a new SQLite revision through authenticated runtime RPC, then a third app process recalls that revision. The original backup hash is unchanged and the owned idle daemon exits. Reproduce with `node tests/acceptance/memory-write-fence.mjs --app /absolute/donwells.app/Contents/MacOS/donwells --profile /absolute/new-profile --evidence /absolute/new-evidence --cutover`. Fixture construction uses the current source through installed Vite; recovery and later reads/writes use the packaged executable. This is not GUI or four-native-agent qualification.

Validation: 59 files / 366 tests, focused memory checks 3 files / 17 tests, typecheck and package build pass. Existing user profiles are not automatically upgraded. The normal launcher has no migration action yet; reverse migration preserving later writes, migration diagnosis/export controls, real subprocess death at the other boundaries and the full four-agent matrix remain Task 09 work. No downgrade to the preserved stale snapshot is permitted.
## Complete recorded-boundary process-death matrix

[Crash matrix receipts](memory-cutover-crash-matrix.json) now cover real SIGKILL at all five recorded cutover boundaries: `candidate-prepared`, `manifest-prepared`, `legacy-retired`, `legacy-fenced`, and `manifest-active`. Each case uses a distinct disposable profile, a killed migration process holding the OS lock, and three packaged app processes. Before manifest publication, restart correctly keeps JSON authoritative; after publication, restart recovers/selects SQLite. Every case passes initial recall, subsequent write plus restart recall, original backup hash preservation and owned idle-daemon shutdown. All five cases used the same packaged artifact hash recorded in the receipts.

Run an individual case with `node tests/acceptance/memory-write-fence.mjs --app /absolute/donwells.app/Contents/MacOS/donwells --profile /absolute/new-profile --evidence /absolute/new-evidence --cutover --cutover-boundary manifest-prepared`, substituting the desired boundary. The fixture helper generates the interrupted state from current source; the supplied package performs recovery and API writes/reads. This completes process-death coverage at these recorded boundaries, not arbitrary instruction-level crash coverage, disk-full or physical power-loss testing. Reverse migration, blocked-source recovery controls, migration UI and the native four-agent matrix remain open.
## Current-state downgrade export

`exportProjectMemoryForDowngrade` now snapshots the active SQLite authority under the writer lock, exports validated schema-v1 data, flushes a new private file, reopens it through the existing legacy validator and verifies bytes plus project hashes/counts. It reads the current database, never the pre-cutover backup. The returned receipt identifies its source directory, SHA-256, byte length, per-project entry counts and retained revision counts. Each invocation creates a separate export; it does not overwrite an existing artifact.

The legacy reader has a 16 MiB document limit. The exporter checks stored UTF-8 payload size before loading the complete document, then checks the final serialized size; an incompatible export is rejected while SQLite stays active. It never discards history or entries to make the downgrade fit.

Regression coverage creates and revises records after migration, archives a decision with OMP/Kimi/Hermes history, exports it, and opens that data through the JSON implementation in a separate disposable profile. Current entries, linked-worktree identity, history and cross-project exclusion survive; the original backup and active SQLite manifest remain unchanged. A larger retained-history case rejects export without publishing a partial file. Focused checks pass: 3 files / 19 tests; typecheck passes. This is separate-profile reopen coverage, not subprocess downgrade acceptance.

Publication back into the original profile and interrupted reverse-switch recovery remain unimplemented. An export is a point-in-time artifact: later SQLite writes must be included or explicitly detected before any reverse cutover. User-facing migration/export controls and the full native-agent matrix also remain open.
## Abort interrupted cutover without restoring an obsolete backup

`abortProjectMemoryMigration` now recovers the preserved legacy source only before SQLite activation. It publishes a durable `aborting` state under the writer lock, restores validated source bytes with exclusive atomic publication, and removes the authority manifest only after the restored source is durable. Startup finishes an interrupted abort instead of resuming the forward migration. Original backups and retired sources remain available. The implementation refuses non-empty recovery directories, conflicting newer source copies, missing required source data and abort requests against active SQLite. Active SQLite must use current-state export/reverse migration, never this abort path.

Regressions cover a newer uncooperative legacy write, both interrupted abort boundaries, unchanged preserved copies and refusal to delete unexpected files or select between conflicting sources. [Packaged abort crash receipts](memory-abort-crash-matrix.json) additionally record SIGKILL of distinct migration processes at `abort-marked` and `json-restored`; the supplied package completes recovery to JSON, preserves a later write through another restart and leaves the original backup unchanged. Owned idle daemons exit in both cases. Reproduce with the existing memory-write-fence runner's `--cutover --cutover-boundary abort-marked` or `json-restored` options and fresh profile/evidence paths.

Validation: 59 files / 371 tests, focused memory checks 3 files / 22 tests, typecheck and package build pass. This closes the ordinary pre-activation abort path; it does not implement a reverse switch after SQLite has accepted writes. Conflicting-source selection still requires recovery controls, and the migration/export UI and native four-agent matrix remain open.
## Memory failure no longer blocks workspace startup

ProjectMemoryService now initializes its store on the first authorized memory request. A load error propagates to that request without preventing runtime/terminal setup. Failed initialization is not cached, so a later request can retry after repair; it never substitutes an empty store for damaged data. Pending migration/abort recovery likewise runs when memory is first accessed, rather than blocking general application startup.

The regression still rejects corrupt and insecure persistence without overwriting it and now proves retry after a deliberate repair. [Packaged damaged-memory receipt](memory-damaged-start.json) records startup with a corrupt disposable source, a rejected memory request with unchanged source bytes, and a real PTY command that successfully wrote its fixture result. After the runner repairs only that synthetic source, memory succeeds in the same app process. Subsequent lock and app-restart checks also pass, and the owned idle daemon shuts down. Reproduce with `tests/acceptance/memory-write-fence.mjs` using fresh profile/evidence paths and `--corrupt-start`.

Validation: 59 files / 371 tests, focused memory checks 3 files / 22 tests, typecheck and package build pass. This is packaged RPC/PTY evidence, not a visual recovery-panel test. The user-facing migration/repair/export controls and active-SQLite reverse switch remain outstanding.

### Side-panel storage controls and terminal actions

The Memory side panel now provides read-only storage diagnosis, verified JSON-to-SQLite upgrade, interrupted-upgrade recovery, and current SQLite export. These profile-wide administrative actions are desktop IPC operations; the project-scoped agent MCP contract is unchanged. A failed memory load does not remove the diagnostic controls. Backend changes invalidate the service cache so the next request uses the current authority.

Split, Stop and Markdown preview actions now live in the side-rail Layout popover. Docking tabs retain session switching and drag targets, without those extra action buttons. No global header or footer was added.

Validation: typecheck and package build passed; the storage implementation passed 59 test files / 372 tests. `memory-storage-ui.json` records a real packaged GUI run that split a terminal through the side control, upgraded a seeded store, verified its original backup and current entry, and exported that entry. All trial terminals and the idle daemon were closed. This does not qualify active-SQLite reverse migration, conflicting-source selection, or the entire workspace plan.

### Reverse migration after SQLite writes

`reverseProjectMemoryMigration` now returns the current SQLite records and retained revisions to JSON under the existing profile maintenance lock. It reuses the verified export path and legacy size limit, durably marks the authority as reversing before removing the old filename fence, publishes JSON exclusively, and only then removes the manifest. Startup resumes a marked reverse migration. The original JSON backup, SQLite database, and current export remain preserved. Oversized exports leave SQLite active. A conflicting legacy write is preserved and reported; source-choice recovery is still pending.

The Memory side panel provides Return current memory to JSON and resume controls. The admin service invalidates its cached backend after a switch. The ordinary project memory MCP/RPC API remains unchanged.

`memory-reverse-crash-matrix.json` records real SIGKILL at five checkpoints: verified export preparation, reverse manifest publication, legacy fence removal, JSON publication, and manifest removal. Each disposable profile receives a post-upgrade write through the packaged app before the kill, then is reopened by the package and checked again after another write and restart. Before the reverse manifest is published SQLite remains authoritative; later checkpoints recover JSON. All five passed, including original-backup preservation and idle-daemon cleanup. These checkpoints do not qualify arbitrary instruction-level crashes, physical power loss, disk full, or the four native-agent matrix.

`memory-storage-reverse-ui.json` records the packaged side-panel upgrade, export, post-upgrade write, and reverse operation. Typecheck, package build, and all 59 test files / 378 tests passed. An initial fixture assertion incorrectly expected JSON before the reverse manifest was published; the corrected runner expects SQLite at that checkpoint. No production profile or installed application was changed.
