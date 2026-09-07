# Task 24 environment implementation increment

September 7, 2026. This increment implements the SSH pairing/terminal path and
carries the Lume policy patch. The next slice adds canonical memory forwarding, reviewed text return and a settings UI. It does not close Task 24.

## Implemented behavior

- `ProjectEnvironments` resolves registered project scope on every request. An
  immutable pairing binds project/checkout, environment ID/generation, remote
  project/root, exact host key fingerprint and a private SSH identity reference.
  Pause prevents new writes; current remote work continues. Explicit connect
  resumes admission after a matching handshake. Changing the trust file fails.
- The local transport invokes `/usr/bin/ssh` with exact argv through the existing
  process executor: strict host checking, dedicated known-hosts file, no user
  SSH configuration, multiplexing, agent forwarding, proxy or incidental forwards.
  No host key is trusted from discovery alone. This increment admits Ed25519
  server keys and a non-root macOS arm64 remote deployment only.
- `donwells project-remote --mapping /administrator/owned/project.json` is a
  restricted JSON-lines endpoint. Requests cannot select a root or application
  RPC method. The expected root in each envelope must equal the admin mapping.
  The endpoint connects to the existing terminal daemon in a dedicated private
  profile outside the checkout. Disconnecting SSH leaves that owner running.
- Terminal open/input/resize/stop requests enter a durable journal before dispatch.
  Stable IDs deduplicate; conflicting payloads fail. Input sequence acknowledgement
  persists, and uncertain input blocks subsequent bytes. `terminal.observe`
  returns the existing terminal and its next sequence; `operation.get` observes
  the original attempt. There is no automatic write replay or arbitrary PID kill.
- The carried MIT Lume patch adds `--no-clipboard` through Run/controller/VM.
  The pinned policy function passes all display/OS/request combinations with
  explicit disable taking priority. No full Lume build or VM trial ran.
  Launch preparation checks the admitted executable hash, selected machine ID,
  4 CPU/8 GiB configuration and selected read-only source/writable return paths.

## Deployment boundary still to exercise

The administrator must install a compatible Node runtime, this bundle and its
macOS arm64 native PTY binding in a directory the agent account cannot edit.
Use a dedicated non-root account. Protect `authorized_keys` and its parent from
that account's writes. The dedicated public key entry must carry
`restrict,command="/absolute/node /absolute/donwells/cli/donwells.mjs project-remote --mapping /private/etc/donwells/project.json"`.
The native SSH client sends only `donwells-project-v1`, checked as
`SSH_ORIGINAL_COMMAND`. Do not forward the global app socket or token.

The root-owned mapping and all its parents must reject group/other writes and
symlinks. Its JSON shape is:

```json
{"version":1,"environmentId":"selected-environment","generation":1,"projectId":"remote-project","root":"/Users/dedicated/project","stateDirectory":"/Users/dedicated/.donwells-project-owner"}
```

The state directory must be private and owned by that dedicated account. Project
mapping limits exposed endpoints, not the shell's OS access; use a dedicated
account or guest for an actual filesystem boundary. No configuration is exported
as an enabled project-kit environment by this increment.

## Checks and remaining clauses

Focused tests exercise real local daemon children through the production endpoint
facade: disconnect/reconnect retains one terminal; a repeated input ID writes one
file line; foreign identity/session and skipped input sequence fail; uncertain
input never resends. Pairing tests cover host mismatch, pause, stale generation and
changed trust files. These are not an actual SSH/guest deployment receipt.

The added memory bridge uses one explicitly requested reverse Unix-socket forward.
A nonce probe verifies that it reaches this bridge owner. Every memory call
reauthenticates the remote native run against its project daemon, then invokes
the existing local ProjectMemoryService with the canonical registered checkout.
Only six memory tools and a request receipt tool are advertised. The bridge
stores mutation IDs/hashes/minimal receipts before dispatch; it does not store
another copy of facts or automatically replay an uncertain request. Paused or
stopped ownership fails subsequent calls. OpenCode gets the memory-only MCP
entry in its existing per-run config; a preexisting OPENCODE_CONFIG_DIR bypasses
that hook insertion and requires explicit deployment qualification.

Source capture retains selected bounded text and baseline revisions. Source
transfer exclusively creates remote files. Returned bytes are staged separately,
hash checked, shown in Pierre diffs and applied only when explicitly selected.
Local edits block overwrite/deletion. Baseline bytes remain available in the
review store. This is selected text transfer, not directory mirroring or script
execution. The settings panel exposes pairing, connect/pause, memory forwarding,
remote daemon terminals and result review. Terminal input uses acknowledged
sequence IDs and blocks on an uncertain reply; reconnect does not replay bytes.
Its current finite SSH request/polling transport still needs real latency review.

Memory forwarding needs an additional administrator policy decision: the
`restrict` entry above intentionally rejects forwarding. Enable the dedicated
key's forwarding permission only with server policy `AllowTcpForwarding no`
and `AllowStreamLocalForwarding remote`; keep agent, X11 and tunnel forwarding
disabled. OpenSSH streamlocal policy does not constrain a remote socket to one
path. Use the dedicated account/guest boundary, a private environment state
directory and the bridge's per-call project authentication; do not describe
this as a general filesystem sandbox. The client refuses to replace a live
socket and removes only a verified owned stale socket. The mapping may set
`opencodeExecutable` to the absolute administrator-installed OpenCode binary.

Focused service checks additionally exercise canonical memory write/read,
deduplicated mutation receipt, revoked owner rejection, unsupported tool denial,
selected result additions/updates and stale local deletion protection. These
checks do not establish an actual SSH forward or guest model integration.

Still required: remote bundle deployment and actual strict-key SSH session;
second-project isolation/cancellation and three reconnects under real SSH;
actual shared-memory forward and native remote agent write/recall proof;
remote reviewed handoff bridge; environment GUI visual/interaction proof;
actual selected source copy and reviewed result application over SSH; Lume full build,
signing, clipboard/no-listener trial; persistent VM lifecycle/reconciliation and
user-owned VM preservation; guest-bound computer control. Code and focused checks are present for the memory/result slices; external
deployment and user-visible proof remain open.

## Prepared Lume lifecycle increment

`ProjectLume` now backs three app endpoints: `environmentLumeList`,
`environmentLumeRegister` and `environmentLumeAction(start|stop|status)`. The
existing environment settings panel exposes registration, start, owner refresh
and stop. It does not download, clone, delete or modify another VM.

Only prepared machines in `<userData>/project-environments/lume-vms` can be
registered. The selected disk/NVRAM inode/device identity and machine identifier
hash are retained in the private registry. The read-only source must belong to
the registered checkout; writable returns must lie within the private
`lume-results` directory. A private `lume-admission.json` supplies the admitted
executable hash and qualified clipboard/no-VNC receipts. It is not editable by
the renderer. The old research VM remains outside this storage and cannot be
registered, started or stopped through this owner.

Start saves its intent before invoking the existing process executor. Status
uses pinned Lume `get NAME --storage DIRECTORY --format json`, then checks its
VNC-disabled sessions.json PID/start timestamp. Pinned upstream get verifies the
PID against the config-file lock. Reattachment requires the previously recorded
PID and start time; uncertain launch without a recorded owner is not replayed.
Stop uses upstream's exact storage-bound stop (which checks the config lock),
then verifies stopped state. Cancellation before verified VM start only aborts
the app's own process handle. A missing source mount cannot block stopping an
already-owned VM. No bare saved PID is killed.

Prepared fixture checks cover private-storage admission, registered project
scope, one launch across reconnect, verified owner marker and retained disk
bytes after stop. Eight environment tests and typecheck pass. These are local
fixtures, not guest or signed-runtime evidence. Root owns the current patched
Lume build, actual clipboard/VNC trial and SSH deployment. Native viewer
reattachment after losing its launcher window is not implemented; reconnect
here restores ownership/status, while terminal work uses the separate SSH path.

Pinned API source checked for this increment:
[Get.swift](https://github.com/trycua/cua/blob/a3228aebbed4c8d9c828c1ddea87cd12e99de238/libs/lume/src/Commands/Get.swift),
[VMDirectory session ownership](https://github.com/trycua/cua/blob/a3228aebbed4c8d9c828c1ddea87cd12e99de238/libs/lume/src/FileSystem/VMDirectory.swift).

Root built exact pinned patched Lume at `research/tool-trials/lume-patched-plan24/libs/lume/.build/release/lume` with Swift release/jobs4 and upstream local virtualization entitlement. Signed executable SHA256 a8b739a9d5a9bd7d0d7865de0f983a6b47e9bd2785e851ff0f05558ae667cc5a. CLI help exposes --no-clipboard and --vnc disabled. Native guest policy remains unqualified while Mac is locked; no admission success flags were written.
