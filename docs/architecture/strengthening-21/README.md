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
