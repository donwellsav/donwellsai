# donwells.ai

Minimal working Orca: run CLI agents side-by-side in git worktrees, each with its own terminal. A small, single-process Electron app — Orca's product core without the relay daemon, mobile/E2EE, or integrations.

## GUI

Orca's shell, rebuilt from its real design tokens: 36px titlebar with embedded terminal tabs, left worktree sidebar (repo-grouped cards with status dots), center terminal workbench with split panes, right sidebar (Explorer / Git), bottom status bar. Zinc dark theme (`#0a0a0a` canvas, `#2a2a2a` sidebar), Geist type, 10px radii.

## Architecture

- Electron 44 + React 19 + Zustand 5 + xterm 6 + node-pty; contextIsolation + sandbox on.
- **Terminal daemon** (`src/main/terminal-daemon.ts`): a detached process owns the PTYs; the app is a reconnectable client (unix-socket NDJSON + auth token, 512 KiB scrollback replay). Agents survive app restarts.
- **Runtime RPC** (`src/main/runtime-rpc.ts`): NDJSON over `donwells.sock`; discovery in `donwells-runtime.json` (socket path + auth token). The CLI drives the same surface as the UI.
- **CLI** (`cli/donwells.mjs`): `node cli/donwells.mjs status`, `repo-add <dir>`, `wt-create <repoId> <name>`, `git-status <path>`, plus agent browser control — `browser-list`, `browser-open <worktreePath> <url>`, `browser-snapshot <path>` (url/title/readable text), `browser-navigate <path> <url>`, `browser-eval <path> '<js>'` — so agents in terminals can read and steer the embedded browser. `--text` for pretty output.
- Persistence: one JSON file in userData (`donwells-data.json`) holding user intent only (repos, settings); worktree state is derived live from git.
- Worktree engine: fingerprint-gated scan cache, name retirement, delete-to-Trash with safety fencing, lineage tracking.

## Development

```
pnpm install
pnpm dev          # dev server + electron
pnpm smoke        # build + headless smoke test (real git repo + real PTY)
pnpm test         # vitest
pnpm typecheck    # both tsconfigs
```

Debug build: `pnpm build` then `npx electron --remote-debugging-port=9334 out/main/index.js` (userData lives in `~/Library/Application Support/donwells.ai`).
