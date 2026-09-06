# Terminal and layout trial

This is an isolated browser fixture for choosing the rebuilt GUI's foundation. It is **not the new product GUI**, a live terminal agent, or a replacement for native/installed acceptance. The final workspace will replace the existing GUI from scratch using #16161D, with native agents as the main interaction and movable tools around them.

The fixture creates two real terminal renderer objects and an unsaved Monaco model. Layout changes move their DOM hosts while preserving renderer ownership. FlexLayout and Dockview use the same content. It compares actual SearchAddon activation and text search against xterm and Ghostty Web.

Run from this directory after the main repository's frozen dependency setup:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run dev
```

Use npm here to keep the trial's lockfile/dependencies separate from the parent pnpm workspace. The trial reuses the parent's Vite, React and xterm packages. Trial engine releases and integrity values are in `admission.json`; the trial does not change the production manifest.

From the Git root, with an installed Playwright module:

```sh
node tests/acceptance/terminal-layout.mjs --playwright /absolute/path/playwright/index.mjs --evidence /tmp/donwells-layout-new
```

The runner exercises 100 terminal moves for xterm/FlexLayout, Ghostty/FlexLayout, then xterm/Dockview, checks object identities and marker preservation, records search results, captures screenshots, and checks 1280×800 overflow. Automation click timing includes Playwright overhead and must not be presented as terminal input latency. Search failure blocks a candidate even when movement checks pass. Exit status reports whether the experiment ran successfully; candidate admission is reported separately.

The scratch check types into Monaco and verifies its model and unsaved draft through 102 moves. Supply `--app /absolute/donwells.app/Contents/MacOS/donwells` to reuse the same two packaged-daemon PTYs across candidates. The native comparison checks selection, search, link activation without navigation, Unicode, resize, alternate screen, multiline paste and SGR mouse input. The trial enables xterm screenReaderMode and checks accessible output; native IME composition and VoiceOver navigation remain unqualified. Four actual agent TUIs, drag gestures, persisted-layout migration and final Electron composition remain separate integration gates. The main app's existing tests remain authoritative until those integrations pass.

Native runs include 200 idle and 200 4-KiB-burst echo samples per accepted layout and 200 alternating terminal focus samples. Echo timing includes the test bridge, so compare candidates within this trial; do not equate it with the packaged renderer IPC baseline or physical keyboard-to-display latency. Candidate rejection is distinct from experiment failure.
