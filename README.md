# OpenCode Serve API — Pi Extension

## DISCLAIMER

This was entirely vibe coded in Pi, with GLM-5.1.

The prompt was:

> Write a Pi extension that serves an API for Pi that's compatible with the OpenCode serve API.

## Overview

A [Pi](https://github.com/badlogic/pi-mono) extension that serves an HTTP API compatible with the [OpenCode](https://github.com/opencode-ai/opencode) serve protocol. Any client built for the `@opencode-ai/sdk` wire format can drive Pi through this extension.

## Quick Start

```bash
# Copy to your global extensions
cp -r opencode-serve-api ~/.pi/agent/extensions/opencode-serve-api

# Start Pi normally — the API server starts automatically
pi
```

Or load directly:

```bash
pi -e ./opencode-serve-api/src/index.ts
```

## Configuration

| Flag | Env-var | Default | Description |
|------|---------|---------|-------------|
| `--serve-port` | `PI_SERVE_PORT` | `4096` | HTTP listen port |
| `--serve-host` | `PI_SERVE_HOST` | `127.0.0.1` | Bind address |

```bash
# Custom port
PI_SERVE_PORT=4321 pi

# Or via flag
pi --serve-port 4321 -e ./opencode-serve-api/src/index.ts
```

## API Endpoints

The server implements the same REST + SSE protocol that OpenCode's `opencode serve` command provides:

### Event Streaming

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/event` | SSE stream of OpenCode-compatible events |
| `GET` | `/global/event` | Same SSE stream (alias) |

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/session` | List sessions |
| `POST` | `/session` | Create session |
| `GET` | `/session/status` | Get all session statuses |
| `GET` | `/session/{id}` | Get session |
| `POST` | `/session/{id}` | Update session (title) |
| `DELETE` | `/session/{id}` | Delete session |
| `GET` | `/session/{id}/message` | List messages in session |
| `POST` | `/session/{id}/message` | Send prompt (synchronous) |
| `POST` | `/session/{id}/prompt_async` | Send prompt (async) |
| `POST` | `/session/{id}/abort` | Abort current operation |
| `POST` | `/session/{id}/fork` | Fork session |
| `POST` | `/session/{id}/command` | Execute slash command |
| `POST` | `/session/{id}/share` | Share (stub) |
| `POST` | `/session/{id}/revert` | Revert message (stub) |
| `POST` | `/session/{id}/unrevert` | Unrevert (stub) |
| `POST` | `/session/{id}/summarize` | Compact session |
| `GET` | `/session/{id}/todo` | Todo list (empty) |
| `GET` | `/session/{id}/diff` | File diffs (empty) |
| `GET` | `/session/{id}/children` | Child sessions (empty) |
| `POST` | `/session/{id}/permissions/{permID}` | Respond to permission |

### Resources

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/config` | Get config |
| `GET` | `/config/providers` | List providers |
| `GET` | `/provider` | List providers |
| `GET` | `/provider/auth` | Auth methods |
| `GET` | `/agent` | List agents |
| `GET` | `/path` | Get paths |
| `GET` | `/vcs` | Git branch info |
| `GET` | `/command` | List slash commands |
| `GET` | `/file` | List directory |
| `GET` | `/file/content` | Read file |
| `GET` | `/file/status` | File status (empty) |
| `GET` | `/find` | Grep text in files |
| `GET` | `/find/file` | Find files by name |
| `GET` | `/find/symbol` | Find symbols (empty) |

### Stubs (return empty data)

MCP, LSP, PTY, TUI control, formatter endpoints return empty/stub responses since Pi doesn't have equivalent features.

## Usage Examples

### Using `@opencode-ai/sdk`

```typescript
import { createOpencodeClient } from "@opencode-ai/sdk";

const client = createOpencodeClient({
    baseUrl: "http://127.0.0.1:4096",
});

// Create a session
const session = await client.session.create({
    body: { title: "My coding session" },
});

// Subscribe to events
const events = await client.event.subscribe();
for await (const event of events.stream) {
    console.log(event);
}

// Send a prompt (async)
await client.session.promptAsync({
    path: { id: session.data.id },
    body: {
        parts: [{ type: "text", text: "List all .ts files in src/" }],
    },
});
```

### Using `curl`

```bash
# Create a session
curl -X POST http://127.0.0.1:4096/session \
  -H "Content-Type: application/json" \
  -d '{"title": "Test session"}'

# Send a prompt (async)
curl -X POST http://127.0.0.1:4096/session/SESSION_ID/prompt_async \
  -H "Content-Type: application/json" \
  -d '{"parts": [{"type": "text", "text": "What files are in this project?"}]}'

# Subscribe to events (SSE)
curl http://127.0.0.1:4096/event

# List messages
curl http://127.0.0.1:4096/session/SESSION_ID/message

# Read a file
curl "http://127.0.0.1:4096/file/content?path=README.md"

# List directory
curl "http://127.0.0.1:4096/file?path=."
```

## Event Types

The SSE stream emits OpenCode-compatible events:

| Event | When |
|-------|------|
| `server.connected` | On SSE connection |
| `session.created` | Session created |
| `session.status` | Agent busy/idle transitions |
| `session.idle` | Agent completes |
| `message.updated` | User or assistant message created |
| `message.part.updated` | Text/reasoning/tool streaming deltas |
| `permission.updated` | Permission request (stub) |
| `permission.replied` | Permission response |

## Pi Commands

The extension registers one command:

- `/serve-api` — Show the API server status

## Architecture

```
┌─────────────────────────┐
│   OpenCode SDK Client   │
│  (or any HTTP client)   │
└────────────┬────────────┘
             │ HTTP / SSE
             ▼
┌─────────────────────────┐
│   Pi Extension          │
│   (this extension)      │
│                         │
│  ┌───────────────────┐  │
│  │  HTTP Server      │  │
│  │  (port 4096)      │  │
│  └───────┬───────────┘  │
│          │              │
│  ┌───────▼────────────┐ │
│  │  Pi Extension API  │ │
│  │  • sendUserMessage │ │
│  │  • sessionManager  │ │
│  │  • event handlers  │ │
│  │  • getCommands     │ │
│  └────────────────────┘ │
└─────────────────────────┘
```

The extension:
1. Starts an HTTP server on `session_start`
2. Maps incoming HTTP requests to Pi's internal APIs
3. Bridges Pi's agent events to OpenCode-compatible SSE events
4. Caches messages from Pi's session manager for the messages endpoint
5. Shuts down cleanly on `session_shutdown`

## Limitations

- **Single active session**: Pi operates on one session at a time. The API accepts multiple session IDs but only the current Pi session is active.
- **No MCP/LSP/PTY**: These OpenCode features don't have Pi equivalents and return empty stubs.
- **No share/unshare**: Returns stub responses.
- **Abort is best-effort**: The abort endpoint signals idle status but doesn't guarantee immediate cancellation.
- **Synchronous prompt returns immediately**: The `/session/{id}/message` POST endpoint returns an assistant message stub immediately. The actual response streams via the `/event` SSE endpoint.

## License

AGPL-v3
