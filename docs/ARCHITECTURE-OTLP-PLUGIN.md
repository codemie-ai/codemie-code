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
- **The forwarder is transport only** (`otlp-spool/forwarder.ts`). It unwraps the spool envelope (still one line per event, `OtlpHookSpoolData`), POSTs `hookEvent` byte for byte, advances the cursor, and retries on 401/403 or 302 login redirects. Redirect following is disabled so an SSO login page returned with 302 cannot be mistaken for successful telemetry delivery. Repeated 401/403 or 302 responses mark credentials stale and leave spool cursors untouched; other redirect statuses are treated as ordinary unsuccessful responses. It does no context resolution and no event enrichment, and never calls into any adapter. It owns only `baseUrl` (from daemon state) and the credentials. The one thing it reads from an event is `type === 'agent.session.end'`, to call `markSessionEnded`.
- **Stale-credential recovery is in-process, no restart required.** A persistent 401/403 sets `otlp-spool/auth-state.ts`'s `credentialsStale` flag, which suspends every forward (`forwarder.ts`'s `send()`) while spool data keeps accumulating on disk. `OtlpInterceptor` (`otlp.plugin.ts`) re-reads the credential store through `resolveFreshCredentials` in `otlp-spool/auth-state.ts` (same lookup as `CodeMieProxy.start()`: `syncCodeMieUrl` credentials first, else the main platform credentials) when that flag is set — on its own forwarding tick, and opportunistically when inbound hook/OTLP traffic arrives after a successful SSO re-login. A successful read replaces the in-memory credentials and clears the flag; forwarding resumes on that tick or the next tick after an inbound refresh. Failed or empty reads leave the flag set, so delivery retries automatically and no spool data is discarded.
- **The event is built by the base class at hook time** (`buildEvent`), because the forwarder runs in a long-lived daemon whose env (cwd, active profile, credentials, CLI version) is frozen at spawn. Per record, in order: `type` (an explicit `type` on the record wins, otherwise the adapter's `resolveEventType`), truncation (`prompt` to 200 chars, `tool_input` / `tool_response` / `error` to 300; a nested `raw` is dropped), `prompt_body`, `session_id` coerced to a string, `cwd` (always the hook's cwd, also for transcript-derived events; stamped as the repository identifier `extractRepository(cwd)` -- `parent/current`, `Cowork` or `unknown` -- never the absolute path, which does not leave the hook process; `repo_remote` is unchanged), `schema_version: 2`, a fresh `event_id`, and `timestamp`. The event's own `raw` field mirrors the full enriched event, so the top level and `raw` carry the same fields.
- **Timestamp**: the event's own valid timestamp (e.g. the transcript line time on `agent.usage.request`), else one `new Date()` captured per hook invocation. It is persisted inside the spool line, so every retry re-sends the same bytes.
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
| `claude-code-otlp.plugin.ts` | `extends OtlpAgentAdapter`: input parsing, `evaluate()` dispatch, per-event handlers, `resolveAgentFields()`, `resolveEventType()` (hook name to type map), allowlist wiring |
| `src/agents/core/OtlpAgentAdapter.ts` | Abstract base: fixed flow, allowlist-before-daemon INVARIANT, generic `ForwardDecision` (with `finalize`/`retryOnce`), hook-time git/story/context common fields, `buildEvent`, one batch spool forward with commit-after-send (the forwarder only transports; `forward-context.ts` is gone) |
| `src/agents/core/identity-resolver.ts` | Developer identity tiers (jwt -> git -> codemie_cli -> os) and email-from-credentials, used by the base class at hook time |
| `src/agents/core/hook-credentials.ts` | `resolveHookCredentials()`: the SSO credentials the daemon will use, read from daemon state (SSO only) |
| `src/agents/core/story-resolver.ts` | Story tiers and `resolveStoryFor({ cwd, branch, prompt, explicitConfigPath })` |
| `client-version-cache.ts` | TTL file cache around `claude --version`, backing the `client_version` common field |
| `claude-code-otlp.types.ts` | `ClaudeForwardDecision` alias, `isClaudeCodeHookInput` |
| `claude-code-otlp.constants.ts` | `CLAUDE_CODE_OTLP_AGENT_NAME` — the registered adapter name |
| `claude-code-otlp.allowlist.ts` | Per-project allowlist gating (`isProjectTracked`/`readAllowlistState`) — see the INVARIANT comment in the base `processOtlpEvent`: an untracked project must never reach the daemon spool, since the daemon has no allowlist of its own |
| `transcript/orchestrator.ts` | `openMainTranscriptPass`/`openSubagentPass`/`openSessionEndPass` — each opens a commit-after-send pass (acquire lock, derive in memory, return `{ events, finalize }`) for its hook |
| `transcript/subagent-usage.ts` | `findSubagentFiles` — discovers every subagent transcript for a session |
| `src/cli/commands/proxy/connectors/claude-code-otlp.ts` | Wires Claude Code's `.claude/settings.json` hooks to `codemie hook --agent claude-code-otlp` |

Claude Code fires 12 hook events (`HOOK_EVENTS` in that connector). `evaluate()` branches on `UserPromptSubmit` (auth gate), `Stop`/`PreCompact`/`StopFailure`/`SessionEnd` (transcript parse), and `SubagentStop` (subagent-scoped transcript parse); everything else falls through to the raw passthrough.

See `docs/ARCHITECTURE-PROXY.md` for the proxy/daemon layer this hands off to, and `otlp-spool/` (`src/providers/plugins/sso/proxy/plugins/otlp-spool/`) for session completeness gating and draining — both already agent-agnostic and not something a new adapter needs to touch.
