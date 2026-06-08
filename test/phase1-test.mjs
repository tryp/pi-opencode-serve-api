/**
 * Phase 1 endpoint tests — starts the extension with a minimal Pi mock
 * and tests all critical P4OC endpoints without requiring a full Pi runtime.
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

// Minimal Pi mock that satisfies the ExtensionAPI surface used by the extension
const pi = {
    _commands: [],
    _flags: {},
    _name: "test-session",
    _cwd: process.cwd(),
    getFlag(name) { return this._flags[name]; },
    registerFlag(name, opts) { this._flags[name] = opts; },
    registerCommand(name, opts) { this._commands.push({ name, ...opts }); },
    getCommands() { return this._commands; },
    getSessionName() { return this._name; },
    setSessionName(n) { this._name = n; },
    getAllTools() { return []; },
    sendUserMessage() {},
    on() {},
};

// Load the extension
const ext = (await import("../src/index.ts")).default;
ext(pi);

// Wait for server to start
await new Promise(r => setTimeout(r, 2000));

const BASE = `http://127.0.0.1:4096`;

async function test(method, path, body, expectedStatus, desc) {
    const url = BASE + path;
    const opts = { method, headers: {} };
    if (body) {
        opts.headers["Content-Type"] = "application/json";
        opts.body = JSON.stringify(body);
    }
    try {
        const res = await fetch(url, opts);
        const status = res.status;
        const text = await res.text();
        let json;
        try { json = JSON.parse(text); } catch { json = text; }

        if (status === expectedStatus) {
            console.log(`  PASS [${method} ${path}] ${status} — ${desc}`);
            return { ok: true, status, body: json };
        } else {
            console.log(`  FAIL [${method} ${path}] expected ${expectedStatus}, got ${status} — ${desc}`);
            console.log(`    Body: ${text.slice(0, 200)}`);
            return { ok: false, status, body: json };
        }
    } catch (e) {
        console.log(`  FAIL [${method} ${path}] connection error — ${desc}: ${e.message}`);
        return { ok: false, error: e.message };
    }
}

let passed = 0;
let failed = 0;

function check(name, ok) {
    if (ok) passed++; else failed++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${name}`);
}

console.log("\n=== Phase 1: Critical P4OC Endpoints ===\n");

// 1. Health
console.log("--- Health & Instance ---");
let r = await test("GET", "/health", null, 200, "health check");
check("health", r.ok);

r = await test("GET", "/global/health", null, 200, "global health");
check("global health", r.ok);

// 9. model/active returns true
console.log("\n--- Model ---");
r = await test("POST", "/model/active", null, 200, "model active");
check("POST /model/active returns true", r.ok && r.body === true);
if (r.ok) console.log(`    Response: ${JSON.stringify(r.body)}`);

// 10. /instance returns 404
console.log("\n--- Instance ---");
r = await test("GET", "/instance", null, 404, "instance returns 404");
check("/instance returns 404", r.ok);

// 8. PATCH /config
console.log("\n--- Config ---");
r = await test("PATCH", "/config", { theme: "light" }, 200, "PATCH config");
check("PATCH /config", r.ok);
if (r.ok) console.log(`    Response: ${JSON.stringify(r.body)}`);

// 7. PATCH /session/{id}
console.log("\n--- Session ---");
// First create a session
r = await test("POST", "/session", { title: "test-session" }, 200, "create session");
check("create session", r.ok);
let sid = r.ok ? r.body.id : null;
console.log(`    Session ID: ${sid}`);

if (sid) {
    r = await test("PATCH", `/session/${sid}`, { title: "updated-title" }, 200, "PATCH session");
    check("PATCH /session/{id}", r.ok);
    if (r.ok) console.log(`    Response title: ${r.body?.title}`);

    // 14. DELETE should broadcast session.deleted
    r = await test("DELETE", `/session/${sid}`, null, 200, "DELETE session");
    check("DELETE /session/{id}", r.ok);
    
    // Verify deleted
    r = await test("GET", `/session/${sid}`, null, 404, "session deleted");
    check("session verified deleted", r.ok);

    // 4. Shell
    r = await test("POST", `/session/${sid}/shell`, null, 200, "session shell");
    check("POST /session/{id}/shell", r.ok);
    if (r.ok) console.log(`    Response: ${JSON.stringify(r.body)}`);

    // 5. Init
    r = await test("POST", `/session/${sid}/init`, {}, 200, "session init");
    check("POST /session/{id}/init", r.ok);
}

// 6. PUT /auth/{id}
console.log("\n--- Auth ---");
r = await test("PUT", "/auth/test-provider", null, 200, "PUT auth");
check("PUT /auth/{id}", r.ok);

// 1. Permission reply
console.log("\n--- Permission ---");
r = await test("POST", "/permission/test-perm-id/reply", { response: "approve" }, 200, "permission reply");
check("POST /permission/{id}/reply", r.ok);

// 2. Question reply
console.log("\n--- Question ---");
r = await test("POST", "/question/test-q-id/reply", { response: "yes" }, 200, "question reply");
check("POST /question/{id}/reply", r.ok);

// 3. Question reject
r = await test("POST", "/question/test-q-id/reject", null, 200, "question reject");
check("POST /question/{id}/reject", r.ok);

// 11. OAuth authorize
console.log("\n--- OAuth ---");
r = await test("POST", "/provider/test-provider/oauth/authorize", null, 200, "oauth authorize");
check("POST /provider/{id}/oauth/authorize", r.ok);
if (r.ok) console.log(`    Response: ${JSON.stringify(r.body)}`);

// 12. OAuth callback
r = await test("POST", "/provider/test-provider/oauth/callback", { code: "test-code" }, 200, "oauth callback");
check("POST /provider/{id}/oauth/callback", r.ok);
if (r.ok) console.log(`    Response: ${JSON.stringify(r.body)}`);

// 13. POST /mcp
console.log("\n--- MCP ---");
r = await test("POST", "/mcp", { name: "test-mcp" }, 200, "POST /mcp");
check("POST /mcp", r.ok);
if (r.ok) console.log(`    Response: ${JSON.stringify(r.body)}`);

// Summary
console.log("\n==============================================");
console.log(`  Phase 1 Results: ${passed} passed, ${failed} failed`);
console.log("==============================================");
process.exit(failed > 0 ? 1 : 0);
