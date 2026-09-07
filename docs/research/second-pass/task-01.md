# Task 01 — stronger baseline and recovery evidence

Status: research complete for the baseline scope; implementation and fresh installed qualification in progress. No replacement engine or dependency admitted by this task.

The supplied list contains 1,209 unique repositories. That inventory is a set of leads, not 1,209 reviews. Current source inspections below include additional comparators outside the list. Exact source refs and license-file hashes are in [task-01-sources.json](task-01-sources.json). HEAD source is not assumed to be in the latest published release.

| Candidate | Source inspected | Stronger behavior to test |
|---|---|---|
| Wave | [durable shell controller](https://github.com/wavetermdev/waveterm/blob/a4447c1563b2df285ab89e76c82f91e1a1a49c1e/pkg/blockcontroller/durableshellcontroller.go) | Existing JobId reconnects; missing owner does not silently spawn a replacement unless forced. Input carries UUID and sequence; receiver deduplication not established. |
| cmux | [resume provenance](https://github.com/manaflow-ai/cmux/blob/7d78b6e4cb0236c3b4eb354d851498b685801e00/Packages/macOS/CMUXAgentLaunch/Sources/CMUXAgentLaunch/AgentResumeEvidenceProvenance.swift), [restore identity](https://github.com/manaflow-ai/cmux/blob/7d78b6e4cb0236c3b4eb354d851498b685801e00/Packages/macOS/CmuxWorkspaces/Sources/CmuxWorkspaces/Session/WorkspaceSessionRestoreIdentity.swift) | Only classified top-level TUI evidence owns resume identity; restored UUID collisions receive replacement IDs. |
| Crush | [session model](https://github.com/charmbracelet/crush/blob/35a7bcab084a6022717d31b110c538a68d6fadf7/internal/session/session.go), [session lookup](https://github.com/charmbracelet/crush/blob/35a7bcab084a6022717d31b110c538a68d6fadf7/internal/cmd/session.go) | Persist parent identity and reject ambiguous ID prefixes. These paths do not prove PTY survival. |
| WezTerm | [multiplexing](https://github.com/wezterm/wezterm/blob/d2f3f05b38f26a872f4b0bfbb3d2eaa7bdfc1b0b/docs/multiplexing.md), [session handler](https://github.com/wezterm/wezterm/blob/d2f3f05b38f26a872f4b0bfbb3d2eaa7bdfc1b0b/wezterm-mux-server-impl/src/sessionhandler.rs) | GUI attachment is separate from mux process ownership; secure socket defaults and explicit pane IDs/sequence. |
| tmux | [client handling](https://github.com/tmux/tmux/blob/578e07fcbc66dc60822b55b88ba12f518df57374/server-client.c) | Client detach is distinct from session termination; slow-client output handling is a useful pressure comparator. |

## Admission findings

Raw license files at the inspected refs were read and hashed, not inferred from names or stars. Wave is Apache-2.0. WezTerm core is MIT with separate OFL font notices. tmux is ISC. cmux's current default license text is GPL-3.0-or-later, subject to file exceptions; Crush is FSL-1.1-MIT, not currently blanket MIT. These are source-level observations, not a completed redistribution audit. No source was copied or binary installed from these candidates during this task. Behavioral precedents remain useful even when direct reuse is not admitted. Revisit exact file/dependency boundaries before any incorporation.

## Current gaps and resulting work

- `check-package` validates expected external files but previously did not reject unexpected external files. Match both file sets, as the ASAR output check already does; prove rejection with a disposable extra file.
- Baseline and keyboard artifact hashes omit imported external CLI code. Include deterministic external resource identity and check before/after stability.
- Keyboard evidence could claim success despite failed final shutdown or daemon cleanup. Require clean exit, retain failure receipts, and return nonzero.
- Keyboard source stability and second-page PDF canvas proof need enforcement.
- Recovery hide/show must prove a visible, responsive same-process terminal instead of setting a flag after `show()`.

These are weaknesses in the acceptance machinery, not evidence that the prior signed artifact failed. The previous artifact remains a historical recovery reference. This task changes how subsequent current and challenger workloads are judged.

## Carried into owning tasks

Task 08: compare two-project GUI detach/reconnect, owner loss without respawn, slow-reader pressure, command-produced markers (not command echo), and sibling-project survival. Existing daemon already separates execution ownership; no replacement is selected from source similarity alone. Its broadcaster's socket-pressure behavior requires reproduction.

Tasks 07/27: verify top-level native session identity against helper/subagent records, ambiguous prefixes, and cross-project/session collisions before importing or resuming history.

Tasks 03/19/26/28: inspect source, release asset checksums, complete dependency notices, installation/removal and rollback before admitting any new runtime. A root license or working demo alone is insufficient.

No elapsed time, performance, or superiority claim is assigned to an unrun candidate.
