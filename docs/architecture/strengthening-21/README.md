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
