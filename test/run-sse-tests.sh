#!/usr/bin/env bash
#
# SSE Event Flow Test Orchestrator
#
# Wraps sse-harness.mjs for agent use with automatic server management,
# cleanup, and structured output.
#
# Usage:
#   ./test/run-sse-tests.sh capture [--port PORT] [--snapshot PATH] [--message MSG]
#   ./test/run-sse-tests.sh test    [--port PORT] --snapshot PATH [--mode strict|type-order]
#   ./test/run-sse-tests.sh list    [--dir DIR]
#   ./test/run-sse-tests.sh compare --actual PATH --expected PATH
#   ./test/run-sse-tests.sh capture-reference [--message MSG]
#   ./test/run-sse-tests.sh self-test        [--message MSG]
#
# Commands:
#   capture             Capture SSE events from a running server
#   test                Compare SSE events against a snapshot
#   list                List available snapshots
#   compare             Compare two snapshot files
#   capture-reference   Start reference opencode + capture
#   self-test           Start our extension + capture + compare in one step
#
# Self-test mode:
#   Starts our extension, captures SSE events, saves as a new snapshot,
#   then runs a type-order test against it (self-consistency check).
#   Useful for quick validation that the harness works and the extension
#   produces a consistent event stream.
#
# Capture-reference mode:
#   Starts the reference opencode server on port 4097, captures SSE events
#   from it, and saves as a reference snapshot for comparison.
#
# Exit codes:
#   0  All tests passed
#   1  Some tests failed
#   2  Server/process error
#   3  Invalid arguments

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS="$ROOT/test/sse-harness.mjs"
SNAPSHOT_DIR="$ROOT/test/snapshots"
PORT="${PI_SERVE_PORT:-4096}"
REF_PORT="${OPENCODE_REF_PORT:-4097}"

# ── Ensure snapshot dir exists ─────────────────────────────────────────

mkdir -p "$SNAPSHOT_DIR"

# ── Logging helpers ────────────────────────────────────────────────────

PASS=0
FAIL=0

log_pass() { echo "  [pass] $*"; ((PASS++)); }
log_fail() { echo "  [fail] $*"; ((FAIL++)); }
log_info() { echo "  [info] $*"; }
log_warn() { echo "  [warn] $*"; }

# ── Process management ─────────────────────────────────────────────────

EXT_PID=""
REF_PID=""

cleanup() {
    local ec=$?
    log_info "Cleaning up..."

    if [[ -n "$EXT_PID" ]] && kill -0 "$EXT_PID" 2>/dev/null; then
        log_info "Stopping extension (PID $EXT_PID)..."
        kill "$EXT_PID" 2>/dev/null || true
        wait "$EXT_PID" 2>/dev/null || true
        log_info "Extension stopped"
    fi

    if [[ -n "$REF_PID" ]] && kill -0 "$REF_PID" 2>/dev/null; then
        log_info "Stopping reference server (PID $REF_PID)..."
        kill "$REF_PID" 2>/dev/null || true
        wait "$REF_PID" 2>/dev/null || true
        log_info "Reference server stopped"
    fi

    # Summary
    echo ""
    echo "=========================================="
    echo "  Passed: $PASS  Failed: $FAIL"
    echo "=========================================="

    # If we're exiting due to error and have failures, use exit code 1
    if [[ $FAIL -gt 0 ]]; then
        exit 1
    fi
    exit $ec
}
trap cleanup EXIT INT TERM

# ── Check for required tools ──────────────────────────────────────────

check_tools() {
    if ! command -v node &>/dev/null; then
        echo "[fatal] node is required but not found"
        exit 2
    fi
    if ! command -v pi &>/dev/null; then
        echo "[fatal] pi is required but not found"
        exit 2
    fi
}

# ── Wait for server ────────────────────────────────────────────────────

wait_for_server() {
    local port="$1"
    local timeout="${2:-30}"
    local url="http://127.0.0.1:${port}/health"

    for i in $(seq 1 "$timeout"); do
        if curl -sf "$url" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    return 1
}

# ── Commands ───────────────────────────────────────────────────────────

cmd_capture() {
    log_info "Capture mode: connecting to server on port ${PORT}"
    node "$HARNESS" capture \
        --port "$PORT" \
        ${SNAPSHOT_ARG:+--snapshot "$SNAPSHOT_ARG"} \
        ${MESSAGE_ARG:+--message "$MESSAGE_ARG"} \
        ${TIMEOUT_ARG:+--timeout "$TIMEOUT_ARG"}
}

cmd_test() {
    if [[ -z "${SNAPSHOT_ARG:-}" ]]; then
        echo "[fatal] --snapshot is required for test mode" >&2
        exit 3
    fi
    if [[ ! -f "$SNAPSHOT_ARG" ]]; then
        echo "[fatal] Snapshot not found: $SNAPSHOT_ARG" >&2
        exit 2
    fi

    log_info "Test mode: comparing port ${PORT} against $(basename "$SNAPSHOT_ARG")"
    if node "$HARNESS" test \
        --port "$PORT" \
        --snapshot "$SNAPSHOT_ARG" \
        ${MESSAGE_ARG:+--message "$MESSAGE_ARG"} \
        ${TIMEOUT_ARG:+--timeout "$TIMEOUT_ARG"} \
        ${MODE_ARG:+--mode "$MODE_ARG"}; then
        log_pass "SSE event flow test passed"
    else
        log_fail "SSE event flow test failed"
    fi
}

cmd_list() {
    local dir="${SNAPSHOT_DIR_ARG:-$SNAPSHOT_DIR}"
    node "$HARNESS" list --dir "$dir"
}

cmd_compare() {
    if [[ -z "${ACTUAL_ARG:-}" ]] || [[ -z "${EXPECTED_ARG:-}" ]]; then
        echo "[fatal] --actual and --expected are required for compare mode" >&2
        exit 3
    fi
    if node "$HARNESS" compare \
        --actual "$ACTUAL_ARG" \
        --expected "$EXPECTED_ARG" \
        ${MODE_ARG:+--mode "$MODE_ARG"}; then
        log_pass "Comparison passed"
    else
        log_fail "Comparison failed"
    fi
}

cmd_capture_reference() {
    local ref_binary="${OPENCODE_BINARY:-}"
    local ref_dir="${OPENCODE_DIR:-$HOME/src/opencode}"

    # Check if reference server binary or source exists
    if [[ -n "$ref_binary" ]] && [[ -x "$ref_binary" ]]; then
        log_info "Using reference binary: $ref_binary"
    elif [[ -f "$ref_dir/go.mod" ]]; then
        log_info "Building reference server from $ref_dir..."
        ref_binary=$(cd "$ref_dir" && go build -o /tmp/opencode-ref-server . 2>/dev/null && echo "/tmp/opencode-ref-server") || true
        if [[ -z "$ref_binary" ]] || [[ ! -x "$ref_binary" ]]; then
            log_warn "Could not build reference server. Install Go and try again."
            log_warn "Falling back: you can manually start the reference server:"
            log_warn "  cd $ref_dir && go run . serve --port $REF_PORT"
            log_warn "Then run: $0 capture --port $REF_PORT"
            exit 2
        fi
    else
        log_warn "Reference server source not found at $ref_dir"
        log_warn "Install opencode from https://github.com/opencode-ai/opencode"
        log_warn "Or manually start and use: $0 capture --port <port>"
        exit 2
    fi

    # Generate snapshot path
    local timestamp
    timestamp=$(date +%Y%m%d-%H%M%S)
    local snapshot="${SNAPSHOT_ARG:-$SNAPSHOT_DIR/ref-capture-${timestamp}.jsonl}"

    log_info "Starting reference server on port $REF_PORT..."
    "$ref_binary" serve --port "$REF_PORT" &
    REF_PID=$!

    if ! wait_for_server "$REF_PORT" 15; then
        log_fail "Reference server did not start within 15s"
        exit 2
    fi
    log_info "Reference server ready (PID $REF_PID)"

    # Capture
    PORT="$REF_PORT" cmd_capture

    # Copy snapshot to a named reference if requested
    if [[ -n "${REF_NAME_ARG:-}" ]]; then
        local named="$SNAPSHOT_DIR/ref-${REF_NAME_ARG}.jsonl"
        cp "$snapshot" "$named"
        log_info "Also saved as: $named"
    fi
}

cmd_self_test() {
    local timestamp
    timestamp=$(date +%Y%m%d-%H%M%S)
    local snapshot="${SNAPSHOT_ARG:-$SNAPSHOT_DIR/self-test-${timestamp}.jsonl}"
    local message="${MESSAGE_ARG:-"Say 'hello world' and nothing else"}"

    log_info "Self-test mode: start extension + capture + self-verify"

    # Start extension in RPC mode.
    # Interactive/TUI mode prevents the HTTP server listen callback from
    # firing, so we use --mode rpc instead.
    #
    # RPC mode reads stdin for commands. To prevent it from seeing EOF
    # and exiting, we pipe from 'sleep infinity': sleep never writes
    # anything and never exits, keeping the pipe write end open forever.
    # Pi blocks harmlessly on stdin reads that never arrive.
    log_info "Starting Pi extension on port $PORT in RPC mode..."
    sleep infinity | PI_SERVE_PORT="$PORT" \
        pi --no-extensions -e "$ROOT/src/index.ts" --mode rpc &
    EXT_PID=$!
    EXT_PID=$!

    if ! wait_for_server "$PORT" 30; then
        log_fail "Extension did not start within 30s"
        exit 2
    fi
    log_info "Extension ready (PID $EXT_PID)"

    # Capture
    log_info "Capturing SSE event stream..."
    if ! node "$HARNESS" capture \
        --port "$PORT" \
        --snapshot "$snapshot" \
        --message "$message" \
        ${TIMEOUT_ARG:+--timeout "$TIMEOUT_ARG"}; then
        log_fail "Capture failed"
        exit 2
    fi

    # Verify the snapshot has events
    local count
    count=$(node -e "
        const { loadSnapshot } = await import('$HARNESS');
        const { events } = loadSnapshot('$snapshot');
        console.log(events.length);
    ")
    log_info "Captured $count events"

    if [[ "$count" -eq 0 ]]; then
        log_fail "No events captured — snapshot is empty"
        exit 2
    fi

    # Count event types
    node -e "
        const { loadSnapshot } = await import('$HARNESS');
        const { events } = loadSnapshot('$snapshot');
        const types = [...new Set(events.map(e => e.type))];
        console.log('Event types:', types.join(', '));
    "

    # Self-consistency check: capture again and compare type-order
    local snapshot2="$SNAPSHOT_DIR/self-test-${timestamp}-retest.jsonl"
    log_info "Capturing second stream for self-consistency check..."

    if ! node "$HARNESS" capture \
        --port "$PORT" \
        --snapshot "$snapshot2" \
        --message "$message" \
        ${TIMEOUT_ARG:+--timeout "$TIMEOUT_ARG"}; then
        log_fail "Second capture failed"
        exit 2
    fi

    # Compare
    log_info "Comparing two captures for consistency..."
    if node "$HARNESS" compare \
        --actual "$snapshot2" \
        --expected "$snapshot" \
        --mode "type-order"; then
        log_pass "Self-consistency check passed"
    else
        log_fail "Self-consistency check failed"
    fi

    # Stop extension
    if [[ -n "$EXT_PID" ]] && kill -0 "$EXT_PID" 2>/dev/null; then
        kill "$EXT_PID" 2>/dev/null || true
        wait "$EXT_PID" 2>/dev/null || true
        EXT_PID=""
        log_info "Extension stopped"
    fi

    echo ""
    log_info "Snapshot saved: $snapshot"
}

# ─── Parse arguments ───────────────────────────────────────────────────

COMMAND=""
SNAPSHOT_ARG=""
MESSAGE_ARG=""
TIMEOUT_ARG=""
MODE_ARG=""
ACTUAL_ARG=""
EXPECTED_ARG=""
REF_NAME_ARG=""
SNAPSHOT_DIR_ARG=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        capture|test|list|compare|capture-reference|self-test)
            COMMAND="$1"
            shift
            ;;
        --port) PORT="$2"; shift 2 ;;
        --snapshot) SNAPSHOT_ARG="$2"; shift 2 ;;
        --message) MESSAGE_ARG="$2"; shift 2 ;;
        --timeout) TIMEOUT_ARG="$2"; shift 2 ;;
        --mode) MODE_ARG="$2"; shift 2 ;;
        --actual) ACTUAL_ARG="$2"; shift 2 ;;
        --expected) EXPECTED_ARG="$2"; shift 2 ;;
        --ref-name) REF_NAME_ARG="$2"; shift 2 ;;
        --dir) SNAPSHOT_DIR_ARG="$2"; shift 2 ;;
        --help|-h)
            cat <<'HELP'
SSE Event Flow Test Orchestrator
Usage:
  ./test/run-sse-tests.sh <command> [options]

Commands:
  capture             Capture SSE events from running server
  test                Compare SSE events against snapshot
  list                List available snapshots
  compare             Compare two snapshot files
  capture-reference   Start reference opencode + capture
  self-test           Start extension + capture + self-verify

Options:
  --port PORT         Server port (default: 4096 or PI_SERVE_PORT)
  --snapshot PATH     Snapshot file path
  --message MSG       Prompt message
  --timeout SEC       Recording timeout (default: 90)
  --mode MODE         Comparison mode: strict | type-order (default: type-order)
  --actual PATH       Actual events file (compare mode)
  --expected PATH     Expected events file (compare mode)
  --ref-name NAME     Name for reference snapshot
  --dir PATH          Snapshot directory (list mode)
HELP
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 3
            ;;
    esac
done

if [[ -z "$COMMAND" ]]; then
    echo "[fatal] No command specified. Use --help for usage." >&2
    exit 3
fi

# ── Execute ─────────────────────────────────────────────────────────────

check_tools

case "$COMMAND" in
    capture)
        PORT_ARG="$PORT" cmd_capture
        ;;
    test)
        cmd_test
        ;;
    list)
        cmd_list
        ;;
    compare)
        cmd_compare
        ;;
    capture-reference)
        cmd_capture_reference
        ;;
    self-test)
        cmd_self_test
        ;;
esac

# Summary
echo ""
echo "=========================================="
echo "  Passed: $PASS  Failed: $FAIL"
echo "=========================================="

if [[ $FAIL -gt 0 ]]; then
    exit 1
fi
exit 0
