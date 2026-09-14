# Task 4 — Cut every task and run caller to daemon authority

## Delivered

- Replaced `OperationalRunService`'s local scheduler/orchestrator/store state with typed `DaemonClient` task-authority intents and projections. Scheduling, run-group fan-out, retries, cancellation, deletion, and execution history now use daemon-owned SQLite commands and projections.
- Added daemon-owned schedule/run-group projection operations (`task.schedule.list`, `task.run-group.list`) and typed client adapters.
- Routed runtime RPC task queries and administrator mutations through the authenticated `DaemonClient`; lease/worker operations remain outside renderer RPC.
- Changed `ProjectTaskCoordination.inspect` and `requireTask` to use daemon task projections after activation. Backlog access is retained only behind the migration read port; opening a native Backlog board is rejected after cutover.
- Added governed `task-authority` plugin capability exposing only daemon projections/intents; worker credentials and lease tokens do not cross the plugin boundary.
- Explicitly fenced task-linked `agent.open` away from generic agent creation so an authority identity cannot bypass the coordinator claim/launch-intent path. Generic agent opens remain available only without an authority task identity.
- Deleted retired `ParallelRunStore`/`ParallelRunOrchestrator`, `ScheduledRunStore`/`ScheduledRunScheduler`, `src/main/orchestration.ts`, `src/main/automations.ts`, and their obsolete service test. Migration readers remain isolated under `task-authority-migration.ts` and are not production writers.

## Tracked-source census

No production imports or writers remain for `src/main/orchestration.ts`, `src/main/automations.ts`, `ParallelRunStore`, `ParallelRunOrchestrator`, `ScheduledRunStore`, or `ScheduledRunScheduler`. The only remaining references to `orchestrations.json`, `automations.json`, and `automation-runs.json` are migration source definitions/tests and retirement-fence fixtures. Generic attention/EventStore behavior is unchanged.

## Verification

- `pnpm test` — 22 files passed, 325 tests passed, 6 skipped
- `pnpm run typecheck` — node, web, and CLI TypeScript checks passed
- `pnpm run build` — Electron main/preload/renderer and CLI build passed
- `pnpm run package:check` — package identity, native unpacking, CLI, icons, notices passed
- Focused coordinator/authority tests — 61 passed
- Focused CLI task credential tests — 6 passed
- Focused terminal-daemon/runtime/projection tests — 37 passed
- Focused migration/projection/CLI tests — 51 passed

The full test run emits pre-existing profile-maintenance disconnect warnings when temporary test runtime lock directories are removed; all tests still pass.

## Concern

The existing `agent.open` protocol does not return the coordinator's ACP child/session object, so task-linked opens are conservatively rejected rather than allowed to bypass fencing. A future protocol seam must return a coordinator-owned ACP session before enabling that path. This is recorded rather than hidden because implementing a generic fallback would violate daemon authority.

## Correction round 1

- Authenticated `task.schedule.list` and `task.run-group.list` through administrator task connections at both the daemon wire boundary and authority methods; worker connections are rejected. Run-group snapshots now carry their committed execution specifications so adapters can preserve command and target semantics.
- `scheduledRunSave` now reads the current schedule projection and sends its actual entity version on update. The integration test edits the same schedule twice and verifies versions `1` then `2` before cancelling its execution.
- Task-linked `agent.open` now fails closed in the main-process runtime with coded `TASK_LINKED_AGENT_REQUIRES_COORDINATOR` before task lookup or daemon launch. Generic task intent metadata/files remain forwarded unchanged. The coordinator-owned ACP return seam remains unavailable, so no bypass was introduced.
- Restored `OperationalRunService` integration coverage for schedule update/cancel, credential-authenticated parallel admission and workspace membership, daemon projections, and retired JSON write fences. Parallel/verification options now reject unknown keys and credentials must authorize every target workspace.
- Replaced the service's divergent run/schedule mappers with Task 3 projection adapters, including specification, command, target, queue/status, history, and execution semantics. Verification rows without an attempt/session are no longer mislabeled `running`.
- Removed obsolete maintenance callback parameters from the service and callsite; maintenance admission is intentionally daemon-owned. Removed the dead `parseScheduledRunPatch` type/export and task lookup bypass callback. Renderer task controls no longer expose the retired Backlog board and copy now names daemon projections.
- Profile IDs are bounded, stable SHA-256-derived values rather than user-data filesystem paths.

### Correction verification

- `pnpm exec vitest run src/main/operational-run-service.test.ts src/main/agent-runtime.test.ts src/main/task-authority/task-authority.test.ts src/main/task-authority/task-projections.test.ts` — 4 files, 58 tests passed.
- `pnpm test` — 24 files, 331 tests passed, 6 skipped.
- `pnpm run typecheck` — node, web, and CLI checks passed.
- `pnpm run build` — Electron main/preload/renderer and CLI build passed.
- `pnpm run package:check` — package identity, native unpacking, CLI, icons, and notices passed.

The full suite retains the pre-existing profile-maintenance disconnect warnings while temporary runtime lock directories are removed; no test failed.
