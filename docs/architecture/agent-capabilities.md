# Agent capabilities — Task 28

The admitted OpenCode integration remains its native terminal plus structured status plugin. This strengthening pass fixes actual plugin discovery and enforces the existing status protocol handshake. No ACP background agent is started by the app. Standalone ACP was qualified separately; that does not advertise ACP controls on a native terminal session.

## Exact implementation and lifecycle

OpenCode 1.18.18, MIT, source [`31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d`](https://github.com/anomalyco/opencode/tree/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d), was already installed. The release API's target_commitish differs from the tag ref; this review uses the resolved tag ref. Its local executable SHA-256 is recorded in [ACP evidence](strengthening-28/acp.json). Apache-2.0 `@agentclientprotocol/sdk` 1.4.0 was reused from the existing isolated research installation, not added to production dependencies.

The pinned `src/cli/cmd/acp.ts` starts its own HTTP server and speaks ACP JSON-RPC over stdio. `src/acp/service.ts` advertises protocol 1, loadSession, HTTP/SSE MCP, image/embedded context, and session close/fork/list/resume. It creates native session IDs and loads native persisted messages. Cancellation aborts the backing session. `permission.ts` offers once/always/reject; missing or rejected client permission responses deny the operation. ACP is not a transport that can be attached to an arbitrary existing PTY. See [official ACP documentation](https://opencode.ai/docs/acp/).

Consequently an implicit `opencode acp` beside an existing TUI would create another owner/server. This task does not admit that architecture. We use the already-present native status integration, as the plan allows before adding a separate ACP client. Prompting, permissions and native resume stay in the CLI/TUI. A future explicit ACP mode requires its own visible ownership transition and scoped client controls; our standalone qualification is not that implementation.

## Production fixes

1. OpenCode's exact pinned `src/config/plugin.ts` discovers `{plugin,plugins}/*.{ts,js}`. Our adapter wrote `runtime-status.mjs`, so the actual TUI launched but never loaded the plugin. The shared launch helper now writes `runtime-status.js`. Every launch path using that helper receives the correction. Existing user OPENCODE_CONFIG_DIR is still preserved rather than overwritten.
2. The existing daemon advertises `agent-hook-events-v1`, but the shared emitter previously ignored that negotiation and sent an event after any successful hello. It now requires the advertised capability and rejects malformed responses. A missing or newer incompatible capability cannot silently change the protocol. Every connection renegotiates. No prompt text or permission decision is added to status events.

## Evidence

- [ACP trial](strengthening-28/acp.json): actual local oMLX Ornith prompt returned ACP_READY; invalid initialize schema rejected; restarted ACP process loaded the same native session; permission callback cancelled the proposed shell write and file remained absent; cancellation returned `cancelled`.
- [Native app trial](strengthening-28/native.json): after stopping ACP, native OpenCode resumed the original session history in xterm. A real prompt returned NATIVE_READY and the daemon reported its connected plugin and waiting state. Replacing the daemon client retained identical run and terminal IDs. A later shell permission appeared in both TUI and workspace attention; the operation was not approved, and stopping that owned agent left its target file absent. [Actual dark-theme permission view](strengthening-28/native-permission.png).
- The first native trial failed with hooks disconnected, then the `.js` fix passed. Raw scripts, source snapshots and failed receipts remain in the parent workspace research trial; failed data is not counted as success.
- `tests/agent-capabilities.test.ts` exercises malformed/missing/incompatible and partial capability responses, reconnection and no replay after disconnect. Existing agent tests cover scoped credential mismatch, cancellation/stop, expired owners and permission-gated input.
- Focused six files: 29 passed. Full suite: 483 passed, 12 existing skipped. Typecheck and build passed. Installed verification is a separate final-release step.

OMP, Hermes, Kimi, DeepSeek Harness and arbitrary executable/argv launch remain native; they gain no inferred ACP support. Other registry entries retain their existing unqualified readiness rather than receiving invented compatibility. Both protocol and native trial applications/agents were stopped, retained exited terminal records dismissed, and owned daemons verified stopped.
