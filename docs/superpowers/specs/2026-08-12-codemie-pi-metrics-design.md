# Design: codemie-pi metrics parity with codemie-claude

**Status:** Approved for implementation  
**Scope:** Enable the existing `codemie-pi` agent to collect and send the same session lifecycle and tool-usage statistics to the CodeMie backend that `codemie-claude` produces.

## 1. Goal

When a user runs `codemie pi`, the CLI must collect and upload to the CodeMie backend:

- Lifecycle metric `codemie_cli_session_total` (started/completed)
- Tool-usage metric `codemie_cli_tool_usage_total` (tools, file operations, models, user prompts, errors)

in the same schema and through the same pipeline used by `codemie-claude`.

## 2. Background

- `codemie-claude` writes per-interaction `MetricDelta` records from its native Claude Code JSONL session file via `ClaudeSessionAdapter` + `claude.metrics-processor`. Those deltas are aggregated by `MetricsSyncProcessor` and sent by `MetricsSender`.
- `codemie-opencode` uses the same post-hoc pattern because OpenCode has no native hook system: it calls `processEvent(SessionStart)` in `onSessionStart`, discovers the session transcript in `onSessionEnd`, and lets `SessionAdapter.processSession` produce deltas.
- Pi stores sessions as JSONL files under the directory pointed to by `PI_CODING_AGENT_DIR`:
  - `sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl`
  - The CodeMie-managed agent dir is `<cwd>/.pi/codemie/agent`.

This makes `codemie-opencode` the closest existing pattern to copy.

## 3. High-level approach

**Approach A — session-end batch sync (selected):**

1. Add lifecycle hooks to `PiPlugin`: `onSessionStart` emits `SessionStart`, `onSessionEnd` discovers the latest Pi JSONL session and emits `SessionEnd`.
2. Implement a `PiSessionAdapter` that discovers and parses the Pi JSONL file.
3. Implement a `PiMetricsProcessor` that translates Pi entries into `MetricDelta` records written to `~/.codemie/sessions/{sessionId}_metrics.jsonl`.
4. Reuse the existing `hook.ts` → `SessionSyncer` → `MetricsSyncProcessor` pipeline for upload.

No changes to the upstream Pi repo are required.

## 4. Metrics parity list

| codemie-claude metric field | Source in Claude session | Equivalent Pi source |
|---|---|---|
| `agent` | metadata name | `pi` |
| `agent_version` | `claude --version` | `pi --version` |
| `codemie_client` | `codemie-claude` | `codemie-pi` |
| `llm_model` | assistant message `model` | assistant entry `model`, fallback `CODEMIE_MODEL` |
| `repository` | git remote / filesystem | existing `CODEMIE_REPOSITORY` / detection |
| `branch` | git branch | existing `CODEMIE_GIT_BRANCH` / detection |
| `session_id` | `CODEMIE_SESSION_ID` | `CODEMIE_SESSION_ID` |
| `session_duration_ms` | SessionEnd − SessionStart timestamps | session record startTime → endTime |
| `active_duration_ms` | `UserPromptSubmit`/`Stop` hooks | best-effort from session duration (no per-turn hooks) |
| `status`/`reason` | exit code | exit code passed to `onSessionEnd` |
| `had_errors` | tool errors / API errors | `toolResult.isError` or assistant `errorMessage` |
| `error_tools` | failing tool names | names of tools with `isError: true` |
| `error_messages` | tool error text | tool result error text |
| `api_errors` | API error messages | assistant `errorMessage` |
| `total_user_prompts` | user messages | user entries |
| `tool_names` | tool use names | tool names from `toolCall.name` |
| `total_tool_calls` | tool use count | count of tool calls |
| `successful_tool_calls` | tool success count | tool results with `isError: false` |
| `failed_tool_calls` | tool failure count | tool results with `isError: true` |
| `files_created` | `Write` tool | `write` tool |
| `files_modified` | `Edit` tool | `edit` tool |
| `files_deleted` | `Delete` tool | not directly available; omitted |
| `total_lines_added` | write content / edit patch | `write` content lines / `edit` diff `+` lines |
| `total_lines_removed` | edit patch `-` lines | `edit` diff `-` lines |
| `schema_version` | `2` | `2` |
| `count` | `1` | `1` |

MCP and extension counts are intentionally omitted for Pi because Pi does not use CodeMie’s MCP config layout or `.claude/` extension categories. The lifecycle metric will still be sent without `mcp_servers_*` and `*_project`/`*_global` extension fields.

## 5. Architecture and components

### 5.1 New files

```
src/agents/plugins/pi/
├── pi.session.ts                        # PiSessionAdapter
├── session/
│   ├── processors/
│   │   └── pi.metrics-processor.ts      # Pi → MetricDelta translator
│   └── pi-file-operations.ts            # tool → file op mapping
```

### 5.2 Modified files

- `src/agents/plugins/pi/pi.plugin.ts`
  - Add `metricsConfig: { excludeErrorsFromTools: ['bash'] }`
  - Set `sessionAnalyticsReport: true`
  - Add `lifecycle.onSessionStart` and `lifecycle.onSessionEnd`
  - Implement `getSessionAdapter()` on `PiPlugin`
- `src/agents/plugins/pi/index.ts` — re-export new symbols if needed.

### 5.3 Reused pipeline

- `src/cli/commands/hook.ts` — `processEvent(SessionStart/SessionEnd)`
- `src/agents/core/session/BaseSessionAdapter.ts` — adapter interface
- `src/agents/core/session/BaseProcessor.ts` — processor interface
- `src/providers/plugins/sso/session/SessionSyncer.ts` — syncer
- `src/providers/plugins/sso/session/processors/metrics/MetricsSyncProcessor.ts` — delta aggregator/sender

## 6. Data flow

1. `BaseAgentAdapter.run()` creates `CODEMIE_SESSION_ID`, sets proxy env, and calls `executeOnSessionStart`.
2. `PiPlugin.onSessionStart` builds a `HookProcessingConfig` and calls `processEvent({ hook_event_name: 'SessionStart', ... })`.
   - `handleSessionStart` creates the CodeMie session record and sends the `started` lifecycle metric.
3. `BaseAgentAdapter.run()` spawns `pi` with `PI_CODING_AGENT_DIR = <cwd>/.pi/codemie/agent`.
4. Pi writes session entries to `<cwd>/.pi/codemie/agent/sessions/<encoded-cwd>/<timestamp>_<id>.jsonl`.
5. When `pi` exits, `executeOnSessionEnd` calls `PiPlugin.onSessionEnd`.
6. `onSessionEnd` discovers the newest Pi session file for the current cwd and calls `processEvent({ hook_event_name: 'SessionEnd', transcript_path: <file>, ... })`.
7. `handleSessionEnd` accumulates active duration, runs `performIncrementalSync`, which calls `PiSessionAdapter.processSession`.
8. `PiMetricsProcessor` writes `MetricDelta` records to `~/.codemie/sessions/{sessionId}_metrics.jsonl`.
9. `syncPendingDataToAPI` runs `SessionSyncer` → `MetricsSyncProcessor` aggregates deltas and sends `codemie_cli_tool_usage_total`.
10. `sendSessionEndMetrics` sends the `completed` lifecycle metric, `updateSessionStatus` closes the session, and files are archived.

## 7. Pi session file parsing

### 7.1 Discovery

- Base directory: `join(getPiAgentDir(cwd), 'sessions')`
- Sub-directory name: base64url-ish encoding of the cwd. The implementation will scan all subdirectories and rely on `cwd` filtering (or heuristics) rather than reimplementing Pi’s exact encoding.
- Session file name: `<timestamp>_<sessionId>.jsonl`
- `discoverSessions({ cwd, maxAgeDays: 1, limit: 1 })` returns the newest file.

### 7.2 Entry types

Pi session JSONL entries are line-delimited JSON objects. The relevant entry shapes are:

```typescript
interface PiUserEntry {
  role: 'user';
  content: string | Array<{ type: string; text?: string }>;
  timestamp?: number;
}

interface PiAssistantEntry {
  role: 'assistant';
  content?: Array<{
    type: 'text';
    text?: string;
  } | {
    type: 'toolCall';
    toolCall: {
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    };
  }>;
  model?: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
}

interface PiToolResultEntry {
  role: 'toolResult';
  toolCallId: string;
  toolName?: string;
  content?: string | unknown;
  isError?: boolean;
  details?: Record<string, unknown>;
  durationMs?: number;
  timestamp?: number;
}
```

These interfaces are local to the Pi plugin; Pi is not added as a dependency.

### 7.3 Matching tool calls to results

- For each `assistant` entry, collect every `content` block whose `type === 'toolCall'`.
- Look ahead through subsequent entries for `toolResult` entries whose `toolCallId` matches.
- A tool call may map to zero results if the session ended prematurely; in that case emit the tool call without status.

### 7.4 Deltas

The metrics processor emits one `MetricDelta` per assistant entry that contains tool calls. Each delta contains:

- `recordId`: deterministic hash or `toolCall.id` of the first tool call (deduplication key)
- `timestamp`: assistant entry timestamp, or session start time if missing
- `tools`: `{ [toolName]: count }`
- `toolStatus`: `{ [toolName]: { success, failure } }`
- `fileOperations`: extracted from matching tool results
- `models`: `[modelName]` if present
- `userPrompts`: captured from the preceding `user` entry (or current turn if interleaved)
- `apiErrorMessage`: assistant `errorMessage` or a synthesized message when all tool results errored

## 8. File operation extraction

`pi-file-operations.ts` maps Pi tool calls to `FileOperation` records.

| Pi tool name | Operation type | Line-count source |
|---|---|---|
| `write` | `write` | `toolCall.arguments.content` |
| `edit` | `edit` | `toolResult.details.diff` or `details.patch` (`+`/`-` lines) |
| `read` | `read` | none |
| `grep` | `grep` | none |
| `glob` | `glob` | none |
| `ls` | `read` | none |
| `find` | `glob` | none |

Paths are read from `toolCall.arguments.path`, `toolCall.arguments.file_path`, or `toolResult.details.path`.
Line-count helpers reuse existing utilities in `src/utils/file-operations.ts` where possible.

## 9. Plugin metadata changes

```typescript
export const PiPluginMetadata: AgentMetadata = {
  // ... existing fields ...

  sessionAnalyticsReport: true,

  metricsConfig: {
    excludeErrorsFromTools: ['bash'],
  },

  lifecycle: {
    async beforeRun(env: NodeJS.ProcessEnv, _config: AgentConfig) { /* existing */ },
    enrichArgs(args: string[], _config: AgentConfig): string[] { /* existing */ },

    async onSessionStart(sessionId: string, env: NodeJS.ProcessEnv) {
      // SessionStart hook
    },

    async onSessionEnd(exitCode: number, env: NodeJS.ProcessEnv) {
      // SessionEnd hook + session discovery
    },
  },
};

export class PiPlugin extends BaseAgentAdapter {
  private sessionAdapter: SessionAdapter;

  constructor() {
    super(PiPluginMetadata);
    this.sessionAdapter = new PiSessionAdapter(PiPluginMetadata);
  }

  getSessionAdapter(): SessionAdapter {
    return this.sessionAdapter;
  }

  // ... additionalInstallation stays ...
}
```

## 10. Error handling

- All metrics/lifecycle failures are non-blocking. Pi must exit normally even if metrics fail.
- Use `logger.error`/`logger.warn` and swallow exceptions.
- Discovery/parsing errors return empty descriptors or throw only inside `processSession`, which is already wrapped in try/catch by `performIncrementalSync`.
- Deduplication via `recordId` ensures re-parsing the same session is idempotent.

## 11. Testing

The project testing policy is “tests only on explicit request.” No new tests will be added unless the user asks for them.

Manual verification:

1. Run `codemie pi --task "create a hello.txt file"`.
2. Confirm `<cwd>/.pi/codemie/agent/sessions/<encoded-cwd>/<timestamp>_<id>.jsonl` exists.
3. Confirm `~/.codemie/sessions/{sessionId}_metrics.jsonl` contains deltas.
4. Confirm the backend receives both `codemie_cli_session_total` (started + completed) and `codemie_cli_tool_usage_total` rows.

## 12. Out of scope

- Incremental per-turn sync during the Pi session (future enhancement).
- Conversation log sync (`_conversation.jsonl`); only metrics deltas.
- Modifying the upstream Pi repo or adding native hooks.
- Mapping Pi extensions/skills into CodeMie extension counts.

## 13. References

- Existing Pi plugin design: `docs/superpowers/specs/2026-08-07-codemie-pi-design.md`
- Claude metrics processor: `src/agents/plugins/claude/session/processors/claude.metrics-processor.ts`
- Claude session adapter: `src/agents/plugins/claude/claude.session.ts`
- OpenCode plugin (post-hoc parity pattern): `src/agents/plugins/opencode/opencode.plugin.ts`
- OpenCode session adapter: `src/agents/plugins/opencode/opencode.session.ts`
- Base session adapter interface: `src/agents/core/session/BaseSessionAdapter.ts`
- Base processor interface: `src/agents/core/session/BaseProcessor.ts`
- Metric delta types: `src/agents/core/metrics/types.ts`
- Hook command: `src/cli/commands/hook.ts`
- Metrics sync pipeline: `src/providers/plugins/sso/session/processors/metrics/`
- Pi source: `/home/taras_spashchenko/TS/github/pi/packages/coding-agent/src/core/session-manager.ts`
- Pi session types: `/home/taras_spashchenko/TS/github/pi/packages/agent/src/harness/session/types.ts`

