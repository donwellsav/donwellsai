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
