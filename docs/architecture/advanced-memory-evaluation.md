# Task 23 — analytics and richer memory evaluation

Status: in progress. No richer memory engine has been admitted. Production dependencies are unchanged.

## Analytics decision

Retain SQLite for the measured project-history workload. AgentsView 0.42.0 already provides a native DuckDB export; a second app-maintained mirror is unnecessary.

The read-only comparison used 50 actual OMP sessions and 5,693 messages, copied into a private archive from project research and native-agent acceptance sessions. The runner alternates engines for 101 executions of each query and checks identical results and unchanged database hashes. This is a measured small-project workload, not a large-scale extrapolation.

| Query | SQLite warm p95 | DuckDB warm p95 |
| --- | ---: | ---: |
| Sessions by day | 0.034 ms | 0.641 ms |
| Tokens by model | 3.320 ms | 2.200 ms |
| Cost coverage | 0.006 ms | 0.157 ms |
| Native outcome signals | 0.022 ms | 0.425 ms |
| Context coverage | 0.016 ms | 0.427 ms |

The SQLite archive occupies 25,178,112 bytes; the DuckDB mirror occupies 29,634,560 bytes and took 3.547 seconds to export. The mirror omits `source_missing_at`, so it cannot replace current-source validation. Every source was present in this particular comparison.

There are no billed-cost events in the archive. Missing billing data must appear as unavailable, never zero dollars. Parser outcome signals are not verified test results. Context tokens are not CPU or RAM samples. App analytics must use its existing verification records for test outcomes and expose measurement coverage.

Reproduce with `tests/acceptance/history-analytics-benchmark.py --sqlite <snapshot>/sessions.db --duckdb <snapshot>/sessions.duckdb --output <new-receipt.json>` using Python with DuckDB 1.5.5. The complete measured receipt is [history-analytics.json](strengthening-23/history-analytics.json). Raw transcripts stay outside the repository.

### Implemented analytics

Sessions search now includes a collapsed **Usage and outcomes** disclosure. It reads the existing SQLite archive in a read-only transaction, validates native source size/mtime and project membership before and after aggregation, and reports day/agent token coverage plus recorded cost status/source. It checks at most 1,000 recent eligible records and explicitly reports truncation and rejected sources. Verification outcomes come from the existing source-aware verification API (latest 20); native parser completion labels are not promoted to test success.

The same scoped read is available through `history-analytics` / `history.analytics`. No extra service, mirror, or dependency is required. Analytics do not include unrecorded resource samples or inferred provider prices.

The built Electron app indexed two real project sessions, displayed their 37,001 output tokens and 86,020 peak context, and exposed missing billing events as unavailable. Keyboard disclosure and refresh passed, followed by graceful app/daemon shutdown. [Runtime receipt](strengthening-23/analytics-ui.json) and [rendered sidepanel](strengthening-23/analytics-ui.png) identify this build; these are not qualification of a newly packaged release. Full tests: 474 passed, 12 intentionally skipped; typecheck and build passed. The focused analytics test covers foreign/stale sources, quoted native IDs, real zero versus absent costs, and unchanged archive bytes.

## Candidate trials

Pinned source commits are recorded in [candidate-versions.json](strengthening-23/candidate-versions.json): Hindsight v0.9.2, Graphiti core 0.30.1 from mcp-v1.1.0, and LightRAG v1.5.7. They run in a separate research virtual environment, with private storage and local oMLX Ornith-1.5-35B-A3B-MLX-8bit. The trial bridge reuses the admitted QMD embedding and reranking models. It records actual LLM usage without storing prompts or answers in the receipt.

Hindsight's default pgvector HNSW index rejects the production embedding model's 2,560 dimensions. The failed startup is retained in [hindsight-2560-rejected.json](strengthening-23/hindsight-2560-rejected.json). A separate trial uses the same Qwen checkpoint truncated and normalized to 1,536 dimensions. That change must remain explicit when comparing scores; it is not a production embedding change.

One-document smoke checks establish compatibility only. They do not establish usefulness, project isolation, temporal correctness, or superiority over existing retrieval. The full comparison uses the existing 50 authored questions against source frozen at `3b3447dd1f65dbe3374a74efecf02c69fbe8168a`, plus separately authored temporal/correction/deletion cases. Admission remains pending those results and transitive license review.
