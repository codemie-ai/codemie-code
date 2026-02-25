#!/bin/bash
#
# Test script for Stop hooks
#
# This script simulates what CodeMie does when executing a Stop hook,
# allowing you to test hooks locally before adding them to your config.
#

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo "Testing Stop Hook: stop-thanks.sh"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Create test hook input (what CodeMie passes to the hook)
TEST_INPUT=$(cat <<EOF
{
  "hook_event_name": "Stop",
  "session_id": "test-session-12345678",
  "transcript_path": "/tmp/test-transcript.jsonl",
  "cwd": "$PWD",
  "permission_mode": "auto",
  "agent_name": "codemie-code",
  "profile_name": "default",
  "tool_execution_history": [
    {
      "toolName": "Write",
      "success": true,
      "duration": 120
    },
    {
      "toolName": "Bash",
      "success": true,
      "duration": 85
    }
  ],
  "execution_stats": {
    "totalToolCalls": 2,
    "successfulTools": 2,
    "failedTools": 0
  }
}
EOF
)

# Set environment variable (how CodeMie passes input to hooks)
export CODEMIE_HOOK_INPUT="$TEST_INPUT"

# Execute the hook
echo "Executing hook: $SCRIPT_DIR/stop-thanks.sh"
echo ""

OUTPUT=$("$SCRIPT_DIR/stop-thanks.sh")
EXIT_CODE=$?

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Hook Output:"
echo "$OUTPUT"
echo ""
echo "Exit Code: $EXIT_CODE"
echo ""

# Parse JSON output
DECISION=$(echo "$OUTPUT" | grep -o '"decision"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4)

echo "Parsed Decision: $DECISION"
echo ""

if [ "$EXIT_CODE" -eq 0 ] && [ "$DECISION" = "allow" ]; then
  echo "✅ Test PASSED: Hook executed successfully"
  exit 0
else
  echo "❌ Test FAILED: Hook did not return expected result"
  exit 1
fi
