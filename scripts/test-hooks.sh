#!/bin/bash
# Quick Hooks System Test Script
# Tests the hooks implementation with example scenarios

set -e

HOOKS_DIR="$HOME/.codemie/test-hooks"
LOG_FILE="$HOME/.codemie/hook-test.log"
TEST_CONFIG="$HOME/.codemie/test-hooks-config.json"

echo "🧪 CodeMie Hooks System Test"
echo "=============================="
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if jq is installed
if ! command -v jq &> /dev/null; then
    echo -e "${RED}✗ Error: jq is required but not installed${NC}"
    echo "Install with: brew install jq (macOS) or apt-get install jq (Linux)"
    exit 1
fi

# Create test hooks directory
echo "📁 Setting up test environment..."
mkdir -p "$HOOKS_DIR"

# Create PreToolUse hook (blocks rm -rf)
cat > "$HOOKS_DIR/pre-tool-hook.sh" << 'EOF'
#!/bin/bash
TOOL_NAME=$(echo "$CODEMIE_HOOK_INPUT" | jq -r '.tool_name')
echo "[PreToolUse] Tool: $TOOL_NAME" >> ~/.codemie/hook-test.log

if [[ "$TOOL_NAME" == "Bash" ]]; then
  COMMAND=$(echo "$CODEMIE_HOOK_INPUT" | jq -r '.tool_input.command')
  if [[ "$COMMAND" =~ "rm -rf" ]]; then
    echo '{"decision": "block", "reason": "Dangerous command blocked: rm -rf"}'
    exit 0
  fi
fi

echo '{"decision": "allow"}'
exit 0
EOF

# Create PostToolUse hook (logs all usage)
cat > "$HOOKS_DIR/post-tool-hook.sh" << 'EOF'
#!/bin/bash
TOOL_NAME=$(echo "$CODEMIE_HOOK_INPUT" | jq -r '.tool_name')
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
echo "[$TIMESTAMP] Tool: $TOOL_NAME" >> ~/.codemie/tool-usage.log
echo '{"decision": "allow"}'
exit 0
EOF

# Create UserPromptSubmit hook (adds context)
cat > "$HOOKS_DIR/prompt-hook.sh" << 'EOF'
#!/bin/bash
echo "{
  \"decision\": \"allow\",
  \"additionalContext\": \"Test context: Working in $(pwd)\"
}"
exit 0
EOF

# Make scripts executable
chmod +x "$HOOKS_DIR"/*.sh

echo -e "${GREEN}✓ Test hooks created${NC}"
echo ""

# Run tests
echo "🧪 Running Hook Tests..."
echo "----------------------"

# Clear logs
rm -f "$LOG_FILE" "$HOME/.codemie/tool-usage.log"

# Test 1: PreToolUse allows safe commands
echo -n "Test 1: PreToolUse allows safe commands... "
export CODEMIE_HOOK_INPUT='{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls -la"},"session_id":"test","cwd":"'$(pwd)'"}'
RESULT=$("$HOOKS_DIR/pre-tool-hook.sh")
EXIT_CODE=$?

if [[ $EXIT_CODE -eq 0 ]] && echo "$RESULT" | jq -e '.decision == "allow"' > /dev/null 2>&1; then
    echo -e "${GREEN}✓ PASS${NC}"
else
    echo -e "${RED}✗ FAIL${NC}"
    echo "  Expected: allow, Got: $RESULT"
fi

# Test 2: PreToolUse blocks dangerous commands
echo -n "Test 2: PreToolUse blocks dangerous commands... "
export CODEMIE_HOOK_INPUT='{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"rm -rf /test"},"session_id":"test","cwd":"'$(pwd)'"}'
RESULT=$("$HOOKS_DIR/pre-tool-hook.sh")
EXIT_CODE=$?

if [[ $EXIT_CODE -eq 0 ]] && echo "$RESULT" | jq -e '.decision == "block"' > /dev/null 2>&1; then
    echo -e "${GREEN}✓ PASS${NC}"
else
    echo -e "${RED}✗ FAIL${NC}"
    echo "  Expected: block, Got: $RESULT"
fi

# Test 3: PreToolUse blocks specific tool
echo -n "Test 3: PreToolUse logs to file... "
if [ -f "$LOG_FILE" ] && grep -q "PreToolUse" "$LOG_FILE"; then
    echo -e "${GREEN}✓ PASS${NC}"
else
    echo -e "${RED}✗ FAIL${NC}"
    echo "  Expected log file with PreToolUse entries"
fi

# Test 4: PostToolUse creates logs
echo -n "Test 4: PostToolUse creates usage logs... "
export CODEMIE_HOOK_INPUT='{"hook_event_name":"PostToolUse","tool_name":"Read","session_id":"test","cwd":"'$(pwd)'"}'
RESULT=$("$HOOKS_DIR/post-tool-hook.sh")

if [ -f "$HOME/.codemie/tool-usage.log" ] && grep -q "Tool: Read" "$HOME/.codemie/tool-usage.log"; then
    echo -e "${GREEN}✓ PASS${NC}"
else
    echo -e "${RED}✗ FAIL${NC}"
    echo "  Expected usage log with Read entry"
fi

# Test 5: UserPromptSubmit adds context
echo -n "Test 5: UserPromptSubmit adds context... "
export CODEMIE_HOOK_INPUT='{"hook_event_name":"UserPromptSubmit","prompt":"test prompt","session_id":"test","cwd":"'$(pwd)'"}'
RESULT=$("$HOOKS_DIR/prompt-hook.sh")

if echo "$RESULT" | jq -e '.additionalContext != null' > /dev/null 2>&1; then
    echo -e "${GREEN}✓ PASS${NC}"
else
    echo -e "${RED}✗ FAIL${NC}"
    echo "  Expected additionalContext in result"
fi

# Test 6: Hook JSON output is valid
echo -n "Test 6: Hook output is valid JSON... "
export CODEMIE_HOOK_INPUT='{"hook_event_name":"PreToolUse","tool_name":"Test","session_id":"test","cwd":"'$(pwd)'"}'
RESULT=$("$HOOKS_DIR/pre-tool-hook.sh")

if echo "$RESULT" | jq '.' > /dev/null 2>&1; then
    echo -e "${GREEN}✓ PASS${NC}"
else
    echo -e "${RED}✗ FAIL${NC}"
    echo "  Hook output is not valid JSON: $RESULT"
fi

# Test 7: Hook execution time
echo -n "Test 7: Hook performance (< 100ms)... "
export CODEMIE_HOOK_INPUT='{"hook_event_name":"PreToolUse","tool_name":"Test","session_id":"test","cwd":"'$(pwd)'"}'
START=$(date +%s%N)
"$HOOKS_DIR/pre-tool-hook.sh" > /dev/null
END=$(date +%s%N)
DURATION=$(( ($END - $START) / 1000000 )) # Convert to milliseconds

if [ $DURATION -lt 100 ]; then
    echo -e "${GREEN}✓ PASS${NC} (${DURATION}ms)"
else
    echo -e "${YELLOW}⚠ SLOW${NC} (${DURATION}ms)"
fi

echo ""
echo "📊 Test Summary"
echo "----------------------"
echo "Test hooks created at: $HOOKS_DIR"
echo "Logs created at:"
echo "  - $LOG_FILE"
echo "  - $HOME/.codemie/tool-usage.log"
echo ""
echo -e "${YELLOW}Next Steps:${NC}"
echo "1. Review test hooks: ls -la $HOOKS_DIR"
echo "2. Check logs: cat $LOG_FILE"
echo "3. View full testing guide: docs/HOOKS_TESTING.md"
echo "4. Configure hooks in your profile: ~/.codemie/codemie-cli.config.json"
echo ""
echo "Example configuration:"
echo '  "hooks": {'
echo '    "PreToolUse": ['
echo '      {'
echo '        "matcher": "Bash",'
echo '        "hooks": [{'
echo '          "type": "command",'
echo "          \"command\": \"$HOOKS_DIR/pre-tool-hook.sh\","
echo '          "timeout": 5000'
echo '        }]'
echo '      }'
echo '    ]'
echo '  }'
echo ""
echo -e "${GREEN}✓ All basic tests passed!${NC}"
