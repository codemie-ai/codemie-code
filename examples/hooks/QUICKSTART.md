# Quick Start: Local Stop Hook

This guide shows you how to set up a local hook that displays "Thanks!" when the model stops.

## What You'll Build

A simple Stop hook that displays a friendly message when the agent completes:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✨ Thanks for using CodeMie! ✨

  Agent: codemie-code
  Session: abc12345...

  Need help? Visit https://codemie.ai/docs
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Installation (3 Steps)

### 1. Make the hook executable

```bash
cd /path/to/codemie-code
chmod +x examples/hooks/stop-thanks.sh
```

### 2. Test the hook (optional)

```bash
./examples/hooks/test-stop-hook.sh
```

Expected output:
```
✅ Test PASSED: Hook executed successfully
```

### 3. Add hook to your configuration

Get the absolute path:
```bash
pwd
# Example: /Users/yourname/code/codemie-code
```

Edit `~/.codemie/codemie-cli.config.json` and add the `hooks` section to your active profile:

```json
{
  "version": 2,
  "activeProfile": "default",
  "profiles": {
    "default": {
      "provider": "openai",
      "apiKey": "your-key",
      "model": "gpt-4",
      "hooks": {
        "Stop": [
          {
            "hooks": [
              {
                "type": "command",
                "command": "/Users/yourname/code/codemie-code/examples/hooks/stop-thanks.sh",
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

**Important:** Replace `/Users/yourname/code/codemie-code` with your actual path from step 1.

## Usage

That's it! Now run any CodeMie agent:

```bash
codemie-code "Write a hello world script"
```

When the agent finishes, you'll see the thanks message automatically.

## Customization

Want to customize the message? Edit `examples/hooks/stop-thanks.sh`:

```bash
# Change this section:
echo "✨ Thanks for using CodeMie! ✨"
echo ""
echo "  Agent: $AGENT_NAME"

# To whatever you want:
echo "🎉 Great work! 🎉"
echo "Session completed successfully!"
```

## Advanced: Block Stopping

Want to prevent the agent from stopping until certain conditions are met? Use the git check example:

```bash
chmod +x examples/hooks/stop-check-git.sh
```

Then use `stop-check-git.sh` in your config instead. This hook will:
- ✅ Allow stopping if all changes are committed
- ❌ Block stopping if there are uncommitted changes
- 📝 Tell the agent to commit changes first

## Troubleshooting

### Hook not running

1. **Check permissions:**
   ```bash
   ls -l examples/hooks/stop-thanks.sh
   # Should show: -rwxr-xr-x (executable)
   ```

2. **Check path is absolute:**
   ```json
   // ❌ Wrong (relative path)
   "command": "examples/hooks/stop-thanks.sh"
   
   // ✅ Correct (absolute path)
   "command": "/Users/yourname/code/codemie-code/examples/hooks/stop-thanks.sh"
   ```

3. **Enable debug logging:**
   ```bash
   export CODEMIE_DEBUG=true
   codemie-code "test"
   # Check logs at ~/.codemie/logs/
   ```

### Script errors

Test the script manually:

```bash
export CODEMIE_HOOK_INPUT='{"session_id":"test","hook_event_name":"Stop","transcript_path":"/tmp/test","cwd":"'"$PWD"'"}'
./examples/hooks/stop-thanks.sh
```

Should output:
```
✨ Thanks for using CodeMie! ✨
...
{"decision": "allow"}
```

## Next Steps

- Read the [full hooks documentation](../../docs/HOOKS.md)
- Check out [more examples](README.md)
- Create your own custom hooks!

## Available Hook Events

You can create hooks for these events:

- **SessionStart** - Session initialization
- **UserPromptSubmit** - Before processing user prompt
- **PreToolUse** - Before tool execution
- **PostToolUse** - After tool completes
- **Stop** - Agent completion (this example)
- **SessionEnd** - Session termination

See [HOOKS.md](../../docs/HOOKS.md) for details on each event type.
