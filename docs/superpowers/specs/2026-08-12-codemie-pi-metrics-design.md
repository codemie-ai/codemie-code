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

MCP and extension counts are reported for Pi, but through Pi-specific mappings rather than the `.claude/` layout — see §9.3 for the resource-directory mapping and §9.4 for the MCP one. The `agents_*` and `rules_*` fields stay at zero by design: Pi has neither concept.

## 5. Architecture and components

### 5.1 New files

```
src/agents/plugins/pi/
├── pi.session.ts                        # PiSessionAdapter + transcript listing
├── pi.types.ts                          # Pi v3 JSONL entry/header shapes
├── pi.extension.ts                      # extension materializer + run-ledger reader (§7.1)
├── pi.incremental-sync.ts               # ledger-driven periodic flush (§10.1)
├── extension/
│   ├── index.js                         # the Pi extension itself — loaded by Pi, not by CodeMie
│   ├── package.json                     # declares {"type":"module"} for the materialized copy
│   └── README.md                        # why it exists and the exit(1) constraint
├── session/
│   ├── processors/
│   │   ├── pi.metrics-processor.ts      # Pi → MetricDelta translator
│   │   └── pi.conversations-processor.ts # Pi → conversation history payloads
│   ├── pi-named-invocations.ts          # skill / subagent / command counts
│   └── pi-file-operations.ts            # tool → file op mapping
└── __tests__/                           # regression suite (§11)
```

`extension/` is a **static asset**, not compiled source: `tsc` does not touch `.js` under `src/`, and
`scripts/copy-plugins.js` copies the directory to `dist/` byte-identically, because Pi loads the file
directly and what ships must be what was tested.

Shared, agent-generic additions:

```
src/agents/core/session/stale-session-reconciliation.ts   # extracted from codex (§10.2)
```

### 5.2 Modified files

- `src/agents/plugins/pi/pi.plugin.ts`
  - `metricsConfig: { excludeErrorsFromTools: ['bash'] }`, `sessionAnalyticsReport: true`,
    `mcpConfig` and `extensionsConfig` so the lifecycle metric's MCP/extension counts are populated
  - `lifecycle.onSessionStart` / `onSessionEnd`; `getSessionAdapter()` on `PiPlugin`
  - `beforeRun` materializes the run-ledger extension and publishes `CODEMIE_PI_LEDGER`
  - `onSessionEnd` reads the ledger, correlates the session record to the transcripts the run
    actually produced, and passes them as `transcript_paths` (§7.1)
  - `enrichArgs` injects `--session-id` / `--session-dir`; `PiPlugin.run()` reconciles session flags
    via `preparePiInvocation` (§9.1)
- `src/agents/plugins/pi/pi.paths.ts` — `resolvePiSessionDir()` / `getPiSessionDir()`, with Pi's own
  path normalization and project-over-global settings precedence (§7.1).
- `src/cli/commands/analytics/cost/usage-readers.ts` — a `pi` case, so Pi sessions report tokens and
  cost instead of zeros (§4).
- `src/cli/commands/analytics/{agent-labels.ts, native-loader.ts, report/client/app.js}` — Pi's
  display label and native (unmanaged `pi`) session discovery.
- `src/providers/plugins/sso/session/processors/conversations/syncProcessor.ts` — folder mapping, so
  Pi conversations are not filed under “Claude Desktop”.
- `src/agents/plugins/codex/codex.reconciliation.ts` — reduced to a shim over the extracted shared
  implementation; its existing test suite is the regression guard for the extraction.
- `src/agents/core/types.ts` — `transcript_paths?: string[]` on the hook event, for agents that
  produce several transcripts in one run.
- `src/agents/core/BaseAgentAdapter.ts` — run `onSessionEnd` on signal exits, and always run proxy
  cleanup afterwards even when the hook throws.
- `scripts/copy-plugins.js`, `eslint.config.mjs`, `package.json` — ship and lint the extension asset.
  The blanket `**/*.js` eslint ignore is narrowed for it specifically: it is the one file whose
  syntax error takes down the user's session, so it must not be the one file nothing checks.

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

### 7.1 Run attribution

A run's transcripts are **recorded, not inferred**. A CodeMie extension runs inside Pi and appends
each transcript path to a ledger as Pi opens it; `onSessionEnd` reads the ledger back.

#### Why inference was abandoned

Pi names transcripts itself, writes them lazily, and a single run can produce several (`/new`,
`/fork`, `--session` into another project). Deciding afterwards which files belong to the run just
launched is guesswork: a concurrent `pi` — or a second CodeMie run in the same cwd — produces files
indistinguishable by id, mtime, or `parentSession` lineage.

Successive rounds of heuristics were tried here and each was shown to be reachable-wrong: identity
anchors (defeated by Pi writing nothing until the first assistant message), fork lineage (defeated
by a foreign fork of an owned file), uuidv4-vs-uuidv7 provenance (proves a concurrent *CodeMie* run,
not a bare `pi`), run-window timing (defeated by any second writer), and a shared-directory test
(the per-cwd default is shared by every CodeMie run in that directory). The failure mode is not lost
metrics but **uploading another process's prompts and tool output under this user's session**, which
is strictly worse than reporting nothing. The problem is not a buggy implementation; it is a
question a directory listing cannot answer.

#### The extension

`src/agents/plugins/pi/extension/` ships `index.js` and a `package.json` declaring
`{"type":"module"}`. `beforeRun` copies both into `<piAgentDir>/extensions/codemie-metrics/`, which
is one of Pi's own discovery roots (`core/resource-loader.ts:814`), so **no argv is modified** —
avoiding the failure mode where a stale `--extension` path makes Pi exit.

The directory layout matters: Pi's `isExtensionFile` accepts only `.ts` and `.js`
(`core/extensions/loader.ts:597-599`), and a bare `.js` would inherit its module system from
whatever `package.json` happens to sit above it on the user's disk, where a CommonJS context makes
`export default` a syntax error. A directory with its own `package.json` removes the ambiguity for
both Pi's jiti loader and CodeMie's self-test.

**The load hazard governs the whole design.** Any extension load failure makes Pi call
`process.exit(1)` in every mode (`main.ts:893-899`), killing the user's coding session — far worse
than collecting nothing. So the asset imports only node builtins, wraps its factory and every
handler in `try/catch`, never subscribes to `tool_call` (a throwing `tool_call` handler blocks the
tool), returns `undefined` from every handler so the `input` handler cannot alter what the user
typed, and records only parsed command *names* — never prompt or argument text. On top of that,
`ensurePiCodeMieExtension` performs a pre-flight `import()` of the materialized copy and **deletes
it** unless it exports a function, so a corrupted asset degrades to "no metrics" rather than "no
session". `CODEMIE_PI_EXTENSION_DISABLED=1` disables it and removes any installed copy.

#### The ledger

`~/.codemie/sessions/<CODEMIE_SESSION_ID>_pi-run.jsonl`, append-only, one JSON object per line. The
path is passed in as `CODEMIE_PI_LEDGER`, so the asset holds no assumptions about CodeMie's layout.
The `.jsonl` suffix keeps it clear of every consumer that enumerates session records, all of which
filter on `.json`.

| `t` | Fields |
|---|---|
| `boot` | `pid` |
| `session` | `reason`, `file`, `piSessionId`, `cwd`, `prevFile`, `mode` |
| `cmd` | `kind` (`skill` \| `prompt`), `name` |
| `shutdown` | `reason`, `file`, `target`, `piSessionId`, `cwd`, `mode` |

`cwd` is `sessionManager.getCwd()` — the *transcript's* cwd, which is what `--session <path>` runs
under, not the wrapper's launch directory. `file` may name a path Pi has not written yet, because
`_persist` only flushes once the session holds an assistant message, so `readPiRunLedger`
existence-filters. Malformed lines are skipped individually, so a truncated final line after a hard
kill does not discard the records before it.

`cmd` records exist because slash commands are the one signal the transcript cannot carry: Pi
expands a prompt template into plain user text before persisting it, so `/review` is gone by the
time the entry is written.

#### What `onSessionEnd` does with it

- `transcript_paths` ← `ledger.transcripts`; nothing outside the ledger is ever claimed.
- `correlation.agentSessionFile` ← `ledger.primaryTranscript`. This was previously left empty, which
  made the analytics cost path resolve no native log at all and report a missing token reader.
- `correlation.agentSessionId` ← `ledger.piSessionId`, so the wire `session_id` is Pi's id.
- `workingDirectory` / `gitBranch` / `repository` are re-derived when `ledger.cwd` differs from the
  launch cwd.
- An ownership sidecar marker is written per transcript.

**With no ledger** — the extension did not run, or the process was `SIGKILL`ed before it wrote —
the run reports its lifecycle metric and *nothing else*, with an explicit warning. There is no
fallback to inference, by design.

#### What discovery still does

`discoverSessions()` is now a plain listing: every `.jsonl` in the resolved session directory whose
header declares this cwd and whose mtime is inside the age window, newest first. It answers "which
Pi transcripts exist here" and is used only by the analytics surface. It has no notion of "this
run", and `src/agents/plugins/pi/__tests__/pi.discovery.test.ts` contains explicit regression guards
that fail if attribution logic is reintroduced.

Session directory resolution is unchanged: `resolvePiSessionDir(cwd, env)` with precedence
`PI_CODING_AGENT_SESSION_DIR` → `sessionDir` in `<cwd>/.pi/settings.json` → `sessionDir` in
`<agentDir>/settings.json` → the default per-cwd directory, with Pi's own path normalization
(Windows shell paths, `~`, `file://`) applied on every channel.

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

  // `--task` becomes Pi's `-p`, the same declarative mapping claude and gemini use.
  // See §9.2.
  flagMappings: {
    '--task': { type: 'flag', target: '-p' },
  },

  // Pi's resource directories are named differently from the scanner's defaults.
  // See §9.3.
  extensionsConfig: {
    project: '.pi',
    global: '~/.pi/agent',
    skillsEntryFile: 'SKILL.md',
    dirNames: {
      agents: [], commands: ['prompts'], skills: ['skills'],
      hooks: ['extensions'], rules: [],
    },
  },

  // MCP reaches Pi via the `pi-mcp-adapter` package, which CodeMie always installs.
  // Six adapter sources folded into three scopes. See §9.4.
  mcpConfig: {
    local: { path: '.pi/mcp.json', jsonPath: 'mcpServers' },
    project: { path: '.mcp.json', jsonPath: 'mcpServers' },
    user: {
      // Not `~/.pi/agent/mcp.json`: a CodeMie run never reads it. See §9.4.
      path: [
        '.pi/codemie/agent/mcp.json',
        '~/.agents/mcp/mcp.json', '~/.agents/mcp.json', '~/.config/mcp/mcp.json',
      ],
      jsonPath: 'mcpServers',
    },
  },

  lifecycle: {
    async beforeRun(env: NodeJS.ProcessEnv, _config: AgentConfig) {
      // ... existing agent-dir / model preparation ...
      // Publishes PI_SESSION_ID (unless argv already selects a session) and the
      // resolved PI_CODING_AGENT_SESSION_DIR onto the run env.
    },
    enrichArgs(args: string[], _config: AgentConfig): string[] {
      // ... existing --provider / --model injection ...
      // Injects `--session-id <CODEMIE_SESSION_ID>` and `--session-dir <dir>`.
      // Deliberately does NOT touch --task; see §9.2.
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
`--session`, `--continue`/`-c`, or `--resume`/`-r` (`--fork` is allowed). Two places cooperate:

`preparePiInvocation`, before the run starts:

- Rewrites CodeMie's `--resume <session-id>` to Pi's `--session <session-id>`. Pi's own
  `--resume`/`-r` is a **boolean** that opens an interactive picker, so the id would otherwise
  be left as a bare positional and delivered to the model as a chat message. When argv already
  carries `--session`, the pair is dropped rather than rewritten, so the orphaned id cannot leak
  into the conversation.
- Publishes a CLI `--session-dir` value as `PI_CODING_AGENT_SESSION_DIR`, since the flag is an
  unknown option to CodeMie's parser and would otherwise be invisible to discovery.

`enrichArgs` then suppresses the `--session-id` injection whenever argv already selects a session.

Nothing here needs to be exact any more. Under the ledger (§7.1) argv is no longer evidence about
which transcript a run produced — the extension reports that from inside Pi — so a mis-detected
session flag costs at most a suppressed `--session-id`, not a mis-attributed transcript. The
pre-ledger `PI_SESSION_ID` publication and its `CODEMIE_PI_SESSION_SELECTED` companion were
deleted along with the window-attribution code that consumed them.

### 9.2 `--task` → `-p`

CodeMie's `--task <prompt>` means "run one task non-interactively" (`AgentCLI.ts` sets
`isNonInteractiveMode` from it). Pi expresses that as `--print`/`-p`, *"process prompt and exit"*
(`cli/args.ts:142`), which `resolveAppMode` turns into print mode (`main.ts:125`).

The mapping is declarative, matching claude and gemini, and `enrichArgs` deliberately leaves
`--task` alone so `transformFlags` can see it — `BaseAgentAdapter` applies `flagMappings` *after*
the `enrichArgs` hook. Pi's `-p` adopts the argument that follows it as the prompt, so the pair
must stay adjacent; `--session-id`/`--session-dir` are appended after it and do not intervene.

The bug this replaced: `enrichArgs` used to consume `--task` and re-append its value as a trailing
**positional**. Pi reads a bare positional as an *interactive* session with an opening prompt, so
`codemie pi --task "…"` opened the TUI and never exited, which blocked every non-interactive use
and all smoke testing.

Known limit, shared with the other agents: a prompt beginning with a single `-` or `--` is not
adopted by `-p` (only a `---` prefix is), and falls through to Pi's parser as an unknown option.

### 9.3 Extension/resource counting

Pi names its resource directories differently from `extensions-scan`'s defaults, so every
`skills_*`/`commands_*`/`hooks_*` lifecycle field reported zero until `extensionsConfig` existed.
The mapping is `commands → prompts/` (flat `.md`, Pi's slash-command equivalent) and
`hooks → extensions/` (`.ts`/`.js`, Pi's in-process hooks); `skills/` already matches the default
directory-per-skill `SKILL.md` layout.

`agents` and `rules` are set to empty arrays — Pi has neither concept, and an empty array holds the
category at zero instead of scanning a directory Pi never reads. (An *explicitly undefined* entry
would throw inside the scanner and silently zero all ten counts, so the arrays must be empty, not
absent.)

`global` is the user's own `~/.pi/agent`, not the agent dir CodeMie redirects Pi to
(`<cwd>/.pi/codemie/agent`). That dir is a copy of the user's plus CodeMie's own metrics extension,
so counting it would report our plumbing as a user-authored hook for every user.

### 9.4 MCP counting

An earlier draft of this document asserted that Pi has no MCP support and that omitting `mcpConfig`
was therefore correct. That was wrong, and it came from grepping the upstream clone at
`~/TS/github/pi`, which is older than the installed package.

The accurate statement is narrower: MCP is not part of Pi **core** — Pi's own `docs/usage.md` says
it "intentionally does not include built-in MCP" — but MCP arrives through the `pi-mcp-adapter`
package, and CodeMie installs that package for every managed Pi (`REQUIRED_PI_PACKAGES` in
`pi.packages.ts`). For the population this metric measures, the adapter is effectively core, so
`mcp_total_servers: 0` was a guaranteed-wrong constant rather than an accurate zero.

The adapter merges six files, lowest precedence first:

| Adapter precedence | Adapter source | Path | CodeMie scope |
|---|---|---|---|
| 1 (lowest) | `shared-global` | `~/.config/mcp/mcp.json` | `user`, candidate 4 |
| 2 | `agents-global` | `~/.agents/mcp.json` | `user`, candidate 3 |
| 3 | `agents-nested-global` | `~/.agents/mcp/mcp.json` | `user`, candidate 2 |
| 4 | `pi-global` | `<agentDir>/mcp.json` | `user`, candidate 1 |
| 5 | `shared-project` | `<cwd>/.mcp.json` | `project` |
| 6 (highest) | `pi-project` | `<cwd>/.pi/mcp.json` | `local` |

The key is `mcpServers` in every file. Three CodeMie scopes cannot hold six sources, so the two
project files map one-to-one and the four global ones become ordered candidates, ordered by adapter
precedence **descending** so the file CodeMie reads is the one that would have won the merge. Note
that `readMCPFromSource` returns on the first candidate that **parses** — it never merges, and a
file that parses without an `mcpServers` key ends the search at zero.

`<agentDir>` is not fixed: the adapter resolves it through `PI_CODING_AGENT_DIR`, which `beforeRun`
always sets to `<cwd>/.pi/codemie/agent`. That copy — not `~/.pi/agent` — is the file a
CodeMie-launched Pi actually reads.

**`~/.pi/agent/mcp.json` is deliberately not a candidate**, and an earlier draft of this section had
it wrong. Because `PI_CODING_AGENT_DIR` is set unconditionally, the user's own Pi home is never one
of the adapter's six sources under CodeMie. Listing it as a "first run" fallback looked harmless but
was not: `readMCPFromSource` cannot distinguish "first run" from "copy exists but has no
`mcp.json`", and `preparePiAgentDir` returns early forever once the copy exists (`pi.setup.ts`), so
the second state is **permanent** for a project — while the home file keeps growing, because a bare
`pi` writes precisely there. The metric would then name servers the run cannot load, and the
unconditional return would additionally hide `~/.agents/*` and `~/.config/mcp`, which the adapter
genuinely does merge. Wrong in both directions at once, and worse than the constant zero it
replaced.

Dropping it buys a clean invariant: **every server reported is one the run actually loads.**

This is the opposite call from `extensionsConfig.global` (§9.3), which avoids the copy precisely
because CodeMie injects its own extension into it. Nothing injects MCP servers, so for MCP the copy
is simply the truth.

The declaration is an approximation otherwise, and the biases are known:

- **Under-counts the first run in a project**, which reports zero user servers: the copy is made in
  `beforeRun`, and `onSessionStart` — where `getMCPConfigSummary` runs — precedes it
  (`BaseAgentAdapter.ts:548` before `:584`). Self-healing from the second run on, and an
  under-count is the failure direction to prefer.
- **Over-counts** a server named in two scopes — the adapter merges those into one live server,
  while `totalServers` sums the scopes (`serverNames` stays deduplicated).
- **Under-counts** every global file after the first that parses, the legacy `mcp-servers` alias
  key, and any config written as true JSONC (the adapter strips comments before parsing;
  `readJsonFile` does not).
- **Under-counts** host-config imports — `hostConfigDiscovery: "on"` or a per-file `"imports"`
  array pull servers from Claude/Codex/Cursor/VS Code files. Following a key into other files with
  other key names is beyond `navigateJsonPath`. Both mechanisms are opt-in and default off.

Every one of these fails silently, which is why `pi.mcp-config.test.ts` writes real config files on
disk rather than asserting on the declaration shape.

## 10. Error handling

- All metrics/lifecycle failures are non-blocking. Pi must exit normally even if metrics fail.
- Use `logger.error`/`logger.warn` and swallow exceptions.
- Discovery/parsing errors return empty descriptors or throw only inside `processSession`, which is already wrapped in try/catch by `performIncrementalSync`.
- Deduplication via `recordId` ensures re-parsing the same session is idempotent.

## 11. Testing

The project's default policy is “tests only on explicit request.” The user explicitly authorized a
regression suite for this work, so one exists — the earlier revision of this document recorded zero
coverage, which is why the same class of attribution defect kept recurring across review rounds.

Unit tests live beside the code under `src/agents/plugins/pi/__tests__/` and run in the `unit`
vitest project. The load-bearing ones:

- `pi.extension-asset.test.ts` — drives the real `extension/index.js` against a fake Pi API and
  asserts the safety invariants: exports a factory, no side effects on import, subscribes to exactly
  three events and never `tool_call`, every handler returns `undefined`, argument text never reaches
  the ledger, and hostile contexts / unwritable ledgers are swallowed rather than propagated.
- `pi.run-ledger.test.ts` — installation, idempotence, repair of a modified asset, removal on
  self-test failure (four ways an asset can be bad), the kill switch, and the ledger reader's
  handling of missing files, malformed lines, and a truncated final line.
- `pi.discovery.test.ts` — the listing behaviour, plus explicit **regression guards** asserting that
  discovery performs no run attribution. These fail if identity, timing, uuid-version, or lineage
  filtering is reintroduced.

### 11.1 End-to-end verification against the real `pi` binary

Run against `pi` 0.84.1 in a scratch git repo, with the extension installed exactly as `beforeRun`
materializes it and a local mock OpenAI-completions server standing in for the model, so full turns
complete offline. Results:

| Scenario | Result |
|---|---|
| `-p` run: ledger has `boot`/`session`/`shutdown`, pi exits 0 | pass — `mode:"print"`, `file` matches the transcript on disk |
| **Two concurrent runs, same cwd** | **pass — zero ledger overlap.** The acceptance test |
| `--fork`: ledger records only the fork's own transcript | pass (fork replays 6 of the parent's 7 entries) |
| Fork billing under a shared `seen` set | pass — parent 14, fork 14, total 28; standalone the fork reads 28 alone |
| `--continue` | pass — exit 0, one transcript |
| `-ne` (`--no-extensions`) | pass — no ledger written |
| `--no-session` | pass — ledger written with `file:null`; the reader claims nothing |
| Corrupted asset | **Pi exits 1 and refuses to start**, confirming the `exit(1)` hazard is real and the pre-flight self-test is load-bearing |
| `--session-id` alongside `-p` | pass — accepted, not rejected |
| Prompt template `/greet` | ledger records `{kind:"prompt",name:"greet"}`; the literal `/greet` appears **0 times** in the transcript, confirming the ledger is its only record |
| `/skill:tidy please` | ledger records `{kind:"skill",name:"tidy"}`; the argument text `please` never reaches the ledger |
| Hook pipeline over the real transcript | emits `models`, `userPrompts`, and `tools:{bash:1}` with `toolStatus` |
| Token extraction | `input:7, output:3, cacheRead:4, total:14` from `prompt_tokens:11` + `cached_tokens:4` — Pi pre-subtracts, so the reader's **pass-through** mapping is correct; subtracting again would undercount |

Not covered by the above, still requiring a human:

1. A TUI session with `/new`, `/fork` and Ctrl-C — print mode cannot exercise the interactive paths.
2. Backend receipt of `codemie_cli_session_total` (started + completed) and
   `codemie_cli_tool_usage_total`, and conversation sync landing under folder `pi`. These need a
   valid CodeMie SSO session; uploads above were pointed at an unreachable host by design.

## 12. Out of scope

- Modifying the upstream Pi repo. (Pi's extension API is *used*, not changed.)
- Re-implementing Pi's argument parser to detect session flags in value positions (see §9.1). This
  previously mattered because a misparse could publish a wrong session identity; with `PI_SESSION_ID`
  publication removed, a misparse can now only suppress `--session-id` injection, which is safe.
- Keying `PiMetricsProcessor`'s cross-transcript state (`seenEntryIds`, the activity window) by
  session id. The processor lives on the registry's singleton plugin, so the state would leak if one
  process ever ran the metrics pipeline for two CodeMie sessions. **Revisit if the incremental-sync
  timer is extended to more than one session per process** — the earlier justification rested on
  `onSessionEnd` firing exactly once, which a periodic flush weakens.

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

