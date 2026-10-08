# Native terminal

**Ghostty is the default terminal on macOS.** The pane renders the vendored libghostty surface (`resources/native/ghostty.node`), and the existing daemon continues to own the PTY: moving a panel, changing renderer, or restarting the GUI never starts a replacement agent.

**A package cannot ship a dead terminal.** `package:check` loads the built module and requires its `request`/`listen` entry points, so a present-but-uninitializable Ghostty fails packaging instead of reaching users (loading also resolves `libDonwellsGhostty.dylib` through dyld, which proves the whole native stack is usable). CI provisions the pinned Zig toolchain via `scripts/install-zig.mjs`, builds the native surface on macOS, and runs `package:check` plus an E2E case that asserts the default renderer really is Ghostty.

**Settings → Terminal → Renderer** selects the surface:

- **Ghostty (native)** — the default. Used only when the native module actually loads.
- **xterm** — the previous renderer, for anyone who needs it.

**Ghostty keybinds drive app commands.** A `keybind = cmd+t=new_tab` line in that file runs the matching app command - `new_tab`/`new_window`, `close_surface`/`close_tab`, `new_split:right|down|left|up|auto`, `toggle_command_palette`, `search`, and `goto_tab:N` for the numbered tab commands the app defines. Terminal-level actions (`copy_to_clipboard`, `paste_from_clipboard`, `select_all`) stay with the embedded surface rather than being duplicated here. Actions with no equivalent are not intercepted and currently do nothing: `increase_font_size`/`decrease_font_size`/`reset_font_size` and `toggle_quick_terminal` remain unwired.

**An existing Ghostty configuration applies.** With **Settings → Terminal → Use my Ghostty config** on (the default), `~/.config/ghostty/config` (or `$XDG_CONFIG_HOME/ghostty/config`) is applied for everything Settings does not manage — keybinds, mouse behaviour, shell integration. Options the app manages — font, features and variations, colours, theme, cursor, scrollback, clipboard — come from Settings, so the UI stays authoritative and the file cannot silently override it. The file is re-read for each new terminal, so edits apply to the next one.

If the native module is missing or cannot load (unsupported platform or architecture, a packaging gap, or a failed probe), panes fall back to **xterm automatically** rather than presenting a surface that cannot draw. The fallback is never silent: the Renderer setting shows the reason the pane fell back. Availability is decided once in the main process (`nativeTerminalAvailability`) and consumed through the pure resolver in `src/renderer/src/terminal-renderer.ts`.

Build with `pnpm build:native-terminal` using Xcode command-line tools, Swift 6 and Zig 0.16.0. `package:prepare` includes this build, and `package:check` fails if the artifacts, resource bundle or their dynamic dependencies are missing or nonportable. Generated checkouts, caches and binaries are ignored. The build targets the host machine's architecture only; cross-architecture packaging needs a matching native build, so a universal macOS artifact is **not** produced today.

The build pins:

- [libghostty-spm](https://github.com/Lakr233/libghostty-spm/tree/e47b20a860d464ac7ecb9c1eec01612cc6b178a5), MIT.
- [Ghostty core](https://github.com/ghostty-org/ghostty/tree/c4e16970a803b170e352432424f44192cb59f3ac), MIT, with the pinned wrapper's external-I/O patch stack.
- MSDisplayLink 2.2.0, MIT; exact commit is in `Package.resolved`.

`host-integration.patch` forwards upstream search callbacks and resolves resources relative to the installed application. Remove those patch sections when the wrapper provides equivalent public hooks. The application supplies native view bounds, configuration, app shortcuts and daemon I/O; it does not implement a second PTY service.

The wrapper's prebuilt XCFramework is **not used**: its linked library included gettext symbols. The source build passes Ghostty's existing `-Di18n=false` and rejects a final library exporting gettext symbols. This excludes Ghostty's gettext-based UI translations, not Unicode terminal input. The wrapper's own MIT shell resources are used; upstream GPL shell integration scripts are not copied into the application.

## Dependency admission

This native path is not described as exclusively MIT/Apache. The following bounded exceptions are admitted explicitly for the selected terminal:

- z2d at `7dbae85c81784dba9988320bf9543ed9a81350c8` uses MPL-2.0, including its stated Cairo/Pixman notices. The exact compiled source from the pinned dependency archive and its license are included at `Contents/Resources/native/notices/z2d-source`. No local z2d modifications are made.
- JetBrains Mono uses SIL OFL 1.1. Its license is included with the embedded font.
- Oniguruma, zlib/libpng, Highway's BSD material and Unicode data retain their respective notices. FreeType is admitted under FTL, not its alternative GPL terms; its attribution is included even though unused font-backend code is removed from the linked native library. Portions of this software are copyright © The FreeType Project (www.freetype.org). All rights reserved.
- simdutf 9.0.0 is used under MIT. Wuffs uses its MIT option. The remaining Zig/runtime helper notices and MSDisplayLink/wrapper/core licenses ship beside the library.

The files in `notices/` were taken from the exact core dependency archives, except z2d and uucode's omitted license files, which came from their pinned upstream commits, and simdutf's MIT text from v9.0.0. A changed core pin requires revisiting this list and the corresponding-source archive.

## Focused check

The native path was historically verified by dispatching AppKit events through the actual native view: search, app shortcuts, switching and recovery, plus a real agent run without submitting a model request, on disposable projects and a separate app profile. The previous acceptance harness (`tests/acceptance/native-terminal.mjs`) was deleted on 2026-09-11 with the rest of `tests/` and `docs/`.

Automated coverage now lives in:

- `src/main/native-terminal-config.test.ts` — the settings→Ghostty configuration contract, including that a hostile font family cannot add a configuration line.
- `scripts/check-package.mjs` — the built module must load and expose `request`/`listen`.
- `e2e/workspace-editor.e2e.ts` → `renders the native Ghostty terminal by default` — availability, the native surface, no xterm fallback, repeated create, and no native error banner.

Still not covered: physical keyboard and pointing behaviour, rendered Metal pixel quality on a locked desktop, and the native search field, which is an AppKit view outside the DOM.
