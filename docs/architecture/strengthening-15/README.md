# Task 15: scoped browser testing

The existing ProjectTools service owns one optional Playwright MCP managed context per checkout. It binds to the registered local preview's webContents identity and URL. The testing dialog explicitly distinguishes this isolated browser from the human preview. Native agents use the existing project-memory MCP connection; no harness-specific browser integration or production dependency was added.

Inspect, type, click, screenshot, console errors, network, viewport measurements and trace operations are available. Callers cannot supply launch settings, arbitrary URLs, output paths or page JavaScript. Layout measurements use one fixed read-only expression. Current snapshot revision and element references are required before input and consumed before dispatch. Concurrent context actions are refused. Stop interrupts the owned process; uncertain input is never retried. Preview replacement requires a fresh managed context. Native target parameters are resolved again after asynchronous setup, fixing a shared transport race.

## Admission and boundaries

Explicit environment configuration: `DONWELLS_BROWSER_TOOL_PACKAGE` points to the admitted external `@playwright/mcp` directory; `DONWELLS_BROWSER_TOOL_EXECUTABLE` points to the admitted Chromium executable. Package 0.0.80 uses core/server 1.63.0-alpha-2026-08-31. Runtime verifies these SHA256 values:

- MCP cli.js: `70dab09ab9a5bc1943fb78e2655f00af7349f9931073833919f19c5d7d786ad6`
- coreBundle.js: `7aa0bf8b6b69d32065912e3d8f7e3c18c62de4d668f770a8e039811d3cf9c6a0`
- Chromium executable: `a596b1cfc6353e987fcec8d71a23a28cd6a9e7a6b4e20b908e4c4fcffe51158e`

The selected MCP/core packages are Apache-2.0; existing external distribution notices remain with their installations. Nothing is redistributed here. MCP LICENSE SHA256 is `9a7110fc2d2f964038e5dc49128f908f29f47a574c961cba16085914e879cbda`; core LICENSE is `45873d00a0dd243596deb4aa23b2493b3d1f0671921bf2538ea431d7380220eb`; core NOTICE is `6d602191187b35b9b01d2cffa01c8469c2c8d9de8a96f1bf868e0f264f51c81d`. Catalog installation belongs to Task 19.

Only identified localhost HTTP(S) previews are admitted. Personal-browser attachment and remote targets remain unavailable. The native allowed-origins configuration is not a network sandbox and does not prevent every redirect; the wrapper rejects observed navigation outside the selected origin. Do not interpret this as protection against arbitrary network activity by a preview application.

Artifacts remain in a private per-launch directory. Only canonical files under that directory are exposed, with hashes and size limits; native resource directories remain trace resources. Screenshots use absolute owned paths because this MCP version resolves explicit relative filenames against the checkout.

## Evidence

`checks.txt`: 28 passing focused checks, including real admitted MCP/browser operations, empty input, network output, stale references, concurrent requests, target change during setup, interruption and explicit restart. Typecheck passed.

`native-agent-result.json`: native OMP using local oMLX `Ornith-1.5-35B-A3B-MLX-8bit` repaired a real fixture's broken form, console error and horizontal overflow. Nineteen audited requests used context `2ca56386-d18e-4674-a6a1-3c4f060ee5bf`; two stale clicks were refused before dispatch. `native-order-proof.json` identifies actual ledger records proving the form TypeError occurred before the native edit and zero console errors after it. The final layout has no horizontal overflow; saved form text was independently checked. The native screenshot/trace/resources are retained with `artifact-hashes.json`. Raw agent reasoning and profile credentials are not included.

That native run used `/tmp/donwells-strengthen-15-package-current/mac-arm64/donwells.app`, ASAR `8f362c813ece76be7e7a1232173d4bfaf781e711b8aebcc2f25259f6811e6706`. Subsequent changes allow clearing text and improve testing-dialog presentation; the empty-input path was verified against the real MCP/browser, and the final package was rechecked separately. Do not confuse the two artifact hashes.

`packaged-ui-result.json` identifies the final package and source fingerprint. It verifies managed open/inspect/stop, preserved human preview, native geometry, navigation, focus, design capture, denied permission, download lifecycle, popup refusal, dialog occlusion, crash/retry and owned cleanup. `package-bytes.txt` compares the package to current build outputs. Actual composed-window screenshots are captured separately from native page images because Electron window capture omits WebContentsView surfaces.

Reproduce with the two admitted environment variables above: `pnpm exec vitest run tests/project-browser-tools.test.ts tests/project-tools.test.ts tests/project-memory-mcp.test.ts tests/browser-runtime-rpc.test.ts`. Run `tests/acceptance/browser-build-loop.mjs` with fresh profile/evidence paths and its explicit packaged executable, Playwright module and admitted tool paths. Run `tests/browser-view-smoke.cjs` with `--app` and `--playwright`. All fixtures use isolated profiles and stop only their owned services.

Final UI package: `/tmp/donwells-strengthen-15-package-ui/mac-arm64/donwells.app`, ASAR `b447f02cabbbb41cf8e4f88ed2858504662716fe4a2a0df3fb924234d75d3018`. The final composed dialog image was visually inspected; shared button styling and readable native diagnostics replaced the initial unstyled action row.
