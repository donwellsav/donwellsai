# Task 25 — checkout language tools and reusable workflows

Status: strengthened. Reuses installed Monaco 0.56.0 (MIT), its TypeScript 5.9.3 worker, existing project script verification and existing versioned skill-package management. No new dependency or external language-server install.

## Changes and actual behavior

Each checkout now gets its own TypeScript compiler program inside the existing worker. Only that checkout's mirrored editor models enter its program, with the most specific registered root winning for nested checkouts. Programs are released after their mirrored models disappear; closing all TypeScript/JavaScript models terminates the workers. The new worker preserves Monaco's existing completion, hover, navigation and rename methods. Its initialization handles the root message before Monaco's two-message worker handshake.

Diagnostics clear on edit and apply only when both request generation and model version still match. The installed Monaco adapter checked disposal after awaiting results but did not check the buffer version. The replacement only handles diagnostics; all other language features reuse Monaco. JavaScript retains syntax checking; TypeScript adds semantic errors. Marker provenance explicitly says **TypeScript · open files**. This is not a full tsconfig/node_modules workspace language server: unopened dependencies and project compiler options remain the declared project typecheck command's responsibility. The live fixture runs the actual installed TypeScript CLI through the existing verification service and records failed then successful checks after an editor save. No declaration file, package script or server configuration is inferred or installed.

Go to Definition now routes through the existing checkout file/navigation store instead of relying on Monaco's default no-op for another model. Targets outside the initiating checkout are refused. Recovery uses **Restart TypeScript / JavaScript tools** in the editor command/context menu; it replaces the language worker, not the text model or undo stack. The two missing standalone Monaco services required by the shipped feature imports are registered.

The live sequence also exposed a shared save-shortcut bug: `addCommand` registered Cmd/Ctrl+S globally without an editor context, so a later editor could receive a different file's save. `addAction` supplies Monaco's editor identity precondition and a disposable registration. Both navigation destinations and the original buffer now save through their own existing save controller. The editor dark background is the requested #16161D.

## Versioned workflow choice

New project offers the optional **App workflow · v1.0.0** choice, with exact contents visible before creation: SPEC.md, TASKS.md and `.agents/skills/app-workflow/SKILL.md`. The specification and checklist are usable by any selected terminal agent; the skill uses the existing workspace skill convention. This does not claim automatic skill discovery by every native agent. The existing skill manager remains the path for inspecting and managing separately installed versioned packages.

The workflow is off by default and copied only into a newly created exclusive project directory using WorktreeFiles. Existing destinations, unknown workflow versions and unsafe file paths fail. Existing AGENTS.md and user instructions are never replaced. The documents grant no tool access, execute no scripts and alter no agent/provider settings. A partial failure preserves the folder and reports the failed creation stage.

## Evidence

[Live receipt](strengthening-25/result.json), [editor](strengthening-25/editor.png), [workflow review at 1100×720](strengthening-25/workflow-review.png). The real built Electron app used a disposable profile and two actual Git projects. Checks cover same-name global isolation, real definition navigation, worker termination/restart, deliberate missing-worker failure, undo/model preservation, two-file manual save, native TypeScript failure/pass and creation of reviewed workflow bytes. The sole recorded page error is the intentionally injected missing-worker exception. The app and its owned daemon shut down. This is a current developer build receipt, not installed-package proof; the final release refresh must include these changes.

`pnpm typecheck` and focused language-tools/project-creation/editor-save/editor-recovery/skill-package checks pass: 34 tests across five files. The deferred-result regression test proves stale diagnostics cannot reappear and a failed worker can recover without mutating the model. Existing skill-package tests cover modified owned files, user instructions, unsafe paths and inert scripts. No VoiceOver or additional-language IME claim is added.
