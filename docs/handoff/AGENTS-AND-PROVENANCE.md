# Agent register and provenance

These are historical workers, not active agents in the destination harness. Read exact logs before treating a final report as established fact. No new subagents were launched for handoff preparation.

Root:01a0741e-cbae-7b92-9b05-b2299f723c9a. The root integrates and commits work, so authorship cannot be inferred from Git author alone.


## Turing — /root/pass2_baseline_research

Thread: `01a07ae6-0254-7433-91e8-ba107a6594d8`. At inventory: 15 command events and 0 file-change events (not unique edits/commits). Complete transcript/action record: `session-archive/01a07ae6-0254-7433-91e8-ba107a6594d8/` in external package.

Last recorded assistant report (historical claim, preserved for traceability):

> Fresh GitHub inspection supports four Task01 strengthening checks. No code changed, tools installed, or runtime comparison performed.
> 
> | Project | Verified refs | Concrete mechanism and relevance |
> |---|---|---|
> | cmux | HEAD `7d78b6e4cb0236c3b4eb354d851498b685801e00`; latest release API reports [v0.64.22](https://github.com/manaflow-ai/cmux/releases/tag/v0.64.22), published 2026-08-03 | [AgentResumeEvidenceProvenance.swift](https://github.com/manaflow-ai/cmux/blob/7d78b6e4cb0236c3b4eb354d851498b685801e00/Packages/macOS/CMUXAgentLaunch/Sources/CMUXAgentLaunch/AgentResumeEvidenceProvenance.swift) allows only classified top-level TUI evidence to own a resume binding; exec, subagent, and unknown records cannot replace it. [WorkspaceSessionRestoreIdentity.swift](https://github.com/manaflow-ai/cmux/blob/7d78b6e4cb0236c3b4eb354d851498b685801e00/Packages/macOS/CmuxWorkspaces/Sources/CmuxWorkspaces/Session/WorkspaceSessionRestoreIdentity.swift) reserves restored workspace UUIDs and generates replacements for collisions. |
> | Wave | HEAD `a4447c1563b2df285ab89e76c82f91e1a1a49c1e`; [v0.14.5](https://github.com/wavetermdev/waveterm/releases/tag/v0.14.5), 2026-04-16 | [durableshellcontroller.go](https://github.com/wavetermdev/waveterm/blob/a4447c1563b2df285ab89e76c82f91e1a1a49c1e/pkg/blockcontroller/durableshellcontroller.go), lines 130–186, reconnects an existing JobId. An absent job manager leaves the block unstarted unless explicitly forced; reconnect does not silently create a replacement job. Input includes a session UUID and monotonically increasing sequence, lines 213–217. Receiver deduplication was not inspected, so this is not evidence of exactly-once execution. |
> | Crush | HEAD `35a7bcab084a6022717d31b110c538a68d6fadf7`; [v0.92.0](https://github.com/charmbracelet/crush/releases/tag/v0.92.0), 2026-08-31 | [internal/session/session.go](https://github.com/charmbracelet/crush/blob/35a7bcab084a6022717d31b110c538a68d6fadf7/internal/session/session.go) persists parent-session relationships. [internal/cmd/session.go](https://github.com/charmbracelet/crush/blob/35a7bcab084a6022717d31b110c538a68d6fadf7/internal/cmd/session.go) resolves exact IDs first and rejects ambiguous prefixes. Useful native-history identity behavior; these files do not prove PTY survival or cross-project isolation. |
> | WezTerm — additional comparator | HEAD `d2f3f05b38f26a872f4b0bfbb3d2eaa7bdfc1b0b`; [20240203-110809-5046fc22](https://github.com/wezterm/wezterm/releases/tag/20240203-110809-5046fc22), 2024-02-03 | [Multiplexing documentation](https://github.com/wezterm/wezterm/blob/d2f3f05b38f26a872f4b0bfbb3d2eaa7bdfc1b0b/docs/multiplexing.md) explicitly separates native GUI attachment from mux ownership, supports Unix socket domains and automatic TLS reconnection, and checks secure socket ownership by default. [sessionhandler.rs](https://github.com/wezterm/wezterm/blob/d2f3f05b38f26a872f4b0bfbb3d2eaa7bdfc1b0b/wezterm-mux-server-impl/src/sessionhandler.rs) exposes pane identities, sequence state, working directory, and separate kill operations. Better focused comparator for an ergonomic GUI over surviving processes; not evidence of native agent checkpoint recovery. |
> | tmux — additional comparator | HEAD `578e07fcbc66dc60822b55b88ba12f518df57374`; [3.7c](https://github.com/tmux/tmux/releases/tag/3.7c), 2026-08-17 | [server-client.c](https://github.com/tmux/tmux/blob/578e07fcbc66dc60822b55b88ba12f518df57374/server-client.c), lines 609–623, implements client detachment distinctly from server/session termination; lines 2092 onward address clients unable to consume output. Strong focused control for process continuity and output pressure. No claim that tmux itself supplies project memory or survives server loss. |
> 
> These are current HEAD source inspections. Release metadata was fetched separately; **the inspected HEAD features have not been established as present in those releases**.
> 
> Current local comparison:
> 
> - [terminal-daemon.ts](/Users/muzikfirst/Documents/donwellsai/terminal-foundation/src/main/terminal-daemon.ts:94) already has the essential detached execution owner, sequence-bearing output/attach snapshots, authenticated run/session hook bindings, and fail-closed stale-endpoint handling. Replacing it solely because another project has these mechanisms would add little.
> - Its `broadcast()` writes to every connected client without handling socket backpressure. Bounded scrollback does not itself bound each socket’s pending write buffer. This is a source-observed pressure candidate, not a reproduced failure.
> - [terminal-daemon.test.ts](/Users/muzikfirst/Documents/donwellsai/terminal-foundation/tests/terminal-daemon.test.ts:193) exercises a fresh socket attachment, explicitly simulating app restart. Its `echo DAEMON_MARKER_42` marker can match terminal command echo; it does not independently prove that command execution produced the marker.
> - [workspace-baseline.mjs](/Users/muzikfirst/Documents/donwellsai/terminal-foundation/tests/acceptance/workspace-baseline.mjs:61) correctly separates source fingerprints from artifact hashes and explicitly says they do not establish the source/build relationship. Existing installed evidence is stronger than this baseline, but [strengthening-final/README.md](/Users/muzikfirst/Documents/donwellsai/terminal-foundation/docs/architecture/strengthening-final/README.md:3) remains historical evidence for its stated artifact.
> 
> Recommended Task01 checks, in priority order:
> 
> 1. **Real owner/client failure matrix with two projects.** Run independent long-lived shell processes with recorded PID, start time, session/run IDs, and canonical cwd; stop the disposable GUI, reattach through CLI and GUI, and verify both process identities and command-produced markers. Then separately lose the daemon and verify the product reports unavailable/lost state without silently spawning replacements. Close project A and prove B remains responsive.
> 2. **Output-pressure recovery check.** Connect one non-reading client while another consumes bounded generated output; measure daemon RSS/pending buffers and foreground response. Verify reconnection reports truncation and resumes without duplicate displayed output. If reproduced, fix the shared broadcaster with bounded slow-client handling and snapshot recovery.
> 3. **Resume identity collision/weak-record negative check.** Two simultaneous native sessions plus a helper/subagent record in each project; restart/reconnect and verify neither project acquires the other session or a newer helper record. cmux supplies a useful explicit evidence rule; add implementation only where current native-history selection fails this check.
> 4. **Artifact provenance check.** Reuse the existing final-artifact manifest verification to establish the baseline’s supplied artifact belongs to its expected build. Include before/after hashes of the executable, ASAR, and external CLI resources—the baseline imports RPC code from outside the ASAR. Reject an intentionally mismatched artifact and changed acceptance driver. Keep this distinct from runtime behavior acceptance.
> 
> <oai-mem-citation>
> <citation_entries>
> MEMORY.md:3-4|note=[Used historical guidance to distinguish current source and artifact evidence from prior outcomes]
> </citation_entries>
> <rollout_ids>
> </rollout_ids>
> </oai-mem-citation>


## Arendt — /root/pass2_baseline_audit

Thread: `01a07ae6-2985-7853-a3eb-40a8e12f8572`. At inventory: 13 command events and 0 file-change events (not unique edits/commits). Complete transcript/action record: `session-archive/01a07ae6-2985-7853-a3eb-40a8e12f8572/` in external package.

Last recorded assistant report (historical claim, preserved for traceability):

> **Spec verdict: PASS for the keyboard-focus and real-keydown corrections. Quality verdict: REQUEST CHANGES for recovery cleanup.**
> 
> `terminal-recovery.mjs:123–126` now attempts `agent.stop` after intentionally killing the daemon at line 111. `AgentRuntime.list()` returns cached `unverifiable` runs after connection loss (`src/main/agent-runtime.ts:118–135`); `stop()` rethrows the failed daemon request (`142–156`). Successful daemon-loss qualification therefore produces a cleanup failure.
> 
> Minimal ownership-safe correction:
> 
> - Record the intentionally killed daemon PID and verify that exact process exited.
> - Only for that confirmed injected loss, bypass app RPC agent/session cleanup.
> - Retain app shutdown, `cleanupOwnedSmokeDaemon`, and the fixture PID liveness check. Unexpected live fixtures or cleanup failures must still fail.
> - Set the injection marker when the kill succeeds, rather than relying on `report.daemonLoss`, which is assigned after several assertions that could fail.
> 
> Do not blanket-ignore `unverifiable` agents or stop errors. No edits or runtime interaction performed.


## Zeno — /root/pass2_evidence_fix

Thread: `01a07aea-a4f6-7e81-a5b9-09620a5f171f`. At inventory: 557 command events and 157 file-change events (not unique edits/commits). Complete transcript/action record: `session-archive/01a07aea-a4f6-7e81-a5b9-09620a5f171f/` in external package.

Last recorded assistant report (historical claim, preserved for traceability):

> No native source defect found. Mouse down focuses `AppTerminalView`, while drag, press, and release all forward to Ghostty correctly.
> 
> The drag used `y=85`, but the window begins at screen `y=159`; those global coordinates miss the window. Window-relative `(417,85)` should be translated to roughly global `(641,244)` points, without applying the screenshot’s 2× pixel scale.
> 
> No files changed or runtime actions performed.
> 
> <oai-mem-citation>
> <citation_entries>
> MEMORY.md:1-4|note=[confirmed terminal-foundation scope and current evidence requirement]
> </citation_entries>
> <rollout_ids>
> </rollout_ids>
> </oai-mem-citation>


## Newton — /root/plan_knowledge

Thread: `01a07bba-124f-74b2-9992-b5e6cfb86e06`. At inventory: 442 command events and 0 file-change events (not unique edits/commits). Complete transcript/action record: `session-archive/01a07bba-124f-74b2-9992-b5e6cfb86e06/` in external package.

Last recorded assistant report (historical claim, preserved for traceability):

> Added `tests/acceptance/computer-control-ui.mjs`; syntax checked.
> 
> It accepts explicit fixture, driver, Playwright, and evidence paths; pauses for visually selected coordinates; verifies actual point input and closed-target recovery; and requires clean app/daemon shutdown. No app launched.


## Gibbs — /root/plan_execution

Thread: `01a07bba-4010-7681-a41e-c5924380132d`. At inventory: 445 command events and 34 file-change events (not unique edits/commits). Complete transcript/action record: `session-archive/01a07bba-4010-7681-a41e-c5924380132d/` in external package.

Last recorded assistant report (historical claim, preserved for traceability):

> Task24 viewer-reopen increment is ready for root commit.
> 
> - **Implemented:** Show desktop verifies recorded PID/start time and native-viewer owner, invokes existing `lume attach … --display native`, then rechecks ownership.
> - **Checked:** focused Lume owner regression and full typecheck passed.
> - **Pending:** actual desktop reopen proof. No VM/app/model/build launched.
> 
> Changed five files: `project-lume.ts`, shared `project-environment.ts`, `ProjectEnvironmentPanel.tsx`, existing environment test, and `second-pass-24/offline-deployment.md`.
> 
> For later guest admission: after verified shutdown, move the retained guest directory into a fresh profile’s `project-environments/lume-vms` using a same-filesystem rename, recording original path and disk identities. That preserves bytes/inodes and is reversible after stopping. Qualify clipboard/VNC behavior before writing admission; register through existing API. No clone or adoption abstraction needed.
> 
> Stopping here for the requested handoff.


## Corrections the next agent must preserve

- Newton's runner description states intended checks; no app launch occurred and the script has documented synchronization/cleanup gaps. It is not successful native proof.
- Gibbs's Show desktop change has source/focused-check evidence; actual viewer reopening is still pending. The VM rename is an untried recommendation, not a reconciled lifecycle decision.
- Zeno's coordinate explanation is a hypothesis; later root observations did not establish that global coordinates were the cause. Do not repeat it as fact.
- Arendt's recovery-cleanup review identifies a particular historical code/check state. Consult subsequent edits before applying it again.
- Turing's source comparison is dated research, not perpetual upstream truth. Refresh only the pending selection facts before relevant implementation.

Root handoff/audit actions are preserved too, including repeated abbreviated responses and their corrections. Do not hide a failed experiment or use an agent's confident phrasing as acceptance evidence.
