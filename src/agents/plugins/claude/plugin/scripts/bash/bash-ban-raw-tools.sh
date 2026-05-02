#!/bin/bash
# PreToolUse/Bash gate: block cat/head/tail/find/grep/rg/wc.
# Forces Read/Grep/Glob tools (which compress output).
# Silently skipped if jq not installed.
# Escape hatch: touch /tmp/bash-raw-unlock (expires 10 min).
set -euo pipefail

command -v jq &>/dev/null || exit 0

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')
[ "$TOOL" = "Bash" ] || exit 0

UNLOCK=/tmp/bash-raw-unlock
check_unlock() {
  local f=$1
  [ -f "$f" ] || return 1
  local mtime
  mtime=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo 0)
  local age=$(( $(date +%s) - mtime ))
  if [ "$age" -lt 600 ]; then return 0; fi
  rm -f "$f"; return 1
}
check_unlock "$UNLOCK" && exit 0
check_unlock "/tmp/bash-raw-unlock-$PPID" && exit 0

CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""')
TRIMMED=$(echo "$CMD" | sed -E 's/^[[:space:]]*//')
FIRST=$(echo "$TRIMMED" | awk '{print $1}')

banned=0
case "$FIRST" in
  cat|head|tail|find|grep|rg|wc) banned=1 ;;
  rtk) exit 0 ;;
esac

# Catch truncation pipes: cat file | head -20
if echo "$CMD" | grep -qE '\|\s*(tail|head)\b' && echo "$FIRST" | grep -qE '^(cat|grep|rg|find)$'; then
  cat >&2 <<EOF
BLOCKED: '| tail'/'| head' pipeline not allowed — raw output floods context before trim.
Use ctx_batch_execute instead:
  commands: [{"label": "label", "command": "your command"}]
  queries:  ["what you're looking for"]
EOF
  exit 2
fi

[ "$banned" -eq 0 ] && exit 0

case "$FIRST" in
  cat|head|tail) echo "BLOCKED '$FIRST'. Use the Read tool." >&2 ;;
  find)          echo "BLOCKED 'find'. Use the Glob tool." >&2 ;;
  grep|rg)       echo "BLOCKED '$FIRST'. Use the Grep tool." >&2 ;;
  wc)            echo "BLOCKED 'wc'. Use Read (line count visible) or rtk wc." >&2 ;;
esac
exit 2
