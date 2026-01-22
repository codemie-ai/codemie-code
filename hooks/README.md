# CodeMie Hooks

This directory contains example hook scripts for the CodeMie hooks system.

## Available Hooks

### check-quality.sh (Stop Hook)

Runs the **EXACT same checks as git pre-commit hook** before the agent completes:
- **lint-staged**: ESLint on changed `.ts` files (zero warnings required)
- **vitest related**: Tests for changed files only (fast, targeted)
- **license-check**: Validates package.json licenses
- **validate:secrets**: Gitleaks secret detection (if Docker available)

This ensures the agent maintains the same quality standards as manual commits.

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
- **Retry Loop**: Agent gets up to 5 attempts (configurable via `maxHookRetries`)

**Example Workflow**:
1. Agent makes code changes to `src/utils/helper.ts`
2. Stop hook runs (same as git pre-commit):
   - ESLint checks `src/utils/helper.ts` only
   - Vitest runs tests related to `src/utils/helper.ts` only
   - License check validates dependencies
   - Gitleaks scans for secrets
3. If failures detected:
   - Hook returns exit code 2 with specific errors
   - Agent receives feedback: "ESLint found 3 errors in helper.ts..."
   - Agent fixes the issues
   - Hook runs again (only on changed files)
4. When all checks pass, agent completes successfully

**Performance**: Much faster than running all tests (checks only changed files)

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
