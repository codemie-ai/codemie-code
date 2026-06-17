# Moonshot API Provider Design

**Date:** 2026-06-15  
**Status:** Approved for implementation  
**Author:** Kimi Code (brainstorming session)  
**Related docs:** https://platform.kimi.ai/docs/guide/agent-support

## 1. Goal

Add a new CodeMie provider, `moonshot-api`, that lets users store a Moonshot API key in a profile and run both `codemie-claude` and `codemie-opencode` against Moonshot models. The provider follows the Kimi platform guide for using `kimi-k2.7-code` with Claude Code, while also supporting OpenCode via Moonshot's OpenAI-compatible endpoint.

## 2. Background

The repository already contains a `moonshot-subscription` provider. That provider relies on the native `kimi` CLI being authenticated with a Moonshot subscription and does **not** store an API key. It is intended only for the `kimi` agent.

This design adds a separate, API-key-based provider for users who want to use Moonshot with Claude Code or OpenCode. It stores the API key in the CodeMie profile (the same way the existing `litellm` provider does) and injects the correct runtime configuration for each supported agent.

## 3. Scope

### In scope

- New provider plugin `moonshot-api`.
- Interactive setup wizard (`codemie setup`) that prompts for:
  - Moonshot API key
  - Optional CodeMie analytics URL/project
- API key validation via Moonshot's `/v1/models` endpoint.
- Runtime environment/config injection for:
  - `codemie-claude` via Anthropic-compatible env vars.
  - `codemie-opencode` via OpenAI-compatible inline config.
- Provider registration and agent compatibility updates.
- Unit tests for setup steps and env injection.

### Out of scope

- Support for agents other than `claude` and `opencode`.
- Secure credential store migration for API keys (follows existing profile-based pattern).
- New CLI commands beyond the existing setup flow.

## 4. Architecture

### 4.1 New files

```
src/providers/plugins/moonshot-api/
├── index.ts                                    # Re-exports + auto-registration
├── moonshot-api.template.ts                    # ProviderTemplate
├── moonshot-api.setup-steps.ts                 # ProviderSetupSteps
└── __tests__/
    ├── moonshot-api.setup-steps.test.ts
    └── moonshot-api.template.test.ts
```

### 4.2 Modified files

- `src/providers/index.ts` — import and re-export the new plugin.
- `src/agents/plugins/claude/claude.plugin.ts` — add `'moonshot-api'` to `supportedProviders`.
- `src/agents/plugins/opencode/opencode.plugin.ts` — add `'moonshot-api'` to `supportedProviders`.

### 4.3 Provider template

```typescript
{
  name: 'moonshot-api',
  displayName: 'Moonshot API',
  description: 'Moonshot API key access for Claude Code and OpenCode',
  defaultBaseUrl: 'https://api.moonshot.ai/v1',
  requiresAuth: true,
  authType: 'api-key',
  priority: 15,
  defaultProfileName: 'moonshot-api',
  recommendedModels: ['kimi-k2.7-code'],
  capabilities: ['streaming', 'tools', 'function-calling', 'vision'],
  supportsModelInstallation: false,
  supportsStreaming: true,
  agentHooks: { /* claude + opencode */ },
  exportEnvVars: (config) => { /* analytics vars */ },
  setupInstructions: '...'
}
```

## 5. Setup Flow

The `ProviderSetupSteps` implementation:

1. Prompts for the Moonshot API key using `inquirer` password input.
2. Optionally prompts for CodeMie analytics URL and project, reusing `promptForCodeMieUrl` and `selectCodeMieProject` from `src/providers/core/codemie-auth-helpers.ts`.
3. Calls `GET https://api.moonshot.ai/v1/models` with `Authorization: Bearer <key>`.
   - On `401`/`403`: throws `ConfigurationError('Invalid Moonshot API key...')`.
   - On network failure: logs a warning and falls back to `recommendedModels`.
   - On success: returns the model list (or falls back if `kimi-k2.7-code` is missing).
4. Builds the profile config:

```typescript
{
  provider: 'moonshot-api',
  baseUrl: 'https://api.moonshot.ai/v1',
  apiKey: '<key>',
  model: 'kimi-k2.7-code',
  authMethod: 'api-key',
  codeMieUrl?: '<analytics-url>',
  codeMieProject?: '<project-name>'
}
```

## 6. Data Flow

### 6.1 Profile to generic env vars

`ConfigLoader.exportProviderEnvVars(config)` emits:

- `CODEMIE_PROVIDER=moonshot-api`
- `CODEMIE_BASE_URL=https://api.moonshot.ai/v1`
- `CODEMIE_API_KEY=<moonshot-key>`
- `CODEMIE_MODEL=kimi-k2.7-code`
- `CODEMIE_AUTH_METHOD=api-key`
- `CODEMIE_URL`, `CODEMIE_PROJECT`, `CODEMIE_SYNC_API_URL` when analytics is enabled.

### 6.2 Claude Code

The `moonshot-api` provider's `agentHooks.claude.beforeRun` overrides the base URL and sets the exact env vars from the Kimi guide:

- `ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic`
- `ANTHROPIC_AUTH_TOKEN=<moonshot-key>`
- `ANTHROPIC_MODEL=kimi-k2.7-code`
- `ANTHROPIC_DEFAULT_OPUS_MODEL=kimi-k2.7-code`
- `ANTHROPIC_DEFAULT_SONNET_MODEL=kimi-k2.7-code`
- `ANTHROPIC_DEFAULT_HAIKU_MODEL=kimi-k2.7-code`
- `CLAUDE_CODE_SUBAGENT_MODEL=kimi-k2.7-code`
- `ENABLE_TOOL_SEARCH=false`
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW=262144`

### 6.3 OpenCode

The `moonshot-api` provider's `agentHooks.opencode.beforeRun` detects `config.provider === 'moonshot-api'` and injects an OpenAI-compatible provider block into OpenCode's config:

```json
{
  "enabled_providers": ["moonshot"],
  "provider": {
    "moonshot": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Moonshot",
      "options": {
        "baseURL": "https://api.moonshot.ai/v1/",
        "apiKey": "<moonshot-key>",
        "timeout": 600000
      },
      "models": {
        "kimi-k2.7-code": {
          "id": "kimi-k2.7-code",
          "name": "kimi-k2.7-code"
        }
      }
    }
  },
  "model": "moonshot/kimi-k2.7-code"
}
```

This JSON is written to `OPENCODE_CONFIG_CONTENT` (or `OPENCODE_CONFIG` temp file if it exceeds `MAX_ENV_SIZE`), reusing the existing OpenCode config-injection helpers.

## 7. Error Handling

| Scenario | Behavior |
|----------|----------|
| Invalid API key during setup | `ConfigurationError` with a link to the Moonshot API key console. |
| Network failure during setup | Warning log + fallback to `recommendedModels`; setup continues. |
| Missing API key at runtime | `AgentCLI` validation fails with "Run `codemie setup`" guidance. |
| Agent does not support provider | `AgentCLI.validateCompatibility()` rejects with supported-provider list. |
| Provider hook throws | Caught, logged, and re-thrown as `ConfigurationError`/`ToolExecutionError` with context. |

## 8. Security

- The API key is stored in the profile JSON at `~/.codemie/codemie-cli.config.json` or `.codemie/codemie-cli.config.json`, consistent with the existing `litellm` provider.
- The key is masked in debug logs using the existing masking logic in `BaseAgentAdapter`.
- No hardcoded credentials; users supply their own key.

## 9. Testing

### Unit tests

- `moonshot-api.setup-steps.test.ts`
  - Valid API key returns model list.
  - Invalid API key throws `ConfigurationError`.
  - Network failure falls back to recommended models.
  - `buildConfig()` produces the expected profile shape.
  - Optional analytics fields are included when enabled.

- `moonshot-api.template.test.ts`
  - `exportEnvVars()` emits analytics variables only when `codeMieUrl` is set.
  - `claude` hook sets all required Anthropic env vars.
  - `opencode` hook produces valid OpenCode config JSON.
  - Provider registration metadata is correct.

### Manual verification

- `codemie setup` creates a Moonshot API profile.
- `codemie-claude --profile <name>` runs against `kimi-k2.7-code` via Moonshot.
- `codemie-opencode --profile <name>` runs against `kimi-k2.7-code` via Moonshot.
- `codemie doctor` recognizes the provider.

## 10. Alternatives Considered

- **Two separate providers (`moonshot-anthropic` + `moonshot-openai`)**: Rejected because it forces users to set up Moonshot twice and duplicates validation/analytics logic.
- **Single provider with agent metadata owning translation**: Rejected because it leaks provider-specific endpoint knowledge into the agent layer, breaking the plugin architecture's separation of concerns.

## 11. Open Questions

None. All clarifying questions were resolved during the brainstorming session.
