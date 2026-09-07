# Final installed verification — 2026-09-07

Runtime source: `557b577`. The final 0.4.0 macOS arm64 DMG includes the Task 23 analytics, Task 25 language/workflow changes and Task 28 native-status fixes. Later changes are acceptance drivers and evidence only.

[Artifact identity](artifact.json) records the SHA-256, exact size and controlled installation at `/tmp/donwells-final-install/donwells.app`. The DMG verifies; Developer ID deep/strict signature verification passes. All 720 application files and 34 external resources match the build. Notarization remains unconfigured; nothing was published or installed over the user's running application.

- [Six keyboard journeys](keyboard.json): launch/collaborate/handoff/understand/build-and-verify/return-and-ship, no mouse input, minimal Finder-style PATH, restart retains terminal identities, both PDF pages render.
- [Language workflow](language.json): isolated native TypeScript workers, real definition navigation, worker-loss recovery, stale diagnostics, correct manual save, actual project typecheck failure then success, and reviewed new-project workflow files. The only page error is the deliberately injected missing-worker failure. [Installed editor](language-editor.png).
- [Analytics](analytics.json): scoped native history, unavailable billing data, keyboard disclosure/refresh and contained smaller-window panel. [Installed smaller-window view](analytics-small-window.png).
- [Update/rollback](update.json): 0.3.0 → final 0.4.0 → 0.3.0 → final 0.4.0, SQLite revision 3, unchanged source and migration backup, retained terminal ID and exports before transitions. The first invocation selected two 0.4.0 builds and failed the test's version-change assertion; [that receipt](update-same-version-rejected.json) remains separate.
- [Native OpenCode](native-opencode.json): local Ornith, original native session history, connected structured waiting/permission events, daemon client reconnect with identical run/session IDs, and stopping a pending permission without executing its command. [Installed permission view](native-permission.png). ACP was stopped before native launch; no hidden second agent was used.

Full suite: 483 passed, 12 existing optional skips; typecheck passes. All final acceptance applications, agents, derived history service and owned terminal daemons shut down cleanly. Earlier Task 22 receipts separately cover the unchanged browser/control/offline tools and four-agent memory matrix; they are not relabeled as reruns of this final artifact.

Tasks 01 and 03–28 have strengthening evidence and dispositions. Task 02 remains skipped by user instruction. Evaluation outcomes are not feature admissions: richer memory engines, VM/remote integration, framework migration and an in-app ACP control mode remain unadmitted for the reasons recorded in their task decisions. The native terminal integrations, shared memory and existing supported tools remain the production path.
