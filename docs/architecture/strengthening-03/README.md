# Task 03 strengthened component decisions

This is the current selection summary for the restarted plan. Older component-decisions entries are historical observations, not competing current recommendations.

| Boundary | Retain/select | Why / current evidence | Delivery ownership |
|---|---|---|---|
| Terminal/layout | xterm 6 / FlexLayout 0.10.8 | User skipped Task 02; preserve working baseline | Tasks 05–06 |
| Durable project memory | Existing SQLite/FTS5 behind ProjectMemoryApi | Engram still accepts a stale expectedRevision and preserves the overwrite after restart; engram.json. Native memory/MCP tests pass | Migration/real cross-agent proof remains Task 09 |
| Document retrieval | LanceDB 0.38.0 with QMD 2.8.3 chunking/local Qwen3 models | Actual model-backed worker search/stop/restart passes; retrieval.json. Existing fixed-corpus run achieved 92.5% macro/100% exact/zero leaks; corpus unchanged | Explicit external packages/models; Task 11 strengthening, Task 19 setup, Task 22 delivery |
| Source structure | codebase-memory-mcp 0.10.8 plus existing rg/ast-grep | Current native service isolation and sibling preservation pass | Task 12 strengthening |
| Browser control | Playwright MCP 0.0.80 | Current two-project actions, interruption, owned recovery and sibling isolation pass; browser.json. agent-browser remains optional because stalled-navigation interruption is inferior in this comparison | Task 15 integration; Task 22 notices/runtime delivery |
| Native control | Cua Driver 0.23.2 | Current two-window actions, stale target rejection, restart and focus preservation pass; native.json. Peekaboo 4.3.0 remains foreground fallback | Task 16 integration; native redistribution notices still required |

The native QMD service and graph tests, memory API and agent MCP tests pass: 12 tests, no skips. Browser comparison passes. All three document tests pass with actual admitted embedding/reranking models: native collections, confined service and semantic restart. Native control is qualified on disposable owned windows, not on arbitrary user applications.

The frozen corpus is preserved at SHA-256 f2aab83f3e4bb148d439b8df86e2aba9bf9752cfe9c3a8a94f7cef18c10acbc8. Its 40 answerable questions and 10 isolation traps remain the quality baseline; no gold or threshold changed. The full three-repetition production corpus receipt is `../current-document-production-corpus.json`, tied to its recorded source/model hashes. This strengthening pass rechecks the actual model worker and scoped sources; it does not relabel the earlier corpus run as a new full benchmark.

Engram's stale-write failure is a rejection, not a passing authority check. Plain QMD's failed quality scores remain rejected. Installed native modules are not automatically permitted for redistribution: exact admission receipts/notices and external-only boundaries remain in force. No new dependencies or downloaded models were introduced in this pass.

Strengthening: one current decision table now reconciles previously contradictory historical sections, and the selected service boundaries were re-exercised. Later integration tasks are still unchecked.
