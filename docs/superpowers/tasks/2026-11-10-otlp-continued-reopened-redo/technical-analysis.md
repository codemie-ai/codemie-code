# Technical Research

**Task**: claude-code-otlp transcript orchestrator, continuation, session start timestamp, native OTel log/record forwarding, reopen/resume handling
**Generated**: 2026-11-10
**Research path**: filesystem (codegraph MCP unavailable; findings come from static reads plus a throwaway-worktree revert test, nothing was run live)

---

## 1. Original Context

Two bugs in the CodeMie CLI `claude-code-otlp` analytics plugin (src/agents/plugins/claude-code-otlp/), tickets EPMCDME-16992 and EPMCDME-16993. A first fix (PR #779, commit b1cb4324) was merged and then fully REVERTED on main by PR #787 (commit ee791ac8). Main currently has NO fix. The fix was tested on Preview by QA and was only partial. We must redo the fix: re-apply #779 (likely `git revert ee791ac8`) and close the remaining gaps.

EPMCDME-16992 (continued session C re-reports parent's copied lines): QA says copies are no longer re-reported (cost/tokens/turns/tool calls = 0 on fixed build) BUT acceptance criterion 2 FAILS: C's `Started` in Session Detail is still the parent's first copied line timestamp (2026-11-10T16:10:48.156Z) while C's own start was 16:23:52Z, and Duration is counted from the wrong start. Expected: C's start = its own start. Backend computes start = least(started_at, activity_started_at).

EPMCDME-16993 (reopened session without prompt changes analytics): QA says after the fix NO hook events are spooled for the reopen, BUT duration still grows to the reopen time (e.g. 37s -> 12m 2s) while active_ms is unchanged. Cause found by QA: Claude Code's OWN native OTel log records for the reopen (hook_registered, plugin_loaded, managed_settings_resolved, mcp_server_connection, hook_execution_start, hook_execution_complete at startup, plus user_prompt for /exit) ARE spooled and delivered, stamped at the reopen time. Transcript file is byte-identical before/after. Expected: opening/resuming a session with no prompt / model request / tool call does not change its analytics. Backend-only changes out of scope (CLI-side fix).

---

## 2. Codebase Findings

### Existing Implementations

**Q4: revert and drift on main**
- `git revert ee791ac8` applies CLEANLY on HEAD 7ea4304b. Tested with `--no-commit` in a temporary detached worktree, since removed. One auto-merged file: `src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts`. Result equals original #779: 22 files, +3521/-18.
- #779 files: `transcript/orchestrator.ts`, `transcript/continuation.ts` (new, 203 lines), `transcript/parse-state.ts`, `claude-code-otlp.plugin.ts`, 4 test files (`claude-code-otlp.plugin.test.ts`, `continuation.test.ts`, `orchestrator.test.ts`, `parse-state.test.ts`), `docs/ARCHITECTURE-OTLP-PLUGIN.md`, plus docs/review artifacts.
- Commits on main after ee791ac8:
  - 6c1c639e (#788): version bump 0.16.7. No overlap.
  - 291d3f29 (#781): pre-spawn claude-code-otlp endpoint refresh. Touches `claude/claude.plugin.ts`, `cli/commands/proxy/daemon-manager.ts`, `connectors/claude-code-otlp-endpoint.ts`. No overlap.
  - 7ea4304b (#782): managed/native CodeMie project selection. Only overlap is `claude-code-otlp.plugin.ts`: `configuredProjectWins = true` (~L116) and `resolveProjectAtCwd(..., { configuredWins: true })` (~L259). This is the auto-merged spot. Also touches `claude-code-otlp.transitions.test.ts` (1 line).
  - dcb710b8 (#785) is BEFORE the revert, already in HEAD. It changed legacy-metrics gate and the otlp-spool area (`forwarder.ts`, `delivery-state.ts`, `sweep.ts`, `session-status.ts`, new `destination-intent.ts`, `accepted-marker.ts`). Relevant to any forwarder-side change for 16993. #777 and #780 are not in the range.
- Nothing after ee791ac8 touches `orchestrator.ts`, `continuation.ts` or `parse-state.ts`.
- Working tree: staged `.codemie/codemie-cli.config.json` (activeProfile epm-cdme -> default; do not commit it), untracked task dir.

**Q1: which events of continued session C carry the parent's timestamp**
Line numbers are for HEAD (no fix) unless marked "after #779". The agent could not reproduce the Preview case offline, so the post-#779 root cause is a strong inference, not proven.
- Without a fix:
  - `agent.usage.request`, one per copied request. `buildUsageRequestEvent` sets `timestamp: req.timestamp` (`transcript/usage-request.ts` ~L260). `OtlpAgentAdapter.buildEvent` (~L305-318) keeps it because `resolveEventTimestamp` (~L378-389) lets an event timestamp beat hook time. `deriveMainEvents` (`orchestrator.ts` ~L545-640) emits them. Event ids are content-keyed and carry C's session id (`claude-code-otlp.event-id.ts:48-77`), so the backend stores them as C's rows.
  - `agent.session.summary`. `started_at = firstTimestamp(parsedLines)` in `buildFullAccumulator` (`orchestrator.ts:464`, `firstTimestamp` L268-275). `ended_at` and the envelope timestamp come from L465, and the timestamp feeds the summary event id (`event-id.ts:58`). `parsedLines` is the whole transcript with no ownership filter (L376-440). Built at L613-634 on every Stop/SessionEnd. `session-summary.ts:108-163` copies `startedAt` to `started_at` (L135) and `endedAt` to `timestamp` (L127).
- NOT parent-derived:
  - `agent.session.start`, `.env`, `.stop`, `.end` use hook time (`resolveEventTimestamp` falls back to `hookTime`).
  - `state.sessionStartedAt = new Date().toISOString()` (`orchestrator.ts:708-709`) is wall-clock at SessionStart. It is used only for git commit resolution (`claude-code-otlp.plugin.ts` ~L504) and is never sent as a start.
  - The spool, forwarder and daemon derive no start time.
- After #779 (b1cb4324):
  - Usage copies are skipped. `ensureInherited` resolves the parent's counted uuids via `continuation.ts` `resolveInheritedUuids`, and `deriveMainEvents` pre-fills `seenUuids`. This matches QA's zero cost/tokens/turns/tools.
  - `buildFullAccumulator` drops lines whose uuid is inherited, but `startedAt` and `endedAt` still come from `firstTimestamp` over the surviving lines. Exclusion is by uuid only.
  - The summary is suppressed only when `inherited.size > 0 && !hasOwnLines`, and `hasOwnLines = parsedLines.length > 0`, which counts any surviving line.
  - MOST LIKELY CAUSE of Started = 16:10:48.156: the summary's `started_at` (and `timestamp`) from a surviving copied line. Candidates are timestamped lines without a uuid (`queue-operation`, a type seen in `orchestrator.test.ts:2934`), or the parent not yet found / outside the 200 newest siblings (D-1, D-2 in the old decisions). 16:10:48.156 is 2.2 s after P's session start 16:10:45.913, which fits a first transcript line, not a hook. The backend `least(started_at, activity_started_at)` means one parent-dated value is enough.
  - Not ruled out: a first pass read the copies before the parent was found (D-2).
- Fix options (CLI-side):
  1. Positional ownership in `buildFullAccumulator`: drop everything up to the last inherited line, including no-uuid lines, and take start/end only from the remainder. Smallest change; also fixes turns/tools/models for no-uuid copies.
  2. Clamp `started_at >= state.sessionStartedAt` when `inherited.size > 0`. D-1 notes `sessionStartedAt` was empty in real saved states, so do not rely on it alone.
  3. Send empty `started_at` for continuations (`buildSessionSummaryEvent` supports it; `duration_ms` becomes null). Weakest, stopgap only.
  4. Replace `hasOwnLines` with the stricter `ownActivity` predicate from `deriveMainEvents` (non-synthetic assistant or `isGenuineUserTurn`), so an idle continuation sends no summary.
  5. Defensive drop of any usage/summary timestamp earlier than C's own `sessionStartedAt` for continuations. D-1 rejected this once, so propose with care.
  - Recommended: 1 + 4, with 2 as a clamp.

**Q2: how native OTel reaches the backend**
- Env setup: written to `~/.claude/settings.json` by `src/cli/commands/proxy/connectors/claude-code-otlp.ts` (`CODEMIE_ENV_KEYS` L81-91, fixed values L105-113: `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, logs/metrics/traces exporters `otlp`, `OTEL_LOG_TOOL_DETAILS=1`; endpoint `${state.url}/v1/analytics/otlp` and bearer headers at L499-500). It applies to plain `claude` too. `claude/claude.plugin.ts:305-306` only forces telemetry off for the `codemie-claude` wrapper when unset; L611-640 is the 7 s pre-spawn endpoint refresh (#781).
- The CLI hook plugin is NOT in the OTel path. Claude Code POSTs directly to the local proxy daemon; the plugin handles hook events only.
- Receive (`src/providers/plugins/sso/proxy/plugins/otlp.plugin.ts`): routes L216-224 for `POST /v1/analytics/otlp/v1/{logs,metrics,traces}`; hooks at `/v1/analytics/hooks` (L211, `handleHooks` L233). `handleOtlp` L335. JSON goes to `handleOtlpJson` (L359): parse, `maskOtlpJson` (L383), one NDJSON line per export request via `appendSpool` (L385). Other content types go to `handleOtlpBinary` (L403) and are spooled as raw unmasked bytes. The session id is the FIRST UUID-v4 regex match anywhere in the body (L31, L365, L409), not `session.id`; a body without a UUID is dropped (L368, L413). No per-record inspection at ingest.
- Spool (`otlp-spool/spool-paths.ts` L11-15, L35-41, L56-61): `~/.codemie/proxy/otlp-spool/<sessionId>.otel_{logs,metrics,traces}.ndjson`, plus `.hooks.ndjson` and `.status`.
- Stamping: the CLI never stamps OTel records. Timestamps are Claude Code's own `timeUnixNano`, forwarded unchanged. "Stamped at reopen" is Claude Code's emit time. Hook events, in contrast, are built and timestamped in the hook process.
- Forward (`otlp-spool/tick-processor.ts` L208-312 per session per tick; `forwarder.ts` L611-625 loops `OTEL_STREAMS`/`OTEL_JSON_STREAMS`; `forwardOtelJsonStream` L494-534; one POST per NDJSON line L518-531 with per-record cursor ack L530; empty-batch branch L508-512). Only per-record logic is read-only `proveJsonRecord` (L521-525), which holds on missing/wrong session id (`otlp-json-reader.ts:34-40`, `:44-77`). The binary path forwards a verified prefix byte-for-byte (L468-474).
- Completeness gate (`otlp-spool/completeness-gate.ts:33-53`): hooks + OTel -> send; OTel only -> wait then skip (cursors advance to EOF, data never sent; per-project allowlist enforcement, L8-15). With #779's `payload: []` on idle reopen the hooks stream may be absent, which would predict NO delivery of the housekeeping records. That contradicts QA's observation, so QA delivery may come from a leftover hooks file (spool swept after ~15-60 min idle) or an evidence-record path. NEEDS A LIVE REPRO.
- Event names: none of `hook_registered`, `plugin_loaded`, `managed_settings_resolved`, `mcp_server_connection`, `hook_execution_start/complete`, `user_prompt`, `api_request`, `retention_sweep`, `event.name` appear in `src/`. OTLP is treated as opaque. There is NO existing activity-vs-housekeeping classification; an allowlist/denylist would be new, reading attribute `event.name` from the log record. EPMCDME-16847 (Claude Desktop `retention_sweep`) is the same problem class.
- Session id per record: the JSON proof requires `session.id` on every log record, span and metric datapoint (`otlp-json-reader.ts:34-40`); logs also accept `session_id`. Resource attributes are not checked. Per-record filtering is feasible on the JSON path only.
- Reopened state availability: in #779, `reopened`/`reopenActive` live on `TranscriptParseState`; `isReopenedIdle = reopened === true && reopenActive !== true`; `reopened` set in `openSessionStartPass(..., source)` when `source === 'resume' && Boolean(state.sessionStartedAt)` (current function at `orchestrator.ts:696`). File: `getCodemiePath('analytics','state',`${sessionId}.json`)` (`parse-state.ts:117-119`), PID lock (L175), atomic temp+rename (L151), `loadParseState` (L129). Plain JSON, so the daemon can read it, but it is a different directory from the spool, written only by the short-lived hook process on SessionStart, and not a designed cross-process contract.
- #779 touched only the hook path (`payload: []`); nothing in `otlp.plugin.ts` or `otlp-spool/`. That is precisely the 16993 gap.

### Architecture and Layers Affected
- Agent plugin / Workflow: `claude-code-otlp.plugin.ts`, `transcript/orchestrator.ts`, `continuation.ts`, `parse-state.ts`, `session-summary.ts`, `usage-request.ts` (16992 and hook half of 16993).
- Core adapter: `src/agents/core/OtlpAgentAdapter.ts` (event timestamp resolution).
- External / Proxy daemon: `otlp.plugin.ts` ingest and `otlp-spool/` forwarder (16993 native OTel half).
- Config: `connectors/claude-code-otlp.ts` (Claude Code OTEL env export).

### Integration Points
- Hook process -> parse-state JSON (`~/.codemie/analytics/state`) -> (proposed) proxy daemon tick reads it.
- Claude Code -> proxy `/v1/analytics/otlp/v1/*` -> NDJSON spool -> forwarder -> analytics API; hooks arrive via `/v1/analytics/hooks`.
- #785 accepted-marker / destination-intent logic sits in the same forwarder area.

### Patterns and Conventions
- One `ForwardDecision`-returning handler per native event, single `forwardToSpool()` call site (`docs/ARCHITECTURE-OTLP-PLUGIN.md`). Agent-owned fields resolved at hook time, never via a forwarder callback to the adapter (AGENTS.md OTel section). A forwarder reading parse-state would bend this rule and needs a deliberate decision.
- ES modules, `.js` import extensions, `@/` alias, `logger.debug`, `getCodemiePath()`.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/architecture/architecture.md`, `integration/external-integrations.md`, `development/development-practices.md`, `testing/testing-patterns.md`, `quality-gates.md`; `docs/ARCHITECTURE-OTLP-PLUGIN.md`; `docs/ARCHITECTURE-PROXY.md`.
- Previous-task artifacts only in git: `git show ee791ac8^:docs/superpowers/tasks/2026-11-09-otlp-continued-and-reopened-sessions/{technical-analysis,accepted-decisions}.md` (decisions D-1, D-2, ...).

### Architectural Decisions
- Old D-1 rejected timestamp clamping against `sessionStartedAt` (it was empty in real saved states). D-2: three parent lookups, then final. D-4: subagent files are not copied.

### Derived Conventions
- Spool entries are byte-exact; any rewrite breaks the proof/ack accounting. Drops must go through a defined recorded path (like `skip` / `recordLossLocked`).

---

## 4. Testing Landscape

### Existing Coverage
- vitest ^4.1.5, projects `unit` (`src/**/*.test.ts`), `cli` (`tests/integration/**`), `agent`. Narrow run: `npx vitest run --project unit <path>`.
- Plugin: `src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.plugin.test.ts` (+ `.allowlist`, `.disable-matrix`, `.event-id`, `.gate`, `.preferences`, `.transitions`, `.types`).
- Transcript: `transcript/__tests__/` `orchestrator`, `parse-state`, `session-signals`, `session-summary`, `usage-request`, `continuation` (from #779), etc.
- Spool: `otlp-spool/__tests__/` forwarder, forwarder-contract, hold-lifecycle, tick-processor, otlp-json-reader, completeness-gate, delivery-*, session-status-atomic. Proxy plugin: `plugins/__tests__/otlp.plugin.otel-json`, `otlp-json-masking`, `otlp.plugin.hooks`. Integration: `tests/integration/proxy-otlp-respawn-recovery.test.ts`.
- #779 added tests: plugin test (+87), `continuation.test.ts` (110), `orchestrator.test.ts` (+387), `parse-state.test.ts` (+34).

### Testing Framework and Patterns
- `orchestrator.test.ts`: `CODEMIE_HOME` = `mkdtempSync` per test, `vi.hoisted` mocks for `session-env-fields.js`, static imports after mocks, helper `mainEvents` (`openMainTranscriptPass` then `pass.finalize(true)`). Plugin test uses static `vi.mock`. Transcript fixtures are inline JSONL strings; no shared builder. Helpers in `tests/helpers/` (`isolated-cli.ts`, `test-isolation.ts`, `temp-workspace.ts`, `fake-clock.ts`, `session-poll.ts`).

### Coverage Gaps
- No tests for the summary `started_at` with copied no-uuid lines; none for native OTel housekeeping records on an idle reopen; no tests classifying `event.name`.
- External harness `C:\Users\OlehPrusak\codemie-eval\`: flat scripts, no package.json/README. `harness.mjs <dist-dir> <out.json>` dynamically imports `<dist>/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.js`, subclasses `ClaudeCodeOtlpPlugin` with `fire()` (calls `evaluate()` then `finalize(true)`), fresh `CODEMIE_HOME` per scenario, builders `L.user/L.assistant/L.record`, `parentSpec`, `copyTo` (rewrites sessionId, keeps uuids and timestamps), `reopenRecords`, `lifecycle`, `metrics`. 14 scenarios: A1-A4 continuation, B1-B8 idle reopen, C1 regression, D1 continued then reopened (`d1.mjs`). `verify13.cjs` diffs baseline vs fixed JSON into a markdown table keyed to 16992/16993. Reusable: dist-import + subclass pattern, isolation, builders, baseline-vs-current diff.
- Missing for a live suite: assertions, packaging, fake backend HTTP server, native `resourceLogs/logRecords` modelling, real proxy ingest + `otlp-spool` forwarder run, real `codemie hook` process invocation, #785 accepted-marker flow, hardcoded dist paths (`gate.mjs`, `cutoff.mjs`, `perf.mjs`) and a hardcoded `./d1.mjs` import. Last vitest run in `iso-codemie-code.txt` failed with an esbuild "service was stopped" error (looks sandbox related).

---

## 5. Configuration and Environment

### Environment Variables
- `CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_*_EXPORTER` (connector `claude-code-otlp.ts:81-113, 499-500`); `CODEMIE_HOME` (state/spool root, test isolation); `CODEMIE_SESSION_ID`.

### Configuration Files
- `~/.claude/settings.json` (env written by connector); `~/.codemie/analytics/state/<sid>.json` (parse state); `~/.codemie/proxy/otlp-spool/` (spool, `.status`).

### Feature Flags and Deployment Concerns
- Allowlist / `sendMode === 'evidence'` / `hooksOnlyWaitTicks` / `heldRetentionMs` in the forwarder. Daemon restart is needed for forwarder changes to take effect; existing spool files must keep working.

---

## 6. Risk Indicators

- 16992 root cause after #779 is inferred, not proven. Add a debug log of kept/dropped line types or reproduce with the real C transcript before choosing the fix.
- 16993 contradiction: the completeness gate predicts OTel-only sessions are skipped, yet QA saw delivery. Reproduce live before designing; the filter placement depends on what keeps the session sendable.
- Startup race: housekeeping OTel records may reach the spool before the SessionStart hook sets `reopened`. A flag-only filter loses or leaks records depending on timing; an event-name filter alone cannot tell a legitimate session from an idle reopen.
- Event-name allowlist/denylist is entirely new, depends on Claude Code version (2.1.318+), and `user_prompt` is both housekeeping (`/exit` on idle reopen) and real activity on a normal prompt. Over-broad filtering drops legitimate data.
- Mixed export requests (activity + housekeeping records in one NDJSON line) require rewriting, which conflicts with the byte-exact proof. The binary protobuf path cannot be filtered without a decoder.
- Ingest session binding uses the first UUID anywhere in the body (`otlp.plugin.ts:31,365,409`): possible mis-binding before any per-session filter.
- Deliberate drops need a recorded "discarded" path consistent with `acknowledge`/`noteProof`/sweeper and #785 accepted-marker logic.
- Coupling the proxy daemon to the agent plugin's parse-state file departs from the "no forwarder callback into the adapter" rule; `reopened` is set only for `source === 'resume'` with a stored `sessionStartedAt` (empty in some real states), so `claude -c` / continued sessions are not covered.
- Timestamp clamp on OTel records is not recommended (breaks byte-exactness, not possible for protobuf).
- Backend-side counting of OTel housekeeping toward `started_at`/`last_event_at` is the cleaner fix but out of scope; confirm with backend owners.
- Revert merges cleanly but touches 22 files (+3521); the #782 `configuredWins` line sits in a file #779 modified, so re-run the existing plugin and orchestrator tests after reverting.
- Staged `.codemie/codemie-cli.config.json` change must not go into the fix commit.
- Agent-found test gaps: no assertions or fake backend in the external harness; vitest startup issue seen in a sandbox.

---

## 7. Summary for Complexity Assessment

The work spans the Agent plugin / Workflow layer (orchestrator, parse-state, session-summary, continuation) and the Proxy/External layer (OTLP ingest and the otlp-spool forwarder). Re-applying #779 is a clean revert (22 files). 16992 needs a small, targeted change in `buildFullAccumulator` / summary suppression (roughly 2-4 files plus tests). 16993 is the larger piece: a new filter in the proxy forwarder for native OTel records, roughly 3-6 files (`otlp.plugin.ts` or `forwarder.ts`/`tick-processor.ts`, `otlp-json-reader.ts`, possibly `completeness-gate.ts` and parse-state access), plus tests and docs.

Technical novelty is high for 16993. There is no existing activity/housekeeping classification, no precedent for the daemon reading hook parse-state, and an unresolved race between OTel emission and SessionStart. Design alternatives exist (event-name allowlist, hold-until-activity, parse-state gate) and each has data-loss or ordering risk. Backward compatibility with existing spool files and with the byte-exact proof matters. The 16992 fix follows established orchestrator patterns, but its root cause is inferred and needs a repro.

Test posture is mixed. The orchestrator, plugin and spool areas have extensive unit tests with usable isolation patterns, while the specific new behaviours (summary start for continuations with no-uuid copies, native OTel on idle reopen) have none. A live end-to-end suite would need new infrastructure: fake backend, real proxy ingest and forwarder, native OTel payload fixtures, and the out-of-repo harness has no assertions. Overall this is a High complexity, architecture-sensitive task driven by the 16993 forwarder design and the repro uncertainty.
