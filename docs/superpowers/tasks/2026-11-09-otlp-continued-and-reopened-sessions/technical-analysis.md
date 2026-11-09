# Technical Research

**Task**: claude-code-otlp transcript orchestrator session-summary usage-request hook spool
**Generated**: 2026-11-09
**Research path**: filesystem (codegraph tool-not-found)

---

## 1. Original Context

Two related Jira bugs in the CodeMie CLI claude-code-otlp plugin (src/agents/plugins/claude-code-otlp/). Fix only the CLI-side (this repo); backend is out of scope.

EPMCDME-16992: A continued Claude Code session re-reports its parent's copied history. Parent P's transcript gets a `continued-in` record naming new session C; C's transcript starts with P's lines copied (same uuid, message.id, requestId, timestamps, sessionId rewritten to C). Root cause per ticket: transcript/orchestrator.ts reads lines after persisted mainOffset; new session id starts at offset 0 so C's first Stop/SessionEnd pass reads P's copied lines. transcript/usage-request.ts derives agent.usage.request for each copied request; transcript/session-summary.ts / session-signals.ts (countTurns, tool and agent counts) build agent.session.summary from all lines. Nothing handles `continued-in` or skips lines whose uuid/message.id belong to another session. claude-code-otlp.event-id.ts: usage event ids are content keys with C's session id so copies are stored as C's rows. Expected: C reports only its own requests/tokens/cost/tool calls/agents/turns; start = own start, not parent's.

EPMCDME-16993: Opening/resuming an old Claude Code session without a prompt rewrites analytics. The CLI sends the reopened session's lifecycle hooks (SessionStart/Stop/SessionEnd -> agent.session.start/stop/end) stamped at open time; backend uses these to extend duration by days, move session into the open day, and the first evidence request binds subscription class/origin from the open's launch headers (native, not routed via CodeMie). Expected: opening/resuming with no prompt/model request/tool call must not change analytics (no lifecycle/dimension hooks forwarded for a no-activity reopen, no session re-binding to the new launch context).

Goal of research: determine (a) exact code paths in the CLI for both, (b) whether both fixes touch the same files/functions (conflict risk if done separately) or can be done independently, (c) what is feasibly fixable client-side, (d) existing tests/fixtures for these paths, (e) Risk Indicators. See docs/ARCHITECTURE-OTLP-PLUGIN.md and .ai-run/guides/architecture/architecture.md.

---

## 2. Codebase Findings

Paths relative to repo root; plugin dir `P/` = `src/agents/plugins/claude-code-otlp/`.

### Existing Implementations
- `src/cli/commands/hook.ts:1671-1674` - entry for `codemie hook --agent claude-code-otlp`; resolves adapter via `AgentRegistry.getAnalyticsAgent`, calls `processOtlpEvent(input, {ensureOtlpProxy, forwardOtlpEventsToSpool})`.
- `src/agents/core/OtlpAgentAdapter.ts` - base class. `processOtlpEvent` (91-171): parseHookInput -> isTracked -> transitionGate -> ensureOtlpProxy -> evaluate() -> prepareForward. Empty payload => accepted=true, nothing sent (137-140). Send 155-156 (optional retryOnce); `finalize(accepted)` always runs. `buildEvent` 302-318; `timestamp` falls back to hook time when payload has none (381-389) - this is the "stamped at open time" source for bug 16993.
- `src/agents/plugins/utils.ts:17-61` - `forwardOtlpEventsToSpool`: single POST to `${daemon}/v1/analytics/hooks`, 3s timeout.
- `P/claude-code-otlp.plugin.ts` - adapter. `HOOK_EVENT_TYPE_MAP` 79-93 (SessionStart->agent.session.start, Stop->agent.session.stop, SessionEnd->agent.session.end); `transitionGate` 197-234; `evaluate()` 314-362; `onSessionStart` 391-420 (always forwards [start, env]); `onStopEvent` 422-432; `onSessionEndEvent` 479-504 (always forwards SessionEnd + agent.git.snapshot + transcript events, retryOnce); `buildGitSnapshotEvent` 727-739.
- `P/transcript/orchestrator.ts` - `buildFullAccumulator` 362-468 (full re-read from byte 0 on every Stop/SessionEnd; `startedAt = firstTimestamp(parsedLines)` at 464); `seedSeenUuids` 477-498; `deriveMainEvents` 545-639 (reads `readNewLines(path, state.mainOffset)`, filters with `isCountedTranscriptLine` + `keepFirstByUuid` against `seenMessageUuids`; builds usage requests, branchCounts; `api_calls` 632-634); `finalizeOf` 647-664; `openSessionStartPass` 696-733 (first-write-wins for gitHeadStart/sessionStartedAt, docblock 671-695); `openMainTranscriptPass` 1016-1046; `openSessionEndPass` 1403-1457.
- `P/transcript/parse-state.ts` - `TranscriptParseState` 52-98 (mainOffset, subagentOffsets, openRequests, activeSkill, branchCounts, gitHeadStart, sessionStartedAt, lastSessionEnvFields, lastCompactionEnd, optional seenMessageUuids/deferredAgentIds/deferredSubagentFiles); file `~/.codemie/analytics/state/<sessionId>.json` (line 118); `createParseState` 103-115; load never throws (falls back to fresh/offset 0), save throws.
- `P/transcript/transcript-reader.ts:21-61` - `readNewLines(file, fromOffset)`; cuts at last newline; file smaller than offset => re-read from 0.
- `P/transcript/usage-request.ts` - `parseUsageLine` 73-150, `usageRequestKey` 158-166 (`requestId||messageId::model`), `mergeUsageRequest` 181-214, `buildUsageRequestEvent` 233-262.
- `P/transcript/session-summary.ts:108-163` - `buildSessionSummaryEvent`, pure builder; phase incremental on Stop, final on SessionEnd; id `summary:<phase>:<ended_at>`.
- `P/transcript/session-signals.ts` - `countTurns` 117-132, `collectEditLineStats`, `collectCompactions`, `latestTitle`.
- `P/claude-code-otlp.event-id.ts:48-77` - usage events content-keyed + session_id; summary natural key phase+ended_at.
- `src/agents/plugins/claude/session/transcript-lines.ts` - `isCountedTranscriptLine`, `keepFirstByUuid` (uuid-only; sibling plugin, not core).
- `P/claude-agent-sdk-hooks.d.ts` - SessionStart.source `'startup'|'resume'|'clear'|'compact'|'fork'` (l.531); SessionEnd.reason includes `'resume'` (l.70).
- Repo-wide grep: no code handles `continued-in` / `continuedIn` / `continued_in`; no "reopen"/"no-activity" logic in the plugin. Nothing in `transcript/` reads a line's own `sessionId`.

### Architecture and Layers Affected
- CLI (`hook.ts`, no business logic) -> Registry -> Plugin (claude-code-otlp) -> Core (OtlpAgentAdapter, types, event-fields, evidence) -> Utils; downstream agent-agnostic proxy daemon spool/forwarder (`src/providers/plugins/sso/proxy/plugins/otlp-spool/forwarder.ts`, `otlp.plugin.ts` handleHooks), which only transports (only inspects `agent.session.end` to mark ended). Spool/forwarder/daemon changes are out of CLI-side scope.
- Core must not import from plugins; spool function injected via `OtlpAdapterDeps` (`src/agents/core/types.ts:735-744`).

### Integration Points
- plugin -> `@/agents/core/{OtlpAgentAdapter,types,event-fields/*,evidence/*}` (record-store, stop-marker, session-scope, owner-pending, stamp); orchestrator -> `@/agents/plugins/claude/session/transcript-lines.js`.
- Hook registration: `src/cli/commands/proxy/connectors/claude-code-otlp.ts` (16 HOOK_EVENTS in ~/.claude/settings.json).
- Bug 16992 flow: new session C has no parse-state => offset 0 and empty seen-uuid set => `deriveMainEvents` emits agent.usage.request for P's copied lines; `buildFullAccumulator` has no sessionId/uuid-ownership filter so summary (models, tools, turns, startedAt, endedAt) includes P's history; usage event ids differ from P's (C's session_id) so backend cannot dedupe.
- Bug 16993 flow: reopen fires SessionStart(source resume/fork) -> Stop/SessionEnd; handlers have no activity check; events carry hook-time timestamps; evidence/dimension binding comes from the launch env (`launch_mode` via CODEMIE_SESSION_ID presence; headers in `header-injection.plugin.ts`). Evidence record is frozen at first hook per doc 7, but a new session_id/launch can bind new evidence.

### Patterns and Conventions
- Template method; one `if` per event name in `evaluate()`; handlers return `ForwardDecision`, never send; commit-after-send via `finalize(accepted)`.
- Empty payload short-circuits send; one PID lock per session per pass - never acquire `acquireParseStateLock` twice (stalls PID_LOCK_WAIT_BUDGET_MS); use envCheck fold-in.
- Resolvers return '' on failure, never throw; import event-fields directly (no barrel); everything resolved at hook time (daemon env frozen).
- Deterministic event ids; growing records content-hashed, immutable ones natural-key, first write wins backend-side.
- Existing seed mechanism: `seenMessageUuids` / `seedSeenUuids` skip already-counted uuids - reusable for P's uuids.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `docs/ARCHITECTURE-OTLP-PLUGIN.md` (primary): s2 pipeline/project pin 24h TTL/event_id; s3 ForwardDecision; s4 adding events (update doc); s6 file table + SessionStart/Stop/SessionEnd paragraph; s7 evidence frozen at first hook ("resumed session ... still sends the original evidence").
- `.ai-run/guides/architecture/architecture.md` - 5-layer rules. `.ai-run/guides/integration/exposed-api.md` (~137-142), `docs/HOOKS.md` (~242, SessionStart payload), openwiki pages `workflows/agent-launch-and-session-telemetry.md`, `workflows/hooks-skills-frameworks-and-automation.md`.
- `.ai-run/guides/integration/cli-analytics-events.md` is cited by the doc but does not exist (stale reference).
- Task dir contains only `.state.json` (flow sdlc-light, phase main); no prior spec/plan.

### Architectural Decisions
- First-write-wins on SessionStart (compact/resume refires keep original gitHeadStart/sessionStartedAt) - tests orchestrator.test.ts ~1652-1726.
- `transitionGate`: only SessionStart startup/clear is "fresh"; non-startup hook without evidence record => stop `resume_unknown` (plugin 197-234; notice text in `claude-code-otlp.notice.ts:14`). Resume deliberately not fresh.
- SessionEnd is not a cleanup boundary (subagent registry survives for resume); git snapshot spans first start through SessionEnd.
- Summary event_id natural key means first record wins for a given phase+ended_at.
- Spool sweep: 15 min after SessionEnd / 60 min abandoned; session waking after sweep is a new session.

### Derived Conventions
- No TODO/HACK/DECISION markers in the plugin; limitations documented in the architecture doc only. Tests for new events/handlers follow existing orchestrator.test.ts structure; update doc s6.

---

## 4. Testing Landscape

### Existing Coverage
Under `P/transcript/__tests__/`: `orchestrator.test.ts` (3539 lines; offsets 1451-1517, seedSeenUuids 2715-2802, resume/SessionStart 1652-1735, 2414, 3508), `parse-state.test.ts`, `session-summary.test.ts`, `session-signals.test.ts`, `usage-request.test.ts`, `transcript-reader.test.ts`, `subagent-usage.test.ts`, `evidence-index.test.ts`, `fork-skill*.test.ts`. `P/__tests__/`: `claude-code-otlp.event-id.test.ts`, `.plugin.test.ts`, `.transitions.test.ts` (resume gate ~100-112,166,241), gate/allowlist/preferences/disable-matrix, etc. `event-fields/__tests__/session-env-fields.test.ts`. CLI: `src/cli/commands/__tests__/hook.session-delivery.test.ts` (heavy resume coverage), `hook.analytics-wiring.test.ts`, `hook-routing-contract.test.ts`, `src/cli/commands/proxy/connectors/__tests__/claude-code-otlp.test.ts`. Spool: `otlp-spool/__tests__/` (forwarder, evidence-lifecycle, spool-io, ...). `src/agents/core/evidence/__tests__/record-store.test.ts`.

### Testing Framework and Patterns
- Vitest ^4.1.5, TS ESM, `.js` import suffix and `@/` alias; unit tests `src/**/__tests__`, integration `tests/integration`. Real temp dirs (`mkdtempSync`), `CODEMIE_HOME` redirect, `vi.mock` of session-env-fields, fake timers, logger spy, dynamic import after spies. Fixtures dir has only 3 jsonl files (transcript-usage, -usage-direct, subagent-direct); most transcripts inline. Guide: `.ai-run/guides/testing/testing-patterns.md` (tests only on explicit request per AGENTS.md).

### Coverage Gaps
- No test/fixture for `continued-in` or copied-history transcripts; no multi-session fixture.
- No test for no-activity reopen of an OTLP session (existing "reopen" tests are Desktop runtime only: `src/telemetry/runtime/DesktopTelemetryRuntime.ts`).
- Offset gaps: same-size rewrite, mid-line offset, offset across handoff, parse-state schema migration for new fields.
- No dedicated unit tests of evaluate()/handlers outside plugin.test / hook.session-delivery.
- Tests needing update if fixed: orchestrator, parse-state, session-summary, plugin, event-id tests.

---

## 5. Configuration and Environment

### Environment Variables
- `CODEMIE_SESSION_ID` (presence => launch_mode managed vs native), `CODEMIE_PROFILE_NAME`, `CODEMIE_PROFILE_CONFIG`, `CODEMIE_BASE_URL`, `CODEMIE_TARGET_API_URL`, `CODEMIE_PROJECT`, `CODEMIE_PROJECT_BINDING`, `CODEMIE_HOME`, `CODEMIE_DEBUG`.
- Spool: `OTLP_SEND_INTERVAL_MINUTES`(2), `OTLP_SWEEP_INTERVAL_MINUTES`(15), `OTLP_SEND_MAX_ATTEMPTS`(3), `OTLP_ALLOW_HOOKS_ONLY_FORWARD`(true), `OTLP_ENDED_SESSION_GRACE_MINUTES`(15), `OTLP_ABANDONED_SESSION_GRACE_MINUTES`(60), `OTLP_HELD_RETENTION_MINUTES`(1440), `CODEMIE_EVIDENCE_RECORD_IDLE_DAYS`(90), `CODEMIE_EVIDENCE_RECORD_MAX_FILES`(20000).
- Claude-side: `CLAUDE_PROJECT_DIR`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_ENTRYPOINT`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK/VERTEX`.

### Configuration Files
- `~/.claude/settings.json` (hooks + OTel env, `CODEMIE_ANALYTICS_PROJECT_FILTER`), `~/.codemie/claude-analytics.json` (prefs, collectionGeneration), `~/.codemie/codemie-cli.config.json`, `~/.codemie/proxy-daemon.json`, `~/.codemie/work-consent.json`.
- State: parse-state `~/.codemie/analytics/state/<sid>.json` (+.lock); evidence cache `<sid>.evidence.json`; evidence records `analytics/state/evidence/<hash>.json` (+verdict/stop/stop-ack/publication siblings); owner-pending dir; project pin `~/.codemie/otlp-session-project/<sid>`; spool `~/.codemie/proxy/otlp-spool/<sid>.{hooks.ndjson,otel_*,status}`.
- Launch headers (analytics POST, `header-injection.plugin.ts` analyticsAttributionHeaders): X-CodeMie-Session-Id, -Routed-Via-CodeMie, -Subscription-Type, plus conditional org/project/funding-route headers. No field literally named "origin"; nearest are `launch_mode`, `project_source`, `funding_route`.

### Feature Flags and Deployment Concerns
- Gate order: prefs.enabled, excludedProjects, allowlist; `collectionGeneration` mismatch => `generation_changed` stop marker. Stop reasons incl. `resume_unknown`.
- Restart proxy daemon after upgrade; hook command migrations 006/009/010/011; commit-after-send implies possible re-send, hence deterministic ids. No sweeper found for parse-state files (unverified).

---

## 6. Risk Indicators

- Shared files/functions: plugin.ts (`onSessionStart`, `onStopEvent`, `onSessionEndEvent`), orchestrator.ts (`openSessionStartPass`, `openMainTranscriptPass`, `openSessionEndPass`, `deriveMainEvents`), and `parse-state.ts` (both fixes likely add fields) => merge-conflict and design coupling if done separately.
- Design dependency: 16993 "has activity" signal should reuse 16992 "own lines" logic; otherwise a continued session's copied lines would look like activity (or a no-activity reopen would look like a pass that produced events).
- Ownership signal for 16992 is unclear: copied lines carry C's rewritten sessionId, so line sessionId cannot discriminate; must use P's uuid set (reading P's transcript) or boundary. Open question: how C learns P's transcript path (hook payload fields / `continued-in` record in P / scanning the project transcript dir). Unverified - needs real transcript samples.
- Summary built from full-file reparse (`buildFullAccumulator`) with no persisted exclusion: the exclusion set must be applied there too (models, tools, turns, startedAt, endedAt), not just in `deriveMainEvents`.
- Summary event_id (`phase+ended_at`) first-wins and `timestamp=endedAt` could be P's last timestamp if C has no own lines.
- Deferring SessionStart (16993) requires persisted pending-start flag and emitting the deferred start with the session's own original start time, else the "extends duration" symptom persists; touches UserPromptSubmit/other activity handlers. Dropping start events risks backend lacking a start for sessions with later real activity.
- Backend behavior assumed (dedup on event_id, binding of dimensions on first evidence request) is not verifiable client-side; the "no re-binding to new launch context" half may only be partially fixable (client can only avoid sending; evidence record/launch headers on later activity still come from the new launch).
- Interaction with `transitionGate` `resume_unknown` and evidence frozen-at-first-hook: a reopened session with prior record proceeds; changes to gating could alter privacy fail-closed behavior (security-sensitive).
- Parse-state load falls back to fresh offset 0 on corruption, which would reproduce re-reporting; schema additions must be backward compatible (no migration tests exist).
- Subagent files for C: unverified whether copied; subagent offsets/registry may also re-report.
- No tests/fixtures for either scenario; orchestrator.test.ts is 3.5k lines (high regression surface).
- Doc must be updated (s6 row + SessionStart/Stop/SessionEnd paragraph); stale reference to missing cli-analytics-events.md.
- Windows path/test portability risk (use path.join).
- Spool/forwarder/daemon was only skimmed by research threads; claims about them come from docs.

---

## 7. Summary for Complexity Assessment

Both bugs live in the Plugin layer of the claude-code-otlp adapter, with a light dependency on Core (OtlpAgentAdapter short-circuit on empty payloads, evidence/stop-marker). Bug 16992 is concentrated in transcript/orchestrator.ts (`deriveMainEvents`, `buildFullAccumulator`, `seedSeenUuids`), `parse-state.ts`, and possibly `transcript-lines.ts` in the sibling claude plugin. Bug 16993 is concentrated in the three lifecycle handlers in claude-code-otlp.plugin.ts plus `openSessionStartPass`. Estimated surface: roughly 5-8 source files plus 5-6 test files and the architecture doc; no spool/daemon/backend changes needed (and those are out of scope).

The work follows existing patterns (ForwardDecision handlers, commit-after-send, seenMessageUuids seeding, empty-payload short-circuit) but introduces new concepts: cross-transcript ownership of lines and deferred/suppressed lifecycle events with persisted state. Both fixes touch the same files and parse-state, and 16993's activity detection should build on 16992's ownership logic, so they should be done in one change or strictly sequenced (16992 first). Principal unknowns: how C locates P's transcript and the real `continued-in` record shape, and how much of the backend binding problem is solvable by suppressing sends.

Test posture is mixed: the orchestrator, parse-state, summary, signals and usage-request modules are well covered with real-temp-dir tests, but there are no fixtures or tests for continued-in transcripts or no-activity reopens, and offset-handoff edge cases are uncovered. Complexity should be scored medium-high: moderate file count, but state-machine and analytics-correctness sensitivity, backend-contract assumptions, and a privacy fail-closed gate adjacent to the change.
