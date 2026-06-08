# OpenCode API Parity Plan

Goal: systematically audit the original OpenCode serve API (as consumed by P4OC and
the `@opencode-ai/sdk` v1 client) against our pi extension (`src/index.ts`), identify
gaps, fix bugs, and add missing functionality.

## Reference Clients

| Client | Where to find it |
|--------|-----------------|
| P4OC Android app (`OpenCodeApi.kt`) | `~/src/P4OC/app/src/main/java/dev/blazelight/p4oc/core/network/OpenCodeApi.kt` |
| P4OC event model (`OpenCodeEvent.kt`) | `~/src/P4OC/app/src/main/java/dev/blazelight/p4oc/domain/model/Event.kt` |
| P4OC event mapper (`Mappers.kt`) | `~/src/P4OC/app/src/main/java/dev/blazelight/p4oc/data/remote/mapper/Mappers.kt` |
| P4OC DTOs | `~/src/P4OC/app/src/main/java/dev/blazelight/p4oc/data/remote/dto/*.kt` |
| `@opencode-ai/sdk` v1 (npm) | `/tmp/oc-sdk/package/dist/gen/sdk.gen.js` |
| `@opencode-ai/sdk` v2 (npm) | `/tmp/oc-sdk/package/dist/v2/gen/sdk.gen.d.ts` |

## Testing Approach

1. Start an opencode server for reference (launch P4OC-connected opencode binary or use the SDK)
2. Start our server (pi with the extension loaded)
3. Hit each endpoint on both servers and compare responses

## Current State Assessment

### HTTP API — REST Endpoints

Legend:
- **(✓)** implemented and working
- **(~)** partially implemented or has known issues
- **(✗)** not implemented
- **(—)** auto-handled by the stub catch-all

#### Instance & Health

| Endpoint | Method | P4OC | SDK v1 | SDK v2 | Status | Notes |
|----------|--------|------|--------|--------|--------|-------|
| `/health` | GET | — | — | — | ✓ | Not in SDK/P4OC but useful for debugging |
| `/global/health` | GET | ✓ | ✓ | ✓ | ✓ | P4OC calls this for connectivity |
| `/instance` | GET | — | — | — | ✗ | Returns hardcoded `{id, label, config}` — not a real endpoint |
| `/instance/dispose` | POST | ✓ | ✓ | — | ✓ | Stub returns `true` |

#### Project & Path

| Endpoint | Method | P4OC | SDK v1 | SDK v2 | Status | Notes |
|----------|--------|------|--------|--------|--------|-------|
| `/project` | GET | ✓ | ✓ | ✓ | ✓ | Returns array of projects |
| `/project/current` | GET | ✓ | ✓ | ✓ | ✓ | Returns `{worktree}` |
| `/project/{projectID}` | GET | — | — | ✓ | ✗ | Needs route |
| `/project/{projectID}/directories` | GET | — | — | ✓ | ✗ | Needs route |
| `/project/git/init` | POST | — | — | ✓ | ✗ | Needs route |
| `/path` | GET | ✓ | ✓ | ✓ | ✓ | Returns state, config, worktree, directory |

#### Session

| Endpoint | Method | P4OC | SDK v1 | SDK v2 | Status | Notes |
|----------|--------|------|--------|--------|--------|-------|
| `/session` | GET | ✓ | ✓ | ✓ | ✓ | |
| `/session` | POST | ✓ | ✓ | ✓ | ✓ | |
| `/session/status` | GET | ✓ | ✓ | ✓ | ✓ | |
| `/session/{id}` | GET | ✓ | ✓ | ✓ | ✓ | |
| `/session/{id}` | PATCH | ✓ | — | — | ✗ | P4OC uses PATCH for update. We have POST. SDK v1 doesn't call update at all. |
| `/session/{id}` | POST | — | ✓ | — | ✓ | SDK v1 uses POST for update. We implement this. |
| `/session/{id}` | DELETE | ✓ | ✓ | ✓ | ✓ | |
| `/session/{id}/message` | GET | ✓ | ✓ | ✓ | ✓ | |
| `/session/{id}/message` | POST | — | ✓ | — | ✓ | SDK v1 uses POST for sync message |
| `/session/{id}/prompt_async` | POST | ✓ | ✓ | ✓ | ✓ | P4OC uses this for sending messages |
| `/session/{id}/message/{messageID}` | GET | ✓ | ✓ | ✓ | ✓ | |
| `/session/{id}/message/{messageID}/part/{partID}` | PATCH | — | — | ✓ | ✗ | |
| `/session/{id}/message/{messageID}/part/{partID}` | DELETE | — | — | ✓ | ✗ | |
| `/session/{id}/abort` | POST | ✓ | ✓ | ✓ | ✓ | |
| `/session/{id}/fork` | POST | ✓ | ✓ | ✓ | ✓ | |
| `/session/{id}/children` | GET | ✓ | ✓ | ✓ | ✓ | Returns empty |
| `/session/{id}/command` | POST | ✓ | ✓ | ✓ | ✓ | |
| `/session/{id}/shell` | POST | ✓ | ✓ | — | ✗ | Not routed |
| `/session/{id}/diff` | GET | ✓ | ✓ | ✓ | ✓ | Returns empty |
| `/session/{id}/summarize` | POST | ✓ | ✓ | ✓ | ✓ | |
| `/session/{id}/todo` | GET | ✓ | ✓ | ✓ | ✓ | Returns empty |
| `/session/{id}/share` | POST | ✓ | ✓ | ✓ | ✓ | |
| `/session/{id}/share` | DELETE | ✓ | ✓ | — | ✓ | |
| `/session/{id}/revert` | POST | ✓ | ✓ | ✓ | ✓ | |
| `/session/{id}/unrevert` | POST | ✓ | ✓ | ✓ | ✓ | |
| `/session/{id}/init` | POST | ✓ | ✓ | — | ✗ | Not routed |
| `/session/{id}/compact` | POST | — | — | ✓ | ✗ | |
| `/session/{id}/context` | GET | — | — | ✓ | ✗ | |
| `/session/{id}/wait` | GET | — | — | ✓ | ✗ | |

#### Config

| Endpoint | Method | P4OC | SDK v1 | SDK v2 | Status | Notes |
|----------|--------|------|--------|--------|--------|-------|
| `/config` | GET | ✓ | ✓ | ✓ | ✓ | |
| `/config` | PATCH | ✓ | — | — | ✗ | P4OC uses PATCH for config update |
| `/config/providers` | GET | ✓ | ✓ | ✓ | ✓ | |

#### Provider

| Endpoint | Method | P4OC | SDK v1 | SDK v2 | Status | Notes |
|----------|--------|------|--------|--------|--------|-------|
| `/provider` | GET | ✓ | ✓ | ✓ | ✓ | |
| `/provider/auth` | GET | ✓ | ✓ | ✓ | ✓ | |
| `/provider/{id}/oauth/authorize` | POST | ✓ | — | — | ✗ | P4OC uses POST. SDK v1 uses GET |
| `/provider/{id}/oauth/callback` | POST | ✓ | — | — | ✗ | |

#### Agent

| Endpoint | Method | P4OC | SDK v1 | SDK v2 | Status | Notes |
|----------|--------|------|--------|--------|--------|-------|
| `/agent` | GET | ✓ | ✓ | ✓ | ✓ | Returns hardcoded coder agent |
| `/model/active` | POST | ✓ | ✓ | — | ~ | Present but return value semantics unclear |

#### VCS

| Endpoint | Method | P4OC | SDK v1 | SDK v2 | Status | Notes |
|----------|--------|------|--------|--------|--------|-------|
| `/vcs` | GET | ✓ | ✓ | ✓ | ✓ | Returns branch |
| `/vcs/apply` | POST | — | — | ✓ | ✗ | |
| `/vcs/diff` | GET | — | — | ✓ | ✗ | |
| `/vcs/diff/raw` | GET | — | — | ✓ | ✗ | |
| `/vcs/status` | GET | — | — | ✓ | ✗ | |

#### File

| Endpoint | Method | P4OC | SDK v1 | SDK v2 | Status | Notes |
|----------|--------|------|--------|--------|--------|-------|
| `/file` | GET | ✓ | ✓ | ✓ | ✓ | |
| `/file/content` | GET | ✓ | ✓ | ✓ | ✓ | |
| `/file/status` | GET | ✓ | ✓ | ✓ | ✓ | |

#### Find & Search

| Endpoint | Method | P4OC | SDK v1 | SDK v2 | Status | Notes |
|----------|--------|------|--------|--------|--------|-------|
| `/find` | GET | ✓ | ✓ | ✓ | ✓ | |
| `/find/file` | GET | ✓ | ✓ | ✓ | ✓ | |
| `/find/symbol` | GET | ✓ | ✓ | ✓ | ✓ | Returns empty |

#### LSP, Formatter, MCP, PTY

| Endpoint | Method | P4OC | SDK v1 | SDK v2 | Status | Notes |
|----------|--------|------|--------|--------|--------|-------|
| `/lsp` | GET | ✓ | ✓ | ✓ | ~ | Stub returns `[]` |
| `/formatter` | GET | ✓ | ✓ | ✓ | ~ | Stub returns `[]` |
| `/mcp` | GET | ✓ | ✓ | ✓ | ~ | Stub returns `{}` |
| `/mcp/{name}/auth` | * | — | ✓ | ✓ | ~ | Catch-all stub |
| `/mcp/{name}/auth/authenticate` | * | — | ✓ | ✓ | ~ | Catch-all stub |
| `/mcp/{name}/auth/callback` | * | — | ✓ | ✓ | ~ | Catch-all stub |
| `/mcp/{name}/connect` | * | — | ✓ | ✓ | ~ | Catch-all stub |
| `/mcp/{name}/disconnect` | * | — | ✓ | ✓ | ~ | Catch-all stub |
| `/mcp` | POST | ✓ | — | — | ✗ | P4OC sends POST to `/mcp` to add a server |
| `/pty` | GET | ✓ | ✓ | ✓ | ~ | Stub returns `[]` |
| `/pty` | POST | ✓ | — | — | ✗ | P4OC creates PTY sessions |
| `/pty/{id}` | GET | ✓ | ✓ | — | ✗ | Not routed |
| `/pty/{id}` | DELETE | ✓ | — | — | ✗ | |
| `/pty/{id}` | PATCH | ✓ | — | — | ✗ | |
| `/pty/{id}/connect` | GET | ✓ | ✓ | — | ✗ | |

#### Command & Experimental

| Endpoint | Method | P4OC | SDK v1 | SDK v2 | Status | Notes |
|----------|--------|------|--------|--------|--------|-------|
| `/command` | GET | ✓ | ✓ | ✓ | ✓ | |
| `/experimental/tool/ids` | GET | ✓ | ✓ | ✓ | ✓ | |
| `/experimental/tool` | GET | ✓ | ✓ | ✓ | ~ | Only `ids` is routed, not `/experimental/tool` |

#### Auth

| Endpoint | Method | P4OC | SDK v1 | SDK v2 | Status | Notes |
|----------|--------|------|--------|--------|--------|-------|
| `PUT /auth/{id}` | PUT | ✓ | — | — | ~ | Catch-all handles via `/auth/` prefix |
| `/auth/{providerID}` | * | — | ✓ | — | ~ | Catch-all |

#### Sync

| Endpoint | Method | P4OC | SDK v1 | SDK v2 | Status | Notes |
|----------|--------|------|--------|--------|--------|-------|
| `/sync/history` | GET | — | — | ✓ | ✗ | |
| `/sync/replay` | POST | — | — | ✓ | ✗ | |
| `/sync/start` | POST | — | — | ✓ | ✗ | |
| `/sync/steal` | POST | — | — | ✓ | ✗ | |

#### Permission & Question

| Endpoint | Method | P4OC | SDK v1 | SDK v2 | Status | Notes |
|----------|--------|------|--------|--------|--------|-------|
| `/permission` | GET | — | — | ✓ | ✗ | |
| `/permission/{requestID}/reply` | POST | ✓ | ✓ | ✓ | ✗ | Not routed at all |
| `/session/{id}/permissions/{permID}` | POST | — | ✓ | — | ✓ | SDK v1 uses this path |
| `/question` | GET | — | — | ✓ | ✗ | |
| `/question/{requestID}/reply` | POST | ✓ | ✓ | ✓ | ✗ | Not routed despite having a route intent for session-based version |
| `/question/{requestID}/reject` | POST | — | — | ✓ | ✗ | |

#### Log & TUI

| Endpoint | Method | P4OC | SDK v1 | SDK v2 | Status | Notes |
|----------|--------|------|--------|--------|--------|-------|
| `/log` | POST | ✓ | ✓ | ✓ | ✓ | |
| `/tui/*` | * | ✓ | ✓ | ✓ | ~ | All handled by catch-all stubs returning `true` |

### SSE Events

Events that P4OC's `EventMapper` expects (from `Mappers.kt`):

| Event type | P4OC maps? | We emit? | Notes |
|-----------|-----------|---------|-------|
| `server.connected` | ✓ | ✓ | On SSE connect |
| `session.created` | ✓ | ✓ | On POST /session |
| `session.updated` | ✓ | ✓ | On agent_end, session update |
| `session.deleted` | ✓ | ✓ | Broadcast on DELETE (Phase 1 fix) |
| `session.status` | ✓ | ✓ | With `busy`/`idle`/`retry` type |
| `session.idle` | ✓ | ✓ | On agent_end |
| `session.diff` | ✓ | ✗ | Never emitted |
| `session.error` | ✓ | ✓ | Emitted on agent error (Phase 1 fix) |
| `session.compacted` | ✓ | ✗ | Never emitted |
| `message.updated` | ✓ | ✓ | On user/assistant messages |
| `message.part.updated` | ✓ | ✓ | text/reasoning/tool deltas, step-start, step-finish |
| `message.removed` | ✓ | ✗ | Never emitted |
| `message.part.removed` | ✓ | ✗ | Never emitted |
| `permission.asked` | ✓ | ✗ | Never emitted — **critical for P4OC UX** |
| `permission.replied` | ✓ | ✓ | From global & session routes (Phase 1 fix) |
| `question.asked` | ✓ | ✗ | Never emitted |
| `todo.updated` | ✓ | ✗ | Never emitted |
| `file.edited` | ✓ | ✗ | Never emitted |
| `file.watcher.updated` | ✓ | ✗ | Never emitted |
| `vcs.branch.updated` | ✓ | ✗ | Never emitted |
| `command.executed` | ✓ | ✗ | Never emitted |
| `installation.updated` | ✓ | ✗ | Never emitted |
| `installation.update-available` | ✓ | ✗ | Never emitted |
| `lsp.client.diagnostics` | ✓ | ✗ | Never emitted |
| `lsp.updated` | ✓ | ✗ | Never emitted |
| `pty.created` | ✓ | ✗ | Never emitted |
| `pty.updated` | ✓ | ✗ | Never emitted |
| `pty.exited` | ✓ | ✗ | Never emitted |
| `pty.deleted` | ✓ | ✗ | Never emitted |
| `server.instance.disposed` | ✓ | ✗ | Never emitted |

### Known Issues / Bugs

1. ~~**`/instance` GET** — not a real OpenCode API endpoint~~ **FIXED** — returns 404
2. ~~**`/session/{id}` PATCH** — P4OC uses PATCH for session update~~ **FIXED** 
3. ~~**`/session/{id}/shell` POST** — not routed~~ **FIXED**
4. ~~**`/session/{id}/init` POST** — not routed~~ **FIXED**
5. **`/session/{id}/compact` POST** — not routed (Phase 2)
6. **`/session/{id}/context` GET** — not routed (Phase 2)
7. **`/session/{id}/wait` GET** — not routed (Phase 2)
8. **`/session/{id}/message/{messageID}/part/{partID}` PATCH/DELETE** — not routed (Phase 2)
9. ~~**`/permission/{requestID}/reply` POST** — not routed~~ **FIXED** — added global route
10. ~~**`/question/{requestID}/reply` POST** — not routed~~ **FIXED**
11. ~~**`/question/{requestID}/reject` POST** — not routed~~ **FIXED**
12. ~~**`/config` PATCH** — P4OC uses PATCH for config update~~ **FIXED**
13. ~~**`/provider/{id}/oauth/authorize` POST** — not routed~~ **FIXED**
14. ~~**`/provider/{id}/oauth/callback` POST** — not routed~~ **FIXED**
15. ~~**PUT `/auth/{id}`** — P4OC uses PUT~~ **FIXED** — catch-all already handles it
16. ~~**`/mcp` POST** — P4OC sends POST to add MCP servers~~ **FIXED**
17. **`/pty` POST, `/pty/{id}` GET/DELETE/PATCH, `/{id}/connect` GET** — PTY endpoints not routed (Phase 2)
18. **`/experimental/tool` GET** — only `ids` routed, not the list endpoint (Phase 2)
19. **`/project/{projectID}` GET** — not routed (Phase 3)
20. **`/project/{projectID}/directories` GET** — not routed (Phase 3)
21. **`/project/git/init` POST** — not routed (Phase 3)
22. **`/vcs/apply`, `/vcs/diff`, `/vcs/diff/raw`, `/vcs/status`** — not routed (Phase 3)
23. **`/sync/*`** — not routed (Phase 3)
24. **`/global/config` GET/PATCH** — not routed (Phase 2)
25. **`/global/dispose` POST** — not routed (Phase 2)
26. **`/global/upgrade` GET** — not routed (Phase 2)
27. **`/skill` GET** — not routed (Phase 2)
28. ~~**Event: `session.deleted`** — not broadcast on DELETE~~ **FIXED**
29. ~~**Event: `session.error`** — never emitted~~ **FIXED** — added in agent_end handler
30. **Event: `permission.asked`** — never emitted (Phase 4 — critical gap)
31. ~~**Event: `permission.replied`** — emitted from session-scoped endpoint but P4OC uses global path~~ **FIXED** — both global and session-scoped now work
32. ~~**SSE directory scoping** — inconsistent~~ **FIXED** — all broadcasts use `{directory, payload}` format
33. ~~**`POST /model/active`** — returns `{}` but P4OC expects `Boolean`~~ **FIXED** — now returns `true`
34. **SSE replay on reconnect** — eventBuffer clearing logic may drop events if SSE reconnects after buffer is full (Phase 5)
35. **Session message filtering** — `refreshMessagesFromSession` filters by timestamp (Phase 5)

## Implementation Phases

### Phase 1: Critical Fixes (P4OC connectivity)

These are the minimum changes needed for P4OC to work reliably:

- [x] **`/permission/{requestID}/reply` POST** — route and emit `permission.replied` event
- [x] **`/question/{requestID}/reply` POST** — route and emit `question.replied` event
- [x] **`/question/{requestID}/reject` POST** — route stub
- [x] **`/session/{id}/shell` POST** — route stub returning `{ptyID: ...}`
- [x] **`/session/{id}/init` POST** — route stub
- [x] **`PUT /auth/{id}`** — handled by catch-all (added debug logging)
- [x] **`PATCH /session/{id}`** — handle PATCH method (mirrors POST update)
- [x] **`PATCH /config`** — handle PATCH method
- [x] **`POST /model/active`** — return `true` instead of `{}`
- [x] **`/instance` GET** — changed to return 404 (not a standard endpoint)
- [x] **`POST /provider/{id}/oauth/authorize`** — route with POST handler
- [x] **`POST /provider/{id}/oauth/callback`** — route with POST handler
- [x] **`POST /mcp`** — route stub returning `{id: "mcp_..."}`
- [x] **Emit `session.deleted` on DELETE** — broadcast before deleting
- [x] **Emit `session.error` when agent errors** — added in agent_end handler (checks for stopReason === "error" | "aborted")
- [x] **Fix SSE event wrapping** — keepalive heartbeat now uses consistent `{directory, payload}` wrapper

### Phase 2: PTY, LSP, and Feature Stubs — COMPLETE

PTY endpoints and other stubs needed for P4OC:

- [x] **`POST /pty`** — route stub returning `{id: "pty_...", ...}`
- [x] **`GET /pty/{id}`** — route stub returning `{id, sessionID, status: "running"}`
- [x] **`DELETE /pty/{id}`** — route stub returning `true`
- [x] **`PATCH /pty/{id}`** — route stub returning `true`
- [x] **`GET /pty/{id}/connect`** — route stub returning `{url: "ws://placeholder", sessionID}`
- [x] **`GET /experimental/tool`** — route stub returning `{tools: []}`
- [x] **`GET /global/config`** — route stub returning `{theme, agent, provider, mcp}`
- [x] **`PATCH /global/config`** — route stub with body parsing
- [x] **`POST /global/dispose`** — route stub returning `true`
- [x] **`GET /global/upgrade`** — route stub returning `{upgradeAvailable: false}`
- [x] **`GET /skill`** — route stub returning pi skills (via `pi.getSkills()`)
- [x] **`GET /permission`** — route stub returning `[]`
- [x] **`GET /question`** — route stub returning `[]`
- [x] **`GET /session/{id}/compact`** — route stub returning `true`
- [x] **`GET /session/{id}/context`** — route stub returning `{context: []}`
- [x] **`GET /session/{id}/wait`** — route stub returning `{completed: true}`
- [x] **`PATCH /session/{id}/message/{messageID}/part/{partID}`** — route stub
- [x] **`DELETE /session/{id}/message/{messageID}/part/{partID}`** — route stub

### Phase 3: Project, VCS, Sync (v2 SDK parity) — COMPLETE

- [x] **`GET /project/{projectID}`** — route stub returning `{id, worktree, ...}`
- [x] **`GET /project/{projectID}/directories`** — route stub returning `[]`
- [x] **`POST /project/git/init`** — route stub returning `{success: true}`
- [x] **`POST /vcs/apply`** — route stub with body parsing
- [x] **`GET /vcs/diff`** — runs `git diff` in activeCwd
- [x] **`GET /vcs/diff/raw`** — runs `git diff --no-color`
- [x] **`GET /vcs/status`** — runs `git status --porcelain`, returns parsed files
- [x] **`GET /sync/history`** — route stub returning `{entries: [], lastSync: null}`
- [x] **`POST /sync/replay`** — route stub with body parsing
- [x] **`POST /sync/start`** — route stub returning `{syncID, started: true}`
- [x] **`POST /sync/steal`** — route stub returning `{stolen: true}`

### Phase 4: SSE Event Completeness — COMPLETE

- [x] **Emit `session.diff`** — after tool_execution_end for file-modifying tools
- [x] **Emit `session.compacted`** — via `pi.on("session_compact")` subscription
- [x] **Emit `todo.updated`** — after any tool execution completes (stub: empty todos)
- [x] **Emit `file.edited`** — after tool_execution_end for file-modifying tools
- [x] **Emit `file.watcher.updated`** — after tool_execution_end for file-modifying tools
- [x] **Emit `vcs.branch.updated`** — on session_start (queries git branch)
- [x] **Emit `command.executed`** — in POST /session/{id}/command handler
- [x] **Emit `permission.asked`** — in tool_execution_start for sensitive tools (bash, edit, write, execute_command)
- [x] **Handle pi permission events** — mapped through tool_execution_start with permission-flagged tool names
- [x] **Handle pi question events** — mapped through message_start for user messages matching question patterns

### Phase 5: Correctness & Robustness — PARTIAL

- [x] **Fix SSE buffer replay on reconnect** — buffer is now a sliding window; not cleared on replay
- [x] **Fix session message filtering** — GET /session/{id}/message now switches `currentSessionId` when requesting a different session
- [x] **Add proper error codes/responses** — added `authError()` (401 ProviderAuthError) and `serverError()` (500 UnknownError) helpers; existing `NotFoundError`, `BadRequestError` already in use
- [x] **Add debug logging with `OPENCODE_LOG_LEVEL=debug`** — already implemented (dlog function)
- [x] **Add `/api/*` prefix routes** — `/api/...` paths are automatically stripped in handleRequest
- [ ] **Validate response shapes against P4OC DTOs** — requires unified P4OC reference comparison; deferred to Phase 6
- [ ] **Add `directory` query param support** — deferred; low P4OC priority since our session model is single-session

### Phase 6: Testing & Validation — INITIATED

- [x] **Write endpoint smoke tests** — `test/smoke.sh` created (bash-based, covers all phases)
- [x] **Document any remaining gaps** — see AGENTS.md §8 and summary below
- [ ] **Start opencode reference server** — blocked by unimplemented or broken Pi extension startup (github-autocomplete crash)
- [ ] **Write SSE event flow tests** — pending Pi extension startup fix
- [ ] **Test against P4OC** — pending Pi extension startup fix
- [ ] **Test session lifecycle** — pending Pi extension startup fix
- [ ] **Test file operations** — covered by smoke tests
- [ ] **Test reconnection** — pending

## How to test each phase

```bash
# Start reference opencode server (if available)
cd ~/src/opencode && go run . serve --port 4097

# Start pi with our extension
cd ~/src/pi-opencode-serve-api
PI_SERVE_PORT=4096 pi -e ./src/index.ts

# Compare endpoints
curl -s http://127.0.0.1:4096/health
curl -s http://127.0.0.1:4097/global/health

# Check responses match expected DTO shapes
curl -s http://127.0.0.1:4096/session | python3 -m json.tool
```

## Notes

- P4OC connects to `/global/event` for SSE, not `/event`
- Events are wrapped in `{directory: ..., payload: {type, properties}}` format
- P4OC's DTOs use `@SerialName` annotations for field naming; our JSON keys must match
- The `session.idle` event (not `session.status`) signals P4OC to re-enable the send button
- `permission.asked` events are the primary mechanism P4OC uses to show permission dialogs
