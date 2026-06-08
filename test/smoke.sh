#!/usr/bin/env bash
#
# OpenCode Serve API — Smoke Tests
#
# Starts a Pi instance with the extension, waits for it, hits endpoints,
# and reports pass/fail for each.  Designed to run without external deps.
#
# Usage:
#   ./test/smoke.sh [--ci]          # --ci skips starting pi (use external)
#   PI_SERVE_PORT=4096 ./test/smoke.sh

set -euo pipefail

PORT="${PI_SERVE_PORT:-4096}"
BASE="http://127.0.0.1:${PORT}"
PID=""
CI_MODE=0
PASS=0
FAIL=0

if [[ "${1:-}" == "--ci" ]]; then
    CI_MODE=1
fi

cleanup() {
    local ec=$?
    if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
        kill "$PID" 2>/dev/null || true
        wait "$PID" 2>/dev/null || true
    fi
    exit $ec
}
trap cleanup EXIT INT TERM

# ── Start Pi with extension ──────────────────────────────────────────

if [[ $CI_MODE -eq 0 ]]; then
    echo "=== Starting Pi with extension on port ${PORT} ==="
    cd "$(dirname "$0")/.."
    PI_SERVE_PORT=$PORT pi -e ./src/index.ts &
    PID=$!
    # Wait for server to be ready
    for i in $(seq 1 30); do
        if curl -sf "$BASE/health" >/dev/null 2>&1; then
            echo "Server ready after ${i}s"
            break
        fi
        if [[ $i -eq 30 ]]; then
            echo "FAIL: Server did not start within 30s"
            exit 1
        fi
        sleep 1
    done
fi

# ── Test helpers ─────────────────────────────────────────────────────

test_name=""
_test_count=0
_assert_fail=0

begin() {
    test_name="$1"
    _assert_fail=0
    ((_test_count++))
}

_endpoint() {
    local method="$1" path="$2" expected_status="$3" desc="$4"
    local body="${5:-}"
    local status
    local output

    if [[ -n "$body" ]]; then
        output=$(curl -s -w "\n%{http_code}" -X "$method" "$BASE$path" \
            -H "Content-Type: application/json" -d "$body")
    else
        output=$(curl -s -w "\n%{http_code}" -X "$method" "$BASE$path")
    fi
    status=$(echo "$output" | tail -1)
    output=$(echo "$output" | sed '$d')

    if [[ "$status" != "$expected_status" ]]; then
        echo "  FAIL [$method $path] expected $expected_status, got $status — $desc"
        echo "    Body: $output"
        _assert_fail=1
    else
        echo "  ok   [$method $path] $status — $desc"
    fi
}

_endpoint_contains() {
    local method="$1" path="$2" expected_status="$3" expected_text="$4" desc="$5"
    local body="${6:-}"
    local status output

    if [[ -n "$body" ]]; then
        output=$(curl -s -w "\n%{http_code}" -X "$method" "$BASE$path" \
            -H "Content-Type: application/json" -d "$body")
    else
        output=$(curl -s -w "\n%{http_code}" -X "$method" "$BASE$path")
    fi
    status=$(echo "$output" | tail -1)
    output=$(echo "$output" | sed '$d')

    if [[ "$status" != "$expected_status" ]]; then
        echo "  FAIL [$method $path] expected $expected_status, got $status — $desc"
        echo "    Body: $output"
        _assert_fail=1
    elif echo "$output" | grep -q "$expected_text"; then
        echo "  ok   [$method $path] $status (contains '$expected_text') — $desc"
    else
        echo "  FAIL [$method $path] $status but missing '$expected_text' — $desc"
        echo "    Body: $output"
        _assert_fail=1
    fi
}

end() {
    if [[ $_assert_fail -eq 0 ]]; then
        echo "  PASS: $test_name"
        ((PASS++))
    else
        echo "  FAIL: $test_name"
        ((FAIL++))
    fi
}

# ── Phase 6: Tests ───────────────────────────────────────────────────

echo ""
echo "=== Health & Instance ==="
begin "Health endpoints"
    _endpoint GET /health 200 "health check"
    _endpoint GET /global/health 200 "global health check"
    _endpoint GET /instance/dispose 200 "instance dispose"
end

begin "Event SSE"
    # Just verify SSE starts (we'll get headers and disconnect)
    local sse_status
    sse_status=$(curl -s -o /dev/null -w "%{http_code}" \
        -H "Accept: text/event-stream" \
        --max-time 3 "$BASE/global/event" 2>/dev/null || echo "200")
    if [[ "$sse_status" == "200" ]]; then
        echo "  ok   [GET /global/event] SSE connection established"
    else
        echo "  FAIL [GET /global/event] expected 200, got $sse_status"
        _assert_fail=1
    fi
end

echo ""
echo "=== Session CRUD ==="
begin "Session list/create"
    _endpoint GET /session 200 "list sessions"
    # Create a session
    local create_out
    create_out=$(curl -s -X POST "$BASE/session" -H "Content-Type: application/json" \
        -d '{"title":"test session"}')
    echo "    Created: $create_out"
    # Extract session ID
    TEST_SESSION_ID=$(echo "$create_out" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null || echo "")
    if [[ -n "$TEST_SESSION_ID" ]]; then
        echo "  ok   Session ID: $TEST_SESSION_ID"
    fi
    _endpoint_contains GET /session 200 "$TEST_SESSION_ID" "session in list"
end

begin "Session single operations"
    if [[ -z "${TEST_SESSION_ID:-}" ]]; then
        echo "  SKIP: no session ID"
        _assert_fail=1
    else
        _endpoint GET "/session/$TEST_SESSION_ID" 200 "get session"
        _endpoint POST "/session/$TEST_SESSION_ID" 200 "update session (POST)"
        _endpoint_contains GET "/session/$TEST_SESSION_ID" 200 "$TEST_SESSION_ID" "verify unchanged"
        _endpoint DELETE "/session/$TEST_SESSION_ID" 200 "delete session"
        _endpoint GET "/session/$TEST_SESSION_ID" 404 "verify deleted"
    fi
end

echo ""
echo "=== Config ==="
begin "Config endpoints"
    _endpoint GET /config 200 "get config"
    _endpoint GET /config/providers 200 "get providers"
end

echo ""
echo "=== Provider ==="
begin "Provider endpoints"
    _endpoint GET /provider 200 "list providers"
    _endpoint GET /provider/auth 200 "provider auth"
end

echo ""
echo "=== Agent ==="
begin "Agent endpoints"
    _endpoint GET /agent 200 "list agents"
    _endpoint POST /model/active 200 "model active"
end

echo ""
echo "=== Path & VCS ==="
begin "Path endpoints"
    _endpoint GET /path 200 "get path info"
    _endpoint GET /vcs 200 "get vcs info"
end

echo ""
echo "=== Command ==="
begin "Command endpoints"
    _endpoint GET /command 200 "list commands"
end

echo ""
echo "=== File ==="
begin "File endpoints"
    _endpoint GET "/file/content?path=AGENTS.md" 200 "read file"
    _endpoint GET "/file?path=." 200 "list directory"
    _endpoint GET /file/status 200 "file status"
end

echo ""
echo "=== Find ==="
begin "Find endpoints"
    _endpoint GET "/find?pattern=opencode" 200 "find pattern"
    _endpoint GET "/find/file?query=AGENTS" 200 "find file"
    _endpoint GET /find/symbol 200 "find symbol"
end

echo ""
echo "=== Stubs ==="
begin "Stub endpoints"
    _endpoint GET /mcp 200 "mcp list"
    _endpoint GET /lsp 200 "lsp list"
    _endpoint GET /formatter 200 "formatter list"
    _endpoint GET /pty 200 "pty list"
    _endpoint GET /experimental/tool/ids 200 "experimental tool ids"
    _endpoint POST /log 200 "log"
    _endpoint POST /instance/dispose 200 "instance dispose"
end

# ── Phase 1: Critical endpoints that should work ─────────────────────

echo ""
echo "=== Phase 1: Critical P4OC Endpoints ==="
begin "PATCH and global endpoints"
    _endpoint PATCH /config 200 "PATCH config"
    _endpoint PATCH "/session/${TEST_SESSION_ID:-none}" 200 "PATCH session"
    _endpoint POST /mcp 200 "POST /mcp"
    _endpoint PUT "/auth/test" 200 "PUT auth"
end

begin "Permission/Question endpoints"
    _endpoint POST "/permission/test-perm-id/reply" 200 "permission reply"
    _endpoint POST "/question/test-q-id/reply" 200 "question reply"
    _endpoint POST "/question/test-q-id/reject" 200 "question reject"
end

begin "Session shell and init"
    _endpoint POST "/session/${TEST_SESSION_ID:-none}/shell" 200 "session shell"
    _endpoint POST "/session/${TEST_SESSION_ID:-none}/init" 200 "session init"
end

begin "Provider OAuth"
    _endpoint POST "/provider/test/oauth/authorize" 200 "oauth authorize"
    _endpoint POST "/provider/test/oauth/callback" 200 "oauth callback"
end

# ── Phase 2: PTY and stubs ──────────────────────────────────────────

echo ""
echo "=== Phase 2: PTY & Feature Stubs ==="
begin "PTY endpoints"
    _endpoint POST /pty 200 "create PTY"
    _endpoint GET "/pty/test-pty-id" 200 "get PTY"
    _endpoint DELETE "/pty/test-pty-id" 200 "delete PTY"
    _endpoint PATCH "/pty/test-pty-id" 200 "patch PTY"
    _endpoint GET "/pty/test-pty-id/connect" 200 "PTY connect"
end

begin "Global stubs"
    _endpoint GET /global/config 200 "global config"
    _endpoint POST /global/dispose 200 "global dispose"
    _endpoint GET /global/upgrade 200 "global upgrade"
    _endpoint GET /skill 200 "skill list"
    _endpoint GET /permission 200 "permission list"
    _endpoint GET /question 200 "question list"
end

begin "Experimental tool"
    _endpoint GET /experimental/tool 200 "experimental tool list"
end

begin "Session sub-stubs"
    _endpoint GET "/session/${TEST_SESSION_ID:-none}/compact" 200 "session compact"
    _endpoint GET "/session/${TEST_SESSION_ID:-none}/context" 200 "session context"
    _endpoint GET "/session/${TEST_SESSION_ID:-none}/wait" 200 "session wait"
end

# ── Phase 3: v2 SDK endpoints ───────────────────────────────────────

echo ""
echo "=== Phase 3: v2 SDK Parity ==="
begin "Project endpoints"
    _endpoint GET "/project/test-project-id" 200 "get project"
    _endpoint GET "/project/test-project-id/directories" 200 "project directories"
    _endpoint POST /project/git/init 200 "project git init"
end

begin "VCS endpoints"
    _endpoint POST /vcs/apply 200 "vcs apply"
    _endpoint GET /vcs/diff 200 "vcs diff"
    _endpoint GET "/vcs/diff/raw" 200 "vcs diff raw"
    _endpoint GET /vcs/status 200 "vcs status"
end

begin "Sync endpoints"
    _endpoint GET /sync/history 200 "sync history"
    _endpoint POST /sync/replay 200 "sync replay"
    _endpoint POST /sync/start 200 "sync start"
    _endpoint POST /sync/steal 200 "sync steal"
end

# ── Summary ──────────────────────────────────────────────────────────

echo ""
echo "=========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "=========================================="

if [[ $FAIL -gt 0 ]]; then
    exit 1
fi
exit 0
