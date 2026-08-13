# Design: codemie-pi Agent Plugin

**Status:** Approved for implementation  
**Scope:** First version — launch Pi with CodeMie proxy and live models; session analytics out of scope.

## 1. Goal

Add a new `codemie-pi` agent to `codemie-code` that installs the upstream `@earendil-works/pi-coding-agent` npm package and configures it to route all LLM traffic through the CodeMie local proxy using models provided by the CodeMie backend.

## 2. Background

- `codemie-code` already supports `codemie-claude`, `codemie-codex`, and `codemie-opencode` via the plugin architecture in `src/agents/plugins/`.
- Pi (`@earendil-works/pi-coding-agent`) is an external CLI whose configuration is driven by files in its agent directory (`~/.pi/agent` by default) plus CLI flags.
- Pi supports custom providers via `models.json`. A provider declares `api` (`openai-completions`, `openai-responses`, `anthropic-messages`, etc.), `baseUrl`, `apiKey`, and a list of models.
- Pi's agent directory can be relocated with the `PI_CODING_AGENT_DIR` environment variable.

## 3. High-level approach

**Approach A — Generate Pi `models.json`:**

1. Install Pi globally from npm (`@earendil-works/pi-coding-agent`).
2. At runtime, copy the user's existing `~/.pi/agent` into a CodeMie-managed directory under the current working directory.
3. Fetch the live model catalogue from the CodeMie proxy/backend.
4. Generate a fresh `models.json` inside the CodeMie-managed directory with two providers:
   - `codemie-proxy` — OpenAI-compatible models (`api: "openai-completions"`, `baseUrl: <proxy>/v1`).
   - `codemie-anthropic` — Claude models (`api: "anthropic-messages"`, `baseUrl: <proxy>`, `authHeader: true`).
5. Set `PI_CODING_AGENT_DIR` and invoke `pi --provider <provider> --model <model> [args...]`.

This approach was selected because it works within Pi's native config system, preserves user skills/extensions/tools, and follows the same injection pattern used by other `codemie-*` agents.

## 4. Plugin metadata

```typescript
export const PiPluginMetadata: AgentMetadata = {
  name: 'pi',
  displayName: 'Pi',
  description: 'Pi - open-source coding agent harness',
  npmPackage: '@earendil-works/pi-coding-agent',
  cliCommand: process.env.CODEMIE_PI_BIN || 'pi',

  sessionAnalyticsReport: false, // out of scope for first version

  dataPaths: {
    home: '.pi',
  },

  envMapping: {
    baseUrl: [],
    apiKey: [],
    model: [],
  },

  supportedProviders: ['ai-run-sso', 'bearer-auth', 'litellm'],

  ssoConfig: {
    enabled: true,
    clientType: 'codemie-pi',
  },

  lifecycle: { beforeRun, enrichArgs },
};
```

Notes:
- `envMapping` is intentionally empty because Pi does not read `CODEMIE_BASE_URL` / `CODEMIE_API_KEY` / `CODEMIE_MODEL` natively.
- No `supportedVersion`/`minimumSupportedVersion` for the first version to avoid blocking Pi's rapid release cycle. Version pinning can be added once a stable Pi API surface is validated.

## 5. File layout

```
src/agents/plugins/pi/
├── pi.plugin.ts          # AgentMetadata + PiPlugin class
├── pi.models.ts          # Fetch CodeMie models + build Pi models.json
├── pi.paths.ts           # Resolve cwd-relative agent dir
└── index.ts              # Re-exports
bin/codemie-pi.js         # Entry point
package.json              # Add "codemie-pi" bin entry
src/agents/registry.ts    # Register PiPlugin
```

## 6. Runtime data flow

1. `bin/codemie-pi.js` resolves `PiPlugin` from `AgentRegistry` and runs it via `AgentCLI`.
2. `BaseAgentAdapter.run()`:
   - Generates a `CODEMIE_SESSION_ID`.
   - Calls `setupProxy()`, which starts the local CodeMie proxy and sets:
     - `CODEMIE_BASE_URL = http://127.0.0.1:<port>`
     - `CODEMIE_API_KEY = proxy-handled`
3. Lifecycle `beforeRun(env, config)`:
   - Resolve `agentDir = join(cwd, '.pi', 'codemie', 'agent')`.
   - Copy `~/.pi/agent` → `agentDir` recursively (first run); on later runs only regenerate `models.json`.
   - Fetch live models from `CODEMIE_BASE_URL/v1/llm_models?include_all=true` via existing `fetchCodeMieLlmModels` (JWT or SSO auth).
   - Generate `agentDir/models.json`.
   - Set `env.PI_CODING_AGENT_DIR = agentDir`.
4. Lifecycle `enrichArgs(args, config)`:
   - Convert `--task <prompt>` to a trailing Pi message argument.
   - Prepend `['--provider', providerId, '--model', modelId]` based on the selected model's family.
5. Spawn `pi <enriched args>` with the modified environment.

## 7. Model classification

Models returned by the CodeMie `/v1/llm_models` endpoint are classified into provider sections:

| Model family | Provider section | `api` override | Notes |
|---|---|---|---|
| `claude-*` | `codemie-anthropic` | — | Provider has `authHeader: true` |
| `gpt-5-2-*`, `gpt-5.2-*`, `gpt-5-1-codex-*`, `gpt-5.1-codex-*`, `gpt-5.3-codex-*`, `gpt-5.4-*`, `gpt-5.5-*`, `gpt-5.6-*`, `gpt-5-6-*` | `codemie-proxy` | `openai-responses` | Same patterns used by OpenCode/Codex |
| Everything else (gpt-4*, o*, gemini*, deepseek*, qwen*, kimi*, etc.) | `codemie-proxy` | — | Default `openai-completions` |

Per-model fields are derived from heuristics, consistent with `opencode-dynamic-models.ts`:
- `name`: `model.label || model.deployment_name`
- `reasoning`: `true` for known reasoning families
- `thinkingLevelMap`: family-specific mapping
- `input`: `['text', 'image']` if multimodal, else `['text']`
- `contextWindow` / `maxTokens`: family-specific defaults
- `compat`: provider-level `supportsReasoningEffort: true, thinkingFormat: "reasoning_effort"`; per-model `forceAdaptiveThinking: true` for newer Claude models

Provider-level fields:
- `codemie-proxy.baseUrl`: `${CODEMIE_BASE_URL}/v1`
- `codemie-anthropic.baseUrl`: `CODEMIE_BASE_URL`
- `apiKey`: `CODEMIE_API_KEY` (typically `"proxy-handled"`)

## 8. Directory copy behavior

- **Source:** `~/.pi/agent` (resolved with Pi's default logic: `join(homedir(), '.pi', 'agent')`).
- **Destination:** `join(process.cwd(), '.pi', 'codemie', 'agent')`.
- **First run:** if the destination directory does not exist, recursively copy the entire source tree.
- **Subsequent runs:** keep the existing destination tree and overwrite only `models.json` so user modifications (settings, installed tools, etc.) survive while the model catalogue stays current.
- **Missing source:** create an empty destination directory and write only `models.json`.
- **Concurrency:** concurrent `codemie-pi` runs in the same working directory may race on `models.json`; acceptable for the first version because each run refreshes the same catalogue.

## 9. CLI argument transformations

Pi accepts `--provider <id>`, `--model <id>`, and positional messages. `enrichArgs` will:

1. If `--task <prompt>` is present, strip the flag and append `<prompt>` as a positional message argument.
2. Determine `providerId` from the selected model family.
3. Prepend `['--provider', providerId, '--model', env.CODEMIE_MODEL]`.

Example:
```
codemie-pi --task "review this code"
→ pi --provider codemie-proxy --model gpt-5.5-2026-04-24 "review this code"
```

## 10. Error handling

| Scenario | Behavior |
|---|---|
| Model fetch fails | Log warning, fall back to a minimal static `models.json` containing `CODEMIE_MODEL` if configured; otherwise throw `ConfigurationError`. |
| Copy from `~/.pi/agent` fails | Log warning, continue with an empty destination directory and generated `models.json`. |
| Selected model cannot be mapped to a provider | Throw `ConfigurationError` with the model id and available families. |
| Pi binary not found | `isInstalled()` returns `false`; `codemie install pi` installs the npm package globally. |

## 11. Out of scope

- Session analytics / metrics sync for Pi (separate task).
- Mapping CodeMie skills/extensions into Pi's extension model.
- MCP proxy injection into Pi.
- Version pinning / compatibility checks.

## 12. Verification

Manual verification steps:
1. `codemie install pi`
2. `codemie pi --task "hello"` (or `codemie-pi --task "hello"`)
3. Confirm `<cwd>/.pi/codemie/agent/models.json` exists and contains `codemie-proxy` and `codemie-anthropic` providers with live models.
4. Confirm `PI_CODING_AGENT_DIR` is set to `<cwd>/.pi/codemie/agent` in the spawned Pi process.

## 13. References

- `src/agents/plugins/opencode/opencode.plugin.ts` — config injection pattern
- `src/agents/plugins/opencode/opencode-dynamic-models.ts` — live model fetch + family detection
- `src/agents/plugins/codex/codex-models.ts` — model filtering/catalog generation
- `src/agents/core/BaseAgentAdapter.ts` — proxy setup + lifecycle orchestration
- `src/agents/registry.ts` — plugin registration
- Pi source: `/home/taras_spashchenko/TS/github/pi/packages/coding-agent/src/core/model-config.ts` — `models.json` schema
- Pi source: `/home/taras_spashchenko/TS/github/pi/packages/coding-agent/src/config.ts` — `PI_CODING_AGENT_DIR`
