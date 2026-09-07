# Task 22 — installed release qualification

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
`/tmp/donwells-strengthen-22-install/current-final/donwells.app`. Developer ID signature
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
checks pass, including stale references and interrupted actions. The final signed
artifact passes both service SIGKILL and app SIGKILL recovery: its old managed
Chrome exits and a new context works after restart. The full suite passes 473
tests with 12 explicit optional skips.

The Finder-style minimal PATH run initially failed at content search. Startup now
appends standard user CLI and Homebrew locations without replacing explicit PATH
precedence. `installed-keyboard-final.json` passes all six keyboard journeys,
restart continuity and two-page PDF rendering with this restricted launch PATH.
This does not discover arbitrary version-manager installations; those need an
explicit PATH or executable. No user shell startup scripts are executed.

`installed-update.json` records 0.3.0 → 0.4.0 → 0.3.0 → 0.4.0 on one controlled
profile. Memory advances to SQLite revision 3. Terminal IDs, source bytes and the
migration backup stay unchanged; project-kit exports precede update and rollback.
All four closes are graceful. The previous binary and exports remain available.

`installed-doctor.json` exercises the separately provisioned graph, QMD/LanceDB,
Backlog and AgentsView installations through settings, pause/resume, scoped
history, corrupt-configuration repair and restart. An initial automation
connection failure is retained in `installed-doctor-initial.json`; the repeat
passed and shut down cleanly. Its initial leftover fixture shell and daemon were
subsequently closed through their authenticated daemon protocol.

`installed-offline-semantic.json` uses the installed executable and archive worker
with the separately provisioned QMD/LanceDB and 4.92 GB of local models. The test
process tree is sandboxed against external outbound networking, verified by an
EPERM probe. Indexing, hybrid recall, restart and source deletion pass. Initial
indexing took 11.94 s, first query 1.46 s, warm query 179 ms and restart/query
5.23 s in this small fixture. These are not corpus-wide performance claims.
The scoped offline suite passes 47 tests with three optional native skips.
Chromium's sandbox cannot nest inside that test policy; whole-GUI offline
network isolation is not claimed. Hosted agents still need their providers.

`installed-computer-control.json` qualifies the external Cua driver against owned
native and Electron fixtures, including stale coordinates and closed targets.
It does not change system permission settings or redistribute the driver.

`installed-native-initial.json` retains DSH's model-level failure: it
recalled the decision but attempted an extra read using the content as an ID.
The MCP descriptions already distinguish content from IDs; the server correctly
rejected that nonexistent ID. OMP wrote and Hermes/Kimi recalled successfully.

The unchanged repeat, `installed-native-final.json`, passes OMP's native write
and Hermes/Kimi/DSH recall across app restarts using local oMLX Ornith. DSH's native
compressed transcript ends with a completed answer and zero failed tool calls.
This is one clean run after one failed run, not a guarantee of model reliability.
Native resume and explicit handoff remain covered by their earlier task receipts.

`installed-launch.json` records a fresh-process/fresh-profile launch: runtime RPC
ready in 307 ms and renderer RPC ready in 397 ms. This single sample does not
measure first paint or flush OS disk caches. Task 21 contains broader timings.

The local artifact is `dist/donwells-0.4.0-mac-arm64.dmg`.
`release-artifact.json` records its exact bytes, SHA-256, installed executable and
archive, signature and runtime-source commit. All 718 app files and 34 external
resources match the current build. Runtime and packaging inputs are unchanged
since commit `8bbe201`; later edits are tests and evidence. No development
node_modules are required by the installed app; acceptance drivers are external
test tools, and optional native services are deliberately separate installations.

Task 22 is strengthened. Release notes are in the root README. No installed user
application, live project data, system permissions or public release was changed.
