#!/usr/bin/env bash
# SessionStart hook (compact|resume): inject prior handoff context.
# Requires: jq (silently skips if absent).
command -v jq &>/dev/null || exit 0
set -euo pipefail

HANDOFF_FILE="$(pwd)/docs/handoff-context.md"
[[ -f "$HANDOFF_FILE" ]] || exit 0

SIZE=$(wc -c < "$HANDOFF_FILE" | tr -d ' ')
AGE_SECS=$(( $(date +%s) - $(stat -f %m "$HANDOFF_FILE" 2>/dev/null || stat -c %Y "$HANDOFF_FILE" 2>/dev/null || echo 0) ))
AGE_HRS=$(( AGE_SECS / 3600 ))

if (( SIZE > 9000 )); then
  CONTEXT=$(printf 'Prior session handoff exists: %s (%sB, %sh old). File too large to inline. Read it with the Read tool before starting work. Treat constraints_to_preserve as hard rules. Execute next_steps[0] first. Delete the file after resuming so it does not replay.' \
    "$HANDOFF_FILE" "$SIZE" "$AGE_HRS")
else
  JSON_CONTENT=$(cat "$HANDOFF_FILE")
  CONTEXT=$(printf 'Prior session handoff (auto-generated on compact, age %sh). Do NOT re-explore the codebase — state is captured below. Treat constraints_to_preserve as hard rules. If user request matches next_steps, execute next_steps[0] first. If unrelated, ask whether to resume. After resuming, delete docs/handoff-context.md so it does not replay.\n\n%s' \
    "$AGE_HRS" "$JSON_CONTENT")
fi

jq -n --arg ctx "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $ctx
  }
}'

exit 0
