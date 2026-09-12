# Native terminal

On macOS, choose **Settings → Terminal → Renderer → Native Ghostty**. The existing daemon continues to own the PTY. Changing renderer, moving a panel or restarting the GUI does not start a replacement agent. xterm remains available and is the default.

Build with `pnpm build:native-terminal` using Xcode command-line tools, Swift 6 and Zig 0.16.0. `package:prepare` includes this build. Generated checkouts, caches and binaries are ignored. The build currently targets the machine's architecture; cross-architecture packaging needs a matching native build.

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

The native path is verified by dispatching AppKit events through the actual native view: search, app shortcuts, switching and recovery, plus a real agent run without submitting a model request, on disposable projects and a separate app profile. It does not establish physical keyboard/pointing behavior or rendered Metal pixel quality on a locked desktop. The previous automated acceptance harness (`tests/acceptance/native-terminal.mjs`) was deleted on 2026-09-11 with the rest of `tests/` and `docs/`; no replacement exists yet.
