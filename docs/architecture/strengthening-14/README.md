# Task 14 strengthening: main-owned browser previews

The app now owns each preview with Electron WebContentsView. Native content stays in the existing persist:donwells-browser partition; renderer controls reuse the existing navigation, history, find and design-capture controllers through a bounded IPC port. No browser engine or package dependency was added.

Renderer requests require the main application frame, registered workspace, current instance identity and a supported intent. Arbitrary page code is not a renderer operation; existing authorized browser.eval RPC resolves the specific project target in main. Native navigation permits HTTP(S), denies popups and retains the existing permission-denial policy. Main owns disposal on renderer/window teardown; async creates are fenced against changed ownership.

Native views cannot participate in DOM z-order. Find/design status reserve space above the page. Visible overlapping dialogs, menus, suggestions, design review and drag overlays hide the native surface. Offscreen FlexLayout drag previews do not hide it. Native page background remains white so unstyled black text is readable; workspace theme remains unchanged. Closing a preview tab preserves the existing retained-pane behavior and hides its guest; removing its host disposes the guest without deleting the partition.

## Evidence

`checks.txt`: browser navigation/runtime/RPC/history/design and shared navigation regressions. Typecheck passed. `package-bytes.txt`: 718 built application files and 31 external resources match the verified package.

Package: /tmp/donwells-strengthen-14-package-verified/mac-arm64/donwells.app. ASAR SHA256 `e1fbdf778ff62318ac105f75455b3d38cc4c68b408947c988857134e3dc7b8da`. Local unsigned qualification; no publishing.

`result.json`: actual package, main-owned guest identity, no webview element, resize clipping, back/forward, retained input and guest ID across two projects, find, a key event delivered directly to native webContents for Cmd+L, design element selection plus bounded screenshot, geolocation denial, download lifecycle, renderer arbitrary-intent denial, real modal dialog occlusion, popup denial, renderer crash/retry, closed tab hiding and owned daemon cleanup all pass.

Download qualification intercepted and canceled a local fixture download after the native will-download event; it proves hosting compatibility, not a completed file download. The screenshot check uses native guest capture; the review image stays local as before.

`native-preview.png` is a macOS window-region capture, visually inspected with the actual page visible; `native-page.png` is the native guest capture. BrowserWindow/renderer capture omits native child views and was rejected as composed-window proof. A computer-use selection briefly opened a default-profile app window during inspection; only that newly launched process was closed and no settings were edited. All automated acceptance runs use new isolated profiles.

Run `node tests/browser-view-smoke.cjs --app <packaged executable> --playwright <installed playwright index.mjs>`. This creates fresh profile/evidence directories and runs the complete packaged acceptance sequence. The obsolete webview-only smoke was replaced after native parity passed.

Electron primary references: [WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view), [View bounds, visibility and ordering](https://www.electronjs.org/docs/latest/api/view).
