/**
 * Azure OpenAI Provider Template
 *
 * Template definition for Azure OpenAI.
 * Auto-registers on import via registerProvider().
 *
 * Key architecture notes for EPAM DIAL and standard Azure OpenAI:
 *
 * 1. AUTH HEADER: Azure OpenAI (including DIAL) uses `api-key: {key}` header,
 *    NOT `Authorization: Bearer {key}`. @ai-sdk/openai-compatible always sends
 *    the Bearer header when apiKey is set, so we pass apiKey='' and inject the
 *    correct header explicitly via `headers: { 'api-key': key }`.
 *
 * 2. URL ROUTING: Azure routes to a specific deployment via:
 *    /openai/deployments/{deployment}/chat/completions?api-version={ver}
 *    @ai-sdk/openai-compatible appends /chat/completions to baseURL, so
 *    baseURL must be: {endpoint}/openai/deployments/{deployment}/
 *
 * 3. Environment variable flow for Claude Code agent:
 *    Config → exportEnvVars → CODEMIE_AZURE_OPENAI_BASE_URL / CODEMIE_API_KEY / CODEMIE_MODEL
 *    BaseAgentAdapter.transformEnvVars → ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN (from envMapping)
 *    agentHooks['*'].beforeRun  → AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_VERSION, AZURE_OPENAI_DEPLOYMENT
 *    agentHooks['claude'].beforeRun → CLAUDE_CODE_USE_AZURE_OPENAI=1, delete ANTHROPIC_AUTH_TOKEN,
 *                                     AZURE_OPENAI_API_KEY=<key>, ANTHROPIC_MODEL=<deployment>
 *
 * 4. CACHE_CONTROL STRIPPING (DIAL/Azure): When CLAUDE_CODE_USE_AZURE_OPENAI=1,
 *    Claude Code bypasses the SSO proxy entirely and sends requests directly to
 *    the Azure/DIAL endpoint. This means proxy-level sanitizers (e.g.,
 *    ClaudeRequestNormalizerPlugin) are NOT applied.
 *
 *    DIAL and Azure OpenAI use the OpenAI Chat Completions spec and do NOT support
 *    Anthropic-native fields such as `cache_control` on messages or content items,
 *    `thinking`, or `betas` request headers. Claude Code in recent versions adds
 *    these fields when prompt caching and experimental betas are enabled.
 *
 *    To prevent HTTP 400 errors ("Extra inputs are not permitted on path
 *    messages.0.cache_control"), the claude hook MUST:
 *      - Set ENABLE_PROMPT_CACHING_1H=0    → prevents cache_control in messages
 *      - Set CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 → prevents beta HTTP headers
 *      - Set CLAUDE_CODE_DISABLE_THINKING=1 / MAX_THINKING_TOKENS=0
 *        → prevents `thinking` and follow-up `reasoning_content` blocks that
 *          DIAL rejects on later turns for Claude deployments
 *      - Set DISABLE_INTERLEAVED_THINKING=1
 *        → prevents interleaved-thinking beta behavior on gateway/provider
 *          combinations that do not preserve Anthropic semantics fully
 *        that some DIAL versions reject (e.g. anthropic-beta: prompt-caching-2024-07-31)
 *
 *    NOTE: The agent default lifecycle.beforeRun (claude.plugin.ts) is NOT executed
 *    when a provider supplies BOTH a wildcard (*) AND agent-specific (claude) hook,
 *    because lifecycle-helpers.ts chains those two provider hooks and skips the
 *    agent default. All essential Claude Code defaults must therefore be re-applied
 *    here explicitly.
 */

import type { ProviderTemplate } from '../../core/types.js';
import { registerProvider } from '../../core/decorators.js';

const DEFAULT_AZURE_API_VERSION = '2024-06-01';

export const AzureOpenAITemplate = registerProvider<ProviderTemplate>({
  name: 'azure-openai',
  displayName: 'Azure OpenAI',
  description: 'Microsoft Azure OpenAI Service — supports GPT-4, o-series and any deployed model',
  defaultBaseUrl: 'https://YOUR-RESOURCE-NAME.openai.azure.com',
  requiresAuth: true,
  authType: 'api-key',
  priority: 13,
  defaultProfileName: 'azure-openai',
  // Models are fetched dynamically from the Azure deployments API during setup.
  // These are shown only as a fallback when the API call fails.
  recommendedModels: ['gpt-4.1', 'gpt-4o', 'o3-mini'],
  capabilities: ['streaming', 'tools', 'function-calling', 'vision', 'json-mode'],
  supportsModelInstallation: false,
  supportsStreaming: true,

  // Export Azure-specific fields as CODEMIE_AZURE_OPENAI_* env vars.
  // The standard CODEMIE_BASE_URL / CODEMIE_API_KEY / CODEMIE_MODEL are set by
  // ConfigLoader.exportProviderEnvVars automatically from config.baseUrl / apiKey / model.
  exportEnvVars: (config) => {
    const env: Record<string, string> = {};

    // Mirror baseUrl into a dedicated Azure var so agent hooks can distinguish it
    // from the generic proxy URL that SSO providers put in CODEMIE_BASE_URL.
    if (config.baseUrl) env.CODEMIE_AZURE_OPENAI_BASE_URL = config.baseUrl;
    if (config.azureApiVersion) env.CODEMIE_AZURE_OPENAI_API_VERSION = config.azureApiVersion;
    // Deployment name (= model by default, may differ if user set azureDeployment explicitly)
    if (config.azureDeployment) env.CODEMIE_AZURE_OPENAI_DEPLOYMENT = config.azureDeployment;

    return env;
  },

  agentHooks: {
    // Wildcard hook: runs for ALL agents before the agent-specific hook.
    // Sets the standard Azure SDK env vars used by OpenAI-compatible clients.
    '*': {
      beforeRun: async (env) => {
        // Azure endpoint (prefer the dedicated var; fall back to generic base URL)
        const endpoint = env.CODEMIE_AZURE_OPENAI_BASE_URL || env.CODEMIE_BASE_URL;
        if (endpoint) {
          env.AZURE_OPENAI_ENDPOINT = endpoint;
        }

        // API version
        env.AZURE_OPENAI_API_VERSION =
          env.CODEMIE_AZURE_OPENAI_API_VERSION || DEFAULT_AZURE_API_VERSION;

        // Deployment name (falls back to model id — valid for most Azure setups
        // where the deployment name matches the base model name)
        env.AZURE_OPENAI_DEPLOYMENT =
          env.CODEMIE_AZURE_OPENAI_DEPLOYMENT || env.CODEMIE_MODEL || '';

        // Azure API key for generic SDK usage
        if (env.CODEMIE_API_KEY) {
          env.AZURE_OPENAI_API_KEY = env.CODEMIE_API_KEY;
        }

        return env;
      }
    },

    // Claude-specific hook: runs after the wildcard hook.
    // Switches Claude Code into Azure OpenAI mode.
    // See: https://docs.anthropic.com/en/docs/claude-code/azure-and-vertex
    'claude': {
      beforeRun: async (env) => {
        // Signal Claude Code to use Azure OpenAI instead of the Anthropic API.
        env.CLAUDE_CODE_USE_AZURE_OPENAI = '1';
        
        // Claude Code in Azure mode reads ANTHROPIC_BASE_URL as the Azure endpoint.
        // (BaseAgentAdapter.transformEnvVars already mapped CODEMIE_BASE_URL → ANTHROPIC_BASE_URL;
        //  here we ensure it points to the Azure endpoint, not a potential proxy URL.)
        const endpoint = env.CODEMIE_AZURE_OPENAI_BASE_URL || env.CODEMIE_BASE_URL;
        if (endpoint) {
          env.ANTHROPIC_BASE_URL = endpoint;
        }
        
        // CRITICAL: Claude Code in Azure mode authenticates via AZURE_OPENAI_API_KEY.
        // ANTHROPIC_AUTH_TOKEN was set by transformEnvVars (envMapping.apiKey) with the
        // Azure key, which would cause Claude Code to attempt Anthropic API auth → 401.
        delete env.ANTHROPIC_AUTH_TOKEN;
        
        // AZURE_OPENAI_API_KEY already set by the wildcard hook above; no duplication needed.
        
        // Model / deployment: Claude Code respects ANTHROPIC_MODEL for the active model.
        // In Azure/DIAL, model == deployment name.
        if (env.CODEMIE_MODEL) {
          env.ANTHROPIC_MODEL = env.CODEMIE_MODEL;

          // Keep internal/background model selection on the same deployment.
          // This avoids hidden switches to Anthropic defaults that do not exist
          // on a DIAL gateway or under a custom deployment naming scheme.
          if (!env.ANTHROPIC_DEFAULT_HAIKU_MODEL) {
            env.ANTHROPIC_DEFAULT_HAIKU_MODEL = env.CODEMIE_MODEL;
          }
          if (!env.ANTHROPIC_DEFAULT_SONNET_MODEL) {
            env.ANTHROPIC_DEFAULT_SONNET_MODEL = env.CODEMIE_MODEL;
          }
          if (!env.ANTHROPIC_DEFAULT_OPUS_MODEL) {
            env.ANTHROPIC_DEFAULT_OPUS_MODEL = env.CODEMIE_MODEL;
          }
          if (!env.ANTHROPIC_DEFAULT_FABLE_MODEL) {
            env.ANTHROPIC_DEFAULT_FABLE_MODEL = env.CODEMIE_MODEL;
          }
        }

        if (!env.CLAUDE_CODE_SUBAGENT_MODEL) {
          env.CLAUDE_CODE_SUBAGENT_MODEL = 'inherit';
        }
        
        // ----------------------------------------------------------------
        // DIAL/Azure compatibility: disable Anthropic-specific request fields
        // ----------------------------------------------------------------
        //
        // Claude Code in Azure mode sends requests DIRECTLY to the Azure/DIAL
        // endpoint — the SSO proxy (and its ClaudeRequestNormalizerPlugin) is
        // NOT in the path.  DIAL uses the OpenAI Chat Completions spec and
        // rejects Anthropic-native fields with HTTP 400:
        //
        //   • cache_control on messages / content items
        //     → added by Claude Code when ENABLE_PROMPT_CACHING_1H=1
        //     → DIAL error: "Extra inputs are not permitted on path messages.0.cache_control"
        //
        //   • anthropic-beta: prompt-caching-* request header
        //     → added when experimental betas are enabled
        //     → some DIAL gateway versions reject unknown beta headers
        //
        // Fix: explicitly disable both features for Azure/DIAL sessions.
        env.ENABLE_PROMPT_CACHING_1H = '0';
        env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1';

        // Azure/DIAL exposes an OpenAI-compatible endpoint, not Anthropic's
        // full Messages API surface.  Disable extended/interleaved thinking so
        // Claude Code does not emit `thinking` params or persist
        // `reasoning_content` blocks into follow-up messages.
        env.CLAUDE_CODE_DISABLE_THINKING = '1';
        env.MAX_THINKING_TOKENS = '0';
        env.DISABLE_INTERLEAVED_THINKING = '1';
        env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING = '1';
        
        // ----------------------------------------------------------------
        // Re-apply essential Claude Code defaults that are normally set by
        // the agent's lifecycle.beforeRun (claude.plugin.ts).  That hook is
        // NOT executed when the provider supplies both a wildcard (*) and an
        // agent-specific (claude) hook — lifecycle-helpers.ts chains only
        // the two provider hooks and skips the agent default entirely.
        // ----------------------------------------------------------------
        if (!env.CLAUDE_CODE_ENABLE_TELEMETRY) {
          env.CLAUDE_CODE_ENABLE_TELEMETRY = '0';
        }
        if (!env.DISABLE_AUTOUPDATER) {
          env.DISABLE_AUTOUPDATER = '1';
        }
        if (!env.ENABLE_TOOL_SEARCH) {
          env.ENABLE_TOOL_SEARCH = '0';
        }
        if (!env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE) {
          let autocompactPct = 80;
          if (env.CODEMIE_PROFILE_CONFIG) {
            try {
              const profileConfig = JSON.parse(env.CODEMIE_PROFILE_CONFIG);
              if (typeof profileConfig.claudeAutocompactPct === 'number') {
                autocompactPct = profileConfig.claudeAutocompactPct;
              }
            } catch {
              // ignore malformed profile config
            }
          }
          env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(autocompactPct);
        }
        
        return env;
      }
    }
  },

  setupInstructions: `
# Azure OpenAI Setup Instructions

## Prerequisites

1. Azure subscription with Azure OpenAI access
2. An Azure OpenAI resource
3. At least one deployed model in Azure OpenAI Studio

## Required Settings

- **Endpoint**: https://<resource-name>.openai.azure.com
- **API Key**: Azure OpenAI key
- **API Version**: 2024-06-01 or newer
- **Deployment Name**: Azure deployment identifier

## Using CodeMie with Azure OpenAI

\`\`\`bash
codemie setup
# Select "Azure OpenAI" as provider
\`\`\`

## Documentation

- Azure OpenAI: https://learn.microsoft.com/azure/ai-services/openai/
- Quotas and limits: https://learn.microsoft.com/azure/ai-services/openai/quotas-limits
`
});
