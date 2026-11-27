# Technical Research

**Task**: sso proxy claude-request-normalizer bedrock tools compact
**Generated**: 2026-11-24
**Research path**: filesystem

---

## 1. Original Context

Fix https://jiraeu.epam.com/browse/EPMCDME-16965. Focus on error message "litellm.UnsupportedParamsError: Bedrock doesn't support tool calling without 'tools=' param specified. Pass 'tools=' param OR set 'litellm.modify_params = True' | 'litellm_settings::modify_params: True' to add dummy tool to the request. Received Model Group=claude-sonnet-4-6 Available Model Group Fallbacks=None". Focus on Suggested Fix: "Add tools normalization/preservation for Bedrock-bound Claude requests during compaction/summarization, in claude-request-normalizer.plugin.ts or a new Bedrock-specific normalizer."

Ticket body: EPMCDME-16965 (Bug): "Claude request normalizer does not inject/preserve tools param for Bedrock-routed /compact requests, causing litellm.UnsupportedParamsError". /compact is non-functional with Bedrock-backed Claude via the ai-run-sso provider; the session stays broken (every later message repeats the error). Only existing Bedrock+compaction handling is diagnostic-only logBedrockUpstreamError() in src/providers/plugins/sso/proxy/sso.proxy.ts (~752-770, commit a08abcc4 / EPMCDME-13136). No plugin under src/providers/plugins/sso/proxy/plugins/ (claude-request-normalizer.plugin.ts, background-request-normalizer.plugin.ts) injects or preserves a tools array. Repro: codemie-code session with Bedrock Claude, converse, /compact. Reference GitHub issue codemie-ai/codemie-code#283. Prior PO analysis notes: checked-in litellm_config.yaml already sets modify_params: true; automatic compaction at 85% context can send same request; CLI cannot tell Bedrock from Vertex for shared aliases. Proposed ACs: /compact on Bedrock completes; next message after works; auto-compaction works; non-Bedrock/ordinary requests unchanged; automated test reproduces failing request shape. A prior mitigation idea: a pure helper (e.g. claude-tools-guard.ts) used by the claude normalizer that injects a dummy tools entry when messages contain tool_use/tool_result blocks but tools is absent/empty.

feature_area: sso proxy claude-request-normalizer bedrock tools compact
Note: do not write tests.

---

## 2. Codebase Findings

### Existing Implementations

**Purpose: make a tools-less request carrying tool history survive Bedrock/LiteLLM.**
- Nothing in the proxy touches `tools`, `tool_use` or `tool_result` in request bodies. Grep of `src/providers/plugins/sso/proxy` (non-test) finds only unrelated `tool_result` event names in `plugins/otlp-spool/reopen-hold.ts:44`. None found for tools injection/preservation.
- `src/providers/plugins/sso/proxy/sso.proxy.ts:399-402` and `:784-802` `logBedrockUpstreamError()` — diagnostic only. Runs after the response is streamed (so cannot alter the request), on any status >=400. Detects Bedrock by body `model` starting `bedrock/` or containing `amazon`/`qwen`. A Claude alias such as `claude-sonnet-4-6` matches none of these, so it does not even log for this ticket's failure. Its message tells admins to set `litellm_settings.modify_params: true`.
- `modify_params` server-side fix (EPMCDME-13136): described in `docs/superpowers/specs/2026-06-24-epmcdme-13136-bedrock-qwen3-compaction-design.md` and the plan next to it. It lives in the separate `codemie` repo. `litellm_config.yaml` is not tracked in this repo (`git ls-files` finds none), so the ticket's "checked-in ... sets modify_params: true" is not checkable here.

**Purpose: per-request Claude body normalization in the proxy.**
- `src/providers/plugins/sso/proxy/plugins/claude-request-normalizer.plugin.ts` (360 lines), priority 14, `clients` = `codemie-claude`, `codemie-copilot`, `CLAUDE_DESKTOP`, `VSCODE_CLAUDE_CODE` (line 191). `onRequest` (233-280) does the following:
  - It parses the JSON body only when the content-type is JSON.
  - It reads `model` from the body, or falls back to `context.config.model`.
  - It applies three module-level handlers driven by `MODEL_CAPABILITY_TABLE` (37-78): `handleDeprecatedSamplingParams`, `handleUnsupportedEffort` and `handleThinkingField`.
  - It rewrites `model` to a tenant deployment via `resolveModel` (catalog fetch, 10-minute TTL cache).
  - It re-serializes and updates `content-length` only when a handler reports a change. Errors are swallowed and the request passes through unchanged.
  - Every handler follows one shape: `(body, caps, model) => boolean modified`. A tools handler would fit that shape without touching the table.
- `plugins/background-request-normalizer.plugin.ts` (134 lines), priority 14, same client list. It rewrites `model` to the haiku tier for title-gen requests (system prompt contains "sentence-case title"), using a `BACKGROUND_REQUEST_RULES` list with `matches`/`resolveForcedModel`. It does not touch tools.
- Registration: `plugins/index.ts:47-48` (Claude then Background normalizer, both priority 14) and exports at `:77-78`.
- Other normalizers use the same skeleton: `kimi-request-normalizer.plugin.ts` (priority 14, clients `codemie-kimi*`) caps `max_tokens`. Its header comment already notes that "Bedrock-backed deployments" reject some values. `request-sanitizer.plugin.ts` (priority 15) is limited to `codemie-code`/`codemie-opencode*` agents, so it is not in the Claude path.

**Other touched code**: `src/providers/plugins/sso/proxy/plugins/types.ts` (`ProxyPlugin`/`ProxyInterceptor`), `src/providers/plugins/sso/proxy/proxy-types.ts` (`ProxyContext`), and `src/providers/plugins/sso/proxy/proxy-clients.ts`. `docs/ARCHITECTURE-PROXY.md:592` and `:1040` list the normalizers and would need updating if a plugin is added.

### Decisions Already in the Code
- Normalizer plugins mutate `context.requestBody` and `content-length` in place. They re-serialize only when something changed, and they never fail a request: parse errors pass through (`claude-request-normalizer.plugin.ts:277-279`).
- Per-model behavior is kept in a data table, not in `if` chains. Model patterns use `(?:[^0-9]|$)` boundaries (lines 35-36). The capability table matches on the client's requested (canonical) name BEFORE the tenant-id rewrite (comment at 260-262).
- The normalizer sees only the model alias, not the backend. There is no Bedrock/Vertex signal anywhere in the plugin (`context.config` has `provider`, `model`, `clientType`, `targetApiUrl`). This agrees with the PO note that the CLI cannot tell Bedrock from Vertex for shared aliases. Any change in the Claude path therefore applies to every backend unless it is conditioned on the body alone (tool blocks present, `tools` absent or empty).
- The earlier Bedrock compaction fix was deliberately server-side (`modify_params`) plus diagnostics. No request mutation was chosen then (design doc `2026-06-24-...-design.md`, "Scope: Global").
- Data stored in the form the task needs: tool-call history is in `body.messages[].content[]` blocks of `type: "tool_use"`/`"tool_result"`. `body.tools` is a top-level array. Both are read directly from the parsed body, with no transformation needed.

### Task Statements Checked Against the Code
- "No plugin ... injects or preserves a tools array": holds (grep above).
- "Only existing Bedrock+compaction handling is diagnostic-only logBedrockUpstreamError() (~752-770)": holds in kind. The location is actually `sso.proxy.ts:784-802`, so the ticket's line numbers are stale.
- "logBedrockUpstreamError covers this case": contradicted for this model name. Its model filter does not match `claude-sonnet-4-6` (see above).
- "Fix in claude-request-normalizer.plugin.ts or a new Bedrock-specific normalizer": the Claude normalizer's `clients` scope covers `codemie-claude`, `codemie-copilot`, claude-desktop and vscode. The ticket repro uses "codemie-code". `codemie-code` is NOT in `ALLOWED_AGENTS`, so the Claude normalizer does not run for the repro agent. The only plugin whose clients include `codemie-code` is `request-sanitizer.plugin.ts` (reasoning params only). Whether `codemie-code` Claude traffic reaches this plugin needs confirming in the spec. Unverified: which `agentName` / `clientType` the repro session sends.
- "checked-in litellm_config.yaml already sets modify_params: true": unverified (file is in the `codemie` repo, not here). The error text in the ticket states the flag was not set, or was not effective, for model group `claude-sonnet-4-6`.
- "Auto-compaction at 85% context can send same request": unverified here. `compact` appears in `src/agents/plugins/claude/*` (session/transcript handling), not in the proxy. No proxy code identifies a compaction request.
- "CLI cannot tell Bedrock from Vertex for shared aliases": holds (see Decisions).

### Consumers of Changed Contracts
Request-body shape consumers downstream of priority 14 on the Claude path: `RequestSanitizer` (15, other clients only), `header-injection` (20), `logging` (50), `otlp` (10), `sso.session-sync` (100). Only `logging`/`otlp` read bodies for analytics. If `tools` is injected, then any request-body logging or analytics will see the extra entry. Not examined in depth. A changed `tools` field would be seen upstream by LiteLLM, whose own dummy-tool logic (`converse_transformation.py`, per the 13136 design doc) is the same remedy applied server-side.

### Architecture and Layers Affected
Proxy plugin layer only: `src/providers/plugins/sso/proxy/plugins/` (interceptor `onRequest`), plus the registry in `plugins/index.ts` if a new plugin is created. The CLI/registry/agent layers are not involved.

### Integration Points
Upstream is the CodeMie gateway, then LiteLLM, then Bedrock Converse. No new external client needed.

### Patterns and Conventions
ES modules with `.js` import suffix, `logger.debug` for per-request logs, a `[plugin-name]` log prefix, a guard clause on content-type, and try/catch pass-through. Pure helpers are used for per-request logic (for example `claude-model-resolver.ts`, `otlp-json-masking.ts`).

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/` exists (architecture, development, integration, security, standards, testing, usage). `docs/ARCHITECTURE-PROXY.md` covers the plugin pipeline and the normalizers (lines 592, 1040). Guides were not read in depth. The facts above come from source.

### Architectural Decisions
`docs/superpowers/specs/2026-06-24-epmcdme-13136-bedrock-qwen3-compaction-design.md` and its plan record the server-side `modify_params` decision. `docs/superpowers/plans/2026-10-23-support-claude-5-5-models.md` records the capability table design.

### Derived Conventions
See Patterns and Conventions.

---

## 4. Testing Landscape

### Existing Coverage
`src/providers/plugins/sso/proxy/plugins/__tests__/`: `claude-request-normalizer.plugin.test.ts`, `claude-request-normalizer.effort.test.ts`, `plugin-order.test.ts`, `kimi`-style siblings, `request-sanitizer.plugin.test.ts`. No test covers tools handling or `sso.proxy.ts` `logBedrockUpstreamError` (not searched exhaustively).

### Testing Framework and Patterns
Vitest. Tests build a `PluginContext` and a `ProxyContext` (JSON `Buffer` body, headers, `url: '/v1/messages'`), call the interceptor's `onRequest`, then parse `context.requestBody`. They mock `fetchCodeMieLlmModels` and credentials via `vi.mock`/`vi.hoisted`. They use `setAvailableModelsForTest` as a seam.

### Coverage Gaps
Tool-history-without-tools request shape. Repo policy: tests only on explicit request. This task says not to write tests.

---

## 5. Configuration and Environment

### Environment Variables
`CODEMIE_HAIKU_MODEL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL` (background normalizer only). None relevant to tools.

### Configuration Files
`litellm_config.yaml` (`litellm_settings.modify_params`) is outside this repo. Nothing in this repo's config governs tools.

### Feature Flags and Deployment Concerns
No flags found in the proxy plugins. Per `docs/ARCHITECTURE-PROXY.md`, the proxy runs as a daemon (`bin/proxy-daemon.js`), so a plugin change needs a daemon restart to take effect for already-running sessions (Speculative).

---

## 6. Risk Indicators

- Scope mismatch: the `codemie-code` agent from the repro is not in the Claude normalizer's `clients` (`claude-request-normalizer.plugin.ts:191`). See Section 2, Task Statements.
- No Bedrock signal in the plugin context: a Bedrock-only condition is not derivable from the alias. Speculative: any fix keyed on body shape applies to Vertex/Anthropic-direct traffic too.
- Existing mechanism kept in place: `logBedrockUpstreamError` (diagnostic) and server-side `modify_params` already target the same purpose. See Section 2, Existing Implementations.
- The `logBedrockUpstreamError` model filter misses Claude aliases (`sso.proxy.ts:790`).
- Speculative: an injected dummy tool could change model behavior on non-Bedrock backends. Tool schema validity (Anthropic requires `name` and `input_schema`) is unchecked.
- `modify_params` state in `litellm_config.yaml` cannot be verified from this repo.
- Stale line references in the ticket (`sso.proxy.ts` ~752-770 vs actual 784-802).
- No existing proxy code detects compaction requests.

---

## 7. Summary for Complexity Assessment

The affected layer is the SSO proxy plugin layer. The nearest existing code is `claude-request-normalizer.plugin.ts` (a 360-line file with a clear handler pattern) and its registration in `plugins/index.ts`. No code today reads or writes `tools` in the proxy. A change would add logic in an established plugin shape, and a new plugin would add a registry line and a docs mention. There are no schema, config or migration changes in this repo.

The technical risks are scoping rather than mechanics. The repro agent (`codemie-code`) is outside the Claude normalizer's client list, and nothing in the proxy can tell Bedrock from other backends. The server-side `modify_params` fix lives in another repo and cannot be verified here. The normalizer code is well tested (existing unit tests in `__tests__/`), but no test covers tools handling.

Pattern novelty is low (mutate body, re-serialize, pass through on error). Open questions for the spec are which client names carry the failing traffic, and whether to condition on body shape alone.

---

## 8. External References

None named by the task as a file path. The Jira ticket URL (https://jiraeu.epam.com/browse/EPMCDME-16965) and GitHub issue codemie-ai/codemie-code#283 are outside the filesystem. They were not fetched, so their content is unverified beyond the task text. `litellm_config.yaml` is referenced but not present in this repository.
