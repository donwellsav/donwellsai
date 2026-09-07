# Task26 — native terminal in the existing desktop host

## Delivered

Terminal settings now offer native Ghostty on macOS. Electron continues to host the editor, browser and project services; the daemon remains the sole PTY owner. Native input, resize, search, app shortcuts, overlay visibility, disconnect handling and retained-output recovery are wired into the app. The same session can switch between xterm and Ghostty. The renderer preference defaults to xterm so existing installations retain their working configuration.

This implements the scoped native-terminal addition under the user's continuous execution authorization. It does not retire Electron, replace the installed/running app, or claim an entire host migration was qualified.

## Research and choice

| Candidate | Inspected revision | Outcome |
|---|---|---|
| [libghostty-spm](https://github.com/Lakr233/libghostty-spm/tree/e47b20a860d464ac7ecb9c1eec01612cc6b178a5) | e47b20a | Selected: actual AppKit/Metal surface with external in-memory transport, native selection/input and resize delegation. |
| [electron-libghostty](https://github.com/philipp-spiess/electron-libghostty/tree/5003e497f12c5046a015a0da798894662f164c6c) | 5003e49 | Useful native embedding precedent; inspected bridge creates executable-backed surfaces and lacks the required external PTY transport. Not adopted as-is. |
| [Tauri](https://github.com/tauri-apps/tauri/tree/10541070c14eef653ba1795e9875149c55ce963e) | 1054107 | Credible host alternative. A port would replace Node/preload and Chromium browser integration as well as windowing. No representative full Tauri port was completed, so no comparative performance win is claimed. |
| [Termini](https://github.com/arach/Termini/tree/d212b998f53645784c6ebd6e35f362e8411988d5) | d212b99 | Native transport-oriented alternative; selected wrapper exposes the needed controller and surface callbacks with the current integration. |
| [ghostling](https://github.com/ghostty-org/ghostling/tree/63842bf8e5e481160f81d348da9ff6fd27986798) | 63842bf | VT demonstration rather than the full embedded native Metal host needed here. |

Earlier Electrobun work is not treated as proof the whole framework fails: a corrected Node-backend route remains distinct from the failed Bun PTY read route. Replacing the complete host is not needed to deliver this task's concrete native terminal capability.

## Source and rights correction

The wrapper's prebuilt binary contained gettext symbols after linking. It was replaced with a reproducible build of matching Ghostty core `c4e16970a803b170e352432424f44192cb59f3ac`, using upstream `-Di18n=false`. The build rejects gettext symbols in the resulting library. This is stronger evidence than the wrapper README's MIT description.

Exact pins, included notices, the explicitly admitted MPL z2d component and bundled corresponding source are documented in [native/ghostty/README.md](../../../native/ghostty/README.md). MIT/Apache preference is not misrepresented as every transitive component having those licenses.

## Evidence and limits

- TypeScript checks passed; four focused existing test files passed, 19 tests total (stream ordering, attention and settings).
- The source build and unsigned arm64 package completed. The package is isolated at `/tmp/donwells-pass2-26/final-package/mac-arm64/donwells.app`.
- [Packaged integration result](native-integration.json) records package/native-library hashes and nine checks: native TUI, input, exact search count, unobscured command palette, same-PID renderer switching, real OMP unsubmitted input, editor/browser/memory coexistence and GUI-crash recovery.
- OMP received native input but no prompt was submitted; no model quality, local provider integration or hosted inference is claimed.
- The Mac was locked. AppKit events were dispatched through the real native view in process. Physical input, pointer selection and Metal pixel inspection remain for the unlocked desktop; no screenshot is substituted for them.
- The browser location must reach the existing saved-layout store before a forced crash. Its current 400 ms debounce window is carried to Task08.
- Trial mistakes are retained as such: an obsolete palette selector and a crash before the debounced browser layout save caused failed checks. They were corrected without changing the app to satisfy a false expectation.
- Disposable agent sessions, app and daemon were cleaned up. The user's running application was not touched.

## Recovery implementation, 2026-09-07

The rebuilt plan reopens recovery work rather than treating the earlier package receipt as complete acceptance. Source review found that an initial native attach failure left `ready` false, hiding the only retry action. The native error panel now always offers Retry and a direct **Use xterm for existing sessions** action. Retry uses the existing idempotent create/attach boundary, so it works whether loading failed before surface creation or attachment failed afterward. Fallback changes the existing renderer preference and preserves daemon session identity; it does not start a replacement shell.

Native surface lifetime also now rejects a late resize failure after that surface was replaced. Teardown removes its subscription/owner entry even if the native destroy call reports an error, allowing sibling surface cleanup to finish. A native destroy failure remains logged; releasing bookkeeping alone is not proof that faulty native code released all platform resources.

The pinned [GhosttyKit host-managed integration](https://github.com/Lakr233/libghostty-spm/blob/e47b20a860d464ac7ecb9c1eec01612cc6b178a5/README.md) was refreshed for this decision. Its in-memory backend supports keeping the host's session ownership; no new library, wrapper upgrade or native binary rebuild was necessary.

Validation: `tests/native-terminal-lifetime.test.ts` passes three focused regressions covering retry on the same surface/session, stale resize rejection and cleanup continuation. Typecheck and source build pass. An isolated development Electron instance injected one initial native-create failure at IPC, clicked the real Retry button successfully, then exercised the real visible xterm fallback and typed into the retained shell. Exactly one unchanged session ID and previous scrollback were retained. This does not establish OS PID equality because the public terminal-list response has no PID; earlier packaged PID evidence remains historical.

Open acceptance: physical keyboard/pointer selection and rendered Metal inspection, final packaged recovery after later GUI changes, and any remaining search/clipboard parity issues observed in that real journey. The isolated app is shared with the owning GUI task for review and then cleaned up by its runner; no user application or VM was used. Task02 remains skipped.
