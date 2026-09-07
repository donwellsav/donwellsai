# Task 24 — isolated desktops and remote workspaces

Status: Task 24 evaluation and transport design complete. No production remote runtime or VM module is admitted. The native nightly trial passes the bounded desktop/transport checks below; stable-release and isolation-control gaps prevent production admission.

## Current boundaries and reuse

The app's existing computer-control service owns an explicitly selected PID/window and invalidates observations after input. Stopping the native service releases its controller only after termination; uncertain input is not replayed. These boundaries remain applicable to a VM viewer.

The existing runtime is local: an owner-only Unix socket plus an owner-only discovery file containing a bearer token. Its methods operate on local registered projects and include broad app operations. Forwarding that socket over a network would not create project mapping, remote leases, or capability negotiation. The existing project-kit export can carry selected text artifacts, memory, handoffs, layout and disabled tool declarations; it excludes credentials, executables and derived indexes. Reuse these contracts before adding another archive format.

## Pinned local VM trial

[Lume 0.5.3](https://github.com/trycua/cua/releases/tag/lume-v0.5.3), release target `754eec754991e1760100621e9bfe7ec1395cc7db`, MIT. The notarized arm64 archive SHA-256 is `af5d0556763a7f0116153c220aaabe44974e775091ac57e38da2abb2959c63e8`; native version output and strict deep signature verification pass. The archive is unpacked only into private project research storage; no installer or global daemon was run.

The host reports arm64, virtualization support and 128 GiB RAM. The disposable guest is configured for four CPUs, 8 GiB RAM, a 60 GiB sparse disk and a 1280×800 display. Its disk lives in the trial's explicit storage directory. macOS installation uses Apple's supported restore image selected by the pinned Lume executable. No host home directory is shared.

The pinned unattended helper invokes `vm.run` with its default VNC policy, and the VNC implementation exposes no bind-address option. The 0.5.3 binary rejects the documentation's `--vnc disabled` option. The separately pinned [August 28 nightly](https://github.com/trycua/cua/releases/tag/nightly-lume-v0.5.4-nightly.20260828.33150299846), source `a3228aebbed4c8d9c828c1ddea87cd12e99de238`, implements that option. Its archive hash is `62f603e17c0cc551d4763080b6fc797a70ea46026149ec37838ea972240394ae`, and strict deep signature verification passes. The guest boots through its native viewer with a null VNC URL and no host-process TCP listener. This is nightly qualification, not stable-release parity. No Lume HTTP server is started. Telemetry is disabled through its native environment option.

## Remote transport design to qualify

1. Use native OpenSSH with explicit host-key pinning and a dedicated identity. Disable agent forwarding and incidental forwards. A guest on host-only/NAT networking is the first test target; do not expose an app listener publicly.
2. Pair a specific host identity with a canonical project root and a separate local checkout identity. Negotiate runtime protocol version, supported operations and tool versions before enabling actions. A path from an imported document cannot change that mapping.
3. Remote runtime discovery stays on the remote host. Do not copy its bearer token into project files or turn the existing global socket into a network endpoint. A future restricted remote entry point must enforce the mapped project for every operation, including terminal creation and tool execution.
4. Disconnect during a write or computer action means the outcome is unknown. Reconnect observes the original operation and process ownership before offering another action; it never resends the write. Use operation IDs and durable outcome records in the eventual remote protocol.
5. Compare source revisions and selected artifact hashes before import. Return outputs to a new local staging directory, show the chosen files, and preserve divergent local files. Reuse the existing safe-save and project-kit checks; no automatic whole-project overwrite or credential import.
6. Pause means refusing new agent/control actions while preserving outputs. Suspending a VM and pausing a controller are different capabilities and must be reported separately. Stop verifies the owned VM/process ended. Destroy applies only to the explicitly disposable instance after outputs are exported.

## Required independent receipts

The native VM receipt must prove guest boot, actual desktop input, selected-project-only transfer, returned artifact bytes, resource configuration, pause/stop behavior and owned cleanup. A state-transition unit test cannot supply those observations.

The remote receipt must separately prove pinned-host authentication, denied mismatched identity/project/version, disconnect during a write, repeated reconnect without replay, retained remote ownership, source divergence and selective artifact return. Local RPC tests cannot supply remote-transport proof. Any unqualified capability remains disabled and named in the admission decision.

The native viewer automatically starts an SSH clipboard bridge using the default `lume` account. The manual trial uses a different guest account. A production isolated profile needs explicit control of that automatic behavior; desktop isolation must not silently grant host clipboard access.

## Native and remote results

[Guest receipt](strengthening-24/guest-desktop.json): macOS 26.6.2 boots with four CPUs, 8 GiB RAM and a 60 GiB sparse disk. Finder displays exactly the selected project, selected tools and artifact return directories. A guest write to the read-only project fails; its original revision hash is unchanged. The existing AppKit control fixture runs inside the guest, and clicking Record A returns its actual guest PID/action JSON to the host. This is native desktop input, not an Electron DOM simulation.

[Separate SSH receipt](strengthening-24/remote-transport.json): the host pins the guest public host key returned through the explicit share. A dedicated key is restricted to `tests/fixtures/remote-work-trial.sh`; passwords, forwarding and unrestricted commands are disabled. The fixture exposes a fixed test project and protocol. Wrong keys, changed host keys, different projects/versions, arbitrary commands and traversal fail. Disconnecting during an accepted write leaves one owned operation running; three reconnects observe its original PID and completion. Submitting its ID again returns the existing result without another write. A stale source revision is refused. Pause refuses new work; resume works; stopping one owned operation preserves the completed sibling. Only the chosen artifact is staged into a new local directory, leaving the source intact.

Reproduce against the provisioned disposable guest with `python3 tests/acceptance/remote-work-trial.py --trial-root /absolute/private/trial --host 192.168.64.2`. Provisioning uses the selected public key, guest-only SSH settings, and an executable copy of the shell fixture installed as that key's forced command. The private key never enters the guest/share. The acceptance runner records outcomes and hashes without credentials. This is a qualification protocol, not production RPC: there is no remote terminal/control dispatch, general project pairing, external concurrent source-edit test, or automatic import into an existing checkout.

The controller was paused before final stop. Lume verified that its owned PID 73592 ended and now reports the guest stopped. The VM disk is retained because the user explored it; returned outputs are preserved and hashed. No user application was stopped. VM suspend is unavailable and is not represented as controller pause. `lume get` incorrectly reports null shares with VNC disabled; the actual guest mount contents and read-only failure supply that evidence.

## Admission decision and concrete integration boundary

Retain Electron and the existing local computer-control module. Do not add a production Lume dependency or expose the local global RPC socket. Stable 0.5.3 cannot meet the disabled-VNC profile; the qualified nightly still starts clipboard synchronization automatically for the native viewer. These are unresolved isolation controls, so the plan's conditional `isolated-workspace.ts` implementation gate is not met.

A follow-on implementation must first qualify a maintained Lume release with explicit clipboard/network policy. Its project module should reuse current service ownership, hold the selected directory manifest, record the VM identity/resource limits, and return outputs through project-kit staging. The GUI belongs in the existing side panel; Stop and Close view retain their existing distinct meanings. Remote pairing then needs its own project-scoped runtime entry point: the negotiated project identity must be checked for every request, durable operation IDs must survive disconnect, and terminal/control ownership must be verified before enabling those capabilities. The trial proves transport and bounded operation mechanics; it does not waive those production gates.
