# Task 19 strengthening — complete

Earlier implementation chunks below describe their status at that commit. The final qualification at the end closes this task.

## Index resource controls

Pause now suspends the existing document job at file, chunking, embedding-batch,
or pre-commit boundaries. The response distinguishes a pending pause from an
acknowledged pause. Resume retains the job ID. Models remain loaded; Stop
terminates the owned service and cancels the job. An in-flight native operation
finishes before a cooperative pause takes effect.

Progress polling and pause/resume require an already-running service. They cannot
start or automatically restart a stopped/crashed worker. Reopening the search
panel recovers the active job state. Search status and index status are separate.

Validation: build and all TypeScript projects passed. With the admitted local
QMD 2.8.3 and LanceDB 0.38.0 packages, 23 document/service checks passed; one
semantic-model qualification check was skipped because model paths were not set
for this run. Native checks cover stable paused progress, same-job resume through
completion, stopping while paused, old collection visibility before replacement,
sibling collection preservation, and no process launch/retry from progress reads.

Task 19 remains open: catalog/configuration, setup diagnosis and packaged UI
qualification are still pending. This is a verified implementation chunk, not
whole-task completion.

## Project service configuration

Settings → Agents now exposes the four integrated MCP services: native code graph,
Lance/QMD document retrieval, managed Playwright testing and Cua native control.
The catalog identifies admitted versions, upstream sources, access scopes and
model requirements. Selected regular-file bytes and available cache-volume bytes
are measured; package/dependency size and provider usage remain explicitly unknown.
Selecting an installed path does not run an installer or request native permissions.

Each registered project has private `project-tools/configuration/<project-key>/tools.json`.
Linked checkouts share it; unrelated projects do not. Existing environment settings
are the fallback until a project explicitly saves its configuration. Applying a
reviewed diff stops that project's existing MCP owners, preserves the previous file
in a UUID-named backup, and uses the existing confined file writer with its expected
revision check. Corrupt content is preserved, not replaced with defaults. External
edits block service use until reapplied. Shutdown waits for an in-flight save.

Code graph native configuration/cache is separated per project. Cua definitions
share desktop/window ownership across projects and configuration changes; only
verified termination releases an uncertain input lease. Native agent authentication
and shared software installations are not modified.

Packaged acceptance: `configuration-result.json` is verified with idle daemon
cleanup confirmed. The dark-theme screenshots were inspected. It proves missing
path diagnosis, visible before/after configuration, native graph readiness,
project disable, document package configuration, acknowledged pause, same-job
resume to completion, stop without polling restart, backups, and persistence after
app restart. Executable: `/tmp/donwells-strengthen-19-package-reviewed/mac-arm64/donwells.app`.
The receipt records its ASAR hash and source fingerprint.

Checks: 41 passed across six doctor/service/computer/skills/secrets/settings files,
then all eight doctor checks passed after adding shutdown-during-save coverage.
Native computer control remains an opt-in skipped test in this run; cross-definition
ownership was checked without controlling the user's desktop. TypeScript/build passed.

Still open for Task 19: native history/task-tool configuration integration, remaining
setup failure qualification and complete catalog/resource/repair review. The plan
and task checklist remain at 19; no whole-task completion is claimed.

## Native history and task-tool configuration

AgentsView binary/root selections and the Backlog.md binary now use the same
project configuration. The app's history IPC/RPC routes remain stable across
configuration changes. History owns finite native indexing jobs; Stop terminates
that project's history worker, and changing configuration closes it before
replacement. Disabling/re-enabling retains the archive. The existing Backlog
adapter reads the current project selection before verifying the admitted binary;
a previously opened board remains an ordinary terminal session.

`native-configuration-result.json`: packaged run verified, idle daemon stopped.
Settings configured Backlog without environment flags, and its native task adapter
returned the fixture task. A separately registered native-history project selected
both native roots in Settings, indexed a real prior OMP/Ornith transcript, retained
search after restart, and refused history access from the unconfigured project.
The screenshot was inspected. Package: `/tmp/donwells-strengthen-19-package-native/mac-arm64/donwells.app`.
After that run, a display-only correction labels a saved Backlog path as configured
instead of not configured; native availability remains verified by the task adapter.

Nineteen history/doctor/task tests passed with the admitted native executables,
including both OMP and DeepSeek canaries, disable/re-enable retention, restart,
and current Backlog selection. The initial doctor test incorrectly rejected the
macOS `/tmp` alias of a registered `/private/tmp` fixture; the fixture resolver now
canonicalizes aliases like the production resolver. No production confinement was
weakened. Latest broader run: 43 passed, two optional native checks skipped in that
run; the native history check had passed separately. Build/typecheck passed.

Task 19 still remains active for the final catalog, repair and resource review.

## Final qualification

`complete-result.json` records the final built app, source fingerprint and ASAR
hash. Verified: true; owned idle daemon stopped: true. The packaged app recovered
corrupt configuration through a confined backup preview and revision-checked Apply,
retained the damaged bytes in a new backup, and restored native tool configuration
and history after restart. `repair-preview.png` was visually inspected: the actual
before/after review is visible. Executable:
`/tmp/donwells-strengthen-19-package-complete/mac-arm64/donwells.app/Contents/MacOS/donwells`.

The catalog includes all six admitted integrations. Selected directory size counts
regular files up to 10,000 entries and excludes linked/shared dependencies; larger
or unreadable sizes are unknown. Diagnostic copy uses an allowlist excluding paths,
native output, raw configuration and credentials. Native CLI authentication is unchanged.

Failure qualification:

- Missing executable: packaged Settings diagnosis, corrected path, native readiness retry.
- Wrong/non-admitted executable: doctor and tool admission tests refuse execution.
- Corrupt configuration: packaged backup repair, retained original bytes, stale revision and confined backup tests.
- Port contention: two project history indexes run concurrently using native ephemeral ports; other MCP services use private pipes.
- Disk shortage and denied writes: ENOSPC/EACCES at the real confined writer preserve the previous file; retry performs the actual write.
- Revoked control permission: computer-control checks refuse the action before dispatch.
- Offline: `offline-checks.txt` records external connections denied with EPERM and 46 passing native backend checks (one optional semantic model check skipped). Run with `sh tests/acceptance/project-tools-offline.sh` and admitted native package/binary environment paths.

The macOS external test sandbox cannot nest Chromium's sandbox: a separate packaged
offline attempt failed at Chromium startup. No security setting was disabled. This
receipt proves backend offline behavior and normal packaged UI separately, not a
fully offline packaged GUI session. Daily-driver/release qualification must retain
that distinction.

`focused-checks.txt`: 59 passed, two optional native checks skipped. Native history
and concurrent project indexing then passed separately; final doctor tests include
repair, diagnostic redaction, size accounting and dangling-link refusal. Typecheck,
build and final packaged acceptance passed. Task 19 is complete.
