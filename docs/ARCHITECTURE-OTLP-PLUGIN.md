# OTLP Hook-Event Plugin Pattern (`OtlpAgentAdapter`)

**Scope**: any plugin implementing `OtlpAgentAdapter` (`src/agents/core/types.ts`), under `src/agents/plugins/<name>/`. Today that's `claude-code-otlp` only; this doc is written so a second implementation (another coding agent/IDE with its own native hook/event surface — e.g. a future Cursor adapter) does not have to reinvent the dispatch shape.
**Status**: Living doc — update this file when the dispatch pattern changes, or when a second `OtlpAgentAdapter` implementation lands (promote the parts that turn out to generalize, keep the parts that don't agent-specific).

## 1. What this pattern is

An `OtlpAgentAdapter` is not a chat agent — it never has a conversation. It is the ingestion point for one coding tool's own native hook/event surface, turned into CodeMie's analytics pipeline (session summaries, per-request usage, subagent usage, auth gating, etc.). Each tool that exposes hooks (Claude Code today; potentially Cursor or others later) gets its own adapter plugin, but every adapter implements the same two-method contract and feeds the same spool shape:

```ts
export interface OtlpAgentAdapter {
  readonly name: string;
  readonly type: AgentAdapterType.OTLP;

  processOtlpEvent(rawHookInput: string): Promise<void>;

  /** Resolve agent-owned common fields for a single hook event */
  prepareAnalyticsFields(
    hookEvent: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}
```

```ts
export interface OtlpHookSpoolData {
  agentName: string;
  raw: string;
  timestamp: number;
}
```

`processOtlpEvent` is the only entry point; everything downstream of it — the spool, the forwarder, the analytics API — is agent-agnostic and already shared. Nothing about the pipeline described below is specific to any one tool's hook names or payload shape; those live entirely inside each adapter's own `evaluate()`.

## 2. Where an adapter sits in the pipeline

```
<tool>'s native hook/event fires (hook names & payload shape are agent-specific)
        │  JSON on stdin
        ▼
codemie hook --agent <adapter-name>              (src/cli/commands/hook.ts)
        │
        ▼
<Adapter>.processOtlpEvent(rawEvent: string)
        │
        ▼
evaluate(rawEvent) → ForwardDecision               ◄── §4: the shape every adapter should follow
        │
   ┌────┴─────┐
   │          │
 block      forward
   │          │
 log +      forwardToSpool(payload)  ──POST──►  proxy daemon spool  (OtlpHookSpoolData)
 suppress                                              │
 (adapter-                                             ▼
  specific)                              otlp-spool/forwarder.ts (background, agent-agnostic)
                                                        │
                                      <Adapter>.prepareAnalyticsFields(hookEvent)
                                                        │
                                                        ▼
                                              CodeMie analytics API
```

- `codemie hook --agent <adapter-name>` (`src/cli/commands/hook.ts`) looks up the adapter via `AgentRegistry.getAnalyticsAgent(name)` and calls `processOtlpEvent` with the raw stdin payload. This part is already agent-agnostic — a new adapter just registers under a new name.
- `forwardOtlpEventToSpool` (`src/agents/plugins/utils.ts`) is fire-and-forget and shared by every adapter: it POSTs `{ agentName, timestamp, raw }` to the local proxy daemon and swallows every error. A dead/unreachable daemon never blocks or fails the hook, regardless of which adapter called it.
- `otlp-spool/forwarder.ts` is agent-agnostic too — it reads spooled records and dispatches to whichever adapter's `prepareAnalyticsFields` matches `spoolData.agentName` (via `AgentRegistry.getAnalyticsAgent`). A new adapter needs no changes here as long as it implements `prepareAnalyticsFields` and spools under its own registered name.
- Wiring _which_ native hooks/events get pointed at `codemie hook --agent <adapter-name>`, and how, is entirely tool-specific — see §5 for how `claude-code-otlp` does it; a different tool will have its own connector.

## 3. The dispatch pattern every `evaluate()` should follow

This is the part that generalizes across adapters, independent of which tool's hooks are being handled. Keep to this shape regardless of the native event names involved.

### 3.1 `ForwardDecision` — the only two outcomes

```ts
export type ForwardDecision =
  | { decision: "forward"; payload: string[] }
  | {
      decision: "block";
      reason: string;
      hookSpecificOutput: Record<string, string | boolean>;
    };
```

Every native event an adapter processes should resolve to exactly one of these. `forward` carries the full list of raw JSON strings to push to the spool (the original raw event, plus zero or more derived analytics events). `block` stops the hook and logs a reason; what `hookSpecificOutput` means (e.g. suppressing a prompt) is specific to the tool and the event, not to this pattern.

### 3.2 One handler per event name — no `switch`, no shared merge step

```ts
private async evaluate(rawEvent: string): Promise<ForwardDecision> {
  const event = toBaseHookEvent(JSON.parse(rawEvent));

  if (!event.sessionId) {
    return { decision: 'forward', payload: [rawEvent] };
  }

  if (event.hookEventName === 'SomeEvent') {
    return await this.onSomeEvent(rawEvent, event);
  }
  if (event.hookEventName === 'OtherEvent') {
    return await this.onOtherEvent(rawEvent, event);
  }
  // ...one `if` per handled event name...

  return { decision: 'forward', payload: [rawEvent] };
}
```

Each handler is fully responsible for its own `ForwardDecision` — it does not return a bare `string[]` for `evaluate()` to merge afterward. That means that the _only_ trailing fallthrough return (`{ decision: 'forward', payload: [rawEvent] }`) is for event names `evaluate()` doesn't branch on at all. It is not a sink that handled branches route through.

### 3.3 One parsed object, not two

Map the adapter's raw event JSON into one typed shape up front. If a handler needs a field the type doesn't yet expose, **extend the type**, don't re-parse `rawEvent` a second time into a second ad-hoc object. The original `rawEvent` _string_ is kept separately only because it is itself the thing that gets forwarded to the spool (`payload: [rawEvent, ...]`) — not because anything needs a second parsed representation of it.

### 3.4 One place writes to the spool

`forwardToSpool()` (or equivalent) should be the only call site for `forwardOtlpEventToSpool()` in an adapter, called exactly once from `processOtlpEvent()` after `evaluate()` resolves. No handler forwards anything itself — handlers only _compute_ what should be forwarded (the `ForwardDecision.payload`). This single-chokepoint property is relied on by analytics correctness (every event reaches the spool exactly once, in a known order, under this adapter's registered name).

### 3.5 Only gate on proxy/daemon readiness when you're about to act on it

An adapter owns the decision of whether it actually needs the local proxy/daemon for a given event — don't pay for an auth check or a daemon-readiness check on every event just because _some_ events need one. `claude-code-otlp` is the current example: only `onUserPromptSubmit` calls `ensureProxyAuth()` (because that handler's whole job is to gate on it); every other handler goes straight to building its `ForwardDecision` and skips the check entirely, since forwarding to the spool doesn't itself require proxy readiness. Keep that shape in a new adapter — gate per-handler, not globally in `evaluate()` or `processOtlpEvent()`.

## 4. Adding a new event to an existing adapter

1. **Decide the shape you need.** Does the new event need extra fields beyond the adapter's current typed hook-event shape? If so, extend that type and its raw→typed mapping function.
2. **Write one handler method**, taking `(rawEvent: string, event: <TypedHookEvent>)` and returning `Promise<ForwardDecision>` (unless the handler genuinely needs no typed field off the event — then `rawEvent` alone is fine).
3. **Add exactly one `if` branch** in `evaluate()`, dispatching to the new handler. Do not add a `switch` case, do not touch the trailing fallthrough return.
4. **Never forward anything from inside the handler.** Return the full `ForwardDecision`; the single `forwardToSpool()` call in `processOtlpEvent()` is what actually sends it.
5. **Add a test** for the new branch, mocking at whatever boundary the adapter already mocks (e.g. a transcript/orchestrator module), following the adapter's existing test structure.
6. **Update that adapter's own event-surface table** (see `claude-code-otlp`'s own notes/tests for the current example of such a table).

## 5. Adding a new `OtlpAgentAdapter` for a different tool

1. Create `src/agents/plugins/<new-adapter-name>/` and implement `OtlpAgentAdapter`: `processOtlpEvent` following the `evaluate()`/`ForwardDecision` shape in §3, plus `prepareAnalyticsFields`.
2. Register it in `AgentRegistry` (`src/agents/registry.ts`) under its own `name` — that name is also what gets passed to `forwardOtlpEventToSpool(rawEvent, name)` and later matched by `otlp-spool/forwarder.ts` via `AgentRegistry.getAnalyticsAgent(name)`.
3. Write a connector that wires the tool's own native hooks/events to `codemie hook --agent <new-adapter-name>` (see `src/cli/commands/proxy/connectors/claude-code-otlp.ts` for the Claude Code example — the specific hook names, settings file format, and env vars will be entirely different for another tool, and that's expected).
4. Everything from `forwardOtlpEventToSpool` onward (the spool POST, `otlp-spool/forwarder.ts`, the analytics API call) is already shared — no changes needed there as long as step 1-3 hold.

## 6. Session completeness gating & draining (`otlp-spool/`)

Past the per-adapter spool POST, the proxy daemon's `otlp-spool/` layer batches a session's spooled data before sending it to the analytics API, rather than forwarding each spooled record immediately. This part is already agent-agnostic — it keys everything off `sessionId`/`agentName`, not off any one adapter's event shape — but it's useful background for understanding what "forward to the spool" actually leads to.

- **`spool-state.ts`** derives a session's state straight from the spool files on disk. `hooksGroupPresent`/`otelGroupPresent` check whether the hooks stream and any OTEL stream have _ever_ had data written — sticky, so a stream that already reached EOF still counts as "written" even once fully delivered.
- **`completeness-gate.ts`** (`gateDecision(spool, status): GateDecision`) decides what to do with a session on each tick:
  - hooks **and** OTEL both present → `'send'`.
  - hooks only, waited long enough (and force-forwarding is allowed) → `'hooks-only-force'`; hooks only but not waited enough yet → `'wait'`.
  - OTEL only → `'wait'` (today this waits indefinitely for a hooks event to arrive — there is no current path that gives up on an OTEL-only session).
  - neither present → `'noop'`.
- **`sweep.ts`** garbage-collects a session once every stream is fully drained (`isSessionDrained`) and a grace period has elapsed since the last producer write — measured from spool-file mtimes, not the status file, since cursor-only updates touch the status file without any new data arriving. Safe to delete: the next producer write recreates the status/spool files from scratch.
- **`session-lock.ts`**'s `withSessionLock` serializes per-session operations but is **not reentrant**: calling it again for the same session from inside an already-running locked callback deadlocks (the inner call chains behind the outer one, which is itself waiting on the inner call to finish). Code running inside a lock must mutate session state in place rather than calling the cursor/status update helpers again.

## 7. Reference implementation: `claude-code-otlp`

`ClaudeCodeOtlpPlugin` (`src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts`) is the current (and so far only) `OtlpAgentAdapter`, registered as `claude-code-otlp`. It ingests Claude Code's own native hook events.

| File                                                    | Role                                                                                                                                                 |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-code-otlp.plugin.ts`                            | `evaluate()` dispatch, all per-event handlers, `prepareAnalyticsFields`, client-version resolution                                                   |
| `claude-code-otlp.types.ts`                             | `BaseClaudeCodeHookEvent`/`toBaseClaudeCodeHookEvent` (the one parsed shape), re-exports `ForwardDecision`                                           |
| `claude-code-otlp.constants.ts`                         | `CLAUDE_CODE_OTLP_AGENT_NAME` — the registered adapter name                                                                                          |
| `transcript/orchestrator.ts`                            | `collectMainTranscriptEvents`, `collectSubagentTranscriptEvents` — Claude-Code-transcript-specific derivation of analytics events                    |
| `transcript/subagent-usage.ts`                          | `findSubagentFiles` — discovers every subagent transcript for a session                                                                              |
| `src/cli/commands/proxy/connectors/claude-code-otlp.ts` | `HOOK_EVENTS` — wires Claude Code's `.claude/settings.json` hooks to `codemie hook --agent claude-code-otlp`; the tool-specific piece from §5 step 3 |

Claude Code fires 12 distinct hook events today (`HOOK_EVENTS` in that connector): `SessionStart`, `Stop`, `StopFailure`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SubagentStart`, `SubagentStop`, `PreCompact`, `Notification`. `evaluate()` branches explicitly on `UserPromptSubmit` (auth gate), `Stop`/`PreCompact`/`StopFailure`/`SessionEnd` (transcript parse), and `SubagentStop` (subagent-scoped transcript parse); everything else falls through to the raw passthrough — intentional, since most of those events carry nothing this pipeline needs to transform.

See `docs/ARCHITECTURE-PROXY.md` for the proxy/plugin layer this hands off to (the spool endpoint, the daemon, the forwarder).
