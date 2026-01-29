# Testing the Hooks System

This guide provides step-by-step instructions for testing the hooks implementation.

## Quick Start Testing

### Step 1: Create Test Hook Scripts

Create a test directory for your hook scripts:

```bash
mkdir -p ~/.codemie/test-hooks
cd ~/.codemie/test-hooks
```

### Step 2: Create Example Hook Scripts

#### Basic PreToolUse Hook (Block Dangerous Commands)

```bash
cat > pre-tool-hook.sh << 'EOF'
#!/bin/bash

# Parse the hook input from environment variable
TOOL_NAME=$(echo "$CODEMIE_HOOK_INPUT" | jq -r '.tool_name')

# Log the hook execution
echo "[PreToolUse Hook] Tool: $TOOL_NAME" >> ~/.codemie/hook-test.log

# Block rm -rf commands
if [[ "$TOOL_NAME" == "Bash" ]]; then
  COMMAND=$(echo "$CODEMIE_HOOK_INPUT" | jq -r '.tool_input.command')
  echo "[PreToolUse Hook] Command: $COMMAND" >> ~/.codemie/hook-test.log

  if [[ "$COMMAND" =~ "rm -rf" ]]; then
    echo '{"decision": "block", "reason": "Dangerous command blocked: rm -rf"}'
    exit 0
  fi
fi

# Allow by default
echo '{"decision": "allow"}'
exit 0
EOF

chmod +x pre-tool-hook.sh
```

#### Basic PostToolUse Hook (Log All Tool Usage)

```bash
cat > post-tool-hook.sh << 'EOF'
#!/bin/bash

# Log all tool usage to file
TOOL_NAME=$(echo "$CODEMIE_HOOK_INPUT" | jq -r '.tool_name')
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

echo "[$TIMESTAMP] Tool executed: $TOOL_NAME" >> ~/.codemie/tool-usage.log
echo "$CODEMIE_HOOK_INPUT" | jq '.' >> ~/.codemie/tool-usage-detailed.log

# Always allow (PostToolUse is informational)
echo '{"decision": "allow"}'
exit 0
EOF

chmod +x post-tool-hook.sh
```

#### UserPromptSubmit Hook (Add Context)

```bash
cat > prompt-hook.sh << 'EOF'
#!/bin/bash

# Add environment context to every prompt
ENV_INFO="You are working in: $(pwd)"

# Log the prompt
PROMPT=$(echo "$CODEMIE_HOOK_INPUT" | jq -r '.prompt')
echo "User prompt: $PROMPT" >> ~/.codemie/prompt-log.txt

# Add context
echo "{
  \"decision\": \"allow\",
  \"additionalContext\": \"$ENV_INFO\"
}"
exit 0
EOF

chmod +x prompt-hook.sh
```

#### Stop Hook (Verify Tests Pass)

```bash
cat > stop-hook.sh << 'EOF'
#!/bin/bash

# Check if we're in a project with tests
if [ ! -f "package.json" ]; then
  # No tests, allow stopping
  echo '{"decision": "allow"}'
  exit 0
fi

# Run tests (suppress output)
npm test > /dev/null 2>&1

if [ $? -eq 0 ]; then
  echo '{"decision": "allow", "reason": "Tests passed"}'
else
  echo '{"decision": "block", "reason": "Tests are failing. Please fix them before completing."}'
fi
exit 0
EOF

chmod +x stop-hook.sh
```

### Step 3: Configure Hooks

Add hooks to your profile configuration (`~/.codemie/codemie-cli.config.json`):

```bash
cat > ~/.codemie/test-hooks-config.json << 'EOF'
{
  "version": 2,
  "activeProfile": "test",
  "profiles": {
    "test": {
      "provider": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "your-api-key-here",
      "model": "gpt-4",
      "debug": true,
      "hooks": {
        "PreToolUse": [
          {
            "matcher": "Bash",
            "hooks": [
              {
                "type": "command",
                "command": "/Users/YOUR_USERNAME/.codemie/test-hooks/pre-tool-hook.sh",
                "timeout": 5000
              }
            ]
          }
        ],
        "PostToolUse": [
          {
            "matcher": "*",
            "hooks": [
              {
                "type": "command",
                "command": "/Users/YOUR_USERNAME/.codemie/test-hooks/post-tool-hook.sh",
                "timeout": 5000
              }
            ]
          }
        ],
        "UserPromptSubmit": [
          {
            "hooks": [
              {
                "type": "command",
                "command": "/Users/YOUR_USERNAME/.codemie/test-hooks/prompt-hook.sh",
                "timeout": 5000
              }
            ]
          }
        ]
      }
    }
  }
}
EOF

# Replace YOUR_USERNAME with your actual username
sed -i '' "s|YOUR_USERNAME|$(whoami)|g" ~/.codemie/test-hooks-config.json
```

## Test Scenarios

### Test 1: PreToolUse Hook (Blocking)

**Goal:** Verify that PreToolUse hook can block dangerous commands.

```bash
# Start the agent with test profile
codemie-code --profile test

# In the agent, try to run a dangerous command:
# User: "run the command: rm -rf /tmp/test"

# Expected result:
# - Hook blocks the command
# - Error message shown: "Dangerous command blocked: rm -rf"
# - Command is NOT executed
```

**Verify:**
```bash
# Check hook log
cat ~/.codemie/hook-test.log

# Should show:
# [PreToolUse Hook] Tool: Bash
# [PreToolUse Hook] Command: rm -rf /tmp/test
```

### Test 2: PreToolUse Hook (Allowing)

**Goal:** Verify that safe commands are allowed.

```bash
# In the agent:
# User: "run the command: ls -la"

# Expected result:
# - Hook allows the command
# - Command executes normally
# - Output is shown
```

**Verify:**
```bash
# Check hook log
cat ~/.codemie/hook-test.log

# Should show hook was called and allowed the command
```

### Test 3: PostToolUse Hook (Logging)

**Goal:** Verify that PostToolUse hook logs all tool usage.

```bash
# Clear the log
rm -f ~/.codemie/tool-usage.log ~/.codemie/tool-usage-detailed.log

# In the agent, run multiple commands:
# User: "read package.json then write a test file"

# Expected result:
# - All tools executed are logged
# - Hook doesn't block anything (informational only)
```

**Verify:**
```bash
# Check usage log
cat ~/.codemie/tool-usage.log

# Should show timestamps and tool names:
# [2024-01-20 10:30:45] Tool executed: Read
# [2024-01-20 10:30:47] Tool executed: Write

# Check detailed log
cat ~/.codemie/tool-usage-detailed.log | jq '.tool_name'
```

### Test 4: UserPromptSubmit Hook (Context Addition)

**Goal:** Verify that context is added to user prompts.

```bash
# Clear prompt log
rm -f ~/.codemie/prompt-log.txt

# In the agent:
# User: "What directory am I in?"

# Expected result:
# - Hook adds context about working directory
# - Agent response includes this information
```

**Verify:**
```bash
# Check prompt log
cat ~/.codemie/prompt-log.txt

# Should show the user's prompt
```

### Test 5: Stop Hook (Test Verification)

**Note:** This test requires a project with tests.

```bash
cd /path/to/project/with/tests

# Scenario A: Tests pass
# User: "implement a feature"
# (agent completes work)

# Expected result:
# - Agent completes
# - Stop hook runs tests
# - Tests pass, agent stops normally

# Scenario B: Tests fail
# Break a test first:
# User: "introduce a bug that breaks tests"
# User: "that's all"

# Expected result:
# - Agent tries to complete
# - Stop hook runs tests
# - Tests fail, hook blocks stopping
# - Agent continues with message: "Tests are failing..."
# - Agent attempts to fix tests
```

### Test 6: Pattern Matching

Test different pattern types:

**Wildcard Pattern:**
```json
{
  "matcher": "*",
  "hooks": [...]
}
```

**Literal Pattern:**
```json
{
  "matcher": "Bash",
  "hooks": [...]
}
```

**Regex Pattern:**
```json
{
  "matcher": "Bash|Write|Edit",
  "hooks": [...]
}
```

### Test 7: Prompt Hooks (LLM-based)

**Goal:** Test LLM-based decision making.

Add a prompt hook to your config:

```json
{
  "PreToolUse": [
    {
      "matcher": "Write|Edit",
      "hooks": [
        {
          "type": "prompt",
          "prompt": "Evaluate if this file operation is safe:\n\nTool: $TOOL_NAME\nArguments: $TOOL_INPUT\n\nRespond ONLY with JSON:\n{\"decision\": \"allow\" or \"deny\", \"reason\": \"brief explanation\"}\n\nDeny operations on system files.",
          "timeout": 30000
        }
      ]
    }
  ]
}
```

Test:
```bash
# Safe operation
# User: "write hello world to test.txt"
# Expected: Allowed

# Dangerous operation
# User: "write data to /etc/hosts"
# Expected: May be denied by LLM
```

## Debugging Hooks

### Enable Debug Logging

Set `debug: true` in your profile:

```json
{
  "debug": true,
  "hooks": { ... }
}
```

### Check Debug Logs

```bash
# View today's debug log
tail -f ~/.codemie/logs/debug-$(date +%Y-%m-%d).log

# Search for hook-related logs
grep -i hook ~/.codemie/logs/debug-$(date +%Y-%m-%d).log
```

### Test Hook Scripts Independently

Test your hook scripts outside of the agent:

```bash
# Set up test input
export CODEMIE_HOOK_INPUT='{
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": {"command": "ls -la"},
  "session_id": "test-session",
  "cwd": "'$(pwd)'"
}'

# Run the hook
~/.codemie/test-hooks/pre-tool-hook.sh

# Check exit code
echo "Exit code: $?"

# Should print JSON decision and exit 0
```

### Common Issues

**Hook Not Executing:**
```bash
# Check hook script is executable
ls -l ~/.codemie/test-hooks/*.sh

# Should show: -rwxr-xr-x

# Make executable if needed
chmod +x ~/.codemie/test-hooks/*.sh
```

**Hook Timeout:**
```bash
# Increase timeout in config
{
  "type": "command",
  "command": "/path/to/hook.sh",
  "timeout": 120000  // 2 minutes
}
```

**JSON Parse Error:**
```bash
# Test JSON output
~/.codemie/test-hooks/pre-tool-hook.sh | jq '.'

# Should parse without errors
```

**Hook Blocking Unexpectedly:**
```bash
# Check exit codes
~/.codemie/test-hooks/pre-tool-hook.sh
echo "Exit code: $?"

# 0 = success (check JSON for decision)
# 2 = blocking error
# other = non-blocking error
```

## Automated Testing

Create a test script to verify all hooks:

```bash
cat > ~/.codemie/test-hooks/run-tests.sh << 'EOF'
#!/bin/bash

echo "Testing Hooks System"
echo "===================="

# Test 1: PreToolUse allows safe commands
echo "Test 1: PreToolUse allows safe commands"
export CODEMIE_HOOK_INPUT='{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}'
RESULT=$(~/.codemie/test-hooks/pre-tool-hook.sh)
if [[ "$RESULT" =~ "allow" ]]; then
  echo "✓ PASS"
else
  echo "✗ FAIL: Expected allow, got: $RESULT"
fi

# Test 2: PreToolUse blocks dangerous commands
echo "Test 2: PreToolUse blocks dangerous commands"
export CODEMIE_HOOK_INPUT='{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"rm -rf /"}}'
RESULT=$(~/.codemie/test-hooks/pre-tool-hook.sh)
if [[ "$RESULT" =~ "block" ]]; then
  echo "✓ PASS"
else
  echo "✗ FAIL: Expected block, got: $RESULT"
fi

# Test 3: PostToolUse logs correctly
echo "Test 3: PostToolUse creates logs"
rm -f ~/.codemie/tool-usage.log
export CODEMIE_HOOK_INPUT='{"hook_event_name":"PostToolUse","tool_name":"Read"}'
~/.codemie/test-hooks/post-tool-hook.sh > /dev/null
if [ -f ~/.codemie/tool-usage.log ]; then
  echo "✓ PASS"
else
  echo "✗ FAIL: Log file not created"
fi

echo ""
echo "Tests complete!"
EOF

chmod +x ~/.codemie/test-hooks/run-tests.sh

# Run tests
~/.codemie/test-hooks/run-tests.sh
```

## Performance Testing

Test hook performance:

```bash
# Time a hook execution
time ~/.codemie/test-hooks/pre-tool-hook.sh

# Should be < 100ms for command hooks
```

## Integration Testing

Test hooks in a real workflow:

```bash
# Create a test project
mkdir ~/hook-test-project
cd ~/hook-test-project
npm init -y

# Add a simple test
cat > test.js << 'EOF'
console.log('Tests pass');
process.exit(0);
EOF

# Add test script to package.json
npm pkg set scripts.test="node test.js"

# Start agent with Stop hook enabled
codemie-code --profile test

# User: "help me add a new feature"
# (let agent work)
# User: "that's done"

# Observe Stop hook running tests
```

## Next Steps

After verifying the hooks work correctly:

1. **Create production hooks** - Move from test hooks to real implementations
2. **Configure per-profile** - Different hooks for dev/staging/prod
3. **Share hooks** - Distribute useful hooks to your team
4. **Monitor performance** - Track hook execution times
5. **Iterate** - Improve hooks based on usage patterns

## Troubleshooting Reference

| Issue | Check | Solution |
|-------|-------|----------|
| Hook not running | Config syntax | Validate JSON, check file paths |
| Permission denied | File permissions | `chmod +x hook-script.sh` |
| Timeout errors | Hook duration | Increase timeout or optimize script |
| JSON parse error | Hook output | Test with `jq` command |
| Hook blocks everything | Exit codes | Check exit code semantics |
| No logs appearing | Debug mode | Set `debug: true` in profile |

## Resources

- [Complete Hooks Documentation](./HOOKS.md)
- [Configuration Guide](./CONFIGURATION.md)
- [Security Best Practices](./SECURITY.md)
