# Task 19 integration discovery and language ownership increment

Existing package configuration, backups, admission and MCP owners remain in
ProjectDoctor. The integration chooser extends that discovery list with facts,
learned memory, temporal knowledge, analytics, project languages and remote
SSH environments. It routes to existing controls, rather than constructing a
second set of memory panels/owners under Settings. Leaving Settings respects
its existing dirty-control guard. Analytics opens Search with Sessions selected.

Status checks are read-only: learned/temporal status reports source manifest
state and explicitly does not claim an external connection; SSH shows recorded
pairing state; canonical facts reads the authoritative store. Language status
reports the existing process/version/document count without starting a server.
Missing configuration and last operation errors remain visible. Package download
paths/checksums and backups continue using the existing admitted catalog.

The project language owner adds inspect and pause endpoints. Pause rejects
pending work, waits for owned-process exit and prevents editor updates from
restarting that checkout. Explicit resume reuses the checkout TypeScript package
and waits for its protocol configure response. Other checkout servers continue.
Graceful termination escalates only the owned child; an unverifiable exit rejects
rather than claiming a stop. No installed files or project sources are removed.
Pause is current-owner session state, not a new persisted project setting.

Primary setup refresh: [MCP local server setup](https://modelcontextprotocol.io/docs/2026-07-28/develop/connect-local-servers)
separates runtime/configuration from a working connection and directs failures
to absolute-path and log checks. [Playwright browsers](https://playwright.dev/docs/browsers)
distinguishes the library from compatible browser installation. These reinforce
the existing explicit runtime/package/browser fields; no installer was added.

Focused Doctor/language checks: 20 passed, one preexisting skipped check.
Read-only language inspection creates no child; pause verifies child exit,
blocks editor restart, preserves another checkout, rejects foreign scope and
resumes with a new owner. Typecheck passed. GUI/fresh-project setup proof remains
with root. Task 19 is not closed: environment removal/migration remains absent;
actual remote deployment belongs to24; every adapter still needs its own product
acceptance. No source or authoritative knowledge is deleted by these controls.
