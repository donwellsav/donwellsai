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
