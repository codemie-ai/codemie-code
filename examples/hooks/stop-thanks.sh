#!/bin/bash
#
# Stop Hook Example: Display "Thanks!" message when agent completes
#
# This hook is executed when the agent finishes processing and is about to stop.
# It receives hook input via the CODEMIE_HOOK_INPUT environment variable.
#
# Usage:
# 1. Make executable: chmod +x stop-thanks.sh
# 2. Add to your profile configuration (see examples/hooks/stop-thanks-config.json)

# Parse session info from hook input (optional, for debugging)
SESSION_ID=$(echo "$CODEMIE_HOOK_INPUT" | jq -r '.session_id' 2>/dev/null || echo "unknown")
AGENT_NAME=$(echo "$CODEMIE_HOOK_INPUT" | jq -r '.agent_name' 2>/dev/null || echo "unknown")

# Display thanks message to the user
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✨ Thanks for using CodeMie! ✨"
echo ""
echo "  Agent: $AGENT_NAME"
echo "  Session: ${SESSION_ID:0:8}..."
echo ""
echo "  Need help? Visit https://codemie.ai/docs"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Allow agent to stop (required for Stop hooks)
# "allow" = let the agent stop normally
# "block" = prevent stopping and continue execution (with reason)
echo '{"decision": "allow"}'
exit 0
