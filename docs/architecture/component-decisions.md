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
