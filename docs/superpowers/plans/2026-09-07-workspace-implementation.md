# Workspace implementation work packages

Planning only. These packages supply implementation detail for the corresponding cards in `2026-09-07-rebuilt-01-26-plan.md`; that file owns scope, status, order and authorization. Existing symbols below were inspected in the current checkout. Proposed changes are instructions, not claims of implementation. Complete packages in working increments; combine adjacent edits when they share an owner, but report acceptance against each task.

## 01 — Preserve the search correction and establish ownership

1. Read the committed addon correction, `pnpm-workspace.yaml`, lockfile and `TerminalPane.tsx`. Retain the shared search-cache invalidation fix unless the selected upstream version contains the equivalent correction. Do not roll back the application or recreate a baseline.
2. Assign unrelated dirty Kimi files to07. Stage named owned paths only. Record the existing correction commit and exact upstream removal condition in the existing task decision file.
3. Use the overwrite/search case in `tests/acceptance/terminal-recovery.mjs` only if changing the correction; reuse applicable evidence when the same source is retained. Search after overwriting one terminal line must find the replacement and reject old text without replacing the PTY.

Exit: correction accounted for, no unowned changes staged, no fresh testing campaign masquerading as new product work.

## 26 — Establish the host without creating a second runtime

**Decision:** Continue Electron + selectable native Ghostty/xterm as the implementation route. Electron already hosts the browser, Monaco and daemon client; Ghostty changes presentation, not ownership. Tauri remains a bounded challenger, not a mandatory second application. Compare the admitted native build with current upstream before modifying it. A host switch must demonstrate a specific improvement and retain every consumed interface below.

**Existing boundary:** `src/main/native-terminals.ts` and `native/ghostty/Sources/DonwellsGhostty/DonwellsGhostty.swift` host native views; `NativeTerminalPane.tsx` supplies bounds/visibility; `src/shared/terminal-stream.ts` supplies stream semantics; the daemon owns node-pty. `scripts/build-native-terminal.mjs` owns assembly and notices.

1. Keep one PTY per session when switching renderer. Persist renderer preference separately from session identity; an unavailable native library offers xterm on the same live session and an actionable native-loading error.
2. Finish native composition at the existing bounds/visibility boundary: opening a menu/dialog hides or clips the native view correctly; moving/splitting it updates bounds; restoring focus targets the selected resource only. Never send a key merely to test focus.
3. Preserve search, selection, copy/paste, resize, scrollback and theme across the supported renderers. Make unsupported behavior explicit instead of silently changing agent interaction.
4. If a Tauri comparison remains necessary, build one disposable host slice containing the same daemon session, an unsaved editor and a stateful browser. Compare idle resource use and focus/reconnect behavior with the existing isolated Electron package. One corrected attempt per specific failure; stop the trial when it cannot preserve a required ownership boundary. Record a rejection or a full migration delta, not a parallel production shell. Do not install/build this trial during planning.
5. Preserve the existing admitted native source and transitive notices, including z2d MPL source obligations. Re-run the focused native check only for native-boundary changes; require actual physical input/visual evidence for the final native interaction clauses.

**Migration:** no PTY migration. A host replacement, if justified, must import the existing profile/layout without mutating its source and reconnect by actual session ID. Keep the old executable/profile recoverable until the candidate works. Failure cannot authorize a new session disguised as reconnection.

## 04 / 03 — Connect engine configuration to actual owners

**Existing flow:** `ProjectTools` receives canonical `ProjectToolScope`; `ProjectDoctor` validates configuration and artifact paths; `ProjectToolsSettings.tsx` displays it; generated native MCP configuration routes through `src/cli/project-memory-mcp.ts`. Task23's concrete engine adapters extend this flow.

1. In04, retain preparation cancellation and stopping-until-exit behavior. Add endpoint lifecycle only for selected services that need it. An external endpoint's disconnect must never kill an unowned service. For locally owned services, retain PID/process-group ownership and bounded output.
2. Preserve the account-level code-graph coordinator and per-checkout index identity. Do not restore the proven-broken one-coordinator-per-project cache arrangement.
3. In03, complete configuration and connection for the existing facts/documents/code engines and expose the role matrix. The Hindsight/Graphiti/DuckDB configuration fields and connected readiness are implemented with their adapters in23 and surfaced in19; they cannot block03 on its own downstream task. Reuse this parser/settings boundary for those later inputs. Store credentials through the existing protected configuration route, never in exports or status text. Enabling means configuration is saved; readiness means an actual supported connection succeeds. Keep these states distinct.
4. Keep `auto`, `lexical` and required `hybrid` semantics. `project_engines` reads state without starting optional models/services. Stop/disable flows through04, not an independent settings-owned child process.
5. Demonstrate configure → native tool query → disable → same terminal and canonical memory. Extend the existing project-tools/doctor/documents checks only at changed boundaries.

**Failure:** cancellation during prepare prevents a late launch; changing configuration invalidates its prior admission; stop in project A cannot stop B. Invalid remote credentials produce a setup error, not automatic fallback to a paid provider.

## 05 — Rebuild the visible shell

**Current gap:** `WorkspaceShell.tsx` puts projects and sessions in competing vertical sections; the sessions section is capped. Its icon rail duplicates the six horizontal tabs in `RightSidebar.tsx`. This is a structural replacement of those presentations, with working resource owners retained.

1. Rewrite `WorkspaceShell.tsx` and `workspace-shell.css` around a resizable left column (initial224px), the terminal work area and a labeled right tool rail (initial68px). Left: compact active project/checkout switcher, expandable project picker, sessions taking remaining height, one Add Agent control, bottom environment/settings access. Show agent/provider and attention state in session rows; do not repeat the project name over every terminal.
2. Replace `RightSidebar.tsx`'s horizontal tab navigation with one active tool title plus move/close controls. The right rail is the sole selector for Files, Changes, Search, Knowledge, Runs, Control and Recovery. Map these to existing tool components and commands; do not create a second tool state store. Runs and Knowledge may expose local subviews inside their content, not new app-wide headers.
3. Set the main surface token to `#16161D` in `main.css`; use related neutral surfaces, restrained status/accent colors and readable existing fonts. Apply tokens to shell, dock tabs, editor and both terminal renderers. Remove obsolete shell selectors when replacing markup.
4. Keep one tab row per actual split in `Workbench.tsx`. Move global layout, project and tool actions into side controls. At narrow width collapse the project picker and show one chosen tool surface; do not shrink every pane below usable width. Preserve a visible route to restore hidden panels.
5. Update every focus caller of `focusPaneTarget` in `navigation-controller.ts`, store actions and command routes. Removing `[data-right-sidebar-tab]` requires replacing the store's focus target with the active rail/tool target in the same change. Closing tools, selecting the already-active session and closing a command menu must return typing to the intended terminal.

**State/migration:** keep existing project/session IDs, widths and layout model. Clamp obsolete dimensions on load. No new layout schema is needed just for markup. No data rollback.

**Product demonstration:** two different agents, populated project list, real tool content, narrow and wide windows. Select a session, open Files, move it, close it, type into the same session. Record terminal rows/usable area before and after. The existing HTML proposal is enough design input; do not spend another run producing a mockup instead of implementing.

## 06 — Move views while retaining resources

**Existing flow:** `Workbench.tsx` retains portal hosts by pane ID and reparents them into FlexLayout slots. `workspace-layout.ts` persists version1 models plus hidden references. `editor-models.ts` caches Monaco documents; `EditorPane.tsx` uses `VersionedEditorSave` and recovery checkpoints. These are the owners to extend.

1. Route move/split/hide/restore through existing layout actions. Close-view hides the reference; stop-session is a separate deliberate action. Reuse stable pane references rather than creating another resource for a move.
2. Preserve unsaved tool drafts when `RightSidebar` content moves into the workbench. Lift only the affected draft state to its existing project component/store owner, keyed by project and item ID. Do not globally persist every component state.
3. Keep native terminal and browser host visibility synchronized with the selected dock slot. Focus follows the resource after movement; a pending focus callback checks current overlay and active-pane state again.
4. Flush layout persistence at the existing close/navigation boundary and preserve editor recovery checkpoints. On restore, reconcile saved references with actual resources: reconnect retained sessions, show missing-resource entries, and offer explicit replacement. Never fabricate a live resource from a label.
5. Exercise move → hide → restore → GUI restart using one running terminal, unsaved editor and stateful browser. A GUI restart may reload browser page content; preserve its configured URL/storage and say when an unsaved page form cannot be recovered. No promise to serialize arbitrary websites.

**Focused regression:** extend `tests/workspace-layout.test.ts` for stale/hidden references and the existing lifecycle check for the actual changed resource owner. Terminal daemon identity, editor buffer/version and browser instance during in-process moves must remain stable.

## 14 — Project preview identity and storage

**Observed gap:** `BrowserViews` already owns `WebContentsView` and validates `key`/`instance`/generation, but all previews use `BROWSER_PARTITION = persist:donwells-browser`. `clear()` destroys views on renderer loss. Do not promise either project-cookie isolation or full page resurrection from current code.

1. In `browser-permissions.ts`, derive a stable persistent partition from the canonical checkout identity, using a hash rather than raw paths. Resolve identity in main via the existing registered-workspace check. Configure permission handlers for every created partition before navigation; replace the single global setup in `index.ts`.
2. In `browser-views.ts`, retain the instance/epoch checks and current view on move/hide. Keep sandbox/context isolation and deny uncontrolled popup creation. Browser commands continue through `BrowserViewRequest`, `BrowserViewPort` and the existing command router.
3. Migration starts each newly isolated checkout with clean site storage. Retain the old shared partition untouched; do not guess which project's credentials/cookies it belongs to or copy them to every project. Explain the one-time sign-in change in the migration UI. Export no browser credentials.
4. Restore saved URL and partition after a guest crash/restart with a visible reload state. A navigation failure offers retry and external-open; it does not allocate duplicate preview owners. Keep browser history scoped where project information is displayed.
5. Demonstrate identical localhost origin in two checkout partitions with different stored values, then move/hide a stateful page and confirm its live instance survives. Extend browser-runtime/view checks at the changed lifecycle boundary.

**Component choice:** retain WebContentsView for the embedded preview; the current Electron recommendation favors it over the webview tag. Session partitions are the storage boundary, not the component's visual placement. Primary references: [Electron session](https://www.electronjs.org/docs/latest/api/session), [WebContentsView source/docs](https://github.com/electron/electron/blob/main/docs/api/web-contents-view.md).

## 15 — Browser tools connected to results

**Existing flow:** `createBrowserToolDefinition` in `project-browser-tools.ts` starts an admitted Playwright MCP context through ProjectTools. It binds a checkout to a selected local preview, consumes element references by revision before input, records artifacts and labels uncertain operations. Its managed browser is separate from the visible preview; this distinction must remain visible.

1. Preserve isolated managed contexts by default. Label the managed context's current URL and preview origin in the tool pane. Do not describe this as controlling the preview's cookies or DOM instance.
2. Expose existing snapshot/input/trace controls and bounded console/network output through the native-agent tool route and Runs evidence view. On preview change invalidate the binding and offer a deliberate fresh context. Navigation/input errors consume old references and require a fresh observation before retry.
3. If same-page testing is required for an authenticated preview, implement explicit attach to that main-owned target with target identity checks and lifetime release; never point a generic controller at every app tab. Compare the selected Playwright route with PinchTab only for an unmet behavior; current repository trials already cover their basic fit.
4. Feed generated artifacts through `verificationAttach` and display `attached-reference` honestly. A screenshot's later attachment does not prove which command generated it. Re-hash on explicit inspection using `hashVerificationArtifact` and allowed owned roots.
5. Run a native agent's local app interaction, capture a real error, fix the relevant project code and repeat the interaction. Verify project B is unchanged and cancel releases only the owned managed context.

## 17 / 18 — Connect edits, runs and collaboration

**Current flow:** `OperationalRunService.verificationRun` discovers package scripts, launches via the daemon-backed parallel orchestrator and captures before/after source fingerprints. `verificationList` distinguishes current/stale/changed-during-run/unverified. `DiffReviewService` owns reviews and artifact confinement. `ProjectTaskCoordination.inspect`, `requireTask` and `openTool` already connect task authority and external TUI tools.

1. In17, put script selection, start/stop, exit status and open-artifact in the Changes/Runs flow rather than a detached status dashboard. Preserve bounded output and the actual exit code. Show an interrupted/unverifiable state when ownership is lost.
2. Link a diff review to an existing run/task ID and its source fingerprint. Recompute freshness on opening a review; source changes invalidate the result. Do not infer success from a marker in terminal text or from a later attached file.
3. Generalize the existing run selection to a validated explicit project command only where the workflow requires a non-package-script build. Retain `OperationalTarget` and shell quoting helpers; Task24 supplies remote execution. Do not implement a second runner in the editor.
4. In18, expose shared-checkout versus separate-worktree choice at agent/task launch. Use existing Git creation and task/handoff claims; show overlap as advisory. Existing claims do not prevent an arbitrary native CLI writing a file.
5. Use `runWithEditorGuard` around worktree/file operations that can invalidate dirty documents. Preview destructive Git operations and preserve dirty work. Keep committing local and pushing/publishing deliberate actions.
6. Demonstrate one failed script then corrected build, stale evidence after another edit, and two agents in separate worktrees reviewing their resulting changes. Extend diff-review/task-coordination/operational checks only for changed semantics.

## 25 — Turn open-file language help into project-aware editing

**Observed gap:** `typescript-worker.js` isolates Monaco mirror models by root, but it sees open files rather than a filesystem-backed configured project. `language-diagnostics.ts` labels diagnostics accordingly. Monaco syntax support for Python/Rust/etc. does not provide those language servers.

1. Preserve `EditorPane`, cached documents, save conflict detection and recovery. Put language actions in the existing editor command route. Do not replace Monaco merely to obtain language-server integration.
2. Add a project-scoped language service route owned in main, starting with the installed project's TypeScript `tsserver`. Resolve it from the registered project's admitted TypeScript installation; report unavailable until installed/configured, with open-files mode still explicit. Use tsserver's project configuration rather than reimplementing tsconfig resolution in a browser worker.
3. Proposed narrow files: `src/main/project-language-tools.ts` for owned process/requests; `src/shared/project-language-tools.ts` for bounded open/change/close/diagnostics/definition/restart messages; `src/renderer/src/project-language-tools.ts` for Monaco provider bindings. Wire through existing preload/main request conventions. Correlate each request with checkout, document URI/version and service generation. Reject returned paths outside authorized roots; drop late diagnostics from older buffer versions or replaced services.
4. Disable duplicate built-in diagnostics/providers only for a document successfully attached to the project service. On crash keep dirty text and expose restart/open-files fallback; never save or replace the buffer automatically. Bound pending requests and process output, cancel on project close, and restart only on explicit action after a repeated failure.
5. Use the existing app-workflow template (`APP_WORKFLOW_FILES`) and skill-package validation to share project build instructions with agents. Add/configure workflow files only when absent; show a diff for updates to authored instructions. Read declared run commands, never invent a package manager or execute installation on project open.
6. For additional languages, retain accurate syntax-only labels until an admitted server is configured through the same narrow operation set. Research a mature Monaco LSP client before adding protocol features beyond this set; do not claim a full VS Code extension host.
7. Demonstrate definition into an unopened project file, a diagnostic affected by tsconfig, two projects with incompatible declarations, restart with unsaved text, then build through17. Extend `tests/language-tools.test.ts` and the existing language-editor journey at these boundaries.

Primary references: [Monaco repository/FAQ](https://github.com/microsoft/monaco-editor), [TypeScript tsserver](https://github.com/microsoft/TypeScript/wiki/Standalone-Server-%28tsserver%29). Confirm the selected project's actual server version before implementation; do not introduce an arbitrary bundled compiler version.

## 19 — Finish usable setup for the delivered integrations

1. Extend the existing `ProjectDoctor` configuration and `ProjectToolsSettings` UI for each actual delivered adapter, including the proposed language service. Use a compact role list: facts, documents, code, learned memory, temporal graph, analytics, browser, control and environments. Show selected implementation, scope and running owner.
2. Each row provides configure, start/connect, stop/disconnect, repair guidance and last actionable error. A missing path or model must have a specific repair route. Do not let a green configuration validator stand in for a working connection.
3. Downloads use the existing manifest/admission route and pinned checksums. Local credentials remain outside portable project files. Demand-driven services stay stopped until used; do not automatically launch a heavy fleet when opening a project.
4. On configuration replacement stop/cancel the old owned work, validate the replacement, and preserve the previous configuration for recovery. External endpoints are disconnected, not terminated.
5. From a fresh disposable profile, configure one tool in each distinct delivery class (bundled, installed local, configured endpoint, environment), repair a bad value, invoke it and stop it. All delivered adapters still require their own functional acceptance in their owning tasks.

## 21 — Integrate the finished GUI

1. After integration, rebuild any remaining disconnected settings/dialog/tool presentation into the05/06 shell. Populate real data for agents, native/ACP sessions, memory projections, graph sources, runs, browser/control and Lume/SSH. Remove replaced navigation and dead CSS instead of layering another shell.
2. Use one session identity treatment across side list, dock tab and recovery. Distinguish local/remote and native/ACP using useful labels, not engine implementation jargon. Put engine details in tool settings/status where they support a decision.
3. Keep search, evidence and history results directly openable to source/action. A service error includes retry/repair without taking over the terminal. Attention markers identify the session requiring action.
4. Exercise the integrated journey from the master plan at narrow/wide sizes with physical native input when available. Fix observed focus, density and latency causes at their shared owner. Keep existing usable shortcuts and contrast;02 qualification stays skipped.
5. Update layout migration only if actual pane references changed; preserve user arrangement and dirty resources. Commit the working GUI with real screenshots and known limits. A proposal screenshot cannot close21.

## 22 — Package and recovery

1. Use `package:prepare` from `package.json` (build, native build, notices and package check), then electron-builder with a unique `/tmp` output override. Do not invoke default `package:mac` while `dist` may own the running daemon.
2. Produce an arm64 DMG with the current native library and distribution notices. Confirm external engines have functioning setup routes; do not accidentally bundle local model caches or credentials. `build/electron-builder.json` currently disables signing: report that status unless genuine signing credentials/configuration are provided.
3. Open a copy of an existing profile in an isolated candidate location, run the integrated workflow and prove migration/recovery using20. Close only candidate-owned processes. No automatic replacement of the user's application.
4. Run package integrity checks and `hdiutil verify` on the actual final DMG. Give its absolute clickable path and the source commit. Signing/notarization cannot be implied from a locally launchable unsigned build.

## Efficient implementation and evidence rules

Each numbered package inherits the master task's research/implementation/demonstration/commit/checklist loop. Refresh only the selection facts needed for its pending change. Reuse today's inspected architecture and recorded trials. If a named path or interface changes before execution, trace its successor once and amend that package; do not rerun this whole audit. A package is complete only when its product clauses are implemented. Planning documents and source inspections are not product delivery.
