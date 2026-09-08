# Current state, requirements and exact remaining work

## Product

A terminal-first macOS workspace for building applications with interchangeable native CLI/TUI agents: OMP, Hermes, DeepSeek Harness, Kimi, custom programs and explicit ACP sessions. Users run agents together or switch on the same project. Canonical project facts/decisions/sources and reviewed handoffs are shared; native histories preserve their own resume identities.

Editor, files, changes, browser, knowledge, resources and environments are movable retained modules around the terminal. The GUI must have its own identity, dark base #16161D, readable type, side controls and preserved terminal height. Final GUI work belongs to21 (former29); this is substantive integration/ergonomics, not cosmetic validation. Stronger components may replace incumbents when current research supports the choice and data/recovery/license requirements are preserved.

## State at transfer

- Source root and branch: `/Users/muzikfirst/Documents/donwellsai/donwellsai`, `workspace/terminal-foundation`.
- Last product change:71fc082 (point request payload fix). c89e541 adds Lume Show desktop; e8ecff0 corrects global module labels. These are partial increments.
- Layout correction is recorded in41b017a; preservation and process cleanup are recorded in92942b8. Later handoff documentation commits may follow. Read actual HEAD/status; do not reset to old hashes.
- Implementation is paused by the user for transfer. No product builds, model calls or VM/desktop trials were run during handoff review/export.
- The task checklist is recorded historical delivery, not blanket current recertification. Source-visible contradictions reopen affected clauses; no indiscriminate restart or repeat test campaign.

## Full recorded checklist

Statuses below deliberately distinguish prior delivery from closure of this rebuilt contract. Planning itself closes no task.

- [x] **01 — Consolidate the working foundation without rolling back** — Delivered; retained536e03b, ownership reconciled.
- [ ] **02 — Original terminal/layout comparison** — Reactivated by user 2026-09-08; pending. Informs26's host decision.
- [x] **03 — Make engine choices usable per project** — Delivered for existing engines; saved/draft status and native connection entry refined.
- [x] **04 — Own tools and resources by project** — Delivered for existing services; endpoint adapters extend it in23.
- [x] **05 — Establish the terminal-centered workspace** — Delivered shell rebuild; final integration remains21.
- [x] **06 — Make modules movable without disrupting work** — Delivered missing-reference recovery and retained Explorer drafts.
- [x] **07 — Make native agents interchangeable and integrate ACP** — Delivered: four named native adapters, reviewed setup repair, custom CLI, concurrent native/ACP owners and real permission/cancel/shared-fact use.
- [x] **08 — Make sessions recoverable and attention useful** — Delivered: durable layout, bounded slow clients, native/ACP reconnect and truthful owner loss; exact owner selection and terminal focus.
- [x] **09 — Make durable project memory dependable and editable** — Delivered: actual OMP/DSH stale conflict, correction, history and native recall after restart; unrelated-project isolation demonstrated.
- [x] **10 — Make agent handoffs useful** — Delivered: native/ACP dispatch and separate authenticated acknowledgment; immutable selected diff capture, stale rejection, portable excerpts and plain-folder source support.
- [x] **11 — Improve project document retrieval** — Delivered; atomic incremental publication, cancellation and live hybrid citation/edit/delete.
- [x] **12 — Add useful code structure and graph navigation** — Delivered exact definitions/callers/file imports, selected-symbol action and confined source navigation.
- [x] **13 — Unify project knowledge and native session history** — Delivered: source-grouped navigation, native Hermes/Kimi resume, reviewed facts and actual slow-query cancellation/isolation demonstrated.
- [x] **14 — Make browser previews part of the project** — Delivered scoped storage and existing view lifetime; final integration21.
- [x] **15 — Let agents inspect and test project applications** — Delivered: guarded context controls, readable diagnostics and artifact references; retained native repair journey plus current app/browser proof.
- [ ] **16 — Provide controlled desktop interaction** — Delivered for the local product scope 2026-09-07/08 (commit e16f6e6): GUI and native-agent MCP entry points both drive the admitted driver to a verified fixture press (background AX route), with ownership scoping, closed-target recovery and clean teardown proven ([resume record](architecture/second-pass-16/resume-2026-09-07.md)). The guest-scoped remote scope was removed with24 on 2026-09-08; local control is unaffected.
- [x] **17 — Connect code changes to working results** — Delivered: actual failing/fixed runs, source-linked review and stale rejection; native and ACP producer records; verified text artifacts open in the existing editor.
- [x] **18 — Coordinate parallel work and Git** — Delivered: overlap owner/changes/handoff routes and deliberate UI merge resolution proven; retained native tools and shared/isolated intent evidence.
- [x] **19 — Make every integrated tool discoverable and manageable** — Delivered: catalog/configuration routes, actual missing-runtime repair and disable, scoped resource controls, native remote stop and inactive pairing retirement.
- [x] **20 — Make projects portable and recoverable** — Delivered: learned/workflow/temporal restore, canonical provenance, actual collision resolution, credential omission and explicit SSH re-pairing.
- [ ] **21 — Finish the integrated GUI and remove daily-use friction** — Active: populated search density/zoom improvements; integrated and physical journeys remain.
- [ ] **22 — Deliver the finished installable application** — Partial: installed5172c81 candidate native workflow and three-class profile recovery passed; final artifact awaits integrated GUI/physical qualification.
- [x] **23 — Integrate analytics and richer project memory** — Delivered: DuckDB activity, Hindsight recall/reflection and Graphiti dated relations; reviewed native-agent sources, correction/erase, portable restoration and interrupted projection recovery.
- [ ] **24 — REMOVED — Integrate isolated desktops and remote work** — Removed by explicit user decision 2026-09-08. All SSH/Lume/remote-control code, the environments panel and install/bundle scripts were deleted from the source tree; the app is local-only with per-project scoping plus permission prompts as the safety model. See the Task 24 plan card.
- [x] **25 — Improve building applications in the editor** — Delivered: project language navigation/recovery, declared build, reviewed workflow creation and actual native DSH workflow reuse demonstrated.
- [x] **26 — Choose and establish the stronger desktop host** — Delivered 2026-09-08: Electron + native Ghostty re-qualified on the current-source package; 12/12 acceptance checks (selection+copy, resize, renderer switch without PTY restart, real agent, coexistence, crash recovery). See the Task26 section below and `architecture/second-pass-26/integrated-2026-09-08.json`.


## Task16 — current implementation boundary

Read the complete16 master card and agent/environment companion, then `src/cli/project-memory-mcp.ts`, `src/main/runtime-rpc.ts`, `src/main/project-computer-tools.ts`, `src/renderer/src/components/ComputerControlPanel.tsx`, and the existing acceptance runners.

Existing: local MCP control operations, connection owner identity, generation/revision checks, selected PID/window attachment, observation and screenshot, element/pixel actions, uncertain-action tracking and tool stop. The GUI payload fix in71fc082 removes extraneous element fields from pixel requests.

2026-09-07 update: the local half is now proven on current source; see `docs/architecture/second-pass-16/resume-2026-09-07.md`. Both acceptance runners (`computer-control-ui.mjs`, `computer-control-mcp.mjs`) pass with `verified: true`. Known driver limitation: foreground pixel clicks on AppKit targets are silently ineffective in Cua Driver0.23.2 (SkyLight copy carries NaN location); the background exact-target AX route is the qualified path.

Status: task16 is Delivered for the local product scope — the remote side was removed 2026-09-08 together with task24, and the local control path is proven (e16f6e6) and packaged (26's 2026-09-08 run).

`tests/acceptance/computer-control-ui.mjs` was corrected on 2026-09-07: receipt-based completion wait, awaited fixture exit, sibling-press assertion. The earlier ENOENT was an early read while the click was in flight; the rerun additionally exposed a real driver delivery defect (see resume record). Both runners require an operator to read the produced native-target.png and write coordinates.json within the wait window.

## Task24 — REMOVED 2026-09-08

Removed by explicit user decision: the product is local-only; safety = per-project scoped folders plus permission prompts. All SSH/Lume/remote-control source, panel, CLI command, scripts and tests were deleted; typecheck/build/tests pass after removal (562 passed, 1 pre-existing unrelated cli.test failure). Historical SSH/Lume delivery records remain in Git history and `docs/architecture/`; the retained task guest under research/ is now irrelevant to the product — leave it untouched unless the user asks.

## Task26 — integrated host/native terminal

Electron/native Ghostty with daemon-owned PTYs is the established direction, re-qualified 2026-09-08 on the current-source package (0365b5a, post task-24 removal). All 12 acceptance checks pass: daemon-owned TUI display, keyDown→PTY, pointer drag selection with copy, pane-tracked resize, exact search, palette/focus, renderer switch without PTY restart, real OMP input without submission, editor/browser/memory coexistence and GUI-crash recovery without resubmission. Evidence: `docs/architecture/second-pass-26/integrated-2026-09-08.json` with artifact hashes. Pointer selection is now proven in-process; the rejected global-coordinate hypothesis stays rejected — no bridge patch was made or needed. Pins kept: wrapper e47b20a is current upstream HEAD; core c4e16970 remains the matched pairing (see decision.md for the refresh rationale and upgrade candidates). License/notice obligations closed via Contents/Resources/native plus a pointer line in THIRD_PARTY_DEPENDENCIES.txt. Remaining honest limits: in-process AppKit dispatch (physical pointer/keyboard and Metal pixel quality unqualified), no model inference.

## Task21 — finish the actual GUI

Existing increments include terminal shell/module retention, search density/font scaling, remote environment module height/side controls, and distinct module labels. Remote terminals remain local to the Environment panel, not automatically integrated in the local Sessions rail.

Complete real populated multi-agent coding, knowledge/history, editor/browser/control, remote/Lume and interrupted work. Profile and fix concrete focus/latency/background-contention/density problems. Consolidate duplicated controls and superseded GUI paths after replacement workflows work. Qualify narrow/wide/font scaling and keyboard/pointer interactions; show before/after product outcomes. Retain #16161D and terminal space. A mockup, passing old tests or a renamed panel does not finish21.

## Task22 — final current-source installed app

Intermediate candidate5172c81 is historical; its DMG/archive/transcript hashes were checked against retained files. Installed recovery transferred three explicit classes (workspace, canonical JSON memory, project kits), not every profile/credential/pairing. Runtime use later changed navigation/docking/terminal-order fields in recovered workspace state; transfer hashes are not timeless current-state hashes.

After remaining changes, use the actual package preparation/native/notices checks and isolated output. Install the current final candidate separately, use a representative integrated project/agent/memory workflow, and demonstrate update/recovery without project loss. Include required tooling setup and accurate distribution rights. Reuse unaffected proof, but allow the smallest necessary real agent call to qualify final installed behavior. No blanket promise of zero additional prompts.

Report exact source commit/artifact hash and signing/notarization truth, verify actual final package, and provide the DMG link. Never replace the user's installation or call the old candidate final.

## Completion and continuation

The full master cards and linked companions remain acceptance authority. Reorder ready slices when dependencies justify it; do not drop requirements. After a full task completes, update existing records, commit locally, show every01–26 row/current position/product outcome/proof/limits, then continue. Reopen specific old clauses only when evidence demands it. Task24 was removed by user decision 2026-09-08; task02 was reactivated the same day. Open tasks:02,16,21,22,26.

## Correct folder layout — latest explicit user correction

- Project folder: `/Users/muzikfirst/Documents/donwellsai` (not Git).
- Only app repository: `/Users/muzikfirst/Documents/donwellsai/donwellsai`.
- Working/staging/handoff: `/Users/muzikfirst/Documents/donwellsai/workingfolder`.
- Research: `/Users/muzikfirst/Documents/donwellsai/research`.
- Trash: `/Users/muzikfirst/Documents/donwellsai/trash`.

The assistant previously misread the project folder as the app Git root. That relocation was corrected: latest source, dependencies and independent Git history were moved into the app child without reverting implementation. The preserved pre-correction commit is33e668e. The parent no longer contains app files or .git.

The previous baseline app checkout, including its untracked planning documents, is preserved in the project folder’s `trash/2026-09-07-layout-cleanup/original-app-before-correction`. Both old worktrees are now alongside it in that trash directory, with Git metadata repaired by `git worktree move`. Their committed history is contained in the active app repository. All seven dirty/untracked plan-restart files are also independently preserved, with SHA256 checks, in `/Users/muzikfirst/Documents/donwellsai/workingfolder/old-checkout-cleanup/plan-restart/`; see `preservation.json` beside it. No work was discarded. Five old daemons and two orphaned terminal helpers were stopped; closing the normal-profile OMP session was explicitly authorized by the user. Available session scrollbacks were saved privately before closure (bounded terminal history, not a full OMP transcript). Cleanup results and snapshots are in `/Users/muzikfirst/Documents/donwellsai/workingfolder/old-checkout-cleanup/`. The active app repository is independent of the archived worktrees. The branch name `workspace/terminal-foundation` is historical and does not require a folder with that name.
