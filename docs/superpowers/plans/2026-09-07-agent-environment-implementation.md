# Native agents, ACP, desktop ownership and remote environments

Planning specification, 2026-09-07. Implements the rebuilt plan's 07/08/10/16/24 capabilities. This document proposes changes; it does not claim they are implemented or qualified. Preserve existing native TUI sessions and user configuration. Ordering below follows interface dependencies and may change without dropping outcomes.

## Current implementation and decisions

| Boundary inspected | Existing behavior | Implementation decision |
| --- | --- | --- |
| `src/main/agent-runtime.ts`, `src/shared/agent-runtime.ts` | `AgentRuntime.start` validates real local registered paths and delegates to the terminal daemon. `RunningAgent.sessionId` currently identifies a terminal. Lost contact marks runs unverifiable. | Keep local validation. Add an explicit session-mode union; remote paths must never pass through local realpath validation. Preserve existing `agent.start` native behavior. |
| `src/main/terminal-daemon.ts`, `daemon-client.ts` | Daemon owns native runs, per-run hook credentials, PTYs, interrupt/stop, and attention. | Daemon also owns ACP children. Renderer/main-process views are clients, not additional process owners. |
| `src/main/agents/registry.ts`, `provider-hooks.ts`, `agent-hook.ts` | Registry supports named agents and arbitrary executable/argv; status hooks are provider-specific. | Capability declarations remain separate for native hooks, ACP, model configuration and project-memory connection. Never infer one from another. |
| `src/main/project-handoff.ts`, `agent-delivery.ts` | Handoff store has revision-checked claims, begin/confirm delivery, authenticated receipt/acknowledgement. Attachment delivery writes bracketed text into a PTY. | Retain the handoff ledger; route delivery by mode. An ACP request acknowledgement is not a receiver's acknowledgement of the handoff. |
| `src/main/project-computer-tools.ts` | Controller binds PID/window, owner, generation and observation revision. Failed dispatched input becomes uncertain; lease releases only after verified service termination. | Keep this boundary for host and guest controllers. Never retry uncertain input automatically or confuse VM viewer controls with guest controls. |
| `src/main/project-export.ts`, `src/shared/project-export.ts` | Project-kit supports selected artifacts and reviewed restore while excluding credentials/executables/derived indexes. | Reuse manifest validation and staging behavior for returned work; add operation/origin identity, not another general archive format. |

Select OpenCode's explicit ACP mode first: installed OpenCode 1.18.18 and Apache-2.0 ACP SDK 1.4.0 already passed the standalone local-provider trial. Admit the SDK as a direct production dependency only when implementing the adapter; retain exact version and notices. This is one concrete adapter, not an abstract plugin framework. OMP, Hermes, Kimi and DSH remain native unless their own ACP route is separately demonstrated.

Evidence already available: [agent capabilities](../../architecture/agent-capabilities.md), [ACP receipt](../../architecture/strengthening-28/acp.json), [remote boundary and pins](../../architecture/remote-isolated-work.md), [SSH receipt](../../architecture/strengthening-24/remote-transport.json), and [guest receipt](../../architecture/strengthening-24/guest-desktop.json). Historical trials prove their named scenarios only. In-app ACP, general remote terminals and production Lume integration remain work.

## 07 native-agent capability completion

Before the ACP slices, finish the named native adapters through the existing registry/hooks/configuration path. OMP, Hermes, DSH and Kimi each retain their own executable, argv, native conversation ID, provider configuration and supported resume command. Inspect the installed CLI help/config and current adapter before changing it; no guessed flags or rewriting the user's provider settings. Preserve arbitrary executable/argv launches as an explicit custom-agent route.

For each named adapter, fill the actual missing hook, memory-MCP configuration or resume mapping in `src/main/agents/registry.ts`, `provider-hooks.ts`, `project-memory-config.ts` and its existing provider-specific helper. Keep availability, launch, model response, tools, attention and resume as separate capabilities. A usage-exhausted provider can still be configured but cannot supply the missing model-response evidence. Use the configured local provider where the agent actually supports it; do not infer compatibility or silently switch to a paid account.

Connect the launch chooser and session rows to those declared capabilities. Support two agents concurrently on the same checkout and a deliberate switch using the same project facts; a reviewed handoff is the continuity route when native conversation formats differ. Extend the existing native-agent matrix only for the changed adapter, preserving the unrelated dirty Kimi work until its provenance is reconciled. Require one actual fact write by one native agent and recall by another, and each named agent's own supported launch/tool/resume behavior. Startup screens and another adapter's success cannot satisfy those clauses.

## ACP contracts and ownership

### 07A: Introduce mode without breaking native consumers

Change `src/shared/agent-runtime.ts` to model `RunningAgent` as common run identity/state plus a discriminant:

- Native: `mode: 'native'`, existing terminal `sessionId` and `AgentStartResult.session`.
- ACP: `mode: 'acp'`, stable app `sessionId`, separately named `protocolSessionId`, adapter ID, negotiated capabilities, and connection generation. No fabricated `TerminalSession`.
- Existing persisted/native records missing mode decode as native. Keep old native launch return shape through the current endpoint; introduce `agent.acp.start` returning the ACP run. New shared selectors must narrow mode before terminal access.

Enumerate all `RunningAgent`, `AgentStartResult`, `sessionId`, `writeAgent`, attach, stop, delivery and attention consumers with `rg` before editing. Update `AgentRuntime`, `DaemonClient`, daemon dispatch, `runtime-rpc.ts`, preload API, `agent-ui-commands.ts`, `runs/AgentsSection.tsx`, and session layout serialization together. Do not spread casts to hide incompatible terminal assumptions.

Proposed RPC methods: `agent.acp.start {workspacePath, adapterId:'opencode', loadSessionId?}`, `agent.acp.prompt {sessionId, requestId, text}`, `agent.acp.permission {sessionId, generation, requestId, optionId}`, `agent.acp.cancel {sessionId}`, and `agent.acp.observe {sessionId, afterSequence?}`. Existing `agent.stop` dispatches by mode. IPC/RPC validates project ownership again for every command, not only start.

Keep model credentials in provider-owned configuration. Use the selected local OpenAI-compatible profile for qualification; do not replace HOME or silently overwrite the user's OpenCode config. The trial's isolated profile is a test technique, not the application's default configuration strategy.

**Commit boundary:** discriminated contracts and native compatibility. Acceptance: existing native startup, terminal input, attach/reconnect and handoff still work; forged ACP commands against a native session fail before process input.

### 07B: Implement one daemon-owned ACP adapter

Add `src/main/agents/acp.ts` for the concrete SDK connection; wire it into `terminal-daemon.ts`. Use `ClientSideConnection` plus `ndJsonStream` and Node stream Web adapters, already demonstrated in `../research/tool-trials/agent-protocol-2026-09-07/acp-trial.mjs`. Spawn an argv array equivalent to `opencode acp --cwd <canonical-project> --hostname 127.0.0.1 --port 0`, never a shell-composed string. Pin/inspect the executable before qualifying changed releases.

Flow: spawn → initialize protocol 1 → record returned capabilities → `session/new` or supported `session/load` → publish ready. Initial client filesystem/terminal capabilities remain absent; do not advertise callbacks the app does not implement. OpenCode performs its own operations through its permission path. This is project routing, not an OS filesystem sandbox; isolation is provided by Task 24.

Project tools: provide the existing project-scoped `memory-mcp` command as a stdio MCP declaration in `session/new`/`session/load`, using pinned workspace/harness/profile arguments and per-run credentials. Reuse the server construction in `agents/project-memory-config.ts` without writing an additional native config file for ACP. Extend daemon authentication to validate ACP run credentials as well as native ones. Never expose credentials in public run records, events or plan receipts.

The prior OpenCode trial passed `mcpServers: []`; it did **not** prove this MCP connection. Inspect the pinned OpenCode adapter's stdio branch and execute one `memory_search` and revision-checked handoff acknowledgement through ACP before claiming integration. If the adapter rejects stdio despite the protocol supporting it, qualify one project-scoped loopback MCP transport using the app's existing server facilities, or select an adapter with working stdio. Do not forward broad runtime RPC to satisfy MCP connectivity.

Record bounded ordered session updates by app sequence; retain protocol payload type and tool-call identity. Prompt response `stopReason` controls turn completion. A tool update or silence is not completion. Apply message/output bounds and backpressure; oversized or malformed frames close the owned connection and surface a reason.

**Commit boundary:** actual adapter plus minimal ACP view beside native terminal sessions. Acceptance: app submits one short local-provider task, receives structured output and a project-memory result, while another native agent continues using the same facts. No second ACP owner is launched for a native TUI.

### 07C / 08: Permission, cancellation and recovery

Store pending permission requests in daemon memory under run + connection generation + request ID. Show operation text/paths and the exact options offered by the adapter in an existing side panel. Return only a currently offered option ID. Stale UI answers fail; dismissal, owner loss or cancellation resolves pending callbacks as cancelled. Show persistent approval only when the provider offers it; do not invent an always-approve policy. Approval authorizes the shown provider operation, not a different queued call.

Serialize prompts per protocol session. Persist request ID, payload hash and state before dispatch. Duplicate ID with the same hash returns the existing state; different payload is rejected. `session/cancel` is a notification: transition to stopping, await the outstanding prompt's cancellation/termination result, and escalate to owned-child termination after a bounded deadline if it remains unresponsive. No automatic prompt resubmission.

GUI loss does not stop the daemon child. Reattach the existing owner and replay bounded app events. Daemon/ACP process loss marks any in-flight mutation uncertain. Persist provider session ID, canonical workspace, adapter/executable identity and last settled request without credentials. A newly started adapter may call `session/load` only when `initialize.agentCapabilities.loadSession` permits it. History replay rebuilds the view and is never interpreted as fresh tool execution. Loading history does not settle an uncertain write; inspect resulting files/tool history and expose uncertainty until reconciled.

An owner claim for `(adapterId, canonical workspace, protocolSessionId)` permits one writer. Native/ACP switch is explicit: finish/cancel turn → stop old owner and verify exit → launch native resume or ACP load. If provider-native ID/resume mapping is unavailable, create a visibly new session with reviewed context. Do not guess a shared process connection.

**Commit boundary:** lifecycle and permission controls. Acceptance: deny a real requested write (file absent), approve a separate request (one write), cancel an active task, reconnect GUI without a new PID, kill adapter during a write and observe uncertain state without replay, and deny a stale permission response. Use a deterministic fixture for protocol faults, then only the minimal real local-provider turns needed for provider behavior.

### 10: Handoff and results across modes

Extend `agent-delivery.ts` to dispatch native text through the existing bracketed-paste route and ACP text through `agent.acp.prompt`; keep the existing handoff revision/claim checks in `project-handoff.ts`. New ACP request IDs derive from the handoff delivery attempt identity, preventing a reconnect from dispatching again. Keep states separate: claimed, dispatched, receiver acknowledged, completed. Reuse existing run/task intent and artifact records for structured ACP output; no new task ledger.

**Commit boundary:** both directions. Acceptance: native → ACP and ACP → native receive the same fact revisions, selected diff and unfinished work; wrong-project receipt and stale revision fail; disconnect after dispatch does not deliver twice.

## Lume and SSH implementation

### 24A: Resolve the known Lume policy gap once

Fresh source inspection on 2026-09-07 confirms [Lume Run.swift](https://github.com/trycua/cua/blob/main/libs/lume/src/Commands/Run.swift) exposes `--vnc disabled`, `--display native|none`, repeated `--shared-dir path:ro|rw`, storage selection and NAT mode. Native macOS display still enables clipboard synchronization automatically. The existing pinned `VM/VM.swift.shouldStartClipboardWatcher` returns true for native macOS even without explicit clipboard request. A successful old nightly boot does not remove this gap.

Implementation decision: qualify an exact maintained Lume revision with an explicit clipboard-disable policy. If upstream still lacks one, carry a small MIT source patch in `native/lume/clipboard-policy.patch`, adding `--no-clipboard` and passing the policy through Run → LumeController → VM; explicit disabled must override native display's automatic behavior. Build with the upstream build/signing workflow and retain source/hash/notices. Do not silently enable clipboard or abandon Lume because the option is missing.

Bounded resolution: inspect current release plus the existing pinned source; make one focused policy patch if needed; one build and one disposable guest trial. On reproducible build/platform failure, record the exact error and leave desktop admission open while SSH work proceeds. Do not repeatedly download restore images or rebuild unchanged sources. Source flags are not proof: verify no clipboard transfer in either direction and no VNC listener with the native viewer running.

Use 4 vCPUs/8 GiB RAM and one disposable VM at a time as the existing proven baseline; reuse a consented disposable image rather than the user's retained explored VM. Disk creation/download requires available-space checks and explicit resource display. No public Lume HTTP server, bridged network, host home mount, agent forwarding or automatic host clipboard access. Guest outbound NAT is not advertised as network isolation from the Internet.

### 24B: Add environment identity and lifecycle

Add `src/shared/project-environment.ts` with strict configuration and result contracts, and `src/main/project-environments.ts` as the project-owned coordinator. Persist configuration under app userData, not project source. Suggested environment record:

`{id, projectKey, checkoutPath, kind:'lume'|'ssh', generation, state, remoteRoot, capabilities, origin}` with a kind-specific config: Lume storage/name, selected mount manifest and resources; SSH hostname/port/user, known-host entry and identity-file reference. Secrets stay in Keychain or existing SSH identity storage; project-kit exports disabled declarations only.

Identity binds projectKey + canonical checkout + environment ID + remote project ID/root. Do not widen `requireLocalExecutionHost` or local ProcessSpec into a silent SSH wrapper. Existing local `ExecutionHost` remains strict; remote dispatch goes through the dedicated coordinator. UI goes in `src/renderer/src/components/ProjectEnvironmentPanel.tsx`, using the current movable module shell: choose environment, view mount/host scope, open terminal/desktop, pause new operations, reconnect, stop owned work, return selected results. Close view never means Stop VM.

Proposed scoped operations: `environment.configure`, `environment.start`, `environment.status`, `environment.pause`, `environment.resume`, `environment.stop`, `environment.connect`, `environment.terminal.*`, `environment.results.list`, `environment.results.stage`. Every request resolves the registered project and environment generation. VM adoption requires matching stored VM/storage identity, not a name alone. Preserve attached user-owned VM lifetime; stopping this app's controller must not stop an adopted VM. Recheck process start identity before killing; PID alone can be reused.

Reuse `ProjectTools` preparation cancellation and service state conventions, but do not pretend a foreground VM process is an MCP server: the environment coordinator owns it and publishes equivalent project ownership/status. On lost contact report unverifiable, not stopped. Persist state necessary to find the original owned guest after GUI restart, then reconcile Lume's observed identity before actions.

**Commit boundary:** environment records, Lume coordinator and usable panel. Acceptance: create owned guest, show selected mounts, disconnect UI/reconnect same guest, pause new dispatch while current work remains, stop owned guest and preserve a second project plus user-owned VM.

### 24C: Production project-scoped SSH entry point

Add `src/cli/project-remote.ts` and a `project-remote` CLI command in `src/cli/index.ts`/argument parsing. It is a separate bounded JSON-lines protocol over SSH stdio, not the existing global socket forwarded remotely. Add the wire types to `project-environment.ts` and local transport to `src/main/project-remote.ts`.

Pairing provisions one dedicated SSH key restricted to a forced command whose administrator-owned mapping fixes one project root and allowed profile. The command does not accept the project root from subsequent requests. Keep the private key local. Use native OpenSSH with strict host-key checking, a dedicated known-hosts file, batch mode, no agent forwarding and no incidental forwards. New host trust comes from a user-supplied/out-of-band fingerprint; `ssh-keyscan` alone is discovery, not verification. A changed host key is a required external blocker for that environment, never auto-repaired.

Handshake returns protocol version, remote project ID, canonical root, OS/arch/runtime and supported terminal/tool/control capabilities. Compare with the pairing before enabling writes. Test initial production target on the already qualified macOS guest with an installed compatible Node/runtime bundle. Linux support is advertised only after its native PTY binding is built and qualified; never claim universal SSH host support from one guest.

The remote entry point connects to a per-project supervisor, launched under the dedicated account and surviving SSH connection loss. Reuse the daemon's PTY ownership/stream primitives through a narrowly scoped dispatch surface; never expose repository administration, global app commands or arbitrary host selection. Authorize every session lookup against this remote project. Supervisor state lives in a private directory outside the editable checkout. Terminal input, resize and control route only to supervisor-owned sessions. A native shell can access what its OS account can access: SSH project mapping is not a filesystem sandbox. For untrusted work use a dedicated account or Lume environment.

Wire request envelope: `{version, environmentId, generation, projectId, requestId, method, params}`. Persist operation ID, parameter hash, state and resulting session/artifact IDs before dispatch. Status/attach may retry; writes may not. Same ID returns recorded status; conflicting parameters fail. Terminal input uses ordered sequence IDs with retained acknowledgement state. After supervisor crash between intent and acknowledgement, mark outcome uncertain instead of promising exactly-once shell effects. Reconnect observes existing sessions/operations; it does not restart commands. Cancel stops only the matched owned process tree and verifies exit.

Shared project memory must remain usable remotely. Add a restricted MCP bridge over the established client connection that exposes only project memory/handoff/tool methods allowed for that pairing, authenticated with an environment-scoped credential. The remote agent's stdio MCP shim sends those calls through the supervisor connection; it must not receive the local broad RPC token. When the connection is unavailable, reads/writes report disconnected and do not fork an untracked remote copy of canonical memory. Reconnect resumes fresh queries, never replays an uncertain memory mutation without its original operation/revision identity. Implement this after the base transport, before claiming remote agents share project memory.

**Commit boundaries:** handshake/host pairing; supervisor terminal ownership/reconnect; scoped project-memory bridge. Acceptance: actual remote terminal, two projects, wrong host/project/version rejection, disconnect during a write, three read-only reconnects retaining run identity, isolated cancellation, and remote native agent queries the same canonical fact revision as a local agent. Existing `tests/fixtures/remote-work-trial.sh` is qualification scaffolding, not the production server.

### 24D: Working copy, mount boundaries and reviewed return

Default isolated workflow: export selected source snapshot read-only plus a distinct writable artifact-return directory. Copy source into guest-private writable working storage before an agent edits; bind that copy to source base revision/hash manifest and environment identity. A deliberately selected live writable mount is a separate UI choice with its exact path and consequences visible. Do not mount secrets, home or app userData. Reject traversal, symlink escapes and unsupported Lume path encodings such as colon-bearing host paths; stage a safe named directory instead of guessing CLI parsing.

Result manifest records environment/project IDs, operation ID, base Git revision plus per-file base hashes for dirty inputs, relative paths, type/size/hash and proposed additions/modifications/deletions. Validate file bytes after transfer into a new staging directory. Reject path escapes, symlinks/hardlinks, executable/secret imports outside explicit product policy, oversize output and hash mismatch. Never automatically run returned scripts.

Reuse project-export validation and the existing diff/editor/safe-save path. Show selected changes and current local divergence before application. Recheck base/current hashes immediately before each approved save; a stale selection reopens review. Preserve local edits and originals, represent conflicts instead of overwrite, and make partial application visible/recoverable. Remote source is not deleted after return. This first implementation stages then reviews selected changes; automatic bidirectional sync is not required and must not be added speculatively.

**Commit boundary:** source snapshot plus selective return. Acceptance: work in both Lume and a separate SSH route, modify local source concurrently, reject stale overwrite, select one returned artifact/diff, verify bytes, and leave sibling files and environments intact.

## Task 16 desktop control integration

Retain the current Cua Driver owner/generation/revision contract while researching replacements against actual target fidelity. For VM desktop input, run the admitted controller inside the guest through the scoped remote tool route; bind guest PID/window and remote environment generation. Controlling the host's native viewer only demonstrates viewer input and must not masquerade as guest window enumeration. In both routes, action uncertainty survives disconnection, and further input requires a fresh verified target/lease after the old controller terminates.

Extend `ComputerControlPanel.tsx` with host-versus-environment target identity and an always reachable Stop control. Do not add a second generic computer-use framework. Qualification: selected disposable guest app action produces guest PID/action receipt; foreground changes invalidate stale observations; close target and fail later input; interrupt controller without stopping another project's application or the VM itself.

## Decision-focused research and execution limits

- ACP protocol references freshly checked: [session setup](https://agentclientprotocol.com/protocol/v1/session-setup), [prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn). These support handshake/load gating and turn control; they do not establish every adapter's compliance.
- The only unresolved ACP integration probe is actual project MCP plus scoped credential propagation, followed by same-owner recovery. Reuse the already proven local-provider prompt/cancel trial rather than repeating broad model comparisons.
- The Lume policy probe is the clipboard-disable patch/build and one real guest test. Its exact source and binary pin must be recorded at implementation; a floating main source link is not a dependency pin.
- The SSH protocol is a proposed app-owned implementation, not an existing upstream feature. Develop deterministic transport/ownership checks before one real SSH guest journey. Reuse the existing guest and key workflow where ownership permits; do not create multiple large VMs to exercise independent cases.
- Tests prove specific failures; delivery additionally requires the described in-app native/ACP and Lume/SSH journeys. A blocked provider or unavailable signing identity leaves its acceptance open while independent slices proceed. Do not mark an experiment's completion as completion of the integration.

This specification requires no product edits, installation, VM activity or model calls during planning. Each implementation commit must update the parent checklist with the delivered behavior, remaining open acceptance and source evidence; continue to the next ready slice without a routine approval stop.

## Task07 reviewed native configuration repair

A moved app can leave OMP/Kimi memory configuration pointing at its old CLI. Setup now offers the exact existing/proposed entry through the existing confirmation dialog; Keep preserves bytes. Applying rechecks the entire reviewed file revision before every branch, preserves unrelated entries and writes a private exact backup. DSH explicitly reviews its entire managed patch. No ownership is inferred from a server name and unreviewed API callers still fail closed.

`second-pass-07/config-repair-live.json` records the actual compact-window UI: scrollable keyboard-focusable preview, Keep, concurrent-edit rejection inside the dialog, fresh review/apply and exact backup. Deletion/equivalent concurrent changes are covered at the shared boundary by the existing file-write suite (16 passed); full typecheck passed. No provider prompts were used. Task07 remains partial pending the real ACP permission journey and complete named-adapter mapping.

## Task07 ACP permission argument review

OpenCode 1.18.18's permission handler builds its initial request from permission metadata, while a later tool update can carry the input. The real local turn reproduced an empty permission object followed by arguments under the same tool-call ID. The existing ACP owner now enriches pending reviews from its bounded current-prompt updates, matching protocol session and tool ID. It preserves the offered choices and permission ID; foreign calls and previous-prompt updates cannot supply review data. The actual current snapshot is retained in `second-pass-07/acp-permission-arguments-live.json`; ten existing ACP checks and node typecheck pass.

The original request was denied through the UI, with no verification run or file created. The model supplied an additional unsupported empty command field on a later request; the MCP schema remains strict. That model-input issue is separate from the corrected review display and does not establish successful verification.
