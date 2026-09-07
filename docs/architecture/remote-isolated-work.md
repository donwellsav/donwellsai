# Task 24 — isolated desktops and remote workspaces

Status: in progress. No remote runtime or VM module is admitted yet.

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
