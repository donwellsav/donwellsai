# Task 08 strengthening evidence

Terminal recovery now reports truncated/unknown replay, offers native resize redraw without input, and preserves the prior screen on failed reattachment. Transport loss suspends renderer input/output delivery, invalidates pending snapshots and marks cached live agents unverifiable. A fresh snapshot resets its sequence boundary; pending output is capped at 1 Mi characters. Exit/unmount invalidates pending reattachment. Resize errors now reach callers instead of being discarded.

The side panel and command palette provide Next waiting session, scoped to live input/permission waits in the selected project. Failed/exited/unverifiable sessions are excluded. Completion descriptions distinguish agent-reported completion from task verification.

## Current evidence

- 40 lifecycle tests across daemon, ownership/PID reuse, client, bus, runtime and attention passed. Nineteen UI-command tests passed, including ordered project-scoped waiting navigation. All three TypeScript projects passed.
- Actual packaged app: `/tmp/donwells-strengthen-08-package-polish/mac-arm64/donwells.app/Contents/MacOS/donwells`.
- ASAR SHA-256: `8b78f8fbc881126b7418a305301cae4a0e61e999c72e2b1f693c564459da27e1`. Package check matched 718 application files and 29 external resources to the build.
- [Packaged recovery receipt](terminal-recovery.json): 20 alternating graceful/SIGKILL app restarts, same native fixture PID and session, actual xterm search of redrawn alternate-screen output, zero input bytes, single process launch. Authenticated disposable daemon was then killed; missing session remained visibly disconnected and was never relaunched. Fixture and idle daemon cleanup passed.
- [Recovered screen](recovered.png), [daemon loss](daemon-lost.png). These are actual app screenshots using the requested dark theme.
- The custom TUI is an explicitly identified transport fixture. Native agent conversation continuation is separately qualified in Task 07.

## Limits and corrections

Window hide/show exercised visibility recovery. Physical workstation sleep was not induced; this remains a hardware qualification limit for Task 21, not a claim of system-sleep testing. Old daemons without truncation metadata conservatively show incomplete-history warnings.

Earlier runs exposed two acceptance-runner defects: querying Playwright's app handle after killing it, and an unscoped locator matching both terminal panes. Both were corrected; the final receipt has no errors. Earlier owned processes were cleaned up. No normal user profile was changed.

Reproduce with `node tests/acceptance/terminal-recovery.mjs --app <packaged-executable> --playwright <installed-playwright-index.mjs> --evidence <new-directory>`.
