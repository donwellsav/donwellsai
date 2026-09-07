# donwells.ai

donwells.ai is a local desktop workspace for parallel agent development across Git worktrees and folders. Reconnectable terminals, a full editor and review surface, an embedded browser, and operational runs share one desktop and CLI interface.

## GUI

The donwells.ai workbench combines persistent workspace organization and split terminals with Explorer, Quick Open, Monaco, rich Markdown, source control, snapshot-bound review notes, and bounded image/PDF viewers. Settings cover agents, editor, source control, browser and media, appearance, terminals, shortcuts, notifications, privacy, and advanced behavior. Semantic light/dark themes and native interface scaling apply without restarting.

## 0.4.0 changes

- Keyboard commands transfer focus into side panels and remain available while editing. The installed keyboard acceptance covers shared-project agents, handoffs, memory, search/edit/save, build evidence and restart continuity.
- macOS Finder launches discover standard Homebrew and user CLI installations while preserving an explicit PATH. Custom installation locations still require an explicit PATH or executable.
- Project tool settings provide pinned optional downloads with sizes, SHA-256 and removal instructions. Tools and models remain separate installations; installed semantic retrieval is tested with external networking denied.
- Managed browser-service crash recovery removes its private Chrome process before starting a fresh context.
- Production dependency notices are generated and verified during packaging. PDF preview uses Chromium canvas without shipping unused Node canvas binaries.
- The controlled 0.3.0 → 0.4.0 → 0.3.0 → 0.4.0 check preserves SQLite revisions, terminal identities, source files and the migration backup. Export a project kit before changing versions.

Installed-release evidence and remaining qualification limits are in [Task 22](docs/architecture/strengthening-22/README.md). The local macOS ARM64 DMG is Developer ID signed; notarization is not configured. This is a local review artifact, with no automatic publishing or update delivery.

## 0.3.0 changes

- Unified product identity, validated settings, semantic themes, native scaling, and explicit profile recovery.
- Durable workspace and split layouts; Explorer, Quick Open, editor/Markdown navigation, browser recovery, and bounded media viewers.
- Registered-workspace Git authority, snapshot-bound review notes, confirmed Design Mode attachments, and ownership-checked skill packages.
- Provider discovery and hook support; finished agent output remains available until dismissal. Closing a live agent stops it before removing its tab.
- Scheduled and parallel finite jobs with durable histories, bounded concurrency/output, cancellation, selective retries, and truthful signal-exit failures.
- Desktop and CLI commands share validation and authority checks. Third-party copyright and source attribution remain in `resources/THIRD_PARTY_NOTICES.txt`.
- Bounded Commands/Files/Everywhere palette with contextual availability and configurable platform shortcuts. Everywhere searches projects, workspaces, retained sessions, open panes, recent files, and cached workspace file results.
- Folder-aware workspace home; Git-only worktree selection retains the draft on failure. Project removal unregisters app state without deleting files and blocks unresolved local work.
- Searchable Agents supervision opens the exact retained terminal, including sessions created outside the renderer. Status and attention presentation use daemon-owned liveness.
- Durable attention inbox retains unread permission, input, completion, failure, and contact events. Only revealing/focusing the exact terminal acknowledges its captured event version; app focus alone does not. Tray/Dock indicators reflect unread attention.
- Crash-safe editor checkpoints retain unsaved buffers and cursor/scroll state. Recovery exposes restore/discard and persistence failures; disk changes produce a save conflict rather than overwriting recovered work.
- Project-scoped back/forward history and recent-location switching survive restarts.
- Shared project memory provides searchable decisions, conventions, facts, procedures, and gotchas through the UI, CLI, and project-pinned MCP clients, with revision checks, provenance, history, and archive/restore.

## Architecture

- Electron 44 + React 19 + Zustand 5 + xterm 6 + node-pty; contextIsolation + sandbox on.
- **Terminal daemon** (`src/main/terminal-daemon.ts`): a detached process owns the PTYs; the app is a reconnectable client (unix-socket NDJSON + auth token, 512 KiB scrollback replay). Agents survive app restarts.
- **Runtime RPC** (`src/main/runtime-rpc.ts`): NDJSON over `donwells.sock`; discovery in `donwells-runtime.json` (socket path + auth token). The CLI drives the same surface as the UI.
- **CLI** (`cli/donwells.mjs`): a shared command catalog drives workspace, terminal, agent, file, editor, Git, review, browser, skill-package, settings, and operational-run services. Commands use the same validation and authority checks as desktop IPC. Use `--help` for the command surface and `--text` for readable output.
- Persistence: atomic, versioned local state separates workspace intent from daemon-owned process facts. Panes, layouts, settings, browser history, review notes, skill manifests, and run histories persist. Contact loss is `unverifiable`, never evidence of process exit.
- Worktree engine: registered local authority, fingerprint-gated scans, name retirement, delete-to-Trash safety fences, and lineage. Folder workspaces remain usable without Git; remote execution is rejected rather than silently performed locally.

## Coding harness memory

Open **Memory → Connect harness** for a copyable configuration using the installed executable and selected project. Adapt the JSON server definition to your harness format; no harness configuration is changed automatically. Keep donwells.ai running. Each client uses `donwells memory-mcp --workspace <registered-workspace> --harness <identifier>` (optionally `--user-data <profile>`).

Git worktrees resolve to their registered project root; separate folder projects remain isolated. MCP exposes search, read, record, replace, revision history, and archive/restore against the same local authority as the UI. Writes carry self-reported harness/session/source attribution, not a separate security identity. Updates and archive/restore require the exact current revision. No transcripts, repository files, credentials, or remote service calls are imported automatically.

## Profile recovery

Existing profiles are not copied automatically. `node scripts/profile-recovery.mjs --help` describes the read-only inventory and explicit recovery controls. The state file is JSON with `schemaVersion: 1`, a `classes` array (`id`, relative `path`, `format`: `file`/`json`/`directory`, and `encryption`: `none`/`encrypted`), and `activeMarkers` listing the relative runtime/lock paths for both profile owners. Shut down both owners before applying; stable files alone do not prove their writers have stopped. Recovery transfers one selected class to an absent destination, preserves unknown state and collisions, checks declared activity markers and stable snapshots, and requires the exact destination. Encrypted state is refused; successful transfers produce a digest-bound rollback receipt.

## Local packaging

`pnpm package:dir` builds the local application bundle; `pnpm package:mac`, `pnpm package:linux`, and `pnpm package:win` define platform artifacts. The macOS build is unsigned unless release signing is deliberately configured. The bundled `Contents/Resources/bin/donwells` launcher runs the CLI without a separate Node installation.

## Development

```
pnpm install
pnpm dev          # dev server + electron
pnpm smoke        # build + headless smoke test (real git repo + real PTY)
pnpm test         # vitest
pnpm typecheck    # main, renderer, and CLI
```

Debug build: `pnpm build` then `npx electron --remote-debugging-port=9334 out/main/index.js` (userData lives in `~/Library/Application Support/donwells.ai`).
