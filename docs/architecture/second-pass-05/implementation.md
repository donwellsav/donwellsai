# Shell implementation

Replaced project-list dominance with a compact expandable project/checkout picker and a session list that owns remaining left-column height. New profiles start at224px; saved widths are preserved. The right rail now labels its tools, Add Agent has one session-list entry point, and duplicate horizontal tool tabs are removed. Tool title/move/close stay within the tool area; actual terminal content starts31px from the top, after its split tab row.

The live check reproduced a deferred-focus race: closing Runs even when already closed scheduled terminal focus after a newly opened tool heading. `setRunsOpen` now focuses on a real close transition, and the shared navigation helper rejects queued focus when the tool selection changed. One runnable regression is `pnpm exec vitest run tests/workspace-focus.test.ts`.

Typecheck/build passed. Shared disposable development app launched actual OMP and Hermes, showed the rebuilt shell, opened Files, retained heading focus, closed it and restored terminal focus. No model prompts were sent. Actual1280x768 window has two490x737 visible terminal surfaces. `shell-live.json` distinguishes native window bounds from responsive viewport emulation; the latter is not physical resize qualification. `shell-actual.png` is the running app, not a mockup. Main dark surface is#16161D.

Task21 still owns final integrated presentation after all modules. Task26 retains physical native input/Metal/package clauses. Task06 fixes missing-resource restore and module ownership independently; shell work does not close those tasks.
