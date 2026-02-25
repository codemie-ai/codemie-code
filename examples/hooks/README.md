# Hook Examples

This directory contains example hooks for the CodeMie Code hooks system.

## Stop Hook: Display Thanks Message

A simple hook that displays a "Thanks!" message when the agent completes.

### Files

- **`stop-thanks.sh`** - Bash script that displays a thanks message
- **`stop-thanks-config.json`** - Example profile configuration with Stop hook

### Setup

1. **Make the hook script executable:**
   ```bash
   chmod +x examples/hooks/stop-thanks.sh
   ```

2. **Test the hook locally (optional but recommended):**
   ```bash
   ./examples/hooks/test-stop-hook.sh
   ```
   
   You should see:
   ```
   ✨ Thanks for using CodeMie! ✨
   
   ✅ Test PASSED: Hook executed successfully
   ```

3. **Get the absolute path to the hook:**
   ```bash
   # From the codemie-code repository root:
   pwd
   # Example output: /Users/username/code/codemie-code
   
   # Full path will be: /Users/username/code/codemie-code/examples/hooks/stop-thanks.sh
   ```

3. **Add the hook to your profile configuration:**
   
   Edit your CodeMie configuration file (`~/.codemie/codemie-cli.config.json`) and add the `hooks` section to your active profile:

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
           "Stop": [
             {
               "hooks": [
                 {
                   "type": "command",
                   "command": "/absolute/path/to/codemie-code/examples/hooks/stop-thanks.sh",
                   "timeout": 5000
                 }
               ]
             }
           ]
         }
       }
     }
   }
   ```

   **Important:** Replace `/absolute/path/to` with the actual absolute path from step 2.

### Usage

Once configured, the hook will automatically execute when the agent completes:

```bash
# Start the agent
codemie-code "Write a hello world script"

# When the agent finishes, you'll see:
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# ✨ Thanks for using CodeMie! ✨
# 
#   Agent: codemie-code
#   Session: abc12345...
# 
#   Need help? Visit https://codemie.ai/docs
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### How It Works

1. When the agent completes execution, CodeMie triggers the `Stop` hook
2. The hook receives session information via the `CODEMIE_HOOK_INPUT` environment variable
3. The script displays a formatted thanks message
4. The script returns `{"decision": "allow"}` to allow the agent to stop normally

### Customization

You can customize the hook to:

- **Change the message:** Edit the `echo` statements in `stop-thanks.sh`
- **Add logging:** Append session info to a log file
- **Run post-processing:** Execute cleanup commands, run tests, etc.
- **Block stopping conditionally:** Return `{"decision": "block", "reason": "..."}` to prevent stopping

Example of blocking stop if tests fail:

```bash
#!/bin/bash

# Run tests
npm test > /dev/null 2>&1

if [ $? -eq 0 ]; then
  # Tests passed
  echo '{"decision": "allow"}'
else
  # Tests failed - block stopping
  echo '{"decision": "block", "reason": "Tests are failing. Please fix before completing."}'
fi
```

## Hook Input Schema

Stop hooks receive this JSON structure via `CODEMIE_HOOK_INPUT`:

```json
{
  "hook_event_name": "Stop",
  "session_id": "agent-session-id",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/working/directory",
  "permission_mode": "auto",
  "agent_name": "codemie-code",
  "profile_name": "default",
  "tool_execution_history": [
    {
      "toolName": "Write",
      "success": true,
      "duration": 120
    }
  ],
  "execution_stats": {
    "totalToolCalls": 5,
    "successfulTools": 5,
    "failedTools": 0
  }
}
```

## Advanced Example: Check Git Status

The `stop-check-git.sh` hook prevents the agent from stopping if there are uncommitted changes:

```bash
chmod +x examples/hooks/stop-check-git.sh
```

Add to your profile configuration:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/examples/hooks/stop-check-git.sh",
            "timeout": 10000
          }
        ]
      }
    ]
  }
}
```

When the agent tries to stop with uncommitted changes:

```
⚠️  Warning: 3 uncommitted change(s) detected

Run 'git status' to see changes

[Agent continues and suggests]: I'll help you commit those changes first...
```

## More Examples

For more hook examples and documentation, see:

- [HOOKS.md](../../docs/HOOKS.md) - Complete hooks documentation
- [HOOKS_TESTING.md](../../docs/HOOKS_TESTING.md) - Testing guide

## Troubleshooting

### Hook not executing

1. Check script is executable: `ls -l examples/hooks/stop-thanks.sh`
2. Verify absolute path in config matches script location
3. Check for JSON syntax errors in config file
4. Enable debug logging: `export CODEMIE_DEBUG=true` before running

### Permission errors

Make sure the script is executable:
```bash
chmod +x examples/hooks/stop-thanks.sh
```

### Hook timing out

Increase the timeout in your config:
```json
{
  "type": "command",
  "command": "/path/to/stop-thanks.sh",
  "timeout": 10000
}
```
