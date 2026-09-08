# Task 02 — terminal/layout comparison — 2026-09-08

Reactivated by the user 2026-09-08 after being skipped since the rebuilt plan. Proportionate by design: this informs the (now delivered) task-26 host decision; it is not a new validation campaign. All evidence cited already exists in this repository.

## Options compared

| Option | What it is | Standing |
|---|---|---|
| xterm.js renderer (current default) | Canvas/DOM terminal in the Electron renderer | Shipped default; every acceptance suite runs through it |
| Embedded native Ghostty surface | libghostty-spm wrapper pin e47b20a, ghostty core c4e16970, Metal-backed NSView over the daemon PTY | Delivered and qualified 2026-09-08 (task 26) |
| Ghostty standalone / ghostling / electron-libghostty | Alternative embedding routes | Considered in `second-pass-26/decision.md`, not adopted (ownership/fit reasons recorded there) |
| Tauri / Electrobun host replacement | Framework-level migration | Electrobun rejected with measured evidence (`desktop-framework-comparison.md`); Tauri not admitted |
| Layout: flexlayout docking vs legacy split-tree | Workspace layout engines | Both persist; legacy is migrate-through only (`workspace-layout.ts:54-70`) |

## Decision dimensions (evidence, not impressions)

- **PTY ownership:** daemon-owned PTYs survive renderer choice; renderer switching preserves PID and input without restart (26 integrated run, check 8). Both renderers attach to the same daemon session.
- **Input:** xterm proven across all suites; native keyDown→PTY proven in-process, physical typing proven externally (external-desktop.json).
- **Search:** xterm via addon (patched, task 01); native Ghostty search returns exact match counts (26 run, check 5).
- **Selection:** native pointer drag-select + copy proven 2026-09-08 (26 run, check 3); xterm selection is long-shipped.
- **Resize:** native surface tracks its pane within 8pt (26 run, check 4); xterm resize covered by layout suites.
- **Rendering:** native is Metal-backed (external desktop images); xterm is canvas. No rendered-pixel quality comparison was run — recorded limit.
- **Failure handling:** native load failure exposes Retry + xterm fallback retaining session identity and scrollback (recovery-ui.json).
- **Cost/rights:** xterm already shipped; Ghostty adds native build + license/notices obligations — completed (licenses + z2d corresponding source ship in Resources/native; pointer line in THIRD_PARTY_DEPENDENCIES.txt).

## Conclusion

Keep the current pairing: **xterm.js as default renderer, embedded native Ghostty as the integrated native surface, daemon-owned PTYs underneath both, flexlayout docking as the layout engine with legacy layouts migrated through.** No terminal-engine or layout replacement is justified by current evidence. Reopen only if a pinned alternative passes the retained fixtures (see the reopen conditions in `desktop-framework-comparison.md`).

## Limits

No new benchmarks were run for 02; this comparison synthesizes measured evidence from tasks 01/21/22/26. Rendered-pixel quality and idle-RAM comparisons between renderers remain unmeasured; they did not change the conclusion.
