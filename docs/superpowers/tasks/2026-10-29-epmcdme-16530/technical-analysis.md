# Technical Research

**Task**: claude otlp token-usage analytics (EPMCDME-16530)
**Generated**: 2026-10-29
**Research path**: filesystem

---

## 1. Original Context

task_context (verbatim ticket EPMCDME-16530, Bug, "[CLI Analytics] Repository token metrics always zero for codemie-claude sessions"):

h2. Summary
Real token usage exists in local Claude transcript but the cli-repositories endpoint shows 0 for input_tokens, output_tokens, and all cache token fields for all codemie-claude sessions. Token data exists for other session types (OpenCode/codemie-copilot).

h2. Steps to Reproduce
1. Run any codemie-claude session with real model calls.
2. Verify real token usage in ~/.claude/projects/*/session.jsonl (message.usage fields).
3. Query after session end: GET /v1/analytics/cli-repositories?time_period=last_24_hours
4. Observe input_tokens:0, output_tokens:0, cache_*:0 for all codemie-claude sessions.

h2. Expected Result
Repository table shows real token counts matching local transcript usage data.

h2. Actual Result
All token fields are 0 for codemie-claude sessions. Sessions from other agent types (OpenCode) show non-zero token data.

h2. Root Cause (as claimed in ticket — UNVERIFIED, must be checked against src/, ticket cites compiled dist/ paths)
Part A — OTLP proxy authentication failure (dist/agents/plugins/utils.js:forwardOtlpEventsToSpool:37-40): when the claude-code-otlp proxy at port 60005 has expired SSO (health:unhealthy in proxy-daemon.json), it rejects hook POSTs with HTTP 401. Hook events containing agent.usage.request with token data are silently dropped — never stored in the spool, never forwarded. Failure swallowed with only a debug log.
Part B — Tick processor silent abort (tick-processor.js:29-30): even when events reach the spool, the tick processor silently skips all forwarding ticks when SSO is stale (areCredentialsStale() returns true with no log or alert). Events accumulate in ~/.codemie/proxy/otlp-spool/ indefinitely.
Evidence: proxy-daemon.json health:unhealthy, lastHealthyAt 2026-10-28T13:40:21Z, smoke sessions 20:33 UTC (+7h); 0 spool files for smoke sessions; session-sync delta (claude.metrics-processor.js:278-292) intentionally omits token fields to avoid double-counting with the OTLP path.

h2. Recommended Fix (from ticket)
- daemon-manager.js:ensureOtlpProxy: surface stale-credential state as visible user warning; implement SSO credential refresh on expiry; fallback local buffer with retry.
- tick-processor.js:30: add logger.warn() to surface stale credentials instead of silently returning.

h2. Impact
All codemie-claude session token metrics are 0 (cost estimation, cache analysis, per-repository token reports).

h2. Acceptance Criteria
- Given a codemie-claude session with real model calls, when the session completes and syncs, then cli-repositories shows non-zero input_tokens and output_tokens matching the local transcript.
- Given the OTLP proxy has stale SSO credentials, when hook events are rejected with HTTP 401, then a visible warning is surfaced to the user (not just a debug log).
- Given the OTLP proxy is unhealthy, when the tick processor runs, then a warning is logged and events are buffered for retry rather than silently dropped.
- Given valid SSO credentials, when hook events are sent, then token data is stored and forwarded correctly.

Additional user directives: (1) the issue must be REPRODUCED first and the repro scripts/cases saved so they can be re-run after the fix; (2) the fix must be in the proper place, minimal, no unnecessary code or changes, no bias toward the ticket's recommended fix if it is wrong. So in your analysis: independently verify the ticket's root cause against src/ (do not trust it), identify the actual data path of token usage for codemie-claude sessions (claude plugin session metrics vs claude-code-otlp hooks vs spool/forwarder), identify what a reproducible, offline test/script would look like (existing test seams, fixtures), and note which parts of the ticket's claims are wrong/unverifiable.

Repo notes: TypeScript ES modules; src/agents/plugins/claude/, src/agents/plugins/claude-code-otlp/, src/providers/plugins/sso/proxy/ (daemon, tick processor, otlp-spool/forwarder), docs/ARCHITECTURE-OTLP-PLUGIN.md, docs/ARCHITECTURE-PROXY.md. Guides under .ai-run/guides/ (architecture, external-integrations, development-practices). Do not write or run tests; research only.

---

## 2. Codebase Findings

### Existing Implementations (actual token data path, verified in src/)

There are two independent analytics channels for a Claude session. Only one carries tokens.

1. **Session-sync channel (no tokens, for any agent).** Bundled Claude plugin hooks (`src/agents/plugins/claude/plugin/hooks/hooks.json`) run plain `codemie hook` -> `src/cli/commands/hook.ts` (non-OTLP branch, after the `getAnalyticsAgent(opts.agent)` check at ~L1558) -> `ClaudeSessionAdapter` -> `src/agents/plugins/claude/session/processors/claude.metrics-processor.ts` -> `MetricsWriter` deltas -> `src/providers/plugins/sso/session/processors/metrics/metrics-sync-processor.ts`. `processDelta` (metrics-processor L349-363) builds a `MetricDelta` with tools, models, file ops, prompts, named invocations. It carries no token fields. `metrics-types.ts:80` states "NOTE: No token fields" for `ToolUsageAttributes`. This is a repo-wide design (token tracking was removed in 3ee529f6, "#183"); it is not Claude-specific and there is no "double-counting" comment in src (ticket's "intentionally omits ... to avoid double-counting" is not present as a stated reason).
2. **OTLP hooks channel (the only token source for Claude).** `codemie hook --agent claude-code-otlp` -> `AgentRegistry.getAnalyticsAgent` -> `ClaudeCodeOtlpPlugin extends OtlpAgentAdapter` (`src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts`). On `Stop`/`PreCompact`/`SessionEnd`/`SubagentStop` it reads the Claude transcript (`transcript/orchestrator.ts`: `openMainTranscriptPass` ~L557-581, subagent pass ~L1125-1138) and emits one `agent.usage.request` per `message.usage` line via `transcript/usage-request.ts` (`parseUsageLine`, `mergeUsageRequest`, `buildUsageRequestEvent`; fields `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_5m/1h_tokens`, ...). Lines with neither `requestId` nor `message.id` are skipped; API-error rows are filtered.
3. **Transport.** Hook process: `OtlpAgentAdapter.processOtlpEvent` (`src/agents/core/OtlpAgentAdapter.ts` L68-143) -> `isTracked` (allowlist) -> `ensureOtlpProxy` (`src/cli/commands/proxy/connect-orchestrator.ts` L452) -> `evaluate` -> `forwardOtlpEventsToSpool` (`src/agents/plugins/utils.ts`) POST `{state.url}/v1/analytics/hooks` with `Bearer state.gatewayKey` (3s timeout, returns bool, debug-only logging). Commit-after-send: `finalize(accepted)` persists the transcript cursor only when accepted, so a rejected batch is re-derived and re-sent on the next hook (not lost). Daemon: `src/providers/plugins/sso/proxy/plugins/otlp.plugin.ts` `handleHooks` appends to `~/.codemie/proxy/otlp-spool/<session>.hooks.ndjson`. Forwarding: `OtlpInterceptor.tick` (every `OTLP_SEND_INTERVAL_MINUTES`, default 2) -> `otlp-spool/tick-processor.ts processSessionTick` -> `completeness-gate.ts gateDecision` -> `otlp-spool/forwarder.ts forwardSession/forwardHooks/send` -> backend `CODEMIE_ENDPOINTS.CLI_ANALYTICS_EVENT_HOOKS`.
4. **Hooks for the channel are not installed by `codemie-claude`.** `claude-code-otlp` hooks are written into `~/.claude/settings.json` only by `codemie proxy connect --claude-code-otlp` (`src/cli/commands/proxy/connectors/claude-code-otlp.ts`, marker `hook --agent claude-code-otlp`, L228; flow in `claude-code-otlp-flow.ts`). The claude plugin `beforeRun` sets `CLAUDE_CODE_ENABLE_TELEMETRY=0` when unset (claude.plugin.ts ~L272). `claude-code-otlp` has no guard against managed (`codemie-claude`) sessions: `isTracked` is only the project allowlist (`readAllowlistState`, absent = all tracked). Contrast `copilot-cli-otlp.plugin.ts` L51-54, which skips when `CODEMIE_SESSION_ID` is set.

### Architecture and Layers Affected
CLI hook layer (`src/cli/commands/hook.ts`), agent adapter layer (`OtlpAgentAdapter`, `claude-code-otlp`), local proxy-daemon layer (`otlp.plugin.ts`, `otlp-spool/*`), SSO provider session-sync layer (`sso/session/processors/metrics`). Backend (`cli-repositories` aggregation) is outside this repo.

### Integration Points
`daemon-manager.ts readState` (`~/.codemie/proxy-daemon.json`: pid, port, url, gatewayKey, health, lastHealthyAt); `GatewayKeyPlugin` (priority 7) sets `ctx.metadata.gatewayKeyValidated`; `auth-state.ts` module-level `credentialsStale` flag; `OtlpInterceptor.refreshCredentialsIfStale` (tick + on every inbound request) re-reads the credential store and clears the flag.

### Patterns and Conventions
`OtlpAgentAdapter` dispatch pattern (docs/ARCHITECTURE-OTLP-PLUGIN.md); `@/` alias, `.js` import extensions, `logger.*` with `sanitizeLogArgs`; deterministic `event_id` content-hashed for `agent.usage.request`.

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/` exists (architecture, development-practices, integration, testing, standards); not opened in depth (research scoped to code). `docs/ARCHITECTURE-OTLP-PLUGIN.md` (contract, commit-after-send, event_id) and `docs/ARCHITECTURE-PROXY.md` apply. `openwiki/workflows/agent-launch-and-session-telemetry.md` covers launch/telemetry.

### Architectural Decisions
auth-state.ts header: stale flag suspends forwarding; "Spool data keeps accumulating on disk while stale, so nothing is lost." tick-processor.ts comments: skipping resumes after credential refresh. Commit-after-send in OtlpAgentAdapter L105-110.

### Derived Conventions
Failure of hook-side forward is deliberately non-fatal and debug-logged (hook must never break Claude Code).

---

## 4. Testing Landscape

### Existing Coverage (reusable offline seams)
- `src/agents/plugins/__tests__/otlp-forward.test.ts`: `forwardOtlpEventsToSpool` with mocked `readState` and stubbed `fetch` (2xx/non-2xx/daemon-missing).
- `src/providers/plugins/sso/proxy/plugins/__tests__/otlp.plugin.hooks.test.ts`: `handleHooks` incl. `agent.usage.request`; `gateway-key.plugin.test.ts`: the only 401 source on `/v1/analytics/hooks`.
- `otlp-spool/__tests__/forwarder.test.ts`: 401 retry, two 403s / 302 => `markCredentialsStale`, cursor untouched; `tick-processor.test.ts` (tmp spool root, `forwarder.js` and `auth-state.js` mocked); `auth-state.test.ts`; `otlp.plugin.credentials-refresh.test.ts` (stale -> refresh -> resume).
- `src/agents/plugins/claude-code-otlp/transcript/__tests__/` (`usage-request.test.ts`, `orchestrator.test.ts`, `fixtures/`) and `claude-code-otlp.plugin.test.ts` (L990, L1111 usage events): transcript -> `agent.usage.request` offline.
- `src/agents/plugins/claude/__tests__/fixtures/*.jsonl` are history fixtures only; no metrics-processor test asserts tokens.

### Testing Framework and Patterns
Vitest (`vi.mock`, dynamic import after mocks, `vi.stubGlobal('fetch')`, tmp dirs for spool). Tests run only on explicit user request (AGENTS.md).

### Coverage Gaps
No end-to-end test chaining transcript -> hook adapter -> `/v1/analytics/hooks` -> spool -> forwarder with stale/expired credentials. No test or guard asserting how a managed `codemie-claude` session (CODEMIE_SESSION_ID set, `CLAUDE_CODE_ENABLE_TELEMETRY=0`) interacts with `claude-code-otlp` hooks. No test of the daemon's behavior when the stored state is `health: unhealthy`.

---

## 5. Configuration and Environment

### Environment Variables
`OTLP_SEND_INTERVAL_MINUTES` (2), `OTLP_SEND_MAX_ATTEMPTS` (3 wait ticks), `OTLP_ALLOW_HOOKS_ONLY_FORWARD` (default true), `OTLP_SWEEP_INTERVAL_MINUTES`, `OTLP_ENDED_SESSION_GRACE_MINUTES`, `OTLP_ABANDONED_SESSION_GRACE_MINUTES` (all `spool-config.ts`); `CODEMIE_ANALYTICS_PROJECT_FILTER` (in `~/.claude/settings.json` env); `CODEMIE_SESSION_ID`; `CLAUDE_CODE_ENABLE_TELEMETRY`.

### Configuration Files
`~/.codemie/proxy-daemon.json` (state, default port from `DEFAULT_DAEMON_PORT`; on this machine port 4001, not 60005 as ticket says); `~/.codemie/proxy/otlp-spool/<session>.{hooks.ndjson,otel_*.bin,status}`; `~/.claude/settings.json` (hooks, allowlist).

### Feature Flags and Deployment Concerns
None. Daemon is spawned detached (`bin/proxy-daemon.js`); its logger output is not user-visible.

---

## 6. Risk Indicators

Ticket claim verification against src/ (dist/ matches src/ for the cited lines, so line drift is not the issue):

- **Part A is wrong as stated.** `handleHooks` returns 401 only when `ctx.metadata.gatewayKeyValidated` is false (local gateway key mismatch; `otlp.plugin.ts` L200-203, `gateway-key.plugin.ts` L55-64). It never consults SSO credentials, so expired SSO cannot cause a 401 on `/v1/analytics/hooks`. `readState` is re-read on every hook, so key drift is unlikely. `health: unhealthy` in the state file does not stop `handleHooks`. Events are not "dropped": a failed forward leaves the transcript cursor uncommitted and the next hook re-sends the same bytes (`finalize(accepted)`).
- **Part B is mostly wrong.** Silent return exists (`tick-processor.ts` L36-38) but staleness is set only by `markCredentialsStale()` after two auth failures in `forwarder.ts` (L297-310), which already logs `logger.warn` once ("analytics credentials rejected - telemetry is being spooled to disk..."). Spool is retained, not lost; recovery is already implemented (`refreshCredentialsIfStale` on tick and on every inbound request, `resolveFreshCredentials`). Adding another `logger.warn` per tick would be log spam in a daemon log; "buffered for retry" is already true.
- **The ticket's evidence is internally unsupported.** "0 spool files for smoke sessions" suggests hook events never reached the daemon at all (hooks not firing, tracked-project gate, daemon not running, or POST failing), not a stale-credential tick skip (which keeps files). Port 60005 and lastHealthyAt 2026-10-28 are not reproducible here; the local daemon state is `health: ok`, `clientType: claude-code-otlp`.
- **Local counter-evidence.** `~/.codemie/proxy/otlp-spool/a9458e24-...hooks.ndjson` (a claude-code-otlp session on this machine) holds 16 `agent.usage.request` events, all with non-zero tokens, scope main/skill/agent. So the hook -> spool half works when hooks are installed and the daemon is up.
- **Most plausible real gap (Speculative, needs repro):** a `codemie-claude` session produces tokens only if the user ever ran `codemie proxy connect --claude-code-otlp` (hooks in `~/.claude/settings.json`) and the hook-time `ensureOtlpProxy`/daemon is reachable. The session-sync channel never carries tokens. Also the hook event's `session_id` is Claude's native id while the session-sync metrics are keyed by `CODEMIE_SESSION_ID`; whether the backend `cli-repositories` joins token events to repositories for managed sessions cannot be determined from this repo. Candidate causes to test: (a) hooks absent for `codemie-claude`, (b) hook-time forward failing (daemon missing/unhealthy -> `ensureOtlpProxy` early-returns when pid alive without a health check, L455), (c) backend join/session-id mismatch.
- `ensureOtlpProxy` returns early for any live pid without checking `health` (connect-orchestrator.ts L455); `ensureDaemon` health check only runs on the other path. Speculative: this is the only code path that could leave an unhealthy daemon in place for hooks.
- Ticket's recommended fixes (SSO refresh in `ensureOtlpProxy`, local buffer) duplicate existing behavior (`refreshCredentialsIfStale`, spool, commit-after-send) and risk unnecessary code.
- Backend (`cli-repositories`) is not in the repo: acceptance criterion 1 is not verifiable by any repo test.
- `codemie hook` hook-time failures are debug-only by design; a user-visible warning at hook level touches Claude Code's output channel.

---

## 7. Summary for Complexity Assessment

Token data for Claude sessions flows exclusively through the `claude-code-otlp` OTLP hooks channel (transcript -> `agent.usage.request` -> hook POST -> daemon spool -> tick -> forwarder -> backend). The `codemie-claude` session-sync channel (`claude.metrics-processor.ts`) never carries tokens, by repo-wide design. Layers touched by any candidate fix: hook adapter (`OtlpAgentAdapter`/`claude-code-otlp`), daemon spool/forwarder, and possibly `connect-orchestrator.ts`. The ticket's two-part root cause does not hold against src/: SSO expiry cannot produce a 401 on `/v1/analytics/hooks`, and stale credentials already log a warning, retain the spool and auto-recover. The actual root cause is not yet identified; the strongest candidates are hook absence for managed `codemie-claude` sessions, a hook-time forward failure against a dead or unhealthy daemon, or a backend join on session id (out of repo).

Test posture is strong at unit level for every segment (transcript parsing, `forwardOtlpEventsToSpool`, `handleHooks`, forwarder auth, tick processor, credential refresh), all offline with Vitest mocks and tmp spool roots. There is no cross-segment reproduction. A faithful offline repro would: feed a Claude transcript fixture with `message.usage` lines into `ClaudeCodeOtlpPlugin.processOtlpEvent` with injected `OtlpAdapterDeps` whose `forwardOtlpEventsToSpool` is wired to `OtlpInterceptor.handleRequest` (or the real `appendSpool` on a tmp spool root), then run `processSessionTick` with a mocked `fetch` (valid creds, then 401/403) and assert the backend body contains non-zero `input_tokens`/`output_tokens`; a second case runs the managed-session shape (`CODEMIE_SESSION_ID` set, no OTEL streams) through the gate. A real-machine repro can also use the existing spool/`proxy-daemon.json` and a real `codemie-claude` run, without modifying user config.

Key risk: scope can balloon if the ticket's recommended fixes are followed; evidence supports a minimal, targeted change only after the repro identifies which segment loses tokens. Complexity signals: undocumented managed-session/OTLP interplay, daemon state and backend outside repo, no existing e2e test.

---

## 8. External References

None named by the task as a source-of-truth path (the ticket cites compiled `dist/` files; those were checked and match `src/`: `dist/agents/plugins/utils.js`, `dist/providers/plugins/sso/proxy/plugins/otlp-spool/tick-processor.js`, `dist/agents/plugins/claude/session/processors/claude.metrics-processor.js`; the backend `cli-repositories` endpoint and ticket-quoted `proxy-daemon.json` (port 60005, lastHealthyAt 2026-10-28T13:40:21Z) are unavailable and unverifiable here).
