#!/bin/bash
# PreToolUse gate for Grep/Glob/Read: requires codebase-memory-mcp first.
# PostToolUse sibling (cbm-mcp-marker.sh) refreshes /tmp/cbm-mcp-used-$PPID.
# Silently skipped if jq not installed.
# Escape hatch: touch /tmp/cbm-unlock-$PPID
command -v jq &>/dev/null || exit 0
set -euo pipefail

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')
UNLOCK=/tmp/cbm-unlock-$PPID
MARKER=/tmp/cbm-mcp-used-$PPID
[ -f "$UNLOCK" ] && exit 0

find /tmp -maxdepth 1 -name 'cbm-*' -mtime +1 -delete 2>/dev/null || true

case "$TOOL" in
  Grep)
    GLOB=$(echo "$INPUT" | jq -r '.tool_input.glob // ""')
    TYPE=$(echo "$INPUT" | jq -r '.tool_input.type // ""')
    PATH_Q=$(echo "$INPUT" | jq -r '.tool_input.path // ""')
    if [[ "$GLOB" =~ \.(json|yaml|yml|md|toml|lock|txt|env)$ ]] \
      || [[ "$TYPE" =~ ^(json|yaml|md|toml|txt)$ ]] \
      || [[ "$PATH_Q" =~ (\.claude|settings|CLAUDE\.md|/tmp/|/var/) ]]; then
      exit 0
    fi
    echo "BLOCKED Grep on source code. Use codebase-memory-mcp: search_graph(query='...') or search_code(pattern='...'). Override: touch $UNLOCK." >&2
    exit 2
    ;;
  Glob)
    PATTERN=$(echo "$INPUT" | jq -r '.tool_input.pattern // ""')
    if [[ "$PATTERN" =~ \.(dart|ts|tsx|js|jsx|py|go|rs|java|kt|swift)$ ]] \
      || [[ "$PATTERN" =~ ^(lib|src|app)/ ]]; then
      echo "BLOCKED Glob on source tree. Use codebase-memory-mcp: search_graph(name_pattern='.*name.*') or get_architecture(). Override: touch $UNLOCK." >&2
      exit 2
    fi
    ;;
  Read)
    FP=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')
    if [[ "$FP" =~ \.(json|yaml|yml|md|toml|lock|txt|env|sh)$ ]] \
      || [[ "$FP" =~ (\.claude|CLAUDE\.md|settings|hooks/|/test/|_test\.) ]]; then
      exit 0
    fi
    if [ -f "$MARKER" ]; then
      AGE=$(( $(date +%s) - $(stat -f %m "$MARKER" 2>/dev/null || stat -c %Y "$MARKER" 2>/dev/null || echo 0) ))
      [ "$AGE" -lt 120 ] && exit 0
    fi
    echo "BLOCKED Read on source file without a recent codebase-memory-mcp call. Run search_graph/get_code_snippet first, then Read the file you need to Edit. Override: touch $UNLOCK." >&2
    exit 2
    ;;
esac
exit 0
