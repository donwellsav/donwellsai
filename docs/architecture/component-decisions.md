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
