# Task 27 strengthening evidence

Native session history is an optional Sessions source in project search. It uses AgentsView 0.42.0 for parsing and FTS, with the existing Node SQLite runtime for read-only lookup. No new package dependency or automatic memory import.

## Admission

[AgentsView v0.42.0 source](https://github.com/kenn-io/agentsview/tree/v0.42.0), commit `ff8fb4e84823b9583eba417afc243140caabdcb0`, MIT license. [Official release](https://github.com/kenn-io/agentsview/releases/tag/v0.42.0) Darwin arm64 archive SHA256 `57f437a089f2f9d41c7335d7ce2a96f2ba95a11d4517678c6a6866a65390a3f3`, checked against SHA256SUMS. Executable SHA256 `7bfa30b671bd0aa497b18cf639f95c9f2499a70a14ed03c704f4d15f9b61bd88`; LICENSE SHA256 `ffb1006bf3c32ec8da3ad6c5f693d8516eecb355df848a694332fa13174a77d4`.

The app requires that exact admitted executable via DONWELLS_HISTORY_BINARY. DONWELLS_HISTORY_ROOTS supplies explicit omp and deepseek-harness directory arrays. Empty configuration imports nothing; Task 19 owns integrated setup. The binary remains an external optional tool, not bundled code.

| Native agent | Discovery and search | Resume evidence |
| --- | --- | --- |
| OMP 18.1.10 | Actual local Ornith JSONL; parent root required for nested discovery | Packaged button starts `omp --resume <original file>`; new assistant record recalled HISTORY_ORNITH_27 |
| DSH launcher 0.1.1-rc.2 / TUI 0.8.0 | Actual compressed session.jsonl.zstd; native engine index/search/get passed | Native TTY resumed UUID 06cecd53-2501-44cf-b70d-7d522af8dfaf with `dsh --profile tui --resume <uuid>` and recalled HISTORY_DSH_27; API argv checked. DSH button was not separately exercised |
| Hermes 0.21.0 / f1ccf436 | Unavailable: released parser omits native cwd despite state.db containing it | No history resume advertised |
| Kimi-code 0.41.0 | Unavailable: retained native wire format stores workDir in session index, which released parser does not use | No history resume advertised |

Native calls used local oMLX Ornith-1.5-35B-A3B-MLX-8bit; no hosted Kimi usage. Unsupported formats are displayed explicitly, as required by Task 27 step 1.

## Project and process boundaries

Read-oriented upstream CLI commands can start a background daemon. The integration instead owns a foreground `serve --no-sync --no-browser --port 0 --require-auth` process, isolated HOME and cache, and bounded authenticated loopback resync. It verifies process-group termination before publishing the archive. Reads never start the engine.

Only selected registered roots are published. Verified macOS /tmp aliases are accepted; upstream prefix matching can also import nested projects, so those rows are deleted with foreign-key cleanup before the receipt is published. Failed rebuilds remove the receipt and cannot expose a partially rebuilt index. Archive removal leaves original native files unchanged.

Reads recheck registered scope and native file size/mtime. Missing, edited, renamed, foreign and symlink-leaf sources cannot be opened from stale records; refresh is explicit. Transcript text is read-only, untrusted, bounded, and never promoted to durable memory. Resume revalidates the original source immediately before starting the native agent.

## Verification

`checks.txt`: 28 tests passed, including real native parser indexing for both supported agents, duplicate IDs, renamed roots, malformed/partial JSONL, deleted/changed originals, parser receipt mismatch, nested-project pruning and direct foreign lookup. Typecheck passed.

`package-bytes.txt`: 718 application files and 30 external resources match current build. Package `/tmp/donwells-strengthen-27-package-scoped/mac-arm64/donwells.app`; ASAR SHA256 `7119f6669d379cf1cbc39a71533ef6f7783bed9a2d1e6eb7fd0aa9f32d71fb9c`.

`result.json` and visually inspected `native-history-source.png`: keyboard search/open, original excerpt, cross-project rejection, original OMP resume/token continuity, changed transcript rejection, explicit reindex and owned daemon cleanup all pass. Core search packaged regression passed immediately before the final backend-only archive-pruning fix; its receipt remains `/tmp/donwells-strengthen-27-search-regression/result.json`.

Reproduce UI with `node tests/acceptance/session-history-ui.mjs --app <packaged executable> --profile <new directory> --evidence <new directory> --playwright <installed playwright index.mjs> --project <registered native cwd> --binary <admitted executable> --omp-root <selected parent root>`. Native tests enable DONWELLS_HISTORY_BINARY and use the local qualification sessions described above.
