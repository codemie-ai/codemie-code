# Technical Research

**Task**: otlp proxy cursor-ide analytics
**Generated**: 2026-09-16
**Research path**: filesystem

---

## 1. Original Context

Wire the proxy → CodeMie backend leg for cursor-ide OTLP event forwarding. Full requirements (verbatim, from PLAN-cursor-ide-otlp-event-hooks.md at repo root):

Context: cursor-ide OTLP forwarding currently only covers cursor hooks → local proxy (hook.ts bypass → forwardOtlpEvent() → OtlpIngestPlugin appending to ~/.codemie/logs/hook-events.jsonl, a debug sink). The proxy → CodeMie backend leg has never been built. This is PoC-scope: transform the raw Cursor hook payload into a record shape the backend already consumes, and push it to a locally-running CodeMie instance. No retry/backoff, no queueing, no tests unless requested. The /event-hooks transform is a no-op passthrough (send raw hook payload as NDJSON). /metrics, /logs, /traces get scaffolding only (endpoint constants + no-op stub push methods), not wired into any call site.

Backend target (no backend changes needed): POST /v1/analytics/cli-analytics/event-hooks, NDJSON body, Content-Type: application/x-ndjson, auth via cookie/Bearer JWT, gated by customer_config.is_feature_enabled("cliAnalytics") (already enabled locally).

Code changes required in codemie-code-fork:
1. src/providers/plugins/sso/sso.http-client.ts — add CLI_ANALYTICS_EVENT_HOOKS, CLI_ANALYTICS_METRICS, CLI_ANALYTICS_LOGS, CLI_ANALYTICS_TRACES to CODEMIE_ENDPOINTS (matching existing convention).
2. src/providers/plugins/sso/proxy/plugins/otlp-ingest.plugin.ts:
   - OtlpIngestPlugin.createInterceptor(context): stop ignoring context; pass context.syncCredentials || context.credentials and context.config.syncApiUrl into OtlpIngestInterceptor's constructor, matching SSOSessionSyncPlugin.createInterceptor's pattern (sso.session-sync.plugin.ts:38, :72-80). No ConfigurationError throw on missing creds (plugin must stay registered unconditionally since local debug-append must keep working without backend config).
   - OtlpIngestInterceptor constructor takes (credentials?: SSOCredentials | JWTCredentials, baseUrl?: string), stores as private fields.
   - Keep existing appendFile local-JSONL write as-is.
   - Add private transformToEventHookRecord(payload: OtlpEventPayload): Record<string, unknown> — no-op passthrough: best-effort JSON.parse(payload.raw), fallback to { raw: payload.raw } if invalid, spread as-is, add minimal structural fields like agent_type: payload.agentName. No business-field mapping. One-line comment marking it as deliberate no-op.
   - Add private pushToBackend(record): Promise<void> — fire-and-forget, mirrors forwardOtlpEvent's shape (try/catch-all, AbortController + short timeout, debug-level logging only, never throws). Early-return (debug log) if no credentials or no baseUrl. Build headers via buildAuthHeaders(...) from providers/core/codemie-auth-helpers.ts — pass credentials.cookies for SSOCredentials, credentials.token for JWTCredentials (use isSSOCredentials/isJWTCredentials type guards from providers/core/types.ts), override Content-Type to application/x-ndjson. fetch(`${baseUrl}${CODEMIE_ENDPOINTS.CLI_ANALYTICS_EVENT_HOOKS}`, {method: 'POST', headers, body: JSON.stringify(record) + '\n', signal}). No retry/backoff, swallow non-2xx and errors at debug level.
   - In handleRequest, after existing local append + before responding 202: call `void this.pushToBackend(this.transformToEventHookRecord(payload))` without awaiting.
   - Add private no-op stub methods pushMetrics(data), pushLogs(data), pushTraces(data) — each a TODO comment + immediate return, not called anywhere.

No other files change; no tests added.

---

## 2. Codebase Findings

### Existing Implementations

- `src/providers/plugins/sso/proxy/plugins/otlp-ingest.plugin.ts` — the file to modify. Currently:
  - `OtlpIngestPlugin.createInterceptor(_context: PluginContext)` ignores context entirely and constructs `new OtlpIngestInterceptor()` with no args (line 23-25).
  - `OtlpIngestInterceptor.handleRequest` (lines 31-142) handles `POST /v1/otlp/hook-events` only: requires `ctx.metadata.gatewayKeyValidated` (401 otherwise), parses `ctx.requestBody` JSON into `OtlpEventPayload {agentName, timestamp, raw}` (400 on parse failure or missing fields), appends to `~/.codemie/logs/hook-events.jsonl` via `appendFile`/`mkdir` (`getCodemiePath('logs', 'hook-events.jsonl')`), logs at debug, then responds 202 `{accepted: true}`. Catch-all wraps the whole body, returns 500 on unexpected errors.
  - Local `interface OtlpEventPayload { agentName: string; timestamp: string; raw: string }` is defined at module scope (lines 11-15) — matches the shape the task's `transformToEventHookRecord(payload: OtlpEventPayload)` will consume.
- `src/providers/plugins/sso/proxy/plugins/sso.session-sync.plugin.ts` — the pattern to mirror for `createInterceptor`. `SSOSessionSyncPlugin.createInterceptor(context)` (lines 37-81) reads `context.syncCredentials || context.credentials`, throws `ConfigurationError` on several missing-prerequisite branches (session ID, non-SSO credentials, client type, sync disabled), then passes `context.config.syncApiUrl` plus other config fields into the constructed interceptor. The task explicitly says **not** to replicate the `ConfigurationError` throw for otlp-ingest.
- `src/agents/plugins/cursor-ide/cursor-ide.otlp-forwarder.ts` — `forwardOtlpEvent(rawInput, agentName)` (lines 19-64) is the shape `pushToBackend` must mirror: reads daemon state, builds an `AbortController` + `setTimeout(..., 1500)` timeout, `fetch`s with a `finally { clearTimeout(timeout) }`, and a top-level `try/catch` that only `logger.debug`s on any failure — never throws, never affects caller behavior. `cli/commands/hook.ts:1613` is the sole caller (`await forwardOtlpEvent(input, agentName)`), reached via a "bypass" path noted in `src/agents/core/types.ts:692`.
- `src/providers/plugins/sso/sso.http-client.ts` — `CODEMIE_ENDPOINTS` const object (lines 19-26) currently has `MODELS`, `USER_SETTINGS`, `USER`, `ADMIN_APPLICATIONS`, `METRICS`, `AUTH_LOGIN`. All consumed as `${apiUrl}${CODEMIE_ENDPOINTS.X}` string templates by the functions in the same file (`fetchCodeMieLlmModels`, `fetchCodeMieModels`, `fetchApplicationDetails`, `fetchCodeMieIntegrations`) — confirms the "matching existing convention" the task references.
- `src/providers/core/codemie-auth-helpers.ts` — `buildAuthHeaders(auth: Record<string, string> | string)` (lines 30-48) returns headers with `Content-Type: application/json`, `User-Agent`, `X-CodeMie-CLI`, `X-CodeMie-Client`, plus `cookie` (built from a `Record<string,string>`) or `authorization: Bearer <token>` (string arg) depending on argument type — no explicit overload signatures on this helper (unlike the SSO client fetch functions above), just one param that's either a cookie-map or a token string.
- `src/providers/core/types.ts` — `SSOCredentials { cookies, apiUrl, expiresAt? }` (line 432), `JWTCredentials { token, apiUrl, expiresAt? }` (line 441), `AuthCredentials = SSOCredentials | JWTCredentials`, and the type guards `isJWTCredentials` (line 455, checks `'token' in creds && !('cookies' in creds)`) and `isSSOCredentials` (line 462, checks `'cookies' in creds && !('token' in creds)`) — exactly the guards named in the task.
- `src/providers/plugins/sso/proxy/plugins/types.ts` — `PluginContext` (lines 47-54) carries `config: ProxyConfig`, `credentials?: SSOCredentials | JWTCredentials`, `syncCredentials?: SSOCredentials | JWTCredentials`, `profileConfig?`, plus an index signature. `ProxyPlugin.createInterceptor(context: PluginContext): ProxyInterceptor | Promise<ProxyInterceptor>` (line 35) — return type already allows async, matching `SSOSessionSyncPlugin`'s `async createInterceptor`.
- `src/providers/plugins/sso/proxy/proxy-types.ts` — `ProxyConfig.syncApiUrl?: string` (line 31, comment: "Optional CodeMie API URL for analytics/session sync") is the field the task names for `baseUrl`.
- `src/providers/plugins/sso/proxy/sso.proxy.ts` (lines 67-118) — where `PluginContext` is actually assembled: `credentials`/`syncCredentials` are resolved (via `sso.getStoredCredentials(...)`) before being placed on the `pluginContext` object passed to every plugin's `createInterceptor`.
- `src/providers/plugins/sso/proxy/plugins/registry.ts` — registers `OtlpIngestPlugin` at line 49 with the comment "Priority 10 - OTLP hook event ingestion"; no changes needed there since priority/registration itself is untouched.

### Architecture and Layers Affected

- **Proxy plugin layer** (`src/providers/plugins/sso/proxy/plugins/`) — the sole layer touched for code change #2. `OtlpIngestPlugin` (plugin class) and `OtlpIngestInterceptor` (interceptor class implementing `handleRequest`) both live here.
- **SSO HTTP client layer** (`src/providers/plugins/sso/sso.http-client.ts`) — touched only to add four string constants to an existing exported const object; no new functions required by the task.
- **Cross-cutting auth helpers** (`src/providers/core/codemie-auth-helpers.ts`, `src/providers/core/types.ts`) — consumed, not modified: `buildAuthHeaders` and the `isSSOCredentials`/`isJWTCredentials` guards.
- **Agent/CLI layer** (`src/cli/commands/hook.ts`, `src/agents/plugins/cursor-ide/cursor-ide.otlp-forwarder.ts`) — upstream leg (cursor hook → local proxy), explicitly out of scope; referenced only as the pattern source for `pushToBackend`'s fire-and-forget shape.

### Integration Points

- Internal: `OtlpIngestInterceptor.handleRequest` (existing) → local JSONL append (unchanged) → new `pushToBackend` fire-and-forget call → 202 response (unchanged timing, per the task's explicit instruction not to await the backend push).
- Internal: `OtlpIngestPlugin.createInterceptor` receives `PluginContext` from `sso.proxy.ts`'s plugin-context assembly (`credentials`/`syncCredentials`/`config.syncApiUrl` already flow through this object for other plugins, e.g. `SSOSessionSyncPlugin`).
- External: new outbound `fetch` from the interceptor to `${baseUrl}${CODEMIE_ENDPOINTS.CLI_ANALYTICS_EVENT_HOOKS}` on a locally-running CodeMie backend (`POST /v1/analytics/cli-analytics/event-hooks`, NDJSON body) — this endpoint and its backend-side gating (`customer_config.is_feature_enabled("cliAnalytics")`) live in the separate `codemie-ai/codemie` repo (`src/codemie/rest_api/routers/cli_analytics.py`), not in this repository; no backend-side code is being read or changed here.

### Patterns and Conventions

- Fire-and-forget outbound calls consistently follow: `try { AbortController + setTimeout(timeoutMs) } catch (all) { logger.debug(...) } finally { clearTimeout }`, never throwing to the caller — seen in `forwardOtlpEvent` and expected to be mirrored in `pushToBackend`.
- Plugin `createInterceptor` methods resolve credentials via `context.syncCredentials || context.credentials` (established in `SSOSessionSyncPlugin`) rather than reading only one field.
- Endpoint path constants are centralized in `CODEMIE_ENDPOINTS` in `sso.http-client.ts` and referenced by template-literal URL construction (`${apiUrl}${CODEMIE_ENDPOINTS.X}`), not hardcoded inline strings, across every existing SSO HTTP client function.
- Sensitive log fields go through `sanitizeLogArgs()` (`src/utils/security.ts`), used throughout `otlp-ingest.plugin.ts` already — any new debug logging in `pushToBackend`/`transformToEventHookRecord` should keep that convention (per AGENTS.md pitfalls table as well).
- Auth header construction is centralized in `buildAuthHeaders(auth)`, which accepts either a cookie map or a token string and switches on `typeof auth`.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/integration/external-integrations.md` documents session-analytics flows for OpenCode, Codex, and MCP OAuth in detail (e.g. "Session Analytics Flow" section, Codex Pipeline A/B) but has **no section on cursor-ide or OTLP hook-event forwarding** — this feature was added after the guide's last update (git log shows the cursor-ide OTLP forwarder commits — `19c260b`, `06fac64`, `625b337`, `6a83d01` — as the most recent commits touching this area, and none of them updated the guide).
- No `.ai-run/guides/` entry specifically for `otlp-ingest.plugin.ts` or the proxy `handleRequest` bypass pattern; closest analog is the MCP auth relay description in the same guide ("custom routing" bypass pattern is documented generically in `types.ts`'s `handleRequest` doc-comment, not in a guide).

### Architectural Decisions

- `src/agents/core/types.ts:692` carries an inline comment referencing `forwardOtlpEvent` behavior ("daemon ... and returns immediately, before the shared ..."), documenting the never-block-the-hook design intent at the source level rather than in a guide.
- `src/providers/plugins/sso/proxy/plugins/types.ts:104-118` documents the `handleRequest` bypass contract in detail (skips all other plugin hooks; handling plugin owns its own security guarantees) — this is the architectural decision that lets `OtlpIngestInterceptor` fully own request/response handling for its route.
- PLAN-cursor-ide-otlp-event-hooks.md (repo root, read in full under Section 8) is itself the most current design record for this specific leg; no separate ADR exists.

### Derived Conventions

- Plugins that need credentials at construction time receive them once, at `createInterceptor` time, as constructor arguments — not looked up per-request inside `handleRequest`.
- Plugins that must remain always-registered regardless of configuration state (unlike `SSOSessionSyncPlugin`, which opts out via thrown `ConfigurationError`) instead store `undefined` credentials/baseUrl and check for their presence per-call-site (this is the pattern the task asks to introduce for `OtlpIngestInterceptor`, since no precedent for "unconditionally registered, optionally backend-connected" plugin currently exists in this codebase).

---

## 4. Testing Landscape

### Existing Coverage

- No test file exists for `otlp-ingest.plugin.ts`. `src/providers/plugins/sso/proxy/plugins/__tests__/` contains tests for `sso.session-sync.plugin.ts`, `gateway-key.plugin.ts`, `claude-request-normalizer.plugin.ts`, `codex-*normalizer/sanitizer*.plugin.ts`, `copilot-encrypted-content-sanitizer.plugin.ts`, `endpoint-blocker.plugin.ts`, `request-sanitizer.plugin.ts`, `vscode-request-normalizer.plugin.ts` — `otlp-ingest.plugin.ts` and `header-injection.plugin.ts`/`jwt-auth.plugin.ts`/`logging.plugin.ts`/`mcp-auth.plugin.ts`/`sso-auth.plugin.ts` have no dedicated test files either.
- No test file exists for `cursor-ide.otlp-forwarder.ts` in `src/agents/plugins/cursor-ide/` (directory not enumerated with a `__tests__` subfolder in this search, and no `otlp-forwarder.test.ts` found).
- No test file exists for `sso.http-client.ts`'s `CODEMIE_ENDPOINTS` object (it's a plain const; the file's tested functions live under `src/providers/plugins/sso/__tests__/sso.auth.test.ts`, which does not appear to cover this specific export by name from this search).

### Testing Framework and Patterns

- Vitest is the framework (per AGENTS.md / `.ai-run/guides/testing/testing-patterns.md`); dynamic-import mocking is the established pattern for modules with side-effecting imports. `sso.session-sync.plugin.test.ts` exists alongside the plugin it mirrors as the closest structural precedent for how an `otlp-ingest.plugin.test.ts` would be organized.

### Coverage Gaps

- No tests today for: `OtlpIngestPlugin.createInterceptor` context-passing, `OtlpIngestInterceptor` constructor field storage, `transformToEventHookRecord`'s parse/fallback branches, or `pushToBackend`'s early-return/header-building/fetch-error-swallowing behavior. Task explicitly does not request tests be added.

---

## 5. Configuration and Environment

### Environment Variables

- No cursor-ide/OTLP-specific env vars found in source. Adjacent analytics/sync env vars in the same plugin family: `CODEMIE_SESSION_SYNC_ENABLED`, `CODEMIE_SESSION_DRY_RUN`, `CODEMIE_SESSION_SYNC_INTERVAL`, `CODEMIE_DEV_API_URL`, `CODEMIE_DEV_API_KEY` (all read in `sso.session-sync.plugin.ts`) — none of these gate `otlp-ingest.plugin.ts` today, and the task does not add any new env var gating for the backend push.
- The plan document notes a backend-side env var `FEATURE_CLI_ANALYTICS` exists as an override in the separate `codemie-ai/codemie` repo, but states it "isn't needed since the yaml flag is already on" — not relevant to this repo's code changes.

### Configuration Files

- `ProxyConfig` (`src/providers/plugins/sso/proxy/proxy-types.ts`, lines 13-40) is the config surface for the proxy plugin layer; `syncApiUrl?: string` (line 31) and `syncCodeMieUrl?: string` (line 32) are the two URL-shaped fields already present and relevant to this task's `baseUrl` parameter.
- No dedicated `config/` file, `.env.example` entry, or JSON schema found specifically for OTLP ingestion; the gateway-key mechanism (`ctx.metadata.gatewayKeyValidated`, checked by `gateway-key.plugin.ts` at priority 7 before `otlp-ingest.plugin.ts`'s priority 10) is the only local config-adjacent gate on this route today.

### Feature Flags and Deployment Concerns

- No feature flag in this repo's code toggles the cursor-ide OTLP forwarding path; gating is entirely on the backend side (`customer_config.is_feature_enabled("cliAnalytics")`), external to this repository per the plan document.
- No CI/CD or Dockerfile references to `otlp`, `cursor-ide`, or `cli-analytics` found in this repo.

---

## 6. Risk Indicators

- No existing test coverage for `otlp-ingest.plugin.ts` at all (before or after this change) — any regression in the existing local-JSONL-append behavior would go undetected unless tests are separately requested.
- Speculative: `OtlpIngestPlugin` is the first plugin in this codebase designed to stay unconditionally registered while optionally connecting to a backend (no `ConfigurationError` gating, unlike every other credentialed plugin such as `SSOSessionSyncPlugin`) — this is a genuinely novel pattern here, so the early-return-on-missing-credentials/baseUrl logic in `pushToBackend` has no directly copyable precedent in this repo and needs careful manual verification (e.g. via the plan's documented manual test steps) rather than relying on an existing analogous test to catch mistakes.
- Speculative: because `handleRequest` fully bypasses the rest of the plugin pipeline (per `types.ts:104-118`), any error thrown inside the new `pushToBackend`/`transformToEventHookRecord` code paths that isn't caught internally could surface through the existing outer `catch` in `handleRequest` and turn a would-be 202 into a 500 for the local-debug-append leg too — the task's requirement that `pushToBackend` "never throws" is the direct mitigation, and should be verified carefully since it changes response behavior for the already-working local sink if violated.
- Cross-repo dependency: the backend endpoint (`codemie-ai/codemie` repo) and the local docker-compose validation environment are outside this repository and were not (and could not be) inspected here; correctness of the NDJSON/dict-shape assumptions rests on the plan document's description only, not on backend source review.
- No guide in `.ai-run/guides/` documents this feature area yet (confirmed absent from `external-integrations.md`), meaning downstream implementers have no curated pattern to check beyond `SSOSessionSyncPlugin` and `forwardOtlpEvent`, both cited directly in the plan itself.

---

## 7. Summary for Complexity Assessment

This task touches exactly one plugin file (`src/providers/plugins/sso/proxy/plugins/otlp-ingest.plugin.ts`) plus one small addition to a shared endpoint-constants file (`src/providers/plugins/sso/sso.http-client.ts`). Both are within the proxy-plugin architectural layer; no router/CLI/agent-layer files change, no DB models or migrations are involved, and the backend side is explicitly out of scope with "no backend changes needed." The change surface is small and localized: modify one `createInterceptor` signature usage, add a constructor with two optional private fields, add three private methods (`transformToEventHookRecord`, `pushToBackend`, and three no-op stubs), and one new call site inside an existing `handleRequest`.

Technical novelty is moderate rather than high: the fire-and-forget-fetch pattern is directly copyable from `forwardOtlpEvent`, and the credentials-resolution pattern is directly copyable from `SSOSessionSyncPlugin.createInterceptor` - but the specific combination (stay registered unconditionally, no `ConfigurationError` gate, optional backend connectivity) has no existing precedent in this codebase, so it can't be pure copy-paste. The auth-header-building step correctly reuses `buildAuthHeaders` and the `isSSOCredentials`/`isJWTCredentials` guards already defined in `providers/core/`.

Test coverage posture is currently zero for the file being changed, and the task explicitly excludes adding tests, so verification depends on the plan's manual testing steps (local docker-compose backend, real SSO login, live hook fire, ClickHouse query) rather than on any automated safety net. Key risk factors are: (1) no prior test harness to catch behavioral regressions in the local-JSONL-append leg if the new code accidentally throws past its own guards, and (2) an undocumented domain (no `.ai-run/guides/` entry covers cursor-ide OTLP forwarding), so future maintainers have only source code and this plan as reference.

---

## 8. External References

- `PLAN-cursor-ide-otlp-event-hooks.md` (repo root, `/Users/Uladzislau_Mamantau/projects/epam/codemie-code-fork/PLAN-cursor-ide-otlp-event-hooks.md`) — resolved and read in full. This is the task's canonical source of truth; the entire verbatim task_context text is a direct excerpt of it. Key facts not already covered by the task_context that a downstream spec may need:
  - **Acceptance criteria** (not fully in task_context): "raw hook-event data sent to `POST /v1/analytics/cli-analytics/event-hooks` is visible in the local ClickHouse instance (`codemie_analytics.coding_agent_hook_events`, via the `mv_hook_events` materialized view). `/metrics`/`/logs`/`/traces` are scaffolded only - no functional or observability requirement on them in this PoC."
  - **Backend dict-shape hint** (best-effort mapping target for a *future* colleague, not required by this PoC): `type` field drives severity (`agent.tool.error`/`agent.turn.error`/`agent.tool.denied` → ERROR/WARN, else INFO); optional keys include `session_id`, `prompt_id`, `agent_id`, `agent_type`, `cwd`, `tool_name` (`_EVENT_ATTRIBUTE_KEYS`), all rendering as empty strings if missing. Backend auth is the plain `authenticate` dependency (cookie or Bearer JWT), no admin gate; gate is `customer_config.is_feature_enabled("cliAnalytics")`, already `enabled: true` locally.
  - **Local docker environment** (manual-testing context, not code): `../codemie/docker-compose.yml` brings up `codemie` backend at `http://localhost:8080`, `clickhouse` (HTTP `:8123`, native `:9000`, creds `otel`/`otel`, schema auto-loaded from `config/clickhouse/schema.sql`), and `otelcollector` (HTTP `:14318`/gRPC `:14317`, offset from standard ports). Local IDP mode seeds `admin@codemie.ai` / `password`; `POST http://localhost:8080/login` with `{email, password}` returns a token and sets an auth cookie.
  - **Manual testing steps** (documented in the plan for the PR, not code): bring up docker-compose, point a codemie-code-fork profile at `localhost:8080` and log in to get real SSO cookies, run `codemie proxy connect --cursor-ide --analytics`, fire a hook (`echo '<sample cursor hook json>' | codemie hook --agent cursor-ide`), verify `~/.codemie/logs/hook-events.jsonl` still gets the raw entry, check daemon/proxy debug logs for the `pushToBackend` POST and its response status, then query ClickHouse for rows in `coding_agent_hook_events`. Finish with `npm run typecheck` / `npm run lint`, no test run unless separately requested.
