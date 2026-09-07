# Package delivery preparation

The installed app now ships the existing profile-recovery engine with bundled-Electron launchers. Recovery is usable without a source checkout or separate Node installation. Its original manifest, collision, owner-quiescence, encryption and exact-target guards remain unchanged. A focused launcher check exercises the actual shipped script with spaced arguments.

The existing package check now requires the recovery resource and macOS native terminal binaries, bundle, build manifest, dependency licenses and covered z2d source. It checks actual architectures and external linkage using Apple tools. Explicit platform/architecture arguments support target-specific checks; no signing or notarization is implied.

Research: [electron-builder extraResources](https://www.electron.build/contents/) and [Electron bundled Node mode](https://www.electronjs.org/docs/latest/api/environment-variables#electron_run_as_node). No new dependency was introduced. Generated installed-production notices were stale after ACP integration; notices:build refreshed188 entries and the complete source package check then passed.

This is preparation, not a final artifact or completion of Task22. Final GUI/physical qualification and isolated candidate installation/update/recovery remain.
