# Terminal and layout trial

This is an isolated browser fixture for choosing the rebuilt GUI's foundation. It is **not the new product GUI**, a live terminal agent, or a replacement for native/installed acceptance. The final workspace will replace the existing GUI from scratch using #16161D, with native agents as the main interaction and movable tools around them.

The fixture creates two real terminal renderer objects and an unsaved scratch textarea. Layout changes move their DOM hosts while preserving renderer ownership. FlexLayout and Dockview use the same content. It compares actual SearchAddon activation and text search against xterm and Ghostty Web.

Run from this directory after the main repository's frozen dependency setup:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run dev
```

Use npm here to keep the trial's lockfile/dependencies separate from the parent pnpm workspace. The trial reuses the parent's Vite, React and xterm packages. Trial engine releases and integrity values are in `admission.json`; no engine was added to the production manifest.

From the Git root, with an installed Playwright module:

```sh
node tests/acceptance/terminal-layout.mjs --playwright /absolute/path/playwright/index.mjs --evidence /tmp/donwells-layout-new
```

The runner exercises 100 terminal moves for each renderer/layout pair, checks object identities and marker preservation, records search results, captures screenshots, and checks 1280×800 overflow. Automation click timing includes Playwright overhead and must not be presented as terminal input latency. Search failure blocks a candidate even when movement checks pass. Exit status reports whether the experiment ran successfully; candidate admission is reported separately.

The scratch assertion currently checks unaffected sibling content; it does not qualify moving an actively edited Monaco model. Native PTY identity, four real agents, IME, keyboard/VoiceOver, drag gestures, persisted-layout migration, recovery and Electron browser view composition are still required. The main app's existing tests remain authoritative until those integrations pass.
