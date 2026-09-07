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
- [ ] **02 — SKIPPED — original terminal/layout comparison** — SKIPPED by user.
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
- [ ] **16 — Provide controlled desktop interaction** — Partial: desktop available; screenshot works and point-request fields fixed. Actual point outcome/closed-target continuation awaits the next harness.
- [x] **17 — Connect code changes to working results** — Delivered: actual failing/fixed runs, source-linked review and stale rejection; native and ACP producer records; verified text artifacts open in the existing editor.
- [x] **18 — Coordinate parallel work and Git** — Delivered: overlap owner/changes/handoff routes and deliberate UI merge resolution proven; retained native tools and shared/isolated intent evidence.
- [x] **19 — Make every integrated tool discoverable and manageable** — Delivered: catalog/configuration routes, actual missing-runtime repair and disable, scoped resource controls, native remote stop and inactive pairing retirement.
- [x] **20 — Make projects portable and recoverable** — Delivered: learned/workflow/temporal restore, canonical provenance, actual collision resolution, credential omission and explicit SSH re-pairing.
- [ ] **21 — Finish the integrated GUI and remove daily-use friction** — Active: populated search density/zoom improvements; integrated and physical journeys remain.
- [ ] **22 — Deliver the finished installable application** — Partial: installed5172c81 candidate native workflow and three-class profile recovery passed; final artifact awaits integrated GUI/physical qualification.
- [x] **23 — Integrate analytics and richer project memory** — Delivered: DuckDB activity, Hindsight recall/reflection and Graphiti dated relations; reviewed native-agent sources, correction/erase, portable restoration and interrupted projection recovery.
- [ ] **24 — Integrate isolated desktops and remote work** — Partial: Linux SSH agent/shared memory, reconnect, selected return/decline, stop and portable re-pairing delivered; physical Lume remains.
- [x] **25 — Improve building applications in the editor** — Delivered: project language navigation/recovery, declared build, reviewed workflow creation and actual native DSH workflow reuse demonstrated.
- [ ] **26 — Choose and establish the stronger desktop host** — Partial: external desktop Metal rendering, typed input and search observed; pointer selection and final integrated package qualification remain.


## Task16 — current implementation boundary

Read the complete16 master card and agent/environment companion, then `src/cli/project-memory-mcp.ts`, `src/main/runtime-rpc.ts`, `src/main/project-computer-tools.ts`, `src/renderer/src/components/ComputerControlPanel.tsx`, and the existing acceptance runners.

Existing: local MCP control operations, connection owner identity, generation/revision checks, selected PID/window attachment, observation and screenshot, element/pixel actions, uncertain-action tracking and tool stop. The GUI payload fix in71fc082 removes extraneous element fields from pixel requests. Typecheck/build and three focused checks were reported passed; one native-gated check skipped. The handoff audit did not rerun them.

Unfinished: establish actual input outcome and interruption/closed-target recovery; cover native-agent and GUI entry points, sibling-app isolation and stale/uncertain-action behavior. Do not complete16 from a fixture click alone. The companion requires host-versus-environment target identity and guest-scoped control; current remote protocol does not provide that route. Coordinate that implementation with24 through existing environment ownership.

`tests/acceptance/computer-control-ui.mjs` is an unproven helper: its wait can succeed with a missing Screenshot button, it reads the receipt without a direct completion wait, and failure cleanup does not await fixture exit. The prior missing actions.json is an observed failure; early timing is a hypothesis. Read the retained records under `docs/architecture/second-pass-16`. Fix only the owning runner issue needed for a real trial; do not turn this into a harness rewrite or entire-task substitute.

## Task24 — both environments and return of real work

Existing SSH delivery records cover native OpenCode/local Ornith/shared facts, terminal reconnect without replay, selected text changes, conflicts/decline, stop/retirement and fresh-profile re-pairing. Existing Lume code covers prepared guest registration and lifecycle; Show desktop requests the existing native viewer and rechecks ownership. Its actual reopen remains unproven.

Complete native Lume preparation/admission, actual clipboard policy and no unintended VNC, selected read-only source/writable-return boundaries, in-guest agent work and shared memory, disconnect/reconnect with uncertain writes preserved, guest controller identity, reviewed return and stop. Preserve a second project and user-owned VM. Pairing/setup must be usable through the intended product workflow, not only a temporary script.

Current `ProjectRemoteMethod` exposes terminal/memory/source/result operations but no computer-control methods. The computer panel routes locally. Guest PID/window control is implementation work; clicking the host VM viewer is not guest enumeration.

The remote `result.read` implementation accepts complete non-executable text and rejects binary/truncated files. Compare that boundary with the actual required artifact workflow; do not imply arbitrary binary/package import is already supported.

Retained task guest exists under research/ in the app repository (see Operations). Prior suggestion to rename it into private storage is UNTRIED and conflicts with the registration wording and new-clone deployment notes. Reconcile requirements and ownership before selecting preparation, explicit adoption or cloning; do not bypass policy by path manipulation. No user VM may be appropriated.

## Task26 — integrated host/native terminal

Electron/native Ghostty with daemon-owned PTYs is the implemented direction. Preserve it unless fresh comparative evidence justifies a migration. Existing external desktop evidence shows Metal rendering, pointer focus followed by typed/echoed text, and native search opening/closing. Pointer text selection is unproven; dispatched drag events are not successful selection.

Complete the full26 card: representative native agent + shared knowledge + unsaved editor + browser + reconnect; input/search/resize/selection usability and preserved live PTY/session owner when changing renderer. Complete dependency/license obligations and applicable packaged integration. A subagent's proposed global-coordinate explanation was not established by later observations; do not patch the bridge based on that claim.

## Task21 — finish the actual GUI

Existing increments include terminal shell/module retention, search density/font scaling, remote environment module height/side controls, and distinct module labels. Remote terminals remain local to the Environment panel, not automatically integrated in the local Sessions rail.

Complete real populated multi-agent coding, knowledge/history, editor/browser/control, remote/Lume and interrupted work. Profile and fix concrete focus/latency/background-contention/density problems. Consolidate duplicated controls and superseded GUI paths after replacement workflows work. Qualify narrow/wide/font scaling and keyboard/pointer interactions; show before/after product outcomes. Retain #16161D and terminal space. A mockup, passing old tests or a renamed panel does not finish21.

## Task22 — final current-source installed app

Intermediate candidate5172c81 is historical; its DMG/archive/transcript hashes were checked against retained files. Installed recovery transferred three explicit classes (workspace, canonical JSON memory, project kits), not every profile/credential/pairing. Runtime use later changed navigation/docking/terminal-order fields in recovered workspace state; transfer hashes are not timeless current-state hashes.

After remaining changes, use the actual package preparation/native/notices checks and isolated output. Install the current final candidate separately, use a representative integrated project/agent/memory workflow, and demonstrate update/recovery without project loss. Include required tooling setup and accurate distribution rights. Reuse unaffected proof, but allow the smallest necessary real agent call to qualify final installed behavior. No blanket promise of zero additional prompts.

Report exact source commit/artifact hash and signing/notarization truth, verify actual final package, and provide the DMG link. Never replace the user's installation or call the old candidate final.

## Completion and continuation

The full master cards and linked companions remain acceptance authority. Reorder ready slices when dependencies justify it; do not drop requirements. After a full task completes, update existing records, commit locally, show every01–26 row/current position/product outcome/proof/limits, then continue. Reopen specific old clauses only when evidence demands it. Skip only02.

## Correct folder layout — latest explicit user correction

- Project folder: `/Users/muzikfirst/Documents/donwellsai` (not Git).
- Only app repository: `/Users/muzikfirst/Documents/donwellsai/donwellsai`.
- Working/staging/handoff: `/Users/muzikfirst/Documents/donwellsai/workingfolder`.
- Research: `/Users/muzikfirst/Documents/donwellsai/research`.
- Trash: `/Users/muzikfirst/Documents/donwellsai/trash`.

The assistant previously misread the project folder as the app Git root. That relocation was corrected: latest source, dependencies and independent Git history were moved into the app child without reverting implementation. The preserved pre-correction commit is33e668e. The parent no longer contains app files or .git.

The previous baseline app checkout, including its untracked planning documents, is preserved in the project folder’s `trash/2026-09-07-layout-cleanup/original-app-before-correction`. Both old worktrees are now alongside it in that trash directory, with Git metadata repaired by `git worktree move`. Their committed history is contained in the active app repository. All seven dirty/untracked plan-restart files are also independently preserved, with SHA256 checks, in `/Users/muzikfirst/Documents/donwellsai/workingfolder/old-checkout-cleanup/plan-restart/`; see `preservation.json` beside it. No work was discarded. Five old daemons and two orphaned terminal helpers were stopped; closing the normal-profile OMP session was explicitly authorized by the user. Available session scrollbacks were saved privately before closure (bounded terminal history, not a full OMP transcript). Cleanup results and snapshots are in `/Users/muzikfirst/Documents/donwellsai/workingfolder/old-checkout-cleanup/`. The active app repository is independent of the archived worktrees. The branch name `workspace/terminal-foundation` is historical and does not require a folder with that name.
