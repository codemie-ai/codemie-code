# OTLP Hook-Event Plugin Pattern (`OtlpAgentAdapter`)

**Scope**: any plugin extending the abstract `OtlpAgentAdapter` (`src/agents/core/OtlpAgentAdapter.ts`), under `src/agents/plugins/<name>/`. Today that's `claude-code-otlp` only.
**Status**: Living doc — update when the dispatch pattern changes or a second adapter lands.

## 1. What this pattern is

An `OtlpAgentAdapter` is not a chat agent. It's the ingestion point for one coding tool's native hook/event surface, turned into CodeMie's analytics pipeline (session summaries, usage, auth gating). `OtlpAgentAdapter<TInput, TBlockOutput>` is an abstract base class: it owns the fixed `processOtlpEvent` flow and resolves agent-independent common fields at hook time; each adapter supplies only the tool-specific parts.

```ts
export abstract class OtlpAgentAdapter<TInput, TBlockOutput = Record<string, unknown>> {
  abstract readonly name: string;
  readonly type = AgentAdapterType.OTLP;
  async processOtlpEvent(raw: string, deps: OtlpAdapterDeps): Promise<void>; // fixed flow

  protected abstract parseHookInput(raw: string): TInput | null;   // null => ignore
  protected abstract extractHookContext(input: TInput): OtlpHookContext;    // { cwd, prompt? }
  protected abstract isTracked(input: TInput): Promise<boolean>;   // allowlist gate
  protected abstract evaluate(input: TInput): Promise<ForwardDecision<TBlockOutput>>;
  protected abstract resolveAgentFields(): Promise<Record<string, unknown>>;
  protected abstract resolveEventType(event: Record<string, unknown>): string;  // `type` of a native event
}

export interface OtlpAdapterDeps {
  ensureOtlpProxy: (agentName: string) => Promise<void>;
  // Sends one hook invocation's events as a single batch; true only for a 2xx response.
  forwardOtlpEventsToSpool: (events: Record<string, unknown>[], agentName: string) => Promise<boolean>;
}

export interface OtlpHookSpoolData {
  agentName: string;
  hookEvent: string; // the complete event (serialized), built at hook time
}
```

Spool forwarding is injected through `OtlpAdapterDeps` (supplied by `hook.ts`) rather than imported, so `core/` has no upward imports and the base class is testable with plain fakes.

Everything downstream of `processOtlpEvent` — spool, forwarder, analytics API — is already agent-agnostic and shared. Nothing in it is specific to any one tool's hook names or payload shape; that lives entirely inside each adapter.

## 2. Pipeline

```
<tool>'s native hook/event fires (agent-specific names/payload)
        │ JSON on stdin
        ▼
codemie hook --agent <adapter-name>        (src/cli/commands/hook.ts)
        │ looks up adapter via AgentRegistry.getAnalyticsAgent(name)
        ▼
OtlpAgentAdapter.processOtlpEvent(rawEvent, deps)   (base class, fixed flow)
        │ parseHookInput → isTracked → ensureOtlpProxy
        ▼
evaluate(input) → ForwardDecision          (§3: shape every adapter follows)
        │
   ┌────┴─────┐
 block       forward
   │           │
 log +     every record built: type, truncation, common +
 suppress  agent + context fields, schema_version, event_id
 (adapter-     │ one batch POST for the whole invocation
  specific)    ▼
         proxy daemon spool (one line per event, OtlpHookSpoolData { agentName, hookEvent }) - stores as is
                                                        │
                                                        ▼
                                  otlp-spool/forwarder.ts (background, transport only)
                                                        │
                                                        ▼
                                              CodeMie analytics API
```

- `forwardOtlpEventsToSpool` (`src/agents/plugins/utils.ts`) is shared: POSTs `{ agentName, hookEvents }` (every record from this one invocation) to the local proxy daemon's `/v1/analytics/hooks` in a single request (3s abort), and returns a boolean — `true` only for a 2xx response — instead of swallowing the outcome. Never throws. A dead daemon or a non-2xx response makes it return `false`; a handler with a cursor (§3.4) only commits that cursor when it sees `true`, so a failed send never advances past events that never left the hook process.
- **The daemon appends the whole batch as one spool write** (`otlp.plugin.ts`'s `handleHooks`): one hook invocation is single-session, so events without a `session_id` are discarded individually and a batch mixing more than one non-empty `session_id` is rejected whole (400). It answers **500** when the spool write itself fails, and 202 only once the batch is durable — the honest half of the all-or-nothing contract `forwardOtlpEventsToSpool` depends on.
- **The forwarder is transport only** (`otlp-spool/forwarder.ts`). It unwraps the spool envelope (still one line per event, `OtlpHookSpoolData`), POSTs `hookEvent` byte for byte, advances the cursor, and retries on 401/403. It does no context resolution and no event enrichment, and never calls into any adapter. It owns only `baseUrl` (from daemon state) and the credentials. The one thing it reads from an event is `type === 'agent.session.end'`, to call `markSessionEnded`.
- **The event is built by the base class at hook time** (`buildEvent`), because the forwarder runs in a long-lived daemon whose env (cwd, active profile, credentials, CLI version) is frozen at spawn. Per record, in order: `type` (an explicit `type` on the record wins, otherwise the adapter's `resolveEventType`), truncation (`prompt` to 200 chars, `tool_input` / `tool_response` / `error` to 300; a nested `raw` is dropped), `prompt_body`, `session_id` coerced to a string, `cwd` (always the hook's cwd, also for transcript-derived events), `schema_version: 2`, a fresh `event_id`, and `timestamp`. The event's own `raw` field mirrors the full enriched event, so the top level and `raw` carry the same fields.
- **Timestamp**: the event's own valid timestamp (e.g. the transcript line time on `agent.usage.request`), else one `new Date()` captured per hook invocation. It is persisted inside the spool line, so every retry re-sends the same bytes.
- **Field resolvers live in `src/agents/core/event-fields/`** (`repo-fields.ts`, `identity-fields.ts`, `env-fields.ts`), one async function per field family, each returning a flat record and `''` per field on failure (never throws). Import the files directly, not through a barrel: `codemie hook` is a fresh process per event, so a barrel would load resolvers the event does not need. The base class composes the *common* ones (below) into every event; an adapter composes *opt-in* ones (`resolveEnvFields`, `resolveIdentityCandidateFields`, `resolveGitHeadFields`, `resolveGitCommitFields`, and the sync `parsePromptFields` from `core/ticket-parser.ts` for `agent.prompt.submit`) only into the events that want them, in that event's handler, with the hook payload spread first so it cannot override a resolved value. `resolveGitHeadFields(ctx, 'end')`/`resolveGitCommitFields` back `agent.git.snapshot` (`SessionEnd`, see §6). This shared directory stays agent-agnostic (no tool's own payload shape leaks into it); an adapter that needs resolvers tied to *its own* tool's hook/payload shapes keeps those in its own plugin directory instead — see `claude-code-otlp/event-fields/` in §6 for the Claude-specific example — never in this shared one. A `build*Event()` for a non-transcript-derived synthetic event (`agent.session.env`, `agent.git.snapshot`) is *not* a field resolver and does not live here either — see the note on `claude-code-otlp.plugin.ts` in §6.
- **Common fields resolved by the base class at hook time**: `git_branch` (`detectGitBranch`), `repo_remote` (`detectGitRemoteRepo`), and `story_id` / `story_source` (`core/story-resolver.ts`, priority explicit env/config file -> marker -> branch -> mention; marker and mention only when `extractHookContext` supplies a `prompt`). Merge rule: a record's own non-empty string value wins, otherwise the resolved common value; `''` / `undefined` never clobber. `resolveAgentFields()` overrides everything (platform, version, entrypoint, …).
- **Identity fields resolved by the base class at hook time** (part of the common fields, stamped over the event), once per invocation for the hook's `cwd`: `user_email` (claims of the SSO credentials), `developer_name` / `identity_source` (`core/identity-resolver.ts`: jwt -> git -> codemie_cli -> os), `codemie_project_name` (`ConfigLoader.load(cwd, { name: activeProfile })`), `codemie_cli_version` (`getCurrentCliVersion()`, i.e. the package running the hook). A failed resolution yields empty strings, never a dropped event.
- **Credentials (SSO only)**: `core/hook-credentials.ts` (`resolveHookCredentials`) reproduces the daemon's choice from daemon state: the credentials stored for `syncCodeMieUrl`, else for `targetUrl` (`SSOProxy`'s `syncCredentials || credentials`). The OTLP daemon is spawned without `--auth-method`, so it always runs as `sso`. JWT is not supported in this flow: a JWT profile gets no credentials in the hook, so identity falls through to git, codemie_cli and os (`identity_source` records the winner). Reading stored credentials clears expired SSO ones, as at daemon start.
- **Story granularity**: each hook subprocess resolves independently. A `Stop` after a prompt containing `story: ABC-1` gets the explicit / branch story, not the marker story. Carrying it across a session would need per-session state.
- **Known limitations**: (1) the explicit story tier reads `<cwd>/.claude/analytics.local.json` by default (Claude-flavoured); `resolveStoryFor` takes `explicitConfigPath` so another adapter can override it. (2) The block path prints `JSON.stringify(decision)` to stdout, which is Claude Code's hook protocol; a tool with a different block protocol must make that step overridable (e.g. an `emitBlock()` method).
- **Rollout**: the daemon outlives CLI upgrades. An old daemon recomputes `story_id`, `story_source` and `repo_remote` from its own env and overwrites the hook's values until restarted (`git_branch` is kept). Restart the proxy daemon after upgrading.
- **Known limitations**: (1) the explicit story tier reads `<cwd>/.claude/analytics.local.json` by default (Claude-flavoured); `resolveStoryFor` takes `explicitConfigPath` so another adapter can override it. (2) The block path prints `JSON.stringify(decision)` to stdout, which is Claude Code's hook protocol; a tool with a different block protocol must make that step overridable (e.g. an `emitBlock()` method). (3) The hook `cwd` may be a subdirectory of the project; `getActiveProfileName(cwd)` only checks `<cwd>/.codemie` and then the global config, so project name and profile can then come from the global profile (same as `ensureOtlpProxy`).
- **Rollout**: the daemon outlives CLI upgrades. Restart the proxy daemon after upgrading. Old-format spool lines and a stale daemon are not handled and produce bad events. For a clean run, stop the daemon and delete `getCodemiePath('proxy', 'otlp-spool')` before the first hook.
- Wiring which native hooks/events call `codemie hook --agent <adapter-name>` is entirely tool-specific — see §6 for the Claude Code connector; a different tool has its own.

## 3. The dispatch pattern every `evaluate()` follows

`ForwardDecision<TBlockOutput>` is a shared generic type exported from `OtlpAgentAdapter.ts`; the adapter binds `TBlockOutput` to its tool's block output (Claude: `UserPromptSubmitHookSpecificOutput`, aliased as `ClaudeForwardDecision`). `evaluate(input)` receives the already-parsed, typed `TInput`; the dispatch convention below is how adapters implement it.

### 3.1 Two outcomes — forward or block

```ts
export type ForwardDecision<TBlockOutput = Record<string, unknown>> =
  | {
      decision: 'forward';
      payload: Record<string, unknown>[];
      retryOnce?: boolean;                        // resend once more if the first send failed
      finalize?: (accepted: boolean) => Promise<void>;  // commit-after-send; see below
    }
  | { decision: 'block'; reason: string; hookSpecificOutput: TBlockOutput };
```

`forward` carries the full list of records to push to the spool (the original parsed event, plus zero or more derived analytics events). `block` stops the hook and logs a reason; any extra fields on `block` (`claude-code-otlp` uses `hookSpecificOutput`, mirroring Claude Code's own hook-output JSON schema) are specific to that tool's blocking mechanism, not to this pattern — a different tool may have no `block` case at all, or a differently-shaped one.

`finalize` and `retryOnce` exist for a handler that owns a cursor into some external log (`claude-code-otlp`'s transcript offsets) and must not advance that cursor until the batch it derived from is actually durable. A handler with nothing to commit (the raw-passthrough fallthrough, a `block` decision) simply omits `finalize`. See §3.4 for the commit-after-send contract this enables.

### 3.2 One handler per event name — no `switch`, no shared merge step

```ts
protected async evaluate(parsed: TInput): Promise<ForwardDecision<TBlockOutput>> {
  // early-return / continuation-key checks here are tool-specific — only add
  // one if this tool's events need it (claude-code-otlp keys continuation on
  // its own 'session_id' field; a different tool may have no such field)

  const nativeEventName = readString(parsed, /* this tool's own event-name field */ 'event_name');
  if (nativeEventName === 'SomeEvent') {
    return await this.onSomeEvent(parsed);
  }
  // ...one `if` per handled event name...

  return { decision: 'forward', payload: [parsed] };
}
```

Each handler returns its own full `ForwardDecision`. The trailing fallthrough return is only for event names `evaluate()` doesn't branch on at all — it's not a sink that handled branches route through.

### 3.3 One parsed object, read directly — no typed projection

`parsed` is read directly by handlers (via small helpers like `readString`/`readOptionalString`) and forwarded as-is; there's no typed/camelCase projection layer, since for a handful of fields that adds a type to check against with no runtime-validation benefit.

### 3.4 One place writes to the spool, and a batch is all-or-nothing

The base class's `processOtlpEvent` is the only call site of `deps.forwardOtlpEventsToSpool`: after `evaluate()` resolves it computes the common (git, story, identity, project, version) and agent fields once (in parallel), builds the event for every `payload` record, then sends the whole invocation as **one batch** in **one request**. `forwardOtlpEventsToSpool` never throws, aborts after 3s, and returns a boolean (true only for a 2xx response); on `false` with `decision.retryOnce` set, the base class resends the same already-built events once more (same `event_id`s — never rebuilt) before giving up. The block path is unchanged: it prints the decision and returns before any enrichment. Handlers never forward anything themselves, so every event reaches the spool exactly once per attempt, in order, under the adapter's registered name.

**Commit-after-send.** A handler whose `ForwardDecision` carries a `finalize` is holding a resource (`claude-code-otlp`: the per-session parse-state lock, with its derived-but-not-yet-saved state) that must only be committed once the send is known to have landed. `processOtlpEvent` calls `finalize(accepted)` exactly once, in a `finally`, after the send attempt(s) — `accepted` is the boolean `forwardOtlpEventsToSpool` returned (after any retry). A handler's own `finalize` typically persists its state when `accepted` is true and always releases its lock, so a failed send leaves everything exactly as it was: the next hook re-derives and re-sends the same events from whatever log it reads (a transcript, for `claude-code-otlp`), with no separate retry queue needed. An empty `payload` skips straight to `finalize(true)` without resolving context or sending anything — there is nothing to lose, so no need to pay for git/identity/story resolution.

### 3.5 Proxy readiness is the adapter's own responsibility

The base flow calls `isTracked()` (abstract) before `deps.ensureOtlpProxy()`, so a subclass cannot skip the allowlist gate (the INVARIANT comment in the base flow). Past that, `ensureOtlpProxy()` runs for every event regardless of which handler runs (every `forward` decision needs the daemon up to reach the spool). Further gates (e.g. an auth check) remain the adapter's own decision. It additionally gates an SSO auth check inside `onUserPromptSubmit` only, because that's the one handler whose job is to enforce it. A different tool may not need a tracked-project concept at all, may not need proxy readiness for every event, or may need a different gate entirely — don't carry `claude-code-otlp`'s specific gating choices into a new adapter, just the principle that each adapter decides this for itself.

## 4. Adding a new event to an existing adapter

1. Write one handler method, `(input) => Promise<ForwardDecision<TBlockOutput>>`.
2. Add exactly one `if` branch in `evaluate()` dispatching to it. No `switch`, don't touch the trailing fallthrough.
3. Never forward from inside the handler — return the `ForwardDecision`; the base class's `processOtlpEvent()` sends it.
4. Add a test for the new branch, following the adapter's existing test structure.
5. Update that adapter's own event-surface table/notes (see §6 for the current example).

## 5. Adding a new `OtlpAgentAdapter` for a different tool

1. Create `src/agents/plugins/<new-adapter-name>/` with a class `extends OtlpAgentAdapter<TInput, TBlockOutput>` and implement `parseHookInput`, `extractHookContext`, `isTracked`, `evaluate` (following §3), `resolveAgentFields` and `resolveEventType` (the `type` for a native event without an explicit one). Agent-owned common fields (platform, version, entrypoint, …) go in `resolveAgentFields()`, resolved **inside the adapter's own hook-time process**, not via a callback from the forwarder — the forwarder runs in the long-lived proxy daemon, a different process from the short-lived `codemie hook --agent <name>` CLI invocation, so resolving state there would reflect the daemon's environment. Git branch/remote, story, identity, project name and CLI version are already resolved by the base class. If resolving a field is expensive (subprocess spawn, network call), back it with a small file cache under `getCodemiePath()` — the hook-time process is fresh per event, so in-memory memoization buys nothing (see `client-version-cache.ts`).
2. Register it in `AgentRegistry` (`src/agents/registry.ts`) under its own `name` — same name the base class passes to `forwardOtlpEventsToSpool(events, name)` and matched by `AgentRegistry.getAnalyticsAgent(name)` in `hook.ts`.
3. Write a connector wiring the tool's native hooks/events to `codemie hook --agent <new-adapter-name>` (see `src/cli/commands/proxy/connectors/claude-code-otlp.ts` for the example — hook names, settings format, and env vars are tool-specific).
4. Everything from `forwardOtlpEventsToSpool` onward is already shared — no changes needed there as long as 1-3 hold. Only implement `finalize`/`retryOnce` on a handler's `ForwardDecision` if that handler owns a cursor into some external log that must not advance until its batch is durable (§3.4); a handler with nothing to commit omits both.

## 6. Reference implementation: `claude-code-otlp`

`ClaudeCodeOtlpPlugin` (`src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts`), registered as `claude-code-otlp`, ingests Claude Code's native hook events.

| File | Role |
|---|---|
| `claude-code-otlp.plugin.ts` | `extends OtlpAgentAdapter`: input parsing, `evaluate()` dispatch, per-event handlers, `resolveAgentFields()`, `resolveEventType()` (hook name to type map), allowlist wiring. Also owns `buildGitSnapshotEvent()`/`buildSessionEnvEvent()` — the `agent.git.snapshot`/`agent.session.env` event builders. Neither is transcript-derived (no offsets/merge/commit-after-send to protect), so they don't belong in `transcript/orchestrator.ts` alongside `agent.usage.request` et al., and they aren't field *resolvers* either, so they don't belong in `event-fields/` — they live as plain functions next to the handler that resolves their inputs. The private `checkSessionEnv()` helper wraps `openSessionEnvCheckPass` for the cheap (no-I/O) re-check and is called explicitly, inline, from `onStopEvent`/`onPreCompactEvent`/`onStopFailureEvent`/`onSessionEndEvent`/`onSubagentStopEvent` — not from a shared place in `evaluate()` — because which hooks get it is a per-handler judgment call (turn/session/subagent boundaries only; `PreToolUse`/`PostToolUse` are deliberately excluded as the hottest hooks in the plugin), and `onSubagentStopEvent` additionally skips it before an internal check-in with no `agent_type` ever reaches the call. `composeFinalize()` merges that check's own `finalize` with the handler's own pass `finalize` into the single one a `ForwardDecision` carries. `onPostModelSwitch`/`onConfigChange` call `openSessionEnvCheckPass` directly instead (with `{ full: ... }`), since they want its full re-resolve, not the cheap merge `checkSessionEnv()` does |
| `src/agents/core/OtlpAgentAdapter.ts` | Abstract base: fixed flow, allowlist-before-daemon INVARIANT, generic `ForwardDecision` (with `finalize`/`retryOnce`), composes the common fields from `event-fields/`, `buildEvent`, one batch spool forward with commit-after-send (the forwarder only transports; `forward-context.ts` is gone) |
| `src/agents/core/identity-resolver.ts` | Developer identity tiers (jwt -> git -> codemie_cli -> os), email-from-credentials, and the raw sources `resolveGitEmail` / `resolveCodemieCliEmail` / `resolveOsUser` |
| `src/agents/core/event-fields/` | Field resolvers: `repo-fields.ts` (common repo/story; opt-in `git_head_start`/`git_head_end`/`git_commits` via `resolveGitCommitFields` — commits by the session's git-email author since the session's wall-clock start, metadata only, backing `agent.git.snapshot`), `identity-fields.ts` (common identity; opt-in `git_email`/`codemie_cli_email`/`os_user`), `env-fields.ts` (opt-in `os`/`timezone`) |
| `src/agents/core/hook-credentials.ts` | `resolveHookCredentials()`: the SSO credentials the daemon will use, read from daemon state (SSO only) |
| `src/agents/core/story-resolver.ts` | Story tiers and `resolveStoryFor({ cwd, branch, prompt, explicitConfigPath })`; text scanning is delegated to `ticket-parser.ts` |
| `src/agents/core/ticket-parser.ts` | Pure ticket-id extraction: `TICKET_RE`, `extractTicketMentions(text, limit)`, `extractTicketMarker(text)`, and `parsePromptFields(prompt)` - opt-in `agent.prompt.submit` fields `story_marker`, `ticket_mentions` (capped at 20), `prompt_length` (UTF-16 units), derived from the full prompt before `buildEvent` truncates it to 200 chars. `git_branch` on this event is the existing common field |
| `client-version-cache.ts` | TTL file cache around `claude --version`, backing the `client_version` common field |
| `event-fields/` (`claude-code-otlp`'s own — **Claude-Code-specific**, not the shared `src/agents/core/event-fields/` above) | Resolvers tied to Claude Code's own hook/tool payload shapes (tool names, `tool_input`/`tool_response` fields, `.meta.json` sidecar layout) — not reusable by a different adapter, so they live here rather than in `core/`. Pure, no I/O, never mocked in tests. `tool-fields.ts`: `resolveToolContextFields`/`resolveToolDiffFields` — `PreToolUse`/`PostToolUse`-only enrichment (`file_path`, `subagent_type`/`description`, `skill_name`, `lines_added`/`lines_removed`). `command-fields.ts`: `resolveCommandFields` - `UserPromptSubmit`-only `command_name` (leading slash command, no slash, arguments never sent; syntactic heuristic, built-ins never reach the hook; `agent.skill.dispatch` stays authoritative for skill-backed commands). `subagent-fields.ts`: `resolveSubagentStopFields` — `SubagentStop`-only: the same `description`/`tool_use_id`/`workflow_run`/`spawn_depth`/`worktree`/`started_at`/`duration_ms` `agent.subagent.usage` carries, stamped onto `agent.subagent.stop` too. `session-env-fields.ts`: `resolveSessionEnvFields(cwd, configuredModel, permissionMode)` — the full `agent.session.env` snapshot (`provider`/`api_host` inferred from `ANTHROPIC_BASE_URL`/`CLAUDE_CODE_USE_BEDROCK`/`CLAUDE_CODE_USE_VERTEX`; `output_style`/`plugins` read from the Claude Code settings cascade and `~/.claude/plugins/installed_plugins.json`; `mcp_servers` via the shared `getMCPConfigSummary()`; `os`/`timezone` reused from the shared `resolveEnvFields()`, not recomputed; `arch`/`node_version`/`hostname_hash` from the runtime), called once from `onSessionStart` to build the session's baseline and again from `onPostModelSwitch`/`onConfigChange` (via `openSessionEnvCheckPass`'s `full` path) for a complete re-resolve. Also exports `resolveVolatileSessionEnvFields(effort, permissionMode)` — the no-I/O subset (`effort`/`permission_mode` plus a fresh `os`/`arch`/`node_version`/`timezone`/`hostname_hash`) merged onto the last snapshot by every other re-check, and `sessionEnvFieldsEqual(a, b)` — an explicit field-by-field comparison (not `JSON.stringify`, which would be key-order-fragile) deciding whether a re-check actually changed anything. Field names here (`configured_model`, `effort`, not `model`/`effort_level`) match the backend's own contract, confirmed against its test fixtures — see "Known limitations" below |
| `claude-code-otlp.types.ts` | `ClaudeForwardDecision` alias, `isClaudeCodeHookInput` |
| `claude-code-otlp.constants.ts` | `CLAUDE_CODE_OTLP_AGENT_NAME` — the registered adapter name |
| `claude-code-otlp.allowlist.ts` | Per-project allowlist gating (`isProjectTracked`/`readAllowlistState`) — see the INVARIANT comment in the base `processOtlpEvent`: an untracked project must never reach the daemon spool, since the daemon has no allowlist of its own |
| `transcript/orchestrator.ts` | `openMainTranscriptPass`/`openSessionStartPass`/`openSubagentPass`/`openSessionEndPass`/`openPostCompactPass` — each opens a commit-after-send pass (acquire lock, derive in memory, return `{ events, finalize }`) for its hook. `openSessionStartPass` derives no events of its own — it only records `git_head_start`/wall-clock `sessionStartedAt`, plus the first `agent.session.env` snapshot, into `TranscriptParseState` (`gitHeadStart`/`sessionStartedAt`/`lastSessionEnvFields`); `git_head_start`/`sessionStartedAt` are read back by `openSessionEndPass` (`SessionEndPass.gitHeadStart`/`sessionStartedAt`) so `agent.git.snapshot` can report the session's starting point from a later, separate CLI process. `openSessionEnvCheckPass(sessionId, input)` is a separate pass (its own lock acquisition, not folded into the other four's signatures, to avoid widening every existing call site just to thread `effort`/`permissionMode` through them): it diffs a recomputed candidate against `state.lastSessionEnvFields` via `sessionEnvFieldsEqual`, returning `{ sessionEnvFields: null, finalize: NOOP_FINALIZE }` (already released) when nothing changed, or the full updated snapshot plus a real `finalize` that persists it — same commit-after-send contract, nothing written to disk until the caller's send is confirmed. `openPostCompactPass` is `PostCompact`'s own dedicated pass — see its note below and in `claude-code-otlp.plugin.ts`'s row |
| `transcript/subagent-usage.ts` | `findSubagentFiles` — discovers every subagent transcript for a session |
| `transcript/session-signals.ts` | Pure `agent.session.summary` signal extractors (edit-diff lines, turns, compactions, client versions, title). `collectCompactions()` turns each `compact_boundary` system line into a `Compaction` (`pre_tokens`/`post_tokens`/`dropped_tokens`/`duration_ms`). `openPostCompactPass` is the only caller that treats its result as a record-worthy signal (`agent.session.compact.done`); `buildFullAccumulator`'s own call (full-file, every `Stop`/`SessionEnd`) feeds only `agent.session.summary`'s aggregate stats, never a record of its own. `PreCompact`'s own event (`agent.session.compact`) never carries compaction numbers: `PreCompact` fires *before* compaction runs, so the boundary line doesn't exist in the transcript yet |
| `src/cli/commands/proxy/connectors/claude-code-otlp.ts` | Wires Claude Code's `.claude/settings.json` hooks to `codemie hook --agent claude-code-otlp` |

Claude Code fires 16 hook events (`HOOK_EVENTS` in that connector). `evaluate()` branches on `SessionStart` (adds the opt-in `os`, `timezone`, `git_email`, `codemie_cli_email`, `os_user`, `git_head_start` and `model` fields to `agent.session.start`, opens `openSessionStartPass`, and emits a second record, `agent.session.env`, built by `buildSessionEnvEvent()` from the session's first snapshot), `UserPromptSubmit` (auth gate), `UserPromptExpansion` (emits `agent.skill.dispatch`: the native payload spread as-is, plus `skill_name` copied from `command_name` — no `expansion_type` gating; the ticket's two fields only, nothing inferred), `PreToolUse`/`PostToolUse` (tool-specific enrichment via `tool-fields.ts`: `file_path` for `Edit`/`Write`/`MultiEdit`/`NotebookEdit`, `subagent_type`/`description` for `Agent`/`Task`, `skill_name` for `Skill`; `PostToolUse` additionally stamps `lines_added`/`lines_removed` from the tool result's own diff, not resolvable pre-execution), `Stop`/`PreCompact`/`StopFailure`/`SessionEnd` (transcript parse, each also re-checking `agent.session.env` via `checkSessionEnv()`/`openSessionEnvCheckPass` and appending a new snapshot record when it changed; `SessionEnd` additionally emits a second record, `agent.git.snapshot`, built by `buildGitSnapshotEvent()` from `openSessionEndPass`'s `gitHeadStart`/`sessionStartedAt`, `resolveGitHeadFields(ctx, 'end')`, `resolveIdentityCandidateFields().git_email`, and `resolveGitCommitFields()` — commits by that git email since `sessionStartedAt`, metadata only), `PostCompact` (its own `openPostCompactPass`, detailed below — never forwards the native hook event itself, only the derived `agent.session.compact.done` record when one is found), `SubagentStop` (subagent-scoped transcript parse, plus stamping `resolveSubagentStopFields`'s seven fields onto the forwarded `agent.subagent.stop` event itself, and the same `agent.session.env` re-check — skipped for Claude Code's own internal "is it done yet?" check-ins, which carry no `agent_type`), and `PostModelSwitch`/`ConfigChange` (never forwarded themselves — each does a full `agent.session.env` re-resolve via `openSessionEnvCheckPass`'s `full` path and emits only the derived snapshot, if anything changed; `ConfigChange` additionally skips entirely for `source: 'skills'`, a skill-*content* edit that's never env-relevant); everything else falls through to the raw passthrough.

**`PostCompact` / `agent.session.compact.done` (`openPostCompactPass`, `transcript/orchestrator.ts`).** `PostCompact` can fire before Claude Code has flushed the `compact_boundary` system line it reports on — observed lag ranges from under a second up to ~9s. Unlike every other pass in this module, `openPostCompactPass` does *not* hold the per-session lock for its whole duration:

1. A lock-free peek at the persisted `lastCompactionEnd` marker (`TranscriptParseState`), then a lock-free `waitForNewCompaction` poll of the transcript (every `COMPACTION_POLL_INTERVAL_MS` = 100ms, up to `POST_COMPACT_WAIT_BUDGET_MS` = 60s) — returns immediately once a `compact_boundary` newer than the marker shows up, with no lock held the whole time. Holding the lock across this wait, like the old design did, would stall any sibling hook for the same session (a concurrently-running subagent's `SubagentStop`, or the `Stop` that resumes the turn right after compaction) for no reason.
2. Only once that resolves (found, or the budget ran out) does it acquire the lock — briefly, like every other pass — reload fresh state, run the normal `deriveMainEvents` for `agent.usage.request`, and re-check for a compaction newer than the now-fresh `state.lastCompactionEnd` via `findLatestCompaction` (a full-transcript scan via `collectCompactions`, deliberately *not* scoped to `state.mainOffset` — a sibling hook can advance `mainOffset` past the boundary line's position while this was waiting, since nothing else ever looks for `compact_boundary`, so trusting `mainOffset` as a starting point would miss it). If found, `buildCompactionDoneEvent` builds the record and `state.lastCompactionEnd` is updated to its `end`, so a later compaction is reported once and a repeat scan of the same one never re-emits it.

The `PostCompact` hook entry is also the one exception to every other event's synchronous, 30s-timeout entry: `connectors/claude-code-otlp.ts`'s `buildCodemieEntry()` gives it `async: true` plus `CODEMIE_POST_COMPACT_HOOK_TIMEOUT_SECONDS` (90s) instead of `CODEMIE_HOOK_TIMEOUT_SECONDS` (30s) — `async` keeps Claude Code, and the user's own turn, from ever waiting on this hook; the longer `timeout` is what keeps Claude Code from killing the subprocess before the wait above (plus the brief lock-held merge/send/commit after it) can finish. No other event can be `async`, because several of them depend on Claude Code waiting synchronously for a `ForwardDecision`-driven outcome (`UserPromptSubmit`'s SSO re-auth `block` decision being the clearest example).

See `docs/ARCHITECTURE-PROXY.md` for the proxy/daemon layer this hands off to, and `otlp-spool/` (`src/providers/plugins/sso/proxy/plugins/otlp-spool/`) for session completeness gating and draining — both already agent-agnostic and not something a new adapter needs to touch.
