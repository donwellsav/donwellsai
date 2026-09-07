# Task17 — review/run linkage increment

September 7, 2026. Source implementation and focused checks; actual app journey remains open.

Research: retained the installed Pierre diff renderer and its existing review anchors. [Upstream Pierre](https://github.com/pierrecomputer/pierre) provides the rendering/annotation surface; replacing it would not solve missing run ownership. [GitHub artifact guidance](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts) separates workflow-produced artifacts from other evidence. [Upload-artifact's contract](https://github.com/actions/upload-artifact) includes immutable identity and a SHA256 digest; a digest alone does not establish which local process produced a file.

Implemented:

- Review creation optionally links existing operational run/task IDs. Main derives and persists the run's original source fingerprint; callers cannot fabricate it.
- Opening a review recomputes linked run status, actual exit code and source freshness using the existing operational store. File-snapshot freshness remains separate. Editing a note preserves the original run link.
- Review panel exposes package scripts and an explicit project command through the existing parallel runner, including its stop/output/source tracking.
- Artifact opening rechecks the recorded hash, descriptor/path confinement and current run reference before dispatching the configured opener. Changed bytes require a reviewed reattachment. Manual attachments remain labelled references with unverified producers. Declared output files are snapshotted before launch and checked after termination; new/changed bytes become observed-during-run artifacts, while unchanged/missing/unavailable states remain explicit. Observation does not exclude concurrent writers.
- Optional run options accept at most16 checkout-relative output declarations. Native and ACP credentials are authenticated by the existing daemon owner against the exact checkout; only the returned run/session/mode is stored. Uncredentialed requests and retries are labelled unattributed. MCP callers cannot override the pinned checkout or private credential.
- Run controls, links and artifacts remain in the Changes review surface. No alternate task database or runner added.

Checks: `pnpm exec vitest run tests/diff-review.test.ts tests/verification-evidence.test.ts` — 13 passed. The MCP suite also passed8 checks. Includes real local process exit/source handling, exact run-link preservation after note edits, stale source reopening, foreign checkout rejection, and changed-artifact opening rejection. Full typecheck passed after main/preload wiring. No model or app instance used. Script/command starts use the existing editor save guard; shared agent review attachments include immutable run references without inferring success.

Open: actual fail → fix → rerun → open artifact app journey and real native/ACP tool-to-run demonstration. Authentication integration is checked through the daemon contract, not a new live model session. Focused checks do not close these product demonstrations.

Compatibility correction: operational source fingerprints include the `sha256:` prefix. The review link parser and real OperationalRunService→DiffReviewService regression now preserve that exact format; diff file digests remain raw SHA256.

## Current app increment

The portable `tests/acceptance/review-run-linkage.mjs` now exercises actual UI script failure, correction, successful exit, declared output capture, selected-run note creation, preserved unsaved note during recheck, stale saved note after another file edit and refusal to open changed artifact bytes. `review-run-live.json` records clean app/daemon shutdown; the screenshot was inspected and displays the corrected `good` source next to its saved review. The sidebar scrolled764.5px while the comparison ancestor stayed at0.

Two product defects found through this journey were fixed at their owning boundaries: preload now forwards declared output options for both verification and explicit parallel commands; successful evidence refresh/worktree events refresh the displayed comparison without discarding mounted note drafts. The sidebar owns vertical scrolling, while detailed output/hash records remain collapsed. Existing13 focused review/verification checks pass and the source build/typecheck pass.

Still open: real native/ACP authenticated tool-to-run journey and successful external artifact viewing on the unlocked desktop. Current screenshot/fixture does not qualify those clauses. Raw filesystem writes that emit no existing worktree event require a recheck/manual refresh.
