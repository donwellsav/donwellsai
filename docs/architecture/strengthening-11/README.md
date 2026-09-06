# Task 11 strengthening

Task 11 strengthened. The current production engine passes the unchanged retrieval gate.

The existing production engine is reused: QMD 2.8.3 chunking/local models and LanceDB 0.38.0 scoped storage/native fusion. The frozen prior engine comparison selected this fallback after standalone QMD failed the retrieval gate. No production dependency or model changed.

Commit `e5a6402` strengthens the existing native service checks: mixed-project multi-get rejects the entire request, replacing an indexed source with a foreign symlink makes get/multi-get/search refuse it, and semantic search drops deleted sources before and after rebuilding. Deleting the last document leaves an explicitly unindexed collection.

Packaged worker validation passed all six document/filesystem checks with no skips, following a 27-test document/filesystem/file-write/MCP run. TypeScript checks passed. The packaged worker used the existing admitted local retrieval models, not a hosted provider. Separate fixture measurements: first index 4572 ms, first query 1882 ms, warm query 183 ms, stopped-service restart plus query 6105 ms, deletion index 54 ms. Other machine activity was not controlled; these are scenario observations, not isolated benchmark claims. Owned services closed and test source directories were removed.

Artifact: `/tmp/donwells-strengthen-10-package/mac-arm64/donwells.app`. ASAR SHA-256 `b658329f8f384697332267501ffdec21a51e326dd011b8cd6839e7f1f31d7f2e`; no product-source changes since its 718-file/29-resource verification. The test executes its real ASAR worker with Electron Node mode; it does not claim installed GUI or release qualification.

Interactive setup belongs to Task 19; unified source navigation to Task 13. Model residency remains one instance per active checkout service and is released by pause.

The current frozen corpus run scored 120 warm queries over three repetitions: 92.5% macro recall@5, 100% exact recall, zero leakage across ten isolation traps, and every citation resolvable. First query 3528 ms; warm median 2909 ms, p95 3354 ms. Peak process RSS 8,719,824 KiB. The receipt records engine/model/corpus hashes and all query rows. An earlier single-repeat invocation was interrupted before scoring to correct the repeat count; it is not counted.
