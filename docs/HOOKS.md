# Hooks System

The CodeMie Code hooks system allows you to execute custom shell commands or LLM-based prompts at key lifecycle points during agent execution. This enables powerful extensibility, custom workflows, and automation capabilities.

## Table of Contents

- [Overview](#overview)
- [Configuration](#configuration)
- [Hook Types](#hook-types)
- [Hook Events](#hook-events)
- [Security Considerations](#security-considerations)
- [Examples](#examples)
- [Troubleshooting](#troubleshooting)

## Overview

Hooks allow you to:

- **Inject context at session start** (SessionStart)
- **Block or modify tool execution** (PreToolUse)
- **Track and log tool usage** (PostToolUse)
- **Add context to user prompts** (UserPromptSubmit)
- **Continue agent execution** after completion (Stop)
- **Make decisions using LLMs** (Prompt hooks)

Hooks are configured in your profile configuration file (`~/.codemie/codemie-cli.config.json`).

## Configuration

Hooks are defined per profile in the configuration file:

```json
{
  "version": 2,
  "activeProfile": "default",
  "profiles": {
    "default": {
      "provider": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "your-api-key",
      "model": "gpt-4",
      "hooks": {
        "PreToolUse": [
          {
            "matcher": "Bash|Write",
            "hooks": [
              {
                "type": "command",
                "command": "/path/to/pre-tool-hook.sh",
                "timeout": 60000
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
                "command": "/path/to/post-tool-hook.sh",
                "timeout": 60000
              }
            ]
          }
        ]
      }
    }
  }
}
```

### Hook Configuration Schema

```typescript
{
  "PreToolUse": [
    {
      "matcher": "pattern",  // Tool name pattern (regex, wildcard *, or literal)
      "hooks": [
        {
          "type": "command" | "prompt",  // Hook type
          "command": "path/to/script.sh",  // For command hooks
          "prompt": "Evaluate if...",      // For prompt hooks
          "timeout": 60000                 // Timeout in milliseconds (default: 60000)
        }
      ]
    }
  ]
}
```

## Hook Types

### Command Hooks

Command hooks execute shell scripts or commands. The hook receives input via the `CODEMIE_HOOK_INPUT` environment variable (JSON format).

**Example command hook:**

```bash
#!/bin/bash
# pre-tool-hook.sh

# Parse input (available as CODEMIE_HOOK_INPUT environment variable)
TOOL_NAME=$(echo "$CODEMIE_HOOK_INPUT" | jq -r '.tool_name')

# Block dangerous commands
if [[ "$TOOL_NAME" == "Bash" ]]; then
  COMMAND=$(echo "$CODEMIE_HOOK_INPUT" | jq -r '.tool_input.command')

  if [[ "$COMMAND" =~ "rm -rf" ]]; then
    # Return blocking decision
    echo '{"decision": "block", "reason": "Dangerous command blocked: rm -rf"}'
    exit 0
  fi
fi

# Allow by default
echo '{"decision": "allow"}'
exit 0
```

### Prompt Hooks

Prompt hooks use an LLM to make decisions. The prompt template can include placeholders that are replaced with actual values:

**Available placeholders:**
- `$ARGUMENTS` - Full hook input as JSON
- `$TOOL_NAME` - Tool name
- `$TOOL_INPUT` - Tool input arguments as JSON
- `$PROMPT` - User prompt text (for UserPromptSubmit)
- `$SESSION_ID` - Current session ID
- `$CWD` - Current working directory

**Example prompt hook:**

```json
{
  "type": "prompt",
  "prompt": "Evaluate if this tool execution is safe:\n\nTool: $TOOL_NAME\nInput: $TOOL_INPUT\n\nRespond with JSON: {\"decision\": \"allow\" or \"deny\", \"reason\": \"explanation\"}",
  "timeout": 30000
}
```

## Hook Events

### PreToolUse

Executed **before** a tool is called. Can block or modify tool execution.

**Use cases:**
- Block dangerous commands
- Modify tool inputs
- Add security checks
- Require user approval

**Input:**
```json
{
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "ls -la" },
  "tool_use_id": "unique-id",
  "session_id": "session-id",
  "cwd": "/path/to/project",
  "permission_mode": "auto"
}
```

**Output:**
```json
{
  "decision": "allow" | "deny" | "block",
  "reason": "Human-readable explanation",
  "updatedInput": { "modified": "input" },
  "additionalContext": "Context to add to agent"
}
```

**Decisions:**
- `allow` - Allow tool execution (default)
- `deny` - Deny this specific tool call
- `block` - Block and show error to user

### PostToolUse

Executed **after** a tool completes. Informational only, cannot block.

**Use cases:**
- Log tool usage
- Track metrics
- Send notifications
- Update external systems

**Input:**
```json
{
  "hook_event_name": "PostToolUse",
  "tool_name": "Write",
  "tool_input": { "file_path": "test.txt" },
  "tool_output": "File written successfully",
  "tool_metadata": {
    "filePath": "test.txt",
    "bytesWritten": 100
  },
  "session_id": "session-id",
  "cwd": "/path/to/project"
}
```

### UserPromptSubmit

Executed **before** processing a user's prompt. Can block or add context.

**Use cases:**
- Add environment context
- Enforce prompt policies
- Inject system prompts
- Log user activity

**Input:**
```json
{
  "hook_event_name": "UserPromptSubmit",
  "prompt": "User's prompt text",
  "session_id": "session-id",
  "cwd": "/path/to/project"
}
```

**Output:**
```json
{
  "decision": "allow" | "block",
  "reason": "Explanation",
  "additionalContext": "Context to prepend to prompt"
}
```

### SessionStart

Executed at **session initialization** before the first message is processed. Can block session start, inject system context, and support iterative feedback loops.

**Use cases:**
- Detect and inject environment information (OS, architecture, etc.)
- Validate prerequisites (dependencies, environment variables)
- Check system requirements before starting
- Add session-wide context for the agent

**Input:**
```json
{
  "hook_event_name": "SessionStart",
  "session_id": "session-id",
  "cwd": "/path/to/project",
  "agent_name": "codemie-code",
  "profile_name": "default",
  "permission_mode": "auto"
}
```

**Output:**
```json
{
  "decision": "allow" | "block",
  "reason": "Human-readable explanation",
  "additionalContext": "Context injected as system message for agent"
}
```

**Decisions:**
- `allow` - Session starts normally
- `block` - Block session start (with exit code 2, supports retry loop)

**Special Features:**
- **System Context Injection**: Any output in `additionalContext` is injected as a system message, making it available to the agent throughout the session
- **Retry Loop**: If hook returns exit code 2 (blocking error) with feedback, the session start will retry up to `maxHookRetries` times (default: 5)

### Stop

Executed when the agent **completes**. Can prevent stopping and continue execution.

**Use cases:**
- Verify tests pass before stopping
- Check code quality
- Enforce completion criteria
- Run post-processing

**Input:**
```json
{
  "hook_event_name": "Stop",
  "session_id": "session-id",
  "cwd": "/path/to/project"
}
```

**Output:**
```json
{
  "decision": "allow" | "block",
  "reason": "Why to continue execution"
}
```

## Pattern Matching

Hook matchers support three pattern types:

### Wildcard
```json
{ "matcher": "*" }  // Matches all tools
```

### Literal
```json
{ "matcher": "Bash" }  // Matches exactly "Bash"
```

### Regex
```json
{ "matcher": "Bash|Write" }       // Matches Bash OR Write
{ "matcher": "[BR]ash" }           // Matches Bash OR Rash
{ "matcher": "(Read|Write|Edit)" } // Matches any of the three
```

## Security Considerations

### ⚠️ Important Security Warnings

1. **Hooks execute arbitrary commands** - Only configure hooks from trusted sources
2. **No shell injection protection in hooks** - Validate and sanitize inputs in your hook scripts
3. **Hooks have access to environment** - Don't expose credentials or secrets
4. **Timeouts are enforced** - Long-running hooks will be killed
5. **Hooks can block agent** - Blocking hooks with exit code 2 will prevent execution

### Best Practices

1. **Always validate input** in command hooks
2. **Use timeouts** to prevent hung hooks
3. **Fail open** - If unsure, allow execution
4. **Log hook decisions** for debugging
5. **Test hooks** before deploying
6. **Use prompt hooks** for complex decisions
7. **Sanitize sensitive data** before passing to hooks

### Exit Codes

Command hooks use exit codes to signal decisions:

- `0` - Success (parse JSON output for decision)
- `2` - Blocking error (blocks execution)
- Other - Non-blocking error (logs warning, continues)

## Examples

### Example 1: Block Dangerous Commands

**Configuration:**
```json
{
  "PreToolUse": [
    {
      "matcher": "Bash",
      "hooks": [
        {
          "type": "command",
          "command": "/usr/local/bin/check-safe-command.sh"
        }
      ]
    }
  ]
}
```

**Hook script (`check-safe-command.sh`):**
```bash
#!/bin/bash

# Parse input
COMMAND=$(echo "$CODEMIE_HOOK_INPUT" | jq -r '.tool_input.command')

# Block dangerous patterns
DANGEROUS_PATTERNS=(
  "rm -rf /"
  "dd if="
  "mkfs"
  "> /dev/sda"
)

for pattern in "${DANGEROUS_PATTERNS[@]}"; do
  if [[ "$COMMAND" =~ $pattern ]]; then
    echo "{\"decision\": \"block\", \"reason\": \"Dangerous command blocked: $pattern\"}"
    exit 0
  fi
done

# Allow by default
echo '{"decision": "allow"}'
```

### Example 2: Log All Tool Usage

**Configuration:**
```json
{
  "PostToolUse": [
    {
      "matcher": "*",
      "hooks": [
        {
          "type": "command",
          "command": "/usr/local/bin/log-tool-usage.sh"
        }
      ]
    }
  ]
}
```

**Hook script (`log-tool-usage.sh`):**
```bash
#!/bin/bash

# Append to log file
echo "$CODEMIE_HOOK_INPUT" >> ~/.codemie/tool-usage.log

# Always allow (PostToolUse is informational)
echo '{"decision": "allow"}'
```

### Example 3: Detect OS at Session Start

**Configuration:**
```json
{
  "SessionStart": [
    {
      "matcher": "*",
      "hooks": [
        {
          "type": "command",
          "command": "/usr/local/bin/detect-os.sh",
          "timeout": 30000
        }
      ]
    }
  ]
}
```

**Hook script (`detect-os.sh`):**
```bash
#!/bin/bash

# Detect operating system and architecture
OS_NAME=$(uname -s)
OS_ARCH=$(uname -m)
NODE_VERSION=$(node --version 2>/dev/null || echo "not installed")

# Return as additional context (will be injected as system message)
echo "{
  \"decision\": \"allow\",
  \"additionalContext\": \"Operating System: $OS_NAME\\nArchitecture: $OS_ARCH\\nNode.js: $NODE_VERSION\"
}"
```

**Result**: The agent will receive this context as a system message and can use it throughout the session:
```
[SessionStart Hook Output]:
Operating System: Darwin
Architecture: arm64
Node.js: v20.11.0
```

### Example 4: Add Environment Context

**Configuration:**
```json
{
  "UserPromptSubmit": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "/usr/local/bin/add-env-context.sh"
        }
      ]
    }
  ]
}
```

**Hook script (`add-env-context.sh`):**
```bash
#!/bin/bash

# Detect environment
if [[ "$PWD" =~ "/production/" ]]; then
  ENV="PRODUCTION"
else
  ENV="DEVELOPMENT"
fi

# Add context to prompt
echo "{
  \"decision\": \"allow\",
  \"additionalContext\": \"You are working in a $ENV environment. Be extra careful with changes.\"
}"
```

### Example 5: Verify Tests Before Stopping

**Configuration:**
```json
{
  "Stop": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "/usr/local/bin/check-tests.sh",
          "timeout": 120000
        }
      ]
    }
  ]
}
```

**Hook script (`check-tests.sh`):**
```bash
#!/bin/bash

# Run tests
npm test > /dev/null 2>&1

if [ $? -eq 0 ]; then
  # Tests passed, allow stopping
  echo '{"decision": "allow"}'
else
  # Tests failed, continue execution
  echo "{
    \"decision\": \"block\",
    \"reason\": \"Tests are failing. Please fix the tests before completing.\"
  }"
fi
```

### Example 6: LLM-Based Decision (Prompt Hook)

**Configuration:**
```json
{
  "PreToolUse": [
    {
      "matcher": "Write|Edit",
      "hooks": [
        {
          "type": "prompt",
          "prompt": "You are a security reviewer. Evaluate if this file operation is safe:\n\nTool: $TOOL_NAME\nArguments: $TOOL_INPUT\n\nRespond with JSON format:\n{\n  \"decision\": \"allow\" or \"deny\",\n  \"reason\": \"Brief explanation\"\n}\n\nBlock any operations on system files or sensitive directories.",
          "timeout": 30000
        }
      ]
    }
  ]
}
```

## Environment Variables

Hooks have access to the following environment variables:

- `CODEMIE_PROJECT_DIR` - Current working directory
- `CODEMIE_SESSION_ID` - Session identifier
- `CODEMIE_HOOK_EVENT` - Event name (PreToolUse, PostToolUse, etc.)
- `CODEMIE_TOOL_NAME` - Tool being executed (if applicable)
- `CODEMIE_AGENT_NAME` - Agent name (e.g., "codemie-code")
- `CODEMIE_PROFILE_NAME` - Profile name
- `CODEMIE_TRANSCRIPT_PATH` - Path to session transcript
- `CODEMIE_PERMISSION_MODE` - Permission mode (auto, manual)
- `CODEMIE_HOOK_INPUT` - Full hook input as JSON string

## Troubleshooting

### Hook not executing

1. Check hook configuration syntax (valid JSON)
2. Verify hook script exists and is executable (`chmod +x script.sh`)
3. Check hook script has correct shebang (`#!/bin/bash`)
4. Enable debug mode (`debug: true` in profile)
5. Check logs at `~/.codemie/logs/debug-YYYY-MM-DD.log`

### Hook timeout

1. Increase timeout in hook configuration
2. Optimize hook script for performance
3. Use background processing for slow operations
4. Consider using PostToolUse for async operations

### Hook blocking unexpectedly

1. Check hook exit codes (0 = success, 2 = blocking)
2. Verify JSON output format
3. Test hook script independently
4. Check for invalid decision values

### Prompt hook not working

1. Verify LLM configuration (API key, base URL)
2. Check prompt template syntax
3. Ensure placeholders are correct
4. Test with command hook first
5. Check LLM response format

## Performance Considerations

1. **Hooks add latency** - Each hook adds execution time
2. **Use timeouts** - Prevent hung hooks from blocking agent
3. **Parallel execution** - Multiple hooks run in parallel
4. **Deduplication** - Identical hooks run only once per event
5. **Prompt hooks are slower** - LLM calls take 1-5 seconds
6. **Command hooks are faster** - Shell scripts typically < 100ms

## Advanced Topics

### Hook Deduplication

Hooks with identical configuration (same command/prompt/timeout) run only once per event, even if configured multiple times.

### Hook Priority

When multiple hooks return different decisions, the priority order is:
1. `block` (highest priority)
2. `deny`
3. `approve`
4. `allow` (lowest priority)

### Error Handling

- Hook failures are logged but don't break agent execution
- Failed hooks default to `allow` (fail open)
- Only exit code 2 is treated as blocking error
- Timeout errors are logged and execution continues

### Testing Hooks

Test your hooks independently before integrating:

```bash
# Set up test input
export CODEMIE_HOOK_INPUT='{"tool_name": "Bash", "tool_input": {"command": "ls"}}'

# Run hook
./your-hook-script.sh

# Check output
echo $?  # Should be 0 for success
```

## Additional Resources

- [Project Documentation](../README.md)
- [Configuration Guide](./CONFIGURATION.md)
- [Security Best Practices](./SECURITY.md)
- [API Reference](./API.md)
