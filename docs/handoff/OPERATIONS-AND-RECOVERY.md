# Launch, operating boundaries and recovery

## New application/session on this Mac

Open `/Users/muzikfirst/Documents/donwellsai/donwellsai` as the local project. In a CLI, change to that directory before starting the harness's normal executable. Select the desired model in the new application; no provider-specific flags are guessed. Paste `START-NEXT-SESSION.txt` (also in chat). A text-only session cannot perform local implementation or macOS qualification.

Initial read-only commands:

```sh
cd /Users/muzikfirst/Documents/donwellsai/donwellsai
git rev-parse --show-toplevel
git branch --show-current
git status --short
git log -7 --oneline
```

The project folder is `/Users/muzikfirst/Documents/donwellsai`. The only app repository is its `donwellsai/` child, with its own `.git` directory. The sibling `workingfolder/` holds scratch/staging and handoff data, `research/` holds research and third-party trials, and `trash/` holds superseded files. Do not put app source at the project-folder root or create another worktree. Historical transcript paths refer to old layouts; use current source paths from this document.

The old `terminal-foundation` and `plan-restart` worktrees have been moved into the project’s `trash/2026-09-07-layout-cleanup/`. Their daemons and orphaned helpers were stopped. Do not launch from those archives. Preservation checks and session snapshots are in `workingfolder/old-checkout-cleanup/`; all committed work is already in the active app repo.

## Tool and build prerequisites

`package.json` specifies pnpm12.0.0. Use its existing scripts and installed dependencies; no install needed solely for onboarding. Inspect actual Node/pnpm availability in the new shell. `pnpm run typecheck` checks main/web/CLI; `pnpm run build` builds Electron main/preload/renderer and CLI. Native terminal build is separate. Prefer the owning existing regression after a real change, not full-suite baseline repetition.

Native pins from present `resources/native/build.json`: wrapper e47b20a860d464ac7ecb9c1eec01612cc6b178a5, core c4e16970a803b170e352432424f44192cb59f3ac, aarch64-macos13.0, i18n disabled. Inspect build script and notices before changes. Native z2d MPL obligations are addressed by bundled covered source/notices; do not silently drop them. Do not present preferred MIT/Apache reuse as proof every dependency has those licenses.

Do not rebuild output currently used by an app/daemon. Verify task ownership, then close only that owner. Use existing acceptance helpers for isolated app lifecycle. For an intentional source dev session after ownership checks:

```sh
task_profile=$(mktemp -d /tmp/donwells-next-session.XXXXXX)
DONWELLS_USER_DATA="$task_profile" pnpm run dev
```

Retain the profile path and process/session identity. Closing a window is not proof a macOS app quit. Verify exit and daemon cleanup; do not stop unrelated apps.

## Task16 helper inputs and interactive procedure

Existing compiled fixture:
`/private/var/folders/ly/4j6lsfds4n3g0_xcjrwjf4b40000gn/T/donwells-control-ui-CW2eu3/fixture`
SHA256 `7a41c1ecfb3f9f446a3c5c7f8141e083afa8690770e5edf09e132608a0e0586d`.

Admitted driver:
`/Users/muzikfirst/Documents/donwellsai/research/tool-trials/native-control-2026-09-06/cua-driver-0.23.2/cua-driver`
SHA256 `2cb9be8da6c91bfa6b535a0d777ca61e463996aff9cd769dace2eb840ddd0700`; runtime enforces this artifact.

Existing Playwright entry:
`/Users/muzikfirst/Documents/donwellsai/research/wt-quest-root/node_modules/playwright/index.mjs`.

Verify these inputs only when needed. If fixture is gone, compile the existing `tests/fixtures/native-control.swift` into a fresh temporary directory with swiftc. Do not install a second automation stack by default. Missing source build/native assets require their actual build, not path guessing.

Read and minimally correct `tests/acceptance/computer-control-ui.mjs` limitations documented in CURRENT-STATE before trusting it. It accepts --evidence, --fixture, --driver and --playwright. The evidence directory must not already exist. Keep the process alive in a managed terminal session, then:

1. Wait for READY and its checkpoint, without blocking your ability to make the second tool call.
2. View the produced native-target.png. Use native image pixels from that exact image, never previous coordinates or global-screen assumptions.
3. Within the current90-second wait, write integer {"x":...,"y":...} to coordinates.json in that evidence directory, preferably by atomic temporary-file rename.
4. Collect the original process's actual final exit/output. Require verified===true, actual target-A receipt, consumed observation, closed-target/release behavior and independent fixture/app/daemon exit evidence.
5. Preserve failed outcomes. Repair a concrete cause before a retry; a runner timeout is not automatically an external product blocker. This helper does not cover the complete16 requirements.

## Lume and SSH resources

Retained task guest (historically stopped; verify before acting):
`/Users/muzikfirst/Documents/donwellsai/research/tool-trials/isolated-work-2026-09-07/vms/donwells-task24-disposable`

Patched Lume binary:
`/Users/muzikfirst/Documents/donwellsai/research/tool-trials/lume-patched-plan24/libs/lume/.build/release/lume`

Prepared remote bundle described in `docs/architecture/second-pass-24/offline-deployment.md`:
`/Users/muzikfirst/Documents/donwellsai/research/tool-trials/project-remote-deployment-plan24-02`.

Do not execute old deployment examples until verifying exact intended guest identity and reconciled lifecycle. Prepared-guest admission, clipboard-disabled/native-display behavior, selected mounts, SSH account/host identity and deployment are distinct requirements. Never place a private SSH key on a guest share. No automatic adoption of a user's VM. New preparation or deliberate policy changes require preservation/recovery, not another user approval for every routine decision already authorized.

Task Linux container: `donwells-task24-linux-ssh`, historically stopped with data retained. Retired original profile binding: `/private/tmp/donwells-task24-linux-app-profile`; do not reuse its retired ID.

Fresh restored profile: `/private/tmp/donwells-task20-environment-evidence-1/restored-profile`; sibling project directories restored-project and collision-resolved. Its SSH binding was explicitly re-paired. Task22 profile: `/private/tmp/donwells-task22-recovery-evidence-1/recovered-profile`; only workspace/memory/kits copied, no credentials/pairing/browser profile.

Historical task Hindsight/bridge/PostgreSQL/Graphiti services were stopped; do not start for unchanged evidence. oMLX atlocalhost8899 was left user-owned. Previously successful model: omlx/Ornith-1.5-35B-A3B-MLX-8bit. Availability is not guaranteed now. Use configured local agent setup and avoid paid/exhausted providers.

## Package commands and scope

Read package.json, build/electron-builder.json and scripts/check-package.mjs before changed packaging. After source/native owners are quiescent and final implementation is ready:

```sh
pnpm run package:prepare
pnpm exec electron-builder --config build/electron-builder.json --mac dmg --arm64 --publish never --config.directories.output=/tmp/donwells-final-UNIQUE
```

Replace UNIQUE with a fresh destination; verify it does not exist. The second command does not replace the first command's source/native/notices checks. Do not use default dist when a runtime may own it. Mount/install the resulting app separately and qualify the actual installed artifact. hdiutil verification alone is not an app workflow. No automatic installed-app replacement, push, PR or publishing.

Historical candidate:
`/tmp/donwells-task22-candidate-5172c81/donwells-0.4.0-mac-arm64.dmg`
SHA256 b683b5025668034d8ef6ea90c0467b487936286f47cae6481d5f81264db0251c.
Separate installed copy: `/tmp/donwells-task22-installed-5172c81/donwells.app`.
It is not final. Recorded signing is ad hoc Electron executable only, no Developer ID, no sealed app resources and no notarization.

## Recover the source if the original checkout is unavailable

The project-local handoff package contains repository.bundle with the reachable history of workspace/terminal-foundation. Verify the package hash manifest and Git bundle before use. Clone into a NEW empty destination, never over this checkout:

```sh
git bundle verify /Users/muzikfirst/Documents/donwellsai/workingfolder/handoff-2026-09-07/repository.bundle
git clone -b workspace/terminal-foundation /Users/muzikfirst/Documents/donwellsai/workingfolder/handoff-2026-09-07/repository.bundle /path/to/NEW-donwells-checkout
```

Bundle recovery restores tracked source, plans and committed evidence, not node_modules, VM disks, models, private credentials, OS permissions or arbitrary /tmp files. Selected ephemeral evidence is separately inventoried; missing dependencies need existing pinned setup procedures. Consult package-manifest.json rather than assuming everything machine-local was copied.

## Efficiency and escalation

One meaningful regression plus required product evidence for each real change. Reuse qualifying work; no speculative rewrite. A failed attempt requires a changed hypothesis/correction before retry. Log exact cause/uncertainty and continue another ready task if a prerequisite is missing. Do not skip acceptance because a trial failed. If all useful work is externally blocked, record each blocker and required action; do not loop or claim background work.
