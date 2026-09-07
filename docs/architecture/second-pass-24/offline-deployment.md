# Task 24 offline deployment bundle

Prepared locally, without contacting or starting a guest:

`research/tool-trials/project-remote-deployment-plan24-02` (under the parent project).
Its `deployment-manifest.json` records all 46 files, SHA-256 values and source
fingerprints. Total size is 122,827,808 bytes before the manifest. Bundle 01 was
an unsuccessful build and has no successful manifest; do not deploy it.

The already installed portable runtime is Node v24.19.0, arm64, ABI137:
`/Users/muzikfirst/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`.
Its dynamic dependencies are macOS system libraries only. Homebrew's Node24/26
executables instead need separate Homebrew dylibs and cannot be copied alone.
The bundle carries node-pty1.1.0 JavaScript and darwin-arm64 prebuilt runtime.
Plain-Node passive imports with Electron forbidden, native module import, three
entry syntax checks and remote `--help` all passed. No PTY or daemon was spawned.
Node redistribution notices remain required before distributing a release;
this is an internal qualification artifact, not a release package.

The package script `scripts/prepare-project-remote-bundle.mjs` refuses an existing
destination, nonportable Node linkage or unexpected external dependencies.
It is also the runnable regression check for a plain-Node guest entry. Moving
artifactPath to its existing shared policy module removes the accidental kit →
Store → Electron import. Separating the passive memory request function from its
CLI bootstrap prevents a bundled endpoint from executing another entry's main
block. No Electron package is included.

## New-clone deployment only

Run `scripts/install-project-remote-guest.sh` manually **inside the new clone**
as administrator, passing the mounted bundle, the mounted PUBLIC client key,
and the regenerated MAC from the new clone's host-side config.json. The script
checks the actual guest en0 MAC before changes and refuses every existing target.
It uses the historically verified account dwtrial. Existing evidence does not
establish that a dwagent account exists; nothing was read from a mounted disk.
The old client key path is `isolated-work-2026-09-07/ssh/trial` and its public
counterpart is `trial.pub`. The private key must never be placed on the share.

```sh
sudo /path/to/install-project-remote-guest.sh \
  /mounted/project-remote-deployment-plan24-02 \
  /mounted/trial.pub \
  NEW_CLONE_MAC_FROM_ITS_CONFIG
```

The script installs a root-owned bundle under `/usr/local/lib/donwells-plan24`,
a root-owned mapping and authorized_keys under `/private/etc/donwells-plan24`,
and dedicated editable project/state directories under `/Users/dwtrial`.
The forced command accepts only the current `donwells-project-v1` endpoint;
workspace, protocol and environment identity remain checked per request.
It validates and prints effective sshd policy, but does not enable/start SSH.
Review that policy before using it, because inherited guest settings may apply.

Unix memory forwarding is deliberately allowed remotely; TCP/agent/X11/tunnel
forwarding and PTY requests are disabled. SSH streamlocal permission is not a
per-path filesystem sandbox. Dedicated guest/account isolation and per-call
native-run credentials enforce the memory boundary. Copy the guest public host
key through the selected return mount and verify its fingerprint before pairing.
A cloned OS retains its SSH host keys; do not mistake cloned key material for
independent host identity or silently trust network-discovered replacements.

App pairing uses environmentId `plan24-guest`, generation1, remoteProjectId
`plan24-project`, remoteRoot `/Users/dwtrial/donwells-plan24-project`. The host
sets the new guest IP and selected private identity path. A separately installed,
root-owned OpenCode executable is still needed for agent.start and is deliberately
not guessed/installed. Add its exact path to the administrator mapping only after
qualifying that executable and its runtime. Shell terminal tests do not prove
agent/MCP integration.

## Native viewer reopen

Pinned `VMDisplayPresenter.swift` already implements `showWindow` and
`applicationShouldHandleReopen`. Closing its window hides/detaches the view;
Dock reopening recreates/attaches it to the same live VZVirtualMachine. The pinned source also provides `lume attach NAME --storage DIRECTORY --display native`.
`NativeDisplayAttachService` verifies that its private native owner marker matches
the configuration-file lock owner, then signals that process to reveal its existing
viewer. Explicit `--display native` prevents the default VNC fallback. The app's
Show desktop action now validates its recorded PID/start time and native marker,
uses this exact command, and checks ownership again afterward. It never calls run.
A stopped owner or stale marker is rejected. A successful attach requests reopening;
physical viewer visibility remains a separate desktop observation.

Primary pinned implementation: `libs/lume/src/Commands/Attach.swift` and
`libs/lume/src/VM/NativeDisplayAttachService.swift` at
[a3228aeb](https://github.com/trycua/cua/tree/a3228aebbed4c8d9c828c1ddea87cd12e99de238/libs/lume/src).
The existing owner regression checks mismatched viewer PID, changed start identity,
exact native-only attach argv, no additional VM launch, and stopped-owner refusal.


Pinned DisplayMode includes `none`; `--display none --vnc disabled --no-clipboard`
is syntactically supported for a separate headless trial. No clone/boot occurred
here, and physical clipboard/viewer qualification remains outstanding.
