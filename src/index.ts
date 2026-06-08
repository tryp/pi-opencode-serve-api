/**
 * OpenCode Serve API — Pi Extension
 *
 * Serves an HTTP API on port 4096 (configurable) that is compatible with the
 * OpenCode serve API protocol.  Any client that speaks the `@opencode-ai/sdk`
 * wire format (or the underlying REST + SSE protocol) can drive Pi through
 * this extension.
 *
 * ─── Quick start ─────────────────────────────────────────────────────────
 *
 *   # Install as a global extension
 *   cp -r opencode-serve-api ~/.pi/agent/extensions/opencode-serve-api
 *
 *   # Or load directly
 *   pi -e ./opencode-serve-api/src/index.ts
 *
 *   # Or use flags / env-vars to configure the port
 *   PI_SERVE_PORT=4321 pi -e ./opencode-serve-api/src/index.ts
 *   pi --serve-port 4321 -e ./opencode-serve-api/src/index.ts
 *
 * ─── Compatibility notes ─────────────────────────────────────────────────
 *
 * The extension maps OpenCode concepts to Pi as follows:
 *
 *   OpenCode "session"  → Pi session (single session is current)
 *   OpenCode "message"  → Pi session entries (user, assistant, toolResult)
 *   OpenCode "event"    → SSE stream bridging Pi's agent events
 *   OpenCode "provider" → Pi model registry providers
 *   OpenCode "command"  → Pi extension commands + templates + skills
 *   OpenCode "file"     → Direct filesystem access via Pi's CWD
 *
 * Unsupported features return empty/stub responses:
 *   - MCP, LSP, PTY, TUI control, file watcher, VCS
 *   - share/unshare, revert/unrevert (stubs)
 *   - find/symbol (LSP-dependent, returns empty)
 *
 * ─── Configuration ──────────────────────────────────────────────────────
 *
 *   Flag / Env-var          Default       Description
 *   ──────────────────────────────────────────────────────────────────────
 *   --serve-port            4096          HTTP listen port
 *     PI_SERVE_PORT
 *   --serve-host            127.0.0.1     Bind address
 *     PI_SERVE_HOST
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import {
    createServer,
    type IncomingMessage,
    type ServerResponse,
    type Server,
} from "node:http";
import { execFile as execFileAsync } from "node:child_process";
import { join, resolve, relative, basename, sep } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileAsync);

// ── Utility types ──────────────────────────────────────────────────────

interface SessionRecord {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
}

// ── HTTP helpers ───────────────────────────────────────────────────────

function jsonResponse(res: ServerResponse, data: unknown, status = 200) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
}

// ── Phase 5: Standardized error responses ────────────────────────────
// These match OpenCode SDK error type names for proper client error handling.

function errorResponse(
    res: ServerResponse,
    status: number,
    name: string,
    message: string,
) {
    jsonResponse(res, { name, data: { message } }, status);
}

function notFound(res: ServerResponse, msg: string) {
    errorResponse(res, 404, "NotFoundError", msg);
}

function badRequest(res: ServerResponse, msg: string) {
    errorResponse(res, 400, "BadRequestError", msg);
}

function authError(res: ServerResponse, msg: string) {
    errorResponse(res, 401, "ProviderAuthError", msg);
}

function serverError(res: ServerResponse, msg: string) {
    errorResponse(res, 500, "UnknownError", msg);
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

async function parseJsonBody(req: IncomingMessage): Promise<any> {
    const raw = await readBody(req);
    if (!raw) return {};
    try {
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

function nowUnix(): number {
    return Date.now();
}

function queryParam(urlPath: string, name: string): string | undefined {
    const idx = urlPath.indexOf("?");
    if (idx === -1) return undefined;
    const sp = new URLSearchParams(urlPath.slice(idx + 1));
    return sp.get(name) ?? undefined;
}

function pathname(urlPath: string): string {
    const idx = urlPath.indexOf("?");
    return idx === -1 ? urlPath : urlPath.slice(0, idx);
}

// ── OpenCode → Pi mappers ─────────────────────────────────────────────

function toOCSession(s: SessionRecord, cwd: string) {
    return {
        id: s.id,
        projectID: "default",
        directory: cwd,
        title: s.title,
        version: "1.0.0",
        time: { created: s.createdAt, updated: s.updatedAt },
        summary: { additions: 0, deletions: 0, files: 0 },
    };
}

/** Map Pi session entries into OpenCode-style message+parts pairs. */
function entriesToOCMessages(
    entries: any[],
    sessionId: string,
): Array<{ info: any; parts: any[] }> {
    const results: Array<{ info: any; parts: any[] }> = [];
    for (const entry of entries) {
        if (entry.type !== "message") continue;
        const msg = entry.message;
        if (!msg) continue;

        const ts = msg.timestamp ? msg.timestamp : nowUnix();

        if (msg.role === "user") {
            const textContent =
                typeof msg.content === "string"
                    ? msg.content
                    : Array.isArray(msg.content)
                      ? msg.content
                            .filter((c: any) => c.type === "text")
                            .map((c: any) => c.text)
                            .join("\n")
                      : "";

            results.push({
                info: {
                    id: entry.id,
                    sessionID: sessionId,
                    role: "user",
                    time: { created: ts },
                    agent: "coder",
                    model: null,
                },
                parts: [
                    {
                        id: randomUUID(),
                        sessionID: sessionId,
                        messageID: entry.id,
                        type: "text",
                        text: textContent,
                    },
                ],
            });
        } else if (msg.role === "assistant") {
            const parts: any[] = [];
            const content = Array.isArray(msg.content) ? msg.content : [];

            for (const block of content) {
                if (block.type === "text") {
                    parts.push({
                        id: randomUUID(),
                        sessionID: sessionId,
                        messageID: entry.id,
                        type: "text",
                        text: block.text ?? "",
                    });
                } else if (block.type === "thinking") {
                    parts.push({
                        id: randomUUID(),
                        sessionID: sessionId,
                        messageID: entry.id,
                        type: "reasoning",
                        text: block.thinking ?? "",
                        time: { start: ts, end: ts },
                    });
                } else if (block.type === "toolCall") {
                    parts.push({
                        id: randomUUID(),
                        sessionID: sessionId,
                        messageID: entry.id,
                        type: "tool",
                        callID: block.id,
                        tool: block.name,
                        state: {
                            status: "completed",
                            input: block.arguments ?? {},
                            output: "",
                            title: block.name,
                            metadata: {},
                            time: { start: ts, end: ts },
                        },
                    });
                }
            }

            const usage = msg.usage ?? {};
            const modelID = msg.model ?? "";
            const providerID = msg.provider ?? "";
            results.push({
                info: {
                    id: entry.id,
                    sessionID: sessionId,
                    role: "assistant",
                    time: { created: ts, completed: ts },
                    parentID: "",
                    modelID: modelID,
                    providerID: providerID,
                    model: modelID ? { providerID, modelID } : null,
                    mode: "build",
                    path: { cwd: "", root: "" },
                    cost: usage.cost?.total ?? 0,
                    tokens: {
                        input: usage.input ?? 0,
                        output: usage.output ?? 0,
                        reasoning: 0,
                        cache: {
                            read: usage.cacheRead ?? 0,
                            write: usage.cacheWrite ?? 0,
                        },
                    },
                    finish: msg.stopReason ?? "stop",
                },
                parts,
            });
        } else if (msg.role === "toolResult") {
            // Tool results are embedded as parts of the parent assistant message
            // in OpenCode. We emit them as a separate message for completeness,
            // but most clients will associate them via toolCallId.
            const text =
                Array.isArray(msg.content)
                    ? msg.content
                          .filter((c: any) => c.type === "text")
                          .map((c: any) => c.text)
                          .join("\n")
                    : "";

            // Find the parent assistant entry to attach this tool result as a part
            // We'll add it as a standalone entry for simplicity
            const lastAssistant = results.length > 0 ? results[results.length - 1] : null;
            if (lastAssistant && lastAssistant.info.role === "assistant") {
                lastAssistant.parts.push({
                    id: randomUUID(),
                    sessionID: sessionId,
                    messageID: lastAssistant.info.id,
                    type: "tool",
                    callID: msg.toolCallId ?? "",
                    tool: msg.toolName ?? "",
                    state: {
                        status: msg.isError ? "error" : "completed",
                        input: {},
                        output: text,
                        title: msg.toolName ?? "tool",
                        metadata: {},
                        time: { start: ts, end: ts },
                    },
                });
            }
        }
    }
    return results;
}

// ── Main extension ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
    // ── Config ────────────────────────────────────────────────────────
    const port = parseInt(
        (process.env.PI_SERVE_PORT as string) ??
            (pi.getFlag("serve-port") as string) ??
            "4096",
        10,
    );
    const hostname =
        (process.env.PI_SERVE_HOST as string) ??
        (pi.getFlag("--serve-host") as string) ??
        "0.0.0.0";

    // ── State ─────────────────────────────────────────────────────────
    let currentSessionId: string = randomUUID();
    const sessions = new Map<string, SessionRecord>();
    const sseClients = new Set<ServerResponse>();
    const eventBuffer: string[] = [];
    let currentThinkingPartId: string | null = null;
    let currentThinkingStartTime: number = 0;
    let currentThinkingText: string = "";
    let currentTextPartId: string | null = null;
    let currentAssistantMessageId: string | null = null;
    let httpServer: Server | undefined;
    let commandCtx: any = null;
    let activeCwd: string = process.cwd();

    // Create default session
    const defaultSession: SessionRecord = {
        id: currentSessionId,
        title: "",
        createdAt: nowUnix(),
        updatedAt: nowUnix(),
    };
    sessions.set(currentSessionId, defaultSession);

    // ── Logging ────────────────────────────────────────────────────────

    const debugLogging = (process.env.OPENCODE_LOG_LEVEL as string) === "debug"
        || (process.env.DEBUG as string)?.includes("opencode-serve")
        || false;

    function elog(msg: string, ...args: any[]) {
        console.log(`[${new Date().toISOString()}] [opencode-serve] ${msg}`, ...args);
    }

    function dlog(msg: string, ...args: any[]) {
        if (debugLogging) {
            console.log(`[${new Date().toISOString()}] [opencode-serve:debug] ${msg}`, ...args);
        }
    }

    function broadcast(event: { type: string; properties: any; id?: string }) {
        const ev = event.id
            ? event
            : { ...event, id: "evt_" + randomUUID() };
        // P4OC routes events by directory — wrap in {directory, payload} format
        // so workspace-scoped subscribers (WorkspaceKey.Directory) receive the event.
        // Without this, events have directory=null → WorkspaceKey.Global → filtered out.
        const wrapped = {
            directory: activeCwd,
            payload: ev,
        };
        const data = `data: ${JSON.stringify(wrapped)}\n\n`;
        // Buffer for replay on reconnect
        eventBuffer.push(data);
        if (eventBuffer.length > 500) eventBuffer.shift();
        for (const res of sseClients) {
            try {
                res.write(data);
            } catch {
                sseClients.delete(res);
            }
        }
    }

    // ── CORS headers ──────────────────────────────────────────────────

    function corsHeaders(res: ServerResponse) {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
    }

    // ── Path confinement ───────────────────────────────────────────

    /** Resolve a user-supplied path and verify it stays within activeCwd. */
    function safePath(fp: string): string | null {
        const abs = resolve(activeCwd, fp);
        const root = resolve(activeCwd);
        if (abs !== root && !abs.startsWith(root + sep)) return null;
        return abs;
    }

    // ── SSE helper ────────────────────────────────────────────────────

    function startSSE(res: ServerResponse) {
        elog("SSE client connected, total:", sseClients.size + 1);
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        });
        res.write(
            `data: ${JSON.stringify({ directory: activeCwd, payload: { id: "evt_" + randomUUID(), type: "server.connected", properties: {} } })}\n\n`,
        );
        // Broadcast existing sessions so the new client discovers them immediately
        for (const session of sessions.values()) {
            res.write(
                `data: ${JSON.stringify({ directory: activeCwd, payload: { id: "evt_" + randomUUID(), type: "session.created", properties: { info: toOCSession(session, activeCwd) } } })}\n\n`,
            );
        }
        // Replay buffered events that arrived while no client was connected
        if (eventBuffer.length > 0) {
            elog("replaying", eventBuffer.length, "buffered events to new SSE client");
            for (const buffered of eventBuffer) {
                try {
                    res.write(buffered);
                } catch { /* ignore */ }
            }
            // Don't clear the buffer — it's a sliding window (max 500 events)
            // that all SSE clients share. Clearing it after one client's replay
            // would lose events for other clients.
            dlog("SSE replay: kept", eventBuffer.length, "buffered events for future clients");
        }
        sseClients.add(res);
        res.on("close", () => {
            elog("SSE client disconnected, remaining:", sseClients.size - 1);
            sseClients.delete(res);
        });
    }

    // ── Request router ────────────────────────────────────────────────

    async function handleRequest(req: IncomingMessage, res: ServerResponse) {
        const url = req.url ?? "/";
        const method = req.method ?? "GET";
        let path = pathname(url);
        // ── Phase 5: Strip /api prefix for v2 SDK compatibility ──────────
        if (path.startsWith("/api/")) {
            path = path.slice(4); // /api/session/... → /session/...
        } else if (path === "/api") {
            path = "/";
        }
        dlog("HTTP", req.method, req.url, "→ path:", path);

        // CORS headers on every response
        corsHeaders(res);

        // Preflight
        if (method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }

        try {
            await route(method, path, url, req, res);
        } catch (err: any) {
            console.error("[opencode-serve] unhandled error:", err);
            if (!res.headersSent) {
                serverError(res, err.message ?? "Internal server error");
            }
        }
    }

    async function route(
        method: string,
        path: string,
        url: string,
        req: IncomingMessage,
        res: ServerResponse,
    ) {
        // ── Health ─────────────────────────────────────────────────
        if ((path === "/health" || path === "/global/health") && method === "GET") {
            return jsonResponse(res, { healthy: true, version: "pi-opencode-serve-api/1.0.0" });
        }

        // ── Project ───────────────────────────────────────────────────
        if (path === "/project" && method === "GET") {
            const now = nowUnix();
            return jsonResponse(res, [
                {
                    id: "default",
                    worktree: activeCwd,
                    vcs: null as string | null,
                    vcsDir: null as string | null,
                    time: { created: now, updated: now },
                    sandboxes: [] as string[],
                },
            ]);
        }
        if (path === "/project/current" && method === "GET") {
            return jsonResponse(res, { worktree: activeCwd });
        }

        // GET /project/{projectID} — get project by ID (v2 SDK)
        const projectIDMatch = path.match(/^\/project\/([^/]+)$/);
        if (projectIDMatch && method === "GET") {
            const pid = projectIDMatch[1];
            elog("GET /project/{id}: id=", pid);
            return jsonResponse(res, {
                id: pid,
                worktree: activeCwd,
                vcs: null as string | null,
                vcsDir: null as string | null,
                time: { created: nowUnix(), updated: nowUnix() },
                sandboxes: [] as string[],
            });
        }

        // GET /project/{projectID}/directories — get project directories (v2 SDK)
        const projectDirMatch = path.match(/^\/project\/([^/]+)\/directories$/);
        if (projectDirMatch && method === "GET") {
            elog("GET /project/{id}/directories: id=", projectDirMatch[1]);
            return jsonResponse(res, []);
        }

        // POST /project/git/init — git init for project (v2 SDK)
        if (path === "/project/git/init" && method === "POST") {
            elog("POST /project/git/init");
            return jsonResponse(res, { success: true });
        }

        // ── Model ─────────────────────────────────────────────────────
        if (path === "/model/active" && method === "POST") {
            return jsonResponse(res, true);
        }

        // ── Instance ──────────────────────────────────────────────────
        if (path === "/instance" && method === "GET") {
            elog("/instance GET called — not a standard OpenCode endpoint, returning 404");
            return notFound(res, "/instance is not a standard OpenCode endpoint");
        }

        // ── Event streams ──────────────────────────────────────────
        if ((path === "/event" || path === "/global/event") && method === "GET") {
            return startSSE(res);
        }

        // ── Global endpoints ────────────────────────────────────────
        if (path === "/global/config" && method === "GET") {
            return jsonResponse(res, { theme: "dark", agent: {}, provider: {}, mcp: {} });
        }
        if (path === "/global/config" && method === "PATCH") {
            const body = await parseJsonBody(req);
            elog("PATCH /global/config: body=", JSON.stringify(body));
            return jsonResponse(res, {
                theme: body.theme ?? "dark",
                agent: body.agent ?? {},
                provider: body.provider ?? {},
                mcp: body.mcp ?? {},
            });
        }
        if (path === "/global/dispose" && method === "POST") {
            elog("POST /global/dispose");
            return jsonResponse(res, true);
        }
        if (path === "/global/upgrade" && method === "GET") {
            return jsonResponse(res, { upgradeAvailable: false, currentVersion: "1.0.0" });
        }

        // ── Sessions ───────────────────────────────────────────────
        if (path === "/session" && method === "GET") {
            return jsonResponse(
                res,
                Array.from(sessions.values()).map((s) => toOCSession(s, activeCwd)),
            );
        }
        if (path === "/session" && method === "POST") {
            const body = await parseJsonBody(req);
            const s: SessionRecord = {
                id: randomUUID(),
                title: body.title ?? "",
                createdAt: nowUnix(),
                updatedAt: nowUnix(),
            };
            sessions.set(s.id, s);
            broadcast({ type: "session.created", properties: { info: toOCSession(s, activeCwd) } });
            return jsonResponse(res, toOCSession(s, activeCwd));
        }
        if (path === "/session/status" && method === "GET") {
            const out: Record<string, any> = {};
            for (const id of sessions.keys()) out[id] = { type: "idle" };
            return jsonResponse(res, out);
        }

        // ── Session sub-routes ─────────────────────────────────────
        const sm = path.match(/^\/session\/([^/]+)(?:\/(.*))?$/);
        if (sm) {
            return await sessionRoute(method, path, url, req, res, sm[1], sm[2] ?? "");
        }

        // ── Config ─────────────────────────────────────────────────
        if (path === "/config" && method === "GET") {
            return jsonResponse(res, { $schema: "", theme: "dark", agent: {}, provider: {}, mcp: {} });
        }
        if (path === "/config" && method === "PATCH") {
            const body = await parseJsonBody(req);
            elog("PATCH /config: body=", JSON.stringify(body));
            return jsonResponse(res, {
                $schema: "",
                theme: body.theme ?? "dark",
                agent: body.agent ?? {},
                provider: body.provider ?? {},
                mcp: body.mcp ?? {},
            });
        }
        if (path === "/config/providers" && method === "GET") {
            return jsonResponse(res, { providers: [], default: {} });
        }

        // ── Providers ──────────────────────────────────────────────
        if (path === "/provider" && method === "GET") {
            return jsonResponse(res, { all: [], default: {}, connected: [] });
        }
        if (path === "/provider/auth" && method === "GET") {
            return jsonResponse(res, {});
        }

        // ── Agents ─────────────────────────────────────────────────
        if (path === "/agent" && method === "GET") {
            return jsonResponse(res, [
                {
                    name: "coder",
                    description: "Main coding agent",
                    mode: "primary",
                    builtIn: true,
                    permission: { edit: "allow", bash: {} },
                    tools: {},
                    options: {},
                },
            ]);
        }

        // ── Paths ──────────────────────────────────────────────────
        if (path === "/path" && method === "GET") {
            return jsonResponse(res, {
                state: "",
                config: "",
                worktree: activeCwd,
                directory: activeCwd,
            });
        }

        // ── VCS ────────────────────────────────────────────────────
        if (path === "/vcs" && method === "GET") {
            try {
                const { stdout } = await execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
                    cwd: activeCwd,
                    timeout: 3000,
                });
                return jsonResponse(res, { branch: stdout.trim() });
            } catch {
                return jsonResponse(res, { branch: "" });
            }
        }

        // POST /vcs/apply — apply VCS changes (v2 SDK)
        if (path === "/vcs/apply" && method === "POST") {
            const body = await parseJsonBody(req);
            elog("POST /vcs/apply: body=", JSON.stringify(body));
            return jsonResponse(res, { success: true });
        }

        // GET /vcs/diff — get VCS diff (v2 SDK)
        if (path === "/vcs/diff" && method === "GET") {
            const fp = queryParam(url, "path") ?? ".";
            try {
                const { stdout } = await execFile("git", ["diff", "--", fp], {
                    cwd: activeCwd,
                    maxBuffer: 2 * 1024 * 1024,
                    timeout: 10000,
                });
                elog("GET /vcs/diff: path=", fp, "diff length=", stdout.length);
                return jsonResponse(res, { diff: stdout });
            } catch {
                return jsonResponse(res, { diff: "" });
            }
        }

        // GET /vcs/diff/raw — get raw VCS diff (v2 SDK)
        if (path === "/vcs/diff/raw" && method === "GET") {
            const fp = queryParam(url, "path") ?? ".";
            try {
                const { stdout } = await execFile("git", ["diff", "--no-color", "--", fp], {
                    cwd: activeCwd,
                    maxBuffer: 2 * 1024 * 1024,
                    timeout: 10000,
                });
                elog("GET /vcs/diff/raw: path=", fp, "diff length=", stdout.length);
                return jsonResponse(res, { diff: stdout });
            } catch {
                return jsonResponse(res, { diff: "" });
            }
        }

        // GET /vcs/status — get VCS status (v2 SDK)
        if (path === "/vcs/status" && method === "GET") {
            try {
                const [{ stdout: branchStdout }, { stdout: statusStdout }] = await Promise.all([
                    execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
                        cwd: activeCwd, timeout: 3000,
                    }),
                    execFile("git", ["status", "--porcelain"], {
                        cwd: activeCwd, maxBuffer: 2 * 1024 * 1024, timeout: 10000,
                    }),
                ]);
                const branch = branchStdout.trim();
                const porcelain = statusStdout.trim();
                const files = porcelain
                    ? porcelain.split("\n").map((line: string) => {
                          const op = line.slice(0, 2).trim();
                          const filePath = line.slice(3).trim();
                          return { path: filePath, operation: op, staged: !line.startsWith(" ") && !line.startsWith("?") };
                      })
                    : [];
                elog("GET /vcs/status: branch=", branch, "files=", files.length);
                return jsonResponse(res, { files, branch, status: porcelain });
            } catch {
                return jsonResponse(res, { files: [], branch: "", status: "" });
            }
        }

        // ── Commands ───────────────────────────────────────────────
        if (path === "/command" && method === "GET") {
            return jsonResponse(
                res,
                pi.getCommands().map((c) => ({
                    name: c.name,
                    description: c.description ?? "",
                    template: `/${c.name}`,
                })),
            );
        }

        // ── Files ──────────────────────────────────────────────────
        if (path === "/file/content" && method === "GET") {
            const fp = queryParam(url, "path");
            if (!fp) return badRequest(res, "Missing ?path=");
            const abs = safePath(fp);
            if (!abs) return errorResponse(res, 403, "Forbidden", "Path outside project directory");
            try {
                const content = await readFile(abs, "utf8");
                return jsonResponse(res, { type: "text", content });
            } catch {
                return notFound(res, "File not found");
            }
        }
        if (path === "/file" && method === "GET") {
            const dir = queryParam(url, "path") ?? ".";
            const abs = safePath(dir);
            if (!abs) return errorResponse(res, 403, "Forbidden", "Path outside project directory");
            try {
                const entries = await readdir(abs, { withFileTypes: true });
                const nodes = await Promise.all(
                    entries
                        .filter((e) => !e.name.startsWith("."))
                        .map(async (entry) => {
                            try {
                                const full = join(abs, entry.name);
                                return {
                                    name: entry.name,
                                    path: relative(activeCwd, full),
                                    absolute: full,
                                    type: entry.isDirectory() ? "directory" : "file",
                                    ignored: false,
                                };
                            } catch {
                                return null;
                            }
                        }),
                );
                return jsonResponse(res, nodes.filter(Boolean));
            } catch {
                return notFound(res, "Directory not found");
            }
        }
        if (path === "/file/status" && method === "GET") {
            return jsonResponse(res, []);
        }

        // ── Find ───────────────────────────────────────────────────
        if (path === "/find" && method === "GET") {
            const pattern = queryParam(url, "pattern") ?? "";
            if (!pattern) return badRequest(res, "Missing ?pattern=");
            try {
                const { stdout } = await execFile(
                    "grep", ["-rn", "--", pattern, "."],
                    { cwd: activeCwd, maxBuffer: 2 * 1024 * 1024, timeout: 10000 },
                );
                const matches = stdout
                    .split("\n")
                    .filter(Boolean)
                    .map((line) => {
                        const c1 = line.indexOf(":");
                        const c2 = line.indexOf(":", c1 + 1);
                        if (c1 === -1 || c2 === -1) return null;
                        return {
                            path: { text: line.slice(0, c1) },
                            lines: { text: line.slice(c2 + 1) },
                            line_number: parseInt(line.slice(c1 + 1, c2), 10),
                            absolute_offset: 0,
                            submatches: [
                                {
                                    match: { text: pattern },
                                    start: 0,
                                    end: pattern.length,
                                },
                            ],
                        };
                    })
                    .filter(Boolean);
                return jsonResponse(res, matches);
            } catch {
                return jsonResponse(res, []);
            }
        }
        if (path === "/find/file" && method === "GET") {
            const q = queryParam(url, "query") ?? "";
            try {
                const { stdout } = await execFile(
                    "find", [".", "-iname", `*${q}*`, "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*"],
                    { cwd: activeCwd, maxBuffer: 2 * 1024 * 1024, timeout: 10000 },
                );
                return jsonResponse(res, stdout.split("\n").filter(Boolean));
            } catch {
                return jsonResponse(res, []);
            }
        }
        if (path === "/find/symbol" && method === "GET") {
            return jsonResponse(res, []);
        }

        // ── PTY endpoints ──────────────────────────────────────────
        const ptyGetMatch = path.match(/^\/pty\/([^/]+)$/);
        if (path === "/pty" && method === "POST") {
            const ptyId = "pty_" + randomUUID();
            elog("POST /pty: created pty=", ptyId);
            return jsonResponse(res, { id: ptyId, sessionID: currentSessionId, status: "created" });
        }
        if (ptyGetMatch && method === "GET") {
            elog("GET /pty/{id}: id=", ptyGetMatch[1]);
            return jsonResponse(res, { id: ptyGetMatch[1], sessionID: currentSessionId, status: "running" });
        }
        if (ptyGetMatch && method === "DELETE") {
            elog("DELETE /pty/{id}: id=", ptyGetMatch[1]);
            return jsonResponse(res, true);
        }
        if (ptyGetMatch && method === "PATCH") {
            elog("PATCH /pty/{id}: id=", ptyGetMatch[1]);
            return jsonResponse(res, true);
        }
        const ptyConnectMatch = path.match(/^\/pty\/([^/]+)\/connect$/);
        if (ptyConnectMatch && method === "GET") {
            elog("GET /pty/{id}/connect: id=", ptyConnectMatch[1]);
            return jsonResponse(res, { url: "ws://placeholder", sessionID: currentSessionId });
        }

        // ── Sync endpoints (v2 SDK parity) ──────────────────────────
        if (path === "/sync/history" && method === "GET") {
            elog("GET /sync/history");
            return jsonResponse(res, { entries: [], lastSync: null });
        }
        if (path === "/sync/replay" && method === "POST") {
            const body = await parseJsonBody(req);
            elog("POST /sync/replay: body=", JSON.stringify(body));
            return jsonResponse(res, { success: true });
        }
        if (path === "/sync/start" && method === "POST") {
            const body = await parseJsonBody(req);
            elog("POST /sync/start: body=", JSON.stringify(body));
            return jsonResponse(res, { syncID: "sync_" + randomUUID(), started: true });
        }
        if (path === "/sync/steal" && method === "POST") {
            elog("POST /sync/steal");
            return jsonResponse(res, { stolen: true });
        }

        // ── Stubs for features Pi doesn't have ─────────────────────
        const stubs: Record<string, any> = {
            "/mcp": {},
            "/lsp": [],
            "/formatter": [],
            "/experimental/tool/ids": pi.getAllTools().map((t) => t.name),
        };
        for (const [stubPath, stubResponse] of Object.entries(stubs)) {
            if (path === stubPath && method === "GET") {
                return jsonResponse(res, stubResponse);
            }
        }
        if (path === "/log" && method === "POST") {
            return jsonResponse(res, true);
        }
        if (path === "/instance/dispose" && method === "POST") {
            return jsonResponse(res, true);
        }
        if (path.startsWith("/auth/")) {
            dlog("auth catch-all: method=", method, "path=", path);
            return jsonResponse(res, true);
        }
        if (path.startsWith("/tui/")) {
            return jsonResponse(res, true);
        }
        if (path.startsWith("/mcp/") && method === "GET") {
            return jsonResponse(res, {});
        }
        if (path.startsWith("/mcp/") && method === "POST") {
            return jsonResponse(res, {});
        }
        if (path.startsWith("/provider/") && method === "GET") {
            return jsonResponse(res, []);
        }

        // ── Phase 1: Critical P4OC endpoints ─────────────────────────

        // POST /permission/{requestID}/reply
        const permReplyMatch = path.match(/^\/permission\/([^/]+)\/reply$/);
        if (permReplyMatch && method === "POST") {
            const body = await parseJsonBody(req);
            const response = body.response ?? "reject";
            broadcast({
                type: "permission.replied",
                properties: {
                    permissionID: permReplyMatch[1],
                    response,
                },
            });
            elog("permission.replied: id=", permReplyMatch[1], "response=", response);
            return jsonResponse(res, true);
        }

        // POST /question/{requestID}/reply
        const questionReplyMatch = path.match(/^\/question\/([^/]+)\/reply$/);
        if (questionReplyMatch && method === "POST") {
            const body = await parseJsonBody(req);
            broadcast({
                type: "question.replied",
                properties: {
                    questionID: questionReplyMatch[1],
                    response: body.response ?? body.answer ?? "",
                },
            });
            elog("question.replied: id=", questionReplyMatch[1]);
            return jsonResponse(res, true);
        }

        // POST /question/{requestID}/reject
        const questionRejectMatch = path.match(/^\/question\/([^/]+)\/reject$/);
        if (questionRejectMatch && method === "POST") {
            broadcast({
                type: "question.rejected",
                properties: {
                    questionID: questionRejectMatch[1],
                    response: "rejected",
                },
            });
            elog("question.rejected: id=", questionRejectMatch[1]);
            return jsonResponse(res, true);
        }

        // POST /provider/{id}/oauth/authorize
        const oauthAuthorizeMatch = path.match(/^\/provider\/([^/]+)\/oauth\/authorize$/);
        if (oauthAuthorizeMatch && method === "POST") {
            const providerId = oauthAuthorizeMatch[1];
            elog("oauth authorize: provider=", providerId);
            return jsonResponse(res, {
                url: "http://placeholder",
                state: "placeholder_" + randomUUID(),
            });
        }

        // POST /provider/{id}/oauth/callback
        const oauthCallbackMatch = path.match(/^\/provider\/([^/]+)\/oauth\/callback$/);
        if (oauthCallbackMatch && method === "POST") {
            const providerId = oauthCallbackMatch[1];
            const body = await parseJsonBody(req);
            elog("oauth callback: provider=", providerId, "body=", JSON.stringify(body));
            return jsonResponse(res, {
                token: "placeholder_token",
                provider: providerId,
            });
        }

        // POST /mcp — add MCP server
        if (path === "/mcp" && method === "POST") {
            const body = await parseJsonBody(req);
            elog("POST /mcp: body=", JSON.stringify(body));
            return jsonResponse(res, { id: "mcp_" + randomUUID() });
        }

        // ── Other stubs ─────────────────────────────────────────────
        if (path === "/skill" && method === "GET") {
            const skills = typeof pi.getSkills === "function" ? pi.getSkills() : [];
            elog("GET /skill: returning", skills.length, "skills");
            return jsonResponse(res, skills);
        }
        if (path === "/permission" && method === "GET") {
            return jsonResponse(res, []);
        }
        if (path === "/question" && method === "GET") {
            return jsonResponse(res, []);
        }
        if (path === "/experimental/tool" && method === "GET") {
            return jsonResponse(res, { tools: [] });
        }

        return notFound(res, path);
    }

    // ── Session sub-route handler ──────────────────────────────────

    async function sessionRoute(
        method: string,
        _path: string,
        url: string,
        req: IncomingMessage,
        res: ServerResponse,
        sid: string,
        sub: string,
    ) {
        const session = sessions.get(sid);

        // GET /session/{id}
        if (sub === "" && method === "GET") {
            if (!session) return notFound(res, `Session ${sid} not found`);
            return jsonResponse(res, toOCSession(session, activeCwd));
        }

        // POST /session/{id} — update
        if (sub === "" && method === "POST") {
            if (!session) return notFound(res, `Session ${sid} not found`);
            const body = await parseJsonBody(req);
            if (body.title) {
                session.title = body.title;
                pi.setSessionName(body.title);
            }
            session.updatedAt = nowUnix();
            return jsonResponse(res, toOCSession(session, activeCwd));
        }

        // DELETE /session/{id}
        if (sub === "" && method === "DELETE") {
            elog("DELETE /session/{id}: sid=", sid);
            broadcast({ type: "session.deleted", properties: { sessionID: sid } });
            sessions.delete(sid);
            return jsonResponse(res, true);
        }

        // PATCH /session/{id} — update (P4OC uses PATCH)
        if (sub === "" && method === "PATCH") {
            if (!session) return notFound(res, `Session ${sid} not found`);
            const body = await parseJsonBody(req);
            if (body.title) {
                session.title = body.title;
                pi.setSessionName(body.title);
            }
            session.updatedAt = nowUnix();
            elog("PATCH /session/{id}: title=", body.title);
            return jsonResponse(res, toOCSession(session, activeCwd));
        }

        // POST /session/{id}/message — synchronous prompt
        if (sub === "message" && method === "POST") {
            elog("POST /session/{id}/message called, sid=", sid);
            const body = await parseJsonBody(req);
            const parts = body.parts ?? [];
            const textParts = parts.filter((p: any) => p.type === "text");
            const text = textParts.map((p: any) => p.text).join("\n");
            if (!text) return badRequest(res, "No text content in parts");

            currentSessionId = sid;
            if (session) session.updatedAt = nowUnix();

            const userMsgId = randomUUID();
            const assistantMsgId = randomUUID();
            currentAssistantMessageId = assistantMsgId;

            // Broadcast user message event
            broadcast({
                type: "message.updated",
                properties: {
                    info: {
                        id: userMsgId,
                        sessionID: sid,
                        role: "user",
                        time: { created: nowUnix() },
                        agent: "coder",
                        model: body.model ?? {},
                    },
                },
            });

            // Send to Pi
            pi.sendUserMessage(text);

            // Return immediately — client tracks response via /event SSE
            return jsonResponse(res, {
                info: {
                    id: assistantMsgId,
                    sessionID: sid,
                    role: "assistant",
                    time: { created: nowUnix() },
                    parentID: userMsgId,
                    modelID: "",
                    providerID: "",
                    mode: "build",
                    path: { cwd: activeCwd, root: "/" },
                    cost: 0,
                    tokens: {
                        input: 0,
                        output: 0,
                        reasoning: 0,
                        cache: { read: 0, write: 0 },
                    },
                },
                parts: [],
            });
        }

        // POST /session/{id}/prompt_async
        if (sub === "prompt_async" && method === "POST") {
            elog("POST /session/{id}/prompt_async called, sid=", sid);
            const body = await parseJsonBody(req);
            const parts = body.parts ?? [];
            const text = parts
                .filter((p: any) => p.type === "text")
                .map((p: any) => p.text)
                .join("\n");
            if (!text) return badRequest(res, "No text content in parts");

            currentSessionId = sid;
            if (session) session.updatedAt = nowUnix();

            // Generate a stable message ID for streaming SSE events
            currentAssistantMessageId = randomUUID();

            pi.sendUserMessage(text);

            res.writeHead(204);
            res.end();
            return;
        }

        // GET /session/{id}/message — list messages
        if (sub === "message" && method === "GET") {
            // If requesting a different session, switch context and refresh
            if (sid !== currentSessionId && sessions.has(sid)) {
                currentSessionId = sid;
                if (session) session.updatedAt = nowUnix();
                elog("GET /session/{id}/message: switched to session=", sid);
            }
            const msgs = cachedMessages.get(sid) ?? [];
            return jsonResponse(res, msgs);
        }

        // GET /session/{id}/message/{messageID}
        const singleMsg = sub.match(/^message\/([^/]+)$/);
        if (singleMsg && method === "GET") {
            const mid = singleMsg[1];
            const msgs = cachedMessages.get(sid) ?? [];
            const found = msgs.find(
                (m: any) => m.info.id === mid,
            );
            if (!found) return notFound(res, `Message ${mid} not found`);
            return jsonResponse(res, found);
        }

        // PATCH /session/{id}/message/{messageID}/part/{partID} — part update
        const partMatch = sub.match(/^message\/([^/]+)\/part\/([^/]+)$/);
        if (partMatch && method === "PATCH") {
            const body = await parseJsonBody(req);
            elog("PATCH part: messageID=", partMatch[1], "partID=", partMatch[2], "body=", JSON.stringify(body));
            return jsonResponse(res, true);
        }

        // DELETE /session/{id}/message/{messageID}/part/{partID} — part delete
        if (partMatch && method === "DELETE") {
            elog("DELETE part: messageID=", partMatch[1], "partID=", partMatch[2]);
            return jsonResponse(res, true);
        }

        // POST /session/{id}/abort
        if (sub === "abort" && method === "POST") {
            // Pi doesn't expose abort from here, but we signal status
            broadcast({
                type: "session.status",
                properties: { sessionID: sid, status: { type: "idle" } },
            });
            return jsonResponse(res, true);
        }

        // POST /session/{id}/fork
        if (sub === "fork" && method === "POST") {
            const ns: SessionRecord = {
                id: randomUUID(),
                title: (session?.title ?? "") + " (fork)",
                createdAt: nowUnix(),
                updatedAt: nowUnix(),
            };
            sessions.set(ns.id, ns);
            broadcast({ type: "session.created", properties: { info: toOCSession(ns, activeCwd) } });
            return jsonResponse(res, toOCSession(ns, activeCwd));
        }

        // POST /session/{id}/share / unshare
        if (sub === "share" && (method === "POST" || method === "DELETE")) {
            if (!session) return notFound(res, `Session ${sid} not found`);
            return jsonResponse(res, toOCSession(session, activeCwd));
        }

        // POST /session/{id}/revert
        if (sub === "revert" && method === "POST") {
            if (!session) return notFound(res, `Session ${sid} not found`);
            return jsonResponse(res, toOCSession(session, activeCwd));
        }

        // POST /session/{id}/unrevert
        if (sub === "unrevert" && method === "POST") {
            if (!session) return notFound(res, `Session ${sid} not found`);
            return jsonResponse(res, toOCSession(session, activeCwd));
        }

        // POST /session/{id}/shell — create PTY shell
        if (sub === "shell" && method === "POST") {
            const ptyId = "pty_" + randomUUID();
            elog("POST /session/{id}/shell: sid=", sid, "pty=", ptyId);
            return jsonResponse(res, { ptyID: ptyId });
        }

        // POST /session/{id}/init — initialize session
        if (sub === "init" && method === "POST") {
            const body = await parseJsonBody(req);
            elog("POST /session/{id}/init: sid=", sid, "body=", JSON.stringify(body));
            return jsonResponse(res, true);
        }

        // GET /session/{id}/compact — session compact stub
        if (sub === "compact" && method === "GET") {
            elog("GET /session/{id}/compact: sid=", sid);
            return jsonResponse(res, true);
        }

        // GET /session/{id}/context — session context stub
        if (sub === "context" && method === "GET") {
            elog("GET /session/{id}/context: sid=", sid);
            return jsonResponse(res, { context: [] });
        }

        // GET /session/{id}/wait — session wait stub
        if (sub === "wait" && method === "GET") {
            elog("GET /session/{id}/wait: sid=", sid);
            return jsonResponse(res, { completed: true });
        }

        // POST /session/{id}/command
        if (sub === "command" && method === "POST") {
            const body = await parseJsonBody(req);
            const cmdRaw = body.command ?? "";
            const cmd = cmdRaw.startsWith("/") ? cmdRaw.slice(1) : cmdRaw;
            const args = body.arguments ?? "";
            elog(`command: cmdRaw="${cmdRaw}" cmd="${cmd}" args="${args}" commandCtx=${commandCtx ? "primed" : "null"}`);
            if (session) session.updatedAt = nowUnix();

            // ── Phase 4: Emit command.executed ──────────────────────────
            broadcast({
                type: "command.executed",
                properties: {
                    sessionID: sid,
                    command: cmdRaw,
                    args: args,
                },
            });

            // Handle reload specially: try direct ctx.reload() if primed
            if (cmd === "reload" || cmd === "reload-runtime") {
                if (commandCtx) {
                    elog("reload via commandCtx.reload()");
                    await commandCtx.reload();
                    // After reload, this extension instance is torn down.
                    // The response below won't execute if reload actually happened.
                }
                return jsonResponse(res, {
                    info: {
                        id: randomUUID(),
                        sessionID: sid,
                        role: "assistant",
                        time: { created: nowUnix() },
                        parentID: "",
                        modelID: "",
                        providerID: "",
                        mode: "build",
                        path: { cwd: activeCwd, root: "/" },
                        cost: 0,
                        tokens: {
                            input: 0,
                            output: 0,
                            reasoning: 0,
                            cache: { read: 0, write: 0 },
                        },
                    },
                    parts: commandCtx
                        ? [{ id: randomUUID(), type: "text", text: "Reloading..." }]
                        : [{ id: randomUUID(), type: "text", text: "Reload not primed yet. Type `/reload-runtime` at the pi prompt once, then retry from the app." }],
                });
            }

            elog(`command fallback: sending /${cmd} to agent`);
            pi.sendUserMessage(`/${cmd} ${args}`);
            return jsonResponse(res, {
                info: {
                    id: randomUUID(),
                    sessionID: sid,
                    role: "assistant",
                    time: { created: nowUnix() },
                    parentID: "",
                    modelID: "",
                    providerID: "",
                    mode: "build",
                    path: { cwd: activeCwd, root: "/" },
                    cost: 0,
                    tokens: {
                        input: 0,
                        output: 0,
                        reasoning: 0,
                        cache: { read: 0, write: 0 },
                    },
                },
                parts: [],
            });
        }

        // POST /session/{id}/summarize
        if (sub === "summarize" && method === "POST") {
            return jsonResponse(res, true);
        }

        // GET /session/{id}/todo
        if (sub === "todo" && method === "GET") {
            return jsonResponse(res, []);
        }

        // GET /session/{id}/diff
        if (sub === "diff" && method === "GET") {
            return jsonResponse(res, []);
        }

        // GET /session/{id}/children
        if (sub === "children" && method === "GET") {
            return jsonResponse(res, []);
        }

        // POST /session/{id}/permissions/{permID}
        const permMatch = sub.match(/^permissions\/([^/]+)$/);
        if (permMatch && method === "POST") {
            const body = await parseJsonBody(req);
            broadcast({
                type: "permission.replied",
                properties: {
                    sessionID: sid,
                    permissionID: permMatch[1],
                    response: body.response ?? "reject",
                },
            });
            return jsonResponse(res, true);
        }

        // Fallback
        return notFound(res, `/session/${sid}/${sub}`);
    }

    // ── Message cache (updated from Pi events) ─────────────────────

    let cachedMessages: Map<string, Array<{ info: any; parts: any[] }>> = new Map();

    function refreshMessagesFromSession(ctx: any) {
        try {
            const sm = ctx.sessionManager;
            if (!sm) return;
            const entries = sm.getBranch();
            // Pi has a single session internally. When P4OC creates a new session,
            // we create it in our sessions Map but pi still appends to its own
            // session history. Filter messages so each P4OC session only sees
            // messages created after that session was created.
            const sess = sessions.get(currentSessionId);
            const since = sess?.createdAt ?? 0;
            const filtered = entries.filter((entry: any) => {
                return entry.message?.timestamp >= since;
            });
            cachedMessages.set(currentSessionId, entriesToOCMessages(filtered, currentSessionId));
        } catch {
            // sessionManager may not be available in all contexts
        }
    }

    // ── Register flags ─────────────────────────────────────────────

    pi.registerFlag("serve-port", {
        description: "HTTP port for the OpenCode-compatible serve API (default: 4096)",
        type: "string",
        default: "4096",
    });

    pi.registerFlag("serve-host", {
        description: "Bind host for the serve API (default: 127.0.0.1)",
        type: "string",
        default: "127.0.0.1",
    });

    // ── Register commands ──────────────────────────────────────────

    pi.registerCommand("serve-api", {
        description: "Show OpenCode serve API status",
        handler: async (_args, ctx) => {
            if (httpServer) {
                ctx.ui.notify(
                    `OpenCode API running on http://${hostname}:${port}`,
                    "info",
                );
            } else {
                ctx.ui.notify("OpenCode API not started yet", "warning");
            }
        },
    });

    pi.registerCommand("reload-runtime", {
        description: "Reload pi extensions, skills, prompts, and themes",
        handler: async (_args, ctx) => {
            commandCtx = ctx;
            elog("reload-runtime command handler fired");
            await ctx.reload();
        },
    });

    pi.registerCommand("reload", {
        description: "Reload pi configuration",
        handler: async (_args, ctx) => {
            commandCtx = ctx;
            elog("/reload command triggered via API, calling ctx.reload()");
            await ctx.reload();
        },
    });

    // ── HTTP server startup (called immediately, no session_start dependency) ──

    function startServer() {
        if (httpServer) return;
        httpServer = createServer(handleRequest);

        httpServer.on("error", (err: any) => {
            if (err.code === "EADDRINUSE") {
                console.error(
                    `[opencode-serve] Port ${port} already in use. Set --serve-port or PI_SERVE_PORT.`,
                );
            } else {
                console.error("[opencode-serve] Server error:", err);
            }
        });

        httpServer.listen(port, hostname, () => {
            elog("server listening on http://" + hostname + ":" + port);
            // UI notify deferred to first session_start (may not be available yet)
        });

        // SSE keepalive heartbeat every 30s
        setInterval(() => {
            const hb = `data: ${JSON.stringify({ directory: activeCwd, payload: { id: "evt_" + randomUUID(), type: "keepalive", properties: { time: nowUnix() } } })}\n\n`;
            for (const res of sseClients) {
                try {
                    res.write(hb);
                } catch {
                    sseClients.delete(res);
                }
            }
        }, 30000);

        elog("HTTP server started (port " + port + ")");
    }

    // Start server immediately — works even when extension is loaded via /reload
    // after initial session_start (Pi skips session_start on reload when hasBindings
    // was never set because the extension was added after initial session).
    startServer();

    // ── Lifecycle ──────────────────────────────────────────────────

    pi.on("session_start", async (event, ctx) => {
        activeCwd = ctx.cwd;

        // Notify UI about the running server
        if (httpServer) {
            try {
                ctx.ui.notify(`OpenCode API: http://${hostname}:${port}`, "info");
                ctx.ui.setStatus("serve-api", `API :${port}`);
            } catch {
                // ctx may be stale in some reload scenarios
            }
        }

        // Verify command is registered
        try {
            const cmds = pi.getCommands();
            const names = cmds.map((c: any) => c.name);
            elog("session_start: registered commands=" + JSON.stringify(names));
        } catch (e) {
            elog("session_start: getCommands error=" + String(e));
        }

        // Update session record with real session info
        const sm = ctx.sessionManager;
        const sf = sm.getSessionFile();
        const stableId = sf ? basename(sf, ".jsonl") : currentSessionId;

        const s = sessions.get(currentSessionId)!;
        s.id = stableId;
        s.title = pi.getSessionName() ?? "";
        sessions.delete(currentSessionId);
        sessions.set(stableId, s);
        currentSessionId = stableId;

        // Refresh messages
        refreshMessagesFromSession(ctx);

        // ── Phase 4: Emit vcs.branch.updated on session start ─────────
        (async () => {
            try {
                const { stdout } = await execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
                    cwd: activeCwd, timeout: 3000,
                });
                const branch = stdout.trim();
                broadcast({
                    type: "vcs.branch.updated",
                    properties: {
                        sessionID: currentSessionId,
                        branch,
                    },
                });
                dlog("Phase4: emitted vcs.branch.updated branch=", branch);
            } catch {
                // Not a git repo, skip
            }
        })();
    });

    // ── Pi → OpenCode event bridge ─────────────────────────────────

    pi.on("agent_start", async (_event, ctx) => {
        refreshMessagesFromSession(ctx);
        currentThinkingPartId = null;
        currentThinkingText = "";
        currentTextPartId = null;
        // Broadcast an initial assistant message.updated so P4OC creates the message placeholder
        broadcast({
            type: "message.updated",
            properties: {
                info: {
                    id: currentAssistantMessageId ?? randomUUID(),
                    sessionID: currentSessionId,
                    role: "assistant",
                    time: { created: nowUnix() },
                },
                parts: [],
            },
        });
        // step-start to signal SDK that a new step is beginning
        broadcast({
            type: "message.part.updated",
            properties: {
                sessionID: currentSessionId,
                part: {
                    id: "prt_" + randomUUID(),
                    messageID: currentAssistantMessageId ?? randomUUID(),
                    sessionID: currentSessionId,
                    type: "step-start",
                    text: "",
                },
            },
        });
        broadcast({
            type: "session.status",
            properties: {
                sessionID: currentSessionId,
                status: { type: "busy" },
            },
        });
    });

    function patchCachedMessageIds() {
        if (!currentAssistantMessageId) return;
        // Find the last assistant message in cachedMessages and patch its IDs
        // to match what was sent during SSE streaming
        const msgs = cachedMessages.get(currentSessionId) ?? [];
        for (let i = msgs.length - 1; i >= 0; i--) {
            const msg = msgs[i];
            if (msg.info.role === "assistant") {
                msg.info.id = currentAssistantMessageId;
                for (const part of msg.parts) {
                    part.messageID = currentAssistantMessageId;
                }
                break;
            }
        }
        currentAssistantMessageId = null;
    }

    pi.on("agent_end", async (event, ctx) => {
        // Check for agent errors and emit session.error if found
        if (event.messages) {
            for (const msg of event.messages) {
                // AssistantMessage has stopReason; check for error/aborted
                const m = msg as any;
                if (m.role === "assistant" && (m.stopReason === "error" || m.stopReason === "aborted")) {
                    const errorMsg = (m as any).errorMessage ?? m.content ?? "Agent encountered an error";
                    elog("agent_end: assistant error stopReason=", m.stopReason, "errorMsg=", errorMsg);
                    broadcast({
                        type: "session.error",
                        properties: {
                            sessionID: currentSessionId,
                            error: String(errorMsg),
                            stopReason: m.stopReason,
                        },
                    });
                }
            }
        }

        // Finalize any remaining active thinking part
        if (currentThinkingPartId) {
            broadcast({
                type: "message.part.updated",
                properties: {
                    part: {
                        id: currentThinkingPartId,
                        sessionID: currentSessionId,
                        messageID: currentAssistantMessageId ?? randomUUID(),
                        type: "reasoning",
                        text: "",
                        time: { start: currentThinkingStartTime, end: nowUnix() },
                    },
                },
            });
        }
        currentThinkingPartId = null;
        currentThinkingStartTime = 0;
        currentThinkingText = "";
        currentTextPartId = null;
        refreshMessagesFromSession(ctx);
        const completedMsgId = currentAssistantMessageId;
        patchCachedMessageIds();
        // Send step-finish to signal the SDK that response generation is complete
        broadcast({
            id: "evt_" + randomUUID(),
            type: "message.part.updated",
            properties: {
                sessionID: currentSessionId,
                part: {
                    id: "prt_" + randomUUID(),
                    messageID: completedMsgId ?? randomUUID(),
                    sessionID: currentSessionId,
                    type: "step-finish",
                    reason: "stop",
                    text: "",
                    time: { start: nowUnix(), end: nowUnix() },
                },
            },
        });
        // Broadcast the completed assistant message so P4OC has the full content
        // (patchCachedMessageIds sets currentAssistantMessageId=null, so save it first)
        const completedAssistantMsg = completedMsgId ? (cachedMessages.get(currentSessionId) ?? []).find((m: any) =>
            m.info.role === "assistant" && m.info.id === completedMsgId) : null;
        if (completedAssistantMsg) {
            broadcast({
                id: "evt_" + randomUUID(),
                type: "message.updated",
                properties: completedAssistantMsg,
            });
        }
        broadcast({
            type: "session.status",
            properties: {
                sessionID: currentSessionId,
                status: { type: "idle" },
            },
        });
        broadcast({
            type: "session.idle",
            properties: { sessionID: currentSessionId },
        });
        // Send session.updated with full session info (cost, tokens, agent, model)
        const currentSess = sessions.get(currentSessionId);
        if (currentSess) {
            broadcast({
                type: "session.updated",
                properties: {
                    sessionID: currentSessionId,
                    info: toOCSession(currentSess, activeCwd),
                },
            });
        }
    });

    pi.on("message_start", async (event, _ctx) => {
        const msg = event.message;
        // Skip user message broadcast if we already broadcast one from POST handler
        if (msg.role === "user" && !currentAssistantMessageId) {
            broadcast({
                type: "message.updated",
                properties: {
                    info: {
                        id: randomUUID(),
                        sessionID: currentSessionId,
                        role: "user",
                        time: { created: nowUnix() },
                        agent: "coder",
                        model: {},
                    },
                },
            });
        }

        // ── Phase 4: Emit question.asked for user messages that look like questions ──
        if (msg.role === "user") {
            const userText = typeof msg.content === "string"
                ? msg.content
                : Array.isArray(msg.content)
                  ? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ")
                  : "";
            const questionPattern = /\?\s*$|^(what|how|why|when|where|who|which|can|could|would|should|is|are|do|does|did|have|has|will|shall|may|might)/i;
            if (userText.trim() && questionPattern.test(userText.trim())) {
                const questionId = "q_" + randomUUID();
                broadcast({
                    type: "question.asked",
                    properties: {
                        questionID: questionId,
                        sessionID: currentSessionId,
                        question: userText.trim(),
                    },
                });
                dlog("Phase4: emitted question.asked id=", questionId);
            }
        }
    });

    pi.on("message_update", async (event, _ctx) => {
        const delta = event.assistantMessageEvent;

        if (delta.type === "text_delta" && delta.delta) {
            // Finalize any active thinking part with end time
            if (currentThinkingPartId) {
                broadcast({
                    type: "message.part.updated",
                    properties: {
                        part: {
                            id: currentThinkingPartId,
                            sessionID: currentSessionId,
                            messageID: currentAssistantMessageId ?? randomUUID(),
                            type: "reasoning",
                            text: "",
                            time: { start: currentThinkingStartTime, end: nowUnix() },
                        },
                    },
                });
            }
            currentThinkingPartId = null;
            currentThinkingStartTime = 0;
            currentThinkingText = "";
            if (!currentTextPartId) {
                currentTextPartId = randomUUID();
            }
            broadcast({
                type: "message.part.updated",
                properties: {
                    part: {
                        id: currentTextPartId,
                        sessionID: currentSessionId,
                        messageID: currentAssistantMessageId ?? randomUUID(),
                        type: "text",
                        text: delta.delta,
                    },
                    delta: delta.delta,
                },
            });
        }

        if (delta.type === "thinking_delta" && delta.delta) {
            if (!currentThinkingPartId) {
                currentThinkingPartId = randomUUID();
                currentThinkingStartTime = nowUnix();
                currentThinkingText = "";
            }
            currentThinkingText += delta.delta;
            broadcast({
                type: "message.part.updated",
                properties: {
                    part: {
                        id: currentThinkingPartId,
                        sessionID: currentSessionId,
                        messageID: currentAssistantMessageId ?? randomUUID(),
                        type: "reasoning",
                        text: currentThinkingText,
                        time: { start: currentThinkingStartTime },
                    },
                    delta: delta.delta,
                },
            });
        }

        if (delta.type === "toolcall_start" && delta.toolCall) {
            currentThinkingPartId = null;
            currentThinkingText = "";
            currentTextPartId = null;
            const toolCallId = delta.toolCall.id ?? "";
            broadcast({
                type: "message.part.updated",
                properties: {
                    part: {
                        id: "tool_" + toolCallId,
                        sessionID: currentSessionId,
                        messageID: currentAssistantMessageId ?? randomUUID(),
                        type: "tool",
                        callID: toolCallId,
                        tool: delta.toolCall.name ?? "",
                        state: {
                            status: "running",
                            input: delta.toolCall.arguments ?? {},
                            time: { start: nowUnix() },
                        },
                    },
                },
            });
        }
    });

    // ── Phase 4: Permission-sensitive tool tracking ─────────────────
    // Track which tools need permission (bash, edit, write)
    const permissionToolNames = ["bash", "edit", "write", "execute_command"];

    pi.on("tool_execution_start", async (event, _ctx) => {
        // Use the tool call ID as part ID so all lifecycle events (start/update/end)
        // update the same part. The client matches parts by id in upsertPart().
        const toolPartId = "tool_" + event.toolCallId;
        broadcast({
            type: "message.part.updated",
            properties: {
                part: {
                    id: toolPartId,
                    sessionID: currentSessionId,
                    messageID: currentAssistantMessageId ?? randomUUID(),
                    type: "tool",
                    callID: event.toolCallId,
                    tool: event.toolName,
                    state: {
                        status: "running",
                        input: event.args ?? {},
                        time: { start: nowUnix() },
                    },
                },
            },
        });

        // ── Phase 4: Emit permission.asked for sensitive tools ────────
        if (permissionToolNames.includes(event.toolName)) {
            const permId = "perm_" + randomUUID();
            const toolArgs = event.args ?? {};
            broadcast({
                type: "permission.asked",
                properties: {
                    permissionID: permId,
                    sessionID: currentSessionId,
                    toolName: event.toolName,
                    toolCallId: event.toolCallId,
                    prompt: `Allow agent to use ${event.toolName}?`,
                    args: toolArgs,
                },
            });
            elog("Phase4: emitted permission.asked id=", permId, "tool=", event.toolName);
        }
    });

    pi.on("tool_execution_update", async (event, _ctx) => {
        if (event.partialResult?.content) {
            const text = event.partialResult.content
                .filter((c: any) => c.type === "text")
                .map((c: any) => c.text)
                .join("\n");
            if (text) {
                const toolPartId = "tool_" + event.toolCallId;
                broadcast({
                    type: "message.part.updated",
                    properties: {
                        part: {
                            id: toolPartId,
                            sessionID: currentSessionId,
                            messageID: currentAssistantMessageId ?? randomUUID(),
                            type: "tool",
                            callID: event.toolCallId,
                            tool: event.toolName,
                            state: {
                                status: "running",
                                input: event.args ?? {},
                                title: event.toolName,
                                metadata: {},
                                time: { start: nowUnix() },
                            },
                        },
                    },
                });
            }
        }
    });

    pi.on("tool_execution_end", async (event, _ctx) => {
        const output = event.result?.content
            ? (Array.isArray(event.result.content)
                  ? event.result.content
                        .filter((c: any) => c.type === "text")
                        .map((c: any) => c.text)
                        .join("\n")
                  : String(event.result.content))
            : "";

        const toolPartId = "tool_" + event.toolCallId;
        broadcast({
            type: "message.part.updated",
            properties: {
                part: {
                    id: toolPartId,
                    sessionID: currentSessionId,
                    messageID: currentAssistantMessageId ?? randomUUID(),
                    type: "tool",
                    callID: event.toolCallId,
                    tool: event.toolName,
                    state: {
                        status: event.isError ? "error" : "completed",
                        input: {},
                        output,
                        title: event.toolName,
                        metadata: {},
                        time: { start: nowUnix(), end: nowUnix() },
                    },
                },
            },
        });

        // ── Phase 4: SSE event completeness ──────────────────────────
        const fileToolNames = ["edit", "write", "apply_diff", "patch", "create"];
        if (fileToolNames.includes(event.toolName)) {
            // Emit file.edited when file-modifying tools complete
            broadcast({
                type: "file.edited",
                properties: {
                    sessionID: currentSessionId,
                    toolName: event.toolName,
                    toolCallId: event.toolCallId,
                    status: event.isError ? "error" : "completed",
                },
            });
            // Emit session.diff to signal P4OC file diff view
            broadcast({
                type: "session.diff",
                properties: {
                    sessionID: currentSessionId,
                    files: [],
                    diff: "",
                    toolName: event.toolName,
                },
            });
            elog("Phase4: emitted file.edited + session.diff for tool=", event.toolName);

            // Emit file.watcher.updated for file system changes
            broadcast({
                type: "file.watcher.updated",
                properties: {
                    sessionID: currentSessionId,
                    toolName: event.toolName,
                    path: event.args?.path ?? event.args?.filePath ?? "",
                },
            });
            dlog("Phase4: emitted file.watcher.updated for tool=", event.toolName);
        }

        // Emit todo.updated as a stub whenever any tool completes
        // (Pi doesn't have a native todo system, but signaling helps P4OC refresh)
        broadcast({
            type: "todo.updated",
            properties: {
                sessionID: currentSessionId,
                todos: [],
            },
        });
    });

    // ── Phase 4: Session compact event ───────────────────────────────
    pi.on("session_compact", async (_event, _ctx) => {
        broadcast({
            type: "session.compacted",
            properties: {
                sessionID: currentSessionId,
            },
        });
        elog("Phase4: emitted session.compacted");
    });

    pi.on("session_shutdown", async () => {
        // Close all SSE clients
        for (const client of sseClients) {
            try {
                client.end();
            } catch {
                // ignore
            }
        }
        sseClients.clear();

        // Close HTTP server
        if (httpServer) {
            httpServer.close();
            httpServer = undefined;
        }
    });
}
