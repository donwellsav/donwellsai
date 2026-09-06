# Task 11 document service integration

Task 11 is complete for the scoped retrieval service. This checkpoint wires the qualified native retrieval pipeline into the existing project tool lifecycle and agent MCP bridge. It does not qualify the installed app or complete the GUI work.

## Evidence

- `current-document-production-corpus.json`: actual production index module, frozen 40-question/10-trap corpus, three warm repetitions after a separately recorded first query. Recall@5 92.5%, exact-identifier recall 100%, zero trap leakage, all returned source references resolve. First query 3322.45 ms; process peak RSS 8,687,872 KiB. Filesystem cache and external machine load were uncontrolled.
- The receipt fingerprints the index module before subsequent empty-index handling and resource cleanup changes. Those changes are covered by focused native tests; the receipt is not represented as a byte-identical final-source run.
- Native collection and worker tests plus existing filesystem, file-write and agent MCP tests: 26 passed, one model-backed service test skipped. Corrupt native manifests fail; scoped reads, ignored/hidden/generated files, symlinks, selected shared references, stale sources, rename/delete, cancellation and sibling-service survival checked.
- All three TypeScript checks and the production build passed. Actual semantic models through the bundled worker subsequently passed; packaged Electron subsequently passed the checks below.

## Configuration and ownership

The main process enables this optional service only with absolute `DONWELLS_DOCUMENT_QMD_PACKAGE` and `DONWELLS_DOCUMENT_LANCE_PACKAGE` paths. Qualified versions are QMD 2.8.3 and LanceDB 0.38.0 on macOS ARM64. Native artifact and model hashes are enforced; see the admission receipts for provenance and licensing. External native packages and models are not redistributed by this change.

Optional `DONWELLS_DOCUMENT_EMBEDDING_MODEL` and `DONWELLS_DOCUMENT_RERANKING_MODEL` point to the admitted Qwen3 4B embedding and 0.6B reranking files. Missing models produce explicitly labeled lexical fallback. Incompatible hashes fail startup. Each active checkout service owns its model instance; pause stops that service and releases its models.

`DONWELLS_DOCUMENT_REFERENCES` is a JSON object mapping canonical project paths to arrays of explicitly selected reference directories. The checkout is always included. Whole-home and ancestor roots are rejected. References share a project collection; checkout sources remain isolated. Root configuration is fixed until service restart; interactive setup belongs to Task 19. Derived databases live under the app user-data `project-tools/documents` directory; source files and durable memory are not changed.

Agent tools: `documents_status`, `documents_index`, `documents_search`, `documents_get`, `documents_multi_get`, `documents_pause`. Index returns a background job immediately; status reports progress. Pause uses the existing lifecycle stop operation. Citation reads reopen current confined source files and report stale index revisions.

Bounded indexing supports 10,000 files, 64 MiB of source text and 20,000 chunks per selected root; larger roots must be narrowed. Binary, truncated, hidden, ignored, generated and known credential files are excluded. Read responses enforce the existing transport size ceiling.

## Model-backed worker follow-up

All three native document tests pass with the admitted models enabled. `current-document-model-service.json` records the worker/executable hashes, successful hybrid search, current source read, stop/restart and owned-service cleanup. The first attempt exposed QMD temporarily redirecting global stdout during model initialization, swallowing concurrent MCP status replies. The worker now supplies the existing MCP transport with an independent Writable bound to the original pipe. This fixes the shared transport rather than extending request timeouts. TypeScript checks and the production build pass after the fix.

## Packaged-worker qualification

`current-document-packaged-service.json` records actual Electron 44.1.1 executing the ASAR worker from `/tmp/donwells-task11-package-02/mac-arm64/donwells.app`, with executable and ASAR hashes. All 27 tests across document retrieval, filesystem confinement, file-write boundaries and agent MCP passed with no skips. Semantic index, hybrid search, source read and stop/restart used the admitted external native modules and models; the source application itself was not installed over the running user app. This is worker integration proof, not Task 22 release proof.

The frozen corpus's 120 warm question queries measured median 2800.47 ms and p95 3204.41 ms. Separately recorded first query was 3322.45 ms. Model files total 4,918,813,408 bytes. The one-document packaged fixture indexed in 10,558.86 ms, queried in 1,445.76 ms and stopped/restarted/queried in 4,847.30 ms. These scenarios have different sizes and are not interchangeable performance claims.

Remaining plan ownership: Task 13 consumes document hits in unified source navigation; Task 19 provides interactive tool/root setup; Task 22 qualifies provisioning and the complete installed application. Task 11 adds no new GUI hierarchy and leaves the terminal-led redesign requirements intact.
