# Task 12 strengthening

Task 12 strengthened. All current qualification gates pass.

Search checks now independently qualify hidden-file and ignored-file options for ripgrep and ast-grep. A checkout identity replacement during streamed delivery rejects the request after its first result. Native syntax matching retains isolated configuration and avoids comments/string literals.

A cancellation failure exposed an early-return race in the shared process-group termination helper. If signalling fails while the group exits, kill(0) can still report unreaped members; the helper now uses the existing bounded quiescence check before claiming uncertainty. The deterministic regression fails on the original implementation and passes with the fix. The change applies to both finite commands and PTY termination; it does not weaken live-process checks. Commit `0bedf2c`.

39 focused search/process/tool/boundary tests and 15 PTY/daemon tests passed. TypeScript and package checks passed. Native graph service qualification covered separate checkout hashes, stale-source marking, denied foreign selectors and sibling survival after stop. A separate native binary trial checked imports, callers, rename/deletion across diverged worktrees and a known current repository caller. Owned graph processes and fixtures were removed.

The rebuilt package passed 20 alternating graceful/SIGKILL application recovery cycles with identical terminal PID/session, rendered redraw, zero input replay, visible daemon-loss failure and no automatic process relaunch. This rechecks the terminal caller of the shared termination helper.

Artifact: `/tmp/donwells-strengthen-12-package/mac-arm64/donwells.app`. ASAR SHA-256 `85c185d0bb8bd42f76b10e8db326e3738e522eab13aa617ec49bd5c9c3de4068`. Package checker matched 718 application files and 29 external resources. Physical system sleep and release signing remain separate gates.

The initial 100k-file run overlapped other qualification work and failed sparse-result p95 (342 ms against 300 ms). Its receipt is retained. No threshold changed; the final run is separate from other qualification jobs.

The final deterministic 100,000-file run passed unchanged thresholds: warm first-result p95 6.11 ms, sparse-result p95 169.67 ms, cancellation p95 25.73 ms (30 cancellation samples, 29 warm search samples per condition). The disposable fixture was removed. This excludes concurrent qualification jobs, not normal user processes; workload and source hashes are in the receipt.
