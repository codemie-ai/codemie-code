# Technical Research

**Task**: claude prompt-cache ttl env
**Generated**: 2026-11-14
**Research path**: codegraph

---

## 1. Original Context

there is an issue with claude code run from codemie-claude command. there is suspicion that cache is 5min by default, need to convert to 1h, since users are complaning on ddrsatical increase of spends. need to investigate availabne envvvars in config, current config in codemie code and make a fix.

---

## 2. Codebase Findings

### Existing Implementations

**Purpose A — "Claude Code launched by `codemie-claude` should use a 1-hour prompt cache"**

- `ENABLE_PROMPT_CACHING_1H = '1'` is already injected: `src/agents/plugins/claude/claude.plugin.ts:351-353`, inside `ClaudePluginMetadata.lifecycle.beforeRun` (starts `:273`).
  - Rule: set only when `!env.ENABLE_PROMPT_CACHING_1H` (any non-empty inherited value, including `'0'`, is kept). Not provider-gated, no comment, no doc link — unlike every neighbouring variable in the hook.
  - Consumers of the name (repo-wide search for `PROMPT_CACHING`): only this line, a comment in `src/agents/plugins/claude/plugin/__tests__/statusline.test.ts:670` ("CodeMie sets ENABLE_PROMPT_CACHING_1H=1, so this is the common path"), and an older analysis doc. No test asserts it.
  - Distance from the purpose: the variable reaches the `claude` process only when the agent-default `beforeRun` actually runs — see hook resolution below.
- Hook resolution decides whether that hook runs: `resolveHook`, `src/agents/core/lifecycle-helpers.ts:70-127`.
  - provider `'*'` + provider `'<agent>'` hook both exist → chain wildcard → specific; **the agent default hook is not in the chain** (`:84-95`).
  - only provider `'<agent>'` hook → it alone (`:98-100`).
  - only provider `'*'` hook → wildcard → agent default (`:103-117`).
  - no provider hooks → agent default (`:125-126`).
- Per provider, for agent `claude` (read from templates, not executed):

| Provider | Provider `beforeRun` hooks | Agent default `beforeRun` runs? |
|---|---|---|
| sso / jwt (`defaultAgentHooks`, `src/providers/core/default-agent-hooks.ts:18-51`) | `'*'` only: installs extension, sets `CODEMIE_CLAUDE_EXTENSION_DIR` | yes |
| litellm | none (no `agentHooks` in `src/providers/plugins/litellm/`) | yes |
| anthropic-subscription (`anthropic-subscription.template.ts:39-99`) | `'*'` only: deletes `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, tier vars, `CLAUDE_CODE_SUBAGENT_MODEL` | yes |
| ollama (`ollama.template.ts:31-66`) | `'*'` only: rewrites `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, tier vars | yes |
| bedrock (`bedrock.template.ts:47-130`) | `'*'` (AWS_*) **and** `'claude'`: `CLAUDE_CODE_USE_BEDROCK='1'`, deletes `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL`, sets `ANTHROPIC_MODEL`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS` (default `4096`), `MAX_THINKING_TOKENS` (default `1024`) | **no** — per `lifecycle-helpers.ts:84-95` |

- Everything the agent default `beforeRun` sets (all guarded by `!env.X`): `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` (`'0'` for `ai-run-sso`/`litellm`, else `'1'`, `:287-289`), `CLAUDE_CODE_AUTO_MODE_SERVER='0'` (`ai-run-sso` only, `:295-300`), `CLAUDE_CODE_ENABLE_TELEMETRY='0'` (`:305`), `DISABLE_AUTOUPDATER='1'` (`:313`), `FORCE_AUTOUPDATE_PLUGINS='1'` (`:326`), `ENABLE_TOOL_SEARCH` (`'true'`/`'0'`, `:347`), `ENABLE_PROMPT_CACHING_1H='1'` (`:351`), `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (85 or profile `claudeAutocompactPct`, `:355-368`); plus `CODEMIE_ROUTER_MODEL_IDS`, `CODEMIE_MODEL_LABELS`, `CODEMIE_CLAUDE_MODEL_PICKER_SETTINGS` (`:525-549`).
- `envMapping` (`claude.plugin.ts:189-201`), applied by `transformEnvVars` before `beforeRun`: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`.
- Other prompt-caching variables (`FORCE_PROMPT_CACHING_5M`, `DISABLE_PROMPT_CACHING*`, `ENABLE_PROMPT_CACHING_1H_BEDROCK`): none found in `src/`, `docs/`, `.ai-run/`, `tests/`.
- `claude-acp` reuses the same metadata and lifecycle (`claude-acp.plugin.ts:16-19`); its agent name is `claude-acp`, so provider `'claude'` hooks do not match it.

**Purpose B — "The request that leaves the machine still carries the cache TTL"**

- SSO proxy forwards every request header except `host`/`connection`: `src/providers/plugins/sso/proxy/sso.proxy.ts:428-432`.
- Body-rewriting plugins active for `codemie-claude`: `claude-request-normalizer.plugin.ts:235-282` (strips/transforms `thinking`, `effort`/`output_config.effort`, `temperature`/`top_p`/`top_k`; rewrites `model`) and `background-request-normalizer.plugin.ts:105-135` (rewrites `model` for title-generation calls). Both parse and re-serialize the JSON body; neither reads or removes `cache_control`, `ttl` or `anthropic-beta`.
- `request-sanitizer.plugin.ts:39` is disabled for Claude (allowed agents: `codemie-code`, `codemie-opencode`, `codemie-opencode-acp`).
- Search of `src/providers/plugins/sso/proxy/` (excluding tests and `otlp-spool`) for `beta|cache|ttl`: no hit touching request caching.

**Purpose C — "See which cache TTL was actually billed"**

- Statusline cost: `src/agents/plugins/claude/plugin/statusline.ts:430-435` reads `usage.cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens` from the transcript and prices the 1h bucket with `rate.cacheWrite1h`; falls back to flat `cache_creation_input_tokens` when both are zero. Covered by `plugin/__tests__/statusline.test.ts:669-689`.
- Rate card: `src/utils/pricing.json` (`cacheWrite1h` per model), `src/utils/pricing.ts:24,48,64`, `src/utils/bedrock-pricing.mjs:109`. The statusline test records sonnet at $6/M (1h write) vs $3.75/M (5m write).
- Other readers of the split: `src/agents/plugins/claude-code-otlp/transcript/usage-request.ts`, `subagent-usage.ts`, `src/cli/commands/analytics/cost/usage-readers.ts`.

**Other touched code**

- Env assembly order: `BaseAgentAdapter.runSession`, `src/agents/core/BaseAgentAdapter.ts:602-613` (`process.env` → `envOverrides` → CodeMie vars), `:676` `transformEnvVars`, `:680` `executeBeforeRun`, `:700` merge back into `process.env`.
- Native-Claude connectors that write env into Claude settings without going through `beforeRun`: `src/cli/commands/proxy/connectors/claude-code-otlp.ts:81-91` (`CODEMIE_ENV_KEYS`, telemetry/OTEL keys only), `vscode-claude-code.ts:17-19` (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` only).

### Decisions Already in the Code

- **Convention for a Claude env default**: `if (!env.X) env.X = '<value>'` in `beforeRun`, with a comment stating why, the opt-out value and the upstream doc URL (`claude.plugin.ts:274-349`). Alternative: provider-template hooks. The prompt-caching line (`:351-353`) follows the guard but carries no comment or reason — "none found".
- **Never write `''`**: the `!env.X` guard treats empty as unset (`claude.plugin.ts:282-283`; pinned by `claude.plugin.tool-search.test.ts:60-64`).
- **Provider gating by set**: `TOOL_SEARCH_VERIFIED_PROVIDERS` (`:70`) and `AUTO_MODE_SERVER_UNSUPPORTED_PROVIDERS` (`:87`) gate defaults on `env.CODEMIE_PROVIDER`; reason recorded: an unverified gateway answers HTTP 400 rather than degrading (`:57-69`). Prompt caching is not gated this way.
- **Agents stay provider-agnostic; providers customise via `agentHooks`** (`lifecycle-helpers.ts:7-15`). Consequence recorded nowhere: a provider that registers an agent-specific `beforeRun` replaces the agent default.
- **Profile-level knob precedent**: `claudeAutocompactPct` — `src/env/types.ts:156`, `src/utils/config.ts:775`, `src/migrations/007-decouple-provider-workspace-config.migration.ts:24`, read from `CODEMIE_PROFILE_CONFIG` at `claude.plugin.ts:357-366`. No generic per-profile env map found (searched `env/types.ts`, `utils/config.ts`, `agents/core/types.ts`, `AgentCLI.ts`).
- **User override paths today**: (1) shell env — wins through the `!env.X` guard; (2) `~/.claude/settings.json` `env` block — read by Claude Code itself and takes precedence over process env (`.ai-run/guides/usage/project-config.md:239-260`); CodeMie detects conflicts only for `ANTHROPIC_BASE_URL` and `ANTHROPIC_MODEL` (`src/agents/plugins/claude/settings-conflict.ts:29-47`).

### Task Statements Checked Against the Code

- "suspicion that cache is 5min by default" — **contradicted at the launch-env level** for sso, jwt, litellm, anthropic-subscription, ollama (`claude.plugin.ts:351-353` sets the 1h flag); **holds for bedrock**, where the agent default hook is not chained (`lifecycle-helpers.ts:84-95`, `bedrock.template.ts:90-129`). Whether Claude Code 2.1.281 (`CLAUDE_SUPPORTED_VERSION`, `:42`) and the gateway behind the proxy honour the flag is **unverified** — outside this repository. What would settle it: the `ephemeral_1h_input_tokens` vs `ephemeral_5m_input_tokens` split in a real session transcript, or a captured request body's `cache_control.ttl`. The only in-repo sample, fixture `tests/integration/session/fixtures/session-624a4a58.jsonl`, shows `"ephemeral_1h_input_tokens":0` on the sampled rows (fixture date and provider unknown).
- "need to convert to 1h" — **keeps an existing mechanism in place**: the `ENABLE_PROMPT_CACHING_1H` line above (consumers listed under Purpose A).
- "users are complaining on drastic increase of spends" — **unverified** (no usage data in the repository). Fact on record: the repo's rate card prices 1h cache writes above 5m writes (`pricing.json`, `statusline.test.ts:669-679`).
- "investigate available env vars in config" — upstream variable list is **unverified** here; the code cites `https://code.claude.com/docs/en/settings` (`claude.plugin.ts:304`), not fetched.

### Consumers of Changed Contracts

- `ClaudePluginMetadata.lifecycle.beforeRun`: invoked via `executeBeforeRun` (`BaseAgentAdapter.ts:680`) for `claude` and `claude-acp`; called directly by tests `claude.plugin.{tool-search,auto-update,statusline,conflict,subagent-warning,model-swap-warning,otlp-preflight,otlp-preflight-endpoint}.test.ts`. `ClaudePluginMetadata` is also imported by `claude-code-otlp/event-fields/session-env-fields.ts:10` (reads `mcpConfig` only).
- `resolveHook` / `executeBeforeRun`: every agent adapter (18 `BaseAgentAdapter` implementations) and every provider template with `agentHooks` (sso, jwt, bedrock, ollama, anthropic-subscription, moonshot-subscription). No test of the chaining rules found (searched `providers-core`, `bedrock.setup-template`, `anthropic-subscription.template`, `BaseAgentAdapter` tests for `resolveHook|wildcard|chain`).
- `BedrockTemplate.agentHooks`: `bedrock.setup-template.test.ts:273+` pins the wildcard AWS transform and `CLAUDE_CODE_USE_BEDROCK` (`:305`).

### Architecture and Layers Affected

- Agent plugin layer: `src/agents/plugins/claude/claude.plugin.ts`.
- Agent core: `src/agents/core/lifecycle-helpers.ts`, `BaseAgentAdapter.ts`.
- Provider plugin layer: `src/providers/plugins/bedrock/bedrock.template.ts`, `src/providers/core/default-agent-hooks.ts`.
- SSO proxy plugins: read-only relevance (Purpose B).

### Integration Points

- Upstream Claude Code binary (`@anthropic-ai/claude-code`, supported 2.1.281, minimum 2.1.269) interprets the env vars.
- `ai-run-sso`: local proxy → CodeMie backend → LiteLLM `/v1/messages` → deployments incl. `bedrock_converse` (`claude.plugin.ts:76-78`). Bedrock provider: direct AWS, no proxy.

### Patterns and Conventions

- `!env.X` guarded defaults with rationale comments; provider sets for gating; ES modules, `.js` import suffixes, `logger`/`sanitizeLogArgs` (AGENTS.md).

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/usage/project-config.md:239-260` — `~/.claude/settings.json` `env` precedence over profile env.
- `.ai-run/guides/architecture/architecture.md`, `integration/external-integrations.md`, `testing/testing-patterns.md` exist; none mentions prompt caching (searched `ENABLE_PROMPT_CACHING|DISABLE_AUTOUPDATER|ENABLE_TOOL_SEARCH|CLAUDE_AUTOCOMPACT` in `docs/*.md`, `README.md`, `.ai-run/`, `openwiki/`: no matches).

### Architectural Decisions
- Hook resolution priority documented in `lifecycle-helpers.ts:7-15,54-62` and `src/agents/core/types.ts:128-141`.

### Derived Conventions
- One focused test file per env concern, named `claude.plugin.<concern>.test.ts`.

---

## 4. Testing Landscape

### Existing Coverage
- `src/agents/plugins/claude/__tests__/claude.plugin.tool-search.test.ts` — per-provider defaults and explicit-value-wins for `ENABLE_TOOL_SEARCH` / `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`; calls the metadata hook directly, so its `bedrock` case bypasses `resolveHook`.
- `claude.plugin.auto-update.test.ts` — `DISABLE_AUTOUPDATER`, `FORCE_AUTOUPDATE_PLUGINS`.
- `claude.provider-support.test.ts`, `tests/integration/sso-claude-plugin.test.ts` (extension install + `--plugin-dir`), `src/providers/core/__tests__/providers-core.test.ts:305-369` (default wildcard hook), `bedrock.setup-template.test.ts`, `anthropic-subscription.template.test.ts`.

### Testing Framework and Patterns
- Vitest; `vi.mock('fs/promises')`, `vi.mock('fs')`; helper `runBeforeRun(env)` invoking `ClaudePluginMetadata.lifecycle.beforeRun` and asserting on the mutated env.

### Coverage Gaps
- No assertion on `ENABLE_PROMPT_CACHING_1H` or `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` defaults.
- No test of `resolveHook` chaining (which hooks run for a provider/agent pair).
- No test of the env a `claude` launch receives end to end on bedrock.

---

## 5. Configuration and Environment

### Environment Variables
- Listed under Purpose A. Selector: `CODEMIE_PROVIDER`. Profile passthrough: `CODEMIE_PROFILE_CONFIG` (JSON).

### Configuration Files
- `~/.codemie/codemie-cli.config.json` (profiles, `claudeAutocompactPct`); `~/.claude/settings.json` and project `.claude/settings*.json` (`env` block read by Claude Code).

### Feature Flags and Deployment Concerns
- None found for prompt caching. `--dry-run` prints the generated config after `beforeRun` (`BaseAgentAdapter.ts:682-696`).

---

## 6. Risk Indicators

- The 1h flag already exists (`claude.plugin.ts:351-353`); the reported symptom therefore has a cause this repository does not show for non-bedrock providers — see "Task Statements Checked Against the Code".
- Bedrock + `claude`: agent default `beforeRun` is not chained, so none of its defaults (1h cache flag included) reach the process — finding from reading `lifecycle-helpers.ts:84-95`, not from a run.
- Upstream behaviour of `ENABLE_PROMPT_CACHING_1H` under a custom `ANTHROPIC_BASE_URL`, under `CLAUDE_CODE_USE_BEDROCK`, and with `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` is unverified; no upstream docs or binary inspected.
- Gateway behaviour (CodeMie backend / LiteLLM / `bedrock_converse`) for a 1h `cache_control.ttl` is unverified and outside this repository.
- 1h cache writes are priced above 5m writes in the repo rate card; the direction of the spend effect depends on session idle patterns not measured here.
- A user's `~/.claude/settings.json` `env` block overrides the injected value silently; conflict detection covers only base URL and model.
- No test pins the prompt-caching default or the hook chaining rules.
- Speculative: the proxy rewrites `model` per request (deployment resolution, title-generation rule) and a router model can dispatch turns to different models; prompt caches are per model, so cache reuse may be affected independently of TTL.
- Speculative: changing `resolveHook` chaining would alter behaviour for every provider/agent pair, not only bedrock/claude.

---

## 7. Summary for Complexity Assessment

The variable the task asks for, `ENABLE_PROMPT_CACHING_1H=1`, is already injected by the Claude agent plugin's default `beforeRun` hook (`src/agents/plugins/claude/claude.plugin.ts:351-353`), guarded so an explicit user value wins. It reaches the `claude` process for sso, jwt, litellm, anthropic-subscription and ollama. For bedrock it does not: the provider registers both a wildcard and a `claude`-specific `beforeRun`, and `resolveHook` (`src/agents/core/lifecycle-helpers.ts:84-95`) then omits the agent default hook entirely. The SSO proxy and its Claude request plugins do not touch `cache_control`, `ttl` or `anthropic-beta`. Layers in reach: agent plugin, agent core hook resolution, bedrock provider template; the file surface is small (one to three source files plus tests).

Novelty is low on the code side — the convention for env defaults, provider gating sets and the test helper pattern all exist. The open part is investigative: whether the upstream binary and the gateway actually apply a 1h TTL cannot be confirmed from this repository, and the task's premise (5-minute default) is contradicted at the launch-env level for the default SSO path.

Test posture: sibling env defaults have dedicated unit tests; the prompt-caching default and the hook chaining rules have none. Key risks are external verification (upstream flag semantics, gateway TTL support), the higher price of 1h cache writes in the repo's own rate card, and the breadth of `resolveHook` consumers should the chaining be touched.

---

## 8. External References

None named by the task.

## Facts Added by Review

Researched for the names the spec relies on, after the analysis above was written. Read like the facts layer; where a line here contradicts one above, this one was read later.

- Contract: `enrichArgs?: (args: string[], config: AgentConfig) => string[]`, declared twice — `ProviderLifecycleHooks` (`src/agents/core/types.ts:109`) and `AgentLifecycle` (`src/agents/core/types.ts:174`). Synchronous, no `this`, no `env` parameter.
- Executor: `executeEnrichArgs` (`src/agents/core/lifecycle-helpers.ts:205-219`). Takes the provider from `config.provider` (the other executors take `env.CODEMIE_PROVIDER`), resolves through `resolveHook(lifecycle, 'enrichArgs', provider, agentName)`, calls `hook(args, config)` unbound, returns `args` unchanged when no hook resolves.
- Single call site: `BaseAgentAdapter.runSession` (`src/agents/core/BaseAgentAdapter.ts:705`), after `executeBeforeRun` (`:680`) and after `Object.assign(process.env, env)` (`:700`), before `transformFlags` (`:710-715`) and reasoning-effort injection (`:719`). A `dryRun` launch returns at `:682-696`, before `enrichArgs`. The built-in handler path receives the pre-`enrichArgs` args (`:836-839`).
- `resolveHook` (`lifecycle-helpers.ts:70-127`) is shared by all five hooks. For `enrichArgs` today: wildcard + specific -> chained (`:84-95`); specific only -> returned alone, agent default not run (`:98-100`); wildcard only -> wildcard then agent default (`:103-117`); no provider hook -> agent default (`:125-126`). Chaining replaces argument 0 with the previous result (`:92`, `:114`).
- `defaultAgentHooks.claude.enrichArgs` (`src/providers/core/default-agent-hooks.ts:53-91`), used by sso (`sso.template.ts:62`) and jwt (`jwt.template.ts:42`). Reads `process.env`, not `config`: prepends `--plugin-dir $CODEMIE_CLAUDE_EXTENSION_DIR`, `--model $CODEMIE_MODEL` (trimmed, non-empty), `--settings $CODEMIE_CLAUDE_MODEL_PICKER_SETTINGS`; each only if the flag is absent from args. Returns the same array when nothing is added.
- `AnthropicSubscriptionTemplate.agentHooks.claude.enrichArgs` (`src/providers/plugins/anthropic-subscription/anthropic-subscription.template.ts:100-110`): `--plugin-dir` only.
- Providers with no `enrichArgs` at all: bedrock (`bedrock.template.ts:47-91`, `'*'` and `'claude'` `beforeRun` only), ollama (`ollama.template.ts:31-35`), moonshot-subscription (`:34-36`), litellm (no `agentHooks`).
- Agent defaults: the Claude lifecycle (`src/agents/plugins/claude/claude.plugin.ts:268`) defines `beforeRun` (`:273`) and `afterRun` (`:648`) and no `enrichArgs`. `claude-acp` spreads the same metadata under `name: 'claude-acp'` (`claude-acp.plugin.ts:16-21`). Agents that do define a default `enrichArgs`: codemie-code (`codemie-code.plugin.ts:382`), opencode (`:489`), opencode-acp (`:57`), codex (`:254`), codex-acp (`:78`), gemini (`:135`), gemini-acp (`:56`), kimi (`:75`), kimi-acp (`:13`), pi (`:314`), copilot-cli (`:316`).
- Resulting Claude launch args today: sso/jwt + `claude` -> the three flags above; anthropic-subscription + `claude` -> `--plugin-dir`; bedrock, ollama, litellm, moonshot + `claude` -> args unchanged; `claude-acp` on any provider -> args unchanged (hooks are looked up by `agentHooks[agentName]`, `lifecycle-helpers.ts:81`).
- Distance from the cache purpose: `enrichArgs` carries no cache setting. Its one link is `--settings <tempfile>` — the model-picker file written in Claude `beforeRun` (`claude.plugin.ts:537-549`) is layered over the user's settings for that process.
- `src/cli/commands/doctor/checks/index.ts:5-15`: a barrel of eleven named re-exports (`NodeVersionCheck`, `NpmCheck`, `NpmPrefixOverrideCheck`, `PythonCheck`, `UvCheck`, `AwsCliCheck`, `AIConfigCheck`, `JWTAuthCheck`, `AgentsCheck`, `WorkflowsCheck`, `FrameworksCheck`). No logic, no array, no registry.
- Only importer: `src/cli/commands/doctor/index.ts:10-22`. Tests import check files directly (`checks/__tests__/doctor-checks.test.ts:98-106`, `tests/integration/doctor-windows.test.ts:9-10`).
- What runs a check: the literal `checks: HealthCheck[]` array in `createDoctorCommand` (`doctor/index.ts:93-105`), iterated in order (`:108`). A class exported from the barrel but absent from that array does not run. `createDoctorCommand` is mounted at `src/cli/index.ts:92`.
- Contract (`doctor/types.ts`): `HealthCheck { name; run(onProgress?) }` (`:43-46`); `ItemWiseHealthCheck` adds `runWithItemDisplay` and is detected by `'runWithItemDisplay' in check` (`doctor/index.ts:113`); `HealthCheckResult { name, success, details }` (`:24-28`); `HealthCheckDetail { status, message, hint? }` (`:15-19`); `HealthStatus = 'ok' | 'warn' | 'error' | 'info'` (`:10`).
- Exit rule: `HealthCheckFormatter.displaySummary` exits 1 when any result has `success: false` (`formatter.ts:128-137`). `success` is set by each check, not derived from statuses: `AgentsCheck` fails only on an `error` detail, so `warn` keeps exit 0 (`AgentsCheck.ts:89`).
- Active profile: checks load it themselves with `ConfigLoader.load()` (`AIConfigCheck.ts:37`, `JWTAuthCheck.ts:21`). `AIConfigCheck.getConfig()` is read only by the orchestrator's `instanceof AIConfigCheck` branch, which runs the provider health check (`doctor/index.ts:159-216`).
- Not-applicable pattern: `JWTAuthCheck` returns `success: true` early (`JWTAuthCheck.ts:29`); `AgentsCheck` emits one `info` detail when nothing is installed (`AgentsCheck.ts:83-86`).
- Claude version and install state already reach doctor through `AgentsCheck.buildDetail` (`AgentsCheck.ts:37-69`): `agent.getVersion()`, `checkVersionCompatibility()`, `AgentRegistry.getInstalledAgents()`.
- Doctor reads no Claude settings file and no cache variable today; with `--verbose` it dumps all of `process.env` to the debug log, masked (`doctor/index.ts:63-83`).
- Provider hook replaces the agent default when an agent-specific one exists — `lifecycle-helpers.ts:98-100`; alternative is chaining, already done for wildcard-only (`:103-117`); reason: doc comment "fallback if no provider hooks exist" (`:57`), `types.ts:131-140`.
- `enrichArgs` hooks read `process.env`, made current by `BaseAgentAdapter.ts:698-700`; alternative is passing `env`; reason recorded in `pi.plugin.ts:62` ("`enrichArgs` receives no env at all").
- Per-process Claude settings go through `--settings <tempfile>`, not `~/.claude/settings.json` — `default-agent-hooks.ts:79-82`; reason: that file is shared by every concurrent Claude Code process.
- Doctor checks are registered by hand in an array, in display order — `doctor/index.ts:93-105`; no auto-discovery.
- "The other agent-specific provider hooks are `enrichArgs` for `claude` (`default-agent-hooks.ts:53`, `anthropic-subscription.template.ts:100`)" — holds; bedrock's `'claude'` `beforeRun` (`bedrock.template.ts:90-91`) is the only other agent-specific provider hook.
- "the Claude lifecycle defines no default `enrichArgs`" — holds (`claude.plugin.ts:268-648`).
- "`claude-acp` is not matched by `'claude'` hooks" — holds (`lifecycle-helpers.ts:81`, `claude-acp.plugin.ts:21`); it also means `claude-acp` receives none of the `'claude'` `enrichArgs` flags.
- "A new check, registered beside the existing ones (`src/cli/commands/doctor/checks/index.ts`)" — the file holds exports only; the list that runs checks is `doctor/index.ts:93-105`.
- Spec outcome "note" — `HealthStatus` has no `note`; the non-failing neutral status is `info` (`types.ts:10`).
- `executeEnrichArgs`: `BaseAgentAdapter.ts:705`; mocked as pass-through in `BaseAgentAdapter.test.ts:83` and `BaseAgentAdapter.signals.test.ts:97`.
- `checks/index.ts` barrel: `doctor/index.ts:22` only.
- `checks` array and `HealthCheckResult.success`: `displaySummary` (`formatter.ts:128`), process exit code of `codemie doctor`.
