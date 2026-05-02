#!/bin/bash
# PostToolUse: touch marker whenever a codebase-memory-mcp tool runs.
# Silently skipped if jq not installed.
command -v jq &>/dev/null || exit 0
set -euo pipefail

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')
if [[ "$TOOL" == mcp__codebase-memory-mcp__* ]]; then
  touch "/tmp/cbm-mcp-used-$PPID"
fi
exit 0
