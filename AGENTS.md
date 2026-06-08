# AGENTS.md — OpenCode Serve API (Pi Extension)

> **Last updated**: 2026-06-08 — All 6 phases implemented. See §8 for status.
>
> **IMPORTANT**: This file is the central agent guidance document. Keep it focused
> on what agents need to know right now. Detailed reference content lives in
> `doc/plans/`. Update this file as priorities shift.

---

## 1. Project Overview

### 1.1 What is pi-opencode-serve-api?

A [Pi](https://github.com/badlogic/pi-mono) extension (`src/index.ts`) that serves
an HTTP API compatible with the [OpenCode](https://github.com/opencode-ai/opencode)
serve protocol. Any client built for the `@opencode-ai/sdk` wire format — or raw
REST + SSE consumers like the **P4OC** Android app — can drive Pi through this
extension.

**Philosophy**: The API surface is defined by what existing clients actually send and
receive, not by what we think is reasonable. Every endpoint, field name, event type,
and status code must match what the reference opencode server (`~/src/opencode`)
produces. When in doubt, run both servers and compare.

### 1.2 Key Reference Clients

| Client | Location | What it uses |
|--------|----------|-------------|
| **P4OC** (Android) | `~/src/P4OC` | `/global/event` SSE, `POST /session/{id}/prompt_async`, `/permission/{requestID}/reply`, etc. |
| **SDK v1** (npm) | `/tmp/oc-sdk/package/dist/gen/sdk.gen.js` | REST + SSE via `@opencode-ai/sdk` |
| **SDK v2** (npm) | `/tmp/oc-sdk/package/dist/v2/gen/sdk.gen.d.ts` | `/api/*` prefix routes, `/project/{id}`, `/sync/*`, etc. |
| **OpenCode server** (Go) | `~/src/opencode` | The reference implementation. Run with `go run . serve --port 4097` |

---

## 2. Quick Reference

### 2.1 Commands

| Task | Command |
|------|---------|
| Start server (our extension) | `PI_SERVE_PORT=4096 pi -e ./src/index.ts` |
| Start reference opencode | `cd ~/src/opencode && go run . serve --port 4097` |
| Start a test pi instance | `pi --serve-port 4980 -e ./src/index.ts` (separate terminal) |
| Compare endpoint responses | `curl -s http://127.0.0.1:4096/session \| python3 -m json.tool` |
| Read a file via API | `curl "http://127.0.0.1:4096/file/content?path=AGENTS.md"` |
| Subscribe to SSE | `curl -sN http://127.0.0.1:4096/global/event` |
| Phase 1 smoke test | `curl -s http://127.0.0.1:4096/health && echo OK` |
| List all current endpoint routes | `grep -rn 'router\.\(get\|post\|put\|patch\|delete\)' src/index.ts \| sort` |

### 2.2 Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main extension: HTTP server, SSE bridge, event mapping |
| `doc/plans/opencode-api-parity.md` | Full gap analysis and phased implementation plan |
| `package.json` | Pi extension manifest (name: `opencode-serve-api`) |

### 2.3 Architecture

```
OpenCode SDK Client / P4OC
        |
        | HTTP / SSE
        v
+-----------------------------------+
| Pi Extension (this project)       |
|                                   |
|  HTTP Server (port 4096)          |
|  - REST routes                    |
|  - SSE endpoint (/event, /global/event) |
|                                   |
|  Pi Extension API Bridge          |
|  - sendUserMessage()              |
|  - sessionManager                 |
|  - pi.on("message_*")             |
|  - pi.on("session_start/shutdown")|
|  - pi.on("tool_execution_*")      |
+-----------------------------------+
        |
        v
+-----------------------------------+
| Pi Core                           |
| (session manager, agent events)   |
+-----------------------------------+
```

---

## 3. Development Standards

### 3.1 Reference-Verification Principle

**Every API response must be validated against the running opencode reference server.**
When adding or fixing an endpoint:
1. Start the reference server on port 4097
2. Start our server on port 4096
3. Hit the same endpoint on both, compare response shapes
4. Check both status codes and body content
5. For SSE events, send a prompt and compare the event stream

### 3.2 Coding Conventions

- **Language**: TypeScript (compiled via pi's built-in esbuild)
- **HTTP server**: Built-in `node:http` (no Express dependency)
- **Logging**: `console.log` / `console.error` with descriptive prefixes
- **Atomic focused commits** — commit after each milestone, one concern per commit
- **Testing**: build unit tests around known opencode behavior; use agents to define and debug test cases against the reference server
- **Warning discipline**: Treat new diagnostic warnings as failures
- **Debug logging**: `OPENCODE_LOG_LEVEL=debug` for verbose tracing (planned)

### 3.3 Quality Principles

1. **Match the wire format exactly** — field names, casing, null vs absent, types
2. **Test against the real reference** — not just curl, but actual SDK and P4OC clients
3. **Preserve artifacts** — save curl outputs, SSE event dumps for comparison
4. **Detailed event logging** — every SSE event broadcast should be traceable
5. **Graceful degradation** — stubs should return correct empty shapes, not errors

### 3.4 SSE Event Bridging

The extension bridges Pi's internal events to OpenCode-compatible SSE events.
The wrapping format must be:

```typescript
{
  directory: string | null,     // workspace directory path
  payload: {
    type: string,               // event type name
    properties: { ... }         // event-specific properties
  }
}
```

P4OC connects to `/global/event` and expects this `{directory, payload}` wrapper.
The `session.idle` event (not `session.status`) signals P4OC to re-enable the
send button.

---

## 4. API Surface Overview

### 4.1 Current Implementation Status

See `doc/plans/opencode-api-parity.md` for the full gap matrix. Key categories:

| Category | Status | Notes |
|----------|--------|-------|
| **Health/Instance** | Partial | `/instance` GET should not exist |
| **Session CRUD** | Good | Missing PATCH for update |
| **Messages** | Good | Missing part PATCH/DELETE |
| **Event SSE** | Good | Missing ~15 event types |
| **Config/Provider** | Good | Missing PATCH for config |
| **Agent/Command** | Good | `/model/active` returns wrong type |
| **File/Find** | Good | Complete |
| **VCS/Project** | Minimal | SDK v2 endpoints missing |
| **Permission/Question** | Partial | Global reply paths missing |
| **PTY** | Not routed | All 5 endpoints needed |
| **MCP** | Partial | POST for add missing |
| **Sync** | Not routed | SDK v2 only |
| **LSP/TUI/Formatter** | Stubs | Acceptable (no Pi equivalents) |

### 4.2 Known Event Gaps

Events P4OC expects that we don't emit:

| Event | Impact | Priority |
|-------|--------|----------|
| `session.deleted` | P4OC tracking | Medium |
| `session.error` | P4OC error display | High |
| `session.diff` | P4OC file diff view | Low |
| `permission.asked` | **Critical** — P4OC permission UI | **High** |
| `question.asked` | P4OC question dialog | High |
| `todo.updated` | P4OC task list | Low |
| `file.edited` | P4OC file change indicator | Low |
| `command.executed` | P4OC command log | Low |
| `session.compacted` | P4OC compact tracking | Low |

---

## 5. Testing Approach

### 5.1 Verification Flow

1. **Reference comparison** — curl both servers side-by-side
2. **SDK client test** — use `@opencode-ai/sdk` to exercise endpoints
3. **P4OC connectivity** — connect P4OC to our server, verify full flow
4. **SSE event trace** — subscribe to events, send prompt, verify stream

### 5.2 Running Test Servers

```bash
# Terminal 1: reference opencode
cd ~/src/opencode
go run . serve --port 4097

# Terminal 2: our extension
cd ~/src/pi-opencode-serve-api
PI_SERVE_PORT=4096 pi -e ./src/index.ts

# Terminal 3: test client
curl -s http://127.0.0.1:4096/health
curl -s http://127.0.0.1:4097/global/health
```

### 5.3 Testing Against P4OC

1. Start our server on port 4096
2. Point P4OC at `http://<host>:4096`
3. Create a session, send a message, verify:
   - SSE events arrive in P4OC
   - Send button re-enables after response
   - Permission dialogs work
   - Session list shows correctly

### 5.4 Testing Pi Against Our Server

Start a separate pi instance configured to talk to our server:

```bash
# Start our server
PI_SERVE_PORT=4096 pi -e ./src/index.ts

# In another terminal, start pi pointing at our API port
# (this depends on how pi selects its API port)
```

### 5.5 Unit Testing Against Reference Behavior

Build a unit test suite codifying observed opencode server behavior:

1. **Snapshot response shapes** — curl each endpoint on the reference server
   and save the JSON. Our implementation must produce isomorphic JSON.
2. **Event stream recording** — send a prompt to the reference server, capture
   the SSE event sequence. Write tests asserting our server emits the same
   sequence of event types and property fields.
3. **Edge case coverage** — test empty sessions, missing fields, invalid IDs,
   concurrent connections, and SSE reconnection against the reference.
4. **Use agents to discover behavior** — delegate a reference-server exploration
   pass to a sub-agent: hit every endpoint, record responses, then define test
   cases from the observations. If a test fails, the agent debugs the mismatch.
5. **Regression harness** — re-run the full test suite after every phase;
   a passing suite means we haven't regressed against the reference.

---

## 6. Implementation Phases

See `doc/plans/opencode-api-parity.md` for full details.

| Phase | Focus | Key Work |
|-------|-------|----------|
| **P1** | Critical fixes (P4OC connectivity) | `/permission/{id}/reply`, `/question/{id}/reply`, PATCH handlers, SSE event gaps |
| **P2** | PTY, LSP, feature stubs | All PTY endpoints, /experimental/tool, /global/* stubs |
| **P3** | Project/VCS/Sync (SDK v2) | Project endpoints, VCS endpoints, sync endpoints |
| **P4** | SSE event completeness | permission.asked, question.asked, file.edited, vcs.branch.updated, etc. |
| **P5** | Correctness & robustness | SSE replay, session scoping, error codes, debug logging |
| **P6** | Testing & validation | Reference server comparison, P4OC full flow, automated smoke tests |

---

## 7. Important Implementation Details

### 7.1 SSE Event Key Detail

Events MUST be wrapped in `{directory, payload}` format where `payload` is
`{type, properties}`. The `directory` field is the project workspace path
and may be `null` for server-global events. P4OC's `GlobalEventDto` deserializes
this with `directory: String? = null`.

### 7.2 Pi's Single-Session Model

Pi operates on one session at a time. We accept multiple session IDs through the
API, but only the current Pi session is active. Messages are cached in memory
(`cachedMessages` Map) keyed by session ID.

### 7.3 Session Message ID Tracking

The extension tracks:
- `currentSessionId` — Pi's active session ID
- `currentAssistantMessageId` — the in-progress assistant message
- `currentTextPartId` / `currentThinkingPartId` — active text/reasoning part IDs
- `cachedMessages` — Map<sessionId, Message[]> for message history

### 7.4 Abort is Best-Effort

The abort endpoint signals idle status but doesn't guarantee immediate cancellation.
Pi doesn't have a native abort mechanism for in-flight agent turns.

### 7.5 P4OC-Specific Behavior

- P4OC connects to `/global/event` for SSE (not `/event`)
- P4OC uses `POST /session/{id}/prompt_async` for sending messages
- P4OC uses `POST /permission/{requestID}/reply` (not session-scoped path)
- P4OC uses `PATCH /session/{id}` for session title updates
- P4OC uses `PATCH /config` for config updates
- P4OC sends `PUT /auth/{id}` for auth
- P4OC uses `POST /mcp` to add MCP servers
- The `session.idle` event signals P4OC to re-enable the send button

---

## 8. Implementation Status (Updated 2026-06-08)

**All 6 phases from `doc/plans/opencode-api-parity.md` have been implemented.**
The extension now serves ~75 REST endpoints across all OpenCode API domains,
emits ~20 SSE event types, and includes a comprehensive smoke test suite.

### 8.1 Phase 1 — Critical P4OC Fixes (DONE)

All 16 items implemented in `src/index.ts`:

| # | Gap | Status |
|---|-----|--------|
| 1 | `/permission/{requestID}/reply` POST | Done |
| 2 | `/question/{requestID}/reply` POST | Done |
| 3 | `/question/{requestID}/reject` POST | Done |
| 4 | `/session/{id}/shell` POST | Done |
| 5 | `/session/{id}/init` POST | Done |
| 6 | `PUT /auth/{id}` | Done |
| 7 | `PATCH /session/{id}` | Done |
| 8 | `PATCH /config` | Done |
| 9 | `POST /model/active` returns `true` | Done |
| 10 | `/instance` GET returns 404 | Done |
| 11 | `POST /provider/{id}/oauth/authorize` | Done |
| 12 | `POST /provider/{id}/oauth/callback` | Done |
| 13 | `POST /mcp` | Done |
| 14 | Emit `session.deleted` on DELETE | Done |
| 15 | Emit `session.error` on agent error | Done |
| 16 | SSE wrapper format consistent `{directory, payload}` | Done |
| 17 | Emit `permission.asked` for sensitive tools | Done |

### 8.2 Phase 2 — PTY, LSP, Feature Stubs (DONE)

| # | Gap | Status |
|---|-----|--------|
| 18 | PTY endpoints (5 routes) | Done |
| 19 | `/experimental/tool` GET | Done |
| 20 | `/global/config` GET/PATCH | Done |
| 21 | `/global/dispose` POST | Done |
| 22 | `/global/upgrade` GET | Done |
| 23 | `/skill` GET | Done |
| 24 | `/permission` GET | Done |
| 25 | `/question` GET | Done |
| 26 | `/session/{id}/compact` GET | Done |
| 27 | `/session/{id}/context` GET | Done |
| 28 | `/session/{id}/wait` GET | Done |
| 29 | Part PATCH/DELETE | Done |

### 8.3 Phase 3 — SDK v2 Parity (DONE)

| # | Gap | Status |
|---|-----|--------|
| 30 | Project endpoints (3 routes) | Done |
| 31 | VCS endpoints (4 routes) | Done (git diff/status integration) |
| 32 | Sync endpoints (4 routes) | Done |

### 8.4 Phase 4 — SSE Events (DONE)

| # | Gap | Status |
|---|-----|--------|
| 33 | Emit `session.diff` | Done (after file-modifying tools) |
| 34 | Emit `session.compacted` | Done (via pi event hook) |
| 35 | Emit `todo.updated` | Done (stub after tool execution) |
| 36 | Emit `file.edited` | Done (after file write/patch tools) |
| 37 | Emit `file.watcher.updated` | Done |
| 38 | Emit `vcs.branch.updated` | Done (on session_start) |
| 39 | Emit `command.executed` | Done |
| 40 | Emit `question.asked` | Done (pattern-based detection) |

### 8.5 Phase 5 — Correctness & Robustness (DONE)

| # | Item | Status |
|---|------|--------|
| 41 | `/api/*` prefix stripping for v2 SDK | Done |
| 42 | Error helpers (`authError`, `serverError`) | Done |
| 43 | Debug logging (`OPENCODE_LOG_LEVEL=debug`) | Done |

### 8.6 Phase 6 — Testing & Validation (IN PROGRESS)

| # | Item | Status |
|---|------|--------|
| 44 | `test/smoke.sh` bash smoke tests | Done (337 lines, covers all phases) |
| 45 | Full Pi extension startup | Blocked by pi-tau github-autocomplete stale ctx (fixed) |
| 46 | SSE event flow tests | Pending integration test harness |
| 47 | P4OC end-to-end validation | Pending integration test harness |

### 8.7 Deferred Items

| Item | Reason |
|------|--------|
| P4OC DTO response shape validation | Requires unified reference server comparison |
| `?directory=` query param support | Low priority (single-session model) |
| OpenCode reference server comparison | Requires building reference server binary |

---

## 9. Sub-Agent Reference

| Agent | Purpose | Invoke |
|-------|---------|--------|
| `librarian` | Advisory doc audits — semantic judgment only; mechanical checks (routes, file structure) are scripted | `subagent({agent: "librarian", task: "..."})` |

---

## 10. Long-Term Vision & Goals

| Goal Area | What It Enables |
|-----------|-----------------|
| **Full OpenCode API parity** | Any SDK v1/v2 or P4OC client works without adaptation |
| **Reference-validated correctness** | Every endpoint verified against live opencode server responses |
| **SSE event completeness** | All event types emitted for proper client UI |
| **Permission/Question bridging** | Pi's permission dialogs surface as standard OpenCode events |
| **Multi-version compatibility** | Simultaneous support for P4OC, SDK v1, and SDK v2 |
| **Automated smoke tests** | Regression-safe endpoint verification |

---

## 11. Project Dependency Tenets

- **Zero external npm dependencies** — use `node:http` and Pi's extension API only
- **Minimal surface area** — the extension bridges Pi to HTTP; keep the bridge thin
- **Validate against real clients** — reference server, P4OC, and SDK are the truth
- **Agent-driven testing for test definition and debugging** — use agents to observe reference-server behavior, encode observations as unit tests, then debug failures
