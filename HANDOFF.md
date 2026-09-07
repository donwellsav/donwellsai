# Start here — donwells.ai harness/model handoff

Updated 2026-09-07. The user requested this handoff to a **different application, model and agent harness** to conserve nearly depleted usage. Do not rely on access to this conversation, its subagents, or its tools. The handoff is a pause, not project completion. When the user supplies START-NEXT-SESSION.txt, that authorizes resuming implementation.

## Workspace and product

Actual Git root: `/Users/muzikfirst/Documents/donwellsai/terminal-foundation`
Branch: `workspace/terminal-foundation`
Parent workspace: `/Users/muzikfirst/Documents/donwellsai` (do not confuse it with the nested Git root).
Last implementation commit before this handoff: `71fc082`. The handoff itself has a later documentation commit.

Build a desktop workspace for **coding and building applications with native CLI/TUI agents**, including OMP, Hermes, DeepSeek Harness, Kimi, custom CLIs and explicit ACP sessions. Several agents can work on one project or users can switch agents. Canonical project facts, decisions and reviewed handoffs are shared; native conversation histories remain separate. Terminals are the primary surface, with movable editor, browser, changes, knowledge and environment tools. Dark base is **#16161D**, restrained identity, side controls, no stacked headers or generic chat dashboard.

The user wants meaningful product improvements and selective reuse of strong components, preferably MIT/Apache. Do not rebuild working features merely to produce a diff or declare tasks complete from tests/status rows. Research actual pending choices; do not repeat completed research or expensive model/VM trials.

## Read these in order

1. Applicable AGENTS.md instructions in the workspace/ancestors and this file.
2. `docs/superpowers/plans/2026-09-07-rebuilt-01-26-plan.md` — single checklist and acceptance authority. Its handoff pause is lifted by the supplied resume prompt.
3. The complete card and relevant companion section for the task you resume:
   - `2026-09-07-agent-environment-implementation.md`: 16 and24.
   - `2026-09-07-workspace-implementation.md`: 21,22,26.
   - `2026-09-07-knowledge-implementation.md`: reference only if an affected knowledge clause needs work.
   These companions live beside the master plan.
4. The corresponding `docs/architecture/second-pass-NN/` delivery notes and actual owning source. Do not read every historical report indiscriminately.

Older contracts/rollouts contain superseded approval gates, numbering and completion labels. Use the master and latest user instructions. No new planning phase is needed.

## Full checklist at transfer

Checked means delivered against the rebuilt contract, with evidence retained in the master/architecture records. Open tasks must not inherit completion from their finished slices.

- [x]01 Foundation and ownership reconciliation
- [ ]02 **Skipped by user** (VoiceOver/additional-language/comparison campaign)
- [x]03 Project engines
- [x]04 Project resources and ownership
- [x]05 Terminal-centered workspace shell
- [x]06 Movable retained modules
- [x]07 Native agents and ACP
- [x]08 Session recovery and attention
- [x]09 Durable project memory
- [x]10 Reviewed handoffs
- [x]11 Document retrieval
- [x]12 Code graph/navigation
- [x]13 Knowledge/history/analytics navigation
- [x]14 Browser previews
- [x]15 Agent app inspection
- [ ]16 Controlled native desktop interaction — **current task, partial**
- [x]17 Changes, runs and artifacts
- [x]18 Parallel work and Git
- [x]19 Integration management
- [x]20 Portability/recovery
- [ ]21 Integrated GUI — partial
- [ ]22 Final installable app — intermediate candidate only
- [x]23 DuckDB/Hindsight/Graphiti integration
- [ ]24 SSH/Lume — SSH delivered, native Lume unfinished
- [x]25 App-building/editor workflow
- [ ]26 Native host/Ghostty — partial

After completing any full task: update the master and delivery record, commit locally, show the **entire01–26 checklist** plus exact outcome/proof/limits, then continue the next ready task. Only02 is skipped. Reorder ready tasks when useful; preserve every requirement. No routine approval pause, push, PR or publishing.

## First action: finish16, without repeating successful work

Read `second-pass-16/implementation.md`, `ComputerControlPanel.tsx`, `project-computer-tools.ts` and the new `tests/acceptance/computer-control-ui.mjs`.

The actual native screenshot worked after the desktop became available. It exposed a UI bug: point actions included `element`, which the strict runtime correctly rejected. **71fc082 fixes both pixelClick/pixelType** by sending element only for element-based actions. Typecheck/build and three focused owner/permission checks passed; one separately gated native test was skipped.

The corrected app trial did **not** establish click delivery: the runner read actions.json after a fixed300ms, before waiting for the asynchronous UI request. It then cleaned up. The runner now waits for the Screenshot button to leave its busy state and checks for an error. That runner correction is syntax checked, **not rerun**. Do not describe this as proven input or a closed-target pass.

First rebuild the current source once (it now also includes the later Lume show action); do not rebuild while a source app is running. Run the bounded UI check below. It creates an isolated app/profile and two disposable native fixture windows, checks permissions and attaches exact fixture A. It writes a native screenshot and waits90seconds for you to visually choose the Record A button. Inspect the image, then write coordinates.json with image-pixel x/y. Do not guess from a different image or repeat uncertain input. On success it verifies the native receipt, consumed observation, closed-target error, release and cleanup.

```sh
cd /Users/muzikfirst/Documents/donwellsai/terminal-foundation
pnpm run build
node tests/acceptance/computer-control-ui.mjs \
  --evidence /tmp/donwells-control16-next-harness \
  --fixture /private/var/folders/ly/4j6lsfds4n3g0_xcjrwjf4b40000gn/T/donwells-control-ui-CW2eu3/fixture \
  --driver /Users/muzikfirst/Documents/donwellsai/research/tool-trials/native-control-2026-09-06/cua-driver-0.23.2/cua-driver \
  --playwright /Users/muzikfirst/Documents/donwellsai/research/wt-quest-root/node_modules/playwright/index.mjs
```

Use a fresh evidence directory. If the compiled fixture is missing, compile the existing `tests/fixtures/native-control.swift` to a fresh temporary file with `swiftc`, then pass that path; do not invent a different fixture. The admitted driver hash is enforced by the runtime. The explicit Playwright path avoids installing a duplicate dependency. If an action result remains uncertain, inspect retained evidence, note the exact failure, and move to ready work; do not blindly click again.

## Remaining work after16

###24 — native Lume, not another Linux campaign

Linux SSH is already delivered: actual OpenCode/local Ornith memory use, same-owner reconnect/no input replay, reviewed selected return, conflict/decline, native stop, pairing retirement, export and explicit fresh-profile re-pairing. Read `second-pass-24/declined-results.md` and `second-pass-20/delivery.md`; do not rerun the model prompt.

**c89e541** adds Show desktop through existing `lume attach NAME --storage DIRECTORY --display native`. It checks recorded PID/start, private viewer marker and same owner afterward. Focused Lume regression and full typecheck passed. **Actual viewer reopen is not demonstrated.** Read `second-pass-24/offline-deployment.md`; an earlier claim that no CLI reopen exists was corrected. No AppleEvent helper/new VM owner was added.

Retained stopped task-owned guest:
`/Users/muzikfirst/Documents/donwellsai/research/tool-trials/isolated-work-2026-09-07/vms/donwells-task24-disposable`
Patched binary:
`/Users/muzikfirst/Documents/donwellsai/research/tool-trials/lume-patched-plan24/libs/lume/.build/release/lume`
Prior guest proof: `docs/architecture/strengthening-24/guest-desktop.json`.

No current app admission exists. Existing registration correctly requires private `<profile>/project-environments/lume-vms` storage. After verifying guest shutdown and disk identities, a same-filesystem **rename of this task-owned guest** into a fresh private profile can preserve bytes/inodes and be reversed after stopping. Record origin and identities. Do not clone/recreate it or adopt a user's VM. Qualify actual native display, clipboard disabled, VNC disabled and reviewed mounts before admitting it. Then register via existing API and demonstrate start, close/reopen same viewer/VM owner, guest-bound computer control, reconnect and stop. Do not write admission from a unit test or health check.

###26 — native terminal

Read `second-pass-26/decision.md` and `external-desktop.json`. Source e8ecff0 produced actual desktop ScreenCaptureKit images of the Metal surface, external typing with cat echo after clicking focus, and native search opening/closing. **Pointer selection remains unproven:** Orca drag dispatches showed no highlight. Pinned AppTerminalView forwarding had no identified defect. Do not change the native bridge based on a guess.

A global-coordinate theory was inconclusive; documented window-relative close-search click worked. Orca calls report synthetic/unverified dispatch, so require visible/read-back outcomes. As a possible alternative (not attempted), the admitted Cua Driver describes `drag` in **window-local screenshot pixels**, unlike Orca's window points, with duration/steps and exact PID/window. Inspect its actual help/schema and screenshot before trying it. Keep one bounded diagnostic; avoid another drag loop. Do not equate in-process AppKit events with external desktop input.

The temporary setup `/tmp/donwells-task26-physical-setup.mjs` and evidence directory `/tmp/donwells-task26-physical-evidence-1` remain for reference; the owned app/agent/daemon are stopped. Do not require those temporary scripts for permanent product behavior. Native implementation/license pins and bundled MPL z2d source are documented under `native/ghostty`.

###21 — integrated GUI

Search density/zoom, retained full-height remote environment module with collapsible side controls, and consistent palette labels are delivered increments. **e8ecff0** removes duplicate palette labels that called modules “Diff · Source Control”; actual before/after search selected the same environments pane. `second-pass-21/module-navigation.md` has proof and runner corrections.

Still finish the populated integrated journey and remaining ergonomics across local/native/ACP agents, knowledge, editor/browser, remote/Lume, interrupted work, narrow/wide/font scale and resource controls. Read the full21 card; screenshots or passing old checks alone do not close it. Remote terminal sessions are panel-local; do not falsely describe them as integrated into the local Sessions rail.

###22 — final package last

**ea031ae** records intermediate candidate5172c81 installation, one real local OMP canonical memory-read prompt, unchanged facts in two restored projects, editor result, and the installed recovery launcher transferring three explicit profile classes. The corrected model tool invocation and cleanup limitation are recorded; no second prompt is needed just to refresh unchanged memory proof.

Candidate:
`/tmp/donwells-task22-candidate-5172c81/donwells-0.4.0-mac-arm64.dmg`
SHA256: `b683b5025668034d8ef6ea90c0467b487936286f47cae6481d5f81264db0251c`
Installed isolated copy: `/tmp/donwells-task22-installed-5172c81/donwells.app`

It predates palette, point-request and Lume-show changes. It is **not final/current-source**. DMG and installed integrity passed727 app files/137 resources/188 notices. Signing is an ad hoc linker-signed Electron executable, no Developer ID, no sealed app resources, no notarization. Do not call it a signed release.

After remaining GUI/native work, use `package:prepare` and electron-builder with a fresh `/tmp` output override (see workspace companion), install separately, demonstrate required current integrated update/recovery and check actual artifact integrity. Do not replace the user's installation. Provide a clickable DMG path.

## Resources and recovery details

All root-owned app/agent/daemon processes from the listed trials were cleaned up. All subagents stopped; they are not available to your harness. Linux Docker fixture `donwells-task24-linux-ssh` is stopped, data retained. Hindsight/bridge, task-owned PostgreSQL and Graphiti Neo4j services are stopped; do not restart unless needed for changed behavior. User oMLX atlocalhost8899 was left untouched. No VM was launched in this final continuation.

Local model used successfully: `omlx/Ornith-1.5-35B-A3B-MLX-8bit`. Do not silently switch to paid services or exhausted Kimi. No credentials are in this handoff. Read configured local agent setup rather than recreating it.

Retained useful profiles/projects:
- `/private/tmp/donwells-task20-environment-evidence-1/restored-profile`: two registered projects, canonical JSON facts, fresh SSH pairing. `restored-project` and `collision-resolved` are sibling paths.
- `/private/tmp/donwells-task22-recovery-evidence-1/recovered-profile`: recovered workspace/memory/project-kit reports; remote bindings/credentials deliberately not copied.
- `/private/tmp/donwells-task24-linux-app-profile`: original SSH binding retired; do not reuse its ID there.

Recovery transfers explicit manifest-owned classes only. Source/destination owners must be stopped. Runtime markers are `donwells-runtime.json` and `terminal-daemon/runtime.json`; absent markers alone are not proof of no owner. `/tmp` canonicalizes to `/private/tmp`, and `/var` to `/private/var`. Wait for renderer state after RPC mutations. Resolved remote requests may still be non-completed operations: check state and exit, never infer cleanup from a promise.

## Efficiency and boundaries

Commit locally as you work. Never push, open PRs, publish, buy services or replace user installations without explicit authorization. One task-owned app at a time; only root/one operator controls desktop/VM/model trials. Do not capture unrelated user app content. Keep native output/menu data private; committed16 reports omit unrelated recent-item trees.

Use existing owners/helpers and stdlib. No speculative abstractions, duplicate process owners, broad test campaigns or status-only completion. Cap failed hypotheses: preserve exact error and next route, continue independent work. Do not invent progress, cost savings or model results. Show checklists after task completion, then continue unless the user pauses or an actual external blocker leaves no ready work.
