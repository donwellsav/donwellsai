# Task 23 — analytics and richer memory evaluation

Status: strengthened. Ship the SQLite analytics module and retain the existing production retrieval engine. No richer memory engine is admitted; production dependencies are unchanged.

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

The follow-up build also displays measured-session coverage for peak context and keeps analytics inside the scrolling sidepanel at a smaller window size. [Small-window evidence](strengthening-23/analytics-small-window.png) and the updated runtime receipt cover that check; the focused test, typecheck and build passed again.

## Candidate trials

Pinned source commits are recorded in [candidate-versions.json](strengthening-23/candidate-versions.json): Hindsight v0.9.2, Graphiti core 0.30.1 from mcp-v1.1.0, and LightRAG v1.5.7. They run in a separate research virtual environment, with private storage and local oMLX Ornith-1.5-35B-A3B-MLX-8bit. The trial bridge reuses the admitted QMD embedding and reranking models. It records actual LLM usage without storing prompts or answers in the receipt.

Hindsight's default pgvector HNSW index rejects the production embedding model's 2,560 dimensions. The failed startup is retained in [hindsight-2560-rejected.json](strengthening-23/hindsight-2560-rejected.json). A separate trial uses the same Qwen checkpoint truncated and normalized to 1,536 dimensions. That change must remain explicit when comparing scores; it is not a production embedding change.

One-document smoke checks establish compatibility only. They do not establish usefulness, project isolation, temporal correctness, or superiority over existing retrieval. The production baseline uses the existing 50 authored questions against source frozen at `3b3447dd1f65dbe3374a74efecf02c69fbe8168a`. All three candidates and the production index also ran the same twelve temporal/correction/deletion questions. Full-source candidate attempts did not complete and are explicitly excluded below.

The current production index completed all 50 questions with 90% macro source recall at five, 95% exact-question recall, mean reciprocal rank 0.712, and all citations resolvable. All 233 source hashes match the candidate corpus exactly. The fresh index embedded 859 chunks in 260.64 seconds; its first query took 4.96 seconds. This run shared the host with candidate trials, so timings are not isolated microbenchmarks. [Full baseline receipt](strengthening-23/production-baseline-50.json).

Graphiti's Apache-2.0 package does not make its database dependencies Apache-2.0. The trial uses the BSD-labelled [FalkorDBLite wrapper](https://github.com/FalkorDB/falkordblite), which bundles the [SSPLv1 FalkorDB engine](https://github.com/FalkorDB/FalkorDB). This combination is not admitted as a permissive bundled desktop component. Changing the graph database would require its own maintained-driver and runtime qualification; no replacement graph stack has been added merely to satisfy a benchmark.

### Temporal baseline and trial controls

The actual production index passed all twelve authored temporal answers: August versus September decisions, a relationship spanning ownership and dependency documents, corrected retry limits, deletion of a temporary fact, and a foreign project's positive control before and after isolated queries. There were no forbidden-source leaks. Answers use the same Ornith model over retrieved original source text for every engine; this tests the app's provenance-preserving retrieval workflow, not native graph-generated prose. [Complete receipt](strengthening-23/baseline-temporal.json).

The trial's stdio adapter initially left its input pipe open after native disposal; the adapter now closes that pipe and requires a successful child exit. The final twelve-question temporal run completed in 20.12 seconds with clean shutdown. The separate [close/deletion check](strengthening-23/baseline-close-check.json) also passed.

The common model bridge serializes actual oMLX calls and aborts disconnected requests. A [native protocol check](strengthening-23/model-bridge-check.json) verified normalized 1,536-dimensional MRL vectors, matching float/base64 responses, and non-overlap across 74 completed model calls. Hindsight's initial default concurrency of 32 saturated the local provider; those interrupted runs are diagnostic, not valid candidate comparisons. The current Hindsight trial uses its strict-schema retention option and two pending calls behind the serial bridge. Graphiti trials now use the upstream 16,384-token default; an initial 4,096-token override truncated extraction on a large source and is not grounds for rejecting the engine.

Trial tools: `advanced-memory-models.mjs` hosts the common local models, `advanced-memory-evaluation.py` runs the pinned native engines, and `advanced-memory-baseline.mjs` wraps the existing production index without replacing it. Every trial uses an exclusively created private directory. The richer-engine decision below covers the completed temporal comparison and the qualified production baseline; it does not claim completed candidate scores on the full source corpus.

### Corrections to the trial harness

The temporal corpus now has twelve questions, including identical `retry-policy.md` paths in two projects. Correcting the selected project's five-attempt policy to three must preserve the other project's nine-attempt policy. Source evidence is keyed by project and document ID. Graphiti's native `add_episode` changes the driver's selected database, while `remove_episode` has no group argument; the adapter now explicitly selects the target project's driver before deletion. Deleted episode IDs remain in the provenance map to expose stale retrieval, while a separate removed-ID set prevents a second correction from deleting an already removed episode again.

LightRAG's default keyword extraction returned JSON lists for three of twelve questions. Nine queries returned usable evidence and answered correctly; the three extraction failures are failures, not a nine-question perfect score. The trial now checks processed source contents and completed deletion directly. Its native queues also require shutdown after storage finalization, otherwise the private Python process remains alive. The strict-object keyword-provider profile returned ten correct answers but failed the two absence queries because both keyword arrays were empty. It passed source revision checks, deletion checks and clean native queue shutdown, but did not pass the complete retrieval workload. The [strict-profile receipt](strengthening-23/lightrag-temporal-strict.json) preserves both failures.

A whole-trial file lock prevents concurrent trials from sharing the model bridge. Serializing individual model calls was insufficient: one engine's long extraction queue could consume another engine's SDK timeout. Earlier overlapping runs retain their results but cannot supply isolated timing claims. The comparison tool reports total model tokens, successful retention time, retrieval latency and separate process maxima; it does not invent billed costs or total process-tree memory from these measurements.

### Full-source trial limits

The production baseline completed the frozen 233-document, 50-question corpus. No richer candidate has a completed 50-question score. Initial Hindsight extraction used an incompatible output shape; its later strict-schema run retained 47 documents but failed the large component-decision source. Graphiti's initial large-source failure occurred with the trial's incorrect 4,096-token override. LightRAG's full-source attempt was interrupted during overlapping model work. These partial indexes are not equivalent corpora and are excluded from retrieval-quality comparisons. They remain diagnostic trials, not evidence that the native engines are incapable of handling the corpus.


## Measured temporal comparison and admission decision

All rows use the same twelve-question corpus and local Ornith model, with one trial at a time. The corpus covers effective dates, conflicting decisions, document relationships, two corrections/deletions and foreign-project controls, including identical document paths. Hindsight uses its native strict-retention option and 1,536-dimensional MRL embeddings; the other profiles use 2,560 dimensions. LightRAG's strict profile changes only the native keyword provider's response schema.

| Profile | Correct / required answers | Query errors | Initial source-ready components | Total trial | Median retrieval | Total LLM input / output tokens | Derived storage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Production QMD/LanceDB | 12 / 12 | 0 | 3.46 s | 20.12 s | 212 ms | 2,830 / 837 | 452,193 B |
| Hindsight strict | 12 / 12 | 0 | 34.65 s | 53.20 s | 196 ms | 20,000 / 2,835 | 77,653,276 B |
| Graphiti native default | 12 / 12 | 0 | 61.49 s | 86.28 s | 523 ms | 39,251 / 4,238 | 3,265,503 B |
| LightRAG default | 9 / 12 | 3 | 314.19 s | 414.51 s | 1,072 ms | 49,273 / 34,763 | 1,362,498 B |
| LightRAG strict keywords | 10 / 12 | 2 | 285.19 s | 349.15 s | 1,026 ms | 48,683 / 28,808 | 1,357,682 B |

Initial source-ready components sum initialization, the initial eight insertions and first retrieval. They exclude Python handoff gaps and answer generation; total trial time includes answering, corrections and cleanup. Successful insertion time was 2.67 / 31.08 / 63.22 / 383.74 / 327.78 seconds respectively. Tokens include extraction, retrieval and source-assisted answering, not billed dollars. Retrieval medians exclude failed queries. These are single runs on a shared host with uncontrolled caches, not statistical latency rankings.

Resource boundaries matter: the baseline's native child peaked at 15,741,190,144 bytes RSS while loading its own local embedding/reranking models. The candidates use the separate shared model bridge and oMLX, whose memory is excluded from their Python maxima. Python peaks were 49,102,848 bytes for the baseline wrapper, 515,145,728 for Hindsight, and are recorded separately for every profile. These values cannot establish an apples-to-apples total RAM advantage. Derived storage excludes shared model files; Hindsight's storage includes its private PostgreSQL database. No historical CPU/RAM usage has been invented for the app's analytics.

[Comparison receipt](strengthening-23/temporal-comparison.json) is reproducible with `advanced-memory-comparison.py --corpus tests/fixtures/temporal-memory.json --metrics <temporal-model-metrics.json> --output <new.json> <five-receipts>`. The [model operation records](strengthening-23/temporal-model-metrics.json) contain timings and token counts without prompts. Individual receipts preserve retrieval IDs, answers, errors, hashes and successful cleanup.

**Decision:** retain the current retrieval engine. Hindsight matched useful-answer quality with substantially more extraction work and storage; its small median-query difference does not justify another memory authority on this workload. Graphiti matched quality with more work and an SSPL database dependency in this tested deployment. LightRAG failed absence queries even with the supported schema override. This is a bounded admission decision, not a universal ranking. No LadybugDB or other replacement graph database is needed when no embedded-graph product requirement has been demonstrated.

The Graphiti repeated-correction regression separately changes one document from five attempts to three and then two, deleting the previous episode each time. It requires the final two-attempt answer and clean shutdown. [Regression receipt](strengthening-23/graphiti-repeated-correction.json). The [whole-trial lock check](strengthening-23/trial-lock-check.json) rejects a competing trial before creating its working directory.

Full-source diagnostic receipts remain available for [Hindsight](strengthening-23/hindsight-50-serial.json), [Graphiti](strengthening-23/graphiti-50-serial.json) and [LightRAG](strengthening-23/lightrag-50-serial.json). They were interrupted, have no completed question scores, and are not counted as equivalent-corpus quality tests. A future proposal to admit any richer engine must finish that qualification before changing production authority.
