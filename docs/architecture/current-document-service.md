# Task 11 document service integration — partial qualification

Task 11 remains open. This checkpoint wires the qualified native retrieval pipeline into the existing project tool lifecycle and agent MCP bridge. It does not qualify the installed app or complete the GUI work.

## Evidence

- `current-document-production-corpus.json`: actual production index module, frozen 40-question/10-trap corpus, three warm repetitions after a separately recorded first query. Recall@5 92.5%, exact-identifier recall 100%, zero trap leakage, all returned source references resolve. First query 3322.45 ms; process peak RSS 8,687,872 KiB. Filesystem cache and external machine load were uncontrolled.
- The receipt fingerprints the index module before subsequent empty-index handling and resource cleanup changes. Those changes are covered by focused native tests; the receipt is not represented as a byte-identical final-source run.
- Native collection and worker tests plus existing filesystem, file-write and agent MCP tests: 26 passed, one model-backed service test skipped. Corrupt native manifests fail; scoped reads, ignored/hidden/generated files, symlinks, selected shared references, stale sources, rename/delete, cancellation and sibling-service survival checked.
- All three TypeScript checks and the production build passed. Actual semantic models through the bundled worker and packaged Electron remain pending.

## Configuration and ownership

The main process enables this optional service only with absolute `DONWELLS_DOCUMENT_QMD_PACKAGE` and `DONWELLS_DOCUMENT_LANCE_PACKAGE` paths. Qualified versions are QMD 2.8.3 and LanceDB 0.38.0 on macOS ARM64. Native artifact and model hashes are enforced; see the admission receipts for provenance and licensing. External native packages and models are not redistributed by this change.

Optional `DONWELLS_DOCUMENT_EMBEDDING_MODEL` and `DONWELLS_DOCUMENT_RERANKING_MODEL` point to the admitted Qwen3 4B embedding and 0.6B reranking files. Missing models produce explicitly labeled lexical fallback. Incompatible hashes fail startup. Each active checkout service owns its model instance; pause stops that service and releases its models.

`DONWELLS_DOCUMENT_REFERENCES` is a JSON object mapping canonical project paths to arrays of explicitly selected reference directories. The checkout is always included. Whole-home and ancestor roots are rejected. References share a project collection; checkout sources remain isolated. Root configuration is fixed until service restart; interactive setup belongs to Task 19. Derived databases live under the app user-data `project-tools/documents` directory; source files and durable memory are not changed.

Agent tools: `documents_status`, `documents_index`, `documents_search`, `documents_get`, `documents_multi_get`, `documents_pause`. Index returns a background job immediately; status reports progress. Pause uses the existing lifecycle stop operation. Citation reads reopen current confined source files and report stale index revisions.

Bounded indexing supports 10,000 files, 64 MiB of source text and 20,000 chunks per selected root; larger roots must be narrowed. Binary, truncated, hidden, ignored, generated and known credential files are excluded. Read responses enforce the existing transport size ceiling.
