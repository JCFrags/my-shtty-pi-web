# Standalone viewport stream viewer

This zero-dependency viewer is the Phase 0 protocol spike. It renders the JPEG
frame messages emitted by an `agent-browser` session and sends the documented
mouse, keyboard, and touch input messages back to the same WebSocket.

```bash
agent-browser --session viewer open https://example.com
PORT=$(agent-browser --session viewer stream status --json | jq -r '.data.port // .port')
node tools/stream-viewer/server.mjs "ws://127.0.0.1:$PORT"
```

The viewer does not own browser state and does not introduce a second automation
protocol. The production Tauri workspace uses the same stream contract.
