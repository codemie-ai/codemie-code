# OTLP Hook-Event Plugin Pattern (`OtlpAgentAdapter`)

**Scope**: any plugin implementing `OtlpAgentAdapter` (`src/agents/core/types.ts`), under `src/agents/plugins/<name>/`. Today that's `claude-code-otlp` only.
**Status**: Living doc — update when the dispatch pattern changes or a second adapter lands.

## 1. What this pattern is

An `OtlpAgentAdapter` is not a chat agent. It's the ingestion point for one coding tool's native hook/event surface, turned into CodeMie's analytics pipeline (session summaries, usage, auth gating). Every adapter implements one method and feeds the same shared spool shape:

```ts
export interface OtlpAgentAdapter {
  readonly name: string;
  readonly type: AgentAdapterType.OTLP;
  processOtlpEvent(rawHookInput: string, deps: OtlpAdapterDeps): Promise<void>;
}

export interface OtlpAdapterDeps {
  ensureOtlpProxy: (agentName: string) => Promise<void>;
}

export interface OtlpHookSpoolData {
  agentName: string;
  raw: string;
  timestamp: number;
}
```

Everything downstream of `processOtlpEvent` — spool, forwarder, analytics API — is already agent-agnostic and shared. Nothing in it is specific to any one tool's hook names or payload shape; that lives entirely inside each adapter.

## 2. Pipeline

```
<tool>'s native hook/event fires (agent-specific names/payload)
        │ JSON on stdin
        ▼
codemie hook --agent <adapter-name>        (src/cli/commands/hook.ts)
        │ looks up adapter via AgentRegistry.getAnalyticsAgent(name)
        ▼
<Adapter>.processOtlpEvent(rawEvent, deps)
        │
        ▼
evaluate(parsed) → ForwardDecision          (§3: shape every adapter follows)
        │
   ┌────┴─────┐
 block       forward
   │           │
 log +     forwardToSpool(payload)  ──POST──►  proxy daemon spool (OtlpHookSpoolData)
 suppress                                              │
 (adapter-                                             ▼
  specific)                           otlp-spool/forwarder.ts (background, agent-agnostic)
                                                        │
                                                        ▼
                                              CodeMie analytics API
```

- `forwardOtlpEventToSpool` (`src/agents/plugins/utils.ts`) is fire-and-forget and shared: POSTs `{ agentName, timestamp, raw }` to the local proxy daemon, swallows every error. A dead daemon never blocks or fails the hook.
- `otlp-spool/forwarder.ts` is agent-agnostic by construction: it maps spooled records straight through to the analytics API payload and never calls into any adapter. Any agent-owned common field (platform, version, entrypoint, …) must already be baked into the event by the adapter before it reaches the spool (§5).
- Wiring which native hooks/events call `codemie hook --agent <adapter-name>` is entirely tool-specific — see §6 for the Claude Code connector; a different tool has its own.

## 3. The dispatch pattern every `evaluate()` follows

This is a convention each adapter implements for itself, not a shared type from `core/types.ts` — `OtlpAgentAdapter`'s only contractual method is `processOtlpEvent`. Each adapter is free to define its own `ForwardDecision`-equivalent and field names to match its own tool's native event shape; keep the shape below, not the literal field/type names from the `claude-code-otlp` example.

### 3.1 Two outcomes — forward or block

```ts
export type ForwardDecision =
  | { decision: 'forward'; payload: Record<string, unknown>[] }
  | { decision: 'block'; reason: string; /* ...whatever this tool needs to suppress/respond to the native event... */ };
```

`forward` carries the full list of records to push to the spool (the original parsed event, plus zero or more derived analytics events). `block` stops the hook and logs a reason; any extra fields on `block` (`claude-code-otlp` uses `hookSpecificOutput`, mirroring Claude Code's own hook-output JSON schema) are specific to that tool's blocking mechanism, not to this pattern — a different tool may have no `block` case at all, or a differently-shaped one.

### 3.2 One handler per event name — no `switch`, no shared merge step

```ts
private async evaluate(parsed: Record<string, unknown>): Promise<ForwardDecision> {
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

`forwardToSpool()` is the only call site for `forwardOtlpEventToSpool()`, called once from `processOtlpEvent()` after `evaluate()` resolves (it loops over `ForwardDecision.payload` and forwards each record). No handler forwards anything itself. This single-chokepoint property guarantees every event reaches the spool exactly once, in order, under the adapter's registered name.

### 3.5 Proxy readiness is the adapter's own responsibility

Whether and when to call `deps.ensureOtlpProxy()`, and whether to add any further gate (e.g. an auth check, a tracked-project check), is a decision each adapter makes for itself based on what its events actually need — there's no required shape here. `claude-code-otlp` gates `ensureOtlpProxy()` on its tracked-project check in `processOtlpEvent()` but, once past that, calls it for every event regardless of which handler runs (since every `forward` decision needs the daemon up to reach the spool) — it does not gate per-handler. It additionally gates an SSO auth check inside `onUserPromptSubmit` only, because that's the one handler whose job is to enforce it. A different tool may not need a tracked-project concept at all, may not need proxy readiness for every event, or may need a different gate entirely — don't carry `claude-code-otlp`'s specific gating choices into a new adapter, just the principle that each adapter decides this for itself.

## 4. Adding a new event to an existing adapter

1. Write one handler method, `(parsed: Record<string, unknown>) => Promise<ForwardDecision>`.
2. Add exactly one `if` branch in `evaluate()` dispatching to it. No `switch`, don't touch the trailing fallthrough.
3. Never forward from inside the handler — return the `ForwardDecision`; the single `forwardToSpool()` call in `processOtlpEvent()` sends it.
4. Add a test for the new branch, following the adapter's existing test structure.
5. Update that adapter's own event-surface table/notes (see §6 for the current example).

## 5. Adding a new `OtlpAgentAdapter` for a different tool

1. Create `src/agents/plugins/<new-adapter-name>/`, implement `OtlpAgentAdapter` following §3. Enrich events with any agent-owned common fields (platform, version, entrypoint, …) **inside the adapter's own hook-time process**, not via a callback from the forwarder — the forwarder runs in the long-lived proxy daemon, a different process from the short-lived `codemie hook --agent <name>` CLI invocation, so resolving agent/tool state there would reflect the daemon's environment, not the invocation that produced the event. If resolving a field is expensive (subprocess spawn, network call), back it with a small file cache under `getCodemiePath()` — the hook-time process is fresh per event, so in-memory memoization buys nothing (see `client-version-cache.ts` for the pattern).
2. Register it in `AgentRegistry` (`src/agents/registry.ts`) under its own `name` — same name passed to `forwardOtlpEventToSpool(event, name)` and matched by `AgentRegistry.getAnalyticsAgent(name)` in `hook.ts`.
3. Write a connector wiring the tool's native hooks/events to `codemie hook --agent <new-adapter-name>` (see `src/cli/commands/proxy/connectors/claude-code-otlp.ts` for the example — hook names, settings format, and env vars are tool-specific).
4. Everything from `forwardOtlpEventToSpool` onward is already shared — no changes needed there as long as 1-3 hold.

## 6. Reference implementation: `claude-code-otlp`

`ClaudeCodeOtlpPlugin` (`src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts`), registered as `claude-code-otlp`, ingests Claude Code's native hook events.

| File | Role |
|---|---|
| `claude-code-otlp.plugin.ts` | `evaluate()` dispatch, per-event handlers, hook-time common-field enrichment, allowlist gate + daemon start |
| `client-version-cache.ts` | TTL file cache around `claude --version`, backing the `client_version` common field |
| `claude-code-otlp.types.ts` | `ForwardDecision` |
| `claude-code-otlp.constants.ts` | `CLAUDE_CODE_OTLP_AGENT_NAME` — the registered adapter name |
| `claude-code-otlp.allowlist.ts` | Per-project allowlist gating (`isProjectTracked`/`readAllowlistState`) — see the INVARIANT comment in `processOtlpEvent`: an untracked project must never reach the daemon spool, since the daemon has no allowlist of its own |
| `transcript/orchestrator.ts` | `collectMainTranscriptEvents`/`collectSubagentTranscriptEvents` — transcript-derived analytics events |
| `transcript/subagent-usage.ts` | `findSubagentFiles` — discovers every subagent transcript for a session |
| `src/cli/commands/proxy/connectors/claude-code-otlp.ts` | Wires Claude Code's `.claude/settings.json` hooks to `codemie hook --agent claude-code-otlp` |

Claude Code fires 12 hook events (`HOOK_EVENTS` in that connector). `evaluate()` branches on `UserPromptSubmit` (auth gate), `Stop`/`PreCompact`/`StopFailure`/`SessionEnd` (transcript parse), and `SubagentStop` (subagent-scoped transcript parse); everything else falls through to the raw passthrough.

See `docs/ARCHITECTURE-PROXY.md` for the proxy/daemon layer this hands off to, and `otlp-spool/` (`src/providers/plugins/sso/proxy/plugins/otlp-spool/`) for session completeness gating and draining — both already agent-agnostic and not something a new adapter needs to touch.
