# orca-lite

Minimal working Orca: run CLI agents side-by-side in git worktrees, each with its own terminal. A small, single-process Electron app — Orca's product core without the relay daemon, mobile/E2EE, automations, integrations, or embedded browser.

## Stack

- Electron 44 (contextIsolation + sandbox, node-pty for terminals)
- React 19 + Zustand, xterm 6 (panes mount once, hide via CSS)
- electron-vite 5, vitest, Node 24, pnpm 10

## Commands

```sh
pnpm install      # first time (rebuilds node-pty via onlyBuiltDependencies)
pnpm dev          # dev mode with hot reload
pnpm build        # production build → out/
pnpm smoke        # build + e2e smoke: boots the real app, exercises git +
                  # PTY surfaces against a temp repo, exits 0/1
pnpm test         # unit tests (git porcelain parser, store persistence)
pnpm typecheck    # tsc on both main and renderer configs
```

## How it works

- **Filesystem is truth.** Worktrees are re-discovered live from `git worktree list --porcelain` on every repo refresh; the JSON store persists only user intent (repo list, agent command).
- **Terminals never touch React.** Main owns PTY sessions (node-pty), streams via IPC; the renderer's `terminal-bus` buffers output per session (512 KB replay) so panes hidden behind other worktrees keep their scrollback.
- **Main worktree** of a repo renders as a card too (path == repo root); branch/HEAD labels come from the porcelain output.

## IPC surface

`meta | listRepos | addRepo | removeRepo | refreshRepo | createWorktree | removeWorktree | openTerminal | closeTerminal | terminalWrite | terminalResize | listAgents | pickDirectory | on` — events: `terminal:data | terminal:exit | terminal:title | worktree:changed`.

## Test seams

- `ORCA_LITE_SMOKE=1` — main runs the in-app probe (`src/main/smoke-probe.ts`) after window load, prints `smoke:ok` / `smoke:fail`, exits.
- `ORCA_LITE_USER_DATA=<dir>` — overrides `app.getPath('userData')` so tests never touch real settings.

## Deferred (tinker later)

Settings UI, split panes, SSH relay, daemon persistence across quit, agent presets, worktree auto-rescan on external git changes.