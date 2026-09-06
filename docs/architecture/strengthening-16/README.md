# Task 16: explicit native computer control

Cua Driver 0.23.2 runs as an optional app-owned direct MCP process using the existing ProjectTools transport. Set `DONWELLS_COMPUTER_TOOL_BINARY` to the admitted external executable. The executable SHA256 is checked before launch: `2cb9be8da6c91bfa6b535a0d777ca61e463996aff9cd769dace2eb840ddd0700`. No new dependency, shared daemon, installer, standalone Cua app, or automatic permission grant was added.

The pinned source declares MIT. The native release archive lacks complete redistribution notices, so the integration uses an explicitly configured external installation; it does not bundle that archive. Source admission is retained in component-decisions.md. The executable links macOS system libraries/frameworks; the adjacent SDK dylib is not an executable dependency. Telemetry is disabled for the owned process. Task 19 owns catalog/setup.

## Behavior and ownership

The side panel lists app/window identities and displays host permission status before attachment. It supports explicit target attachment, inspection, screenshot, visible Stop/release and movement into the workspace. Foreground delivery is an explicit attachment choice. Native agents receive computer_* tools through their existing project MCP connection; each connection injects a private controller identity, rejecting caller overrides.

One controller owns a target until release. Snapshot revisions, element tokens, observed window bounds and image bounds fence input. Observation does not acquire input authority. Foreground actions and potentially synthesized keyboard actions reserve one desktop-wide lease across checkouts. Concurrent actions are refused instead of queued. A native input error or interrupted transport consumes references and holds uncertain ownership until verified process termination. Stop never replays input.

ProjectTools now admits the selected tool's exact MCP protocol version (2025-06-18 for Cua, existing default unchanged), permits adapter-owned preflight calls and invokes cleanup only after process-tree termination succeeds. Explicit verified Stop resets intentional restart accounting; automatic failures remain bounded. Tests verify the cleanup callback runs after the PID has exited.

## Qualification

`checks.txt` contains 59 passing checks: target/controller isolation, denied permissions, concurrent desktop input, stale frames/revisions, retained uncertain ownership, quiescent cleanup, deliberate restart versus crash limits, scoped MCP owner injection, browser regressions and workspace navigation. Typecheck passed. Permission denial is a deterministic adapter check; actual host permission status and capture are qualified separately in the package without revoking user grants.

`result.json` and `native-actions.json` record the actual packaged native/Electron fixture workflow. Native AX input reached the selected AppKit window while the sentinel app remained foreground. Electron background text routes refused same-process multi-window ambiguity, and DOM values/events confirmed no input occurred. After explicit foreground reattachment, screenshot-based typing produced actual DOM input events and the Save button changed the visible result. This is not a claim that Electron background typing works.

A long native typing action was stopped after DOM events proved input had begun. The request returned uncertainty; the DOM stopped changing and no input was replayed. A fresh controller could attach after termination. WindowServer-observed movement caused stale coordinates to be refused; a closed target was refused. UI attachment, screenshot, release and moving the module were exercised in the package.

Hard interruption of foreground input can leave the target app foreground because the terminated native process cannot finish focus restoration. The receipt records the actual foreground PID after interruption. Only the AppKit background path is qualified to preserve sentinel focus. This integration does not synthesize compensating input or claim that interrupted foreground delivery is focus-neutral.

Native output is untrusted and bounded by the shared transport. Large screenshots can be refused by its existing response limit. Clipboard operations, global desktop targeting and arbitrary tool names are not exposed. The production integration is currently macOS with the admitted binary; other platforms remain unqualified.

Run `tests/acceptance/computer-control.mjs` with a fresh `--profile`, `--evidence`, packaged executable `--app`, installed Playwright module `--playwright`, and admitted Cua executable `--driver`. It compiles the existing disposable AppKit fixture, creates a separate Electron fixture window, and closes only its owned processes. Earlier qualification failures remain in temporary receipts; the committed result is the final verified run.

Final package: `/tmp/donwells-strengthen-16-package-final/mac-arm64/donwells.app`. ASAR SHA256 `f36d01e97db02754191159169f6bcbd760005689b0419ee7fad1a76d300f8f10`. Current-build byte comparison is in `package-bytes.txt`. The dark-theme control panel and exact attached fixture were visually inspected.
