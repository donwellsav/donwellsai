# Consistent module navigation

The global palette mislabeled Project environments, memory, search, recovery and computer-control panes as “Diff · Source Control.” It also excluded Files and Changes. The palette now reuses the tab layout's `workspacePaneLabel` and reserves file/browser/diff prefixes for those actual pane types. No navigation dependency or parallel label registry was added.

The existing native-agent owner navigation and pane-selection route remain unchanged. The [VS Code navigation reference](https://code.visualstudio.com/docs/editing/editingevolved) was reviewed as an alternative interaction precedent; replacing our working navigator would not address the shared-label defect more directly.

`tests/acceptance/module-palette.mjs` records the actual old label in installed5172c81, then passes against the changed source app: searching “environment” finds the named module and selecting it activates the same pane key. Typecheck and build passed. The two earlier runner failures (assuming a Quick Open title instead of Global Navigator, then reading repos before renderer delivery) are retained separately; neither was a product failure. Every fixture app/daemon was stopped.

This scoped change improves21E. It does not close the integrated or physical journey. Candidate5172c81 predates this palette fix; its earlier package/recovery proof remains valid only for that recorded candidate, not a final current-source package.
