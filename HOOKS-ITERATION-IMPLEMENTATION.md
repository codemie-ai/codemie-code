# Hooks Iteration Implementation Summary

## Problem Statement

When Stop hooks returned exit code 2, the codemie-code agent would hang indefinitely because:
1. The agent was recursively called with an empty message
2. No feedback from the hook was passed to the agent
3. The agent immediately completed again, triggering the hook again in the same state
4. Infinite loop until recursion limit was reached

## Solution Implemented

### 1. Enhanced Hook Decision Parser (`src/hooks/decision.ts`)

**Changes:**
- Exit code 2 (blocking error): Now includes both `stderr` and `stdout` in `additionalContext`
- Exit code 1 (non-blocking error): Also includes output in `additionalContext` for informational feedback
- Feedback is combined and made available for agent processing

**Code:**
```typescript
// Handle exit code 2 (blocking error - requires agent retry)
if (exitCode === 2) {
  const feedback = [stderr, stdout.trim()].filter(Boolean).join('\n\n');
  return {
    decision: 'block',
    reason: stderr || 'Hook returned blocking error (exit code 2)',
    additionalContext: feedback || undefined,
  };
}

// Handle non-zero exit codes (non-blocking errors - informational)
if (exitCode !== 0) {
  const feedback = [stderr, stdout.trim()].filter(Boolean).join('\n\n');
  return {
    decision: 'allow',
    reason: `Hook failed but execution continues (exit code ${exitCode})`,
    additionalContext: feedback || undefined,
  };
}
```

### 2. Configuration Support (`src/agents/codemie-code/types.ts` & `config.ts`)

**Changes:**
- Added `maxHookRetries` field to `CodeMieConfig` interface (default: 5)
- Configuration is loaded from project settings and passed through to agent
- Users can configure retry limit via `.codemie/codemie-cli.config.json`

**Configuration Example:**
```json
{
  "hooks": {
    "Stop": [...]
  },
  "maxHookRetries": 5
}
```

### 3. Agent Loop Tracking (`src/agents/codemie-code/agent.ts`)

**Changes:**
- Added `hookLoopCounter` property to track retry attempts
- Counter resets on new user messages (not on hook feedback recursion)
- Counter increments each time a Stop hook returns exit code 2

**Code:**
```typescript
private hookLoopCounter = 0; // Track Stop hook retry attempts

// Reset hook loop counter only for new user messages (not recursive calls)
if (message.trim() && !message.startsWith('[Hook feedback]')) {
  this.hookLoopCounter = 0;
}
```

### 4. Feedback Injection for Stop Hook Exit Code 2 (`src/agents/codemie-code/agent.ts`)

**Changes:**
- When Stop hook returns exit code 2, feedback is constructed from hook output
- Feedback is passed as message content to recursive `chatStream()` call
- Agent receives feedback in conversation history and can reason about it
- Retry counter is checked against `maxHookRetries` limit

**Code:**
```typescript
if (stopHookResult.decision === 'block') {
  const maxRetries = this.config.maxHookRetries || 5;

  if (this.hookLoopCounter >= maxRetries) {
    // Limit reached - force completion with warning
    onEvent({
      type: 'content_chunk',
      content: `\n\n[Warning: Hook retry limit (${maxRetries}) reached. Completing execution.]\n\n`
    });
  } else {
    // Increment retry counter
    this.hookLoopCounter++;

    // Construct feedback message from hook output
    const hookFeedback = [
      stopHookResult.reason || 'Hook requested continuation',
      stopHookResult.additionalContext
    ]
      .filter(Boolean)
      .join('\n\n');

    // Notify user about hook retry
    onEvent({
      type: 'content_chunk',
      content: `\n\n[Hook retry ${this.hookLoopCounter}/${maxRetries}: ${stopHookResult.reason || 'Continuing execution'}]\n\n`
    });

    // Reset execution state for continuation
    this.currentExecutionSteps = [];
    this.currentStepNumber = 0;

    // Clear hook cache to allow Stop hooks to run again
    if (this.hookExecutor) {
      this.hookExecutor.clearCache();
    }

    // Recurse with hook feedback to guide agent
    const feedbackMessage = `[Hook feedback]: ${hookFeedback}`;
    return this.chatStream(feedbackMessage, onEvent);
  }
}
```

### 5. Hook Cache Clearing

**Critical Fix:**
- Call `hookExecutor.clearCache()` before retrying to allow Stop hooks to execute again
- Without this, hooks are skipped due to deduplication logic

## Implementation Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ User Request: "Implement feature X"                             │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
          ┌────────────────────────┐
          │ Agent executes task    │
          │ (writes code, runs     │
          │  tools, etc.)          │
          └────────────┬───────────┘
                       │
                       ▼
          ┌────────────────────────┐
          │ Stop hook executes     │
          │ (e.g., run tests)      │
          └────────────┬───────────┘
                       │
         ┌─────────────┴─────────────┐
         │                           │
         ▼                           ▼
    Exit Code 0              Exit Code 2
    (Success)                (Retry needed)
         │                           │
         │                           ▼
         │              ┌────────────────────────┐
         │              │ hookLoopCounter < max? │
         │              └────────┬────────┬──────┘
         │                       │        │
         │                       ▼        ▼
         │                     YES       NO
         │                       │        │
         │                       │        ▼
         │                       │   ┌────────────────────┐
         │                       │   │ Force completion   │
         │                       │   │ with warning       │
         │                       │   └────────────────────┘
         │                       │
         │                       ▼
         │          ┌────────────────────────────┐
         │          │ Increment hookLoopCounter  │
         │          │ Clear hook cache           │
         │          │ Inject feedback to agent   │
         │          │ Retry chatStream()         │
         │          └─────────────┬──────────────┘
         │                        │
         │                        ▼
         │          ┌────────────────────────────┐
         │          │ Agent sees feedback:       │
         │          │ "3 tests failed: ..."      │
         │          │ Agent reasons about fix    │
         │          │ Agent applies fix          │
         │          └─────────────┬──────────────┘
         │                        │
         │                        └───────┐
         │                                │
         ▼                                ▼
    ┌────────────────────────────────────────┐
    │ Complete successfully                  │
    └────────────────────────────────────────┘
```

## Use Case: Regression Test Suite

### Scenario
User wants to ensure all tests pass before completing a task.

### Setup
Create a Stop hook that runs the test suite:

```bash
#!/bin/bash
# .codemie/run-tests.sh

npm test

if [ $? -eq 0 ]; then
  echo "✅ All tests passed!"
  exit 0
else
  # Extract test failures
  npm test 2>&1 | grep "FAIL" | head -5
  exit 2  # Retry - agent should fix failures
fi
```

### Configuration
```json
{
  "hooks": {
    "Stop": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "./.codemie/run-tests.sh"
      }]
    }]
  },
  "maxHookRetries": 5
}
```

### Execution Flow

1. **Iteration 1**: Agent writes code → Tests run → 3 failures → Feedback: "Fix auth, db, api"
2. **Iteration 2**: Agent sees feedback → Fixes 2 issues → Tests run → 1 failure → Feedback: "Fix api validation"
3. **Iteration 3**: Agent sees feedback → Fixes last issue → Tests run → All pass → Complete ✓

## Exit Code Semantics

| Exit Code | Meaning | Decision | Agent Behavior |
|-----------|---------|----------|----------------|
| **0** | Success | `allow` | Agent completes normally |
| **1** | Non-blocking failure | `allow` | Agent completes, feedback shown as info |
| **2** | Blocking error (retry) | `block` | Agent retries with feedback, up to `maxHookRetries` times |

## Testing

### Test Hook Created
`.codemie/test-hook.sh` simulates a regression test suite:
- Attempt 1: Returns exit 2 with "3 tests failing"
- Attempt 2: Returns exit 2 with "1 test failing"
- Attempt 3: Returns exit 0 with "All tests passed!"

### Test Results
- ✅ Hook feedback is captured from stderr + stdout
- ✅ Feedback is passed to agent via `[Hook feedback]:` message
- ✅ Agent can see and reason about feedback
- ✅ Hook cache is cleared between retries
- ✅ Loop counter tracks attempts correctly
- ✅ Retry limit prevents infinite loops

## Known Limitations

### 1. User Prompt for Retry Limit (TODO)
Currently, when retry limit is reached, execution completes with a warning.
Future enhancement: Ask user for guidance (continue/abort/ignore hook).

### 2. No Retry State Persistence
If the CLI is interrupted, retry state is lost.
Future enhancement: Persist retry state across sessions.

### 3. Hook Output Truncation
Very large hook outputs may be truncated.
Future enhancement: Implement smart truncation or summarization.

## Files Modified

1. `src/hooks/decision.ts` - Enhanced exit code handling
2. `src/agents/codemie-code/types.ts` - Added `maxHookRetries` config field
3. `src/agents/codemie-code/config.ts` - Load and pass through `maxHookRetries`
4. `src/agents/codemie-code/agent.ts` - Implemented retry loop with feedback injection

## Compatibility

- ✅ Backward compatible: Existing hooks continue to work
- ✅ Default behavior preserved: Exit code 0/1 unchanged
- ✅ Opt-in: Only hooks that return exit code 2 use retry mechanism
- ✅ Configurable: Users can set custom retry limits

## Future Enhancements

1. **User interaction at limit**: AskUserQuestion integration
2. **Retry strategies**: Exponential backoff, jitter
3. **Hook metrics**: Track success rates, failure patterns
4. **Selective retry**: Allow hooks to specify retry behavior
5. **Feedback templates**: Structured feedback formats for better agent understanding
