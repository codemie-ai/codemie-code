# EPMCDME-15301 Sub-stage 1.1 — Common Fields, Transcript Parsing, New Usage Events

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the `claude-code-otlp` analytics pipeline with common fields on every `agent.*` event, incremental persisted transcript parsing, three new events (`agent.usage.request`, `agent.subagent.usage`, `agent.session.summary`), story resolution, and an extended identity chain — per `spec.md`.

**Architecture:** Two layers already exist and are extended, not replaced. (1) Hook-side (`ClaudeCodeOtlpPlugin.processOtlpEvent`, runs once per Claude Code hook invocation, CLI process, must exit 0): `evaluate()` dispatches one handler per hook event name; the handlers for `Stop`/`PreCompact`/`StopFailure`/`SessionEnd`/`SubagentStop` call the transcript orchestrator (`transcript/orchestrator.ts`'s `collectMainTranscriptEvents`/`collectSubagentTranscriptEvents`), which *returns* zero or more derived, explicitly-`type`d synthetic records rather than forwarding them itself; the handler appends those to the original parsed event in its `ForwardDecision.payload`. `processOtlpEvent()` then merges a small set of agent-owned common fields onto every record in that payload (`withCommonFields()`) and is the **one** call site that forwards to the spool (`forwardToSpool()`, looping over the payload and calling the shared `forwardOtlpEventToSpool()` per record) — this is also where each record's `event_id` is stamped (`randomUUID()`, inside `forwardOtlpEventToSpool()`). (2) Daemon-side (`forwarder.ts`, long-running proxy tick): stamps `schema_version`, `codemie_cli_version`, `story_id`/`story_source`, `developer_name`/`identity_source` onto every record — old and new — in `mapHookRecords()`, carrying the already-stamped `event_id` straight through.

**Tech Stack:** TypeScript, Node `node:fs/promises`/`node:crypto`/`node:child_process`, Vitest. No new runtime dependencies.

## Global Constraints

- `schema_version = 2` on every event. `platform = 'claude-code'` (constant).
- Truncation unchanged: prompt 200 chars (`MAX_PROMPT_CHARS`), tool input/output/error 300 chars (`MAX_TOOL_FIELD_CHARS`) — both already defined in `forwarder.ts:37-38`.
- Hooks/orchestration stay `async`, swallow all exceptions internally, never throw past the top-level handler, never block Claude Code.
- Node only, no new npm dependencies.
- `event_id` is a `randomUUID()` stamped once per record, hook-time, inside `forwardOtlpEventToSpool()` — the one chokepoint every record (original and derived alike) passes through on its way to the spool.
- Only the *resolved* `story_id`/`story_source` is ever sent — never raw prompt text. Nothing in this sub-stage writes `.claude/analytics.local.json` (read-only here).
- Ticket regex (shared constant): `/(?<![A-Za-z0-9])[A-Z][A-Z0-9]+-\d+(?!\d)/gi`, result upper-cased.
- Identity chain priority: `jwt → git → codemie_cli → os`.
- Out of scope (do not touch): `agent.session.env`, `agent.skill.dispatch`, `agent.git.snapshot`, and any change to existing-event *content* beyond the common fields.
- Commit per task using the repository's existing convention.

---

### Task 1: Event IDs + schema/version stamp for existing events

`event_id` is a `randomUUID()` stamped once per record, hook-time, inside the already-shared `forwardOtlpEventToSpool()` (`src/agents/plugins/utils.ts`) — the one chokepoint every record (original hook event and derived synthetic event alike) already passes through. `mapHookRecords()` (`forwarder.ts`) carries that value straight through (`event_id: hookEvent['event_id'] as string`) instead of computing it; it also stamps `schema_version: 2` and `codemie_cli_version` (resolved once via `resolveCodemieCliVersion()` in `forward-context.ts`) on every mapped record, old and new.

**Files:**
- Modify: `src/agents/plugins/utils.ts` — `forwardOtlpEventToSpool()` stamps `event_id: randomUUID()` onto the event before spooling it.
- Modify: `src/providers/plugins/sso/proxy/plugins/otlp-spool/forwarder.ts` — `hookEventType()` prefers an explicit `hookEvent['type']` string over the `HOOK_EVENT_TYPE_MAP` lookup (needed so synthetic records from later tasks keep their own type); `mapHookRecords()` stamps `schema_version: 2`, `codemie_cli_version`, and carries through the already-stamped `event_id`.
- Test: `src/providers/plugins/sso/proxy/plugins/otlp-spool/__tests__/forwarder.test.ts`.

**Interfaces:**
- Produces: nothing new — `forwardOtlpEventToSpool(event, agentName): Promise<void>` (pre-existing shared helper) now also stamps `event_id`.

**Test-first: yes — `mapHookRecords()` on two records yields two different `event_id`s (carried through from the input) and both carry `schema_version: 2`.**

- [x] Write failing tests for `mapHookRecords` stamping `schema_version`/`event_id`/`codemie_cli_version`.
- [x] Implement the `utils.ts`/`forwarder.ts` edits.
- [x] Run `npx vitest run src/providers/plugins/sso/proxy/plugins/otlp-spool/__tests__/forwarder.test.ts` — PASS.
- [x] Commit.

---

### Task 2: Agent-owned common fields (`withCommonFields`)

**Files:**
- Create: `src/agents/plugins/claude-code-otlp/client-version-cache.ts` — `resolveClientVersion()`: runs `claude --version` and caches the result in a TTL file cache (1h) under `getCodemiePath('cache', 'claude-code-client-version.json')`, since each hook fire is a fresh CLI process with no in-memory instance to cache on.
- Modify: `src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts` — add a private `withCommonFields(records)` that merges `{ platform: 'claude-code', entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? '', client_version: await resolveClientVersion() }` onto every record, called once from `processOtlpEvent()` on the full `ForwardDecision.payload` just before `forwardToSpool()`.
- Test: `src/agents/plugins/claude-code-otlp/__tests__/client-version-cache.test.ts`, `__tests__/claude-code-otlp.plugin.test.ts`.

**Interfaces:**
- Produces: `resolveClientVersion(): Promise<string>` (`client-version-cache.ts`); `ClaudeCodeOtlpPlugin.withCommonFields(records: Record<string, unknown>[]): Promise<Record<string, unknown>[]>` (private).
- `agent_id`/`agent_type` are **not** produced here — they arrive verbatim on raw subagent-shaped hook payloads, or are sourced inside the Task 8/9 transcript builders.

**Test-first: yes — `resolveClientVersion()` spawns `claude --version` once and serves the cached value on a second call within the TTL; `withCommonFields()` on two records stamps identical `platform`/`entrypoint`/`client_version` onto both.**

- [x] Write failing tests (mock `exec()`/the cache file to assert single invocation across two calls within the TTL).
- [x] Implement.
- [x] Run `npx vitest run src/agents/plugins/claude-code-otlp/__tests__/client-version-cache.test.ts src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.plugin.test.ts` — PASS.
- [x] Commit.

---

### Task 3: Identity resolution chain

**Files:**
- Create: `src/providers/plugins/sso/proxy/plugins/otlp-spool/identity.ts`
- Modify: `forwarder.ts:67-81,273-288` — `buildForwardContext()` calls the new resolver once per tick instead of the inline `resolveUserEmail()`; `mapHookRecords()` stamps `developer_name`/`identity_source` from the resolved result.
- Test: `src/providers/plugins/sso/proxy/plugins/otlp-spool/__tests__/identity.test.ts`.

**Interfaces:**
- Produces: `resolveIdentity(credentials: SSOCredentials | JWTCredentials, cwd: string): Promise<{ developerName: string; identitySource: 'jwt' | 'git' | 'codemie_cli' | 'os' | '' }>` — tries, in order: existing JWT-claims logic (moved from `resolveUserEmail`), `git config user.email` / `user.name` via `exec()`, the existing `codemie_cli` profile config loader, `os.userInfo().username`. First non-empty wins.

**Test-first: yes — with JWT absent/empty, `resolveIdentity` falls through to git email when `git config user.email` succeeds, and to `os.userInfo().username` when every other tier is empty.**

- [x] Write failing tests covering: jwt hit, jwt-miss→git-hit, all-miss→os-fallback.
- [x] Implement `identity.ts`, wire into `forwarder.ts`.
- [x] Run `npx vitest run src/providers/plugins/sso/proxy/plugins/otlp-spool/__tests__/identity.test.ts` — PASS.
- [x] Commit.

---

### Task 4: Story resolution — explicit + branch tiers (non-prompt events)

**Files:**
- Create: `src/providers/plugins/sso/proxy/plugins/otlp-spool/story-resolver.ts`
- Modify: `forwarder.ts:200-213,273-288` — `buildForwardContext()` resolves explicit/branch story once per tick (same per-tick-cache shape as `resolveGitInfo`); `mapHookRecords()` stamps `story_id`/`story_source` on every non-`agent.prompt.submit` record.
- Modify: `.gitignore` — add `.claude/analytics.local.json`.
- Test: `src/providers/plugins/sso/proxy/plugins/otlp-spool/__tests__/story-resolver.test.ts`.

**Interfaces:**
- Produces: `TICKET_RE` (exported shared regex, per Global Constraints), `resolveExplicitStory(cwd: string): Promise<{ storyId: string; storySource: 'explicit' } | null>` (checks `SDLC_ANALYTICS_STORY_ID` env first, then reads `<cwd>/.claude/analytics.local.json`'s `storyId` field — read-only, never writes it), `resolveBranchStory(branch: string): { storyId: string; storySource: 'branch' } | null` (first `TICKET_RE` match).

**Test-first: yes — `resolveExplicitStory` prefers the env var over the file when both are set; `resolveBranchStory` extracts `EPMCDME-15301` from `feature/epmcdme-15301-foo` uppercased.**

- [x] Write failing tests for both resolvers plus the regex's word-boundary behavior (no match inside `ABC-123X`).
- [x] Implement `story-resolver.ts`, wire into `forwarder.ts`, add the `.gitignore` line.
- [x] Run `npx vitest run src/providers/plugins/sso/proxy/plugins/otlp-spool/__tests__/story-resolver.test.ts` — PASS.
- [x] Commit.

---

### Task 5: Story resolution — marker/mention tiers (`agent.prompt.submit`)

**Files:**
- Modify: `story-resolver.ts` (Task 4) — add the marker/mention tiers.
- Modify: `forwarder.ts:221-269` — in `mapHookRecords()`, for records whose `hookEvent['hook_event_name'] === 'UserPromptSubmit'`, resolve against the record's own **untruncated** `hookEvent['prompt']` (read before `limitHookPayload()` truncates it) in priority order explicit → marker → branch → mention, overriding the per-tick explicit/branch result from Task 4 only when a higher-priority prompt-level tier exists.
- Test: extend `__tests__/story-resolver.test.ts`.

**Interfaces:**
- Produces: `resolveMarkerStory(promptText: string): { storyId; storySource: 'marker' } | null` (matches `story: X` / `ticket #X`, case-insensitive), `resolveMentionStory(promptText: string): { storyId; storySource: 'mention' } | null` (bare `TICKET_RE` match anywhere in the text).

**Test-first: yes — a prompt containing `story: EPMCDME-999` resolves to `storySource: 'marker'` even when the branch carries a different ticket; a prompt with no marker but a bare `ABC-42` mention resolves to `storySource: 'mention'`; the raw prompt text itself is never present on the emitted record (only `prompt_body`, truncated, and `story_id`/`story_source`).**

- [x] Write failing tests for marker precedence over mention, and for the no-match case falling back to the Task 4 branch/explicit result.
- [x] Implement.
- [x] Run `npx vitest run src/providers/plugins/sso/proxy/plugins/otlp-spool/__tests__/story-resolver.test.ts` — PASS.
- [x] Commit.

---

### Task 6: Transcript parse-state persistence

**Files:**
- Create: `src/agents/plugins/claude-code-otlp/transcript/parse-state.ts`
- Test: `src/agents/plugins/claude-code-otlp/transcript/__tests__/parse-state.test.ts`.

**Interfaces:**
- Produces:
```ts
export interface OpenUsageRequest {
  requestId: string; model: string; modelRaw: string; timestamp: string;
  speed: string; inferenceGeo: string; serviceTier: string;
  inputTokens: number; cacheCreation5mTokens: number; cacheCreation1hTokens: number;
  cacheReadTokens: number; outputTokens: number;
  webSearchRequests: number; webFetchRequests: number;
  scopeKind: 'main' | 'skill' | 'agent'; scopeName: string; agentId: string;
  stopReason: string; isApiError: boolean; gitBranch: string;
}
export interface TranscriptParseState {
  mainOffset: number;
  subagentOffsets: Record<string, number>;
  openRequests: Record<string, OpenUsageRequest>; // key: `${requestId}::${model}`
  activeSkill: string;
  branchCounts: Record<string, number>;
  compactionCount: number; // persisted count of this session's PreCompact triggers, feeds agent.session.summary's compaction_count
}
export function createParseState(): TranscriptParseState;
export async function loadParseState(sessionId: string): Promise<TranscriptParseState>; // missing or corrupt file -> fresh state, never throws
export async function saveParseState(sessionId: string, state: TranscriptParseState): Promise<void>;
export async function withParseStateLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T>; // serializes concurrent load-mutate-save cycles for one session via an exclusive-create lock file
```
Stored at `getCodemiePath('analytics', 'state', `${sessionId}.json`)` (`src/utils/paths.ts:385`), directory created on write.

**Test-first: yes — `loadParseState` on a missing file returns `createParseState()`'s fresh shape; on a corrupt JSON file it also recovers to fresh rather than throwing; `saveParseState` followed by `loadParseState` round-trips `openRequests` and `branchCounts` exactly.**

- [x] Write failing tests for missing/corrupt/round-trip.
- [x] Implement `parse-state.ts`.
- [x] Run `npx vitest run src/agents/plugins/claude-code-otlp/transcript/__tests__/parse-state.test.ts` — PASS.
- [x] Commit.

---

### Task 7: Incremental transcript reader

**Files:**
- Create: `src/agents/plugins/claude-code-otlp/transcript/transcript-reader.ts`
- Test: `.../__tests__/transcript-reader.test.ts`.

**Interfaces:**
- Produces: `readNewLines(filePath: string, fromOffset: number): Promise<{ lines: string[]; nextOffset: number }>` — reads bytes from `fromOffset` to EOF, cuts at the last `\n` (same safe-cut rule as `spool-io.ts:122-144`'s `snapshotPendingHookRecords`) so a partially-written trailing line is never returned; returns `{ lines: [], nextOffset: fromOffset }` when the file is missing or has no new complete line.

**Test-first: yes — a file with two complete lines plus a trailing unterminated partial line returns only the two complete lines and `nextOffset` points exactly after the second line's newline; a second call starting from that offset returns only lines appended afterwards.**

- [x] Write failing tests (fixture file written incrementally across two reads).
- [x] Implement.
- [x] Run `npx vitest run src/agents/plugins/claude-code-otlp/transcript/__tests__/transcript-reader.test.ts` — PASS.
- [x] Commit.

---

### Task 8: `agent.usage.request` extraction and merge

**Files:**
- Create: `src/agents/plugins/claude-code-otlp/transcript/usage-request.ts`
- Test fixture: `src/agents/plugins/claude-code-otlp/transcript/__tests__/fixtures/transcript-usage.jsonl` (new — modeled on the confirmed shape in `spec.md`'s "Transcript field shape" section: `message.id`, `message.usage.{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens,service_tier,speed,inference_geo}`, `message.usage.cache_creation.{ephemeral_1h_input_tokens,ephemeral_5m_input_tokens}`, `message.usage.server_tool_use.{web_search_requests,web_fetch_requests}`, `message.stop_reason`, top-level `gitBranch`).
- Test: `.../__tests__/usage-request.test.ts`.

**Interfaces:**
- Produces:
  - `parseUsageLine(line: string, scopeKind: 'main'|'skill'|'agent', scopeName: string, agentId: string): OpenUsageRequest | null` — returns `null` for lines with no `message.usage`; `request_id` = `message.id` (not `requestId` — see spec's Open risks); `model`/`model_raw` via `parseBackendModelName()`/`parseRoutingHeaders()` from `@/utils/routing-headers.mjs` and `@/utils/bedrock-pricing.mjs` (same resolution the statusline and `usage-readers.ts:188` already use).
  - `mergeUsageRequest(a: OpenUsageRequest, b: OpenUsageRequest): OpenUsageRequest` — every numeric field takes `Math.max`; non-numeric fields (`stopReason`, `isApiError`, `gitBranch`, etc.) take `b`'s value when non-empty, else `a`'s.
  - `buildUsageRequestEvent(sessionId: string, req: OpenUsageRequest): Record<string, unknown>` — `{ type: 'agent.usage.request', session_id: sessionId, request_id: req.requestId, model_raw, model, speed, inference_geo, service_tier, input_tokens, cache_creation_5m_tokens, cache_creation_1h_tokens, cache_read_tokens, output_tokens, web_search_requests, web_fetch_requests, scope_kind, scope_name, agent_id, stop_reason, is_api_error, git_branch, timestamp }` (`event_id`/`schema_version` stamped later by Task 1's daemon-side code, since this record carries an explicit `type`).

**Test-first: yes — on a fixture with two JSONL lines for the same `message.id`+model where the second has a higher `output_tokens` and a `stop_reason` the first lacks, `mergeUsageRequest` of the two parsed records keeps the max `output_tokens` and the non-empty `stop_reason`; a line with no `usage` block parses to `null`.**

- [x] Write failing tests against the fixture.
- [x] Implement `usage-request.ts`.
- [x] Run `npx vitest run src/agents/plugins/claude-code-otlp/transcript/__tests__/usage-request.test.ts` — PASS.
- [x] Commit.

---

### Task 9: `agent.subagent.usage` builder

**Files:**
- Create: `src/agents/plugins/claude-code-otlp/transcript/subagent-usage.ts`
- Test: `.../__tests__/subagent-usage.test.ts` with 2-3 fixture subagent transcript+`.meta.json` pairs under a temp `<session>/subagents/` directory.

**Interfaces:**
- Produces:
  - `interface SubagentFile { agentId: string; filePath: string; toolUseId?: string; agentType?: string; spawnDepth?: number; }` and `findSubagentFiles(mainTranscriptPath: string): Promise<SubagentFile[]>` — own implementation (the existing `findSubagentFiles` in `src/agents/plugins/claude/claude.session.ts:384` is `private` and not exported, so this is a fresh, smaller implementation reading `<parentDir>/<sessionId>/subagents/agent-*.jsonl` + sibling `.meta.json`, same path convention). `description`/`workflow_run`/`worktree` have no identified source in the sidecar (per spec's Open risks) — emit them as empty string, never fabricated.
  - `buildSubagentUsageEvent(sessionId: string, file: SubagentFile, usageRequests: OpenUsageRequest[], toolCalls: Record<string, number>, toolErrors: Record<string, number>, skillsInvoked: Record<string, number>, startedAt: string, durationMs: number): Record<string, unknown>` — `type: 'agent.subagent.usage'`, tokens/`api_calls` aggregated by summing `usageRequests` (reusing Task 8's `OpenUsageRequest` fields), `spawn_depth` defaults to `0` when the sidecar omits it (top-level subagents, per spec's Open risks — not treated as an error).

**Test-first: yes — a session fixture with three subagent transcript files produces three `agent.subagent.usage` events whose summed token fields equal the sum of the `agent.usage.request` records this same fixture yields with `scope_kind: 'agent'` (the external data-model doc's §8 acceptance scenario).**

- [x] Write the failing cross-check test plus a `spawn_depth`-missing-sidecar case.
- [x] Implement `subagent-usage.ts`.
- [x] Run `npx vitest run src/agents/plugins/claude-code-otlp/transcript/__tests__/subagent-usage.test.ts` — PASS.
- [x] Commit.

---

### Task 10: `agent.session.summary` builder

**Files:**
- Create: `src/agents/plugins/claude-code-otlp/transcript/session-summary.ts`
- Test: `.../__tests__/session-summary.test.ts`.

**Interfaces:**
- Produces:
  - `interface SessionSummaryAccumulator { models: Record<string, number>; toolCalls: Record<string, { calls: number; errors: number }>; linesAdded: number; linesRemoved: number; filesChanged: Set<string>; filesWritten: Set<string>; compactionCount: number; }` and `updateBranchCounts(counts: Record<string, number>, branch: string): void` (bumps `counts[branch]`, mutates the `TranscriptParseState.branchCounts` from Task 6).
  - `primaryModel(models: Record<string, number>): string`, `branchDominant(counts: Record<string, number>): string` — both return the highest-count key, `''` when empty.
  - `buildSessionSummaryEvent(sessionId: string, phase: 'incremental' | 'final', acc: SessionSummaryAccumulator, named: NamedInvocationCounts, branchCounts: Record<string, number>, startedAt: string, endedAt: string | undefined): Record<string, unknown>` — `named` comes from `extractNamedInvocations()` (`src/agents/plugins/claude/session/claude-named-invocations.ts`, directly imported) for `skills_used`/`commands_in_order`/`primary_command`; `type: 'agent.session.summary'`.

**Test-first: yes — a `branchCounts` map built from a mid-session branch switch (`{main: 3, feature: 7}`) resolves `branch_dominant: 'feature'` (the external data-model doc's §8 branch-switch scenario); `buildSessionSummaryEvent` with `phase: 'incremental'` omits `endedAt` and with `phase: 'final'` includes it.**

- [x] Write failing tests for `branchDominant`, `primaryModel`, and both phases.
- [x] Implement `session-summary.ts`.
- [x] Run `npx vitest run src/agents/plugins/claude-code-otlp/transcript/__tests__/session-summary.test.ts` — PASS.
- [x] Commit.

---

### Task 11: Orchestrate main-transcript triggers (`Stop`, `PreCompact`, `StopFailure`, `SessionEnd`)

The orchestrator does not forward anything itself — it `return`s the derived events, and the plugin's own `evaluate()`/`forwardToSpool()` chokepoint is what actually sends them, so there is exactly one place in the pipeline that writes to the spool (per `docs/ARCHITECTURE-OTLP-PLUGIN.md` §3.4). Load-mutate-save runs inside a per-session lock (`withParseStateLock`, Task 6) so forwarding only ever sees fully-persisted state.

**Files:**
- Create: `src/agents/plugins/claude-code-otlp/transcript/orchestrator.ts`
- Modify: `src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts` — `evaluate()` dispatches `Stop`/`PreCompact`/`StopFailure`/`SessionEnd` each to their own handler method (`onStopEvent`/`onPreCompactEvent`/`onStopFailureEvent`/`onSessionEndEvent`), which calls `collectMainTranscriptEvents()` and returns `{ decision: 'forward', payload: [parsed, ...derived] }` — the handler never forwards directly.
- Test: `src/agents/plugins/claude-code-otlp/transcript/__tests__/orchestrator.test.ts`.

**Interfaces:**
- Produces: `collectMainTranscriptEvents(sessionId: string, transcriptPath: string, trigger: 'Stop' | 'PreCompact' | 'SessionEnd' | 'StopFailure'): Promise<Record<string, unknown>[]>` — loads state under the per-session lock (Task 6), reads new lines (Task 7), derives/merges `agent.usage.request` records (Task 8) keyed into `state.openRequests`, updates `state.branchCounts`/`state.compactionCount` (bumped on `PreCompact`), builds one event per completed `agent.usage.request` plus one `agent.session.summary` (`phase: 'incremental'` on `Stop`, `'final'` on `SessionEnd`; `PreCompact`/`StopFailure` return only usage requests, never a summary — matches spec), saves state, **returns** the built events (does not forward them), and swallows every error internally, returning `[]` on failure (never throws into `processOtlpEvent`).

**Test-first: yes — calling `collectMainTranscriptEvents` twice with the same transcript (simulating a re-parse after a crash before state was saved) returns `agent.usage.request` events whose natural-key fields (`request_id`, `model`) are identical both times — the idempotent-reparse scenario from the external data-model doc's §8. (`event_id` itself is not idempotent across these two calls — see spec.md's Open risks; the natural key is what's actually stable.)**

- [x] Write the failing idempotent-reparse test (on natural key, not `event_id`) plus a basic Stop → one summary + N usage-request results test.
- [x] Implement `orchestrator.ts` and the `claude-code-otlp.plugin.ts` per-handler wiring.
- [x] Run `npx vitest run src/agents/plugins/claude-code-otlp/transcript/__tests__/orchestrator.test.ts` — PASS.
- [x] Commit.

---

### Task 12: Orchestrate subagent triggers (`SubagentStop`, `SessionEnd` backstop)

Same return-not-forward design as Task 11: the function returns its derived events rather than sending them.

**Files:**
- Modify: `orchestrator.ts` (Task 11) — add the subagent path.
- Modify: `claude-code-otlp.plugin.ts` — `onSubagentStopEvent` reads `agent_transcript_path`/`agent_id`/`tool_use_id`/`agent_type` off the parsed hook event, builds a `SubagentFile`, and calls `collectSubagentTranscriptEvents()`; `onSessionEndEvent` additionally calls `findSubagentFiles()` (Task 9) and runs it for **every** subagent file discovered, not just ones already seen — the crashed/missed-hook backstop.
- Test: extend `__tests__/orchestrator.test.ts`.

**Interfaces:**
- Produces: `collectSubagentTranscriptEvents(sessionId: string, subagentFile: SubagentFile): Promise<Record<string, unknown>[]>` — reads new lines from `state.subagentOffsets[subagentFile.agentId]` (Task 7) under the per-session lock, derives `agent.usage.request` with `scope_kind: 'agent'` (Task 8), builds one `agent.subagent.usage` (Task 9) summarizing this agent's *cumulative* usage, saves the updated offset back into the shared `TranscriptParseState`, and **returns** the built events rather than forwarding them.

**Test-first: yes — a `SessionEnd` on a session with three subagent files, only one of which already has a `SubagentStop`-advanced offset, still returns three `agent.subagent.usage` events (the backstop); a subagent whose offset shows nothing new since the last run still returns its (unchanged) cumulative `agent.subagent.usage` summary rather than being skipped — that re-run guarantee is the whole point of the backstop.**

- [x] Write the failing backstop test (three fixture subagents, one pre-advanced offset) and a no-new-bytes-still-returns-cumulative-summary test.
- [x] Implement.
- [x] Run `npx vitest run src/agents/plugins/claude-code-otlp/transcript/__tests__/orchestrator.test.ts` — PASS.
- [x] Commit.

---

## Self-Review Notes

- **Spec coverage:** Common fields (Tasks 1-3), story resolution (4-5), transcript parse-state (6-7), the three new events (8-10), and the four trigger wirings (11-12) each map to a numbered spec section. The privacy "never raw prompt text" constraint is enforced structurally (only the resolved `story_id`/`story_source` ever leaves `mapHookRecords()`) rather than left to each task's judgment.
- **Non-goals respected:** no task touches `agent.session.env`, `agent.skill.dispatch`, `agent.git.snapshot`, or any existing event's own content fields — only the common-field wrapper in `mapHookRecords()`.
- **Type consistency:** `OpenUsageRequest` (Task 6) is the one shape Tasks 8, 9, and 11/12 all import and merge/aggregate — no parallel redefinition. `TranscriptParseState` (Task 6) is the single state object Tasks 7, 11, and 12 all read/mutate/save.
