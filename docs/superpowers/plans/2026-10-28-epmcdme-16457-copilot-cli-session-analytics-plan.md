# EPMCDME-16457 Copilot CLI Managed + Native Session Analytics — Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. CLI tasks live in this repo (`codemie-code`); backend tasks in `epm-cdme/codemie` are listed so the wire contract is designed end-to-end.

**Ticket:** [EPMCDME-16457](https://jiraeu.epam.com/browse/EPMCDME-16457) — clones EPMCDME-16018. Baseline metric definitions: EPMCDME-15301. Pricing baseline: EPMCDME-16301.

**Goal:** Complete GitHub Copilot CLI analytics for managed (`codemie-copilot`) and native (`copilot` + CodeMie hooks) sessions so that tool activity, API requests, token usage, harness and attribution match the Claude Code implementation, are never double-counted, and cache-read pricing resolves Copilot's model names. **Backend USD cost stays $0 for hook-only sessions (decision D1 in the backend plan, same as hook-only Claude); USD pricing for Copilot lives in the local `codemie analytics` report.**

**Guiding rule (agreed in review): do it the same way as the Claude Code implementation** (`src/agents/plugins/claude-code-otlp/`).

**Architecture rule:** Keep the `OtlpAgentAdapter` dispatch shape: one `ForwardDecision` handler per native event, no `switch`, and a single spool call site (`docs/ARCHITECTURE-OTLP-PLUGIN.md`). Resolve agent-owned fields at hook time or in the daemon enrichment. The forwarder never calls back into the adapter.

| Mode | Launch | CLI Analytics ingestion |
|---|---|---|
| Managed | `codemie-copilot` | Same `copilot-cli-otlp` hook pipeline as native. The user's connector hook file is loaded because managed `COPILOT_HOME` defaults to `~/.copilot` (Task 7). It is labelled `entrypoint: 'managed'`. The existing `MetricDelta` / conversations sync is unchanged and goes to a separate store. |
| Native | `copilot` | `codemie hook --agent copilot-cli-otlp --event <name>` → hooks spool → `otlp-spool/forwarder.ts`. The final usage + summary pass at session end is done by `otlp-spool/copilot-usage-enrichment.ts` (stateless, idempotent; see Task 5). |

**Start gates** (all closed before the task they gate; the rest of the plan can start with Task 0):

| Gate | Gates | Status |
|---|---|---|
| G1 Base-class change `resolveAgentFields(input)` (Task 6) | Task 6 | Decided: optional-input signature, no behaviour change for Claude / Copilot Chat |
| G2 Supported Copilot version bump to 1.0.92 (Task 6a) | Task 5 test fixtures | Approved (minimum → 1.0.83); 1.0.92 verified to exist on npm; only the `usage_record` threshold check in Task 0 remains |
| G4 Backend plan B2 / B3 / B4 (`epm-cdme/codemie`, `docs/superpowers/plans/2026-10-28-epmcdme-16457-copilot-cli-session-analytics-backend-plan.md`, written and reviewed) | CLI release + Preview E2E (not CLI coding) | Open — owner: backend dev of EPMCDME-16457; must be merged before or with the CLI release |
| G5 Decision D1: backend USD cost for hook-only Copilot sessions stays $0 | CLI release | Assumed (Claude parity); ticket owner confirms (baseline EPMCDME-16301). If rejected, a backend pricing task is added and the release waits for it; no CLI code changes |

---

## Review decisions (2026-10-28)

| Item | Decision | Where |
|---|---|---|
| Killed sessions | Send usage + incremental summary at every `agentStop` (Claude's `Stop`) | Task 4, 5 |
| API-call count / usage | **Tier A** (Copilot ≥ 1.0.92): one `agent.usage.request` per `session.usage_record`, `request_id = apiCallId`, with complete tokens, as Claude does per request. **Tier B** (any build **without** `usage_record`: < 1.0.92, including native sessions from builds older than 1.0.79): one row per `assistant.message` (`messageId`), with each shutdown segment's totals on that segment's last request. No backend change; B1 only as a fallback | Task 5 |
| Supported Copilot version | Recommended version moves to **1.0.92** so managed installs get Tier A by default. Following the repo rule ("the minimum is the previously recommended version"), the hard minimum moves from 1.0.79 to **1.0.83**: users on 1.0.79–1.0.82 get blocked at launch and must upgrade. **Approved by the requester on 2026-10-28.** Native `copilot` on any version keeps working through Tier B | Task 6a |
| Per-session agent fields | `OtlpAgentAdapter` passes the parsed hook input to `resolveAgentFields(input)`; existing adapters ignore it | Task 6 |
| Hook-side state | Two small per-session files (tool correlation; usage cursor) instead of one file with an ID set; the daemon final pass is stateless and idempotent through stable `event_id`s | Task 3, 4, 5 |
| `stop_reason` | `usage_record.finishReason`; Tier B rows use `'end_turn'`. It has no numeric effect for Copilot (no OTel logs to pair with) | Task 5 |
| Managed hooks | Same as Claude: managed sessions load the user's connector hook file (shared `~/.copilot`). With an explicit `COPILOT_HOME` override, `beforeRun` writes the CodeMie-owned hook file there when it is missing or different. **Never delete anything**: the hook-time connector scope (`isTracked`) already neutralises a stale copy | Task 7 |
| Tool correlation | Real IDs: `preToolUse.toolCalls[].id`. Ends pair with the open start by name + args, and a start ID never changes | Task 3 |
| Premium requests | Not sent | Task 5 |
| Cross-midnight | Each row carries its own request's timestamp | Task 5 |
| Pricing | CLI sends normalized `model` + literal `model_raw`. The backend prices cache reads by `model_raw` (`cost_daily.model_name`), so backend task **B4** teaches `normalize_model` the dotted Claude names. Backend USD cost stays $0 for hook-only sessions (D1) | Task 5, B4, G5 |
| `usage_partial` | Summary attribute only; no backend exposure (Claude has no such flag). E2E checks raw ingest | Task 5, E2E |

## Task 0 findings (local `~/.copilot/session-state`: 197 sessions, 134 with a shutdown record; Copilot 0.0.348 – 1.0.100)

| Question | Finding |
|---|---|
| Real `preToolUse` payload | `{ sessionId, cwd, toolCalls: [{ id, name, args }] }`. It has **no `timestamp` and no top-level `toolName`**. `isCopilotCliHookInput` requires a numeric `timestamp`, so every tool start is rejected, which is the ticket's root cause. Batches: 1 call in 632 hooks, 2–14 calls in 425. `args` is an object (1,937) or a string (122). |
| Tool-call IDs | All 2,059 `toolCalls[].id` values equal `assistant.message.toolRequests[].toolCallId`, written to `events.jsonl` before the hook. `postToolUse` / `postToolUseFailure` have **no ID**; their `toolArgs` is a string (1,316) or an object (2,168). |
| `postToolUse` / `postToolUseFailure` | `{ sessionId, timestamp, cwd, toolName, toolArgs, toolResult: { textResultForLlm, resultType, sessionLog, toolTelemetry } }` / `{ …, toolName, toolArgs, error }` |
| `agentStop` / `sessionEnd` | `{ sessionId, timestamp, cwd, transcriptPath, stopReason: 'end_turn', stop_hook_active, agentId? }` / `{ sessionId, timestamp, cwd, reason, error? }` |
| Per-request usage | `session.usage_record.usage` (Copilot ≥ 1.0.92) has model, input/output/cacheRead/cacheWrite/reasoning tokens, a unique `apiCallId`, `finishReason`, `initiator` (`user`/`agent`/`sub-agent`) and `duration`. Per-model count and token sums equal the shutdown totals (12/12). |
| Older builds (no `usage_record`) | `count(assistant.message)` per model = `modelMetrics[model].requests.count` (153/153). `messageId` is always present and unique. `requestId` is present in only 47% of messages and **not unique** (up to 6 messages share one). Task 0 re-checks this on builds before 1.0.79 (sessions from 0.0.348 exist locally) |
| Resume | `session.shutdown` totals are usually **cumulative** across resumes (7 → 28 → 34 requests), but one session **reset per segment** (8, 36, 11, 1). Both patterns must be handled. `usage_record` has neither problem. |
| Model names | Dotted Claude versions (`claude-haiku-4.5`, `claude-sonnet-4.6`) plus `gpt-5.3-codex`, `gpt-5.4-mini`, and others. |
| Managed `COPILOT_HOME` | `beforeRun` defaults it to `resolveDataPath()` = `~/.copilot` (`copilot-cli.plugin.ts:191-195`, `BaseAgentAdapter.ts:1277-1284`), the same as `getCopilotHome()` and the connector. |

Source: `hook.start.input` records in `events.jsonl`, which is Copilot's own log of each hook payload. Fixtures are built from them (Task 0 below).

---

## Root cause → fix map

| # | Gap (ticket) | Cause | Fix |
|---|---|---|---|
| 1 | Tool-start events dropped | `preToolUse` has no `timestamp` → `isCopilotCliHookInput` rejects it. It also has no top-level `toolName` (it uses `toolCalls[]`) | Task 1, 2 |
| 2 | Tool completion lacks correlation | `postToolUse` / `postToolUseFailure` carry no ID | Task 3 |
| 3 | Request counts lost | One row per model with `request_id = <session>:<model>`. The backend counts distinct `(request_id, model_raw)` groups (`rollups.py:425-449`) → 1 API call per model | Task 5 |
| 4 | Session Detail incomplete | Detail tools and timeline read OTel spans/logs only (`reader.py:759-792`) | B2 |
| 5 | Harness `Unknown` | Harness comes only from `otel_resources` (`reader.py:657-681`); there is no `platform` fallback | Task 6 + B3 |
| 6 | Managed sessions missing | `isTracked()` drops every hook that carries `CODEMIE_SESSION_ID` | Task 7 |

---

## Part A — CLI (`codemie-code`)

### Task 0 — Fixtures and version check

- [x] Build sanitized fixtures under `src/agents/plugins/copilot-cli-otlp/__tests__/fixtures/` from `hook.start.input` and `events.jsonl` records:
  - `pre-tool-use.single.json`, `pre-tool-use.batched.json` (≥ 3 calls, one with string `args`), `post-tool-use.json` (string and object `toolArgs`), `post-tool-use-failure.json`, `agent-stop.json` (one with `agentId`), `session-end.json`.
  - `events.usage-record.jsonl` (Tier A, mixed models, includes a `sub-agent` record).
  - `events.193-requests.jsonl` (Tier B, the verified 193-request session).
  - `events.resume-cumulative.jsonl` and `events.resume-reset.jsonl` (Tier B, both resume patterns).
  - **Sanitize by allowlist, not by stripping prompts only.** Keep IDs (regenerated UUIDs), tool and model names, timestamps, counts and token numbers. Replace `cwd`, `transcriptPath`, repository, branch, host, user login / email, `toolArgs`, `args`, `textResultForLlm`, `sessionLog` and `toolTelemetry` with fixed placeholders. Add a fixture lint test that fails on any path separator outside the placeholders, `@`, or `http` in the fixture text.
- [x] **Version checks (closes G2):** install `@github/copilot@1.0.91` and `@github/copilot@1.0.92` in a scratch directory and confirm `session.usage_record` is absent / present. Record the real threshold in this plan; if it is not 1.0.92, change the version in Task 6a and the Tier A / B boundary wording. Also check that `messageId` exists on a pre-1.0.79 session. *Finding (2026-10-28):* the npm package is only a loader (the binary ships as a platform optional dependency), so it can't be grepped. The local `~/.copilot/session-state` (365 sessions) shows `usage_record` absent in every session ≤ 1.0.80 and present from `1.0.92-4.unstable` onwards; no stable 1.0.91 session exists locally, so the 1.0.92 boundary stays as planned (Tier B covers any build without the record).

### Task 1 — Types and input guard

File: `copilot-cli-otlp.types.ts`

- [x] Add `CopilotCliToolCall { id: string; name: string; args: unknown }` and extend `CopilotCliHookInput` with:
  - `toolCalls?: CopilotCliToolCall[]`;
  - `toolResult?: { textResultForLlm?: string; resultType?: string }`;
  - `transcriptPath?: string`, `stopReason?: string`, `transformedPrompt?: string`.
  - `timestamp` becomes optional.
- [x] `isCopilotCliHookInput`: accept a **missing** `timestamp` only for `codemieEventName === 'preToolUse'` with an array `toolCalls`. Every other event still requires a numeric `timestamp`, which keeps rejecting VS Code Local's string timestamps. `normalizeEvent` stamps `Date.now()` when the timestamp is absent.

### Task 2 — Tool events (single + batched)

New file: `copilot-cli-otlp.tool-payload.ts`

- [x] `extractStartCalls(input)`: map `toolCalls[]` to `{ toolUseId: id, toolName: name, toolArgs: parseArgs(args) }`. `parseArgs` parses a JSON string when valid and otherwise keeps it as a string. Entries without `id` or `name` are dropped with one sanitized debug log line.
- [x] `extractEndCall(input)`: `{ toolName, toolArgs: parseArgs(toolArgs), success, resultText?, errorMessage? }`.
  - Failure: the `postToolUseFailure` event, or `toolResult.resultType === 'failure'`.
  - Do **not** forward `sessionLog` / `toolTelemetry`.
- [x] Plugin handlers (one per event):
  - `onEnforcedEvent('preToolUse')`: auth once. On success, forward N `agent.tool.start` events with `tool_use_id = id`, **then** record the open starts (Task 3). On failure, keep the single `permissionDecision: 'deny'`, which denies the whole batch, as today; nothing is recorded, so a denied call can never leave an open start behind.
  - `onToolEnd` / `onToolFailure`: one `agent.tool.end` / `agent.tool.error`, with the `tool_use_id` from Task 3.
- [x] `buildToolEvent(base, call, outcome?)` holds the tool fields. `normalizeEvent` keeps only the non-tool fields.
- [x] File-path parity with Claude `tool-fields.ts`: `file_path` from `args.path` for `create` / `edit` / `str_replace_editor` / `apply_patch`. Define a **new** `FILE_PATH_TOOLS` set in `tool-payload.ts`. Do not change or export the managed `FILE_WRITE_TOOLS` (`copilot-cli.session.ts:56`, `['create','edit']`), so managed metrics stay unchanged. Extract `file_path` before the base class truncates `tool_input` to 300 chars.
- [x] `buildEventId` needs no change: the digested payload already contains `tool_use_id` (`toolCallId` → `tool_use_id`), so batch events with a shared timestamp keep distinct IDs. Add a regression test for it.

### Task 3 — Start ↔ end correlation (real IDs, immutable)

New file: `copilot-cli-otlp.tool-correlation.ts`

- [x] **Start:** `tool_use_id` is the real `toolCalls[].id` from the payload, with no lookup. After a successful auth (Task 2), record each start as an open start `{ id, name, argsKey, startedAt }`, where `argsKey = sha256(canonicalJson(parseArgs(args)))`.
- [x] **End:** drop open starts older than 30 min (aborted / interrupted tools), then remove and return the **oldest open start** with the same `name` and `argsKey`; otherwise the oldest open start with the same `name`. Reuse its ID unchanged; **a start's ID is never replaced**.
- [x] **End without an open start** (the start hook timed out or was skipped):
  - bounded tail-read of `events.jsonl` for the newest `tool.execution_start` with the same name and args whose `toolCallId` has not ended yet → that real ID;
  - otherwise a generated `<sessionId>:<argsKey16>:orphan:<n>`.
  - The end event is always sent.
- [x] **Hook-side state is two small files** in `getCodemiePath('otlp', 'copilot-cli')` (`isSafeSessionId`, atomic write: temp + rename), so the hot path (`preToolUse` / `postToolUse`) never reads usage state:
  - `<sessionId>.tools.json`: `openStarts` only, capped at 500 (oldest dropped). Written by `preToolUse` / `postToolUse*`.
  - `<sessionId>.session.json`: `usageCursor` (Task 4/5), `clientVersion` (Task 6) and `sessionStateRoot` (Task 7). Written by `agentStop`, `sessionStart` and `sessionEnd` only. The cursor is committed in `finalize(accepted)` (`OtlpAgentAdapter.ts:134-140`), as Claude's `finalizeOf` does (`orchestrator.ts:615-632`), so a rejected spool write is re-derived by the next pass.
  - **No emitted-ID set anywhere.**
- [x] **Lockfile** (`O_EXCL`, one per state file) with **stale recovery**: a lock whose mtime is older than 2 s is removed and retaken, so a crashed hook can never block later ones. The existing `otlp-spool/session-lock.ts` is in-process only and is **not** reusable across hook processes.
- [x] **Time budget:** **≤ 150 ms per hook for the state-file work only** (lock wait + read + write). Auth (`ensureProxyAuth`), `ensureOtlpProxy` and spool acceptance keep their existing behaviour and the connector's 30 s hook timeout.
  - On `preToolUse`, budget exhaustion only skips recording open starts. The start events still carry real IDs, and auth enforcement always runs. Ends then use the `events.jsonl` lookup.
- [x] Delete both state files in the daemon after the final pass. Sweep files older than 24 h on `sessionStart`.

### Task 4 — Summaries and tool totals (Claude field names)

- [x] Extract the pairing loop in `CopilotCliSessionAdapter.parseSessionFile` into a pure `extractCopilotToolActivity(events)` in `copilot-cli/copilot-cli.tool-activity.ts`, returning `{ tools, toolStatus, fileOperations }`. The managed adapter calls it, with no behavior change.
- [x] `buildSessionSummaryEvent(...)` uses Claude's field names (`session-summary.ts:128-161`), which the backend already accepts (`rollups.py:1190-1216`):
  - `timestamp`, `started_at`, `ended_at`, `is_final`, `duration_ms`. The backend calculates duration from `started_at` and `ended_at` (`rollups.py:1168-1186`), so **both timestamps are required**; `duration_ms` is informational.
  - `api_calls`: main-thread requests only, excluding `initiator: 'sub-agent'`, as in Claude (`orchestrator.ts:600`).
  - `tool_calls`, `tool_errors`, `tools: Record<name, { calls, errors }>`, `tool_results`.
  - `turns`, `models` (primary first), `primary_model`.
  - `lines_added` / `lines_removed` (`null` when unknown), `files_changed`, `files_written`, `files_edited` (`session.shutdown.codeChanges` + tool activity).
  - `usage_partial` (non-contract attribute).
- [x] **Summary `event_id`** = `stableEventId('agent.session.summary', sessionId, `${phase}:${ended_at}`)`. Every incremental snapshot and each final summary after a resume is stored. The backend uses the latest by timestamp (`rollups.py:1044-1051`), so a resumed session's newer final summary is never dropped as a duplicate.
- [x] **`agentStop` handler** (Claude's `Stop`, `orchestrator.ts:584-603`), within the Task 3 budget. A payload with `agentId` (sub-agent stop) does nothing extra: the main-thread `agentStop` picks its usage records up from the same `events.jsonl`.
  - **Incremental read with a cursor:** `usageCursor = { offset, lastEventTs }` (byte offset of the first unread complete line). On a fresh state (first `agentStop` of this process, including after a resume) read the whole file once, capped at 8 MB (above that, read the tail and set `usage_partial`). Afterwards read only from `offset`. Use `transcriptPath` when present and under the Copilot home, else the session-state path.
  - send `agent.usage.request` rows for the records / messages after the cursor (Task 5);
  - send an incremental summary (`is_final: false`, `ended_at` = the latest event timestamp), with totals computed over the whole file on a fresh state and kept in the cursor afterwards (`toolCalls`, `toolErrors`, `apiCalls`, `turns` counters);
  - on budget exhaustion or a missing file send nothing extra; the next `agentStop` or the final pass catches up.
- [x] **Final pass** (daemon, `copilot-usage-enrichment.ts`, after `session.shutdown`) is **stateless**: it reads the whole `events.jsonl` (same 8 MB cap) and builds **all** usage rows plus the final summary (`is_final: true`) from scratch. Re-sent rows carry the same stable `event_id`, which the backend dedups on `(type, session_id, event_id)` (`otlp.py:457-463`), so the daemon needs no knowledge of what the hooks already sent. Required changes to `copilot-usage-enrichment.ts`:
  - replace `alreadyEnriched` (any usage row at or after sessionEnd) with a check for an existing `agent.session.summary` record with `is_final: true` and the same `ended_at` in the hooks spool;
  - drop the `no-usage` early return: a found `session.shutdown` always yields the final summary (`api_calls: 0` when there are no usage rows);
  - read `sessionStateRoot` from `<sessionId>.session.json` (Task 7) instead of a stamped event field.

### Task 5 — Usage rows (Claude contract: one row per API request)

New file: `copilot-cli-otlp.request-usage.ts`. `copilot-cli-otlp.usage.ts` keeps only the summary and template helpers.

- [x] **Tier A, from `session.usage_record` (Copilot ≥ 1.0.92):** one `agent.usage.request` per record, in the same shape as Claude's `buildUsageRequestEvent` (`usage-request.ts:233-262`):
  - `request_id = apiCallId`, `message_id = ''`, `model_raw = usage.model`, `model = resolveCopilotBillableModel(usage.model)`;
  - tokens via the existing `toBackendTokens` peel-off: `inputTokens` includes cache, the OpenAI convention, verified by the record sums matching the shutdown totals;
  - `thinking_tokens = reasoningTokens ?? null`, `stop_reason = finishReason`;
  - `scope_kind = 'agent'` for `initiator: 'sub-agent'`, otherwise `'main'`;
  - `timestamp` = the record's event timestamp.
  - Each record is complete when written, so it is sent by the `agentStop` pass that first sees it (cursor, Task 4) and again, byte-identical and with the same `event_id`, by the stateless final pass. Resumes are safe because `apiCallId` is unique.
- [x] **Tier B, from `assistant.message` (any build or segment without `usage_record`; in practice < 1.0.92):**
  - One row per message:
    - `request_id = messageId`. Not `requestId`, which is not unique (Task 0).
    - `model`: `data.model`, else the model in effect from `session.model_change`, else the single-model backfill; reuse the extracted `fromPerTurn` model logic.
    - `output_tokens`; input, cache and thinking are 0 / null until attached.
    - `stop_reason: 'end_turn'`, and `timestamp` = the message timestamp.
  - **Segments:** split `events.jsonl` at each `session.shutdown` (done on every full read: the first `agentStop` of a process and the final pass; incremental `agentStop` reads send per-message rows only, without totals). For each shutdown `k` and model `m`, classify the totals with the request counts:
    - `requests.count == cumulative message count up to k` → **cumulative**: segment totals = shutdown `k` − shutdown `k−1`;
    - `requests.count == message count in segment k` → **reset**: segment totals = shutdown `k`;
    - anything else → skip attaching for that segment and model, set `usage_partial`, and log a debug message.
  - Attach the segment's input, cache-read, cache-write (5 m) and reasoning totals to **that segment's last message of model `m`**. The re-sent row keeps the same `request_id` and timestamp, and gets `event_id` suffix `:final`. The backend's max-merge then applies it (`rollups.py:423-445`), and the request groups stay within `_GROUP_REACH` because the timestamp is unchanged.
  - Output reconciliation: if the per-message output sum is **below** the segment's output total, add the non-negative difference to that last message. If it is **above**, keep the per-message values (the backend can't lower a max) and set `usage_partial`.
  - Model in a segment rollup with no messages → one row `request_id = <sessionId>:<model>:seg<k>` with the segment totals.
- [x] Mixed sessions (a resume with an upgraded Copilot): choose the tier **per segment**.
- [x] **`resolveCopilotBillableModel(raw)`** (CLI half of the pricing decision; backend half is B4): turn dotted `claude-*` versions into dashes (`claude-sonnet-4.6` → `claude-sonnet-4-6`, `claude-haiku-4.5` → `claude-haiku-4-5`) and pass every other name through unchanged. It fills the `model` field only. `model_raw` stays literal, and the backend resolves cache-read pricing from `model_raw` through its own `normalize_model` (B4). Extend the CLI function only for names seen in fixtures. Names neither side resolves appear in the backend's `unpriced_models` (only when they have cache-read tokens).
- [x] `event_id = stableEventId('agent.usage.request', sessionId, request_id + (attached ? ':final' : ''))`.
- [x] Do **not** send `premium_requests` (strict Claude parity). It stays in the local `codemie analytics` report only.
- [x] Remove the `attachUsage` / `usage_models` path from `onSessionEnd`. `session.shutdown` is written only after the `sessionEnd` hook exits, so the hook can never read usage; the daemon and `agentStop` are the only usage sources.
- [x] Local `codemie analytics` (`usage-readers.ts#readCopilotCli`): prefer `session.usage_record` when present, and carry request counts so the local API-call count matches the backend. Unknown models are shown as **unpriced**, not `$0`.

### Task 6 — Harness, version, attribution

- [x] **Base-class change (G1):** `OtlpAgentAdapter.processOtlpEvent` calls `this.resolveAgentFields(hookInput)`, and the abstract signature becomes `resolveAgentFields(input: TInput)`. Subclasses that take no parameter stay type-compatible, so Claude and Copilot Chat are untouched. Needed because agent fields are resolved once per hook and spread **after** the event's own fields in `buildEvent`, so a per-event `client_version` could never win, and there is no other per-session hook. Add a base-class test that the input reaches `resolveAgentFields`.
- [x] `resolveAgentFields(input)`: keep `platform: 'copilot-cli'` (backend B3 maps it to the display name). Add:
  - `entrypoint`: `'managed'` only when `CODEMIE_SESSION_ID` is set **and** `input.sessionId === CODEMIE_SESSION_ID` (the managed launcher pins the native session UUID to it, `enrichArgs`); otherwise `'native'`. A native `copilot` started inside a managed shell inherits the env var but has a different session ID, so it is labelled correctly. Accepted limitation: a managed `--resume` / `--continue` session (no pinning) is labelled `native`; it is still counted once.
  - `client_version`: `session.start.data.copilotVersion` from a bounded head-read (64 KB) of `events.jsonl`, cached in `<sessionId>.session.json` (Task 3). Empty string when the file is not there yet. (Claude's `client-version-cache.ts` runs `claude --version` and is not reusable here.)
- [x] **Add `entrypoint` to `TEMPLATE_FIELDS`** (`copilot-cli-otlp.usage.ts:96-99`) so usage and summary events built at session end carry it. The daemon final pass fills an empty `client_version` from the head of the same `events.jsonl`.
- [x] Repository/branch fallback to `session.start.data.context.{repository,branch}` when `cwd` is not a git repo.

### Task 6a — Supported Copilot version (G2)

- [x] In `copilot-cli.plugin.ts`: `COPILOT_SUPPORTED_VERSION` `1.0.83` → `1.0.92`, `COPILOT_MINIMUM_SUPPORTED_VERSION` `1.0.79` → `1.0.83` (repo rule in the comment above the constants). Use the real `usage_record` threshold found in Task 0 if it differs.
- [x] Update the version assertions in `copilot-cli.registry.test.ts` and any other test that pins the old values.

### Task 7 — Managed sessions (Claude parity), no double counting


How Claude does it:
- `isTracked()` checks only the allowlist (`claude-code-otlp.plugin.ts:91-93`).
- Managed `codemie-claude` keeps its bundled plugin hooks (`claude/plugin/hooks/hooks.json` → `MetricDelta` / conversations). The user's `codemie proxy connect` hooks in `~/.claude/settings.json` also fire in managed sessions, because `CLAUDE_CONFIG_DIR` is not overridden.
- The two hook sets run side by side and write to different stores.

Copilot is the same: managed `COPILOT_HOME` defaults to `~/.copilot`, so the connector's `hooks/codemie-copilot-cli-hooks.json` is already loaded in managed sessions.

- [x] Remove the `process.env.CODEMIE_SESSION_ID` early return from `CopilotCliOtlpPlugin.isTracked()`. The connector scope (`isCopilotProjectTracked`) applies to both modes unchanged. This change alone brings managed sessions into CLI Analytics.
- [x] **Explicit `COPILOT_HOME` override only.** Definitions: the *default home* is `join(os.homedir(), '.copilot')` (hardcoded; **not** `getCopilotHome()`, which already follows the override); the *source* is `<default home>/hooks/codemie-copilot-cli-hooks.json`. In `beforeRun`, when `canonical(env.COPILOT_HOME)` differs from the default home (case-insensitive on Windows) and the source file exists:
  - write `buildHookFileContent()` to `<env.COPILOT_HOME>/hooks/codemie-copilot-cli-hooks.json` with `writeAtomically` when the file is missing or different. The file name is CodeMie-owned, so overwriting it is the same as what the connector does;
  - **never delete anything and never touch the default-home file.** A stale copy is harmless: the hook-time `isTracked` scope check ignores untracked projects;
  - if the user exported `COPILOT_HOME` globally and connected under it, the connector file is already there, the source does not exist, and nothing happens;
  - import `buildHookFileContent` dynamically from `cli/commands/proxy/connectors`, as `onSessionEnd` already does for `hook.js` (existing precedent for plugin → CLI imports).
- [x] **Session-state root for the daemon (override case only), without any wire change:** the `sessionEnd` hook (not time-critical, no 150 ms budget) writes `sessionStateRoot` into `<sessionId>.session.json` when `getCopilotSessionStateRoot()` differs from the default. The daemon final pass reads it from that local file. Nothing is stamped on events, so **`forwarder.ts` / `unwrapHookRecords()` stay byte-for-byte unchanged**.
  - Daemon validation: `realpath`; the last path segment is `session-state`; it lies under `os.homedir()` or equals the default; `realpath(<root>/<sessionId>/events.jsonl)` stays inside `realpath(root)`; and it is a regular file. Otherwise fall back to the default.
- [x] Coexistence: the managed `lifecycle.onSessionStart` / `onSessionEnd` (`processEvent` → `MetricDelta`) and the user-hooks `eventNameMapping` (`hook.ts:681`) are unchanged. Auth in the managed `preToolUse` uses the same cached `ensureCodeMieSsoAuth` as in native and Claude. Hooks use the persistent proxy daemon (`ensureOtlpProxy`), separate from the managed per-session SSO proxy.
- [x] Identity: Copilot's own `sessionId` in both modes (managed pins it to `CODEMIE_SESSION_ID`). A native `copilot` started inside a managed shell is a separate session and is tracked on its own. A managed session's proxy traffic writes nothing to CLI Analytics (there is no `agent.usage.request` producer under `sso/proxy`).

### Task 8 — Docs

- [x] `docs/ARCHITECTURE-OTLP-PLUGIN.md`: add a Copilot CLI section covering the real hook payload shapes, correlation and the two hook-side state files, Tier A / B usage, the cursor-based `agentStop` pass and the stateless final pass, resume segmentation, summary IDs, the `resolveAgentFields(input)` contract, and managed vs native.
- [x] `docs/COMMANDS.md` / `docs/CONFIGURATION.md`: only if they quote the supported Copilot version (grep for `1.0.83` and `1.0.79` in `docs/` and `README.md` and update).
- [x] `AGENTS.md` plugin table: update the `copilot-cli-otlp` note (tool and usage metrics; managed sessions tracked when connected).

---

## Part B — Backend (`epm-cdme/codemie`)

**The detailed backend plan is a separate document in the backend repo:** `docs/superpowers/plans/2026-10-28-epmcdme-16457-copilot-cli-session-analytics-backend-plan.md`. The table below is a summary.

| Task | Change |
|---|---|
| B1-fallback | **Not planned.** Only if a future Copilot build drops both `usage_record` and the message count = request count property. Spec: nullable `usage_requests.request_count`; `UsageRow` mapping (`ingestor.py:145-148`); `_BUILD_REQUESTS` uses `max(request_count)` per group and `api_call_count += coalesce(request_count, 1)`; backfill. |
| B2 Session Detail | `get_session_detail_tools` / `get_session_detail_events` (`reader.py:759-792`) read only spans/logs. Add a hook fallback behind a "no TOOL span in the session" guard: the breakdown from `invocations_hourly` kind 1 (the Session List source, so List = Detail), and the timeline from hook tool starts + a replicated `usage_requests` grouping (per-event cost 0, D1; row count must equal `cost_daily.api_call_count`). Both read rollups, so they lag until the recompute. |
| B3 Harness | `coalesce(nullif(o.service_name,''), nullif(d.platform,''))` in `get_session_detail_meta` (`reader.py:657-681`); `session_dims.platform` already carries the hook `platform` and is already joined. Add `"copilot-cli": "GitHub Copilot CLI"` in `vocabulary.py:150-164`. Only Session Detail has a harness column. |
| B4 Model-name resolution | `normalize_model` (`coding_agent_pricing.py:24`) maps dotted `claude-*` versions to dashes so cache-read pricing and `unpriced_models` resolve Copilot's `model_raw`. Lookup-only. USD cost itself stays $0 for hook-only sessions (D1). |
| B5 Attribution | No change. Common fields + `TEMPLATE_FIELDS`; `entrypoint` and `client_version` land in `session_dims` already. |

Backend facts relied on, verified in review: ingest dedup on `(type, session_id, event_id)` (`otlp.py:457-463`); `_BUILD_REQUESTS` groups by request ID + `model_raw` with `max()` of each field (`rollups.py:423-445`, `_GROUP_REACH` = 1 h) and leaves `cost_usd` NULL for requests without an OTel match, which `cost_daily` counts as 0; `cost_daily` rows exist even at $0 cost (`rollups.py:727-750`), so a session with at least one usage row enters Session List (a session with none does not); the latest summary by timestamp wins (`rollups.py:1044-1051`).

---

## Testing (required by the ticket's acceptance criteria)

Vitest, colocated `__tests__`, dynamic-import mocking (`.ai-run/guides/testing/testing-patterns.md`).

| Test file | Covers |
|---|---|
| `copilot-cli-otlp.types.test.ts` (extend) | `preToolUse` without `timestamp` accepted; other events without `timestamp` rejected; VS Code string `timestamp` rejected |
| `copilot-cli-otlp.tool-payload.test.ts` | single and batched `toolCalls`; object and string `args`/`toolArgs`; entry without id or name dropped; `resultType` failure; `sessionLog` / `toolTelemetry` not forwarded |
| `copilot-cli-otlp.tool-correlation.test.ts` | end pairs with the oldest open start (exact args, then name-only); identical parallel calls pair in order; start ID never replaced; end with no open start → `events.jsonl` lookup → orphan; open starts older than 30 min are dropped; a denied batch records nothing; budget exhaustion on `preToolUse` still emits real start IDs; concurrent writers; **stale lockfile (mtime > 2 s) is recovered, a live lock is not stolen** |
| `copilot-cli-otlp.plugin.test.ts` (extend) | **AC: 3 tool calls (2 ok, 1 failed) → 3 starts, 2 `agent.tool.end`, 1 `agent.tool.error`, correct names, paired IDs**; batched `preToolUse` → N starts with distinct `event_id`s (regression: `tool_use_id` is in the digest); `file_path` set for `create` / `edit` / `str_replace_editor` / `apply_patch` and extracted before truncation; auth failure denies once; `agentStop` sends one usage row per **new** request (the cursor never repeats a row across consecutive `agentStop`s; a rejected spool write does not advance it); sub-agent `agentStop` (`agentId`) sends nothing extra; incremental summary; skips quietly on a missing file or exhausted budget; whole-file read capped at 8 MB → `usage_partial`; `entrypoint` is `managed` only when `sessionId === CODEMIE_SESSION_ID`, `native` for a nested native session with the env var inherited |
| `copilot-cli-otlp.request-usage.test.ts` | **Tier A:** one row per `usage_record`, `request_id = apiCallId`, per-model sums = shutdown, sub-agent → `scope_kind: 'agent'`, `stop_reason = finishReason`. **Tier B / AC:** `events.193-requests.jsonl` → 193 distinct `request_id`s (`messageId`), not 2; a pre-1.0.79 fixture takes the Tier B path. **Resume:** cumulative and reset fixtures → backend-equivalent sums (group by `request_id`, `max` per field, then sum) equal the latest cumulative total or the sum of reset segments, never more. Output residual only if non-negative. `resolveCopilotBillableModel`. Re-running the full build twice yields identical `event_id`s (daemon idempotency). |
| `copilot-usage-enrichment.test.ts` (extend) | final summary with Claude field names + `started_at`/`ended_at`; two finals after a resume have distinct `event_id`s; a session with no usage rows still gets its final summary (`api_calls: 0`); the already-sent check keys on the final summary's `ended_at`, not on usage rows; `entrypoint` and `client_version` on built events (empty template version filled from `events.jsonl`); `sessionStateRoot` validation read from `<sessionId>.session.json` (`..`, symlink/junction, wrong last segment, relative, outside home) |
| `forwarder.test.ts` (extend) | no payload change: hook records are still forwarded byte for byte, with no extra fields (regression for the dropped stamp approach) |
| `OtlpAgentAdapter.test.ts` (extend) | `resolveAgentFields` receives the parsed hook input; adapters declaring no parameter keep working |
| `copilot-cli.plugin.test.ts` (**new**) | `isTracked()` no longer drops `CODEMIE_SESSION_ID`; `beforeRun` with default `COPILOT_HOME` writes and deletes nothing; with an override and an existing default-home connector file it writes the hook file there (missing / different only) and never deletes or touches the default-home file; no source file → no write; Windows case-insensitive path equality; `onSessionStart` / `onSessionEnd` run once |
| `copilot-cli.registry.test.ts` (extend) | supported version `1.0.92`, minimum `1.0.83` |
| `copilot-cli.analytics.test.ts` (extend) | the `extractCopilotToolActivity` refactor leaves managed `tools` / `toolStatus` identical; `FILE_WRITE_TOOLS` unchanged |
| Fixture lint test | fixtures contain only placeholders for paths, hosts, emails and content (Task 0) |
| Backend | hook-only session → Detail tool breakdown non-empty, harness `GitHub Copilot CLI` (see the backend plan's tests) |
| `claude-code-otlp` suites | regression only |

Policy note: `AGENTS.md` says to write tests only on explicit request. Here the ticket's acceptance criteria require them; confirm with the requester before starting Task 1.

Commands: `npx vitest run src/agents/core src/agents/plugins/copilot-cli-otlp src/agents/plugins/copilot-cli src/agents/plugins/claude-code-otlp src/providers/plugins/sso/proxy/plugins/otlp-spool`, then `npm run lint`, `npm run typecheck` and `npm run build`.

Preview E2E (both modes, Preview backend; **requires backend B2 / B3 / B4 deployed to Preview, gate G4**). Backend Detail tools, timeline and harness also wait for the backend rollup recompute after the CLI forwards the session (backend plan B2.1), and cost shows $0 (G5 / D1). Hooks-only sessions are forwarded after the spool's hooks-only wait: with the defaults (2 min send interval × 3 ticks) a session shows up about 6–8 minutes after exit. For E2E set `OTLP_SEND_INTERVAL_MINUTES=0.25` and `OTLP_SEND_MAX_ATTEMPTS=1` in the daemon environment (then about 30–60 s), and restart the daemon. are forwarded after the spool's hooks-only wait: with the defaults (2 min send interval × 3 ticks) a session shows up about 6–8 minutes after exit. For E2E set `OTLP_SEND_INTERVAL_MINUTES=0.25` and `OTLP_SEND_MAX_ATTEMPTS=1` in the daemon environment (then about 30–60 s), and restart the daemon.

1. **Managed** `codemie-copilot` in a connected project: 3-tool scenario. Session List = Detail = Overview for tools, API calls, duration, models, harness `GitHub Copilot CLI`, project/branch, and `entrypoint: managed`. Then `codemie proxy disconnect` the project and relaunch: no new CLI Analytics session.
2. **Native** `copilot`: same scenario plus a batched turn and a mid-session model switch. Usage arrives within the forwarding window above (the enrichment itself finishes within 10 s of exit).
3. **Resume** a native session (`copilot --resume`) and run one more turn: API calls and tokens equal the cumulative shutdown total, not old + new. Run it on 1.0.92 (Tier A) **and** on a pre-1.0.92 build (Tier B).
4. **Kill** a native session after ≥ 2 turns (`kill -9` on macOS / Linux, `Stop-Process -Id <pid> -Force` on Windows): it appears in Session List with the exact API-call count and tools. `usage_partial` is checked on the **raw ingested summary**, not the UI.
5. Native `copilot` inside a managed shell: two sessions, each counted once; the native one is labelled `entrypoint: native`.
6. Claude Code session: metrics unchanged.

---

## Delivery order

1. Task 0: fixtures and version checks (closes G2), and the `AGENTS.md` test-policy confirmation.
2. Task 6a (version bump) can ship in parallel; it is independent of the rest.
3. Tasks 1 → 2 → 3 (native tool tracking).
4. Task 5, then Task 4 (usage, summaries, `agentStop`, stateless final pass).
5. Task 6 (needs the base-class change, G1), then Task 7, then Task 8.
6. Backend B2, B3, B4 (G4) and the D1 confirmation (G5), merged / confirmed before or with the CLI release. CLI events use the existing contract, and the new summary attributes are additive.

## Known limitations (accepted)

- **Tier B** (any Copilot build without `usage_record`, i.e. below 1.0.92): each model's input/cache/reasoning totals per shutdown segment sit on that segment's last request. Totals, cost and context-per-call are exact; per-request sizes are not. If a session is killed before its first shutdown, input/cache tokens are missing (`usage_partial`). Managed sessions use Tier A once the recommended version is installed.
- **Tier B:** a segment whose totals match neither the cumulative nor the reset pattern is left without input/cache tokens and flagged `usage_partial`, rather than guessed.
- **`agentStop` reads** are skipped when the budget runs out. A killed session then reports usage only up to the last successful pass.
- **Files over 8 MB:** the hook and the final pass read only the tail and set `usage_partial`.
- **Final pass re-sends all rows** (same `event_id`s, deduplicated by the backend). The cost is spool volume only.
- **Managed `--resume` / `--continue` sessions** are labelled `entrypoint: native` (no session pinning); they are counted once.
- **Raising the minimum Copilot version to 1.0.83** blocks managed launch for users on 1.0.79–1.0.82 until they upgrade.
- **Backend USD cost is $0** for hook-only Copilot sessions (D1, same as hook-only Claude); only cache-read cost is priced, and only for model names the backend resolves (B4).
- **A session with no usage row** (killed before its first `agentStop`) has no backend cost row and is not listed in Session List.

## Resolved questions

1. **Tool correlation:** real IDs come from `preToolUse.toolCalls[].id`; ends pair with open starts; start IDs are never replaced. Totals come from the summary (backend `rollups.py:1191-1205`).
2. **Native `copilot` inside a managed shell:** tracked as its own session, under the same connect + scope rule as Claude.
3. **`premium_requests`:** not sent (strict Claude parity).
4. **No `session.shutdown` (crash/kill):** usage rows are sent at each `agentStop`. Tier A rows are complete. Tier B rows carry exact counts and output tokens but no input/cache (`usage_partial`).
5. **Resume:** Tier A is unaffected (unique `apiCallId`; the fresh-state `agentStop` read and the final pass re-send the same `event_id`s). Tier B splits at each shutdown and classifies totals as cumulative or reset by request count (both patterns occur in real data).
6. **Backend dependency:** the backend plan exists (`epm-cdme/codemie`, same file name under `docs/superpowers/plans/`) and is aligned with this one (B2 / B3 / B4, decisions D1–D3); only the Preview E2E and the release depend on it (G4, G5).
