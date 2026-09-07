# Complete available session record: coverage and retrieval

Root thread: `01a0741e-cbae-7b92-9b05-b2299f723c9a`, begun2026-09-05. Archive path:
`/Users/muzikfirst/Documents/donwellsai/handoff-2026-09-07/session-archive`.

## Files

- `manifest.json`: thread source paths, exact source byte cutoffs/hashes, source/exported record counts, last timestamps, malformed/missing records and tool calls without recorded output.
- `SHA256SUMS.json`: integrity hashes of exported files.
- `action-index.jsonl`: time-ordered completed command/file-change/tool/subagent/image events, agent/thread identity and pointers to exact event records. Index fields do not replace full arguments/results.
- `<thread-id>/conversation.md`: complete exported textual user/assistant and inter-agent messages in source order; no summarization/truncation added by the exporter.
- `<thread-id>/events.jsonl`: recorded visible messages, exact available tool inputs/results, file-change records, runtime/turn outcomes and agent communications, with original ordinal and byte offset.

The package also carries Git history with changed filenames and a recovery bundle. A Git author name is not reliable agent attribution. Correlate a commit hash with the relevant agent's recorded command/result before attributing it. Concurrent agent histories can interleave; keep thread identity and timestamps.

## Scope and limitations

All six database-linked thread logs were found in the first export. The manifest, rather than a prose count, is the authoritative final inventory. Ancestor/user context repeated by the harness can appear in child histories. Response calls and completed UI action records may describe the same execution; do not count them twice. Automatic user-role context is labeled by its content and is not a new user instruction.

Private reasoning, encrypted content, internal system/developer instructions, token bookkeeping and private compaction snapshots are not included. Original logs remain untouched in the user's Codex directory. We do not export account databases, auth files or unrelated thread logs. Recorded visible tool outputs may themselves include sensitive project data; this archive is local and must not be published casually.

An output truncated by its original tool remains truncated. A missing exit/output stays unknown. Inline recorded images are retained when present; external image/file references require their original file or the separately copied evidence. No unrecorded mouse event, lost runtime output or other app's unlinked history can be reconstructed from these logs.

Each export captures a fixed byte prefix of each source. The export action cannot include its own future result, later packaging actions or the final response. The final manifest states cutoffs; refresh after this session ends if the last messages/actions are needed. This is the exact completeness boundary, not a claim that future records were captured.

## Search and trace

Search action-index.jsonl for task name, commit, filename or command; use thread and source_ordinal to locate the full events.jsonl record. Read the nearby conversation for intent and correction. A failed command and later successful continuation are separate events; preserve both. Do not replay a transcript command automatically.

Example (read-only):

```sh
rg -n '71fc082|computer-control-ui|project-lume' /Users/muzikfirst/Documents/donwellsai/handoff-2026-09-07/session-archive/action-index.jsonl
```

For exact records use Python JSON loading line by line and filter source_ordinal. Use small slices rather than loading hundreds of megabytes into model context. AGENTS-AND-PROVENANCE.md identifies the owning worker histories and disputed conclusions.

## Refresh after session completion

A reusable exporter is committed at `scripts/export-session-handoff.py`. It opens the Codex thread registry read-only, follows recorded child edges, preserves visible records and writes only its own marked export destination. It does not launch agents, replay commands, alter original logs or contact a service.

```sh
cd /Users/muzikfirst/Documents/donwellsai/terminal-foundation
python3 scripts/export-session-handoff.py --self-test
python3 scripts/export-session-handoff.py --thread 01a0741e-cbae-7b92-9b05-b2299f723c9a --output /Users/muzikfirst/Documents/donwellsai/handoff-2026-09-07/session-archive
```

Refreshing changes export hashes. Update the outer package manifest/archive if distributing that refreshed version; do not claim the old ZIP includes new records. On a different machine without the original Codex registry/logs, use the included snapshot and its explicit cutoff; the refresh command cannot recreate unavailable history.
