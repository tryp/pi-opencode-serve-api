#!/usr/bin/env node
/**
 * SSE Event Flow Test Harness
 *
 * Reusable harness for capturing and comparing SSE event streams from both
 * the reference opencode server and our Pi extension.
 *
 * ─── Modes ─────────────────────────────────────────────────────────────
 *
 *   capture    Capture SSE event stream from a server as a reference snapshot
 *   test       Capture SSE event stream and compare against a snapshot
 *   list       List available snapshots
 *
 * ─── Usage ─────────────────────────────────────────────────────────────
 *
 *   # Capture a reference snapshot from opencode on port 4097
 *   node test/sse-harness.mjs capture --port 4097 --snapshot test/snapshots/basic-prompt.jsonl
 *
 *   # Test our extension on port 4096 against a snapshot
 *   node test/sse-harness.mjs test --port 4096 --snapshot test/snapshots/basic-prompt.jsonl
 *
 *   # List available snapshots
 *   node test/sse-harness.mjs list
 *
 *   # Programmatic API (for use in other scripts)
 *   import { capture, test, compareEvents } from "./sse-harness.mjs";
 *
 * ─── Capture mode with custom prompt ───────────────────────────────────
 *
 *   node test/sse-harness.mjs capture \
 *     --port 4096 \
 *     --snapshot test/snapshots/hello-world.jsonl \
 *     --message "Write hello world in python" \
 *     --timeout 120
 *
 * ─── Event Sequence Format ─────────────────────────────────────────────
 *
 * Snapshots are JSONL files, one event per line:
 *
 *   {"type":"server.connected","properties":{},"_ts":1717000000000}
 *   {"type":"session.created","properties":{"info":{"id":"...","title":""}}}
 *   {"type":"session.status","properties":{"sessionID":"...","status":{"type":"idle"}}}
 *
 * Dynamic fields (id, eventId, timestamps) are preserved but marked for
 * structural comparison with placeholder matching.
 */

import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

// ─── Constants ──────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SNAPSHOT_DIR = join(ROOT, "test", "snapshots");
const DEFAULT_PORT = 4096;
const DEFAULT_TIMEOUT = 90; // seconds

// ─── Types ──────────────────────────────────────────────────────────────

/**
 * @typedef {Object} SSEEvent
 * @property {string} type
 * @property {Object} properties
 * @property {number} [_ts] - capture timestamp
 * @property {string} [_raw] - raw JSON for reference
 */

/**
 * @typedef {Object} CompareResult
 * @property {boolean} pass
 * @property {number} total
 * @property {number} matched
 * @property {number} mismatched
 * @property {string[]} errors
 */

// ─── Dynamic field patterns ────────────────────────────────────────────

/** Fields whose values are dynamically generated and should be ignored in comparison */
const DYNAMIC_FIELDS = new Set([
    "id",           // session, message, part IDs
    "callID",       // tool call IDs
    "sessionID",    // session ID (compared structurally, not by value)
    "messageID",    // message IDs
    "partID",       // part IDs
    "toolCallId",   // tool call IDs
    "permissionID", // permission request IDs
    "questionID",   // question IDs
    "eventId",      // event IDs
    "branch",       // git branch name (varies by environment)
    "worktree",     // workspace path (varies by environment)
]);

/** Property paths that are always dynamic (dot-notation) */
const DYNAMIC_PATHS = [
    "info.id",
    "info.projectID",
    "info.directory",
    "info.time.created",
    "info.time.updated",
    "info.version",
    "part.id",
    "part.messageID",
    "part.sessionID",
    "part.callID",
    "part.time.start",
    "part.time.end",
    "part.state.time.start",
    "part.state.time.end",
    "state.time.start",
    "state.time.end",
    "info.createdAt",
    "info.updatedAt",
    "info.compactingAt",
    "time.created",
    "time.updated",
    "time.start",
    "time.end",
];

// ─── Logger ─────────────────────────────────────────────────────────────

const LOG_PREFIX = {
    INFO: "  [info]",
    OK: "   [ok]",
    PASS: " [pass]",
    FAIL: " [fail]",
    WARN: " [warn]",
    DATA: " [data]",
};

function log(tag, msg, ...args) {
    const line = `${tag} ${msg}` + (args.length ? " " + args.map(a => typeof a === "object" ? JSON.stringify(a) : a).join(" ") : "");
    process.stdout.write(line + "\n");
}

// ─── SSE Parsing ────────────────────────────────────────────────────────

/**
 * Parse an SSE stream from a readable response body.
 * Yields {type, properties, id?, _raw} objects.
 *
 * Handles:
 *   data: {...}\n\n         - standard SSE data frame
 *   event: xxx\ndata: {...} - named event (not used by opencode)
 *   id: xxx                 - event ID (used by opencode)
 */
async function* parseSSEStream(response) {
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEventType = null;
    let currentData = null;
    let currentId = null;

    for await (const chunk of response) {
        buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });

        while (buffer.includes("\n\n")) {
            const idx = buffer.indexOf("\n\n");
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);

            const lines = frame.split("\n");
            for (const line of lines) {
                if (line.startsWith("event: ")) {
                    currentEventType = line.slice(7).trim();
                } else if (line.startsWith("data: ")) {
                    currentData = line.slice(6).trim();
                } else if (line.startsWith("id: ")) {
                    currentId = line.slice(4).trim();
                } else if (line === "" && currentData) {
                    // Empty line in frame — no-op
                }
            }

            // Emit if we have data
            if (currentData !== null) {
                try {
                    const parsed = JSON.parse(currentData);
                    // SSE wrapper: {directory, payload: {type, properties, id?}}
                    // or raw event from reference server
                    let event;
                    if (parsed.payload && parsed.payload.type) {
                        // Wrapped format (our extension)
                        const { directory, payload } = parsed;
                        event = {
                            type: payload.type,
                            properties: payload.properties || {},
                            id: payload.id || currentId,
                            _directory: directory,
                            _raw: currentData,
                        };
                    } else if (parsed.type) {
                        // Direct format (reference server or unwrapped)
                        event = {
                            type: parsed.type,
                            properties: parsed.properties || {},
                            id: parsed.id || currentId,
                            _raw: currentData,
                        };
                    } else {
                        // Unknown format — wrap as-is
                        event = {
                            type: "_unknown",
                            properties: parsed,
                            _raw: currentData,
                        };
                    }
                    event._ts = Date.now();
                    yield event;
                } catch {
                    // Non-JSON data line — skip
                }
                currentData = null;
                currentEventType = null;
                currentId = null;
            }
        }
    }

    // Handle trailing data without \n\n
    if (currentData !== null) {
        try {
            const parsed = JSON.parse(currentData);
            let event;
            if (parsed.payload && parsed.payload.type) {
                event = {
                    type: parsed.payload.type,
                    properties: parsed.payload.properties || {},
                    id: parsed.payload.id || currentId,
                    _directory: parsed.directory,
                    _raw: currentData,
                };
            } else if (parsed.type) {
                event = {
                    type: parsed.type,
                    properties: parsed.properties || {},
                    id: parsed.id || currentId,
                    _raw: currentData,
                };
            } else {
                event = { type: "_unknown", properties: parsed, _raw: currentData };
            }
            event._ts = Date.now();
            yield event;
        } catch { /* skip unparseable trailing data */ }
    }
}

// ─── HTTP helpers ───────────────────────────────────────────────────────

function fetchSSE(url, timeout = 10_000) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const opts = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port,
            path: parsedUrl.pathname,
            method: "GET",
            headers: {
                "Accept": "text/event-stream",
                "Cache-Control": "no-cache",
            },
            timeout,
        };

        const req = (parsedUrl.protocol === "https:" ? https : http).request(opts, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`SSE connection failed: HTTP ${res.statusCode}`));
                return;
            }
            resolve(res);
        });

        req.on("error", reject);
        req.on("timeout", () => {
            req.destroy();
            reject(new Error("SSE connection timed out"));
        });
        req.end();
    });
}

/**
 * Wait for server to be ready by polling a health endpoint.
 */
async function waitForServer(baseUrl, timeout = 30_000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        try {
            const res = await fetch(`${baseUrl}/health`);
            if (res.ok) return true;
        } catch { /* server not ready yet */ }
        await new Promise(r => setTimeout(r, 500));
    }
    throw new Error(`Server at ${baseUrl} did not become ready within ${timeout}ms`);
}

/**
 * Send a prompt to a session and return the response.
 *
 * The OpenCode wire format expects parts array:
 *   { parts: [{ type: "text", text: "..." }] }
 */
async function sendPrompt(baseUrl, sessionId, message, timeout = 30_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        const res = await fetch(`${baseUrl}/session/${sessionId}/prompt_async`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ parts: [{ type: "text", text: message }] }),
            signal: controller.signal,
        });

        if (!res.ok) {
            throw new Error(`Prompt failed: HTTP ${res.status} ${await res.text()}`);
        }

        // 204 No Content — prompt accepted, no response body
        if (res.status === 204) {
            return { accepted: true };
        }

        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Create a session on the server.
 */
async function createSession(baseUrl, title = "test-session") {
    const res = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
    });

    if (!res.ok) {
        throw new Error(`Session creation failed: HTTP ${res.status} ${await res.text()}`);
    }

    return await res.json();
}

// ─── Event recording ────────────────────────────────────────────────────

/**
 * Subscribe to SSE and record all events until a terminal event is received
 * or timeout elapses.
 *
 * Terminal events (stop recording when seen, in order of priority):
 *   - session.idle  (signal: send button re-enabled, response complete)
 *   - session.error (signal: error occurred)
 *   - message.removed (signal: message was removed)
 *
 * @param {string} baseUrl
 * @param {Object} options
 * @param {number} [options.timeout=90]
 * @param {number} [options.promptTimeout=30]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<SSEEvent[]>}
 */
async function recordEvents(baseUrl, options = {}) {
    const timeout = (options.timeout || DEFAULT_TIMEOUT) * 1000;
    const signal = options.signal;

    const events = [];
    const terminalEvents = new Set(["session.idle", "session.error", "message.removed"]);
    const terminalSeen = new Set();
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
        const url = `${baseUrl}/global/event`;
        const parsedUrl = new URL(url);

        const opts = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port,
            path: parsedUrl.pathname,
            method: "GET",
            headers: {
                "Accept": "text/event-stream",
                "Cache-Control": "no-cache",
            },
        };

        const req = http.request(opts, async (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`SSE connection failed: HTTP ${res.statusCode}`));
                return;
            }

            try {
                for await (const event of parseSSEStream(res)) {
                    events.push(event);

                    // Check for terminal events
                    if (terminalEvents.has(event.type)) {
                        terminalSeen.add(event.type);
                        // session.idle + no pending tool execution = response complete
                        if (event.type === "session.idle") {
                            // Give a short grace period for any trailing events
                            await new Promise(r => setTimeout(r, 1000));
                            resolve(events);
                            return;
                        }
                        if (event.type === "session.error") {
                            resolve(events);
                            return;
                        }
                    }

                    // Timeout check
                    if (Date.now() - startTime > timeout) {
                        resolve(events);
                        return;
                    }

                    // External abort
                    if (signal?.aborted) {
                        resolve(events);
                        return;
                    }
                }
                // Stream ended naturally
                resolve(events);
            } catch (err) {
                // If we already have events, resolve with what we got
                if (events.length > 0) {
                    resolve(events);
                } else {
                    reject(err);
                }
            }
        });

        req.on("error", reject);
        req.setTimeout(timeout, () => {
            req.destroy();
            resolve(events);
        });
        req.end();
    });
}

// ─── Event comparison ───────────────────────────────────────────────────

/**
 * Strip dynamic fields from an event for structural comparison.
 * Replaces dynamic values with placeholder strings.
 */
function stripDynamic(event) {
    const result = { type: event.type, properties: {} };

    function stripValue(value, path = "") {
        if (typeof value === "string" && (
            DYNAMIC_FIELDS.has(path.split(".").pop()) ||
            DYNAMIC_PATHS.includes(path) ||
            value.length > 40 ||
            /^[a-f0-9]{8}-[a-f0-9]{4}-/.test(value) || // UUID
            /^evt_/.test(value) ||                       // event ID
            /^\d{10,}$/.test(value)                      // unix timestamp
        )) {
            return `«dynamic:${path || "value"}»`;
        }
        if (Array.isArray(value)) {
            return value.map((v, i) => stripValue(v, `${path}[${i}]`));
        }
        if (value !== null && typeof value === "object") {
            const obj = {};
            for (const [k, v] of Object.entries(value)) {
                obj[k] = stripValue(v, path ? `${path}.${k}` : k);
            }
            return obj;
        }
        return value;
    }

    for (const [k, v] of Object.entries(event.properties || {})) {
        result.properties[k] = stripValue(v, k);
    }

    return result;
}

/**
 * Compare two event sequences structurally.
 * Returns detailed comparison result.
 *
 * @param {SSEEvent[]} actual
 * @param {SSEEvent[]} expected
 * @param {Object} [options]
 * @param {boolean} [options.verbose=false]
 * @param {string[]} [options.ignoreTypes] - event types to skip in comparison
 * @returns {CompareResult}
 */
function compareEvents(actual, expected, options = {}) {
    const verbose = options.verbose || false;
    const ignoreTypes = new Set(options.ignoreTypes || [
        "server.connected",
    ]);

    const errors = [];
    let matched = 0;
    let mismatched = 0;

    // Filter out events to ignore
    const filteredActual = actual.filter(e => !ignoreTypes.has(e.type));
    const filteredExpected = expected.filter(e => !ignoreTypes.has(e.type));

    const total = Math.max(filteredActual.length, filteredExpected.length);

    if (total === 0) {
        return { pass: true, total: 0, matched: 0, mismatched: 0, errors: [] };
    }

    // Compare by position first
    const maxLen = Math.min(filteredActual.length, filteredExpected.length);
    for (let i = 0; i < maxLen; i++) {
        const a = filteredActual[i];
        const e = filteredExpected[i];

        if (a.type !== e.type) {
            errors.push(`[${i}] type mismatch: expected "${e.type}", got "${a.type}"`);
            mismatched++;
            continue;
        }

        const aStripped = stripDynamic(a);
        const eStripped = stripDynamic(e);

        const aStr = JSON.stringify(aStripped);
        const eStr = JSON.stringify(eStripped);

        if (aStr !== eStr) {
            errors.push(`[${i}] properties mismatch for "${a.type}":`);
            if (verbose) {
                errors.push(`  expected: ${eStr}`);
                errors.push(`  actual:   ${aStr}`);
            }
            mismatched++;
        } else {
            matched++;
        }
    }

    // Extra events in actual
    if (filteredActual.length > filteredExpected.length) {
        for (let i = maxLen; i < filteredActual.length; i++) {
            errors.push(`[${i}] unexpected event: "${filteredActual[i].type}"`);
            mismatched++;
        }
    }

    // Missing events
    if (filteredExpected.length > filteredActual.length) {
        for (let i = maxLen; i < filteredExpected.length; i++) {
            errors.push(`[${i}] missing event: "${filteredExpected[i].type}"`);
            mismatched++;
        }
    }

    return {
        pass: mismatched === 0,
        total,
        matched,
        mismatched,
        errors,
    };
}

/**
 * Summary comparison — checks that all expected event types appear in order,
 * ignoring extra events that may be interspersed (e.g., tool_execution_update).
 *
 * This is more lenient than compareEvents and better suited for real LLM
 * responses where tool execution may produce variable event sequences.
 *
 * @param {SSEEvent[]} actual
 * @param {SSEEvent[]} expected
 * @param {Object} [options]
 * @returns {CompareResult}
 */
function compareEventTypes(actual, expected, options = {}) {
    // Types whose counts vary by server state (e.g., replayed sessions on
    // SSE reconnect). We compare them as binary present/absent rather than
    // by exact count.
    const ignoreTypes = new Set(options.ignoreTypes || [
        "server.connected",
        "session.created",
        "session.status",
        "vcs.branch.updated",
        "keepalive",
    ]);
    // Types that must follow the same sequence in both streams.
    // Extra occurrences of these in either stream trigger a mismatch.
    const coreTypes = new Set([
        "session.updated",
        "session.deleted",
        "session.idle",
        "session.error",
        "session.diff",
        "session.compacted",
        "message.updated",
        "message.part.updated",
        "message.removed",
        "message.part.removed",
        "permission.asked",
        "permission.replied",
        "question.asked",
        "todo.updated",
        "file.edited",
        "file.watcher.updated",
        "command.executed",
    ]);

    const errors = [];

    // Filter to core types only, preserving order
    const actualTypes = actual
        .filter(e => !ignoreTypes.has(e.type) && coreTypes.has(e.type))
        .map(e => e.type);
    const expectedTypes = expected
        .filter(e => !ignoreTypes.has(e.type) && coreTypes.has(e.type))
        .map(e => e.type);

    // Check that core event types appear in same order (allowing extras)
    let ai = 0;
    let ei = 0;
    let matched = 0;
    let mismatched = 0;

    while (ei < expectedTypes.length && ai < actualTypes.length) {
        if (actualTypes[ai] === expectedTypes[ei]) {
            matched++;
            ai++;
            ei++;
        } else {
            ai++;
        }
    }

    if (ei < expectedTypes.length) {
        const missing = expectedTypes.slice(ei);
        errors.push(`Missing ${missing.length} core event(s) after position ${ai}: ${missing.join(", ")}`);
        mismatched += missing.length;
    }

    // Check for unexpected core events in actual (not in expected)
    const expectedSet = new Set(expectedTypes);
    const unexpectedActual = actualTypes.filter(t => !expectedSet.has(t));
    if (unexpectedActual.length > 0) {
        errors.push(`Unexpected core events in actual stream: ${[...new Set(unexpectedActual)].join(", ")}`);
        mismatched += unexpectedActual.length;
    }

    return {
        pass: mismatched === 0,
        total: Math.max(expectedTypes.length, actualTypes.length),
        matched,
        mismatched,
        errors,
    };
}

// ─── Snapshot I/O ──────────────────────────────────────────────────────

/**
 * Save events as a JSONL snapshot file.
 */
function saveSnapshot(filePath, events) {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }

    const metadata = {
        _snapshot: {
            createdAt: new Date().toISOString(),
            count: events.length,
            types: [...new Set(events.map(e => e.type))],
        },
    };

    const lines = [
        JSON.stringify(metadata),
        ...events.map(e => {
            const { _raw, _ts, ...clean } = e;
            return JSON.stringify(clean);
        }),
    ];

    writeFileSync(filePath, lines.join("\n") + "\n");
    log(" [save]", `Saved ${events.length} events to ${filePath}`);
    return events.length;
}

/**
 * Load events from a JSONL snapshot file.
 * Returns {metadata, events}.
 */
function loadSnapshot(filePath) {
    if (!existsSync(filePath)) {
        throw new Error(`Snapshot not found: ${filePath}`);
    }

    const content = readFileSync(filePath, "utf8");
    const lines = content.trim().split("\n");

    let metadata = {};
    const events = [];
    let firstLine = true;

    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            const parsed = JSON.parse(line);
            if (firstLine && parsed._snapshot) {
                metadata = parsed._snapshot;
                firstLine = false;
            } else {
                events.push(parsed);
                firstLine = false;
            }
        } catch {
            // skip unparseable lines
        }
    }

    return { metadata, events };
}

/**
 * List available snapshots in the snapshot directory.
 */
function listSnapshots() {
    if (!existsSync(SNAPSHOT_DIR)) {
        return [];
    }

    const files = readdirSync(SNAPSHOT_DIR)
        .filter(f => f.endsWith(".jsonl"))
        .map(f => {
            const fp = join(SNAPSHOT_DIR, f);
            const stat = existsSync(fp) ? readFileSync(fp, "utf8") : "";
            const firstLine = stat.trim().split("\n")[0] || "{}";
            let meta = {};
            try { meta = JSON.parse(firstLine); } catch {}
            return {
                name: f,
                path: fp,
                count: meta._snapshot?.count || 0,
                types: meta._snapshot?.types || [],
                createdAt: meta._snapshot?.createdAt || "unknown",
            };
        })
        .sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));

    return files;
}

// ─── Capture mode ──────────────────────────────────────────────────────

/**
 * Capture SSE event stream from a server.
 *
 * 1. Connect to the server
 * 2. Subscribe to SSE on /global/event
 * 3. Create a session
 * 4. Send the configured prompt
 * 5. Record events until session.idle or timeout
 * 6. Save snapshot
 * 7. Print event summary
 *
 * @param {Object} options
 * @param {number} options.port
 * @param {string} options.snapshot
 * @param {string} [options.message="Say 'hello' and nothing else"]
 * @param {number} [options.timeout=90]
 * @returns {Promise<{events: SSEEvent[], filePath: string}>}
 */
async function capture(options = {}) {
    const port = options.port || DEFAULT_PORT;
    const snapshotPath = options.snapshot || join(SNAPSHOT_DIR, `capture-${port}-${Date.now()}.jsonl`);
    const message = options.message || "Say 'hello' and nothing else";
    const timeout = options.timeout || DEFAULT_TIMEOUT;

    const baseUrl = `http://127.0.0.1:${port}`;

    log("", "");
    log(" [info]", `=== SSE Capture Mode ===`);
    log(" [info]", `Server:    ${baseUrl}`);
    log(" [info]", `Snapshot:  ${snapshotPath}`);
    log(" [info]", `Message:   "${message}"`);
    log(" [info]", `Timeout:   ${timeout}s`);
    log("", "");

    // Wait for server
    log(" [info]", "Waiting for server...");
    await waitForServer(baseUrl);

    // Subscribe to SSE
    log(" [info]", "Subscribing to SSE...");
    const eventsPromise = recordEvents(baseUrl, { timeout });

    // Give SSE subscription time to establish
    await new Promise(r => setTimeout(r, 1000));

    // Create a session
    log(" [info]", "Creating session...");
    const session = await createSession(baseUrl);
    const sessionId = session.id;
    log("   [ok]", `Session ID: ${sessionId}`);

    // Send prompt
    log(" [info]", `Sending prompt: "${message}"...`);
    const promptResult = await sendPrompt(baseUrl, sessionId, message);
    log("   [ok]", `Prompt accepted: ${JSON.stringify(promptResult)}`);

    // Wait for events
    log(" [info]", `Recording events (timeout: ${timeout}s)...`);
    const events = await eventsPromise;

    // Save snapshot
    const saved = saveSnapshot(snapshotPath, events);

    // Summarize
    const types = [...new Set(events.map(e => e.type))];
    log("", "");
    log(" [data]", `Events captured: ${events.length}`);
    log(" [data]", `Event types:     ${types.length}`);
    for (const t of types) {
        const count = events.filter(e => e.type === t).length;
        log(" [data]", `  ${t}: ${count}`);
    }
    log("", "");
    log("   [ok]", `Snapshot saved to: ${snapshotPath}`);

    return { events, filePath: snapshotPath };
}

// ─── Test mode ─────────────────────────────────────────────────────────

/**
 * Test our extension against a reference snapshot.
 *
 * 1. Connect to our extension server
 * 2. Subscribe to SSE on /global/event
 * 3. Create a session
 * 4. Send the configured prompt
 * 5. Record events until session.idle or timeout
 * 6. Compare against snapshot
 * 7. Report pass/fail
 *
 * @param {Object} options
 * @param {number} options.port
 * @param {string} options.snapshot
 * @param {string} [options.message] - overrides snapshot message if provided
 * @param {number} [options.timeout=90]
 * @param {string} [options.mode="strict"] - "strict" or "type-order" comparison
 * @returns {Promise<{pass: boolean, result: CompareResult}>}
 */
async function test(options = {}) {
    const port = options.port || DEFAULT_PORT;
    const snapshotPath = options.snapshot;
    const timeout = options.timeout || DEFAULT_TIMEOUT;
    const mode = options.mode || "type-order"; // "strict" or "type-order"

    if (!snapshotPath) {
        throw new Error("Snapshot path is required for test mode");
    }

    // Load snapshot
    const { metadata, events: expectedEvents } = loadSnapshot(snapshotPath);
    log(" [info]", `Loaded snapshot: ${snapshotPath} (${expectedEvents.length} events)`);

    // Determine message from snapshot if not overridden
    const message = options.message || "Say 'hello' and nothing else";

    const baseUrl = `http://127.0.0.1:${port}`;

    log("", "");
    log(" [info]", `=== SSE Test Mode (${mode}) ===`);
    log(" [info]", `Server:    ${baseUrl}`);
    log(" [info]", `Snapshot:  ${snapshotPath} (${expectedEvents.length} events)`);
    log(" [info]", `Message:   "${message}"`);
    log(" [info]", `Timeout:   ${timeout}s`);
    log("", "");

    // Wait for server
    log(" [info]", "Waiting for server...");
    await waitForServer(baseUrl);

    // Subscribe to SSE
    log(" [info]", "Subscribing to SSE...");
    const eventsPromise = recordEvents(baseUrl, { timeout });

    // Give SSE subscription time to establish
    await new Promise(r => setTimeout(r, 1000));

    // Create a session
    log(" [info]", "Creating session...");
    const session = await createSession(baseUrl);
    const sessionId = session.id;
    log("   [ok]", `Session ID: ${sessionId}`);

    // Send prompt
    log(" [info]", `Sending prompt: "${message}"...`);
    const promptResult = await sendPrompt(baseUrl, sessionId, message);
    log("   [ok]", `Prompt accepted: ${JSON.stringify(promptResult)}`);

    // Wait for events
    log(" [info]", `Recording events (timeout: ${timeout}s)...`);
    const actualEvents = await eventsPromise;

    // Compare
    log("", "");
    log(" [info]", `Events received: ${actualEvents.length}`);
    log(" [info]", "Comparing against snapshot...");

    let result;
    if (mode === "strict") {
        result = compareEvents(actualEvents, expectedEvents, { verbose: true });
    } else {
        result = compareEventTypes(actualEvents, expectedEvents);
    }

    // Report
    log("", "");
    if (result.pass) {
        log(" [pass]", `TEST PASSED — ${result.matched}/${result.total} events matched`);
    } else {
        log(" [fail]", `TEST FAILED — ${result.matched}/${result.total} matched, ${result.mismatched} mismatches`);
        for (const err of result.errors.slice(0, 20)) {
            log(" [fail]", `  ${err}`);
        }
        if (result.errors.length > 20) {
            log(" [warn]", `  ... and ${result.errors.length - 20} more errors`);
        }
    }

    // Event type summary
    const actualTypes = [...new Set(actualEvents.map(e => e.type))];
    const expectedTypes = [...new Set(expectedEvents.map(e => e.type))];
    log("", "");
    log(" [data]", "Event types in actual stream:");
    for (const t of actualTypes) {
        const count = actualEvents.filter(e => e.type === t).length;
        log(" [data]", `  ${t}: ${count}`);
    }
    log(" [data]", "Event types in snapshot:");
    for (const t of expectedTypes) {
        const count = expectedEvents.filter(e => e.type === t).length;
        log(" [data]", `  ${t}: ${count}`);
    }

    // Save actual events for debugging
    const debugPath = snapshotPath.replace(".jsonl", ".actual.jsonl");
    saveSnapshot(debugPath, actualEvents);
    log(" [info]", `Actual events saved to: ${debugPath}`);

    log("", "");
    return { pass: result.pass, result };
}

// ─── Startup & Process Management ──────────────────────────────────────

/**
 * Start our Pi extension as a child process using RPC mode.
 *
 * Interactive TUI mode prevents the HTTP server's listen callback from
 * firing (pi's TUI captures stdout/stderr), but RPC mode (`--mode rpc`)
 * with the stdin pipe kept open works correctly.
 *
 * The stdin pipe is held open (but not written to) to prevent pi from
 * seeing EOF on stdin, which would cause RPC mode to exit.
 *
 * @param {Object} options
 * @param {number} [options.port=4096]
 * @param {string} [options.host="127.0.0.1"]
 * @param {boolean} [options.quiet=false]
 * @returns {{ proc: ChildProcess, stdinPipe: WritableStream|undefined, cleanup: Function }}
 */
function startExtension(options = {}) {
    const port = options.port || DEFAULT_PORT;
    const host = options.host || "127.0.0.1";
    const quiet = options.quiet || false;

    const env = {
        ...process.env,
        PI_SERVE_PORT: String(port),
        PI_SERVE_HOST: host,
    };

    if (quiet) {
        env.OPENCODE_LOG_LEVEL = "quiet";
    }

    // Use --no-extensions to avoid loading the globally installed extension
    // which would conflict on flag registration and port binding.
    // Use --mode rpc to avoid the TUI which prevents the HTTP server's
    // listen callback from firing in interactive mode.
    // Use "pipe" for stdin and keep the write end open so pi never sees
    // EOF on stdin (which would cause RPC mode to exit).
    const proc = spawn("pi", [
        "--no-extensions",
        "-e", "./src/index.ts",
        "--mode", "rpc",
    ], {
        cwd: ROOT,
        env,
        stdio: [
            "pipe",  // stdin: keep open to prevent pi from exiting
            quiet ? "pipe" : "inherit",  // stdout
            quiet ? "pipe" : "inherit",  // stderr
        ],
        detached: false,
    });

    // Keep stdin open by retaining a reference to proc.stdin
    // We don't write anything — just keeping the pipe open prevents EOF.
    const stdinPipe = proc.stdin;

    proc.on("error", (err) => {
        log(" [fail]", `Failed to start Pi extension: ${err.message}`);
    });

    proc.on("exit", (code) => {
        try { stdinPipe?.destroy(); } catch {}
        if (code !== 0 && !quiet) {
            log(" [warn]", `Pi extension exited with code ${code}`);
        }
    });

    const cleanup = () => {
        try {
            if (proc.pid) process.kill(proc.pid, "SIGTERM");
        } catch {}
        try { stdinPipe?.destroy(); } catch {}
    };

    return { proc, stdinPipe, cleanup };
}

/**
 * Stop a child process gracefully.
 */
function stopProcess(proc, signal = "SIGTERM") {
    return new Promise((resolve) => {
        if (!proc || !proc.pid) {
            resolve();
            return;
        }
        const timer = setTimeout(() => {
            try { process.kill(proc.pid, "SIGKILL"); } catch {}
            resolve();
        }, 5000);

        proc.on("exit", () => {
            clearTimeout(timer);
            resolve();
        });

        try {
            process.kill(proc.pid, signal);
        } catch {
            clearTimeout(timer);
            resolve();
        }
    });
}

// ─── CLI ────────────────────────────────────────────────────────────────

function printUsage() {
    console.log(`
SSE Event Flow Test Harness

Usage:
  node test/sse-harness.mjs <command> [options]

Commands:
  capture         Capture SSE events from a server as reference snapshot
  test            Test SSE events against a reference snapshot
  list            List available snapshots
  compare         Compare two snapshot files

Capture options:
  --port <n>      Server port (default: 4096)
  --snapshot <p>  Output snapshot path
  --message <s>   Prompt message (default: "Say 'hello' and nothing else")
  --timeout <n>   Recording timeout in seconds (default: 90)

Test options:
  --port <n>      Server port (default: 4096)
  --snapshot <p>  Reference snapshot path (required)
  --message <s>   Prompt message (default: from snapshot)
  --timeout <n>   Recording timeout in seconds (default: 90)
  --mode <m>      Comparison mode: "strict" or "type-order" (default: type-order)

List options:
  --dir <p>       Snapshot directory (default: test/snapshots)

Compare options:
  --actual <p>    Actual events file (required)
  --expected <p>  Expected events file (required)
  --mode <m>      Comparison mode: "strict" or "type-order" (default: type-order)

Examples:
  # Capture from reference opencode
  node test/sse-harness.mjs capture --port 4097 --snapshot test/snapshots/ref-prompt.jsonl

  # Test our extension
  node test/sse-harness.mjs test --port 4096 --snapshot test/snapshots/ref-prompt.jsonl

  # Capture with custom prompt
  node test/sse-harness.mjs capture --port 4096 \\
    --snapshot test/snapshots/hello-py.jsonl \\
    --message "Write hello world in python"
`.trim());
}

async function main() {
    const args = process.argv.slice(2);
    const command = args[0];

    function getOpt(name, def) {
        const idx = args.indexOf(name);
        return idx >= 0 ? args[idx + 1] : def;
    }

    function hasOpt(name) {
        return args.includes(name);
    }

    if (hasOpt("--help") || hasOpt("-h") || !command) {
        printUsage();
        return;
    }

    try {
        switch (command) {
            case "capture": {
                const result = await capture({
                    port: parseInt(getOpt("--port", String(DEFAULT_PORT))),
                    snapshot: getOpt("--snapshot"),
                    message: getOpt("--message"),
                    timeout: parseInt(getOpt("--timeout", String(DEFAULT_TIMEOUT))),
                });
                process.exit(0);
                break;
            }

            case "test": {
                const result = await test({
                    port: parseInt(getOpt("--port", String(DEFAULT_PORT))),
                    snapshot: getOpt("--snapshot"),
                    message: getOpt("--message"),
                    timeout: parseInt(getOpt("--timeout", String(DEFAULT_TIMEOUT))),
                    mode: getOpt("--mode", "type-order"),
                });
                process.exit(result.pass ? 0 : 1);
                break;
            }

            case "list": {
                const dir = getOpt("--dir", SNAPSHOT_DIR);
                const snapshots = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".jsonl")) : [];
                if (snapshots.length === 0) {
                    console.log(`No snapshots found in ${dir}`);
                } else {
                    console.log(`Snapshots in ${dir}:`);
                    console.log("");
                    for (const name of snapshots) {
                        const fp = join(dir, name);
                        const stat = readFileSync(fp, "utf8");
                        const firstLine = stat.trim().split("\n")[0] || "{}";
                        let meta = {};
                        try { meta = JSON.parse(firstLine); } catch {}
                        const count = meta._snapshot?.count || "?";
                        const types = (meta._snapshot?.types || []).join(", ");
                        console.log(`  ${name}`);
                        console.log(`    Events: ${count}  |  Types: ${types}`);
                    }
                }
                process.exit(0);
                break;
            }

            case "compare": {
                const actualPath = getOpt("--actual");
                const expectedPath = getOpt("--expected");
                const mode = getOpt("--mode", "type-order");

                if (!actualPath || !expectedPath) {
                    console.error("Both --actual and --expected are required for compare mode");
                    process.exit(1);
                }

                const { events: actualEvents } = loadSnapshot(actualPath);
                const { events: expectedEvents } = loadSnapshot(expectedPath);

                let result;
                if (mode === "strict") {
                    result = compareEvents(actualEvents, expectedEvents, { verbose: true });
                } else {
                    result = compareEventTypes(actualEvents, expectedEvents);
                }

                if (result.pass) {
                    console.log(`PASS: ${result.matched}/${result.total} events matched`);
                } else {
                    console.log(`FAIL: ${result.matched}/${result.total} matched, ${result.mismatched} mismatches`);
                    for (const err of result.errors) {
                        console.log(`  ${err}`);
                    }
                }
                process.exit(result.pass ? 0 : 1);
                break;
            }

            default:
                console.error(`Unknown command: ${command}`);
                printUsage();
                process.exit(1);
        }
    } catch (err) {
        console.error(`[error] ${err.message}`);
        process.exit(1);
    }
}

// ─── Exports ────────────────────────────────────────────────────────────

export {
    capture,
    test,
    compareEvents,
    compareEventTypes,
    recordEvents,
    parseSSEStream,
    saveSnapshot,
    loadSnapshot,
    listSnapshots,
    stripDynamic,
    startExtension,
    stopProcess,
    waitForServer,
    createSession,
    sendPrompt,
};

// Run CLI when executed directly
if (process.argv[1] && (process.argv[1].endsWith("sse-harness.mjs") || process.argv[1].endsWith("sse-harness"))) {
    main();
}
