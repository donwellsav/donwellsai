# Lume clipboard policy

`clipboard-policy.patch` targets the exact previously qualified nightly source
`a3228aebbed4c8d9c828c1ddea87cd12e99de238` (MIT). It adds `--no-clipboard`
through Run → LumeController → VM. Explicit disable overrides both automatic
native macOS synchronization and explicit `--clipboard`; manual clipboard
transfer already requires the watcher, which is never started in this mode.

Current upstream Run.swift still lacks explicit disable as inspected September 7,
2026. Source and patch hashes are recorded in `source.json`. The patch applies
cleanly to the pinned files. This is not a qualified executable yet.

Apply with `git apply /absolute/path/clipboard-policy.patch` in that source tree,
then use its existing build/signing workflow. One admitted build and one
consented disposable 4 CPU / 8 GiB guest trial remain: verify host→guest and
guest→host clipboard both stay unchanged, no VNC listener exists, selected
read-only/source and writable/return mounts work, and sibling/user VMs survive.
Do not use an unpatched nightly with an unsupported flag or silently remove it.

The TypeScript launch preparation refuses unqualified policy receipts or an
executable hash mismatch. It never downloads, creates, modifies or starts a VM.
