> **Historical plan — superseded for execution.** Use [the rebuilt 01–26 plan](2026-09-07-rebuilt-01-26-plan.md). Approval gates and Tasks27–29 below are historical; the replacement preserves their capabilities under01–26. Current mode is planning at the user’s request.

# donwells.ai Product Improvement Implementation Plan

> **For agentic workers:** APPROVED FOR CONTINUOUS EXECUTION by the user: “execute plan work without stopping.” Read the execution contract below. Execute the scoped tasks in the approved dependency order; no subagents without explicit permission. Steps use checkbox syntax for tracking.

**Goal:** Deliver a coherent desktop workspace in which interchangeable native terminal agents build applications together, share durable project knowledge, use integrated development tools and preserve work across sessions and environments.

**Architecture:** Keep project authority and process ownership separate from presentation. Improve or replace components behind those boundaries using researched implementations. Maintain one authoritative project fact/history store, with separately managed document/code indexes, learned memory, temporal relationships and analytics.

**Tech Stack:** The current checkout uses Electron, React, xterm, node-pty, FlexLayout, Monaco, SQLite/FTS5 and QMD/LanceDB. These are the starting implementation, not automatic winners. Requested integrations include DuckDB, Hindsight, Graphiti/alternative graph backends, Lume, SSH and ACP. Tauri/native Ghostty receive an explicit host decision and integration task.

**Spec:** [Existing product specification](../specs/2026-09-06-terminal-workspace-design.md), as amended by the user’s current product direction and the constraints below. This draft proposes replacing the execution order and completion rules of the earlier second-pass plan, not rolling back its source history.

**Current position:** Task01, Task26, Task04 and Task03 product changes complete; Task05 active: native focus repair complete; concrete shell proposal awaits the card’s required visual approval. Task02 is skipped; final GUI refinement is Task29. User authorized continuous execution across the plan. Preexisting Kimi changes remain separate. Historical tests and packages are not substituted for product improvements.

## Product promise and non-negotiable requirements

- Open a software project; use OMP, Hermes, Kimi, DeepSeek Harness or other native CLI/TUI agents; run several or switch between them.
- Share project facts, decisions, sources and explicit handoffs across agents. Shared memory does not mean every agent has the same internal conversation, context window or running process.
- Build real applications using editor/Git/tasks, source and document retrieval, browser testing, computer control, isolated/remote work and usable review/output tools.
- Terminals occupy the main work area. Supporting tools belong in movable side panels or intentional workspace splits. Do not stack redundant app headers above terminals.
- Main dark surface is `#16161D`; the app has its own identity and coherent ergonomics rather than an Orca clone or generic agent-chat dashboard.
- Preserve existing user projects, facts, history, sessions, credentials, unsaved edits and installed applications throughout changes.
- Fresh GitHub research precedes each implementation task. The 1,209-repository inventory is a starting point, not the search boundary or proof of review.
- Prefer MIT/Apache reuse; check actual chosen files, transitive dependencies, assets and redistribution. Other terms need an explicit admission decision, not an assumed license based on a repository label.
- Choose stronger outcomes, not familiar or easier implementations. Conversely, adding a second engine must deliver its defined role rather than duplicate the same responsibility.
- Task02 stays skipped. Ordinary keyboard/focus/contrast/resizing remain part of usability; VoiceOver/additional-language qualification remains deferred.
- No automatic push, PR, publication, provider credit redemption, destructive migration or replacement of the user’s running app.

## Execution contract — the proposed leash

1. **Execution authorization:** the user approved continuous plan execution. Complete each scoped card, show the full checklist, and proceed immediately in dependency order. Ask only for a material decision outside the approved scope or information that cannot be safely inferred; do not stop merely at a commit or checkpoint.
2. **One active implementation:** do not start unrelated work or delegate without explicit permission. Research may inspect alternatives, but cannot quietly become installs, prototypes, host migration or production edits outside the approved card.
3. **Before a card starts:** show the user-visible gap, recommended component/design, strongest credible alternative, relevant licensing/deployment implications, exact intended changes and demo. Pin versions then, using fresh sources; this draft does not invent future winning versions.
4. **Completion is a product outcome:** research, tests, receipts, downloads, prototypes and keep-current reports do not complete an implementation task. The user must be able to use the stated capability or improvement through the app/native-agent workflow.
5. **No forced change for appearances:** if a researched task has no justified product change, explain that and request a scope decision. Do not invent code or mark the task complete using validation alone.
6. **Scope drift rule:** a newly found issue goes to its owning task. Fix it now only if it blocks the approved deliverable. If it materially changes the scope, stop implementation and present an amended card. Do not turn a failed check into a general audit.
7. **Verification budget follows the change:** use the smallest regression and real user-flow check that prove the change. Broader checks follow actual cross-cutting risks. Do not repeat full suites, package builds or long benchmarks after unrelated document changes or passing checks.
8. **Candidate failure rule:** separate upstream limits from bad configuration or trial mistakes. Propose a corrected route or a replacement. A rejected implementation does not cancel the requested feature; unresolved delivery stays open.
9. **Commits and disclosure:** commit scoped working increments locally; distinguish partial work from completed tasks. Preserve unrelated dirty files. Never rewrite history or roll back as a substitute for removing a poor implementation.
10. **Stop conditions:** pause on a requested pause, material scope change, required user choice, or inability to deliver the approved outcome. Never claim work continues after ending a turn; report the exact active state.

At each checkpoint use this format:

- **Task / status:** implementation, blocked decision, or ready for user review.
- **Product change:** what the user can do now and where.
- **Choice:** what was adopted/replaced and why it improves the defined outcome.
- **Proof:** the focused check and actual flow, with material limits.
- **Commit / remaining work:** exact local commit and unfinished portions.
- **Full checklist / next proposed card:** every task status; no silent advancement.

## Architecture decisions to approve

| Boundary | Proposed responsibility | What must not happen |
|---|---|---|
| Desktop host | GUI, view lifecycle and native platform integration; Task26 selects the route before later UI investment. | Rewriting all project/agent logic merely to change window technology. |
| Project authority | Canonical project identity plus checkout identity, using existing `resolveProjectToolScope`. | Sharing checkout indexes across divergent branches or letting a tool pick arbitrary project authority. |
| Native execution | Stable agent/session ownership, native TUI I/O and recovery. | Treating panel movement as process restart or silently launching a replacement agent. |
| Durable knowledge | Existing `ProjectMemoryApi` semantics: facts, IDs, revisions, history and explicit corrections. | Two independently writable stores both claiming to be authoritative. |
| Retrieval and graphs | QMD/LanceDB or stronger approved retrieval; code structure index; source-backed temporal Graphiti relationships. | Conflating code graphs with learned/temporal memory or returning deleted/stale facts as current. |
| Learned memory | Hindsight-derived recall/reflection with attribution and reviewable promotion into durable facts. | Automatically treating inferred statements as confirmed project decisions. |
| Analytics | DuckDB-backed project activity analysis, preferably using existing export paths. | A redundant persistent mirror with no freshness/deletion story. |
| Tools and environments | Project-owned browser, native control, Lume, SSH and optional services. | Global target/control access presented as project isolation. |
| Agent protocols | Native CLI/TUI remains first-class; ACP is an explicit supported session mode. | Hidden double ownership or pretending every native session supports ACP attachment. |

Existing interfaces to reuse include `ProjectMemoryApi`, `ProjectToolScope`, `ProjectToolDefinition`, `ToolServiceState`, `RunningAgent`, `ProjectHandoff`, `ProjectSearchHit` and current runtime RPC. Exact new contracts are written with the approved implementation proposal after research, only where existing interfaces cannot express the required capability. Do not build a speculative universal plugin framework.

## Shared integration rules

These are required behaviors, not a mandate to invent new services or interfaces:

- A fact projected into Hindsight or Graphiti keeps its canonical project, source ID and revision. Projection jobs are idempotent and resume after interruption. UI/agent reads distinguish current, stale and unavailable projections; superseded/deleted source facts must not reappear as current knowledge. Task23 chooses the smallest durable synchronization mechanism that satisfies this.
- Document and code indexes bind to the checkout and source revision. Learned facts can be project-wide only when their provenance permits it. A diverged worktree does not silently rewrite another checkout’s index.
- Each external engine has a declared local process or remote endpoint owner, supported version/configuration, credentials location, resource behavior and uninstall/rebuild path. A remote endpoint receives project content only through the user’s explicit configuration; credentials stay outside exported kits and logs.
- Native TUI and ACP transitions retain an identified native session where supported. Where conversion is unsupported, use an explicit new session plus reviewed handoff; never present it as the same live conversation.
- Returned VM/SSH/browser artifacts carry origin and project identity and are reviewed before applying changes locally. Reconnection inspects uncertain operations instead of replaying writes.
- New capabilities must be usable from the native-agent tool path and have an understandable configuration/status route in the app. Module-specific UI is delivered with the capability; Task29 unifies it rather than being the first usable interface.
- Local provider qualification uses the user’s configured oMLX `Ornith-1.5-35B-A3B-MLX-8bit` when available. Availability is checked at execution time; a missing provider is surfaced rather than silently charged to another hosted provider.

## Proposed execution order

Numbers preserve the checklist’s identity; dependency order avoids rebuilding the GUI for a late host change and packaging before requested integrations are finished.

**01 → 26 → 04 → 03 → 05 → 06 → 07 → 08 → 09 → 10 → 11 → 12 → 13 → 27 → 14 → 15 → 16 → 17 → 18 → 23 → 24 → 25 → 28 → 19 → 20 → 29 → 21 → 22.**

Task02 is excluded. Task26’s move earlier and final release after Task29 are explicit proposals for approval. If the user prefers numeric order, revise dependencies before coding; do not silently follow two conflicting sequences.

| Milestone | Tasks | Result |
|---|---|---|
| Direction and foundations | 01, 26, 04, 03 | A useful foundation fix, selected host path and usable project-owned engines. |
| Native workspace | 05–08 | Distinctive terminal-centered workspace and interchangeable recoverable agents. |
| Shared knowledge | 09–13, 27 | Durable facts, handoffs, retrieval, code navigation and session history. |
| Build and interact | 14–18 | Browser/native control, review/build tools and coordinated Git work. |
| Requested integrations | 23–25, 28 | DuckDB/Hindsight/Graphiti, Lume/SSH, language workflows and ACP in the product. |
| Coherence and delivery | 19, 20, 29, 21, 22 | Discoverable tools, portability, final GUI, targeted optimization and installable app. |

## Full checklist

- [x] **01 — Finish a useful foundation change** — Delivered: same-position TUI redraws invalidate terminal search cache; focused packaged regression passes.
- [ ] **02 — SKIPPED — original terminal/layout comparison** — SKIPPED by user.
- [x] **03 — Make engine choices usable per project** — Delivered: explicit document retrieval modes, native-agent engine inventory, live configure/query/disable workflow.
- [x] **04 — Own tools and resources by project** — Delivered: launch cancellation, truthful stopping state, live ownership/calls, shared native graph cache with isolated checkout sessions.
- [ ] **05 — Establish the terminal-centered workspace** — ACTIVE: focus repair delivered; [rendered proposal](../../architecture/second-pass-05/layout-proposal.html) awaits required visual approval before shell replacement.
- [ ] **06 — Make modules movable without disrupting work** — Queued for implementation after preceding dependencies.
- [ ] **07 — Make native agents interchangeable** — Queued for implementation after preceding dependencies.
- [ ] **08 — Make sessions recoverable and attention useful** — Queued for implementation after preceding dependencies.
- [ ] **09 — Make durable project memory dependable and editable** — Queued for implementation after preceding dependencies.
- [ ] **10 — Make agent handoffs useful** — Queued for implementation after preceding dependencies.
- [ ] **11 — Improve project document retrieval** — Queued for implementation after preceding dependencies.
- [ ] **12 — Add useful code structure and graph navigation** — Queued for implementation after preceding dependencies.
- [ ] **13 — Unify finding and opening project knowledge** — Queued for implementation after preceding dependencies.
- [ ] **14 — Make browser previews part of the project** — Queued for implementation after preceding dependencies.
- [ ] **15 — Let agents inspect and test project applications** — Queued for implementation after preceding dependencies.
- [ ] **16 — Provide controlled desktop interaction** — Queued for implementation after preceding dependencies.
- [ ] **17 — Connect code changes to working results** — Queued for implementation after preceding dependencies.
- [ ] **18 — Coordinate parallel work and Git** — Queued for implementation after preceding dependencies.
- [ ] **19 — Make every integrated tool discoverable and manageable** — Queued for implementation after preceding dependencies.
- [ ] **20 — Make projects portable and recoverable** — Queued for implementation after preceding dependencies.
- [ ] **21 — Remove daily-use friction and bottlenecks** — Queued for implementation after preceding dependencies.
- [ ] **22 — Deliver the finished installable application** — Queued for implementation after preceding dependencies.
- [ ] **23 — Integrate analytics and richer project memory** — Queued for implementation after preceding dependencies.
- [ ] **24 — Integrate isolated desktops and remote work** — Queued for implementation after preceding dependencies.
- [ ] **25 — Improve building applications in the editor** — Queued for implementation after preceding dependencies.
- [x] **26 — Choose and establish the stronger desktop host** — Delivered: selectable native Ghostty on Electron, daemon-owned PTYs, native search and app shortcuts; packaged integrated recovery passes. Physical desktop qualification remains explicit.
- [ ] **27 — Make native session history useful across agents** — Queued for implementation after preceding dependencies.
- [ ] **28 — Integrate ACP and additional agent adapters** — Queued for implementation after preceding dependencies.
- [ ] **29 — Refine the complete GUI around the integrated product** — Queued for implementation after preceding dependencies.

## Task cards

The file lists are existing starting ownership boundaries, verified during planning. A card may require a new focused adapter or host-specific file; its exact path and interface must appear in the implementation proposal before approval. Existing-code names do not preselect that technology as the winner. Host-dependent paths are remapped explicitly after Task26. No speculative implementation code is presented as settled before component research.

Each unskipped card requires its fresh research and user-approved implementation proposal before the listed implementation steps. Each ends with its stated demonstration, focused review, local commit and the full checklist. Large cards have named slices so a single failure cannot turn into an unlimited project; completion requires all of that card’s slices.

### Task 01: Finish a useful foundation change

**Depends on:** None.

**Product deliverable:** Terminal search finds text that a running TUI has just overwritten, without losing its session.

**Research before implementation:** Inspect the current xterm search cache, admitted upstream fixes and supported patch mechanisms; compare the narrow fix against replacing the addon. Terminal/layout replacement remains outside Task02.

**Starting files:** `src/renderer/src/components/TerminalPane.tsx`, `tests/acceptance/terminal-recovery.mjs`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`.

- [ ] Account for the paused changes: separate the unfinished search patch from earlier Kimi changes and supporting acceptance edits; preserve all of them until their disposition is reviewed.
- [ ] Finish or replace the narrow search-cache correction at the shared addon boundary; document the upstream version and removal condition for a local dependency patch.
- [ ] Keep the one overwrite/search regression needed to protect the fix; carry unrelated findings to their owning cards.

**Done demonstration:** In the actual terminal, change INPUTS 0 to INPUTS 1 at the same cursor position. Search finds the new text and no longer returns the old text. The same native process remains attached.

**Scope boundary:** No additional baseline campaign, cold-launch series, unrelated cleanup or GUI redesign. The current unverified patch is not accepted merely because it exists.

### Task 02: SKIPPED — original terminal/layout comparison

**Depends on:** None.

**Product deliverable:** No work under this task, as explicitly requested.

**Research before implementation:** None.

**Done demonstration:** Not applicable.

**Scope boundary:** Retain xterm/FlexLayout pending the separately authorized Task26 decision. Do not claim this skipped task is complete.

### Task 03: Make engine choices usable per project

**Depends on:** 04.

**Product deliverable:** A project can configure and use its selected memory, document and code engines through the app and native-agent tool configuration.

**Research before implementation:** Compare SQLite/FTS5, Engram, current QMD/LanceDB and credible retrieval alternatives; inspect Hindsight and Graphiti connection requirements and current graph backends. Research browser/control options here as recommendations for Tasks15/16, not a second implementation.

**Starting files:** `src/main/project-doctor.ts`, `src/main/project-tools.ts`, `src/shared/project-doctor.ts`, `src/renderer/src/components/settings/ProjectToolsSettings.tsx`, `src/main/agents/project-memory-config.ts`.

- [x] Present an engine matrix by role: durable facts, document retrieval, code graph, learned memory and temporal relationships. Name a recommended default and explain each retained alternative.
- [x] Implement project configuration and usable connections for approved engines through the existing service owner; expose real supported operations and actionable unavailable states.
- [x] Connect the chosen existing-project retrieval route to native-agent tool configuration. Reserve automatic Hindsight/Graphiti projection and richer memory UI for Task23.

**Done demonstration:** Configure a project engine, execute a real project-scoped query through the supported agent tool path, disable it, and continue using terminals and durable memory.

**Scope boundary:** A shortlist, downloaded binary or green health indicator is not delivery. Hindsight/Graphiti remain committed Task23 integrations, not optional abandoned experiments.

### Task 04: Own tools and resources by project

**Depends on:** 01, 26.

**Product deliverable:** Starting, stopping or changing tools in one project cannot terminate another project’s work.

**Research before implementation:** Study project/process ownership in Wave, WezTerm and maintained MCP supervisors; choose existing helpers or mature components by behavior, not framework popularity.

**Starting files:** `src/main/project-tools.ts`, `src/shared/project-tools.ts`, `src/main/project-doctor.ts`, `src/shared/child-process/run-process.ts`.

- [x] Use the existing canonical project key and separate checkout index key for every service; expose owner, active jobs and connection state.
- [x] Add only lifecycle capabilities needed by the approved engines: local child process or explicitly configured endpoint, cancellation, crash recovery and bounded output.
- [x] Make stop/disable remove the selected owner’s resources, and make missing optional services leave native terminals usable.

**Done demonstration:** Run two projects, stop or crash a service in A, and keep B responsive. Restart A without duplicate workers or replayed writes.

**Scope boundary:** No new universal orchestration framework or mandatory background fleet.

### Task 05: Establish the terminal-centered workspace

**Depends on:** 03, 04.

**Product deliverable:** The primary screen has a distinctive hierarchy, coherent colors and useful terminal space.

**Research before implementation:** Review terminal-first workspaces, native macOS ergonomics and docking precedents; extract interaction strengths without cloning another app.

**Starting files:** `src/renderer/src/components/Workbench.tsx`, `src/renderer/src/components/RightSidebar.tsx`, `src/renderer/src/components/workspace-shell.css`, `src/renderer/src/main.css`.

- [ ] Produce one concrete layout proposal using #16161D, a restrained accent system, readable terminal type and side-mounted project/tool controls; obtain visual approval before replacing the shell.
- [ ] Implement the approved primary shell with clear active project, agent and environment identity, consolidating duplicate controls.
- [ ] Give every main action a visible route and a keyboard route; retain terminal height rather than stacking app headers.

**Done demonstration:** Open a project and two native agents, switch tools and return to typing without searching for focus or sacrificing terminal height.

**Scope boundary:** No generic chat dashboard, decorative overview cards or full application polish; final integrated GUI work is Task29.

### Task 06: Make modules movable without disrupting work

**Depends on:** 05.

**Product deliverable:** Users can arrange terminals, editor, browser and tools around the work and return to the same arrangement.

**Research before implementation:** Research persistent docking, stable view identity and keyboard panel navigation within the chosen host; Task02 remains skipped.

**Starting files:** `src/renderer/src/workspace-layout.ts`, `src/renderer/src/components/Workbench.tsx`, `src/renderer/src/components/TerminalPane.tsx`, `src/renderer/src/store.ts`.

- [ ] Separate panel placement from terminal, editor and browser ownership using existing persistent resource IDs.
- [ ] Implement move, split, resize, close-view and restore interactions with keyboard focus transfer and practical presets.
- [ ] Restore per-project layout while preserving unsaved documents and showing an explicit missing-resource state.

**Done demonstration:** Move a running agent and unsaved editor between splits and side panels; return after restarting the GUI with the same session and draft.

**Scope boundary:** Closing a view must not silently kill its process. Do not add a second layout state model.

### Task 07: Make native agents interchangeable

**Depends on:** 04, 06.

**Product deliverable:** OMP, Hermes, Kimi, DeepSeek Harness and user-defined CLI agents can work in the same project with understandable setup and capabilities.

**Research before implementation:** Inspect current native launch/resume/tool conventions, maintained adapters and provider support for each agent. Verify local oMLX compatibility from real configuration.

**Starting files:** `src/main/agent-runtime.ts`, `src/main/agents/project-memory-config.ts`, `src/shared/agent-runtime.ts`, `src/renderer/src/components/runs/AgentsSection.tsx`.

- [ ] Provide discover/configure/launch/resume paths while preserving native TUI operation and custom commands.
- [ ] Connect the selected project’s shared tools using each agent’s supported mechanism; distinguish unsupported capabilities from failed setup.
- [ ] Expose provider/model configuration and clear setup errors. Use local Ornith where available; do not assume hosted Kimi usage.

**Done demonstration:** Use two different agents on one project, then switch agent type and access the same project facts through their native tool paths.

**Scope boundary:** Do not replace native agents with a homegrown chat harness or imply that a startup screen proves a working provider.

### Task 08: Make sessions recoverable and attention useful

**Depends on:** 06, 07.

**Product deliverable:** Users know which agent needs them and can reconnect without duplicate work or lost process identity.

**Research before implementation:** Compare durable reconnect, slow-reader handling and resume provenance in Wave, WezTerm, tmux and cmux; inspect exact licenses before code reuse.

**Starting files:** `src/main/terminal-daemon.ts`, `src/main/daemon-client.ts`, `src/main/agent-runtime.ts`, `src/renderer/src/components/TerminalPane.tsx`, `src/shared/agent-presentation.ts`.

- [ ] Distinguish running, waiting, exited and unverifiable states; attention opens the exact owning session.
- [ ] Fix confirmed weak ownership/output-pressure paths in the shared daemon; reconnect from snapshots without replaying input.
- [ ] Separate detach, interrupt, stop and dismiss, with visible lost-owner recovery options.

**Done demonstration:** Detach/reconnect A while B runs, exercise a slow client and kill a disposable owner; preserve live identities and never silently respawn a lost agent.

**Scope boundary:** No attempts to fabricate native state by guessing from arbitrary terminal text.

### Task 09: Make durable project memory dependable and editable

**Depends on:** 03, 04, 07.

**Product deliverable:** All supported agents share project facts, decisions and conventions with history, corrections and safe migration.

**Research before implementation:** Reassess memory authorities on revision checks, history, offline operation, import/export and isolation; consider replacement only with a complete migration route.

**Starting files:** `src/main/project-memory.ts`, `src/main/project-memory-store.ts`, `src/main/project-memory-sqlite.ts`, `src/main/project-memory-migration.ts`, `src/cli/project-memory-mcp.ts`, `src/renderer/src/components/ProjectMemoryEditor.tsx`.

- [ ] Keep one authoritative fact/history store behind the existing ProjectMemoryApi; improve or replace the backend through that boundary.
- [ ] Implement reviewable corrections, archive/delete and revision conflict handling across agents; identify project-wide versus checkout-specific context.
- [ ] Provide restart-safe migration with backup, stable IDs/history and an explicit recovery route. Derived engines never become a competing authority accidentally.

**Done demonstration:** Agent A writes a decision; B reads and corrects it; A sees the correction and history after restart. An unrelated project cannot read it.

**Scope boundary:** No automatic promotion of raw transcripts or model inference into authoritative facts.

### Task 10: Make agent handoffs useful

**Depends on:** 07, 09.

**Product deliverable:** A user can move work to another agent without manually reconstructing project state.

**Research before implementation:** Review native continuation and context transfer patterns; distinguish shared facts, task summaries and agent-specific conversation state.

**Starting files:** `src/main/project-handoff.ts`, `src/main/agent-delivery.ts`, `src/shared/project-handoff.ts`, `src/renderer/src/components/ProjectHandoffPanel.tsx`.

- [ ] Build a concise reviewed handoff from goal, completed work, relevant files, current source revision, unresolved questions and next action.
- [ ] Support same-project receiving agents with explicit claim and separately acknowledged delivery.
- [ ] Expose stale source, conflicting edits, uncertain delivery and retry choices without automatically resending a write.

**Done demonstration:** OMP hands work to Hermes or another supported agent, which uses the shared facts and exact next step; interrupted delivery is shown honestly.

**Scope boundary:** No private chain-of-thought collection or pretend conversion of every agent’s internal session format.

### Task 11: Improve project document retrieval

**Depends on:** 03, 04, 09.

**Product deliverable:** Agents and users find relevant project documentation with resolvable citations and current content.

**Research before implementation:** Compare current QMD/LanceDB with credible hybrid retrieval and reranking alternatives on actual project questions; include maintained projects outside the supplied list.

**Starting files:** `src/main/project-documents.ts`, `src/main/project-document-index.ts`, `src/main/project-document-worker.ts`, `src/shared/project-tools.ts`.

- [ ] Integrate the chosen chunking/search/reranking route with approved source folders and incremental indexing.
- [ ] Expose indexing progress, pause/cancel and stale/missing citations; remove deleted sources from retrieval.
- [ ] Keep lexical search usable when models or semantic indexes are unavailable.

**Done demonstration:** Find a paraphrased design decision, open its cited source, edit/delete the source and observe current retrieval behavior.

**Scope boundary:** No whole-home indexing or full-corpus rerun for every UI change.

### Task 12: Add useful code structure and graph navigation

**Depends on:** 03, 04.

**Product deliverable:** Users and agents can find definitions, callers, imports and structural matches in the active checkout.

**Research before implementation:** Compare codebase-memory-mcp, ripgrep, ast-grep and maintained code graph/index alternatives; compare graph storage separately from language extraction.

**Starting files:** `src/main/project-code-search.ts`, `src/main/project-code-graph.ts`, `src/renderer/src/components/ProjectGraph.tsx`, `src/renderer/src/project-graph.ts`.

- [ ] Integrate the strongest code lookup path with direct source navigation and explicit language coverage.
- [ ] Keep indexes bound to checkout/revision and update affected content after edits or branch changes.
- [ ] Give graphs useful navigation and filtering around a selected symbol; label uncertain dynamic relationships.

**Done demonstration:** Start at a function, find its direct callers/imports, open the matching lines and distinguish results from a diverged worktree.

**Scope boundary:** No decorative graph visualization with no useful source navigation; code graph is not temporal memory.

### Task 13: Unify finding and opening project knowledge

**Depends on:** 09, 11, 12.

**Product deliverable:** One search surface finds files, code, documents and memory without hiding their different meanings.

**Research before implementation:** Research source-grouped search, query cancellation, keyboard navigation and provenance presentation in developer tools.

**Starting files:** `src/main/project-search-ipc.ts`, `src/shared/project-tools.ts`, `src/renderer/src/components/ProjectSearch.tsx`.

- [ ] Compose existing result types in source groups with useful filters and keyboard navigation.
- [ ] Bind open actions to the original project and revision; cancel stale requests during project switches.
- [ ] Open exact lines, memory records and cited documents, showing missing/stale sources with a recovery action.

**Done demonstration:** Search a project concept, move among code/document/memory results and open their actual sources; change projects mid-query without leaked results.

**Scope boundary:** No invented global relevance score or duplicate index for the search UI.

### Task 14: Make browser previews part of the project

**Depends on:** 04, 06, 26.

**Product deliverable:** Project previews stay usable while terminals and panels move, with clear page and project ownership.

**Research before implementation:** Review the chosen host’s supported embedded-browser surface and browser isolation options; compare complete preview behavior rather than empty webviews.

**Starting files:** `src/main/browser-views.ts`, `src/shared/browser-view.ts`, `src/renderer/src/components/BrowserPane.tsx`, `src/renderer/src/components/BrowserHosts.tsx`, `src/renderer/src/browser-view-port.ts`.

- [ ] Use the host-supported persistent browser owner and connect visible bounds/lifecycle to the workspace.
- [ ] Provide navigation, history, local app URLs, loading/error recovery and external-open behavior.
- [ ] Preserve the intended browser session when rearranging panels and keep project scopes explicit.

**Done demonstration:** Run a local app, navigate it, move its preview beside an agent and return without losing page state.

**Scope boundary:** No arbitrary DOM embedding workaround that breaks input, clipping or process ownership.

### Task 15: Let agents inspect and test project applications

**Depends on:** 03, 04, 14.

**Product deliverable:** An agent can operate the project browser, inspect errors and return useful diagnostics to its native session.

**Research before implementation:** Compare Playwright MCP, agent-browser, browser-use and maintained alternatives on target selection, diagnostics, cancellation and integration.

**Starting files:** `src/main/project-browser-tools.ts`, `src/renderer/src/components/BrowserTestingPanel.tsx`, `src/main/project-tools.ts`.

- [ ] Bind automation to an explicitly selected project preview or owned browser session.
- [ ] Expose needed inspect, interact, screenshot, console/network and trace actions through agent tools and concise UI controls.
- [ ] Return artifact links and actionable failures; cancel stalled actions without duplicating browser owners.

**Done demonstration:** An agent reproduces a bug in a local app, reads console/network evidence, edits it and confirms the user flow works.

**Scope boundary:** No control of unrelated user tabs or a second browser launched without an explicit need.

### Task 16: Provide controlled desktop interaction

**Depends on:** 03, 04, 06.

**Product deliverable:** Agents can operate a chosen native application or isolated desktop with clear ownership and a visible stop action.

**Research before implementation:** Compare current Cua Driver, Peekaboo and maintained computer-control alternatives for target fidelity, background operation and interruption.

**Starting files:** `src/main/project-computer-tools.ts`, `src/renderer/src/components/ComputerControlPanel.tsx`.

- [ ] Implement target attachment, capability/permission diagnosis and visible action state.
- [ ] Expose the supported observation/action path to native agents and keep control scoped to the selected target.
- [ ] Provide immediate interruption and surface target disappearance or ownership loss before further actions.

**Done demonstration:** Operate a disposable native app while another app remains untouched; interrupt an action and recover from a closed target.

**Scope boundary:** No global desktop takeover disguised as project scope.

### Task 17: Connect code changes to working results

**Depends on:** 08, 10.

**Product deliverable:** Users can review changes, run the project and see what those runs actually produced.

**Research before implementation:** Compare developer review/run/artifact workflows and existing diff components; retain mature interfaces unless a stronger option fixes a defined gap.

**Starting files:** `src/main/operational-run-service.ts`, `src/main/runtime-rpc.ts`, `src/main/diff-review.ts`, `src/renderer/src/components/DiffReviewPanel.tsx`, `src/renderer/src/components/ProjectActions.tsx`.

- [ ] Extend `OperationalRunService` and the existing `verification.scripts/run/list/attach` RPC routes alongside diff-review records; keep one run/task authority instead of adding another database.
- [ ] Connect run/test/build actions to the active source revision and show actionable output beside changed files.
- [ ] Keep generated artifacts openable and distinguish observed producer output from user-attached references or stale results.

**Done demonstration:** Edit an app, run its failing command, fix it, rerun and open the produced artifact from the same workspace.

**Scope boundary:** This builds user-facing development tools; it is not permission for the agent to perform a new app-wide verification campaign.

### Task 18: Coordinate parallel work and Git

**Depends on:** 07, 10, 17.

**Product deliverable:** Users can assign work to several agents in a shared checkout or isolated worktrees and review the results coherently.

**Research before implementation:** Review worktree/task coordination, Lazygit, Backlog.md and maintained alternatives; select one task authority rather than stacking trackers.

**Starting files:** `src/main/project-task-coordination.ts`, `src/renderer/src/components/runs/AgentsSection.tsx`, `src/renderer/src/components/ProjectActions.tsx`.

- [ ] Make shared-checkout versus isolated-worktree launch an explicit choice tied to a task intent.
- [ ] Show overlapping file scopes and current ownership as advisory information, with a clear handoff/resolve route.
- [ ] Integrate the approved native Git/task tool with the active project and preserve normal Git operations.

**Done demonstration:** Run two related tasks, detect overlapping work, review diffs and resolve or merge through a deliberate user action.

**Scope boundary:** Never silently switch branches, merge, push or create PRs.

### Task 19: Make every integrated tool discoverable and manageable

**Depends on:** 03, 04, 07, 15, 16, 23, 24, 25, 27, 28.

**Product deliverable:** Users can enable, configure, diagnose and remove the app’s integrations without editing hidden files.

**Research before implementation:** Research setup/doctor and resource-control patterns after actual integration requirements are known; reuse existing installers and platform facilities.

**Starting files:** `src/main/project-doctor.ts`, `src/shared/project-tool-downloads.json`, `src/renderer/src/components/settings/ProjectToolsSettings.tsx`, `src/renderer/src/components/ProjectSetupDialog.tsx`.

- [ ] Finish one catalog for all delivered tools with honest installed/connected/disabled states and real configuration routes.
- [ ] Show actionable missing-runtime/model/permission/version errors, download sizes and relevant resource use.
- [ ] Provide project-level stop, pause, remove and reconnect actions without deleting authoritative knowledge or unrelated installations.

**Done demonstration:** Set up a fresh project, enable a memory engine and remote target, resolve a configuration failure and disable their background work from the app.

**Scope boundary:** A catalog row pointing to an unfinished prototype does not count as an integration.

### Task 20: Make projects portable and recoverable

**Depends on:** 09, 10, 11, 12, 18, 19, 23, 24, 25, 27, 28.

**Product deliverable:** Users can move or restore a project’s useful knowledge and workspace configuration without copying machine secrets.

**Research before implementation:** Review portable project formats, incremental backup and migration practices; prefer native archives and existing manifest handling.

**Starting files:** `src/main/project-export.ts`, `src/shared/project-export.ts`, `src/renderer/src/components/settings/ProjectKitSettings.tsx`.

- [ ] Extend the project kit to include authoritative memory/history, tasks, handoffs, workflows and portable integration settings.
- [ ] Declare which derived indexes can be rebuilt and which learned-memory data needs export; preserve provenance and deletion semantics.
- [ ] Provide preview, collision handling and restore/reconnect instructions with credentials omitted.

**Done demonstration:** Export a project and restore it into a fresh profile/location; retrieve its facts and reconnect tools without leaking credentials or overwriting another project.

**Scope boundary:** No opaque VM/profile dump as the only portability story.

### Task 21: Remove daily-use friction and bottlenecks

**Depends on:** 20, 29.

**Product deliverable:** The integrated app feels responsive and stays usable under real multi-agent work.

**Research before implementation:** Research remedies for the bottlenecks actually observed in the integrated product, including terminal rendering, indexing contention and keyboard focus.

**Starting files:** `src/renderer/src/components/TerminalPane.tsx`, `src/renderer/src/components/Workbench.tsx`, `src/main/project-tools.ts`, `src/renderer/src/main.css`.

- [ ] Profile the real slow or awkward journeys and rank them by user impact.
- [ ] Fix foreground latency, unnecessary background work, focus loss and unreadable/overcrowded states in their shared owning paths.
- [ ] Keep one meaningful before/after demonstration per fix; defer VoiceOver and additional-language qualification as requested.

**Done demonstration:** Use multiple native agents alongside retrieval, editor and browser; typing, switching and cancellation remain responsive with visible resource controls.

**Scope boundary:** Renamed from qualification: this is a product optimization task. Passing old tests or producing benchmark charts alone cannot complete it.

### Task 22: Deliver the finished installable application

**Depends on:** 21.

**Product deliverable:** The user can install, update and recover the final integrated app with its tools and project data intact.

**Research before implementation:** Review current packaging/update support for the selected host, component redistribution and native tool delivery before changing release paths.

**Starting files:** `build/electron-builder.json`, `scripts/check-package.mjs`, `src/main/project-export.ts`, `package.json`.

- [ ] Implement or update the selected host’s package/update path and complete component notices and tool delivery routes.
- [ ] Produce the final local artifact after GUI and performance work, including migration/recovery support.
- [ ] Demonstrate installation and one representative complete project workflow; report signing/notarization status accurately.

**Done demonstration:** Install the candidate into an isolated location, open an existing project, use agents and shared memory, update and recover without losing that project.

**Scope boundary:** No publication, automatic replacement of the user’s running installation, PR or push. Existing unsigned or intermediate artifacts are not the final deliverable.

### Task 23: Integrate analytics and richer project memory

**Depends on:** 03, 09, 10, 11, 12, 13, 27.

**Product deliverable:** Users and agents can inspect project activity, recall learned context and query relationships over time.

**Research before implementation:** Freshly compare DuckDB, Hindsight, Graphiti and alternative graph backends on the requested roles. Revisit corrected configurations and licensing boundaries; prior non-selection is not cancellation.

**Starting files:** `src/main/project-analytics.ts`, `src/main/project-memory.ts`, `src/main/project-tools.ts`, `src/main/project-document-index.ts`, `src/renderer/src/components/ProjectAnalytics.tsx`, `src/renderer/src/components/ProjectMemoryPanel.tsx`.

- [ ] 23A: Integrate DuckDB analytics through the existing export/read route where possible; preserve source freshness/deletion and expose useful session/activity queries without a redundant authoritative store.
- [ ] 23B: Integrate Hindsight retain/recall/reflect with project scope, source attribution, visible learned versus confirmed information and explicit promotion/correction controls.
- [ ] 23C: Integrate Graphiti temporal relationships using an approved backend; support source-backed relationship/as-of queries, updates and deletion. Evaluate alternatives where the tested backend is unsuitable.
- [ ] 23D: Connect these capabilities to native agents and the knowledge UI; make indexing/projection lag, resource cost and engine disable/rebuild behavior understandable.

**Done demonstration:** Ask what changed in a project decision and why, inspect its dated sources and relationships, correct/delete it, and observe the correction across recall and graph views; use real project activity analytics.

**Scope boundary:** 23A–D are separately reviewable implementation slices. None completes the whole task alone. Do not ship duplicate truth stores, expose private reasoning, or relabel a standalone service demo as integration.

### Task 24: Integrate isolated desktops and remote work

**Depends on:** 04, 16, 18.

**Product deliverable:** Users can send project work into a Lume desktop or SSH workspace and bring reviewed results back.

**Research before implementation:** Research current Lume releases, VM control and clipboard/mount behavior; compare SSH runtime approaches and credible isolation alternatives.

**Starting files:** `src/main/project-tools.ts`, `src/main/project-computer-tools.ts`, `src/main/project-export.ts`, `src/renderer/src/components/ComputerControlPanel.tsx`.

- [ ] 24A: Add a usable Lume module with selected project mounts, explicit write boundaries, desktop/control connection, clipboard behavior and start/stop/recovery.
- [ ] 24B: Add SSH workspace configuration with verified host identity, project/runtime compatibility and remote terminal/tool ownership.
- [ ] 24C: Implement disconnect/reconnect without replaying uncertain writes, and reviewable artifact/diff return to the local project.

**Done demonstration:** Launch an agent in an isolated or remote project, disconnect and reconnect, inspect its output and import selected results while a second project stays unaffected.

**Scope boundary:** 24A–C all required. Do not expose the unrestricted local runtime socket remotely or use the user’s active VM as a disposable fixture.

### Task 25: Improve building applications in the editor

**Depends on:** 06, 12, 17, 18.

**Product deliverable:** Users get useful language intelligence and repeatable project workflows that agents can share.

**Research before implementation:** Compare existing Monaco workers, maintained language servers and workflow/skill formats against the languages and project types selected for the task.

**Starting files:** `src/renderer/src/components/EditorPane.tsx`, `src/renderer/src/language-diagnostics.ts`, `src/main/project-creation.ts`, `src/shared/project-creation.ts`.

- [ ] Improve diagnostics, definition/reference navigation and worker recovery through the selected language integration; label supported languages.
- [ ] Connect declared project run/test/build commands to the editor and agents without inventing commands.
- [ ] Offer reviewable reusable workflow/skill bundles during project setup, preserving user-authored instructions and source files.

**Done demonstration:** Create or open a project, navigate a definition, fix a diagnostic, run the app and reuse its workflow with another native agent.

**Scope boundary:** Do not write a new language server or scatter provider-specific workflow copies into every project.

### Task 26: Choose and establish the stronger desktop host

**Depends on:** 01.

**Product deliverable:** The project has an approved, usable host/terminal integration direction before more expensive UI and platform work.

**Research before implementation:** Compare the current Electron host against Tauri/native Ghostty and maintained alternatives, including a corrected Electrobun route if credible. Inspect actual native embedding and browser/PTY ownership, not screenshots or empty-shell metrics.

**Starting files:** `src/main/index.ts`, `src/main/terminal-daemon.ts`, `src/main/browser-views.ts`, `src/renderer/src/components/TerminalPane.tsx`, `src/renderer/src/components/Workbench.tsx`, `build/electron-builder.json`.

- [x] 26A: Bring a concrete recommendation to the user using a representative integrated slice: native agent, editor draft, browser, shared memory and reconnect. Define migration scope and full dependency rights.
- [x] 26B: If migration is approved, integrate the chosen host/native terminal with the existing project/process boundaries and port the actual required workflows before retiring the old path.
- [x] Under continuous execution authorization, retain Electron and deliver selectable native Ghostty with the existing daemon. See `docs/architecture/second-pass-26/decision.md`; no wholesale host replacement or user-app replacement.

**Done demonstration:** The chosen host runs a real native agent with shared knowledge, preserves an unsaved editor and browser state, and reconnects correctly. Native Ghostty has usable search/input/resize integration if adopted.

**Scope boundary:** This moves earlier by explicit proposed sequencing, not by silently reviving Task02. No wholesale rewrite before the user approves the recommendation. Failed empty-host trials do not cancel requested capabilities.

### Task 27: Make native session history useful across agents

**Depends on:** 03, 04, 07, 13.

**Product deliverable:** Users can find earlier agent work, inspect its sources and resume the correct native session where supported.

**Research before implementation:** Compare AgentsView and current native-history formats/adapters, including parent-session provenance and exact resume identity.

**Starting files:** `src/main/project-session-history.ts`, `src/shared/project-session-history.ts`, `src/renderer/src/components/ProjectSearch.tsx`.

- [ ] Integrate project-scoped history discovery and Sessions search with native agent/source attribution.
- [ ] Keep imported transcripts read-only, distinguish helpers/subagents and reject ambiguous resume mappings.
- [ ] Offer supported resume or an explicit handoff route; allow reviewed facts from history to enter durable memory.

**Done demonstration:** Find prior work from two agents, open its actual session context and resume the intended agent without selecting a helper or another project.

**Scope boundary:** History is not automatically authoritative memory, and a matching title is not enough to resume a session.

### Task 28: Integrate ACP and additional agent adapters

**Depends on:** 04, 07, 08, 10, 17.

**Product deliverable:** Users can choose native terminal operation or an explicit structured ACP session with working permissions and cancellation.

**Research before implementation:** Inspect current ACP implementations, OpenCode and other maintained adapters for session ownership, resume, capabilities and provider compatibility.

**Starting files:** `src/main/agent-runtime.ts`, `src/shared/agent-runtime.ts`, `src/main/project-tools.ts`, `src/renderer/src/components/runs/AgentsSection.tsx`, `src/main/agent-hook.ts`.

- [ ] Implement ACP as a visible session mode with project-scoped tool access and honest negotiated capabilities.
- [ ] Expose structured prompt/result, permission, cancellation and error handling without silently starting a second owner beside the TUI.
- [ ] Implement supported native/ACP ownership transitions and additional adapters through the existing registry; preserve arbitrary CLI support.

**Done demonstration:** Run an ACP-backed task, approve/deny a permission, cancel safely and resume the intended session in a supported mode without duplicate execution.

**Scope boundary:** A CLI protocol demo, status plugin or hidden second agent is not the requested ACP integration.

### Task 29: Refine the complete GUI around the integrated product

**Depends on:** 05, 06, 07, 08, 10, 13, 14, 15, 16, 17, 18, 19, 20, 23, 24, 25, 26, 27, 28.

**Product deliverable:** The full app feels like one ergonomic terminal-first workspace, with its own visual identity and discoverable capabilities.

**Research before implementation:** Research interaction precedents around the actual delivered workflows; audit their information architecture and compare concrete layout options before selecting the final design.

**Starting files:** `src/renderer/src/components/Workbench.tsx`, `src/renderer/src/components/RightSidebar.tsx`, `src/renderer/src/components/workspace-shell.css`, `src/renderer/src/main.css`, `src/renderer/src/commands.ts`.

- [ ] Present an integrated GUI proposal showing normal coding, shared knowledge, browser/control, local/remote environments and interrupted work; obtain visual approval.
- [ ] Consolidate navigation and duplicate controls, establish progressive disclosure, and keep terminal interaction central on small and large windows.
- [ ] Polish keyboard/focus routes, density, typography, resizing, status/error/recovery states and consistent #16161D theming across the delivered modules.
- [ ] Remove superseded GUI paths once their required workflows exist in the approved replacement.

**Done demonstration:** Walk from opening a project through multi-agent work, handoff, retrieval, browser/remote work and reviewing a built app without hunting through disconnected panels.

**Scope boundary:** No new feature expansion here, no Orca clone, no ornamental dashboard and no stacked headers consuming terminal space. GUI approval concerns the actual integrated design, not a static mockup alone.

## Selection and integration record for each task

Use one concise record alongside its implementation proposal: user problem; incumbent strengths/limits; credible alternatives including an outside-list candidate when relevant; primary source links and source/release pins; exact licensing/dependency boundary; installation/runtime/model requirements; recommendation; planned changes; data migration/uninstall/recovery; and the one representative user flow. Rank candidates by required capability, user experience, correctness/recovery, integration ownership, maintenance and deployment/resource cost. Stars and README benchmarks are discovery signals, not selection criteria.

A useful existing component can remain, but the card must explain what product improvement is delivered around it. A requested integration can be disabled by default to manage resources; that is different from leaving it unimplemented. Do not run DuckDB, Hindsight and Graphiti as mandatory background services merely because all are available.

## Scope and completion audit

- Native multi-agent use and switching: Tasks07/08/10/28.
- Project knowledge shared across agents: Tasks03/09/10/11/12/13/23/27.
- Building applications rather than chatting: Tasks14/15/16/17/18/25.
- Explicit requested additions: DuckDB/Hindsight/Graphiti and alternative graph backends in03/12/23; Lume/SSH in24; ACP in28; Tauri/native Ghostty in26.
- Coherent GUI and ergonomics: initial usable shell05/06, module-specific interaction in each task, final integrated refinement29, actual friction fixes21.
- Portability and installable delivery: Tasks19/20/22 after integrations.
- Task02 remains skipped. Historical checked tasks do not carry completion into this pass.
- Research-only choices are approval gates within tasks; they do not substitute for the product deliverables.

**Authorization update:** the user approved executing the plan continuously. Scoped implementation, research, necessary checks and local commits are authorized. Material scope changes, destructive actions and external publication remain separate decisions.

## Task01 completion

Delivered a narrow MIT search-addon patch invalidating cached lines on parsed writes. The current TUI text is searchable and overwritten text is absent; same process retained, one recovery cycle, deliberate owner-loss behavior and owned cleanup pass. [Focused result](../../research/second-pass/task-01-search-fix.json). No new runtime dependency or terminal replacement. Earlier baseline-only work does not count as this deliverable.

## Carry-forward findings from Task26

- Task08: layout persistence currently debounces for 400 ms. A crash immediately after opening a browser can lose that new location; native recovery evidence waits for the actual saved layout and does not claim immediate durability.
- Task21/29: qualify native physical keyboard, pointer/selection, narrow search layout and Metal visuals on the unlocked desktop. The locked-session AppKit event check does not cover these.
