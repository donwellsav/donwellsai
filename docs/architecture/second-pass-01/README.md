> Historical archive of the earlier strengthening pass (fff1a99/d06a160). Status, task numbering, pending checks and temporary app paths below describe that run. Current execution is owned by [the rebuilt01–26 plan](../../superpowers/plans/2026-09-07-rebuilt-01-26-plan.md); this archive creates no new task or retry requirement.

# Second pass Task 01 — in progress

Source audit and fresh GitHub research: [Task 01 research](../../research/second-pass/task-01.md). Active checklist: [second pass](../../superpowers/plans/2026-09-07-second-strengthening-pass.md).

The current isolated, unsigned application is `/tmp/donwells-pass2-01/package/mac-arm64/donwells.app`. It does not replace the user installation. [Build receipt](build.json) records the unchanged source fingerprint across the actual package command and identifies the executable, ASAR and all 34 external resource files. The checker matched 720 app files and 34 external files. ASAR matches the prior production build because this task changes acceptance machinery, not production source. This is observed source/build/package association, not reproducible-build certification.

[Baseline](baseline.json): 200 idle echo and 200 loaded echo samples; p95 PTY feedback 1.5/2.3 ms, respectively. 200 keyboard samples and 200 tab-change samples also recorded, alongside Electron/daemon resource observations. Measurements exclude physical display/xterm paint completion and external model memory. Source and artifact stayed unchanged during this run. Process/daemon cleanup passed. This is one measured launch, not a launch distribution.

[Negative package fixture](negative-package.json): adding an unexpected shipped CLI file is rejected with a nonzero exit for the expected file-set mismatch.

## Retained unsuccessful checks

- [First recovery run](recovery-first-failed.json): all 20 GUI restart cycles retained one TUI PID, with no replayed input. The new visibility/input check failed after using text insertion rather than a real keypress. This is being investigated/corrected as a driver issue; it is not a passed responsiveness test. Its initial cleanup used terminal.close on an agent session, which the runtime correctly rejected; subsequent agent stop/dismiss and daemon cleanup succeeded.
- [First keyboard run](keyboard-first-failed.json): failed reaching New memory after a repeated panel command. The driver chose traversal direction before asynchronous panel focus settled and sent Shift+Tab into xterm. App and daemon cleanup passed; source/artifact were unchanged. Centralize the existing panel-focus readiness assertion before traversal, then rerun.

Task 01 remains open pending corrected live runs and final evidence review. Task02 is skipped; new Task29 is final GUI refinement. No previous unimplemented integration is counted complete by these checks.
