# Task09 — correction and local erasure increment

SQLite remains the authoritative fact store. Existing Engram comparison does not justify losing stable IDs, CAS, retained history or reversible migration. This increment adds product behavior through that existing boundary.

- Conflict review shows the latest saved revision alongside the retained authored draft. Reapply updates the CAS base; Save remains explicit. Archived revisions cannot be silently restored by reapply.
- Erase is a separate human IPC action. It atomically removes current/retained content and stores a content-free tombstone. Archive/restore stays reversible. Agent MCP exposes no erase tool.
- JSON schema2 and SQLite schema2 preserve tombstones across migration, reverse and exports. Existing schema1 receives an owner-only backup before upgrade. Two already-open JSON readers refresh committed changes.
- External engine cleanup belongs to23; the erase confirmation states that limitation and that older backups/exports keep copies.

Verification:46 focused memory/migration/export/editor checks, typecheck and source build passed. `editor-erase-live.json` records real Electron UI create, competing human API edit, visible conflict comparison/reapply, archive/restore, and erase surviving renderer reload. It is not a two-native-agent conflict demonstration or a full application restart. The first runner attempt omitted required update fields; corrected input then passed. Both app and daemon closed cleanly.

Task09 remains **Partial** until the combined native/ACP integration journey demonstrates conflicting updates and restart/history through actual agents. Existing historical native create/recall evidence is not used to close that missing clause. Task20 still owns complete kit identity remapping; this increment preserves/rejects erasure identity conflicts safely.
