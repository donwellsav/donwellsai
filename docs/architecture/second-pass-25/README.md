# Task25 project-language integration

Source increment cadab1d adds project-local tsserver diagnostics, definitions, references and explicit process recovery through the existing editor/main ownership. Monaco0.56.0 remains the editor. TypeScript5.9.3 in each test project supplies the language server; absence of tsserver remains an explicit open-files fallback. No global installation or new app dependency.

Research refreshed September7 against [TypeScript standalone server](https://github.com/microsoft/TypeScript/wiki/Standalone-Server-(tsserver)), [Monaco](https://github.com/microsoft/monaco-editor) and [monaco-languageclient](https://github.com/TypeFox/monaco-languageclient). The installed project server owns tsconfig and unopened-file resolution. A general LSP transport is a credible path for additional configured languages; it does not remove the present ownership/version/stale-result boundaries and is not necessary for this selected TypeScript integration.

Current source-app receipt `result.json` demonstrates incompatible tsconfigs in separate processes, actual project diagnostic sources, definition into an unopened file, references navigation, restart preserving unsaved buffers/model identity/undo, missing-worker recovery, failed then corrected successful declared typecheck and reviewed versioned workflow creation. Screenshots were inspected. App and daemon stopped cleanly. Focused language checks are recorded separately.

Reproduce: `node tests/acceptance/language-editor.mjs --root <checkout> --playwright <installed-module> --typescript <TypeScript5.9.3-package-directory> --evidence <output-directory>`. Server package is physically copied into the owned fixtures, not referenced across project boundaries.

Task remains partial: share/reuse the declared workflow with another actual native agent. Creation proof does not establish that agent journey. User-authored instructions remain protected by existing absent-only project creation and reviewed artifact import; no automatic workflow updates are introduced.
