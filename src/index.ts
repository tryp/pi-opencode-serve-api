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
                    model: {},
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
            results.push({
                info: {
                    id: entry.id,
                    sessionID: sessionId,
                    role: "assistant",
                    time: { created: ts, completed: ts },
                    parentID: "",
                    modelID: msg.model ?? "",
                    providerID: msg.provider ?? "",
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
            (pi.getFlag("--serve-port") as string) ??
            "4096",
        10,
    );
    const hostname =
        (process.env.PI_SERVE_HOST as string) ??
        (pi.getFlag("--serve-host") as string) ??
        "127.0.0.1";

    // ── State ─────────────────────────────────────────────────────────
    let currentSessionId: string = randomUUID();
    const sessions = new Map<string, SessionRecord>();
    const sseClients = new Set<ServerResponse>();
    let httpServer: Server | undefined;
    let activeCwd: string = process.cwd();

    // Create default session
    const defaultSession: SessionRecord = {
        id: currentSessionId,
        title: "",
        createdAt: nowUnix(),
        updatedAt: nowUnix(),
    };
    sessions.set(currentSessionId, defaultSession);

    // ── SSE broadcast ─────────────────────────────────────────────────

    function elog(msg: string, ...args: any[]) {
        console.log(`[${new Date().toISOString()}] [opencode-serve] ${msg}`, ...args);
    }

    function broadcast(event: { type: string; properties: any }) {
        const data = `data: ${JSON.stringify(event)}\n\n`;
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
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        });
        res.write(
            `data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`,
        );
        sseClients.add(res);
        res.on("close", () => sseClients.delete(res));
    }

    // ── Request router ────────────────────────────────────────────────

    async function handleRequest(req: IncomingMessage, res: ServerResponse) {
        const url = req.url ?? "/";
        const method = req.method ?? "GET";
        const path = pathname(url);

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
                errorResponse(res, 500, "UnknownError", err.message ?? "Internal server error");
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
        if (path === "/health" && method === "GET") {
            return jsonResponse(res, { status: "ok", sessions: sessions.size });
        }

        // ── Event streams ──────────────────────────────────────────
        if ((path === "/event" || path === "/global/event") && method === "GET") {
            return startSSE(res);
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

        // ── Stubs for features Pi doesn't have ─────────────────────
        const stubs: Record<string, any> = {
            "/mcp": {},
            "/lsp": [],
            "/formatter": [],
            "/pty": [],
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
            sessions.delete(sid);
            return jsonResponse(res, true);
        }

        // POST /session/{id}/message — synchronous prompt
        if (sub === "message" && method === "POST") {
            const body = await parseJsonBody(req);
            const parts = body.parts ?? [];
            const textParts = parts.filter((p: any) => p.type === "text");
            const text = textParts.map((p: any) => p.text).join("\n");
            if (!text) return badRequest(res, "No text content in parts");

            currentSessionId = sid;
            if (session) session.updatedAt = nowUnix();

            const userMsgId = randomUUID();
            const assistantMsgId = randomUUID();

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
            const body = await parseJsonBody(req);
            const parts = body.parts ?? [];
            const text = parts
                .filter((p: any) => p.type === "text")
                .map((p: any) => p.text)
                .join("\n");
            if (!text) return badRequest(res, "No text content in parts");

            currentSessionId = sid;
            if (session) session.updatedAt = nowUnix();

            pi.sendUserMessage(text);

            res.writeHead(204);
            res.end();
            return;
        }

        // GET /session/{id}/message — list messages
        if (sub === "message" && method === "GET") {
            // Read from Pi's session manager via the stored closure
            // We need to access sessionManager, but it's on ctx which we don't have here.
            // We store the latest entries periodically.
            return jsonResponse(res, cachedMessages);
        }

        // GET /session/{id}/message/{messageID}
        const singleMsg = sub.match(/^message\/([^/]+)$/);
        if (singleMsg && method === "GET") {
            const mid = singleMsg[1];
            const found = cachedMessages.find(
                (m: any) => m.info.id === mid,
            );
            if (!found) return notFound(res, `Message ${mid} not found`);
            return jsonResponse(res, found);
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

        // POST /session/{id}/command
        if (sub === "command" && method === "POST") {
            const body = await parseJsonBody(req);
            const cmd = body.command ?? "";
            const args = body.arguments ?? "";
            if (session) session.updatedAt = nowUnix();
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

    let cachedMessages: Array<{ info: any; parts: any[] }> = [];

    function refreshMessagesFromSession(ctx: any) {
        try {
            const sm = ctx.sessionManager;
            if (!sm) return;
            const entries = sm.getBranch();
            cachedMessages = entriesToOCMessages(entries, currentSessionId);
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

    // ── Lifecycle ──────────────────────────────────────────────────

    pi.on("session_start", async (event, ctx) => {
        activeCwd = ctx.cwd;

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

        // Start HTTP server (once)
        if (!httpServer) {
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
                console.log(
                    `opencode server listening on http://${hostname}:${port}`,
                );
                ctx.ui.notify(`OpenCode API: http://${hostname}:${port}`, "info");
                ctx.ui.setStatus("serve-api", `API :${port}`);
            });
        }
    });

    // ── Pi → OpenCode event bridge ─────────────────────────────────

    pi.on("agent_start", async (_event, ctx) => {
        refreshMessagesFromSession(ctx);
        broadcast({
            type: "session.status",
            properties: {
                sessionID: currentSessionId,
                status: { type: "busy" },
            },
        });
    });

    pi.on("agent_end", async (_event, ctx) => {
        refreshMessagesFromSession(ctx);
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
    });

    pi.on("message_start", async (event, _ctx) => {
        const msg = event.message;
        if (msg.role === "user") {
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
    });

    pi.on("message_update", async (event, _ctx) => {
        const delta = event.assistantMessageEvent;

        if (delta.type === "text_delta" && delta.delta) {
            broadcast({
                type: "message.part.updated",
                properties: {
                    part: {
                        id: randomUUID(),
                        sessionID: currentSessionId,
                        messageID: randomUUID(),
                        type: "text",
                        text: delta.delta,
                    },
                    delta: delta.delta,
                },
            });
        }

        if (delta.type === "thinking_delta" && delta.delta) {
            broadcast({
                type: "message.part.updated",
                properties: {
                    part: {
                        id: randomUUID(),
                        sessionID: currentSessionId,
                        messageID: randomUUID(),
                        type: "reasoning",
                        text: delta.delta,
                    },
                },
            });
        }

        if (delta.type === "toolcall_start" && delta.toolCall) {
            broadcast({
                type: "message.part.updated",
                properties: {
                    part: {
                        id: randomUUID(),
                        sessionID: currentSessionId,
                        messageID: randomUUID(),
                        type: "tool",
                        callID: delta.toolCall.id ?? "",
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

    pi.on("tool_execution_start", async (event, _ctx) => {
        broadcast({
            type: "message.part.updated",
            properties: {
                part: {
                    id: randomUUID(),
                    sessionID: currentSessionId,
                    messageID: randomUUID(),
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
    });

    pi.on("tool_execution_update", async (event, _ctx) => {
        if (event.partialResult?.content) {
            const text = event.partialResult.content
                .filter((c: any) => c.type === "text")
                .map((c: any) => c.text)
                .join("\n");
            if (text) {
                broadcast({
                    type: "message.part.updated",
                    properties: {
                        part: {
                            id: randomUUID(),
                            sessionID: currentSessionId,
                            messageID: randomUUID(),
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
        const output = event.result
            ? event.result.content
                  .filter((c: any) => c.type === "text")
                  .map((c: any) => c.text)
                  .join("\n")
            : "";

        broadcast({
            type: "message.part.updated",
            properties: {
                part: {
                    id: randomUUID(),
                    sessionID: currentSessionId,
                    messageID: randomUUID(),
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
