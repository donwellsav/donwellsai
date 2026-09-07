# Task 22 — installed release qualification in progress

The 0.4.0 release build adds generated notices for 187 installed production
dependencies and verifies them before packaging. The existing adapted-code notice
remains separate. PDF.js uses Chromium canvas in the renderer; unused native Node
canvas packages are excluded. The installed six-journey run also rendered both
fixture PDF pages, including canvas pixels and the text layer.

Settings exposes ten pinned optional asset downloads with byte sizes, SHA-256 and
installation/removal instructions. The source record is
`src/shared/project-tool-downloads.json`. These are separately provisioned tools,
not binaries or model weights redistributed inside the app. Archive sizes exclude
installed dependencies. The browser archive was downloaded and its executable
matched the existing admission hash. npm package archives and exact Hugging Face
model revisions are pinned; GitHub release sizes/digests are recorded from their
release asset metadata.

A controlled installation was copied from the verified DMG into
`/tmp/donwells-strengthen-22-install/current/donwells.app`. Developer ID signature
verification and shipped-byte comparison passed. Notarization was not performed:
no notary credentials are configured. A copied 0.3.0 artifact is retained for the
update/rollback check. No user's installed application or data was replaced.

Ten external tool/model installations were copied with APFS clones under this
acceptance installation. Every symlink resolves inside that tools tree. Native
agents keep their own existing installations and authentication.

The installed browser-service SIGKILL test exposed an orphan Chrome process.
`browser-crash-before.json` retains the failure. The managed browser now has a
fresh private profile per service; after parent failure, cleanup matches that
profile, executable and private process group before stopping Chrome. Service
restart waits for asynchronous cleanup. `browser-crash-fixed.json` proves removal
and a new working context on the correction package. The native browser adapter
checks pass, including stale references and interrupted actions; the full suite
passes 472 tests with 12 explicit optional skips. The release must be rebuilt with
this correction before final installed qualification is credited.

Remaining: final corrected DMG installation, installed update/rollback and native
tool/agent workflows, offline limits and final release notes. Task 22 is open.
