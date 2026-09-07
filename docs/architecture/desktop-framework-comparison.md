# Desktop framework comparison — Task 26

Decision: retain Electron and xterm. Electrobun 2.0.1 failed the native runtime gate on this machine. No production dependency or shell migration is admitted. This closes the candidate evaluation, not a claim that its full acceptance workload passed.

## Candidate and reproducible evidence

[Electrobun 2.0.1](https://github.com/blackboardsh/electrobun/releases/tag/v2.0.1), MIT, source `8d09d15db791f346e419efd452d6759750addb62`; Hutch 0.24.3. The exact release core pins Cottontail 0.5.0 or Bun 1.4.0. Release-asset SHA-256 checks were verified before use. Source, release metadata, binaries, disposable workflow source and DMG remain in `research/tool-trials/framework-2026-09-07` in the parent workspace.

The disposable host imported the existing ProjectMemoryService, SQLite migration and WorktreeFiles services. Four real node-pty terminals ran delayed shell output and exit checks. The identical bundled service fixture ran under Node 24.16.0, Bun 1.4.0 and Cottontail 0.5.0. No replacement PTY implementation or weakened file permission check was introduced.

| Required behavior | Node control | Bun 1.4.0 | Cottontail 0.5.0 |
|---|---|---|---|
| Create memory, migrate SQLite, query original entry | Pass | Pass | Rejected unsafe migration directory |
| Revision-checked save and rejection of stale write | Pass | Pass | Pass |
| Four PTYs: correct output and exit | 4/4 | 0/4 output; three deadlines | 0/4 output; four deadlines |
| Stream errors | None | None reported | Four `_read() method is not implemented` errors |

The Cottontail migration directory was actually mode 0755; Node's mkdtemp-created private directory passes the same existing safety check. An early fixture used `/tmp` without resolving its macOS `/private/tmp` alias and failed safe-save under Node too. That fixture defect was corrected before the three-runtime comparison. Preliminary instant-exit PTY probes are not used as final evidence.

The native-webview Cottontail host built successfully, created a verified 26,155,069-byte DMG, installed through its real self-extractor, and was launched from the extracted app. Its native worker exited with `_read() method is not implemented` before generating its report. The installer launcher returned zero despite that child error; exit code alone is not success. See [receipts](strengthening-26/result.json), [installed log](strengthening-26/installed-runtime.log) and the three control JSON files beside them.

## Comparison limits and disposition

Startup, idle/four-session RAM, interactive input latency, browser fidelity, keyboard accessibility, recovery and update delta sizes are **not qualified**: the installed candidate cannot yet run the required workflow. The 26 MB artifact contains a qualification host, not our complete renderer, retrieval, browser and control services. Comparing it to the installed Electron package would be misleading. Full Task 21 journeys were therefore not run on this rejected candidate. Existing Electron installed acceptance remains recorded under Task 22; later production edits still require the final package refresh.

Tauri/native Ghostty were alternative leads, not tested replacements in this experiment. No universal framework ranking follows from this result. Task 02's terminal-engine replacement remains skipped by user instruction.

The disposable repository experiment was removed after retaining source and measurements in the research directory. Reopen this comparison when a pinned runtime passes the exact retained fixture, including all four terminals and private memory migration. Then build the full renderer/service workflow and require all six installed journeys and equal-service measurements before proposing migration. Keeping a separate Node daemon could avoid some Bun compatibility issues, but introduces a packaging/control boundary that this experiment has not proven and does not remove Electron's current verified advantages.

Only owned trial processes were stopped. The installer created its own `ai.donwells.framework-trial` support directory; early Hutch probes also downloaded into `~/.hutch`. These are not production app data. No user application was stopped or modified.
