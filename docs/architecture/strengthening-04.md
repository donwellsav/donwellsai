# Task 04 strengthening pass

Fixed a real preparation/scope race in the shared ProjectTools lifecycle. A checkout reassigned to another project while native preparation was in flight could launch under the new scope using preparation for the previous scope. Direct start unexpectedly succeeded; search/write raised an undefined-service error after launching. Three deterministic regression cases reproduced the failure before the fix.

The prepared scope key is now checked again at the actual launch boundary, including recursive launch resolution. Calls also compare the bound key after startup before dispatching arguments constructed for the earlier project. Changed scope rejects the request without dispatching the write. Five cases cover start/search/write preparation and search/write target binding. Existing process ownership, uncertainty and retry behavior remain intact.

Verification: 35 lifecycle/RPC/process/secret-store tests pass; all TypeScript checks pass. Both real native QMD and graph service checks pass after the change, including concurrent scopes and stopping one service while its sibling remains usable. No new abstraction or dependency was added. This is service foundation qualification; complete native-agent and installed-release workflows remain later tasks.

Local logs: /tmp/donwells-strengthen-04-red.log (three intended failures), /tmp/donwells-strengthen-04-final.log, /tmp/donwells-strengthen-04-types.log, /tmp/donwells-strengthen-04-native.log.
