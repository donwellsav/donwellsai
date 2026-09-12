# Bundled session history

The macOS ARM64 app includes AgentsView 0.42.0 with the cwd3 Hermes/Kimi attribution patch. Users do not install Go or select an engine path. App packaging runs `pnpm build:native-history` and verifies the executable and license in the packaged resources.

`source.tar.gz` contains upstream commit ff8fb4e84823b9583eba417afc243140caabdcb0; `cwd3.patch` contains the modifications and parser tests. The two pricing snapshots are the build inputs used by that source. All inputs, the Go toolchain and the tested output are pinned in `build.json`. The build needs Go/Xcode on the developer machine; GOTOOLCHAIN selects Go 1.27.0 automatically. A changed output fails packaging until it is qualified.

The generated 106 MB executable lives under ignored `resources/native/history`, rather than Git. It uses system libraries only. The original cwd3 executable remains accepted for existing explicit overrides. The former `tests/project-session-history.test.ts` was deleted on 2026-09-11 with the rest of `tests/`; no replacement exists yet.
