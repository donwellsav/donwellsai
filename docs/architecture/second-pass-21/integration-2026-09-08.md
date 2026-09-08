# Task 21 integrated increment — 2026-09-08

Package under test: current source after the task-24 removal and task-26 qualification (0365b5a + task-21 fix batch), `dist/mac-arm64/donwells.app`, unsigned dir build.

## Profiled friction, ranked and dispositioned

From a full read of the shell/render paths plus the earlier records, ranked by user impact:

1. **Dead "Project environments" pane in persisted layouts** — after the 24 removal, an old saved layout restored a blank unexplained tab. Fixed: `Workbench.tsx` renders the existing `empty-note` pattern with an explanation and a working close action. Live before/after: `module-palette-2026-09-08.json` + `environments-restored-2026-09-08.png` (pane injected into a real saved session while the app was closed, relaunched, note rendered, closed via its button).
2. **Focus dead-ends** — `.workspace-stage` was not focusable, so keyboard navigation's workspace branch silently no-opped; `focusPaneTarget` bailed silently behind overlays. Fixed: stage is `tabIndex={-1}` (outline only on `:focus-visible`); `focusPaneTarget` now returns a boolean so blocked focus is observable. Proof: extended `tests/workspace-focus.test.ts` (overlay-blocked handoff resolves false); full keyboard-only traversal in `keyboard-journeys-2026-09-08.json` (six journeys, zero pointer events).
3. **Always-on background polling** — status+scan (lsof/ps per worktree) every 5 s and the document-service poll every 1–2 s ran even with the window hidden. Fixed: both skip while `document.hidden`; status poll catches up on `visibilitychange`, search poll self-resumes within one tick. Verification is code-level (no App.tsx test harness exists; none was created per project rules).
4. **Dead CSS from the superseded shell** — ~200 lines of zero-referenced selectors (nav-entry, wt-card, section-header, pane-title-bar, hidden-workspaces-*, etc.) deleted from `main.css` and `workbench-dock.css` after bare-word re-verification. Proof: the packaged app passes all three suites below with the deletions in place.

Considered and deliberately kept: dual sidebar/docked module hosting (that is the delivered movable-modules feature, not duplication), the three palette overlays (commands / files / modules are distinct scopes, standard IDE pattern), RunsPanel takeover and the session list (management surface vs navigation), the Layout popover. The 21E clause bars removing controls whose workflows lack replacements; these all have live workflows.

## Journey evidence on the package

- `keyboard-journeys-2026-09-08.json` — populated journeys start/collaborate/handoff/understand(memory)/buildVerify/returnShip, zero pointer events; the runner was repaired for a pre-existing staleness (2b91f36 collapsed the Run-verification disclosure; the runner now opens it like a user must).
- `module-palette-2026-09-08.json` — module palette opens the real memory pane; retired-pane restore proof above.
- `workspace-accessibility-2026-09-08.json` + `workspace-1280.png` / `workspace-200-percent.png` — narrow (1280×800) and wide (1440×960) layouts, 200% interface scale with no clipped/unreachable elements, reduced motion, hidden-layout/unsaved-draft retention across crash restart, four composed panes with real preview and diff.
- Task 26's `second-pass-26/integrated-2026-09-08.json` additionally covers native renderer selection/resize/focus on the same package lineage.

## Remaining blocker (explicit, per the card's allowance)

Physical native keyboard/pointer/selection/Metal qualification needs an unlocked desktop session the operator consents to drive. After the 2026-09-07/08 incidents, synthesized input on the user's active desktop is not used. Everything else on the card is covered by the evidence above. The two-minute manual check (open the app, drag-select text in a native terminal, copy, type) can close this whenever the user chooses; 22's representative workflow is a natural moment.

Vitest after the batch: 563 passed, 1 failed (pre-existing, unrelated: cli.test parallel-start), 15 skipped.
