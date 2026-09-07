# Native/ACP integration increment

The daemon now owns optional OpenCode ACP sessions separately from native PTYs. Per-session credentials authenticate project MCP calls; stopped owners cannot keep calling project tools. The side-panel view retains bounded protocol output, offered permissions, draft text and recorded prompt outcomes. Prompt identity is journaled before dispatch; reconnect does not resend work. Explicit ACP-to-native switching verifies exit before launching the exact provider conversation ID. Native-to-ACP starts a clearly identified new conversation where native ID mapping is unavailable.

Handoffs can bind current memory revisions and reject changed/archived facts. ACP attachment delivery requires a stable request ID and uses the protocol prompt path. Native delivery retains its existing terminal path.

Research used the installed OpenCode 1.18.18 adapter stdio MCP branch and SDK 1.4.0. The actual app used isolated XDG directories, existing local Ornith-1.5-35B-A3B-MLX-8bit through oMLX, and no HOME replacement or paid provider.

Evidence: `acp-memory-live.json` records the actual offered one-time memory read, private project fact recall, and renderer reload with the same PID and retained updates. `mode-switch-live.json` records the visible switch action, stopped ACP owner, exact native --session ID, terminal adoption, and idempotent retry. Both successful runs shut down the owned app/daemon. The screenshot captures terminal adoption during startup, not a rendered provider reply. The first switch runner polled before request acceptance; waiting for the existing receipt fixed that runner race without changing product code.

Checks: 29 focused tests across ACP protocol/lifecycle, delivery, output, switch identity, MCP authentication, and handoff revisions passed. The integrated application build passed. Actual cross-agent conflict/write and bidirectional reviewed handoff, write denial/approval, provider interruption/reload, and all named native adapters remain open. This increment does not close Tasks 07, 08 or 10.
