# Task20 learned portability increment

Source implemented; complete Task20 remains open.

## Native contract examined

Hindsight source pin `ebad478240d3171bb88201ececda5e8d9883d22d`, `hindsight-api-slim/hindsight_api/api/http.py` and `engine/transfer/{export,schema}.py`. Bank template GET export omits learned facts and is not used. The asynchronous document-transfer export preserves document text, chunks, extracted facts, entity names, timestamps and document-local causal indices without extraction/model calls. It requires the server's document-export API enabled. Product support for this route on the user's deployed version still needs actual service proof; a missing endpoint fails explicitly. `transferSchemaRevision` identifies the inspected transfer contract, not an asserted running server revision. Model is the user's declared external server identity, not independently verified by export.

The product selects only its current canonical source document IDs, polls the returned operation, confines downloads to the configured origin and native download route, bounds compressed bytes to8MiB and uncompressed ZIP entries to16MiB/51files, never extracts files, and rechecks canonical source content before publication. The existing configured Python runs standard-library ZIP parsing. No dependency or second archive framework was added. Interrupted server export may finish remotely; no partial project kit is published.

## Usable increment

Format3 stores learned documents plus source references, temporal rebuild selections, and portable model/retrieval/task-authority hints. A new export checkbox requests current learned documents; absent that option, prior restored historical documents remain preserved on re-export. The same authoritative ID map used by memory/history/tombstones/handoffs remaps all learned and temporal references and document IDs on import. Earliest original identity remains in the existing kit reference map. Unsupported chunk or causal references fail before restore. Withdrawn/erased canonical references prevent re-export rather than silently retaining returned learned text.

Import writes inspectable historical learned data to `donwells-import/knowledge.json`. It does not advertise this file as an active engine bank. Optional explicit `.github/workflows/*.yml|yaml`, `.backlog/config.yml` and `.backlog/tasks/*.md` files use the existing bounded text-file path reader and restore to the new checkout. Reserved imported metadata paths cannot be overwritten by supplied artifacts. Native workflow execution is not launched. Only retrieval mode is directly restored as configuration; integrations stay disabled, model hints remain descriptive, environment bindings require pairing again.

Machine absolute attribution paths, arbitrary upstream metadata and retention options are omitted explicitly; safe source IDs and provenance remain. Existing content secret redaction remains in force, not a guarantee that arbitrary prose contains no secret. Canonical data and learned snapshots retain their content/history limits and fail on broken references.

## Checks and limits

`pnpm exec vitest run tests/project-export.test.ts`:17passed, including learned facts/source IDs→import→re-export, earliest provenance, explicit workflow file restore, erased source rejection and absent chunk/causal reference rejection. Existing JSON/SQLite memory, history, deletion/tombstones, version1 conversion, path/collision/durability checks remain.

`pnpm run typecheck`:passed. Standard-library decoder exercised with a valid native-shaped ZIP and a traversal entry; accepted/rejected respectively without filesystem extraction. These checks do not substitute for a real native server export or app restore journey.

Remaining full20 clauses: live native export against supported deployment; actual learned import/reconnect proof without re-extraction (explicit source path implemented below; upstream re-embeds and resolves entities); actual temporal relationship regeneration after target configuration; environment re-pair proof; richer supported portable settings and automatic complete native task/workflow selection where required. Historical snapshot alone does not close those clauses.

## Explicit reconnect increment

The kit panel now offers `Reconnect learned facts · re-embed`. It reads and validates the restored snapshot, proves each document ID matches its remapped canonical reference, encodes the supported native ZIP using the same bounded Python helper, then delegates to the existing knowledge owner. No automatic ingestion occurs during kit import. The explicit action uses the configured server's embeddings; it does not invoke extraction.

The owner prepares a new project-scoped generation before submitting multipart POST `/document-transfer?on_conflict=skip`. Completion requires exact document/fact counts, zero skipped documents and no server ID remapping. Canonical revisions are checked again before publishing. Existing recall/reflection and deletion/source-validity controls then use the imported bank. The previous published bank survives failed import. An uncertain submission is durably marked because upstream does not accept a caller-supplied import operation ID. Recovery discovers exactly one `import_documents` operation in that fresh bank; absent or ambiguous operations remain unpublished and block cleanup rather than treating a missing receipt as success.

The server must be restarted with `HINDSIGHT_API_ENABLE_DOCUMENT_EXPORT_API=true` and `HINDSIGHT_API_ENABLE_DOCUMENT_IMPORT_API=true` for native transfer routes. This agent did not restart the server or invoke embeddings. Runtime compatibility and actual recall after a real native transfer still require the root-owned live journey. Native export/import flags do not establish external model identity.

After this increment:21focusedchecks passed across knowledge/export; fulltypecheck passed. New owner check proves imported facts enter normal recall without a retain/extraction call, previous publication survives failure, lost receipts remain blocked until discoverable, and count mismatches do not publish. Python stdlib encode→decode roundtrip preserves document IDs, learned text, chunk references and entities. Tests use a fake service; live reconnect is not claimed complete.

## Actual native transfer

`native-transfer-live.json` records local Hindsight0.9.2 document export, app kit import into a new registered project, explicit native import/re-embedding, and learned recall resolving only remapped target source identities. Original bank data survived service restart. No extraction during transfer. Temporal rebuild/environment pairing and full visible journey remain open.

## Temporal restoration

`temporal-restore-live.json` binds the real kit archive hash and persisted import mapping to one restored canonical fact. After explicit destination configuration, Graphiti0.30.1 rebuilt a separate generation; its actual relationship cites only the remapped destination fact/revision/project key. The original canonical source and published generation remained unchanged. No erased source was revived.

The initial runner completed source projection, export and import, then incorrectly expected a disabled Graphiti status response; that API requires configuration. The continuation inspected the disabled destination through Project Doctor and rebuilt only the target. It did not repeat source extraction, export or import. Both owned app/daemon shutdowns were clean. Environment re-pairing remains open.

Environment re-pairing is now completed in `environment-restore-live.json`; actual collision handling and alternate-destination restore are in `collision-live.json`. See `delivery.md` for the rebuilt Task20 outcome.
