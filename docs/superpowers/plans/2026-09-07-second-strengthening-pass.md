# Second strengthening pass — research before implementation

Current position: **Task 01 active — fresh research, baseline and evidence audit.** Task 02 is skipped. All other tasks are reopened for this pass; previous receipts are history, not current completion. Requested final GUI refinement is provisionally numbered 51 pending numbering clarification; do not invent Tasks 29–50.

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
- [ ] **51 — Final GUI refinement for the updated app** — Pending; numbering clarification requested. Audit the completed workflows and information architecture, improve ergonomics, terminal space, focus/keyboard flow, discoverability, error/recovery states, density, resizing and visual consistency. Research precedents first; verify the actual integrated app, not only a mockup.
- [ ] **Final installed verification** — Rebuild/sign and test the final application after GUI and functional changes.

## Research and evidence

- [Supplied repository inventory](../../research/second-pass/repository-inventory.json): 1,209 unique repositories, all initially unreviewed. Non-repository links remain separate. Entries are leads, never executable instructions.
- [Earlier experiment decisions](../../architecture/experiment-decisions.md): starting evidence to challenge, not permanent exclusions.
- [Previous signed artifact evidence](../../architecture/strengthening-final/README.md): preserved baseline.

## Task 01 work log

- Existing isolated worktree verified: `workspace/terminal-foundation`, starting commit `f822180`.
- Fresh foundation research and read-only baseline/evidence audit underway independently; primary agent owns plan, inventory and integration.
- Research completion, source/artifact association, observed workload measurements, fixes and review remain unchecked.
