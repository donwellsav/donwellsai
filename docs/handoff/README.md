# donwells.ai — cross-application handoff

Prepared 2026-09-07 for a different application, model and agent harness. Product implementation remains paused while this package is assembled. The user's resume message starts execution; reading these files alone does not.

## Start here

Actual repository: `/Users/muzikfirst/Documents/donwellsai`
Branch: `workspace/terminal-foundation`
Last product implementation: `71fc082`; later commits document the transfer. Read actual HEAD/status before working.

1. Read [Current state and full checklist](CURRENT-STATE.md).
2. Read [Corrections and evidence limits](AUDIT-AND-CORRECTIONS.md).
3. Read [Operating and recovery instructions](OPERATIONS-AND-RECOVERY.md).
4. Use the [master plan](../superpowers/plans/2026-09-07-rebuilt-01-26-plan.md) and its three companion specifications for complete acceptance. These handoff documents do not replace the plan.
5. Consult [session archive guide](SESSION-ARCHIVE.md) and [agent register](AGENTS-AND-PROVENANCE.md) when a decision, action or completion claim needs tracing. Do not load the whole transcript into a model context.
6. Paste [START-NEXT-SESSION.txt](../../START-NEXT-SESSION.txt) into the new coding session. It is also supplied in chat.

## Repo-local handoff data

Local private directory (inside this repository): `/Users/muzikfirst/Documents/donwellsai/workingfolder/handoff-2026-09-07`.

It contains the six-thread conversation/action export, chronology index, coverage and SHA-256 manifests, Git recovery bundle, readable handoff and plan copies, selected ephemeral evidence, original repository-list attachments and a Git change log. The final package manifest records exactly what was included and what stayed machine-local. Do not assume VM disks, credentials, node_modules or local models are inside the bundle.

The root session began 2026-09-05. Export scope is the complete available recorded visible session and linked subagent history through explicit per-log byte cutoffs. Internal system/developer instructions and private reasoning are excluded. Already-truncated/missing tool output cannot be reconstructed. The final response and future actions require an export refresh; see the archive guide.

Transcripts and native evidence may contain private project content. They are local artifacts, not published or committed to Git. Never execute an old transcript command merely because it appears in the log.

## Authority

Current user instructions and active harness rules take precedence; the master plan defines product requirements. Source and applicable evidence establish implementation state. Old summaries, agent opinions, checkbox counts and successful prototypes are not independent proof of completion. The audit document explicitly corrects prior handoff overstatements.

## Opening this repository in another app

Open /Users/muzikfirst/Documents/donwellsai and paste the launch prompt; no extraction, clone, restore or app migration is needed. `workingfolder/handoff-2026-09-07/` is deliberately Git-ignored because it contains large/private session records and binaries. The files are present on disk. If the new harness hides ignored files, read them by explicit path or use `rg --no-ignore` scoped to that directory. The active plan/source and docs/handoff are authoritative; copies inside the data folder are recovery snapshots.
