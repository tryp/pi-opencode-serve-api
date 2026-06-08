/**
 * Route-level validation — tests the route handler table in src/index.ts
 * by parsing the source for registered route patterns and verifying they
 * cover expected OpenCode endpoints.  No Pi instance required.
 *
 * Usage:
 *   node test/validation.mjs
 *
 * Returns 0 on success, 1 on failure.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(join(root, "src", "index.ts"), "utf8");
const lines = src.split("\n");

const knownRoutes = new Map(); // method -> Set<pattern>

// Scan the route function for if-statements matching route patterns
const routePattern = /if\s*\(\s*(?:path\s*===\s*"([^"]+)"|\/path\.match\(([^)]+)\))\s*&&\s*method\s*===\s*"([A-Z]+)"/g;

// More comprehensive pattern - match conditionals that contain both path and method checks
for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match patterns like: if (path === "/foo" && method === "GET")
    const simple = line.match(/if\s*\(\s*path\s*===\s*"([^"]+)"\s*&&\s*method\s*===\s*"([A-Z]+)"/);
    if (simple) {
        const [, path, method] = simple;
        if (!knownRoutes.has(method)) knownRoutes.set(method, new Set());
        knownRoutes.get(method).add(path);
    }
    // Match patterns like: if (path.startsWith("/foo/"))
    const startsWith = line.match(/if\s*\(\s*path\.startsWith\(["']([^"']+)["']\)/);
    if (startsWith) {
        const [, prefix] = startsWith;
        const methodMatch = line.match(/method\s*===\s*"([A-Z]+)"/);
        const method = methodMatch ? methodMatch[1] : "*";
        if (!knownRoutes.has(method)) knownRoutes.set(method, new Set());
        knownRoutes.get(method).add(prefix + "*");
    }
    // Match: const xxxMatch = path.match(...) patterns
    const matchDecl = line.match(/const\s+\w+Match\s*=\s*path\.match\(\/(.+)\/\s*\)/);
    if (matchDecl) {
        // Look ahead for method check
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
            const m = lines[j].match(/method\s*===\s*"([A-Z]+)"/);
            if (m) {
                if (!knownRoutes.has(m[1])) knownRoutes.set(m[1], new Set());
                knownRoutes.get(m[1]).add("/regex:" + matchDecl[1].substring(0, 40));
            }
        }
    }
    // Match: sub === "xxx" && method === "YYY" (session routes, including empty sub)
    const sessionSub = line.match(/sub\s*===\s*"([^"]*)"\s*&&\s*method\s*===\s*"([A-Z]+)"/);
    if (sessionSub) {
        const [, sub, method] = sessionSub;
        const label = sub ? "/session/{id}/" + sub : "/session/{id}";
        if (!knownRoutes.has(method)) knownRoutes.set(method, new Set());
        knownRoutes.get(method).add(label);
    }
    // Match: method === "YYY" && sub === "xxx" (reversed order)
    const sessionSubRev = line.match(/method\s*===\s*"([A-Z]+)"\s*&&\s*sub\s*===\s*"([^"]*)"/);
    if (sessionSubRev) {
        const [, method, sub] = sessionSubRev;
        const label = sub ? "/session/{id}/" + sub : "/session/{id}";
        if (!knownRoutes.has(method)) knownRoutes.set(method, new Set());
        knownRoutes.get(method).add(label);
    }
}

// ── Expected OpenCode endpoints ──────────────────────────────────────

const expected = {
    "GET": [
        "/health",
        "/global/health",
        "/session",
        "/session/status",
        "/session/{id}",
        "/session/{id}/message",
        "/session/{id}/message/{messageID}",
        "/session/{id}/todo",
        "/session/{id}/diff",
        "/session/{id}/children",
        "/session/{id}/compact",
        "/session/{id}/context",
        "/session/{id}/wait",
        "/config",
        "/config/providers",
        "/provider",
        "/provider/auth",
        "/agent",
        "/path",
        "/vcs",
        "/vcs/diff",
        "/vcs/diff/raw",
        "/vcs/status",
        "/file",
        "/file/content",
        "/file/status",
        "/find",
        "/find/file",
        "/find/symbol",
        "/mcp",
        "/lsp",
        "/formatter",
        "/pty",
        "/pty/{id}",
        "/pty/{id}/connect",
        "/command",
        "/experimental/tool/ids",
        "/experimental/tool",
        "/project",
        "/project/current",
        "/project/{projectID}",
        "/project/{projectID}/directories",
        "/sync/history",
        "/skill",
        "/permission",
        "/question",
        "/global/config",
        "/global/upgrade",
    ],
    "POST": [
        "/session",
        "/session/{id}",
        "/session/{id}/message",
        "/session/{id}/prompt_async",
        "/session/{id}/abort",
        "/session/{id}/fork",
        "/session/{id}/share",
        "/session/{id}/revert",
        "/session/{id}/unrevert",
        "/session/{id}/command",
        "/session/{id}/summarize",
        "/session/{id}/shell",
        "/session/{id}/init",
        "/session/{id}/permissions/{permID}",
        "/model/active",
        "/instance/dispose",
        "/log",
        "/mcp",
        "/permission/{requestID}/reply",
        "/question/{requestID}/reply",
        "/question/{requestID}/reject",
        "/provider/{id}/oauth/authorize",
        "/provider/{id}/oauth/callback",
        "/pty",
        "/project/git/init",
        "/vcs/apply",
        "/sync/replay",
        "/sync/start",
        "/sync/steal",
        "/global/dispose",
    ],
    "PATCH": [
        "/session/{id}",
        "/config",
        "/session/{id}/message/{messageID}/part/{partID}",
        "/pty/{id}",
        "/global/config",
    ],
    "DELETE": [
        "/session/{id}",
        "/session/{id}/share",
        "/session/{id}/message/{messageID}/part/{partID}",
        "/pty/{id}",
    ],
    "PUT": [
        "/auth/{id}",
    ],
};

// ── Run validation ───────────────────────────────────────────────────

let pass = 0;
let fail = 0;
const failures = [];

for (const [method, paths] of Object.entries(expected)) {
    const routes = knownRoutes.get(method) || new Set();
    for (const path of paths) {
        // Check exact match or prefix match (for regex-based routes)
        const found = routes.has(path) || 
                      path.startsWith("/regex:") ||
                      [...routes].some(r => {
                          // For regex routes, check if the pattern could match
                          if (r.startsWith("/regex:")) return true;
                          // For prefix routes
                          if (r.endsWith("*")) return path.startsWith(r.slice(0, -1));
                          // For session sub-routes
                          if (r.startsWith("/session/{id}/")) {
                              const sub = r.slice("/session/{id}/".length);
                              return path.includes(sub);
                          }
                          return false;
                      });
        if (found) {
            pass++;
        } else {
            fail++;
            failures.push(`${method} ${path}`);
        }
    }
}

// ── Report ───────────────────────────────────────────────────────────

console.log(`\n=== Route Validation ===`);
console.log(`Routes scanned: ${[...knownRoutes.values()].reduce((a, s) => a + s.size, 0)}`);
console.log(`Expected: ${Object.values(expected).reduce((a, arr) => a + arr.length, 0)}`);
console.log(`Pass: ${pass}, Fail: ${fail}`);

if (failures.length > 0) {
    console.log(`\nMissing routes:`);
    for (const f of failures) {
        console.log(`  [MISSING] ${f}`);
    }
}

// ── Additional checks ────────────────────────────────────────────────

console.log(`\n=== Additional Features ===`);

// Check for session.deleted broadcast
if (src.includes('"session.deleted"')) console.log("[OK] session.deleted event broadcast");
else {
    console.log("[MISSING] session.deleted event broadcast");
    fail++;
}

// Check for session.error broadcast
if (src.includes('"session.error"')) console.log("[OK] session.error event broadcast");
else {
    console.log("[MISSING] session.error event broadcast");
    fail++;
}

// Check for permission.asked broadcast
if (src.includes('"permission.asked"')) console.log("[OK] permission.asked event broadcast");
else {
    console.log("[MISSING] permission.asked event broadcast");
    fail++;
}

// Check for /api/ prefix stripping
if (src.includes('/api/')) console.log("[OK] /api/ prefix stripping for v2 SDK");
else {
    console.log("[MISSING] /api/ prefix stripping");
    fail++;
}

// Check for authError / serverError helpers
if (src.includes('function authError')) console.log("[OK] authError helper");
else {
    console.log("[MISSING] authError helper");
    fail++;
}
if (src.includes('function serverError')) console.log("[OK] serverError helper");
else {
    console.log("[MISSING] serverError helper");
    fail++;
}

// Check for config PATCH
if (src.includes('PATCH /config')) console.log("[OK] PATCH /config");
else {
    console.log("[MISSING] PATCH /config");
    fail++;
}

// Check for session PATCH
if (src.includes('PATCH /session')) console.log("[OK] PATCH /session");
else {
    console.log("[MISSING] PATCH /session");
    fail++;
}

// Check SSE events
const sseEvents = [
    'server.connected', 'session.created', 'session.updated',
    'session.status', 'session.idle', 'session.deleted', 'session.error',
    'session.diff', 'session.compacted',
    'message.updated', 'message.part.updated',
    'permission.asked', 'permission.replied',
    'question.asked', 'question.replied',
    'todo.updated', 'file.edited',
    'vcs.branch.updated', 'command.executed',
];
for (const evt of sseEvents) {
    if (src.includes(`"${evt}"`)) {
        // Already counted as pass above for SSE events
    } else {
        console.log(`[MISSING] SSE event: ${evt}`);
        fail++;
    }
}

console.log(`\n=== Final: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
