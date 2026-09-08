# Final 0.5.0 artifact — 2026-09-08

Final local artifact after the task-24 removal, task-26 host qualification and task-21 GUI work. Source: HEAD after cddce4b plus the 0.5.0 version bump (committed together with this record).

- **Artifact:** `dist/donwells-0.5.0-mac-arm64.dmg`, SHA256 `8ad3c856979a8d8e5bb0e53ca46ddd9f6d7888da807cd7b98ee11eb5b696e1f6`. `hdiutil verify`: VALID (CRC32 $4FDAB980).
- **Signing truth:** ad hoc linker-signed (`Identifier=Electron`, no TeamIdentifier), no Developer ID, no notarization; `spctl --assess` rejects it. This is a local installable build, not a signed distribution release. No publication, push or PR occurred.
- **Isolated install:** DMG mounted read-only, app copied to `/tmp/donwells-22-final/donwells.app`. The user's own installed application was never touched.

## Representative workflow on the installed copy

`installed-workflow-0.5.0.json`: the full keyboard-journeys suite plus PDF preview against the installed 0.5.0 app — populated multi-agent start/collaborate, handoff, memory, source edit+save, verification run with attached artifact, graceful close/relaunch retention. All journeys pass, zero pointer events.

## Update/rollback continuity

`installed-update-0.5.0.json`: 0.4.0 (dir build, same source) → 0.5.0 → rollback to 0.4.0 → 0.5.0 against one disposable profile. Canonical memory revisions 1→2→3 survive each binary switch, terminal session identity is retained, project-kit exports before update and rollback, source fixture and migration backup unchanged. `verified: true`.

## Profile recovery with the shipped launcher

The installed `Contents/Resources/bin/donwells-profile-recovery` (bundled-Electron launcher) inventoried a populated profile and applied the **workspace** and **memory** classes to an empty destination; both transferred files are hash-identical to source. The **kits** class was honestly `unavailable` (that profile had no project-kits directory). Opening the installed app on the recovered profile retains the project identity and returns the identical shared-memory fact (same id/revision/content/projectKey) — `installed-recovery-0.5.0.json`. First verification script mis-asserted the `memory.list` result shape; the corrected direct comparison is what the record contains. Recovery scope is the explicit classes only — not credentials, browser profiles or opaque files.

## Limits

No model inference or paid provider was used. Physical-desktop input qualification (21F) remains the one open product clause and is independent of this artifact. Gatekeeper will block first launch of this ad hoc build for other users; that is expected until a signed/notarized release exists.
