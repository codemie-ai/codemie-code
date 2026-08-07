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
| `agent_version` | `claude --version` | `env.CODEMIE_CLI_VERSION` (same convention as codemie-claude; Pi's own `--version` is not probed) |
| `codemie_client` | `codemie-claude` | `codemie-pi` |
| `llm_model` | assistant message `model` | assistant entry `model`, fallback `CODEMIE_MODEL` |
| `repository` | git remote / filesystem | existing `CODEMIE_REPOSITORY` / detection |
| `branch` | git branch | existing `CODEMIE_GIT_BRANCH` / detection |
| `session_id` | `CODEMIE_SESSION_ID` | `CODEMIE_SESSION_ID` |
| `session_duration_ms` | SessionEnd − SessionStart timestamps | session record startTime → endTime |
| `active_duration_ms` | `UserPromptSubmit`/`Stop` hooks | first-to-last emitted delta timestamp, merged across every transcript of the run (falls back to unset if no deltas) |
| `status`/`reason` | exit code | `status` is always `'completed'` (set in `hook.ts`); `reason` is `'exit'` on a clean exit, `exit(<code>)` on a non-zero exit, or `signal(<name>)` when Pi was terminated by a signal. The last two forms extend the `"exit"`/`"logout"`/`"clear"` set described for `BaseHookEvent.reason`. |
| `had_errors` | tool errors / API errors | `toolResult.isError` or assistant `errorMessage` |
| `error_tools` | failing tool names | names of tools with `isError: true` |
| `error_messages` | tool error text | tool result error text, scrubbed in two layers. In the delta file, a failing tool listed in `metricsConfig.excludeErrorsFromTools` (`bash` by default) contributes `Tool failed: <toolName>` instead of its raw output (§7.4). Before upload, the shared post-processor replaces the **whole** array with `Excluded tool failed: <tool>` entries whenever any failing tool was excluded — messages are not correlated to tools at that layer, so a mixed failure cannot be scrubbed selectively. `had_errors` stays `true` either way. |
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

MCP and extension counts are intentionally omitted for Pi because Pi does not use CodeMie’s MCP config layout or `.claude/` extension categories. The lifecycle metric is still sent with those fields present as zeros (e.g. `mcp_total_servers: 0`, `agents_project: 0`, `skills_global: 0`) because the shared summary helpers return all-zero objects when no config is declared.

## 5. Architecture and components

### 5.1 New files

```
src/agents/plugins/pi/
├── pi.session.ts                        # PiSessionAdapter + run attribution
├── pi.types.ts                          # Pi v3 JSONL entry/header shapes
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
  - Publish `PI_SESSION_ID` / `PI_CODING_AGENT_SESSION_DIR` in `beforeRun`, inject
    `--session-id` / `--session-dir` in `enrichArgs`, and reconcile session flags in
    `PiPlugin.run()` via `preparePiInvocation` (§9.1)
- `src/agents/plugins/pi/pi.paths.ts` — add `resolvePiSessionDir()` / `getPiSessionDir()`,
  with tilde expansion and project-over-global settings precedence (§7.1).
- `src/agents/core/types.ts` — add `transcript_paths?: string[]` to the hook event, for agents
  that produce several transcripts in one run.
- `src/agents/core/BaseAgentAdapter.ts` — run `onSessionEnd` on signal exits, and always run proxy
  cleanup afterwards even when the hook throws.
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
3. `PiPlugin.run()` reconciles CodeMie's session flags with Pi's (§9.1), then `beforeRun` publishes
   `PI_SESSION_ID` and the resolved `PI_CODING_AGENT_SESSION_DIR` onto the run env, and `enrichArgs`
   appends `--session-id <CODEMIE_SESSION_ID>` and `--session-dir <dir>` to the argv.
4. `BaseAgentAdapter.run()` spawns `pi` with `PI_CODING_AGENT_DIR = <cwd>/.pi/codemie/agent`.
5. Pi writes session entries to `<session-dir>/<timestamp>_<id>.jsonl`, where `<session-dir>` is the
   directory resolved in step 3 — by default `<cwd>/.pi/codemie/agent/sessions/<encoded-cwd>/`.
6. When `pi` exits, `executeOnSessionEnd` calls `PiPlugin.onSessionEnd`. The adapter always runs
   proxy cleanup afterwards, even if the hook throws.
7. `onSessionEnd` attributes the run's Pi transcripts (§7.1) and calls
   `processEvent({ hook_event_name: 'SessionEnd', transcript_path: <first>, transcript_paths: [...], ... })`.
   A run that used `/new` or `/fork` produces more than one; `hook.ts` processes every path, and the
   metrics processor deduplicates by Pi entry id because `/fork` copies history verbatim.
8. `handleSessionEnd` accumulates active duration, runs `performIncrementalSync`, which calls `PiSessionAdapter.processSession`.
9. `PiMetricsProcessor` writes `MetricDelta` records to `~/.codemie/sessions/{sessionId}_metrics.jsonl`.
   Because it is invoked once per transcript, it keeps the run's activity window across calls and
   writes `active_duration_ms` from the merged bounds rather than the last file's span.
10. `syncPendingDataToAPI` runs `SessionSyncer` → `MetricsSyncProcessor` aggregates deltas and sends `codemie_cli_tool_usage_total`.
11. `sendSessionEndMetrics` sends the `completed` lifecycle metric, `updateSessionStatus` closes the session, and files are archived.

## 7. Pi session file parsing

### 7.1 Discovery

- Base directory: `resolvePiSessionDir(cwd, env)`, whose precedence is
  `PI_CODING_AGENT_SESSION_DIR` → `sessionDir` in `<cwd>/.pi/settings.json` → `sessionDir` in
  `<agentDir>/settings.json` → the default `join(getPiAgentDir(cwd), 'sessions')/<encoded-cwd>`.
  This mirrors Pi's own resolution: Pi merges project settings over global settings, and a
  leading `~` is expanded on every channel. The plugin has no argv at this point, so a CLI
  `--session-dir` reaches it as `PI_CODING_AGENT_SESSION_DIR` (see §9.1) rather than as a flag.
- Sub-directory name: Pi encodes the cwd as `--<cwd with leading slash removed and `/`, `\`, `:` replaced by `-`>--`.
- Session file name: ISO-8601 timestamp with `:` and `.` replaced by `-`, e.g. `2026-08-07T11-27-16-523Z_<sessionId>.jsonl`.
- **Collection.** `discoverSessions({ cwd, maxAgeDays: 1, runStartedAt, agentSessionId, env })`
  reads each candidate file's line-1 header and keeps files whose `header.cwd` matches the
  requested cwd and whose mtime is within the age window. Modification time is used for the age
  filter so long-running sessions are not discarded while still open. No `limit` is passed: a run
  can legitimately span several transcripts, and all of them are returned as `transcript_paths`.
- **Attribution.** Candidates are then claimed in order of decreasing certainty. Timing never
  accepts a transcript on its own — it only narrows the set — because a concurrent Pi run in the
  same directory produces files that are indistinguishable by time alone:
  1. *Identity.* The file matching `PI_SESSION_ID` is the run's anchor, resolved the way Pi
     resolves `--session <arg>`: exact session id, then transcript path, then id prefix. Accepted
     regardless of timing, since a `--session` resume appends to a transcript created earlier.
  2. *Lineage.* `/fork` records the parent transcript's absolute path in `header.parentSession`,
     so every transitive descendant of an owned file is claimed. The walk is downward only: the
     anchor's own parent belongs to an earlier run.
  3. *Elimination.* `/new` writes an unlinked header with a fresh id and no parent link, so it
     carries no proof of ownership. Candidates are first pruned by run window, and — only when an
     anchor exists — by having a parent outside the owned set. Without an anchor there is no owned
     set to compare against, and `--continue` may reopen a transcript an earlier run forked, so
     lineage cannot exclude anything there.
- **With an anchor**, a UUIDv4 id identifies another CodeMie-driven Pi run — CodeMie injects v4
  ids while Pi mints v7 — so such candidates are rejected, and their presence is the one
  detectable signal that this directory has more than one writer. When none is present, the
  remaining transcripts can only be this run's own `/new` files and **all** of them are claimed;
  requiring a single survivor would silently drop every `/new` after the first.
- **Without an anchor** (`--continue`, bare `--resume`), or when a concurrent CodeMie run *is*
  detected, one surviving candidate is still unambiguous and is claimed; two or more cannot be
  told apart by time, so a warning is logged and only the provably owned set is returned. The
  UUIDv4 rule is deliberately **not** applied in the no-anchor case: `--continue` appends to a
  transcript an earlier CodeMie run created, so that file legitimately carries a v4 id.

### 7.2 Entry types

Pi session JSONL entries are line-delimited JSON objects. The shipped `pi` CLI writes format **v3** (`CURRENT_SESSION_VERSION = 3` in `packages/coding-agent/src/core/session-manager.ts`). Every file begins with a header line:

```typescript
interface PiSessionHeader {
  type: 'session';
  version?: number;
  id: string;
  timestamp: string; // ISO-8601
  cwd: string;
  parentSession?: string;
}
```

Subsequent lines are entries with an envelope:

```typescript
interface PiEntryBase {
  type: string;          // 'message' | 'model_change' | ...
  id: string;            // 8-hex, collision-checked within the session
  parentId: string | null;
  timestamp: string;     // ISO-8601 at entry level
}

interface PiMessageEntry extends PiEntryBase {
  type: 'message';
  message: PiUserMessage | PiAssistantMessage | PiToolResultMessage | PiBashExecutionMessage;
}

interface PiUserMessage {
  role: 'user';
  content: string | Array<{ type: 'text'; text: string } | unknown>;
  timestamp: number;     // epoch ms
}

interface PiAssistantMessage {
  role: 'assistant';
  content?: Array<
    | { type: 'text'; text?: string }
    | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }
  >;
  model?: string;
  usage?: Record<string, unknown>; // required by Pi but not forwarded to ToolUsageAttributes
  stopReason?: string;
  errorMessage?: string;
  timestamp: number;     // epoch ms
}

interface PiToolResultMessage {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content?: string | Array<{ type: 'text'; text: string } | unknown>;
  details?: Record<string, unknown>;
  isError: boolean;      // required by Pi
  timestamp: number;     // epoch ms
}
```

These interfaces are local to the Pi plugin; Pi is not added as a dependency. The v4 harness format in `packages/agent/src/harness/session/jsonl/types.ts` is **not** used by the shipped CLI.

### 7.3 Matching tool calls to results

- Walk entries in file order.
- For each `assistant` entry, collect every `content` block whose `type === 'toolCall'` and remember them as unmatched calls.
- For each `toolResult` entry, pair it with the most recent preceding *unmatched* assistant tool call whose `toolCall.id` matches `toolResult.toolCallId`, then consume that match.
- A tool call may map to zero results if the session ended prematurely; in that case emit the tool call without `toolStatus`.

`toolCall.id` is intentionally not guaranteed session-unique (Pi passes provider ids through verbatim, e.g. `functions.<tool>:<n>`), so a global last-wins map is unsafe.

### 7.4 Deltas

The metrics processor emits one `MetricDelta` per assistant tool call, plus one per user prompt and one per assistant-level API error. Each delta contains:

- `recordId`: `${entry.id}:${toolCall.id}` (entry ids are collision-checked by Pi, so this is reliably unique)
- `timestamp`: assistant entry timestamp, or session start time if missing
- `tools`: `{ [toolName]: 1 }`
- `toolStatus`: `{ [toolName]: { success, failure } }` (omitted when the call has no matching result)
- `fileOperations`: extracted from matching tool results for non-failing calls
- `models`: `[modelName]` if present, with `CODEMIE_MODEL` fallback
- `userPrompts`: captured from `user` entries. Pi's `/skill:<name>` slash-command inlines the literal `<skill name="…" location="…">` wrapper and the real user prompt in a single text block; the wrapper is stripped and the trailing user text is kept. Slash-command template expansions and extension/SDK-sent user messages carry no persistent provenance marker, so they cannot be filtered and may be counted as human prompts.
- `apiErrorMessage`: assistant `errorMessage`, or tool error text extracted from a failing tool result's `content[]`. For tools listed in `metricsConfig.excludeErrorsFromTools` (`bash` by default), the raw error text is replaced with a generic `Tool failed: <toolName>` placeholder so `had_errors`/`error_tools` remain accurate without exposing the tool's output. This is the **delta-file** wording; see §4 for the different string the shared post-processor puts on the wire.

## 8. File operation extraction

`pi-file-operations.ts` maps Pi tool calls to `FileOperation` records.

| Pi tool name | Operation type | Line-count source |
|---|---|---|
| `write` | `write` | `toolCall.arguments.content` (single trailing newline stripped) |
| `edit` | `edit` | `toolResult.details.diff` or `details.patch` (`+`/`-` lines) |
| `read` | `read` | none |
| `grep` | `grep` | none |
| `ls` | `read` | none |
| `find` | `glob` | none |
| `bash` | _(intentionally unmapped)_ | `bash` mutates files arbitrarily and records no reliable file-effect signal |

There is no tool named `glob`; `glob` is only an optional parameter of `grep`. Extension-registered tools with unknown names are logged at debug level but not mapped.

Paths are read from `toolCall.arguments.path`, `toolCall.arguments.file_path`, or `toolResult.details.path`.
Line-count helpers reuse existing utilities in `src/utils/file-operations.ts` where possible.

**Limitations:** `write` creates or overwrites, and Pi records nothing distinguishing the two, so every write is counted as a creation. File changes performed through `bash` are not tracked.

## 9. Plugin metadata changes

```typescript
export const PiPluginMetadata: AgentMetadata = {
  // ... existing fields ...

  sessionAnalyticsReport: true,

  metricsConfig: {
    excludeErrorsFromTools: ['bash'],
  },

  lifecycle: {
    async beforeRun(env: NodeJS.ProcessEnv, _config: AgentConfig) {
      // ... existing agent-dir / model preparation ...
      // Publishes PI_SESSION_ID (unless argv already selects a session) and the
      // resolved PI_CODING_AGENT_SESSION_DIR onto the run env.
    },
    enrichArgs(args: string[], _config: AgentConfig): string[] {
      // ... existing --provider / --model / --task rewriting ...
      // Injects `--session-id <CODEMIE_SESSION_ID>` and `--session-dir <dir>`.
    },

    async onSessionStart(sessionId: string, env: NodeJS.ProcessEnv) {
      // SessionStart hook
    },

    async onSessionEnd(exitCode: number, env: NodeJS.ProcessEnv) {
      // SessionEnd hook + session discovery; emits transcript_paths[]
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

  // Translates CodeMie's session flags to Pi's and publishes the argv-derived
  // facts that beforeRun (env only) and enrichArgs (no env) cannot read.
  async run(args, envOverrides, runOptions) {
    const prepared = preparePiInvocation(args, envOverrides);
    return super.run(prepared.args, prepared.envOverrides, runOptions);
  }

  // ... additionalInstallation stays ...
}
```

### 9.1 Session-flag reconciliation

Pi's `validateSessionIdFlags` exits with code 1 when `--session-id` is combined with
`--session`, `--continue`/`-c`, or `--resume`/`-r` (`--fork` is allowed). `preparePiInvocation`
therefore, before the run starts:

- Rewrites CodeMie's `--resume <session-id>` to Pi's `--session <session-id>`. Pi's own
  `--resume`/`-r` is a **boolean** that opens an interactive picker, so the id would otherwise
  be left as a bare positional and delivered to the model as a chat message.
- Suppresses the `--session-id` injection whenever argv already selects a session, and records
  that in `CODEMIE_PI_SESSION_SELECTED` so `beforeRun` does not publish a `PI_SESSION_ID` the
  transcript will never carry.
- Publishes `PI_SESSION_ID` from `--session`/`--session-id` when one names a session up front.
  `--continue` and bare `--resume` name none, so those runs correlate by run window instead.
- Publishes a CLI `--session-dir` value as `PI_CODING_AGENT_SESSION_DIR`, since the flag is an
  unknown option to CodeMie's parser and would otherwise be invisible to discovery.

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
- Pi source (v3 session format, authoritative for the shipped CLI): `/home/taras_spashchenko/TS/github/pi/packages/coding-agent/src/core/session-manager.ts`
- Pi message types: `/home/taras_spashchenko/TS/github/pi/packages/ai/src/types.ts`

