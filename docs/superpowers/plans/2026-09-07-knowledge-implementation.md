# Knowledge implementation detail — Tasks 09–13, 20 and 23

Planning only. This document supplies implementation detail to the rebuilt 01–26 plan; it does not close tasks or authorize execution. Paths below are relative to `terminal-foundation`. Names marked **proposed** do not exist yet. Existing functions below were inspected in the current source; previous service trials are feasibility evidence, not delivered app integrations.

## Current implementation and specific gaps

| Owner | Inspected source and behavior | Gap to implement |
|---|---|---|
| 09 | `ProjectMemoryService` resolves every request to registered project identity; `ProjectMemoryApi` supports list/get/create/update/history/archive. `replaceSqliteMemoryEntry` uses a project-scoped revision CAS inside `BEGIN IMMEDIATE`. | Preserve these contracts. Add reconciliation UX and explicit erase semantics; archive is not erasure. Prevent derived engines from serving superseded or erased material. |
| 09 | `PROJECT_MEMORY_MAX_HISTORY_REVISIONS` is 32; JSON/SQLite migration, export and reverse already exist. `onChanged` notification carries the project, not a durable event. | Do not use that callback as a reliable projection queue. Preserve the documented history bound; display truncated history rather than promising an unlimited timeline. |
| 11 | `openProjectDocumentIndex.replace` hashes chunks, reuses embeddings and uses Lance `mergeInsert` with deletion of absent source rows. `search` distinguishes lexical/auto/required-hybrid. | Surface incremental work, cancellation and freshness through the app; preserve last published index on interrupted replacement and bind every citation to source revision. No rewrite of this functioning merge path without a demonstrated failure. |
| 12 | Existing code search, codebase-memory service and `ProjectGraph` already own structural lookup/navigation. | Add source-change/branch freshness and meaningful selected-symbol navigation. Do not route code relationships through Graphiti. |
| 13 | `ProjectSessionHistory` admits AgentsView 0.42.0 by checksum, filters native sources to registered scope and verifies size/mtime before returning them. OMP and DSH have exact resume mappings. | Hermes and Kimi are explicitly unavailable. `get` returns a five-message window, not a complete transcript. Source freshness does not establish parent/helper attribution. These remain actual integration work. |
| 23A | `aggregateSessionHistory` runs SQLite queries over current native session IDs. `analytics` validates at most 1,000 recent sources and returns truncation. | DuckDB is not integrated. Preserve this cheap summary while adding DuckDB for useful selected-project exploration; do not claim SQLite queries satisfy DuckDB. |
| 20 | Kit v1 contains memory, handoffs, selected text artifacts, layout and tool catalog state. Import regenerates memory IDs; sessions/caches are omitted. | Add explicit identity remapping, learned-memory preservation and portable workflow/integration sections. Existing behavior does not preserve cross-engine source identity. |
| 23B/C | Hindsight/Graphiti source and trial installations exist under `../research/tool-trials/advanced-memory-2026-09-07`; no product adapter owns them. | Build configuration, service ownership, durable projection, query/correction controls, native-agent tools and restore behavior. |

## Component decisions and admission boundaries

Keep SQLite/FTS5 as canonical fact authority. Engram is a credible alternative, but changing the authority must preserve revisions, CAS, attribution and migration; no current evidence justifies sacrificing those contracts. QMD 2.8.3/LanceDB 0.38.0 remain the document route unless the focused Task11 comparison demonstrates a relevant improvement. Never rerun an entire corpus solely because a panel changed.

Use DuckDB for derived analytics, Hindsight for learned recall/explicit reflection and Graphiti for temporal relationships. They are distinct features, not four interchangeable databases. Use installed trial resources before downloading more. Pins from the existing September7 research are starting selections, refreshed only for relevant API changes at implementation:

- DuckDB Python 1.5.5 is recorded in the resolved trial environment. Run it as a short-lived owned analytics worker, avoiding an additional Electron native addon/ABI dependency.
- Hindsight research pin `83ef402e85372875f11a94652e1395a50c743060`; MIT. Inspected Python client has retain/recall/reflect, document IDs, document deletion and document export. Bind to its HTTP service through one app-owned adapter; do not expose its unrestricted upstream API directly to agents. [Client source](https://github.com/vectorize-io/hindsight/blob/main/hindsight-clients/python/hindsight_client/hindsight_client.py).
- Graphiti research pin `b943c9e8486cdc7fe6cb2f4cfe151ae53f0a884d`; Apache2. Source has `add_episode(..., group_id, uuid)`, scoped search filters and `remove_episode`. Choose the supported Neo4j driver as the implementation route, using a separately configured local server rather than bundling an unreviewed server into the app. [Driver source](https://github.com/getzep/graphiti/blob/main/graphiti_core/driver/neo4j_driver.py).
- **Server admission still required:** record the exact Neo4j distribution/version, license and resource configuration before installation. Graphiti's license does not license Neo4j. The attempted direct 5.26 license URL did not resolve; this document does not invent a successful license verification. This is a narrow artifact-admission step, not a new architecture survey or permission gate. If that distribution cannot be admitted, evaluate Ladybug against the required Graphiti driver operations; do not silently substitute a deprecated Kuzu deployment or an SSPL FalkorDB binary.
- Ladybug MIT remains a backend challenger, not an established drop-in Graphiti driver. FalkorDB's server terms differ from Graphiti's Apache license. Prior Kuzu/Graphiti trial success is not a maintained backend decision.

The Graphiti source's `remove_episode` deletes an edge only when the removed episode is its first listed contributor, and deletes nodes mentioned by just one episode. That implementation alone cannot establish correct recomputation after deleting a contributing source. The design below therefore uses source gating immediately and generation rebuilding for corrections/deletions affecting inferred relationships.

**Historical rebuild requirement:** A replacement Graphiti generation includes retained, non-erased historical source revisions/episodes as well as current revisions. Current queries exclude superseded truth; as-of queries resolve the applicable retained revision and label the historical time basis. Erased content is excluded from both. If the canonical 32-revision retention bound has removed the requested history, report the unavailable interval instead of inventing or silently truncating an answer. A correction rebuild must preserve available as-of answers.

## Shared knowledge contract

### Authority, provenance and query semantics

Reuse `ProjectToolScope.projectKey` for shared project memory and `indexKey` for checkout source indexes. Never accept an agent-supplied bank/group/project key; resolve the bound workspace on every runtime call. Hindsight bank IDs and Graphiti group IDs are derived by the app from project identity plus projection generation.

Add **proposed** `src/shared/project-knowledge.ts` for these concrete request/result types only:

- `KnowledgeSourceRef`: `{ projectKey, kind: 'memory' | 'handoff' | 'document' | 'session', id, revision, sourceTime, checkoutKey?: string }`.
- `KnowledgeQuery`: `{ workspacePath, query, mode: 'learned' | 'relationships', asOf?: string, limit }`. `asOf` applies only to relationships; reject unsupported combinations.
- `KnowledgeResult`: source references, excerpt/relationship, `classification: 'learned' | 'confirmed'`, source validity, indexed time, engine generation, and partial/stale reason. Graphiti validity times describe inferred relationships; canonical revision time establishes what the app knew. Do not equate them.
- `KnowledgeProjectionStatus`: configured/enabled/running/error, desired/published generation, pending count, last successful publication and model/backend identification. Do not report CPU/token cost when unavailable.

Use existing runtime RPC, preload bridge, project service registration and MCP dispatcher. Proposed tool names are `knowledge_recall`, `knowledge_reflect`, `knowledge_relationships` and `knowledge_status`. `knowledge_reflect` is an explicit potentially model-consuming action, never triggered by typing or opening a pane. Raw upstream retain/delete/SQL/Cypher tools are not exposed. Agents create reviewed facts through existing memory APIs; raw transcripts never auto-promote.

### Projection reliability without a second authority

Add **proposed** `src/main/project-knowledge.ts` as the owner of reconciliation and upstream calls, plus **proposed** `src/main/project-knowledge-worker.py` for the Graphiti Python client and DuckDB operations. Reuse `ProjectTools` ownership/cancellation rather than creating another process manager. Use the existing scoped configuration to store executable/endpoint/model references; credentials use the existing secret mechanism and never enter receipts/kit exports.

Use a small derived SQLite manifest at the existing project-tool cache location, with two tables: `generations(project_key, engine, generation, state, source_digest, published_at)` and `sources(project_key, engine, generation, source_kind, source_id, source_revision, content_hash, remote_id, state, error)`. Unique source identity within a generation prevents duplicate scheduling. This manifest is disposable execution state, not another source of facts.

Do not rely on `onChanged` delivery. On start/reconnect and before publishing a generation, reconcile a scoped canonical snapshot against the manifest; notification only schedules a debounced reconciliation. A canonical commit may succeed while an engine is offline. A crash between commit and scheduling is recovered by the next scan. Read the full project document through an internal scoped snapshot method rather than repeatedly calling the public 200-result list limit. Preserve the 2,500-entry project bound and explicit retained-history limit.

Process one model-consuming job at a time by default across these optional integrations. Coalesce unprocessed source revisions; do not infer over every keystroke. Persist a successful upstream operation before moving the source row to completed. On uncertain response, reconcile deterministic remote identity before retrying. Fixed UUID input does not by itself prove upstream idempotence; the Graphiti adapter looks up/removes an unpublished partial episode before replaying it, or abandons that unpublished generation and resumes a fresh one.

Before returning recall/relationship results, resolve all claimed sources against canonical current/retained history. Unknown, deleted, foreign or untraceable references cannot support an answer. Mixed valid/invalid provenance requires removing the invalid claim, not merely hiding its citation. If a generated answer cannot be separated reliably, return unavailable/stale and offer source search instead. A current query cannot silently answer from an old generation after a correction. Historical `asOf` may return retained superseded evidence with explicit dates, but never erased evidence.

### Correction, archive, erase and rebuild

Archive keeps an auditable revision and removes the item from current recall. Restore creates the next revision. Correction retains prior history, but the old generation becomes ineligible for current answers until reconciled. For ordinary additions, project-scoped incremental retain/episodes can be used after the native operation is qualified. For corrections/archive/erase, build a fresh project generation from the permitted source snapshot, publish only after source digest is rechecked, then remove the superseded engine bank/group with the adapter's scoped operation. If source changes while building, coalesce and rebuild only affected work or abandon the unpublished generation; never publish the wrong snapshot.

Erasure is a new explicit user action, not a relabelled archive button. Proposed `projectMemoryErase({workspacePath,id,expectedRevision})` uses the same CAS/resolver, removes current/history and records only a non-content tombstone needed for derived cleanup. It must not be callable automatically as an incidental agent correction. Show that retained external backups cannot be silently rewritten; future exports exclude erased material. A derived cleanup failure means `erase pending in engine`, suppresses that engine's answers and remains visible until acknowledged. It does not prevent ordinary terminal work or falsely report remote deletion complete.

On disable, stop app-owned workers and suppress new requests immediately. Keep canonical data. Preserve an explicit choice to retain derived caches for restart or remove the app-owned project generation; never delete user-owned server databases. On enable, reconcile before claiming current. Engine failure leaves source memory, code search and terminals usable.

## Executable slices, ownership and acceptance

Each numbered slice is a commit boundary. Implement the owner contract and one representative app/native-agent journey; tests alone do not close it. Any newly created adapter check is proposed below, not an existing green result.

### 09A — correction and erasure through the existing authority

Files: `src/shared/project-memory.ts`, `src/main/project-memory.ts`, `project-memory-store.ts`, `project-memory-sqlite.ts`, `project-memory-migration.ts`, `ProjectMemoryEditor.tsx`, and existing CLI dispatch. Trace both JSON and SQLite writes before changing contracts. Preserve migration/reverse; do not migrate storage during render.

Implement conflict response with current revision and a compare/reapply path retaining the user's unsaved edit. Add erase/tombstone support only with matching persistence/migration/export handling. Bump the affected on-disk schema with transactional migration and a pre-migration backup; do not change `assertSchema` to accept versions whose structure was not migrated. Preserve stable IDs and provenance across JSON→SQLite migration.

Acceptance: two actual supported agents edit one fact from the same revision; one succeeds, the other sees a conflict, reviews and reapplies. Restart; history is intact and worktrees share the fact while another project cannot retrieve it. Archive/restore differs visibly from erase. Extend `tests/project-memory.test.ts` at the shared store boundary; one case covers interruption/reopen and conflicting erase. Erasure stays local-only until23 remote cleanup is implemented and labelled.

### 10A — reviewed transfer tied to source identity

Files: existing `project-handoff.ts`, `agent-delivery.ts`, shared handoff types and `ProjectHandoffPanel.tsx`. Retain current claim/delivery/acknowledgement distinctions. Add source memory revisions and checkout/source fingerprint to the reviewed handoff; when the recipient opens it, show changed references and let the user refresh the draft. No raw transcript dump.

Acceptance: OMP→Hermes and native↔ACP use the same reviewed context contract; only session delivery differs under07/08. Disconnect after possible submit must display uncertain delivery and require deliberate retry, not resend on reconnect. Extend existing handoff check for changed source revision; complete the native and ACP demonstration after their delivery capabilities exist.

### 11A — usable incremental retrieval

Files: `project-documents.ts`, `project-document-worker.ts`, `project-document-index.ts`, shared tool result types and existing document/search views. Reuse content hashes, cached vectors, `mergeInsert`, root admission and retrieval modes. Add a source-generation/fingerprint to progress/citation responses and stale action in the view. Cancellation leaves the last committed collection available and reports that publication was not completed. Confirm Lance transaction behavior at the selected version before changing the write path; if a forced crash exposes partial rows, use an unpublished collection generation and atomic local active-generation pointer, not a second embedding database.

Acceptance: edit one source, index only changed embeddings, find a paraphrase and open its actual line; delete it and confirm both search and direct citation resolve correctly. Cancel a rebuild and query the last published snapshot with honest staleness. Required-hybrid never returns a disguised lexical result. Reuse `tests/project-documents.test.ts`; model quality comparison is a small fixed question set against the strongest challenger only when the current route misses a product requirement.

### 12A — source-bound graph navigation

Files: `project-code-search.ts`, `project-code-graph.ts`, `ProjectGraph.tsx`, `project-graph.ts`. Reuse scoped index identity and the shared upstream cache established by04. Carry checkout/source fingerprint into graph results; verify the file/line when opening. Add selected-symbol direct callers/imports filters and supported-language explanation. File writes and branch changes invalidate the relevant index without killing another project's service.

Acceptance: diverged worktrees have different callers; opening either graph reaches its own source. Edit a caller and refresh only the affected checkout. Dynamic/unsupported edges remain uncertain. Extend `tests/project-code-graph.test.ts`, then use the live graph view; no ornamental graph work substitutes for navigation.

### 13A — complete native history and unified search

Files: `project-session-history.ts`, shared session history types, `ProjectSearch.tsx`, `project-search-ipc.ts`; native resume owner07 remains responsible for executable construction. Expand history capability descriptors to include supported source format/version, project attribution source, parent/helper role and exact resume identity. For Hermes/Kimi, inspect the installed format/provider metadata first: use a maintained parser update where it preserves exact cwd and native IDs; otherwise add narrow native-source readers at this owning boundary. Do not infer project from title or import an unscoped home archive. Ambiguous sessions may appear only in an explicitly unassigned browser and cannot be resumed as project-owned until mapped through actual metadata.

Add bounded pagination to transcript viewing, preserving ordinal/source identity. Search grouped sources independently with cancellation and workspace request generation. Only the code-text stream currently has explicit IPC cancellation ownership; extend the same controller pattern to slow document/history/knowledge calls instead of merely discarding results in React. Reviewed extraction opens the existing memory editor prefilled with source attribution; saving creates a normal canonical fact.

Acceptance: actual OMP, Hermes, DSH and Kimi history where their installed formats support it; helper sessions are labelled and never selected by an ambiguous resume action. A genuinely unavailable provider remains an explicit unmet clause, not proof from an OMP fixture. Change project during slow search and verify cancellation and no cross-project result insertion. Extend `tests/project-session-history.test.ts` with parent/helper and source mapping cases, then show exact native resume. Do not spend provider tokens re-testing transcript parsing.

### 23A — DuckDB activity exploration

Files: extend `project-analytics.ts`, `ProjectSessionHistory.analytics`, shared analytics type and `ProjectAnalytics.tsx`; proposed Python worker above. Within the existing validated SQLite read transaction, export only selected project sessions/usage rows to an owned temporary NDJSON snapshot. Include source IDs, revision/fingerprint, occurred time and explicit null/measurement status. Finish source revalidation before invoking DuckDB. DuckDB reads the snapshot in a disposable database with external access/extension loading disabled after trusted input loading; app operations are parameterized fixed query templates, not arbitrary agent SQL.

First useful queries: sessions/tokens by agent/day, measured versus unknown cost coverage, and activity before/after a selected project decision timestamp. Preserve unknown values as null; do not infer dollar cost from token count or charge zero for missing records. Include exclusion/truncation metadata. For histories above1,000, page the source validation/export and report progress rather than silently presenting a capped report as complete. Discard output if source-generation changes before publication.

Acceptance: query actual project activity through UI and `project_analytics` MCP, compare the selected source rows, then remove/change a transcript and refresh. Source rows disappear/change; unrelated project rows never enter the snapshot. Cancel and confirm only the owned worker/tempfiles stop. Extend `tests/project-analytics.test.ts` for row/null/provenance semantics and one native DuckDB worker check; SQLite summary remains available when optional DuckDB is disabled.

### 23B — Hindsight learned recall and review

Files: proposed knowledge contracts/owner, existing project-tool configuration, `ProjectMemoryPanel.tsx` and MCP dispatcher. Add endpoint, model identity, enabled state, status and start/stop/reconcile controls. Use project-generation bank IDs and deterministic document IDs derived from source ID/revision; retain includes source metadata. Start with confirmed memory plus reviewed handoffs; document/session expansion is explicitly selected and budgeted, not automatic whole-project ingestion. Bind the HTTP request timeout/abort and operation result to the existing owning scope.

Retain runs from the durable reconciliation manifest. Recall displays learned results with cited sources and validity; reflect is an explicit button/tool and its answer is labelled inferred. Promote opens the normal memory editor, preserving the original reference; saving alone creates a confirmed fact. Correction edits the canonical source, then schedules generation reconciliation.

Acceptance: a local configured model retains one decision and a reviewed handoff, recalls relevant context, and reflects with supported citations. A second project using similar text receives none of it. Change/archive/erase source, interrupt mid-projection, restart, and verify current recall cannot repeat the withdrawn claim. Extend proposed `tests/project-knowledge.test.ts` with an adapter fake for crash/identity and one separately invoked live endpoint demonstration; successful service startup is insufficient.

### 23C — Graphiti dated relationships

Files: proposed Python worker and TS knowledge owner. Build the supported Neo4j driver integration with group IDs fixed by owner, explicit local model/embedding configuration and constrained query operations. Submit source episodes with UUID, timestamp and source ID/revision. Store returned episode/edge references in the manifest. Normalize relationship results into the shared result contract; expose source date separately from edge validity interval. `asOf` filters both retained source availability at that date and relationship interval; source history older than retained revisions is explicitly unavailable.

Implement two query modes: current relationships and historical relationships at a chosen timestamp. Correct/archive/erase invalidates current generation and initiates a fresh one. Because upstream episode deletion does not guarantee shared-edge recomputation, use a new isolated group for the corrected snapshot; publish after validation, then clean the old group through a scoped, tested operation. Query gating protects the user while cleanup is pending; it does not falsely claim physical deletion complete.

Acceptance: decision changes from A to B with two dated sources; current query gives B and historical query shows A with dates/provenance. Remove a source contributing to a shared edge and demonstrate no unsupported surviving edge after publication. Repeat after process restart and an uncertain submit without duplicate episodes. Same query in project B cannot access project A. Native integration check must exercise actual chosen backend, model and deletion; a fake adapter cannot qualify temporal inference.

### 23D — one usable knowledge surface and native-agent route

Extend `ProjectSearchHit` with learned/relationship groups only when their source-opening action is implemented. Keep source groups, no invented global score. Add a compact side-panel view for current/historical mode, source provenance, projection lag/error, retry/rebuild and engine disable. Keep terminals visible. Add MCP operations to generated agent configuration via the existing app-bound server; no per-agent competing memory servers.

Acceptance: from an actual native agent ask what changed and why, inspect the cited source in the app, correct it, and observe invalidation/reconciliation in both engines. Switch projects during recall and confirm cancellation. Stop both engines; ordinary terminal input and canonical facts still work. Qualify an actual model-driven tool operation once per distinct adapter contract, reuse it for unchanged UI work.

### 20A — portable knowledge with referential integrity

Files: `project-export.ts`, shared kit types, `ProjectKitSettings.tsx`; reuse preview, checksums, destination collision handling and safe path rules. Introduce kit v2, continue reading v1 through an explicit conversion. Add scoped workflow/task metadata from their owning stores, engine selection/configuration without secrets, reviewed source references, and an optional learned-memory snapshot obtained from the admitted export API. Graph/source indexes and projection manifests are rebuildable; local session source files remain external unless explicitly selected for export and scrubbed.

Export a reference map. On fresh identity restore, preserve original source identity in provenance and apply one deterministic old→new ID mapping to every memory/handoff/learned reference. Do not independently randomize IDs in each section. In-place recovery uses the explicit original identity only after collision checks; importing beside an existing project gets a distinct project identity and cannot reconnect to the original Hindsight bank/Graphiti group. Imported engine state starts disabled.

Hindsight learned output is not necessarily reproducible byte-for-byte from its inputs. Export approved learned snapshot plus source/model/version metadata where the pinned API supports a coherent snapshot; otherwise label the precise unsupported snapshot portion and retain source material for recomputation, leaving that portability clause open. Retain erased-source tombstones without content and refuse restoration of references whose source is absent/erased. Never export endpoint secrets, local absolute model paths, browser profiles or VM images as a shortcut.

Acceptance: export/preview/restore to a new directory/profile next to an existing project, resolve a learned citation to its remapped canonical source, reconnect engines explicitly and rebuild derived indexes. Detect tampering/ID collisions without overwrite. Restore a v1 kit and explain the converted omissions. Extend `tests/project-export.test.ts` with cross-section reference mapping and deletion semantics; run one fresh-profile app journey.

## Bounded unresolved items and exact next evidence

These are not claims of completed feasibility and must not become open-ended research campaigns:

1. **Neo4j artifact admission:** inspect the selected server distribution's actual license and version compatibility with the pinned Graphiti driver, choose local isolated launch/resource settings, then perform the23C scenario once. Keep external-server ownership separate from app worker ownership. Failure changes the artifact/backend selection, not the temporal-memory requirement.
2. **Hindsight coherent export/deletion:** inspect the pinned document export/delete API response and any asynchronous operation status; implement acknowledgement/reconciliation around that behavior. The found methods establish an available API surface, not snapshot atomicity or derived mental-model deletion. Source gating and generation rebuild remain required.
3. **Hermes/Kimi history provenance:** inspect the installed native sources; if cwd/parent/session identity is absent, identify the exact trustworthy metadata join or supported parser update. Never guess from titles. This may require adding launch-time native identity capture in07 for future sessions while historical unknowns remain explicitly unassigned.
4. **Lance interrupted publication:** reuse the existing native package and one forced-stop case. Keep current merge path if atomic publication is adequate; implement generation publication only if the case demonstrates a gap.

No installs, model calls, migrations or product edits were performed while writing this plan. These implementation slices remain pending and do not inherit completion from earlier standalone trials.
