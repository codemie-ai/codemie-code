# CodeMie Hooks

This directory contains example hook scripts for the CodeMie hooks system.

## Available Hooks

### check-quality.sh (Stop Hook)

Runs code quality checks before the agent completes execution:
- **ESLint**: Checks for code style and quality issues
- **Tests**: Runs the full test suite

**Usage**: Add to your profile configuration:

```json
{
  "profiles": {
    "default": {
      "hooks": {
        "Stop": [
          {
            "hooks": [
              {
                "type": "command",
                "command": "/absolute/path/to/codemie-code/hooks/check-quality.sh",
                "timeout": 300000
              }
            ]
          }
        ]
      },
      "maxHookRetries": 5
    }
  }
}
```

**Behavior**:
- **Exit 0**: All checks passed - agent can complete
- **Exit 2**: Checks failed - agent receives feedback and must fix issues
- **Retry Loop**: Agent gets up to 5 attempts to fix issues

**Example Workflow**:
1. Agent makes code changes
2. Stop hook runs linting and tests
3. If failures detected:
   - Hook returns exit code 2 with failure details
   - Agent receives feedback: "ESLint found 3 errors in file.ts..."
   - Agent fixes the issues
   - Hook runs again
4. When all checks pass, agent completes successfully

## Creating Custom Hooks

### Hook Script Template

```bash
#!/bin/bash

# Access hook input via environment variable
INPUT="$CODEMIE_HOOK_INPUT"

# Parse input with jq
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id')
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name')

# Your logic here...

# Return decision as JSON
echo '{"decision": "allow", "reason": "Check passed"}'
exit 0
```

### Exit Codes

- **0**: Success - parse JSON output for decision
- **1**: Non-blocking error - logs warning, continues
- **2**: Blocking error - triggers retry loop with feedback

### Available Environment Variables

- `CODEMIE_PROJECT_DIR`: Working directory
- `CODEMIE_SESSION_ID`: Session identifier
- `CODEMIE_HOOK_EVENT`: Event name (PreToolUse, PostToolUse, etc.)
- `CODEMIE_TOOL_NAME`: Tool being executed (if applicable)
- `CODEMIE_AGENT_NAME`: Agent name (e.g., "codemie-code")
- `CODEMIE_PROFILE_NAME`: Profile name
- `CODEMIE_TRANSCRIPT_PATH`: Path to session transcript
- `CODEMIE_PERMISSION_MODE`: Permission mode (auto/manual)
- `CODEMIE_HOOK_INPUT`: Full hook input as JSON string

## Documentation

For complete hooks documentation, see [/docs/HOOKS.md](../docs/HOOKS.md).
