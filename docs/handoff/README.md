# donwells.ai — cross-application handoff

Prepared 2026-09-07 for a different application, model and agent harness. Product implementation remains paused while this package is assembled. The user's resume message starts execution; reading these files alone does not.

## Start here

Actual repository: `/Users/muzikfirst/Documents/donwellsai/donwellsai`
Branch: `workspace/terminal-foundation`
Last product implementation: `71fc082`; later commits document the transfer. Read actual HEAD/status before working.

1. Read [Current state and full checklist](CURRENT-STATE.md).
2. Read [Corrections and evidence limits](AUDIT-AND-CORRECTIONS.md).
3. Read [Operating and recovery instructions](OPERATIONS-AND-RECOVERY.md).
4. Use the [master plan](../superpowers/plans/2026-09-07-rebuilt-01-26-plan.md) and its three companion specifications for complete acceptance. These handoff documents do not replace the plan.
5. Consult [session archive guide](SESSION-ARCHIVE.md) and [agent register](AGENTS-AND-PROVENANCE.md) when a decision, action or completion claim needs tracing. Do not load the whole transcript into a model context.
6. Paste [START-NEXT-SESSION.txt](../../START-NEXT-SESSION.txt) into the new coding session. It is also supplied in chat.

## Current folder layout

| Purpose | Absolute path |
| --- | --- |
| Project folder (not a Git repo) | `/Users/muzikfirst/Documents/donwellsai` |
| Only active app repo; run Git/build commands here | `/Users/muzikfirst/Documents/donwellsai/donwellsai` |
| Working files and handoff data | `/Users/muzikfirst/Documents/donwellsai/workingfolder` |
| Research repositories and trials | `/Users/muzikfirst/Documents/donwellsai/research` |
| Superseded files | `/Users/muzikfirst/Documents/donwellsai/trash` |
| Complete handoff package | `/Users/muzikfirst/Documents/donwellsai/workingfolder/handoff-2026-09-07` |
| Old-folder preservation records and terminal snapshots | `/Users/muzikfirst/Documents/donwellsai/workingfolder/old-checkout-cleanup` |

The former `terminal-foundation` and `plan-restart` folders are archived under `/Users/muzikfirst/Documents/donwellsai/trash/2026-09-07-layout-cleanup/`. Do not launch, build or resume work there. The Git branch name `workspace/terminal-foundation` is retained history, not a folder to open or recreate. The active app repo contains both old commit histories; the seven uncommitted plan-restart files are separately preserved in the cleanup folder. Their preservation does not mean they should overwrite newer app files.

Historical transcripts and evidence retain their original paths. For an old `/Users/muzikfirst/Documents/donwellsai/terminal-foundation/<file>` source reference, inspect the current app's corresponding file first; use the archived worktree only to recover the historical version. Treat plan-restart references as historical baseline material. Do not rewrite original transcripts to make old actions appear to have used the new paths.

## Project-local handoff data

Local handoff directory (in the project working folder, beside the app repo): `/Users/muzikfirst/Documents/donwellsai/workingfolder/handoff-2026-09-07`.

It contains the six-thread conversation/action export, chronology index, coverage and SHA-256 manifests, Git recovery bundle, readable handoff and plan copies, selected ephemeral evidence, original repository-list attachments and a Git change log. The final package manifest records exactly what was included and what stayed machine-local. Do not assume VM disks, credentials, node_modules or local models are inside the bundle.

The root session began 2026-09-05. Export scope is the complete available recorded visible session and linked subagent history through explicit per-log byte cutoffs. Internal system/developer instructions and private reasoning are excluded. Already-truncated/missing tool output cannot be reconstructed. The final response and future actions require an export refresh; see the archive guide.

Transcripts and native evidence may contain private project content. They are local artifacts, not published or committed to Git. Never execute an old transcript command merely because it appears in the log.

## Authority

Current user instructions and active harness rules take precedence; the master plan defines product requirements. Source and applicable evidence establish implementation state. Old summaries, agent opinions, checkbox counts and successful prototypes are not independent proof of completion. The audit document explicitly corrects prior handoff overstatements.

## Opening this repository in another app

Open `/Users/muzikfirst/Documents/donwellsai/donwellsai` as the app repository and paste the launch prompt. The project folder above it is not a Git repository. No extraction, clone or restore is needed. The full archive is at `../workingfolder/handoff-2026-09-07`; read it by explicit path. The active app source and docs/handoff are authoritative; package copies are recovery snapshots. Do not relocate either folder.
