#!/usr/bin/env bash
# Real end-to-end check of the subscription-analytics CLI connect flow (EPMCDME-16849):
#   built CLI hook/command processes -> durable state + queued forwarder -> HTTP -> the backend's cli_analytics router
#   and ingestor -> SQL on ONE task-owned loopback Postgres 17 container -> the backend's analytics reader.
# See drive.mjs for what is REAL, REPLAYED and SYNTHETIC. Exits non-zero when any assertion fails.
#
# Parameters (environment): CLI_REPO, BACKEND_REPO, BACKEND_PY, PROFILE, PG_PORT, API_PORT, PG_IMAGE, CONTAINER,
#   E2E_TRANSCRIPT (a real Claude transcript, .jsonl), EVIDENCE_DIR (where commands/outputs/exit codes are persisted),
#   KEEP=1 (leave the container and scratch state for inspection).
# Prerequisites: `npm run build` done in CLI_REPO, a backend checkout with its venv, podman and the cached PG image.
set -u
HERE="$(cd "$(dirname "$0")" && { pwd -W 2>/dev/null || pwd; })"
CLI_REPO="${CLI_REPO:-$(cd "$HERE/../../.." && pwd)}"
BACKEND_REPO="${BACKEND_REPO:-C:/codemie-dev/_local/epmcdme-16849/codemie}"
BACKEND_PY="${BACKEND_PY:-$BACKEND_REPO/.venv/Scripts/python.exe}"
PROFILE="${PROFILE:-claude-personal}"
PG_PORT="${PG_PORT:-55417}"
API_PORT="${API_PORT:-8765}"
PG_IMAGE="${PG_IMAGE:-docker.io/library/postgres:17}"
CONTAINER="${CONTAINER:-pg-epmcdme16849-e2e}"
EVIDENCE_DIR="${EVIDENCE_DIR:-C:/codemie-dev/_local/epmcdme-16849/evidence/e2e}"
E2E_TRANSCRIPT="${E2E_TRANSCRIPT:-C:/Users/IvanKryzhanovskyi/.claude/projects/C--codemie-dev--local-epmcdme-16849-evidence-fixtures-hookcap-work/235e967e-a83e-427b-99e9-1adc6e5e9973.jsonl}"
WORK="$EVIDENCE_DIR/scratch"
mkdir -p "$EVIDENCE_DIR"
LOG="$EVIDENCE_DIR/commands.log"
: > "$LOG"
run() { echo "\$ $*" >> "$LOG"; "$@" >> "$LOG" 2>&1; local rc=$?; echo "exit=$rc" >> "$LOG"; return $rc; }

[ -f "$CLI_REPO/dist/cli/commands/hook.js" ] || { echo "build the CLI first (npm run build in $CLI_REPO)" >&2; exit 2; }
[ -f "$E2E_TRANSCRIPT" ] || { echo "E2E_TRANSCRIPT not found: $E2E_TRANSCRIPT" >&2; exit 2; }

BACKEND_PID=""
listener() { netstat -ano | grep -E "127.0.0.1:$1 .*LISTENING" | awk '{print $5}' | sort -u; }
[ -z "$(listener "$API_PORT")" ] || { echo "port $API_PORT is already in use; set API_PORT" >&2; exit 2; }
cleanup() {
  kill "$BACKEND_PID" 2>/dev/null
  for pid in $(listener "$API_PORT"); do taskkill //F //PID "$pid" >/dev/null 2>&1; done  # the python child of the subshell
  if [ "${KEEP:-0}" != "1" ]; then run podman rm -f "$CONTAINER"; fi
}
trap cleanup EXIT

# Only this task's own container is ever created or removed.
run podman rm -f "$CONTAINER"
run podman run -d --pull=never --name "$CONTAINER" -p "127.0.0.1:$PG_PORT:5432" \
  -e POSTGRES_PASSWORD=e2e -e POSTGRES_DB=analytics_e2e "$PG_IMAGE" || { echo "could not start $CONTAINER" >&2; exit 2; }
for _ in $(seq 1 40); do podman exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
run podman exec "$CONTAINER" psql -U postgres -tAc "select version()"

export E2E_PG_URL="postgresql://postgres:e2e@127.0.0.1:$PG_PORT/analytics_e2e" E2E_PORT="$API_PORT"
(cd "$BACKEND_REPO" && PYTHONPATH="$BACKEND_REPO/src" "$BACKEND_PY" "$HERE/backend_app.py" > "$EVIDENCE_DIR/backend.log" 2>&1) &
BACKEND_PID=$!
up=0
for _ in $(seq 1 90); do
  curl -s -m 2 "http://127.0.0.1:$API_PORT/_e2e/health" >/dev/null 2>&1 && { up=1; break; }
  sleep 1
done
[ "$up" = 1 ] || { echo "backend did not start; see $EVIDENCE_DIR/backend.log" >&2; exit 2; }
echo "backend up (pid $BACKEND_PID), Postgres: $(podman exec "$CONTAINER" psql -U postgres -tAc 'show server_version')" | tee -a "$LOG"

# Scratch CODEMIE_HOME/HOME only: no global profile, installed CLI or hook is read or changed.
env -i PATH="$PATH" SYSTEMROOT="${SYSTEMROOT:-}" TEMP="${TEMP:-}" TMP="${TMP:-}" \
  CODEMIE_HOME="$WORK/codemie-home" HOME="$WORK/home" USERPROFILE="$WORK/home" \
  CLI_REPO="$CLI_REPO" E2E_WORK="$WORK" E2E_API="http://127.0.0.1:$API_PORT" E2E_PROFILE="$PROFILE" \
  E2E_TRANSCRIPT="$E2E_TRANSCRIPT" E2E_OUT="$EVIDENCE_DIR/results.json" \
  node --import "file:///$HERE/no-keytar-register.mjs" "$HERE/drive.mjs" 2>&1 | tee "$EVIDENCE_DIR/drive.out"
RC=${PIPESTATUS[0]}
echo "drive exit=$RC" | tee -a "$LOG"
exit "$RC"
