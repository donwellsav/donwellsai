# Bounded terminal client output

Both broadcasts and RPC responses previously wrote into each Node socket without bounding queued bytes. A stalled reader could therefore grow daemon memory even though retained terminal history was bounded. The shared send path now checks socket.writableLength plus the encoded frame against8MiB and disconnects only that client. PTY ownership and other clients remain intact; no input is replayed. The limit admits a JSON-escaped512KiB snapshot or bounded2MiB ACP replay with headroom.

Research: Node upstream documents internal socket write queuing and writableLength in https://github.com/nodejs/node/blob/main/doc/api/net.md#socketbuffersize . The existing DaemonClient already rejects pending requests and reports disconnection, then supports explicit reattachment; no replacement queue or reconnect framework was needed.

The focused actual socket/PTY regression in tests/agent-daemon.test.ts pauses one authenticated reader during32MiB output, confirms the healthy reader completes, separately pressures queued snapshot replies, and reconnects to the same session and native PID. This protects the shared output boundary; the separate actual workspace journey records visible recovery.
