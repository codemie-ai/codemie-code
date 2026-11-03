# EPMCDME-15301 sub-stage 1.1 — expanded fields and new usage events (OTLP analytics pipeline)

## Goal

Extend the existing `claude-code-otlp` pipeline (`forwarder.ts` / `otlp-spool` / `claude-code-otlp.plugin.ts`) with:

- Common fields on every emitted `agent.*` event.
- Incremental transcript re-parsing on every trigger, backed by persisted per-session parse state.
- Three new events: `agent.usage.request`, `agent.subagent.usage`, `agent.session.summary`.
- Story/ticket resolution.
- An extended identity chain.

This is additive to the existing 13-event `agent.*` taxonomy already produced by `HOOK_EVENT_TYPE_MAP`/`mapHookRecords()` (`forwarder.ts:16-29,221-269`); no server (`codemie`) changes.

## Common fields

Every field below is sent on **every** emitted event. Split by *where* each is computed:

- **Plugin-owned, resolved hook-time inside `processOtlpEvent` itself.** `ClaudeCodeOtlpPlugin.withCommonFields()` (private, `claude-code-otlp.plugin.ts`) merges a small object onto every record in a `ForwardDecision`'s payload — the original hook event and any transcript-derived synthetic events alike — right before `forwardToSpool()` sends them.
  - `platform` — the literal `'claude-code'`.
  - `entrypoint` — `process.env.CLAUDE_CODE_ENTRYPOINT ?? ''`, read live.
  - `client_version` — `resolveClientVersion()` (`client-version-cache.ts`): runs `claude --version` once and caches the result in a TTL file cache under `getCodemiePath('cache', ...)` (1h TTL). A *file* cache, not an in-memory one — each hook fire is a fresh CLI process, so there's no live instance to memoize on across calls.
  - `agent_id`/`agent_type` are **not** common fields. They either arrive verbatim on the raw hook payload for subagent-shaped hook events (`SubagentStart`/`SubagentStop`, passed through as-is) or are sourced inside the transcript builders themselves (`agent.usage.request`/`agent.subagent.usage`, see "New events" below) — not through any shared enrichment step.

- **Daemon-side, client-agnostic** — computed once per forward tick in `buildForwardContext()` and stamped onto every record in `mapHookRecords()` (`forwarder.ts`), the same pattern already used today for `user_email`/`developer_name`/`git_branch`/`repo_remote`/`codemie_project_name`:
  - `schema_version=2`
  - `event_id`
  - `codemie_cli_version` — the running `@codemieai/code` package's own `version` field in `package.json` (currently `0.15.4`).
  - `story_id`/`story_source`
  - `developer_name`/`identity_source`

## `event_id`

One mechanism for every event, old and new: a `randomUUID()` stamped once, hook-time, inside `forwardOtlpEventToSpool()` (`src/agents/plugins/utils.ts`) — the single chokepoint every record (the original hook event and every transcript-derived synthetic event alike) already passes through on its way to the spool. `mapHookRecords()` (`forwarder.ts`) carries that value straight through (`event_id: hookEvent['event_id']`) rather than computing anything daemon-side; `schema_version`/`codemie_cli_version` are still stamped there.

Because `event_id` is generated fresh on every forward rather than derived from a record's natural key, it does not provide dedup across re-parses — see "Open risks" below.

## Transcript re-parsing

Needed to produce the three new events (`agent.usage.request`, `agent.subagent.usage`, `agent.session.summary`), none of which exist in the hook payload itself — unlike the existing 13 events, which just map that payload, these have to be derived by reading and parsing the transcript file.

Per the data-model doc (§5.1), parsing is **incremental and backed by persisted per-session state** at `~/.codemie/analytics/state/<session_id>.json`:

- **State holds**: the byte offset already consumed in the main transcript, and separately for each subagent transcript; the `openRequests` max-merge-in-progress map; `activeSkill`; `branchCounts` (feeds `branch_dominant`); `compactionCount` (persisted count of this session's `PreCompact` triggers, feeds `agent.session.summary`'s `compaction_count`).
- **Triggers**: `Stop`, `SubagentStop`, `PreCompact`, `StopFailure`, `SessionEnd` — each reads only the bytes appended since its stored offset, updates the running tallies, derives any newly-complete records, writes the updated state back to disk, then sends. Each session's load-mutate-save cycle is serialized by a per-session exclusive-create lock file (`withParseStateLock`, `parse-state.ts`) so concurrent hook processes for the same session (e.g. sibling `SubagentStop` fires) can't race on the shared state file; a stale lock (holder crashed) is detected and stolen rather than awaited forever.
- **Recovery path**: if the state file is missing (first run for a session) or fails to parse (corruption), fall back to a full parse from byte `0` and treat every record as newly derived. Because `event_id` is generated fresh at forward-time (see "`event_id`" above) rather than derived from a record's natural key, a record re-derived this way is assigned a new `event_id` — the backend sees a new record, not an update to the original. See Open risks.
- Stays `async`, swallows all errors internally (matching `hook.ts`'s existing try/catch + `process.exitCode` convention), and always exits 0.

## Transcript field shape (verified against real transcripts)

Verified against real Claude Code session transcripts (current client, multiple projects/sessions) and cross-checked against the existing production parser `src/cli/commands/analytics/cost/usage-readers.ts` (`ClaudeRawMessage`/`extractClaudeUsageRecords`), which already parses most of this same shape for the unrelated cost-reporting pipeline — prior art to adapt, not a blank slate:

- **No top-level `requestId` field appears on any real transcript line observed.** It is not declared in this repo's own `claude-message-types.ts` `ClaudeMessage` type either. `usage-readers.ts` already treats it as optional and falls back to `message.id` alone when absent (`const key = id || reqId ? ... : null`) — the existing production code already assumes `requestId` may not be there.
- **Use `message.id`** (the API-level message id, stable across streaming chunks for one response) **as `request_id`.** It is present on every usage-bearing line sampled and is the only reliable per-response identity. This also means the `agent.usage.request` `event_id` keys on `message.id`, not a field that in practice is always empty — had it keyed on the literal absent `requestId`, every request for a given model within a session would collide onto the same `event_id` and overwrite rather than accumulate.
- **`message.stop_reason`** sits directly on `message`, as a sibling of `usage` — not nested inside it. Observed value: `"tool_use"`.
- **`message.usage`** fields, confirmed by direct inspection:
  - Flat: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` (matches `usage-readers.ts`).
  - `service_tier` (observed `"standard"`) and `speed` (observed `"standard"`) are flat fields on `usage`, not on `message`.
  - `inference_geo` is a flat field on `usage`, observed as `""` (present but empty, not absent).
  - `cache_creation.ephemeral_1h_input_tokens` / `cache_creation.ephemeral_5m_input_tokens` — nested one level, matches `usage-readers.ts`.
  - `server_tool_use.web_search_requests` / `server_tool_use.web_fetch_requests` — nested one level under `server_tool_use`, not flat fields.
  - `iterations` (observed `[]`) — present on every sampled line but not named anywhere in this ticket's scope; shape and purpose unconfirmed. Carry through as opaque/unused rather than guessing a meaning.
- Top-level fields confirmed present on every line: `sessionId`, `gitBranch`, `cwd`, `timestamp`, `version`, `entrypoint`, `uuid`, `parentUuid`, `isSidechain`, `userType` — matches `claude-message-types.ts`'s `ClaudeMessage`.

## New events

### `agent.usage.request`

- Fires on `Stop` (re-parse of the main transcript), `SubagentStop` (re-parse of that subagent's own transcript, `scope_kind=agent`), `PreCompact` (re-parse of the main transcript, so in-progress request usage is captured before compaction can drop the turns it came from), `StopFailure` (same re-parse as `Stop`, for a turn that ended via failure rather than a clean stop), and `SessionEnd` (final re-parse of the main transcript **and every subagent transcript**).
- One per unique `(request_id, model)` across the session transcript and all subagent transcripts.
- Take the max per numeric field across duplicate records (per `openRequests` merge).
- `scope_kind`/`scope_name` = `main`/`skill`/`agent` depending on which transcript (main vs. a named skill context vs. a subagent transcript) the record came from.

Fields: `request_id`, `timestamp`, `model_raw`, `model`, `speed`, `inference_geo`, `service_tier`, `input_tokens`, `cache_creation_5m_tokens`, `cache_creation_1h_tokens`, `cache_read_tokens`, `output_tokens`, `web_search_requests`, `web_fetch_requests`, `scope_kind`, `scope_name`, `agent_id`, `stop_reason`, `is_api_error`, `git_branch`. All sourced from the transcript shape confirmed above (`message.id`, `message.usage.*`, `message.stop_reason`, `server_tool_use.*`, `gitBranch`) or, for `model`/`model_raw`, from the same resolution chain the statusline already uses (`parseRoutingHeaders()`/`parseBackendModelName()`); `agent_id` is passed through by the caller (the orchestrator) — `''` for a main-transcript record, the subagent's own `agentId` for a subagent-transcript record — not resolved by any shared enrichment step. `is_api_error`'s presence pattern on a real error is unverified — see Open risks.

### `agent.subagent.usage`

- Fires on `SubagentStop`, keyed by `tool_use_id`, and again on `SessionEnd` — re-emitted for **every** subagent transcript found, not just ones whose `SubagentStop` already fired (backstop for a crashed/missed subagent hook). Never fires on `Stop`/`PreCompact` (main-transcript-only parses).
- Aggregates that subagent's own transcript: tokens by model/cache tier, tool-call/error counts, skills invoked.

Fields: `agent_type`, `description`, `tool_use_id` (all from the subagent's own `<agentId>.meta.json` sidecar, already read by `claude.session.ts`'s `findSubagentFiles()`), `spawn_depth` (same sidecar), `workflow_run`, `worktree`, `started_at` (that transcript's first line `timestamp`), `duration_ms` (derived from first/last line `timestamp`), tokens by model/cache tier and `api_calls` (aggregated from that subagent transcript's own usage records, same fields as `agent.usage.request` above), tool-call counts (`tool_use` block count), error counts (`is_api_error`/tool-error occurrences), skills invoked (`tool_use` blocks named `Skill`, via `extractNamedInvocations()`). `spawn_depth`'s default for top-level subagents, and `workflow_run`/`worktree`'s missing source, are both tracked in Open risks.

### `agent.session.summary`

- Fires on `Stop` (`phase=incremental`) and `SessionEnd` (`phase=final`, all fields recomputed from full state) — the only two of the three triggers that are session-level stop points; `SubagentStop`/`PreCompact` never emit it.
- `primary_model` = model with the most `agent.usage.request` records this session.
- `primary_command` = most-frequently-invoked slash command.
- `branch_dominant` = key with the highest count in `branchCounts`.

Fields: models used, `primary_model` (aggregated from this session's `agent.usage.request` records), tool-call counts/errors by tool (existing `PostToolUse`/`PostToolUseFailure` hook payloads, already forwarded today), skills used (`extractNamedInvocations()`'s `skillInvocations`), slash-commands in order and `primary_command` (`extractNamedInvocations()`'s `commandInvocations`), lines added/removed and files changed/written (existing `Edit`/`Write` tool payloads, already forwarded today), compaction counts (`PreCompact` trigger count this session), branch-switch counts and `branch_dominant` (derived from `git_branch` per record via `branchCounts`), `client_version`/`codemie_cli_version` (common fields, see above), session start/end timestamps (`SessionStart`/`SessionEnd` hook timestamps), `api_calls` (count of `agent.usage.request` records this session), session `title`. `title`'s missing source is tracked in Open risks.

## Story/ticket resolution

Resolved fresh every time, by event type:

- **Non-prompt events** (everything except `agent.prompt.submit`): priority chain is explicit → branch. Both are resolvable without any per-record text, so both are computed once per forward tick in `buildForwardContext()` and stamped onto the whole batch in `mapHookRecords()` (`forwarder.ts`) — same per-tick cache already used for `git_branch`/`repo_remote`.
- **`agent.prompt.submit` events**: priority chain is explicit → marker → branch → mention. Marker/mention require that record's own prompt text, so they're evaluated per-record against the *full, untruncated* prompt — either hook-side at `UserPromptSubmit` before `prompt_body` is truncated to `MAX_PROMPT_CHARS=200`, or per-record inside `mapHookRecords()` using the record's own `hookEvent['prompt']` before truncation. Only the resolved `story_id`/`story_source` is threaded through to the spool/forwarder, never the raw text (ticket privacy constraint).

**Explicit** reads from two sources, first match wins:
1. `SDLC_ANALYTICS_STORY_ID` env var.
2. `<cwd>/.claude/analytics.local.json` — shape `{ "storyId": string }`. `cwd` is the hook payload's existing `cwd` field (`claude-code-otlp.types.ts:19,53`, already read via `process.cwd()` at `claude-code-otlp.plugin.ts:38`), which is the project root for Claude Code hook invocations. Gitignored — add `.claude/analytics.local.json` to `.gitignore`.

Reading is read-only here: **nothing in this stage writes that file.** A command that writes it (e.g. `/codemie:set-story`) is tracked separately and out of scope for this stage.

**Branch** reuses `resolveGitInfo()`/`detectGitBranch` (`forwarder.ts`, `src/utils/processes.ts`).

## Identity resolution

- Extend `resolveUserEmail()`'s JWT-only chain (`forwarder.ts:67-81`) to `jwt → git → codemie_cli → os`, first available wins:
  - `git` reads `git config user.name`/`user.email`.
  - `codemie_cli` reads the existing CLI profile config.
  - `os` reads `os.userInfo().username`.
- **Security scope (approved 2026-10-05):** this `jwt → git → codemie_cli → os` derivation chain reads an identity-like value from local git config / CLI config / OS username with no external verification. It is used only to stamp `developer_name`/`identity_source` on outbound analytics/telemetry events (`identity.ts`) — never on the SSO proxy's outbound attribution headers, billing, tenant isolation, or LLM request routing, which `security-practices.md`'s Project & User Attribution Headers rule governs.

## Non-goals

- `agent.session.env`, `agent.skill.dispatch`, `agent.git.snapshot` — sub-stage 1.2.
- Any modification to existing event *content* (`agent.session.start`, `agent.prompt.submit`, `agent.tool.start`/`end`, `agent.subagent.stop`, `agent.session.compact`, `agent.session.stop`/`end`) beyond adding the common fields above.

## Open risks

- **Transcript field confidence gaps** (all affect the three new events; sourcing details are in "Transcript field shape" and "New events" above):
  - `request_id` must be sourced from `message.id` — no real transcript observed carries a top-level `requestId`. Resolved, but flagged so it isn't silently reintroduced from `usage-readers.ts`'s optional-`requestId` interface during implementation.
  - `is_api_error` (used in `agent.usage.request` and in `agent.subagent.usage`'s error counts) is read by production code elsewhere in this repo, but no sampled transcript contained an actual API error, so whether it's always present (false/absent otherwise) or appears only on the erroring line is unverified.
  - `spawn_depth` (`agent.subagent.usage`) is present in the `.meta.json` sidecar only for nested subagents (depth ≥ 2); top-level subagents omit it, so implementation needs an explicit default rather than treating absence as an error.
  - `workflow_run`/`worktree` (`agent.subagent.usage`) have no identified source in this codebase's transcript handling or the `.meta.json` sidecar. The external data-model doc names a `workflows/<runId>/` sidecar directory as the source, but a direct check across every local session directory found no such directory in any sampled session — the gap stands; worth revisiting with the data-model doc's owner.
  - `title` (`agent.session.summary`) has no identified source in a real transcript, top-level or nested, and the data-model doc doesn't name one either — unresolved on both sides.
- **Known limitations, accepted as-is for this sub-stage:**
  - `lines_added`/`lines_removed` (`agent.session.summary`) always emit `0`. An `Edit`/`Write` tool_use's `input` carries the *proposed* edit, not a diff stat, so no reliable added/removed line count can be derived from it without re-implementing diffing — out of scope for this sub-stage.
  - `scope_kind: 'skill'` (`agent.usage.request`) is never emitted. No reliable in-transcript signal for "this turn is inside a skill context" was found, so every main-transcript usage record is unconditionally scoped `'main'`. `state.activeSkill` stays tracked-but-unused, available for a later task that identifies a real signal.
  - `started_at`/`ended_at` (`agent.session.summary`) are close approximations, not the literal `SessionStart`/`SessionEnd` hook payload timestamps: `started_at` is the main transcript's own first parsed line timestamp, and `ended_at` is `Date.now()` at parse time. Threading the actual hook timestamps through would require widening every `collectMainTranscriptEvents` call site's signature; deferred.
  - `commands_in_order` (`agent.session.summary`) contains the right distinct slash-command names but not a true chronological sequence — it is `Object.keys()` of `commandInvocations`, an unordered count map. No chronological invocation order is available anywhere in `NamedInvocationCounts` to draw from. A genuine mismatch with the field's name, documented rather than fabricated.
  - `description` (`agent.subagent.usage`) always emits `''`. The sidecar `.meta.json` schema it mirrors (matching the real production schema) has no `description` key at all, so there is no source anywhere in this codebase to populate it from — unlike the sibling `workflow_run`/`worktree`/`title` gaps above, this one wasn't caught before implementation.
  - `event_id` does not provide idempotent dedup across re-parses: it's a `randomUUID()` generated fresh every time a record is forwarded, not a deterministic function of the record's natural key, so a crash-before-save re-parse of `agent.usage.request`/`agent.subagent.usage`/`agent.session.summary` forwards the re-derived record under a new `event_id` — the backend sees a new record rather than an update to the original. Accepted as-is for this sub-stage; the natural key is still stable across re-derivation (`request_id`+`model`, `tool_use_id`, or `session_id`+`phase`), so dedup on that key is possible if the backend needs it.
