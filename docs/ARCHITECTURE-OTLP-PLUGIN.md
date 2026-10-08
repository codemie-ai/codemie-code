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
  protected abstract agentCommonFields(): Promise<Record<string, unknown>>;
}

export interface OtlpAdapterDeps {
  ensureOtlpProxy: (agentName: string) => Promise<void>;
  forwardOtlpEventToSpool: (event: Record<string, unknown>, agentName: string) => Promise<void>;
}

export interface OtlpHookSpoolData {
  agentName: string;
  raw: string;
  timestamp: number;
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
 log +     common fields merged,
 forward each record ──POST──►  proxy daemon spool (OtlpHookSpoolData)
 suppress                                              │
 (adapter-                                             ▼
  specific)                           otlp-spool/forwarder.ts (background, agent-agnostic)
                                                        │
                                                        ▼
                                              CodeMie analytics API
```

- `forwardOtlpEventToSpool` (`src/agents/plugins/utils.ts`) is fire-and-forget and shared: POSTs `{ agentName, timestamp, raw }` to the local proxy daemon, swallows every error. A dead daemon never blocks or fails the hook.
- `otlp-spool/forwarder.ts` only forwards: it maps spooled records to the analytics API payload and never calls into any adapter. It passes `story_id`, `story_source`, `git_branch`, `repo_remote` through from the record (`''` when absent) and no longer resolves story or git info itself. Credential and daemon-state fields (`user_email`, `developer_name`, `identity_source`, `codemie_project_name`, `codemie_cli_version`) are still stamped by the forwarder.
- **Common fields resolved by the base class at hook time** (the forwarder runs in a long-lived daemon whose env is frozen at spawn, so env-dependent fields were wrong there): `git_branch` (`detectGitBranch`), `repo_remote` (`detectGitRemoteRepo`), and `story_id` / `story_source` (`core/story-resolver.ts`, priority explicit env/config file -> marker -> branch -> mention; marker and mention only when `extractHookContext` supplies a `prompt`). Merge rule: a record's own non-empty string value wins, otherwise the resolved common value; `''` / `undefined` never clobber. `agentCommonFields()` overrides everything (platform, version, entrypoint, …).
- **Story granularity**: each hook subprocess resolves independently. A `Stop` after a prompt containing `story: ABC-1` gets the explicit / branch story, not the marker story. Carrying it across a session would need per-session state.
- **Known limitations**: (1) the explicit story tier reads `<cwd>/.claude/analytics.local.json` by default (Claude-flavoured); `resolveStoryFor` takes `explicitConfigPath` so another adapter can override it. (2) The block path prints `JSON.stringify(decision)` to stdout, which is Claude Code's hook protocol; a tool with a different block protocol must make that step overridable (e.g. an `emitBlock()` method).
- **Rollout**: the daemon outlives CLI upgrades. An old daemon recomputes `story_id`, `story_source` and `repo_remote` from its own env and overwrites the hook's values until restarted (`git_branch` is kept). Restart the proxy daemon after upgrading.
- Wiring which native hooks/events call `codemie hook --agent <adapter-name>` is entirely tool-specific — see §6 for the Claude Code connector; a different tool has its own.

## 3. The dispatch pattern every `evaluate()` follows

`ForwardDecision<TBlockOutput>` is a shared generic type exported from `OtlpAgentAdapter.ts`; the adapter binds `TBlockOutput` to its tool's block output (Claude: `UserPromptSubmitHookSpecificOutput`, aliased as `ClaudeForwardDecision`). `evaluate(input)` receives the already-parsed, typed `TInput`; the dispatch convention below is how adapters implement it.

### 3.1 Two outcomes — forward or block

```ts
export type ForwardDecision<TBlockOutput = Record<string, unknown>> =
  | { decision: 'forward'; payload: Record<string, unknown>[] }
  | { decision: 'block'; reason: string; hookSpecificOutput: TBlockOutput };
```

`forward` carries the full list of records to push to the spool (the original parsed event, plus zero or more derived analytics events). `block` stops the hook and logs a reason; any extra fields on `block` (`claude-code-otlp` uses `hookSpecificOutput`, mirroring Claude Code's own hook-output JSON schema) are specific to that tool's blocking mechanism, not to this pattern — a different tool may have no `block` case at all, or a differently-shaped one.

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

### 3.4 One place writes to the spool

The base class's `processOtlpEvent` is the only call site of `deps.forwardOtlpEventToSpool`: after `evaluate()` resolves it computes the common fields once, merges them into each `payload` record and forwards every record, **not awaited** (fire-and-forget; it never throws, and awaiting would put daemon latency on the hook path). Handlers never forward anything themselves, so every event reaches the spool exactly once, in order, under the adapter's registered name.

### 3.5 Proxy readiness is the adapter's own responsibility

The base flow calls `isTracked()` (abstract) before `deps.ensureOtlpProxy()`, so a subclass cannot skip the allowlist gate (the INVARIANT comment in the base flow). Past that, `ensureOtlpProxy()` runs for every event regardless of which handler runs (every `forward` decision needs the daemon up to reach the spool). Further gates (e.g. an auth check) remain the adapter's own decision. It additionally gates an SSO auth check inside `onUserPromptSubmit` only, because that's the one handler whose job is to enforce it. A different tool may not need a tracked-project concept at all, may not need proxy readiness for every event, or may need a different gate entirely — don't carry `claude-code-otlp`'s specific gating choices into a new adapter, just the principle that each adapter decides this for itself.

## 4. Adding a new event to an existing adapter

1. Write one handler method, `(input) => Promise<ForwardDecision<TBlockOutput>>`.
2. Add exactly one `if` branch in `evaluate()` dispatching to it. No `switch`, don't touch the trailing fallthrough.
3. Never forward from inside the handler — return the `ForwardDecision`; the base class's `processOtlpEvent()` sends it.
4. Add a test for the new branch, following the adapter's existing test structure.
5. Update that adapter's own event-surface table/notes (see §6 for the current example).

## 5. Adding a new `OtlpAgentAdapter` for a different tool

1. Create `src/agents/plugins/<new-adapter-name>/` with a class `extends OtlpAgentAdapter<TInput, TBlockOutput>` and implement `parseHookInput`, `extractHookContext`, `isTracked`, `evaluate` (following §3) and `agentCommonFields`. Agent-owned common fields (platform, version, entrypoint, …) go in `agentCommonFields()`, resolved **inside the adapter's own hook-time process**, not via a callback from the forwarder — the forwarder runs in the long-lived proxy daemon, a different process from the short-lived `codemie hook --agent <name>` CLI invocation, so resolving state there would reflect the daemon's environment. Git branch/remote and story are already resolved by the base class. If resolving a field is expensive (subprocess spawn, network call), back it with a small file cache under `getCodemiePath()` — the hook-time process is fresh per event, so in-memory memoization buys nothing (see `client-version-cache.ts`).
2. Register it in `AgentRegistry` (`src/agents/registry.ts`) under its own `name` — same name the base class passes to `forwardOtlpEventToSpool(event, name)` and matched by `AgentRegistry.getAnalyticsAgent(name)` in `hook.ts`.
3. Write a connector wiring the tool's native hooks/events to `codemie hook --agent <new-adapter-name>` (see `src/cli/commands/proxy/connectors/claude-code-otlp.ts` for the example — hook names, settings format, and env vars are tool-specific).
4. Everything from `forwardOtlpEventToSpool` onward is already shared — no changes needed there as long as 1-3 hold.

## 6. Reference implementation: `claude-code-otlp`

`ClaudeCodeOtlpPlugin` (`src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts`), registered as `claude-code-otlp`, ingests Claude Code's native hook events.

| File | Role |
|---|---|
| `claude-code-otlp.plugin.ts` | `extends OtlpAgentAdapter`: input parsing, `evaluate()` dispatch, per-event handlers, `agentCommonFields()`, allowlist wiring |
| `src/agents/core/OtlpAgentAdapter.ts` | Abstract base: fixed flow, allowlist-before-daemon INVARIANT, generic `ForwardDecision`, hook-time git/story common fields, fire-and-forget spool forwarding |
| `src/agents/core/story-resolver.ts` | Story tiers and `resolveStoryFor({ cwd, branch, prompt, explicitConfigPath })` |
| `client-version-cache.ts` | TTL file cache around `claude --version`, backing the `client_version` common field |
| `claude-code-otlp.types.ts` | `ClaudeForwardDecision` alias, `isClaudeCodeHookInput` |
| `claude-code-otlp.constants.ts` | `CLAUDE_CODE_OTLP_AGENT_NAME` — the registered adapter name |
| `claude-code-otlp.allowlist.ts` | Per-project allowlist gating (`isProjectTracked`/`readAllowlistState`) — see the INVARIANT comment in the base `processOtlpEvent`: an untracked project must never reach the daemon spool, since the daemon has no allowlist of its own |
| `transcript/orchestrator.ts` | `collectMainTranscriptEvents`/`collectSubagentTranscriptEvents` — transcript-derived analytics events |
| `transcript/subagent-usage.ts` | `findSubagentFiles` — discovers every subagent transcript for a session |
| `src/cli/commands/proxy/connectors/claude-code-otlp.ts` | Wires Claude Code's `.claude/settings.json` hooks to `codemie hook --agent claude-code-otlp` |

Claude Code fires 12 hook events (`HOOK_EVENTS` in that connector). `evaluate()` branches on `UserPromptSubmit` (auth gate), `Stop`/`PreCompact`/`StopFailure`/`SessionEnd` (transcript parse), and `SubagentStop` (subagent-scoped transcript parse); everything else falls through to the raw passthrough.

See `docs/ARCHITECTURE-PROXY.md` for the proxy/daemon layer this hands off to, and `otlp-spool/` (`src/providers/plugins/sso/proxy/plugins/otlp-spool/`) for session completeness gating and draining — both already agent-agnostic and not something a new adapter needs to touch.
