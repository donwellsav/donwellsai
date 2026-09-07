# Task04 — project service ownership

## Product changes

- Stop cancels the final asynchronous scope check before a prepared service can launch. The regression reproduced a successful launch after Stop on the previous implementation.
- Service state remains `stopping` until owned-process cleanup finishes. A retained process is no longer reported as stopped merely because termination was requested.
- Project tools displays the canonical project/checkout owner, process ID and active calls. It refreshes service status while visible without replacing configuration drafts. Background engine jobs retain their engine-specific progress; active calls are not mislabeled as a count of those jobs.
- Code graphs now share one app-owned cache root, with distinct checkout index keys and per-session allowed roots. This corrects a real two-project failure: codebase-memory rejects a second cache while its account daemon is active. Configuration setup is serialized across project definitions that share that cache.
- Conflicting external code-graph installations receive an actionable error. Their processes are not stopped. Previous per-project derived cache directories are preserved; rebuild indexes in the shared cache as needed. No canonical facts or source files are migrated or deleted.

## Research and selection

| Source inspected | Finding |
|---|---|
| [Wave shell controller, a4447c1](https://github.com/wavetermdev/waveterm/blob/a4447c1563b2df285ab89e76c82f91e1a1a49c1e/pkg/blockcontroller/shellcontroller.go) | Explicit controller ownership, close and completion state are useful precedents. Its Go controller is not a drop-in supervisor for these Node services. |
| [WezTerm domains, d2f3f05](https://github.com/wezterm/wezterm/blob/d2f3f05b38f26a872f4b0bfbb3d2eaa7bdfc1b0b/mux/src/domain.rs) | A connection/domain boundary must remain distinct from process lifetime. Retain the existing native terminal daemon instead of tying it to optional tool services. |
| [MCP TypeScript stdio client, 5119ee7](https://github.com/modelcontextprotocol/typescript-sdk/blob/5119ee7fd7790e335a3fb60ef36f85334e2a6326/packages/client/src/client/stdio.ts) | EOF, bounded wait, SIGTERM and SIGKILL are supported patterns. Its child transport does not replace this app's project keys, process-tree verification and uncertain-write handling. No new dependency is justified for this fix. |
| [codebase-memory v0.10.8](https://github.com/DeusData/codebase-memory-mcp/blob/v0.10.8/README.md#session-coordination-daemon) and the matching native source | Requires one canonical cache root across active processes. Session roots and project index identities remain distinct. Stopping one frontend releases that session rather than terminating siblings. |

No new third-party code or dependency was copied. Existing admitted codebase-memory v0.10.8 and the shared process helpers are reused. Its account-wide cache constraint is retained as an explicit limitation for Task12's engine comparison, not hidden behind per-project labels.

## Evidence

- The launch-after-stop regression failed before the change and passed after it. The existing project-tool/doctor tests passed: 37 passed and one optional native-history test skipped. Updated active-call and stopping assertions passed in the 24-test project-tools file.
- TypeScript checks and the development build passed.
- [Live app receipt](live-ownership.json): two real code-graph services started; settings showed A's owner/process; stopping A through the UI left B indexing on its original PID; restarting A produced a new PID and the settings refreshed automatically. This was the actual development app in a disposable profile, not a mock service or packaged release claim.
- The checked-in `tests/acceptance/code-graph-service.test.ts` now uses separate ProjectDoctor owners, not one shared ProjectTools fixture. It covers concurrent indexes, distinct results, stop/restart isolation, rejected foreign targets and external cache conflicts. Its native receipt is adjacent.
- UI and terminal-daemon cleanup succeeded. No user's running app or external code-graph installation was stopped.

The user can now run these services in two projects and stop/restart either through the existing Project tools route. Next is Task03: usable engine choices and native-agent retrieval configuration.
