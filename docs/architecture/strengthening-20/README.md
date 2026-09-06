# Task 20 strengthening — complete

The project kit uses the existing memory, handoff, confined file, settings and
layout authorities. No archive dependency or parallel operational store was added.
The existing CLI catalog provides `project-kit-export`, `project-kit-preview`,
`project-kit-import` and `project-kit-report`; CLI parsing and transport are reused.
Settings → Advanced provides the same export/review/restore flow.

## Format and restoration

Version 1 is a private JSON kit, capped at 32 MiB. Each section has a SHA-256
checksum, and import requires the exact reviewed whole-file hash plus source
project identity. It includes current and archived facts with retained history,
handoffs, portable panel geometry, up to 100 explicitly selected text artifacts
(up to 512 KiB each), and the admitted tool version manifest. Binary artifacts,
source checkouts, caches, executable paths, native authentication stores, browser
URLs/cookies and agent process state are excluded. Recognizable credentials in
selected text are redacted; provenance machine/session references are removed.
This is a project-context kit, not a source-code repository clone.

An import exclusively creates a new directory outside existing Git checkouts.
Memory IDs are remapped, full retained revisions go into the current JSON/SQLite
authority, and handoffs become historical superseded records with stale source
fingerprints. No native delivery is resumed. Fresh shell sessions fill restored
terminal panels; no old session IDs, commands or credentials are reused. Browser
slots explain how to set a new local preview URL. File-specific editor/diff views
are reopened from their files rather than transferring buffers or machine paths.

All tools are initially disabled. The report identifies unsupported versions and
local setup/index rebuilding requirements. It persists explicit source and target
identities. Derived code/document/session indexes are rebuilt through their
existing index operations after local tool configuration.

Validation precedes destination writes. Existing destinations are never merged.
Export stages/flushed bytes and publishes using an exclusive atomic hard link;
failed flush/publication leaves no completed kit and does not overwrite a file.
Failed restore registration rolls back only the exact imported memory/handoffs;
the new directory and incomplete marker remain for inspection. A crash before
registration leaves the new directory unregistered; this version does not auto-
resume partial imports. Existing projects remain unchanged.

## Evidence

`result.json`: verified, with both owned daemons stopped. The final packaged app
exported SQLite memory through Settings, reviewed/imported it into a second clean
profile, queried current and previous revisions, preserved the selected artifact,
refused duplicate import, and retained memory and new terminal sessions on restart.
`restored-terminals.png` was visually checked with actual terminal canary output in
both visible splits. An earlier screenshot was taken before output rendered; the
runner now waits for visible terminal screens and writes a canary before capture.

Artifact:
`/tmp/donwells-strengthen-20-package-final/mac-arm64/donwells.app/Contents/MacOS/donwells`.
Its ASAR hash and source fingerprint are recorded in the receipt.

Typecheck and build passed. `checks.txt`: 86 passing checks across kit, CLI,
migration, memory, handoff, layout, store and capture tests. The subsequent 12 kit
checks also cover oversized/linked input, interrupted export, duplicate identities,
traversal/file-directory collisions, missing tool versions, JSON/SQLite rollback,
quoted-secret redaction, cached reader invalidation and a delayed renderer save
preserving imported layout. No personal profiles or agent model calls were used.
