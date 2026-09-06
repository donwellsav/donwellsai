# Task 09 strengthening evidence

The existing SQLite migration required no production rewrite. Added checks inject ENOSPC during backup and authority-manifest publication, preserve the legacy data exactly, and prove successful retry. A missing active SQLite file now has an explicit regression: requests fail, the manifest and fenced legacy path remain unchanged, and restoring the same database restores service without cross-project ID access.

The process-crash runner now reads an explicit boundary marker instead of assuming all child stdout is JSON. Vite startup output exposed that test-runner defect. Production migration behavior remained correct.

## Verification

- 34 memory, migration and MCP tests passed; all three TypeScript projects passed.
- Twelve real SIGKILL boundaries passed: five upgrade, two abort, five reverse. Each receipt proves writer fencing, process-lock release, preserved original backup, restart recall and a successful later write. Reverse cases preserve post-upgrade writes.
- Corrupt legacy memory fails visibly while terminal execution remains functional; correcting only the fixture permits recovery.
- [Four native agents, one migrated fixture, Ornith](native-agents-ornith.json): OMP, Hermes TUI, Kimi CLI and DSH each called shared memory search and recalled the same post-migration value after app restart. The original backup remained unchanged. All four binaries stayed unchanged; owned sessions and daemon cleanup passed.
- Packaged app: `/tmp/donwells-strengthen-08-package-polish/mac-arm64/donwells.app/Contents/MacOS/donwells`. ASAR SHA-256 `8b78f8fbc881126b7418a305301cae4a0e61e999c72e2b1f693c564459da27e1`. Task 08 package verification matched 718 application files and 29 external resources; Task 09 changes are checks and runner support only.

## Provider qualification

The user selected local oMLX `Ornith-1.5-35B-A3B-MLX-8bit` after Kimi's hosted provider reached its weekly usage limit. All four final runs used the existing loopback endpoint `http://127.0.0.1:8899/v1`. OMP used `--model omlx/Ornith-1.5-35B-A3B-MLX-8bit`; Kimi used its native `KIMI_CODE_HOME` override and a doctor-validated temporary config; Hermes and DSH used temporary native profiles. No normal provider profile was rewritten. The initial [quota-limited receipt](native-provider-quota.json) is retained as a failed provider run, not counted as passing.

Test support commit: `7e1b02b`. ENOSPC is injected at real file-write calls rather than filling the user's disk. Native recall does not replace Task 10's explicit handoff/claim/delivery tests.
