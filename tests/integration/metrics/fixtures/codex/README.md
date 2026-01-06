# Codex Integration Test Fixtures

This directory contains real Codex session files used for integration testing.

## Directory Structure

```
fixtures/codex/
└── sessions/
    └── 2026/
        └── 01/
            └── 02/
                ├── rollout-2026-01-02T16-58-23-019b7f37-8646-7b42-af3b-3a02bcaed870.jsonl (main)
                └── rollout-2026-01-02T19-00-00-019b7f95-0000-7000-0000-000000000001.jsonl (error handling)
```

This structure matches the actual Codex directory layout: `~/.codex/sessions/{YYYY}/{MM}/{DD}/rollout-*.jsonl`

## Test Session

**File**: `sessions/2026/01/02/rollout-2026-01-02T16-58-23-019b7f37-8646-7b42-af3b-3a02bcaed870.jsonl`
**Session ID**: `019b7f37-8646-7b42-af3b-3a02bcaed870`
**Provider**: ai-run-sso (preview-codex)
**Model**: gpt-5-1-codex-2025-11-13

### Session Contents

**Turn Count**: 5 turns
**Tool Calls**: 4 shell commands (all successful)

#### Token Usage
- Input: 180,501 tokens
- Output: 4,224 tokens
- Cache Read: 106,368 tokens
- Total: 291,093 tokens

#### Tool Calls
1. `ls` - List directory contents
2. `rg --files -g 'AGENTS.md'` - Search for files
3. `cat README.md` - Read README
4. `nl -ba README.md` - Read README with line numbers

### Expected Test Results

See `expected-session.json` for expected session metadata and `expected-metrics.jsonl` for expected delta records.

#### Full Session Parse (`parseSessionFile`)
```javascript
{
  sessionId: '019b7f37-8646-7b42-af3b-3a02bcaed870',
  turnCount: 5,
  model: 'gpt-5-1-codex-2025-11-13',
  tokens: {
    input: 180501,
    output: 4224,
    cacheRead: 106368
  },
  toolCalls: [
    { name: 'shell', status: 'success' },
    { name: 'shell', status: 'success' },
    { name: 'shell', status: 'success' },
    { name: 'shell', status: 'success' }
  ],
  toolUsageSummary: [
    { name: 'shell', count: 4, successCount: 4, errorCount: 0 }
  ],
  metadata: {
    workingDirectory: '/path/to/codemie-ai/codemie-code',
    gitBranch: 'codex',
    models: ['gpt-5-1-codex-2025-11-13'],
    modelCalls: { 'gpt-5-1-codex-2025-11-13': 5 }
  }
}
```

#### Incremental Parse (`parseIncrementalMetrics`)
**Deltas**: 13 records (see `expected-metrics.jsonl`)
- 9 token usage deltas (one per turn, tracking input/output/cache)
- 4 tool call deltas (one per shell command)

**Sample Delta - Token Usage with Cache**:
- recordId: `019b7f37-8646-7b42-af3b-3a02bcaed870:2026-01-02T14:58:30.081Z:15`
- tokens: { input: 13336, output: 111, cacheRead: 6528 }
- tools: {} (empty - no tools)
- models: ['gpt-5-1-codex-2025-11-13']
- gitBranch: 'codex'

**Sample Delta - Tool Call**:
- recordId: `019b7f37-8646-7b42-af3b-3a02bcaed870:2026-01-02T14:58:27.496Z:10`
- tokens: { input: 0, output: 0 }
- tools: { shell: 1 }
- toolStatus: { shell: { success: 1, failure: 0 } }
- models: ['gpt-5-1-codex-2025-11-13']
- gitBranch: 'codex'

### Data Structure

Codex sessions follow this structure:
```
~/.codex/sessions/{YYYY}/{MM}/{DD}/rollout-{date}T{time}-{uuid}.jsonl
```

Each JSONL file contains events:
- `session_meta`: Session metadata (working directory, git branch)
- `turn_context`: Turn metadata (model information)
- `event_msg`: Various events including `token_count`
- `response_item`: Function calls and responses (`function_call`, `function_call_output`)

### Notes

- Codex uses JSONL format (one JSON object per line)
- Token tracking available only for cloud providers (not Ollama)
- Tool calls are correlated via `call_id` between request and response
- Model is tracked from `turn_context` events

---

## Error Handling Test Session

**File**: `sessions/2026/01/02/rollout-2026-01-02T19-00-00-019b7f95-0000-7000-0000-000000000001.jsonl`
**Session ID**: `019b7f95-0000-7000-0000-000000000001`
**Provider**: ai-run-sso (preview-codex)
**Model**: gpt-5-1-codex-2025-11-13

### Session Contents

**Turn Count**: 1 turn
**Tool Calls**: 3 shell commands (2 success + 1 failure)

#### Token Usage
- Input: 5,300 tokens
- Output: 180 tokens
- Total: 5,480 tokens

#### Tool Calls
1. `ls -la` - Success (exit_code: 0)
2. `cat nonexistent.txt` - **Failure** (exit_code: 1, error: "No such file or directory")
3. `pwd` - Success (exit_code: 0)

### Expected Test Results

#### Error Detection
- Total tool calls: 3
- Successful: 2
- Failed: 1
- Error message captured: "No such file or directory"

#### Tool Usage Summary
```javascript
{
  name: 'shell',
  count: 3,
  successCount: 2,
  errorCount: 1
}
```

#### Delta Records with Failures
```javascript
// Failed tool call delta
{
  recordId: '019b7f95-0000-7000-0000-000000000001:2026-01-02T17:00:04.050Z:7',
  tokens: { input: 0, output: 0 },
  tools: { shell: 1 },
  toolStatus: {
    shell: {
      success: 0,
      failure: 1
    }
  }
}
```

This fixture validates:
- ✅ Mixed success/failure tool call handling
- ✅ Error message capture in `toolCall.error` field
- ✅ Proper `toolStatus` tracking with failure counts
- ✅ Token accounting across failed calls
