# Technical Research

**Task**: model validation claude-request-normalizer proxy launcher
**Generated**: 2026-11-25
**Research path**: filesystem

---

## 1. Original Context

Ticket EPMCDME-17343 (sub-task of bug EPMCDME-17057), verbatim:

Summary: CLI: reject invalid model values at launch and in the local proxy

--- Parent EPMCDME-17057 (Bug): "CodeMie LLM proxy forwards invalid model values to LiteLLM, which broke daily spend aggregation". On 2026-11-06 a Claude Code session launched via CodeMie CLI sent a ~7,500-char prompt in the `model` field; neither the CLI local proxy nor the backend validated it; it reached LiteLLM and broke daily spend aggregation (btree index row size exceeded). Root causes in this repo: (2) CLI local proxy forwards an unresolved model unchanged: src/providers/plugins/sso/proxy/plugins/claude-request-normalizer.plugin.ts (resolveModel returns undefined for unresolved, body left as is). (3) CLI launcher accepts any text in -m/--model/CODEMIE_MODEL and skips catalog auto-heal for an explicit model: src/agents/core/AgentCLI.ts:99, src/agents/plugins/claude/claude.models.ts:488. Parent expected result: request rejected with a clear 400 by CodeMie and never reaches LiteLLM. ---

Context
* codemie-claude accepts any text in -m / --model and CODEMIE_MODEL. An explicit model is treated as never stale, so it skips catalog auto-heal and is passed to Claude Code as is. Other agents have their own explicit-model checks (Copilot, Codex); Claude has none.
* The local proxy's Claude request normalizer passes an unresolved model through unchanged on purpose, so the gateway's own error is shown. It is shared by codemie-claude, codemie-copilot and Claude Desktop.
* The normalizer has no way to answer with its own error status today: errors thrown from its current hook are swallowed, and the "blocked" answer is always 200. Only request-level hooks (used by the gateway-key and endpoint-blocker plugins) can reject with a status.
* The local proxy already has an Anthropic-style error format in the gateway-key plugin; Claude Code shows errors in that format to its user.
* No existing test covers oversized, multi-line or non-text model values in the launcher or the normalizer.

Story: As a CodeMie CLI user, I want the CLI to refuse a malformed model value right away with a clear message, so that a mistyped or pasted model never travels to the CodeMie backend and LiteLLM.

Background: The CLI is where the bad value is born and the earliest place to stop it. The same rule must apply at launch and in the local proxy, so a value cannot be accepted by one and rejected by the other.

Acceptance Criteria
* AC1: Given codemie-claude is started with -m <value> or CODEMIE_MODEL=<value>, when the value is longer than 256 characters, contains whitespace or control characters (including leading or trailing), or is empty, then startup stops with a clear message that names the rule and the received length, not the value, and Claude Code is not launched.
* AC2: Given a request through the local proxy on the Claude path (codemie-claude, codemie-copilot, Claude Desktop), when its model value breaks the same rule or is not text, then the local proxy answers with a clear error in the Anthropic-style format and the request is not forwarded. The message names the rule and the received length, never the value.
* AC3: Given a valid model name or a router alias, when it is passed to -m / CODEMIE_MODEL or sent through the local proxy, then behaviour is unchanged, including requests whose model the proxy today passes through for the gateway to judge.
* AC4 (negative): Given a rejected value, when the error output, the local-proxy response or the log is produced, then none of them contains the full offending value.
* AC5: Given the validation is in place, when the shared table of test values (oversized, multi-line, tab, non-breaking space, leading and trailing space, empty, non-text; valid names and router aliases) is run, then unit tests for the launcher and for the local proxy show every bad value rejected and every valid one accepted.

Out of Scope: NG1 checking a model against the model catalog. NG2 launcher checks for agents other than codemie-claude, and local-proxy checks for agents that do not use the Claude request normalizer (codex, opencode, gemini, kimi). NG3 launch-time validation of per-tier model env vars (their values are still checked when they appear in a request). NG4 any change in backend/UI/SDK repos.

Decisions: D1 rule = over 256 characters, any Unicode whitespace or control character anywhere (rejected, not trimmed), not text, or empty. D2 ONE shared check used by both launcher and local proxy. D3 local proxy rejects with a real error response in the Anthropic-style format already used by the gateway-key plugin — not pass-through, not the "blocked" 200 answer; must be a request-level hook because throws from the normalizer's current hook are swallowed. D4 covered: codemie-claude launcher and the local-proxy Claude path incl. agents sharing that normalizer. D5 this child owns the test-value table (also supplied to backend child).

Open questions: none.

Constraints: codemie-code is a public GitHub repo — no ticket keys or private hostnames in code, tests or commit messages if its git-workflow guide forbids them; follow that guide. Independent of backend child. Layering rule of the repo (CLI → Registry → Plugin) applies to where the shared check lives.

(Caller asked to establish: where the shared check lives per the layering rule; request-level hook mechanism and error format; normalizer hook / resolveModel / swallowed errors / blocked-200 and which agents use it; launcher flow for -m/--model/CODEMIE_MODEL; Copilot/Codex explicit-model checks; test locations; logging/sanitization rules for AC4; git-workflow rule on ticket keys.)

---

## 2. Codebase Findings

### Existing Implementations

**Purpose A: stop a malformed model value at launch (codemie-claude)**
- Nothing validates the value's shape. Searched: `-m/--model`, `CODEMIE_MODEL`, `CODEMIE_MODEL_SOURCE` across `src/` and `bin/`.
- `-m, --model <model>` is declared for every agent on the shared `AgentCLI` program: `src/agents/core/AgentCLI.ts:94`. It is config-only (not forwarded; `configOnlyOptions` at `AgentCLI.ts:691`). `bin/codemie-claude.js` builds `AgentCLI` from `AgentRegistry.getAgent('claude')`.
- Flow in `handleRun` (`AgentCLI.ts:183-570`): `ConfigLoader.load(..., {model: options.model})` at 235 -> JWT/baseUrl tweaks -> `--reasoning-effort` check 280-291 -> `--resume` check 294 -> missing-field check 300-322 (`!config.model`) -> provider settings check 327 -> auth 335-355 -> launch identity 360 -> `validateCompatibility(config)` 405 -> `exportProviderEnvVars` 411 -> `CODEMIE_MODEL_SOURCE='cli'` if `options.model` truthy 416-418 -> source recomputed at 440-444 (`cli` | `env` when `process.env.CODEMIE_MODEL` truthy | `default`) -> `CODEMIE_PROFILE_CONFIG` = `JSON.stringify(config)` 458 -> `adapter.run`.
- Value precedence: `ConfigLoader.load` (`src/utils/config.ts:196-262`): profile -> env (`loadFromEnv`, `config.ts:631` `if (process.env.CODEMIE_MODEL)`) -> CLI overrides (`removeUndefined`). With `--profile` set, env `model` is dropped unless `cliOverrides.model` is truthy (`config.ts:214-231`), yet `AgentCLI.ts:442` still labels the source `env`. So `process.env.CODEMIE_MODEL` can differ from `config.model`.
- Empty values today count as absent: `if (options.model)` (416), `if (process.env.CODEMIE_MODEL)` (442, `config.ts:631`) are falsy for `''`; `!cliOverrides.model` at `config.ts:228`.
- Model reaches Claude Code via env: `CODEMIE_MODEL` -> `ANTHROPIC_MODEL` (`BaseAgentAdapter.ts:1280-1284`, claude `envMapping`), and `claude.plugin.ts:459` TIER_TARGET_VARS.
- Auto-heal skip for explicit model: `claude.models.ts:38-40` (`EXPLICIT_MODEL_SOURCES = {'cli','env'}`), `claude.models.ts:441-446` (`tier === 'model'` and source in set -> `keepConfiguredModel`, no catalog check). Runs from `claude.plugin.ts` `beforeRun` loop at 469-519 (provider != `anthropic-subscription`).
- Precedent for launch-time flag validation: invalid `--reasoning-effort` -> `console.error(chalk.red(...))`, `logger.error`, `process.exit(1)` (`AgentCLI.ts:281-289`; echoes the value). Agent-specific branch precedent: `this.adapter.name === ClaudePluginMetadata.name` (`AgentCLI.ts:138`). Claude metadata `blockedModelPatterns: []` (`claude.plugin.ts:208`), so `validateCompatibility` (`AgentCLI.ts:743`) never blocks a Claude model (it would echo `Model '${model}'` at 767 if it did).
- Other `AgentCLI` users with Claude-family plugin: `claude-acp` (`claude-acp.plugin.ts:35`, clientType `codemie-claude-acp`). Not in the normalizer's client list (below).

**Purpose B: stop a malformed model in the local proxy (Claude path)**
- Normalizer: `src/providers/plugins/sso/proxy/plugins/claude-request-normalizer.plugin.ts`. Priority 14 (`:197`), `clients = ['codemie-claude','codemie-copilot', CLAUDE_DESKTOP, VSCODE_CLAUDE_CODE]` (`:191`; `claude-desktop`, `vscode-claude-code` from `proxy-clients.ts:7-8`). Registered in `plugins/index.ts:47`. `BackgroundRequestNormalizerPlugin` shares the same four clients (`background-request-normalizer.plugin.ts:86`).
- Hook: `onRequest(context)` only (`:233-280`). Skips unless body present and `content-type` contains `application/json`; no URL filter. `JSON.parse` of body; `requestedModel = typeof body.model === 'string' ? body.model : ''` (`:242`) so a non-text model is silently treated as absent; `model = requestedModel || context.config.model || ''` (`:243`); empty -> return. Whole body in `try { ... } catch { /* pass through unchanged */ }` (`:238-279`).
- `resolveModel` (`:288-302`): `ensureModelsLoaded` (catalog TTL 10 min, backoff 60 s, `:206-209`, `:309-325`); returns `undefined` when catalog empty or `resolveClaudeDeployment(...).kind === 'unresolved'` (`claude-model-resolver.ts`); the caller then leaves `body.model` unchanged (`:264-270`). A catalog failure never fails the request (`:352-358`).
- Swallowing: `runHook` (`sso.proxy.ts:621-641`) wraps each interceptor in try/catch, `logger.error` and continues. "Blocked" short-circuit (`sso.proxy.ts:340-350`): if `context.metadata.blocked`, answers `res.statusCode = 200` with `blockedResponseBody` or `{"success":true}`; status is hard-coded 200.
- Request-level hook: `ProxyInterceptor.handleRequest(context, req, res, httpClient): Promise<boolean>` (`plugins/types.ts:165-170`). Loop at `sso.proxy.ts:319-333`: interceptors in priority order, only those that `serves()` the context (`:611-614`: no `clients` list or `context.agentName` in it, checked at each one's turn); `true` = request fully handled, nothing else runs (no `onRequest`, no forwarding, no logging plugin); a throw goes to `handleError` -> `sendErrorResponse` (`:693-778`) which writes `{error:{type:'ProxyError',code,message,statusCode}, requestId, timestamp}` (not Anthropic-style). Every `handleRequest` hook runs before any `onRequest` hook (documented `endpoint-blocker.plugin.ts:9-13`, `docs/ARCHITECTURE-PROXY.md:551,560`). `buildContext` has already read the body into `context.requestBody` (`sso.proxy.ts:427-452`), so a handleRequest hook can read it.
- Anthropic-style format, gateway-key plugin (`gateway-key.plugin.ts:62-68`): `res.statusCode = 401; Content-Type: application/json; {"type":"error","error":{"type":"authentication_error","message":"..."}}`; returns `true`. Same envelope elsewhere: `otlp.plugin.ts:53` (`sendError(res, 400, 'invalid_request_error', msg)`, used at 240-299), `desktop-models.plugin.ts:141-144` (502, `api_error`), `sso-session-expiry.plugin.ts:103`, `awaiting-login-listener.ts:94`. Endpoint-blocker answers fixed JSON, default 200, per-pattern `statusCode` (`endpoint-blocker.plugin.ts:21-27,100-110`) and is not Anthropic-style.
- Plugin priorities of existing request-level hooks: MCP auth 3, endpoint blocker 5, gateway key 7, client attribution 8 (can rewrite `agentName` to `claude-desktop`, `client-attribution.plugin.ts:63`), desktop models 9 (`handleRequest` for `/v1/models`; its `onRequest` rewrites `claude-x-<hash>` aliases to real ids, `desktop-models.plugin.ts:95-116`), SSO/JWT auth 10, normalizers 14, sanitizer 15, header injection 20, logging 50. `plugin-order.test.ts` asserts the 7/8/9 order.
- A handleRequest hook sees the raw client model: `claude-x-<hash>` desktop alias not yet mapped (`sso.desktop-models.ts:174`).

**Purpose C: explicit-model checks other agents have (for comparison; NG2 keeps them out of scope)**
- Copilot: `assertExplicitCopilotModelAllowed` (`copilot-cli.models.ts:199-212`) called from `copilot-cli.plugin.ts:301,425` inside `setupProxy`; trigger `CODEMIE_MODEL_SOURCE` in `cli|env`; checks family-name compatibility and catalog membership; throws `ConfigurationError` echoing the full value. `bin/codemie-copilot.js` has its own `--model`/`CODEMIE_MODEL` parsing (`:21,68,95,169-193`).
- Codex: `assertExplicitCodexModelAllowed` (`codex-models.ts:477-500`, called `codex.plugin.ts:288`), `isExplicitModelChoice` (`codex-models.ts:98`); echoes the full value; plus `console.error` of the value at `codex-models.ts:441,464`.
- Kimi: `assertExplicitKimiModelAllowed` (`kimi.models.ts:183`, called `kimi.plugin.ts:88`). Gemini: `validateGeminiModel` (`gemini.models.ts`).
- All are catalog/family checks in the plugin layer, none test length, whitespace or control characters.

**Other touched code**
- `src/utils/` precedent for shared, layer-neutral helpers: `header-value.ts`, `model-normalizer.ts` (`normalizeModelName`), `model-family.ts`, `long-text-masking.ts`; tests in `src/utils/__tests__/`.
- `src/utils/errors.ts`: `CodeMieError`, `ConfigurationError` (`:1,:8`). `safeTerminalValue` exists privately in `claude.plugin.ts:149` (strips non-printable ASCII, not exported).

### Decisions Already in the Code

- Convention: a proxy plugin that refuses a request does so from `handleRequest`, answers directly, returns `true` (`gateway-key.plugin.ts:62-68`, `desktop-models.plugin.ts:141`, `otlp.plugin.ts:53`); recorded reason in `docs/ARCHITECTURE-PROXY.md:560` ("rejected before any normalization plugin sees the request").
- Decision: unresolved model passes through to the gateway — `claude-request-normalizer.plugin.ts:282-287` doc comment ("pass through unchanged when the catalog is unavailable or nothing matches"); reason stated in the ticket context (gateway's own error shown); alternative: reject.
- Decision: explicit model is never stale and skips catalog auto-heal — `claude.models.ts:438-446`; reason in comment (user-chosen value must not be silently replaced).
- Decision: hook errors are swallowed except `handleRequest` — `sso.proxy.ts:636-639` vs `:327-331`; documented `docs/ARCHITECTURE-PROXY.md:333-339`.
- Convention: layering `CLI -> Registry -> Plugin -> Core -> Utils`, "All layers -> Utils", plugins do not call plugins (`.ai-run/guides/architecture/architecture.md:145-155`). Observed code: proxy plugins import from `src/utils/` (`logger`, `security`) and some from `src/agents/core/` (`client-attribution.plugin.ts:20` `session-id.js`; `header-injection.plugin.ts:24`). `claude-model-resolver.ts:13-18` header explicitly keeps the proxy "self-contained" and not dependent on the CLI's connector-side resolver ("CLI -> Registry -> Plugin, never reversed").
- Data form: the launcher compares `options.model` / `process.env.CODEMIE_MODEL` as truthy strings; the proxy reads `body.model` from raw JSON (any JSON type). Today emptiness is "absent" in both (`AgentCLI.ts:416,442`; normalizer `:242-245`); AC1/AC2 need empty and non-text distinguished from absent.
- Test seam in normalizer: `setAvailableModelsForTest` (`:228`).

### Task Statements Checked Against the Code

- "Only request-level hooks can reject with a status": holds (`sso.proxy.ts:319-333`; `runHook` swallows `:636`).
- "errors thrown from its current hook are swallowed": holds (`sso.proxy.ts:636-639`, plus the internal `catch {}` at `claude-request-normalizer.plugin.ts:277`).
- "blocked answer is always 200": holds (`sso.proxy.ts:345`).
- "passes an unresolved model through on purpose": holds (`:282-287`, `:264-270`).
- "shared by codemie-claude, codemie-copilot and Claude Desktop": holds, and also `vscode-claude-code` (`:191`). `codemie-claude-acp` is not listed.
- "AgentCLI.ts:99 accepts any text": line 99 is now the `--jwt-token` option; the `-m, --model` option is at `AgentCLI.ts:94` (line drift, behaviour holds).
- "claude.models.ts:488 skip auto-heal": the skip is at `claude.models.ts:441` (file has 468 lines); behaviour holds.
- "Claude has no explicit-model check; Copilot, Codex do": holds (`validateCompatibility` blocks nothing for Claude, `claude.plugin.ts:208`).
- "Claude Code shows errors in the Anthropic-style format": unverified in this repo (client behaviour); the format exists at `gateway-key.plugin.ts:64-67`.
- "No existing test covers oversized/multi-line/non-text model": holds (see Section 4; normalizer tests cover thinking/effort/sampling/resolve only).
- D3 "request-level hook because throws from the normalizer's current hook are swallowed": holds. Keeps the normalizer's `onRequest` and its pass-through of unresolved models in place; consumers listed below.
- "Layering rule (CLI -> Registry -> Plugin) applies to where the shared check lives": the rule is `CLI -> Registry -> Plugin -> Core -> Utils` with all layers allowed to use Utils (architecture.md:145-155). Launcher code is in `src/agents/core/` (Core) and the proxy plugin in `src/providers/plugins/sso/proxy/plugins/` (Plugin of a different registry).
- "no ticket keys in code/tests/commits if the guide forbids": the guide does not forbid them in code (see Section 3). 298 `EPMCDME-<n>` occurrences exist in 153 files under `src/` (e.g. `claude-request-normalizer.plugin.ts:4`, `:36`; `AgentCLI.ts:357`).

### Consumers of Changed Contracts

- `ProxyContext.requestBody` / `body.model` read by (all after any new handleRequest hook): `claude-request-normalizer.plugin.ts:242`, `background-request-normalizer.plugin.ts:124` (forces model for cheap background calls), `desktop-models.plugin.ts:105` (alias rewrite), `logging.plugin.ts:59-97` (logs the whole parsed body at debug), `sso.proxy.ts:788` (Bedrock 4xx warn logs `model`), `header-injection.plugin.ts:78,166` (`X-CodeMie-CLI-Model` from `config.model`, profile-sourced), `codex-request-normalizer.plugin.ts:170`, `request-sanitizer.plugin.ts`.
- `CODEMIE_MODEL` / `CODEMIE_MODEL_SOURCE` consumers: `claude.models.ts:419,441`, `copilot-cli.models.ts:145-146`, `copilot-cli.plugin.ts:418`, `codex-models.ts:98`, `gemini.models.ts:97`, `BaseAgentAdapter.ts:639,1133,1201,1280`, `config.ts:631,1805`, `bin/codemie-copilot.js`. A launcher check on `claude` touches the same `handleRun` body that every other agent shares.
- Normalizer client list `ALLOWED_AGENTS` (`:191`) is the only definition of "Claude path" in the proxy; `background-request-normalizer.plugin.ts:86` duplicates it, `desktop-models.plugin.ts` has its own `ALLOWED_AGENTS`.
- Plugin registration order tests: `plugin-order.test.ts` (7/8/9), `claude-request-normalizer.plugin.test.ts:88-90` (priority 14).
- Logging that echoes the model value today: `AgentCLI.ts:114` (`JSON.stringify(opts)` at debug, runs before `handleRun`), `claude.models.ts:443,401` (value in log), `claude-request-normalizer.plugin.ts:99,118,162,186,299` (debug), `desktop-models.plugin.ts:108,112` (warn/debug, `claude-x-` aliases), `logging.plugin.ts:95` (whole body), `AgentCLI.ts:458` (`CODEMIE_PROFILE_CONFIG` env carries `model`), `claude.plugin.ts:492,498` (`safeTerminalValue` echo to stderr).

### Architecture and Layers Affected

- CLI/launcher: `src/agents/core/AgentCLI.ts` (Core of agents; also `bin/codemie-claude.js` entry). Claude plugin: `src/agents/plugins/claude/` (`claude.plugin.ts` `beforeRun`, `claude.models.ts`).
- Proxy: `src/providers/plugins/sso/proxy/` (`sso.proxy.ts` hook runner; `plugins/` registry `index.ts`, `types.ts`).
- Utils: `src/utils/` (candidate layer reachable from both; precedent files above).

### Integration Points

- `AgentCLI.handleRun` -> `ConfigLoader.load` -> `exportProviderEnvVars` -> `adapter.run` (env handoff).
- Daemon/gateway mode vs per-session proxy: `clientType` from `claude.plugin.ts:216` (`codemie-claude`), `COPILOT_CLI_CLIENT_TYPE='codemie-copilot'` (`copilot-cli.constants.ts:131`), gateway-key named clients `claude-desktop`, `vscode-claude-code` (`proxy-clients.ts:14`); `serves()` gate on `context.agentName`.
- Catalog fetch (`fetchCodeMieLlmModels`) is used by the normalizer; NG1 excludes it from the new check.

### Patterns and Conventions

- Plugin class + interceptor class, `id '@codemie/proxy-...'`, numeric `priority`, optional `clients`, registered in `plugins/index.ts:35-60`.
- ES modules, `.js` import suffix, `@/` alias, explicit return types, `logger.*` not `console.log` (AGENTS.md); error classes from `src/utils/errors.ts`.
- Launch errors: `console.error(chalk.red(...))` + `logger.error` + `process.exit(1)` in `handleRun`; a throw inside `handleRun` is printed as "Failed to run ..." (`AgentCLI.ts:558-569`).

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — layers, "All layers -> Utils", "Plugin -> Plugin direct calls" not allowed.
- `.ai-run/guides/security/security-practices.md` — "Data Sanitization for Logging": `sanitizeLogArgs()` redacts only sensitive keys/values (key patterns `api_key`, `token`, `password`, `secret`, `credential`, `cookie`, `authorization`; `src/utils/security.ts:29-52`, `:82-119`); a model string is not redacted or truncated by it. "Log request/response bodies raw" is listed as an anti-pattern (`:153`).
- `.ai-run/guides/standards/git-workflow.md` — ticket keys: branch `EPMCDME-<NNNN>[_desc]` allowed (line 24-26); commit anti-pattern "Ticket key in the commit subject when scope already conveys context" -> "reference the ticket in the body footer instead" (line 199); allowed scopes include `cli`, `agents`, `proxy`, `providers`, `utils`; subject <= 100 chars; "Reference the related issue/PR in the body" (line 100). No rule forbids ticket keys in code, tests or the commit body; no rule on private hostnames found in this guide.
- `docs/ARCHITECTURE-PROXY.md` — hook lifecycle (`:299-300,362-376`), error handling (`:333-339`), endpoint blocker and gateway key as `handleRequest` plugins (`:551,560`).
- `docs/superpowers/` holds prior task analyses (path pattern of this run).

### Architectural Decisions

- Recorded in code comments only (`endpoint-blocker.plugin.ts:9-13`, `claude-model-resolver.ts:13-18`, `claude.models.ts:438-446`); no ADR directory found.

### Derived Conventions

- Rejection responses use `type:'error'` envelope with `error.type` in `authentication_error | invalid_request_error | api_error`; `invalid_request_error` with 400 is already used by `otlp.plugin.ts:240-299`.

---

## 4. Testing Landscape

### Existing Coverage

- Launcher: `src/agents/core/__tests__/AgentCLI-model-source.test.ts` (`handleRun` with `ConfigLoader.load/exportProviderEnvVars` spied, `run` mock; asserts `CODEMIE_MODEL_SOURCE`), `AgentCLI-bedrock-gate.test.ts` (spies `process.exit` to throw `process.exit:<code>`, binds `handleRun`), `AgentCLI-print-config.test.ts`, `-resume`, `-silent-flag`, `-project-seam`, `-analytics-report`, `-effort` (only `exportProviderEnvVars`).
- Claude models: `src/agents/plugins/claude/__tests__/claude.models.test.ts` (explicit-model skip of auto-heal).
- Normalizer: `src/providers/plugins/sso/proxy/plugins/__tests__/claude-request-normalizer.plugin.test.ts` (helpers `createPluginContext`, `createProxyContext(body)`, mocks `fetchCodeMieLlmModels` via `vi.hoisted`; passthrough tests at `:652-698`), `claude-request-normalizer.effort.test.ts`, `claude-model-resolver.test.ts`.
- Request-level hooks: `gateway-key.plugin.test.ts` (`makeProxyContext`, `makeMockRes` capturing statusCode/headers/body; calls `interceptor.handleRequest!(ctx, {}, res, {})`), `endpoint-blocker.plugin.test.ts`, `plugin-order.test.ts`.
- Real-proxy tests: `src/providers/plugins/sso/proxy/__tests__/sso.proxy.gateway-public-endpoints.test.ts` (real `CodeMieProxy` + local upstream server + `resetPluginRegistry`), `sso.proxy.client-gate.test.ts` (per-client hook gating).
- Utils tests co-located in `src/utils/__tests__/`.

### Testing Framework and Patterns

- Vitest, co-located `__tests__`, `@group unit` header comment; `vi.mock` / `vi.spyOn`, dynamic `import()` after spies (`.ai-run/guides/testing/testing-patterns.md:70-90`). Repo rule: write/run tests only on explicit request (AGENTS.md); this ticket's AC5 asks for them.

### Coverage Gaps

- No test for oversized/multi-line/tab/NBSP/leading-trailing/empty/non-text model in launcher or proxy; no test of `-m ''` or `CODEMIE_MODEL=''`; no test that a handleRequest plugin on the Claude path rejects with a status; no shared table of values exists.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_MODEL` (read `config.ts:631`, `AgentCLI.ts:442`; exported `config.ts:1805`; mapped to `ANTHROPIC_MODEL`), `CODEMIE_MODEL_SOURCE` (`cli|env|default`, set `AgentCLI.ts:417,440`, `bin/codemie-copilot.js:118,182,193`), `CODEMIE_HAIKU_MODEL`/`CODEMIE_SONNET_MODEL`/`CODEMIE_OPUS_MODEL` (tier vars, `claude.models.ts:42-47`; NG3), `ANTHROPIC_MODEL` and `ANTHROPIC_DEFAULT_*_MODEL` (written by `claude.plugin.ts:459-466,504-509`), `CODEMIE_DEBUG` (debug logging), `CODEMIE_PROFILE_CONFIG` (JSON of profile incl. `model`, `AgentCLI.ts:458`).

### Configuration Files

- Profile `model` (global/local `.codemie` config, `ConfigLoader`); `config.example.json`. No length or character constraint on `model` found in `src/env/types.ts` / `config.ts`.

### Feature Flags and Deployment Concerns

- None found for this area. Proxy plugins are registered unconditionally in `plugins/index.ts`; a new plugin changes the daemon and per-session proxy (both use `registerCorePlugins`). `src/bin/proxy-daemon.ts` hosts the long-lived daemon that serves Claude Desktop (its `clientType` from `defaultClientOf`, `proxy-daemon.ts:86`).

---

## 6. Risk Indicators

- Existing mechanism kept in place: the normalizer's pass-through of unresolved models (and its `onRequest` + internal `catch {}`) stays for valid values; consumers listed in Section 2 "Consumers of Changed Contracts".
- Existing mechanism kept in place: explicit-model auto-heal skip (`claude.models.ts:441`) stays; Copilot/Codex/Kimi/Gemini catalog checks stay (NG2) and still echo full values in their messages.
- Speculative: an empty `-m ''` / `CODEMIE_MODEL=''` is invisible to current truthy checks (`AgentCLI.ts:416,442`, `config.ts:631`, `:228`); detecting it needs `!== undefined` checks on `options.model` and `process.env.CODEMIE_MODEL` rather than on `config.model`, which can differ from the env value when `--profile` is used (`config.ts:214-231`).
- Speculative: AC1/AC2 mention env value with `--profile`, and a `claude-x-<hash>` desktop alias is seen raw by a handleRequest hook; the rule must accept those shapes.
- Speculative: `\s`, `\p{White_Space}` and `\p{Cc}` differ at the edges (e.g. U+FEFF is in `\s` but not White_Space; U+200B is in neither); D1 says "any Unicode whitespace or control character" without naming the set, so the shared test table should pin the edge cases.
- Speculative: a request-level hook runs before SSO/JWT auth (10) and, if placed under priority 8, before `client-attribution` settles `agentName`; `serves()` is evaluated per interceptor at its turn (`sso.proxy.ts:612`), so priority and `clients` choice determine which clients are covered (a shared-key request later reclassified to `claude-desktop`).
- Speculative: the normalizer has no URL filter, so a hook covering the same traffic would see every JSON POST for those clients (including non-model endpoints and bodies where `model` is absent, which today means "use config.model").
- AC4 log echoes found today (see Consumers): `AgentCLI.ts:114` debug-logs full options before validation; `logging.plugin.ts:95` logs the whole request body at debug but only in `onRequest`, which a handleRequest rejection precedes; `sanitizeLogArgs` does not redact or truncate model strings; `desktop-models.plugin.ts:108` warns with the alias value.
- Error shape: a thrown error from a handleRequest hook produces `{error:{type:'ProxyError',...}}`, not the Anthropic envelope (`sso.proxy.ts:764-768`); the Anthropic envelope requires the hook to write the response itself.
- Layering: the proxy plugin (providers) and `AgentCLI` (agents) are in different registries; precedent for imports into both exists from `src/utils/`; `claude-model-resolver.ts:13-18` states a preference against cross-layer coupling for the proxy.
- `AgentCLI.handleRun` is shared by all agents; a Claude-only branch needs the existing name check pattern (`AgentCLI.ts:138`); `claude-acp` shares the plugin family but not the proxy client list.
- Public repo: 298 ticket-key occurrences already exist in `src/`; the guide restricts only the commit subject.

---

## 7. Summary for Complexity Assessment

Layers: two entry points and one shared helper. Launcher: `src/agents/core/AgentCLI.ts` (`handleRun`, before auth, with the existing `--reasoning-effort` check as the in-file precedent) and the Claude plugin family. Proxy: a new request-level (`handleRequest`) interceptor in `src/providers/plugins/sso/proxy/plugins/` registered in `plugins/index.ts`, writing the Anthropic-style envelope the way `gateway-key.plugin.ts` does. The shared rule has layer-neutral precedent in `src/utils/` (`header-value.ts`, `model-normalizer.ts`), which both layers already import from. Existing files touched are few (AgentCLI, plugin index, possibly a utils module); no DB, config schema or external service involved.

Technical novelty is low: the hook mechanism, the error envelope, and a launch-time exit pattern all exist. The non-obvious parts are (a) empty values are treated as "absent" in four places today, (b) env value vs `config.model` divergence under `--profile`, (c) hook order against client attribution and desktop alias rewriting, and (d) AC4 log echoes in code that runs before or after the check. Test posture: strong harnesses exist for every touch point (AgentCLI `handleRun` spies, gateway-key request/response mocks, real-proxy tests), but nothing covers malformed model values and no shared value table exists (AC5).

Key risk factors: the exact whitespace/control character set in D1, covering exactly the Claude-path clients without affecting codex/kimi/gemini traffic, empty-versus-absent semantics, and not leaking the value through existing debug logs. Size drivers are test breadth (table-driven for launcher, plugin, and optionally a real-proxy test) rather than production code.

---

## 8. External References

None named by the task. (Repo guides read per AGENTS.md: architecture, security-practices, git-workflow, testing-patterns; all resolved.)
