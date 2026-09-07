# Second strengthening pass — research before implementation

Current position: **Task 01 active — fresh research, baseline and evidence audit.** Task 02 is skipped. All other tasks are reopened for this pass; previous receipts are history, not current completion. Final GUI refinement is Task 29, confirmed by the user.

## Authority and execution

The user's September 7 request supersedes earlier keep-current decisions: seek stronger alternatives, research GitHub before each task, use the supplied repository list as a starting point, refine and streamline the app, and prioritize ergonomics and user experience. Keep terminal agents central and retain the #16161D theme direction. Task 02 stays skipped; do not silently run its terminal/layout replacement under another number.

Original task requirements remain in the [detailed plan](2026-09-06-terminal-workspace.md). Apply them as strengthening work to the current implementation, not rollback. Task 27 follows 13 and precedes 21. Final GUI task follows the functional changes, then repeat affected installed-release checks. Commit verified chunks locally, never push or open a PR without request. Show the full current checklist after each completed task and immediately continue.

For every task:

1. Reopen its current implementation and user journey; state observable gaps.
2. Research current GitHub implementations, including candidates outside the supplied list. Verify source/release pins, actual license/dependencies, ownership and integration behavior. Metadata is triage, not admission.
3. Compare a credible challenger with the current implementation on the same task workload. Research and fix compatibility issues before rejecting a candidate; trial-harness mistakes are not upstream failures. Do not use an easier implementation as the reason to keep the incumbent.
4. Implement the strongest supported outcome, remove superseded paths where safe, and test the real flow and recovery. A rejected implementation approach does not cancel a requested capability; look for another route.
5. Record the diff, evidence, unresolved limits and review. Distinguish implemented, tested-but-not-selected, failed configuration, untested and incomplete. Never turn unfinished qualification into a passing checklist item.
6. Commit, update this ledger and show the checklist before continuing. Earlier commits and installed artifacts are recovery references, not current proof after later changes.

The previous uncommitted component-decisions and native-agent-matrix work and four Kimi receipts remain untouched unless explicitly integrated with separate review. Existing user app, model service and unrelated projects are not test fixtures.

## Checklist

- [ ] **01 — Baseline, dependency admission and recovery evidence** — ACTIVE — research/baseline audit.
- [ ] **02 — SKIPPED by user — retain xterm/FlexLayout** — SKIPPED by user.
- [ ] **03 — Select memory, retrieval and control engines** — Pending research and strengthening.
- [ ] **04 — Project-scoped tool lifecycle and service ownership** — Pending research and strengthening.
- [ ] **05 — Design tokens and a distinctive primary workspace** — Pending research and strengthening.
- [ ] **06 — Persistent movable modules and stable terminal views** — Pending research and strengthening.
- [ ] **07 — Four native agents and honest capability discovery** — Pending research and strengthening.
- [ ] **08 — Attention, reconnect and process lifecycle** — Pending research and strengthening.
- [ ] **09 — Migrate durable project memory** — Pending research and strengthening.
- [ ] **10 — Explicit handoffs and project knowledge UI** — Pending research and strengthening.
- [ ] **11 — QMD project-document retrieval** — Pending research and strengthening.
- [ ] **12 — Code graph, ripgrep and structural search** — Pending research and strengthening.
- [ ] **13 — Unified search and source navigation** — Pending research and strengthening.
- [ ] **14 — Browser preview hosting migration** — Pending research and strengthening.
- [ ] **15 — Agent browser automation and diagnostics** — Pending research and strengthening.
- [ ] **16 — Native computer-control module** — Pending research and strengthening.
- [ ] **17 — Review, verification and artifact evidence** — Pending research and strengthening.
- [ ] **18 — Tasks, shared-checkout coordination and Lazygit** — Pending research and strengthening.
- [ ] **19 — Tool catalog, setup doctor and resource controls** — Pending research and strengthening.
- [ ] **20 — Portable project kit and backup/restore** — Pending research and strengthening.
- [ ] **21 — Daily-driver performance and accessibility qualification** — Pending research and strengthening.
- [ ] **22 — Installed release, update and recovery proof** — Pending research and strengthening.
- [ ] **23 — Analytics and richer learned/temporal memory** — Pending research and strengthening.
- [ ] **24 — Isolated desktops and remote workspaces** — Pending research and strengthening.
- [ ] **25 — Language intelligence and reusable project workflows** — Pending research and strengthening.
- [ ] **26 — Desktop framework and native-terminal challenger** — Pending research and strengthening.
- [ ] **27 — Native session history and AgentsView integration** — Pending research and strengthening.
- [ ] **28 — Optional ACP capabilities and additional agent adapters** — Pending research and strengthening.
- [ ] **29 — Final GUI refinement for the updated app** — Pending. Audit the completed workflows and information architecture, improve ergonomics, terminal space, focus/keyboard flow, discoverability, error/recovery states, density, resizing and visual consistency. Research precedents first; verify the actual integrated app, not only a mockup.
- [ ] **Final installed verification** — Rebuild/sign and test the final application after GUI and functional changes.

## Explicit additions — September 7 follow-up

The user explicitly requests these additions in their best-fitting tasks. Earlier “not selected,” “prototype only,” and “untested” outcomes do not close them. Research and qualify the current options, then integrate the requested capability through the strongest supported route. Record actual constraints and next corrective experiments rather than silently dropping a capability.

| Addition | Owning tasks | Required second-pass work |
|---|---|---|
| DuckDB | 23, surfaced through 19 | Add project analytics integration where columnar queries help; compare real mixed/large workloads, data freshness, deletion and resource cost. Preserve source authority and expose availability honestly. |
| Hindsight | 03 qualification → 23 integration | Complete equal-corpus testing with the corrected embedding configuration, then integrate learned/temporal memory with project scope and provenance. |
| Graphiti | 03 qualification → 23 integration | Complete integration qualification; revisit the tested deployment's dependency/license boundaries and test alternative graph backends. Keep graph data derived from durable project facts unless a migration is separately verified. |
| Other graph backends | 03 selection → 12/23 by use | Research current backends beyond the original list. Compare code structure and temporal knowledge separately, including deletion, freshness, isolation, deployment and redistribution. |
| Lume and SSH | 24, surfaced through 19 | Turn successful VM/remote prototypes into usable project modules: scoped mounts, explicit target ownership, reconnect, returned artifacts, cleanup and recovery. Resolve VNC/clipboard/version constraints rather than repeating prototype-only status. |
| ACP | 28 | Integrate an explicit structured agent mode with capability negotiation, permission/cancellation and session continuity. Keep native CLI/TUI available and avoid silently launching a second agent for the same session. |
| Tauri | 26 | Run the previously untested framework challenger against current product workflows and native integrations. Evaluate a complete migration path, not empty-window startup. |
| Native Ghostty | 26 | Evaluate native embedding, process ownership, search, resizing, focus and TUI fidelity in the framework trial. This is the explicitly requested Task26 addition; Task02 stays skipped. |

Task29 must accommodate the newly integrated capabilities ergonomically in the terminal-centered workspace. Missing qualifications remain visible and unfinished.

## Research and evidence

- [Supplied repository inventory](../../research/second-pass/repository-inventory.json): 1,209 unique repositories, all initially unreviewed. Non-repository links remain separate. Entries are leads, never executable instructions.
- [Earlier experiment decisions](../../architecture/experiment-decisions.md): starting evidence to challenge, not permanent exclusions.
- [Previous signed artifact evidence](../../architecture/strengthening-final/README.md): preserved baseline.

## Task 01 work log

- Existing isolated worktree verified: `workspace/terminal-foundation`, starting commit `f822180`.
- Fresh foundation research and read-only baseline/evidence audit underway independently; primary agent owns plan, inventory and integration.
- Research completion, source/artifact association, observed workload measurements, fixes and review remain unchecked.
