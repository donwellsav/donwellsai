# Task 08 layout and first-shell increment

The first-visit shell path checked only already-created panes. Two workspace
activations before the terminal IPC reply therefore created two processes. Each
reply unconditionally focused its terminal and workspace, overwriting a browser
or another project selected in the meantime. A per-workspace pending first-shell
fence now spans that request; automatic completion preserves newer navigation.
Explicit new-terminal actions remain distinct user requests.

The existing workspace persistence owner now queues saves immediately instead
of waiting 400 ms. One write may be in flight and one pending batch captures
the latest state; 20 edits during a held write require only one subsequent
write. Every pending caller waits for that newer snapshot. Navigation history
initialization finishes before snapshot capture, preventing async load ordering
from enqueueing stale state. Browser opening and docking-save return the actual save
promise; terminal opening and splitting wait for it before resolving. A rejected
save remains a rejection and sets the visible workspace-save error. The existing
main Store remains the persistence authority; there is no second layout journal.
Synchronous UI setters are still synchronous: their mutation is not a durable
acknowledgment. Callers needing a crash boundary must await the returned location
operation or `flushWorkspaceSession()` before reporting success or killing the
renderer. Renderer death while a save is pending remains an uncertain boundary.

Focused checks hold the save promise unresolved and prove browser open cannot
acknowledge early; reject storage and verify visible failure; activate a fresh
workspace twice during one held shell request and select its browser before
completion, retaining one terminal and browser focus. A held-write test verifies
pending callers stay unacknowledged until the coalesced latest snapshot saves. Lifecycle/baseline/focus/
navigation checks: 20 passed. Typecheck passed. Actual source-built fresh-folder
and immediate post-ack renderer-reload proof is owned by the root task and is
not claimed by these checks. Task 08 remains open for its full owner/crash matrix.

Actual Electron result: `layout-live.json` verifies repeated activation creates one shell, late startup retains browser focus, and immediate renderer reload after acknowledged browser saving restores the same terminal and browser. Clean app/daemon shutdown. Full08 ACP write/cancel/crash coverage remains open.
