# Conversations Sync CLI Command

Manual conversation syncing for Claude Code sessions.

## Usage

```bash
# Sync a specific Claude session
codemie conversations sync <session-id> [options]

# Options:
#   --assistant <id>    Assistant ID (default: 5a430368-9e91-4564-be20-989803bf4da2)
#   --folder <name>     Folder name (default: Claude Imports)
#   --dry-run          Log conversations without sending to API
#   -v, --verbose      Show detailed conversation data
```

## Examples

### Basic Sync

```bash
# Find your Claude session ID
ls ~/.claude/projects/*/

# Sync the session
codemie conversations sync abc-123-def-456
```

### Custom Assistant and Folder

```bash
codemie conversations sync abc-123 \
  --assistant my-assistant-id \
  --folder "My Custom Folder"
```

### Dry Run (Test Without Sending)

```bash
# See what would be synced without actually sending
codemie conversations sync abc-123 --dry-run -v
```

### Incremental Sync

The command automatically tracks synced conversations:

```bash
# First run: Syncs all conversations
codemie conversations sync abc-123

# Second run: Only syncs new conversations (if any)
codemie conversations sync abc-123
```

## How It Works

1. **Session File Location**: Reads from `~/.claude/projects/{hash}/{session-id}.jsonl`

2. **Conversation Splitting**: Automatically splits sessions into multiple conversations based on `/clear` commands

3. **Incremental Tracking**: Stores sync state in `~/.codemie/conversations/sync-state.json`
   - Tracks conversation IDs and message counts
   - Only syncs new messages on subsequent runs
   - Reuses conversation IDs for updates

4. **API Endpoint**: `PUT /v1/conversations/{conversation-id}/history`

## Testing

### Real Conversation Sync Test

Parametrized test that syncs real Claude sessions to localhost:

```bash
# 1. Start CodeMie API server
cd ../codemie-api
npm run dev

# 2. Find your Claude session ID
ls ~/.claude/projects/*/*.jsonl
# Example: ~/.claude/projects/abc123/def-456-ghi.jsonl
# Session ID = def-456-ghi

# 3. Run test with session ID
CODEMIE_TEST_SESSION_ID=def-456-ghi npm test -- tests/integration/conversations-sync-real.test.ts

# Or with custom API URL
CODEMIE_TEST_SESSION_ID=abc-123 \
CODEMIE_API_URL=http://localhost:3000 \
npm test -- tests/integration/conversations-sync-real.test.ts
```

### Manual Testing

```bash
# 1. Build the CLI
npm run build && npm link

# 2. Setup SSO credentials (if using SSO)
codemie profile login --url https://your-codemie-instance.com

# 3. Find a Claude session
ls ~/.claude/projects/*/

# 4. Sync it
codemie conversations sync <session-id> -v

# 5. Check the output
# - Should show 2 conversations (if you used /clear)
# - Should display message counts
# - Should show sync summary
```

## Sync State Format

The sync state is stored in `~/.codemie/conversations/sync-state.json`:

```json
{
  "sessions": {
    "claude-session-123": {
      "claudeSessionId": "claude-session-123",
      "conversations": [
        {
          "conversationId": "uuid-1",
          "messageCount": 4,
          "lastMessageTimestamp": "2026-01-06T10:00:10Z",
          "lastSyncedAt": "2026-01-06T10:05:00Z"
        },
        {
          "conversationId": "uuid-2",
          "messageCount": 6,
          "lastMessageTimestamp": "2026-01-06T10:15:00Z",
          "lastSyncedAt": "2026-01-06T10:05:00Z"
        }
      ],
      "lastUpdatedAt": "2026-01-06T10:05:00Z"
    }
  },
  "lastUpdated": "2026-01-06T10:05:00Z"
}
```

## Requirements

- **Provider**: Must use `ai-run-sso` provider
- **Authentication**: Must be logged in via `codemie profile login`
- **Session Files**: Claude session files must exist in `~/.claude/projects/`

## Troubleshooting

### "Session file not found"
- Check session ID is correct: `ls ~/.claude/projects/*/*.jsonl`
- Ensure Claude Code has created session files

### "SSO credentials not found"
- Run: `codemie profile login --url https://your-instance.com`
- Verify config: `codemie profile list`

### "Conversation sync requires ai-run-sso provider"
- Switch provider: `codemie setup`
- Select `ai-run-sso` from the list

### No new messages synced on second run
- This is expected behavior (incremental sync)
- Use `--dry-run -v` to see current state
- Check sync state: `cat ~/.codemie/conversations/sync-state.json`

## API Payload Example

The command sends this format to the API:

```json
{
  "assistant_id": "5a430368-9e91-4564-be20-989803bf4da2",
  "folder": "Claude Imports",
  "history": [
    {
      "role": "User",
      "message": "Hello, first conversation",
      "history_index": 0,
      "date": "2026-01-06T10:00:00Z",
      "file_names": []
    },
    {
      "role": "Assistant",
      "message": "Response to first conversation",
      "history_index": 0,
      "date": "2026-01-06T10:00:05Z",
      "duration": 5,
      "input_tokens": 10,
      "output_tokens": 8,
      "cache_creation_input_tokens": 0,
      "cache_read_input_tokens": 0,
      "thoughts": []
    }
  ]
}
```

## Future Enhancements (Phase 2)

- [ ] Agent adapter pattern (support Codex, Gemini conversations)
- [ ] Command blacklisting (exclude specific commands from sync)
- [ ] Resumption message detection (filter summarization markers)
- [ ] Batch sync (sync multiple sessions at once)
- [ ] Watch mode (auto-sync on file changes)
