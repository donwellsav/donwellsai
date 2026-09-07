# Reviewed handoff dispatch

The handoff panel now includes native and ACP sources/receivers from their existing
owners. It labels modes and reuses the existing review, memory revision, source
fingerprint, claim and receipt controls. A new explicit Send instructions action
calls ProjectHandoffService rather than writing terminal input in the renderer.

The existing handoff record retains optional dispatch metadata: a request ID and
uncertain/submitted state. A short SQLite claim persists uncertainty before any
transport input. Competing or repeated dispatch calls observe that record, never
resend. ACP receives the persisted request ID through the existing prompt journal;
native input uses the existing bracketed-paste delivery path. Neither transport
success nor a PTY write acknowledges the handoff. The authenticated receiver still
calls receive (receipt uncertain) and acknowledge (confirmed) separately.

Dispatch metadata leaves the reviewed claim revision unchanged, so the receiving
instruction refers to the same exact revision. Receipt/acknowledgment may advance
that revision while the transport result is being saved; recording submission
preserves the latest receipt state. Supersession and a newly reviewed handoff remain
the deliberate recovery path after inspecting an uncertain attempt. Reload only
reads state and exposes no automatic send effect.

Missing dispatch fields remain valid in legacy records. Portable restore clears
historical dispatch together with the old recipient and delivery metadata. The
existing maximum handoff size still applies. No new ledger or process owner.

Research reused the inspected ACP protocol contract and current native delivery,
receiver credential, source freshness and private handoff transaction paths.
Focused native/ACP checks prove stale-source and foreign-project rejection,
concurrent single dispatch, separate authenticated receipt, and no replay after
transport failure or owner recreation. These checks do not qualify real model
receipt or GUI ergonomics; native-to-ACP and ACP-to-native product demonstrations
remain required.

## Captured selected diff and plain-folder source increment

The handoff form can load existing review notes for a chosen file/comparison,
show their selected lines, and attach exact note revisions. Creation resolves
those selections from the existing DiffReviewStore, verifies both actual source
snapshots, selected context text, and note revision, then captures the canonical
note in the existing handoff document. At most ten selections fit within the
existing 64,000-byte handoff limit. There is no second diff store. Later edits or
deletion of the original review note do not alter the captured evidence. Source
changes continue to block claim, dispatch and authenticated receive through the
handoff source fingerprint. Native and ACP receivers receive the same captured
lines and snapshot hashes in the existing handoff tool result.

Project-kit export retains captured notes inside its existing handoff payload,
applying existing portable text redaction and checkout-path remapping. Restore
keeps their selected excerpts and review provenance in a superseded historical
handoff; it neither invents a live review record nor requires the old store.

Registered plain folders now use the shared source owner without initializing
Git. Its fingerprint covers sorted regular-file revisions and directory paths,
including hidden authored entries, with two complete captures. Existing folder visibility policy excludes node_modules, .git and .DS_Store; .gitignore patterns are not used. The UI names this scope explicitly. Source revision is null
and changedFiles is empty because there is no Git baseline. Capture refuses
links/special files, more than 50,000 scanned entries, 32 MiB aggregate content per pass, 15 seconds per pass, and the existing 8 MiB per-file limit;
it never silently treats omitted files as unchanged. Larger folder capture is a
bounded limitation requiring a future qualified streaming implementation.

Focused checks: 50 handoff/export/Git tests and all TypeScript projects passed.
The already completed two-model-turn cross-mode receipt remains the transport
proof; this increment still needs the root-owned actual picker/restore journey.
