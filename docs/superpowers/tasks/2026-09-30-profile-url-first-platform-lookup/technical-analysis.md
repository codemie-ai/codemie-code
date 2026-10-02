# Technical Research

**Task**: sso credentials baseUrl codeMieUrl platform-url resolver
**Generated**: 2026-09-30
**Research path**: filesystem

---

## 1. Original Context

Make the profile URL (profile `baseUrl`) the primary URL for DIRECT CodeMie platform interactions, and keep the workspace URL (`workspace.codeMieUrl`, resolved onto the merged config as `config.codeMieUrl`) for analytics / indirect interactions and as a fallback. NO config schema change and NO data migration — both values already exist in every SSO profile; only call-site precedence changes.

Background facts already established (verify against code, do not assume):
- SSO credentials are stored per host: key = hash of protocol+host only (`deriveUrlStorageKey` in src/utils/credential-crypto.ts, `normalizeToBase` in src/providers/plugins/sso/sso.auth.ts). So `https://codemie.lab.epam.com` (codeMieUrl) and `https://codemie.lab.epam.com/code-assistant-api` (baseUrl) map to the SAME stored credentials when the host matches.
- `ensureApiBase()` (src/providers/core/codemie-auth-helpers.ts) is idempotent, so login URL `ensureApiBase(x)/v1/auth/login/<port>` (sso.auth.ts) can be built from baseUrl or codeMieUrl.
- Risk: login can rewrite apiUrl from the server's config.js `VITE_API_URL` (sso.auth.ts ~354-375) and credentials are stored under the TYPED url (sso.auth.ts ~137), so baseUrl host may differ from the credential key host. Also a comment in src/utils/sdk-client.ts (~48) says "use codeMieUrl for credential lookup, not baseUrl (which may be proxied)". Therefore the change must be "P first, W fallback" (try baseUrl-derived lookup, and fall back to codeMieUrl when no credentials are found), never "W removed".
- For providers whose baseUrl is a vendor URL (anthropic-subscription, moonshot-subscription) the CodeMie login exists only for analytics and MUST keep using codeMieUrl; only `ai-run-sso` and bearer-auth/JWT profiles have a CodeMie-backed baseUrl.

Desired design: one small resolver helper (proposed location src/providers/core/codemie-auth-helpers.ts), e.g. `getPlatformUrl(config)`: for provider ai-run-sso / bearer-auth -> `config.baseUrl` first, fall back to `config.codeMieUrl`; for all other providers -> `config.codeMieUrl` only (no baseUrl fallback). Plus a credentials-lookup wrapper or documented pattern that tries the P-derived URL first and W second.

Call sites to evaluate/switch (direct interactions -> P first; line numbers approximate, from an earlier read):
- Credentials lookup (`codeMieUrl || baseUrl` today, W wins): src/utils/sdk-client.ts:49; src/providers/plugins/sso/sso.models.ts:82 (+ apiUrl fallback :92); src/providers/plugins/sso/sso.setup-steps.ts validateAuth ~203 and getAuthStatus ~300; src/cli/commands/skills/lib/skills-search-client.ts ~114 and ~132; src/cli/commands/skills/lib/require-auth.ts:27; src/cli/commands/profile/auth.ts logout ~106.
- Login/refresh (W only today): src/cli/commands/profile/auth.ts handleLogin ~64 (`url || config.codeMieUrl`) and handleRefresh ~124 (hard-requires codeMieUrl, ~132-134 clear+login); src/providers/plugins/sso/sso.setup-steps.ts re-auth prompt ~268 (requires codeMieUrl).
- Model-list fetch at agent start reads `env.CODEMIE_URL` (which is W) for the SSO branch: src/agents/plugins/claude/claude.models.ts ~157-180, gemini/gemini.models.ts ~96, codex/codex-models.ts ~381, pi/pi.models.ts ~258, kimi/kimi.models.ts ~139, copilot-cli/copilot-cli.models.ts ~157, opencode/opencode-dynamic-models.ts (~146), and callers src/agents/plugins/codemie-code.plugin.ts ~269 and src/agents/plugins/opencode/opencode.plugin.ts ~292 which pass `env.CODEMIE_URL`. The JWT branch already uses CODEMIE_BASE_URL + token and must not change. SSO branch should look up credentials by CODEMIE_BASE_URL first, falling back to CODEMIE_URL. Check how CODEMIE_BASE_URL and CODEMIE_URL are exported (src/providers/plugins/sso/sso.template.ts exportEnvVars; ConfigLoader.exportProviderEnvVars in src/utils/config.ts).
- Health/doctor: src/providers/plugins/sso/sso.health.ts ~42-112 (errors out without codeMieUrl); src/cli/commands/doctor/checks/AIConfigCheck.ts ~76 (shows codeMieUrl); src/cli/commands/test-metrics.ts ~79.

Stays on workspace URL (do NOT change): analytics/metrics sync (`syncCodeMieUrl`, `CODEMIE_SYNC_API_URL`, src/providers/plugins/sso/proxy/sso.proxy.ts ~102, session-sync plugin), subscription-provider templates, AgentCLI.ts ~315 analytics-auth check, Claude statusline (src/agents/plugins/claude/plugin/statusline.ts), proxy connect `syncCodeMieUrl`.

Out of scope: per-host analytics-auth marker, a second login prompt in the setup wizard, PR #596 (moves identity keys into profiles), any change to where setup writes codeMieUrl.

Acceptance criteria:
1. SSO profile with both baseUrl and codeMieUrl on the same host behaves exactly as today (same stored credentials found).
2. SSO profile with only baseUrl set (no codeMieUrl): login, refresh, logout, doctor/health, model list and skills auth all work.
3. SSO profile with only codeMieUrl set: still works (fallback preserved).
4. If credentials are not found under the baseUrl-derived key, lookup falls back to codeMieUrl.
5. anthropic-subscription / moonshot-subscription keep using codeMieUrl for their CodeMie login/analytics.
6. JWT/bearer-auth model-list path is unchanged; analytics sync sites are untouched.
7. Guide .ai-run/guides/usage/project-config.md gets a short accurate note on the W vs P roles (and its incorrect claim that `export CODEMIE_PROJECT=...` overrides config should be corrected: loadFromEnv in src/utils/config.ts never reads CODEMIE_PROJECT; it only reaches child env/header/session records as a fallback when config has no project).

Research goals: confirm every call site above against the CURRENT code (repo just fast-forwarded to main 895b5bc), find any additional codeMieUrl/baseUrl lookup sites I missed (grep `codeMieUrl`, `getStoredCredentials(`, `CODEMIE_URL`), identify existing unit tests covering each touched file (Vitest, colocated `__tests__`), and flag risks (split-host, proxy-rewritten baseUrl such as the local proxy URL being placed in baseUrl or CODEMIE_BASE_URL at runtime — check whether CODEMIE_BASE_URL is ever overwritten with the local proxy address before models.ts files run).

---

## 2. Codebase Findings

### Existing Implementations (call sites verified against HEAD 895b5bc)

All listed sites confirmed; line numbers in the task are accurate to within a few lines. Node/TypeScript ESM, Vitest, `@/` alias, `.js` import extensions.

Credential lookup, `codeMieUrl || baseUrl` today:
- `src/utils/sdk-client.ts:48-57` (comment "not baseUrl (which may be proxied)" present; passes to `getStoredCredentials`).
- `src/providers/plugins/sso/sso.models.ts:82-83` `fetchModels`; `:92` `credentials.apiUrl || config.codeMieUrl`. Also `listModels` :62 uses instance `this.baseUrl` set via `setBaseUrl()`; `fetchIntegrations(codeMieUrl)` :112-119 takes an explicit URL.
- `src/providers/plugins/sso/sso.setup-steps.ts` `validateAuth` :203 and `getAuthStatus` :300 (`codeMieUrl || baseUrl`); `promptForReauth` :268-277 hard-requires `config.codeMieUrl`.
- `src/cli/commands/skills/lib/skills-search-client.ts` :114 and :132; `src/cli/commands/skills/lib/require-auth.ts:27`.
- `src/cli/commands/profile/auth.ts`: `handleLogin` :64 (`url || config.codeMieUrl`), `handleLogout` :106 (`codeMieUrl || baseUrl`), `handleRefresh` :124 (requires `config.codeMieUrl` AND `provider.authType === 'sso'`), clear :132, re-login :134.

Sites MISSED by the task list (found by grep):
- `src/cli/commands/skills/lib/skills-metrics.ts:359` `codeMieUrl || baseUrl` (skill event emission; analytics-flavoured, comment at :378 says bare baseUrl "points at the LLM proxy for SSO providers" and uses `credentials.apiUrl` for the events endpoint). Decide explicitly: analytics -> leave on W.
- `src/providers/plugins/sso/sso.health.ts:42,58,62,112` (list had it) — note :112 `modelProxy.setBaseUrl(config.codeMieUrl)` feeds `SSOModelProxy.listModels()`.
- `src/cli/commands/profile/index.ts:158` passes `config.codeMieUrl` to `ProfileDisplay.formatStatus`; `profile/display.ts:40,121`; `src/utils/profile.ts:56` (display only).
- `src/cli/commands/test-metrics.ts:79` `config.codeMieUrl || process.env.CODEMIE_URL`, then `getStoredCredentials(ssoUrl)` at :97.
- `src/cli/commands/doctor/checks/AIConfigCheck.ts:76` shows `CodeMie URL` only for `authType === 'sso'`; else shows Base URL. Display only, no credential lookup.
- `src/cli/commands/proxy/connect-orchestrator.ts:237` `getStoredCredentials(baseUrl)` (already baseUrl-based), :363/:402 `syncCodeMieUrl: config.codeMieUrl`, :632 requires codeMieUrl for Claude Desktop MCP; `proxy/index.ts:168`; `proxy/connectors/managed-mcp-remote.ts:128-133`; `proxy/inspect-desktop.ts:128`.
- `src/telemetry/runtime/DesktopTelemetryRuntime.ts:357`; `src/cli/commands/hook.ts:269,428,553,942,1225` (`CODEMIE_URL` as `ssoUrl`, analytics); incremental-sync files `codex/pi/opencode *.incremental-sync.ts` (analytics, `ssoUrl: env.CODEMIE_URL` in each `*.plugin.ts`). All analytics -> stay on W.
- `src/agents/core/BaseAgentAdapter.ts:575` (banner display) and `:1038` `syncCodeMieUrl: env.CODEMIE_URL`; `src/agents/core/AgentCLI.ts:221` builds `config.baseUrl` from `codeMieUrl` only under `--jwt-token`.
- `src/providers/plugins/sso/proxy/sso.proxy.ts:91` looks up creds by `targetApiUrl` (= CODEMIE_BASE_URL, i.e. the real backend URL), :105 by `syncCodeMieUrl`. So the proxy itself already does P-first for model traffic and W for sync — the pattern this task extends.

### Architecture and Layers Affected

CLI commands (`src/cli/commands/profile|skills|doctor|test-metrics`), Provider layer (`src/providers/core/codemie-auth-helpers.ts`, `src/providers/plugins/sso/*`), Agent plugin layer (`src/agents/plugins/*/*models.ts`, `codemie-code.plugin.ts`, `opencode/*`), shared utils (`src/utils/sdk-client.ts`). Guides: `.ai-run/guides/usage/project-config.md`. Per AGENTS.md, CLI -> Registry -> Plugin; agent plugins already import `CodeMieSSO` directly in the models files.

### Integration Points

- `CodeMieSSO.getStoredCredentials(url?, allowFallback=true)` (`sso.auth.ts:175`): retrieves by raw URL (store derives key), falls back to legacy global creds only when `normalizeToBase(credentials.apiUrl) === normalizeToBase(url)`, and DELETES expired creds via `clearSSOCredentials(url)` then returns null. A P-first-then-W lookup therefore calls it twice at most; a miss on P never mutates stored creds unless expired.
- `CodeMieSSO.authenticate({codeMieUrl})` (`sso.auth.ts:79-137`): login URL `ensureApiBase(codeMieUrl)/v1/auth/login/<port>`; stores under the TYPED url (`storeSSOCredentials(credentials, this.codeMieUrl)`); after callback, apiUrl defaults to `ensureApiBase(codeMieUrl)` and is overridden by `VITE_API_URL` from `<apiUrl>/config.js` (:354-375). Confirms split-host possibility: key host = typed host, `credentials.apiUrl` host may differ.
- `ensureApiBase` skips the `/code-assistant-api` suffix for localhost/127.0.0.1.
- Env export: `ConfigLoader.exportProviderEnvVars` (`config.ts:1488`) sets `CODEMIE_BASE_URL = config.baseUrl`; `sso.template.ts:42` sets `CODEMIE_URL = config.codeMieUrl` (only if set); jwt/anthropic/moonshot templates do likewise. `loadFromEnv` (`config.ts:460,483`) maps CODEMIE_BASE_URL->baseUrl and CODEMIE_URL->codeMieUrl.

### Patterns and Conventions

- Provider identity constants: `ProviderName.AI_RUN_SSO = 'ai-run-sso'`, `ProviderName.BEARER_AUTH = 'bearer-auth'` (`src/providers/core/types.ts:48-49`). SSO template `authType: 'sso'`; JWT template `authType: AuthMethod.JWT`.
- AgentCLI normalizes `config.baseUrl = ensureApiBase(config.baseUrl)` for ai-run-sso and bearer-auth only (`AgentCLI.ts:233-238`) — same provider pair the proposed resolver keys on.
- Each model-list file has an identical shape: `jwtToken && baseUrl` -> JWT; else `CODEMIE_URL` -> `new CodeMieSSO().getStoredCredentials(codeMieUrl)` -> error/`[]` if missing. Seven near-duplicate copies (claude.models.ts:157-191 with a TTL cache keyed `sso:${codeMieUrl}`; gemini.models.ts:88-107; codex-models.ts:372-395; pi.models.ts:249-270; kimi.models.ts:130-150; copilot-cli.models.ts:148-170; opencode-dynamic-models.ts:150-173). Error messages embed the URL in the "Run: codemie profile login --url ..." hint.
- Errors: project error classes (`ConfigurationError`); logging via `logger.debug`.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/usage/project-config.md` — target of acceptance criterion 7. Line 150-163 "Team project context" describes workspace `codeMieUrl`; lines 163-168 "CI/CD overrides" show `export CODEMIE_PROJECT=ci-project` followed by "Environment variables override both global and local config." That is the incorrect claim.
- `src/utils/config.ts` `loadFromEnv` (:449-500) reads CODEMIE_PROVIDER/BASE_URL/API_KEY/MODEL/TIMEOUT/DEBUG/ALLOWED_DIRS/IGNORE_PATTERNS/URL/AUTH_METHOD/INTEGRATION_*; grep for `CODEMIE_PROJECT` in `config.ts` returns nothing. Confirmed: it is only exported outward (`sso.template.ts:43`, jwt/anthropic/moonshot templates) and read from `env` in `BaseAgentAdapter.ts:1036`, `ensure-session.ts:28`, plugin `project:` fields and `hook.ts:787/947/1229`.
- Also relevant: `.ai-run/guides/architecture/architecture.md`, `integration/external-integrations.md`, `security/security-practices.md` (credential handling).

### Architectural Decisions
- `sdk-client.ts:48` comment: use codeMieUrl for lookup, "not baseUrl (which may be proxied)".
- `skills-metrics.ts:378` comment: bare profile baseUrl "points at the LLM proxy for SSO providers".
- Migration 006/007 moved codeMieUrl onto scope-level workspace (`statusline.ts:722`); `resolveProfileWorkspace` merges it onto the config (`config.ts:135`).

### Derived Conventions
`.ai-run/guides/` exists (no guide names platform-URL precedence). openwiki/ exists as generated evidence. Convention: analytics paths use `CODEMIE_URL`/`syncCodeMieUrl`; model traffic uses `CODEMIE_BASE_URL`.

---

## 4. Testing Landscape

### Existing Coverage (Vitest, colocated `__tests__` plus `tests/integration`)
- `src/providers/core/__tests__/codemie-auth-helpers.test.ts` — `ensureApiBase`, `buildAuthHeaders` (natural home for `getPlatformUrl` tests).
- `src/providers/plugins/sso/__tests__/sso.auth.test.ts` — `CodeMieSSO`. NO dedicated tests for `sso.models.ts`, `sso.health.ts`, `sso.setup-steps.ts` (only referenced indirectly).
- `tests/integration/sso-per-url-credentials.test.ts`, `sso-credential-key-normalization.test.ts`, `analytics-auth-gate.test.ts`, `sso-claude-plugin.test.ts` — credential keying and analytics gate.
- Model files: `claude/__tests__/claude.models.test.ts`, `codex/__tests__/codex-models.test.ts`, `gemini/__tests__/gemini.models.test.ts`, `pi/__tests__/pi.models.test.ts`, `kimi/__tests__/kimi.models.test.ts`, `copilot-cli/__tests__/copilot-cli.models.test.ts`. opencode-dynamic-models: no dedicated test; `src/agents/plugins/__tests__/codemie-code-plugin.test.ts`, `opencode-gpt55-routing.test.ts` reference plugin callers.
- `src/cli/commands/doctor/checks/__tests__/doctor-checks.test.ts` (556 lines; covers AIConfigCheck); `src/cli/commands/profile/__tests__/index.test.ts` (profile index only).
- `src/cli/commands/skills/lib/__tests__/skills-search-client.test.ts`, `skills-metrics.test.ts`, `src/cli/commands/skills/__tests__/find.test.ts|commands.test.ts` (touch require-auth).
- `src/utils/__tests__/config-project-override.test.ts`, `export-provider-env.test.ts` — config/env export.
- `src/agents/core/__tests__/BaseAgentAdapter.test.ts`, `AgentCLI-*.test.ts`.

### Testing Framework and Patterns
Vitest with dynamic-import mocking (`vi.mock` before dynamic import, per testing-patterns guide). `CodeMieSSO` is typically mocked in agent model tests.

### Coverage Gaps
- No unit tests: `src/utils/sdk-client.ts`, `sso.models.ts`, `sso.health.ts`, `sso.setup-steps.ts` validateAuth/getAuthStatus/promptForReauth, `profile/auth.ts` (login/logout/refresh), `require-auth.ts`, `test-metrics.ts`, `opencode-dynamic-models.ts`.
- No tests for a P-miss then W-hit lookup anywhere. Note repo policy: write/run tests only on explicit request.

---

## 5. Configuration and Environment

### Environment Variables
- `CODEMIE_BASE_URL` (profile baseUrl; exported by `exportProviderEnvVars`), `CODEMIE_URL` (workspace codeMieUrl; exported only by sso/jwt/anthropic/moonshot templates and only when set), `CODEMIE_SYNC_API_URL` (only set by anthropic/moonshot templates, `ensureApiBase(codeMieUrl)`), `CODEMIE_JWT_TOKEN`, `CODEMIE_AUTH_METHOD`, `CODEMIE_PROFILE_CONFIG` (JSON of whole merged config, set at `AgentCLI.ts:392`, contains original `baseUrl` and `codeMieUrl`), `CODEMIE_PROJECT` (output only).

**CODEMIE_BASE_URL is overwritten with the local proxy address BEFORE the model files run (key finding).**
`BaseAgentAdapter.run()` order: `setupProxy(env)` at :564 -> `transformEnvVars` :605 -> `executeBeforeRun` :609 (where the models files run). `setupProxy` (:1046-1067) sets `env.CODEMIE_BASE_URL = <http://localhost:PORT>` and `CODEMIE_API_KEY='proxy-handled'` whenever the provider `authType === 'sso'` or auth method is `jwt`, and the agent has `ssoConfig.enabled` (true for codemie-code, claude, gemini, codex, pi, kimi, copilot-cli, opencode, openwiki). The real backend URL is captured only as `ProxyConfig.targetApiUrl` inside the proxy. Consequences:
- In `beforeRun`/model-list code (claude.plugin.ts:406 `resolveClaudeModel`, gemini.plugin.ts:177, codemie-code.plugin.ts:269, opencode.plugin.ts:292, codex/pi/kimi/copilot plugins), for SSO profiles `env.CODEMIE_BASE_URL` is `http://localhost:<port>`, so a lookup keyed on it (per the proposed "CODEMIE_BASE_URL first") can never hit stored credentials; the codeMieUrl fallback would always be what succeeds, and with no `CODEMIE_URL` (baseUrl-only profile) SSO model list returns `[]`/static fallback/throws (acceptance criterion 2 for model list would fail).
- The JWT branch (`jwtToken && baseUrl`) already sends the JWT to that proxy URL; unchanged.
- Additionally `BaseAgentAdapter.ts:629` does `Object.assign(process.env, env)`, so the proxy URL leaks to `process.env.CODEMIE_BASE_URL` of the agent process and its children; `loadFromEnv` (config.ts:460) then treats it as `baseUrl` in any nested `codemie ...` invocation unless `cliOverrides.name` is set (config.ts:150-158 filter). This affects `ConfigLoader.load()`-based sites (skills, sdk-client) when run inside an agent session. `:975-977` comments acknowledge stale process.env from previous sessions.
- Original profile baseUrl remains available in `CODEMIE_PROFILE_CONFIG` (JSON) at `beforeRun` time; `claude.plugin.ts:296-298`, `codemie-code.plugin.ts:314-316`, `opencode.plugin.ts:52-57` already parse it.

### Configuration Files
`~/.codemie/codemie-cli.config.json` (global), `.codemie/codemie-cli.config.json` (local); `workspace.codeMieUrl` merged by `ConfigLoader.resolveProfileWorkspace`. No schema change required by the task. Credentials: encrypted files per host key (`credential-crypto.ts`: `deriveUrlStorageKey` = hash of protocol+host; `deriveLegacyUrlStorageKey` for older raw-URL keys).

### Feature Flags and Deployment Concerns
None. No flags. Statusline script reads creds from `workspace.codeMieUrl` and checks same-origin with baseUrl (`statusline.ts:722-743`) — unchanged.

---

## 6. Risk Indicators

- Proxy-rewritten CODEMIE_BASE_URL at model-list time (see Section 5): `env.CODEMIE_BASE_URL` in the seven model files and two plugin callers is the localhost proxy URL for SSO profiles. Speculative: a naive "look up by CODEMIE_BASE_URL first" is a silent no-op and breaks baseUrl-only profiles; the platform URL for that path would have to come from another source (e.g. a value exported before `setupProxy`, or the original baseUrl in `CODEMIE_PROFILE_CONFIG`).
- Split-host: credentials key host = typed host (`sso.auth.ts:137`); `credentials.apiUrl` may come from `VITE_API_URL` (:354-375). A baseUrl on a different host than the key yields a lookup miss, so P-then-W fallback is mandatory. Also each `getStoredCredentials` miss on P with `allowFallback=true` retrieves global creds and compares hosts; expired creds are deleted by the lookup.
- Provider gating: `AgentCLI.ts:315-320` runs the SSO `validateAuth(config)` for non-SSO providers (anthropic/moonshot), where `config.baseUrl` is a vendor URL. Today `codeMieUrl || baseUrl` falls to a vendor baseUrl only if codeMieUrl is absent (already gated by the `&& config.codeMieUrl` condition). Speculative: a resolver used inside `validateAuth` must return W only for those providers, otherwise vendor URLs would be probed for CodeMie creds.
- Nested-session env leak: `Object.assign(process.env, env)` (BaseAgentAdapter.ts:629) can make `ConfigLoader.load()` return `baseUrl = http://localhost:PORT` inside agent-spawned `codemie` commands (skills, sdk-client); the lookup would miss and fall back to W, which is safe only if W is set. Speculative: baseUrl-only profile inside an agent session may fail skills auth.
- Duplication: seven copies of the SSO model-list lookup; changes must be applied consistently, and claude.models.ts cache key `sso:${codeMieUrl ?? ''}` must be revisited if the lookup URL changes.
- `handleRefresh` (auth.ts:124) and `promptForReauth` (sso.setup-steps.ts:268) hard-require `codeMieUrl`; `sso.health.ts:42` errors without it; these are the failing paths for a baseUrl-only profile. `handleRefresh` also clears credentials by W, then logs in by W: must clear/login with the same URL to avoid clearing one key and storing another.
- Login stores under the typed URL, so a login triggered from P (baseUrl with `/code-assistant-api` path) stores under the same host key as W only when hosts match.
- Analytics-flavoured sites that also use `codeMieUrl || baseUrl` and were not in the task list: `skills-metrics.ts:359`, `test-metrics.ts:79`. Need an explicit decision.
- Test coverage thin for most touched files (Section 4); lint zero-warning and typecheck gates apply.
- Doc: `project-config.md` CI/CD example plus the sentence "Environment variables override both global and local config" is contradicted by `loadFromEnv` for `CODEMIE_PROJECT`.

---

## 7. Summary for Complexity Assessment

The change touches CLI command layer (profile auth, skills, doctor/test-metrics), provider layer (a new small resolver in `codemie-auth-helpers.ts`, `sso.models.ts`, `sso.health.ts`, `sso.setup-steps.ts`), one shared util (`sdk-client.ts`), the agent-plugin layer (seven `*models.ts` files with near-identical SSO lookup blocks plus `codemie-code.plugin.ts` and `opencode.plugin.ts` callers) and one guide file. Roughly 20 source files plus one doc; no schema, migration or new dependency. The pattern (P-first then W) already exists in the SSO proxy (`sso.proxy.ts` looks up model creds by `targetApiUrl`, sync creds by `syncCodeMieUrl`).

The main technical wrinkle is the model-list path: `BaseAgentAdapter.setupProxy` rewrites `env.CODEMIE_BASE_URL` to the local proxy URL before `beforeRun`, so the model files cannot derive the platform URL from that variable for SSO profiles. The rest is mechanical call-site substitution. Credential storage is host-keyed, so same-host profiles resolve identically, and split-host/proxy-leak cases must fall back to W.

Test posture is weak for the touched files: model files and doctor checks have unit tests, but `sdk-client.ts`, `sso.models.ts`, `sso.health.ts`, `sso.setup-steps.ts`, `profile/auth.ts`, `require-auth.ts` and `opencode-dynamic-models.ts` have none; repo policy allows tests only on explicit request. Overall: medium-to-high (6+ files, but repetitive and low novelty), with one design decision (how the model-list path obtains the pre-proxy platform URL) that the spec must settle.

---

## 8. External References

None named by the task.
