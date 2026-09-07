# Task 21 strengthening — in progress

Current artifact: Task 20 final package, ASAR
`6cba18b2f03385350e2b034273985d37f562927c54a3357878b0a0d0d6a6a4df`.
No product change was needed for the restart check: graceful close intentionally
flushes dirty editor buffers through the existing workspace close gate. The
runner now distinguishes 20 SIGKILL crash recoveries from an additional graceful
save/restart. It verifies unchanged unsaved source bytes after every crash,
identical draft text, saved project memory and the same terminal session IDs.

`workspace-shell.json` passed without renderer errors and stopped its owned daemon.
It also covers 100 layout moves, editor DOM/undo/redo continuity, damaged layout
repair, keyboard controls, 200% scaling, reduced motion and real browser/diff panes.
The 200% screenshot was visually inspected. The toolbar test now waits for the
visible pressed state and refocuses its control before closing a panel.

`baseline.json` records 200 samples per measured condition. Terminal write-to-PTY
output p95 was 0.7 ms idle and 0.9 ms under 4 KiB output load. Real keyboard-to-PTY
echo p95 was 0.5 ms; dock click-to-two-animation-frames p95 was 17.4 ms.
Animation-frame timing is a presentation proxy, not measured xterm paint completion.
Idle CPU and memory are recorded by Electron process role, with no model started.
Other user processes were left running.

`launches.json` records ten fresh application profiles: renderer-ready median
406.76 ms, p95 420.41 ms. OS filesystem caches were not evicted; these are not
machine-reboot cold starts. Each owned process was cleaned up.

Still open: large-project search, frozen retrieval corpus, current-package native
agent journeys and remaining fault checks, then full checks and task closure.
VoiceOver and additional-language qualification remain deferred by the user.

The first large-search run failed its sparse-match latency target: p95 738.47 ms
(target 300 ms), despite median 58.59 ms. Common-match p95 was 4.91 ms and cancel
acknowledgement p95 25.90 ms. `code-search-before.json` retains the failed receipt.
The task remains open while the native path is profiled; no threshold was relaxed.

## Sparse search profiling and correction

`rg-profile.py` reproduces the same deterministic 100k native fixture and interleaves
20 trials each of automatic, 1, 4 and 8 workers. Native first-match p95 was 195.95,
820.26, 17.77 and 44.52 ms respectively (`rg-profile.json`). This measures native
search directly, separately from the registered-checkout adapter.

The shared adapter now selects four ripgrep workers. No query cache, index or new
service was added. The unchanged full adapter scale test passed: sparse first-hit
p95 64.42 ms, common first-hit p95 4.60 ms, cancellation p95 26.09 ms. The direct
native correctness tests passed for ignore rules, literal queries, confinement,
changed scopes, limits, cancellation and structural search. See
`code-search-after.json`. Hardware and other workloads remain uncontrolled;
this is a measured interactive default, not a claim of universal bulk throughput.

Full typecheck passed. The initial full test run found a stale RPC expectation
for Task 18's optional task intent and a timer-race in the descendant cancellation
check. The RPC check now expects the existing optional argument. The cancellation
check waits for the descendant's own PID announcement, cancels the owned group,
and checks the native process table for no running descendant. Focused checks
passed; the full rerun passed 470 tests, with 12 explicitly skipped (71 files
passed, 5 skipped). The large fixture and optional native services have separate
opt-in qualification and are not credited from skipped tests.

## Current-package native agents

`native-agents.json` passed on the new Task 21 package. Four native harnesses used
local oMLX Ornith. OMP created exactly one shared decision through memory_record;
Hermes TUI, Kimi and DSH invoked memory_search and returned that value. DSH's native
compressed transcript additionally proved a completed answer with no failed tool
calls. SQLite-migrated memory, revision/provenance and the native write survived
app restart. Owned sessions/daemon were cleaned up and the temporary Hermes
configuration removed. Native binaries were unchanged. Total end-to-end duration
was 88.68 seconds, including local model work; this is not host interaction latency.
This fixture proves native write/recall, not every app-building or handoff journey.

## Frozen retrieval corpus

`retrieval.json` passes the production-index gate: 92.5% macro recall@5 across
three repetitions of the 40 frozen questions, 100% exact-query recall, no leakage
on ten isolation traps and every returned citation resolvable. This uses the
pinned QMD/Lance packages and local Qwen embedding/reranking files with their hashes
recorded. The cold first query took 3698 ms after fresh index construction; warm
query samples are retained separately. Corpus/source remain frozen at the prior
comparison commit, while the production indexing implementation is current.
Other acceptance apps and model-agent runs were kept idle during this measurement.

## Search setup regression and packaged workflows

`search-before.json` records the unconfigured-history regression: Task 19's
configuration gate reached the Sessions pane as a raw Electron IPC error while
Index sessions remained usable. Search now reads the existing project doctor
configuration on activation and after Settings closes; unavailable history offers
Configure session history instead of an indexing action. No new configuration
source or service was added. The rerun verifies that setup is keyboard reachable,
then returns to search. Typecheck and 17 focused checks passed (two external-only
checks remain explicitly skipped).

The new package's `project-search-ui.json` passes native graph/source navigation,
stale/rebuilt callers, project isolation, cancelled/obsolete results, query/panel
continuity, keyboard source-to-terminal copy and current memory revision opening.
`project-task-coordination.json` and `verification-review.json` pass native task
integration/shared-checkout conflict handling and actual failing/passing script,
source/artifact staleness, browser artifacts and review workflows. Each receipt
records its exact package and owned-process cleanup.

`handoff-ui.json`, `project-doctor.json`, `computer-control.json` and
`terminal-recovery.json` also passed on the rebuilt package. These cover
handoff ownership/revision fences, recoverable tool configuration, native indexing
pause/resume/stop, history scoping, native target/control ownership and interrupted
input, and reconnect/redraw of the same terminal process. All owned daemons stopped.
Physical system sleep was not induced on the user's workstation; window visibility
and explicit reconnect recovery are the exercised fallback. Native foreground input
can leave its target foreground when interrupted; the control receipt retains that
limit rather than claiming background control for unsupported Electron targets.


## Native handoff remains open

The source OMP wrote the requested fixture file. Initial Kimi trials stopped at
native approval; later Kimi and DSH trials lost the Playwright page before recipient
handoff execution. These failures are retained in `native-handoff-before.json`,
`native-handoff-retries.json` and `native-handoff-dsh-failure.json`. Each owned
daemon was cleaned up. A separate 30-second idle app probe remained open; native
keyboard modifier flags were zero. The inspected OMP fixture transcript contained
only the requested file-write tool call. A subsequent main-process inspection proved
the BrowserWindow was still alive at the page error. Debug logging captured a
Chromium debugging WebSocket disconnect (1006); app quit followed during test
cleanup. This is an unresolved automation connection failure, not proof of an
app shutdown.
Unverified approval-driver edits were removed; the preexisting Kimi code-search
runner changes were preserved. No native handoff completion is claimed here.


## Managed browser shutdown

`browser-cleanup-before.json` identifies the managed Chrome by its live ancestry
under the exact app process, then proves it survives the old MCP hard-stop path.
The probe terminates only that identified browser after recording the failure.
`browser-cleanup.json` passes against ASAR
`7fa541721f4b0572332d29ca87807f8fcd4b9af1256bbe664c4e87bae589d1fc`:
the MCP service receives EOF, closes its detached Chromium child, and then the
existing process-group termination check verifies quiescence. EOF gets at most
two seconds; an uncooperative service is still force-stopped. Windows retains its
existing taskkill path. Unexpected parent crashes remain a separate recovery gate.

Replay with `tests/acceptance/browser-process-cleanup.mjs` and the existing
`--app`, `--profile`, `--evidence`, `--playwright`, `--package` (Playwright MCP),
and `--browser` arguments. The 22 lifecycle tests and typecheck passed. The browser
build runner now sets its verification flag only after its final GUI checks.


## Native continuation and browser build loop

`native-handoff-cli.json` passes on the shutdown-fixed package: OMP completed its
source-file turn with exit 0, native DSH received and acknowledged the exact handoff,
produced matching output, and completed its turn with zero failed tool calls. The
native executables were unchanged. This uses real PTYs/RPC and the existing preload
setup/review API; it does not claim a keyboard-only GUI handoff. `handoff-ui.json`
separately covers GUI review, binding and revision fences.

`browser-build-loop.json` passes the native OMP repair/replay loop: source changed,
all nine required browser operations were exercised in one managed context, the
fixed form saved its input, overflow cleared, and screenshot/trace artifacts were
produced. Final review used focused native webContents keyboard input and captured
the rendered inspection panel (`browser-build-review.png`). Chromium's debugging
connection still disconnected; the Electron main inspector and application remained
usable. The underlying debug-socket cause is unresolved, not hidden by these receipts.

After that disconnect, Playwright's app close can return without stopping Electron.
The shared disposable-test cleanup now verifies the exact child process and applies
bounded termination if necessary, after clearing native sessions and tools. Both
receipts disclose that fallback and confirm daemon cleanup. This is not proof of
normal user-initiated app shutdown; graceful restart/save was separately exercised
in `workspace-shell.json`, and installed update/recovery remains Task 22.


Full post-fix checks passed: 471 tests, 12 explicit skips; typecheck passed.
`owned-orphan-cleanup.json` records four older failed-test browsers, each tied to
an exact disposable Task 21 checkout by its current working directory and command.
Their private process groups were terminated and verified stopped. The original
browser-build app also survived its lost Playwright context; its agent and terminal
lists were empty before terminating that exact recorded app process. Unknown and
user-owned browsers were left alone. The final managed-browser acceptance passes
with the committed runner and current package.

Remaining Task 21 closure work: complete the keyboard-only six-journey check and
review the aggregate qualification matrix. Existing keyboard shell/source-copy and
native browser-review checks do not alone prove all six journeys keyboard-only.
