/**
 * Azure OpenAI Provider Template
 *
 * Template definition for Azure OpenAI.
 * Auto-registers on import via registerProvider().
 *
 * Key architecture notes for Azure OpenAI:
 *
 * 1. AUTH HEADER: Azure OpenAI uses `api-key: {key}` header,
 *    NOT `Authorization: Bearer {key}`. @ai-sdk/openai-compatible always sends
 *    the Bearer header when apiKey is set, so we pass apiKey='' and inject the
 *    correct header explicitly via `headers: { 'api-key': key }`.
 *
 * 2. URL ROUTING: Azure routes to a specific deployment via:
 *    /openai/deployments/{deployment}/chat/completions?api-version={ver}
 *    @ai-sdk/openai-compatible appends /chat/completions to baseURL, so
 *    baseURL must be: {endpoint}/openai/deployments/{deployment}/
 *
 * 3. Environment variable flow for generic OpenAI-compatible clients:
 *    Config → exportEnvVars → CODEMIE_AZURE_OPENAI_BASE_URL / CODEMIE_API_KEY / CODEMIE_MODEL
 *    agentHooks['*'].beforeRun → AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_VERSION,
 *                                AZURE_OPENAI_DEPLOYMENT and AZURE_OPENAI_API_KEY
 *
 * 4. Protocol scope: Claude Code/ACP, Codex and Gemini are intentionally excluded
 *    from direct Azure provider metadata. Azure-backed runs for those clients should
 *    use an external LiteLLM gateway for protocol conversion.
 */

import type { ProviderTemplate } from '../../core/types.js';
import { registerProvider } from '../../core/decorators.js';

const DEFAULT_AZURE_API_VERSION = '2025-04-01-preview';

export const AzureOpenAITemplate = registerProvider<ProviderTemplate>({
  name: 'azure-openai',
  displayName: 'Azure OpenAI',
  description: 'Microsoft Azure — Chat Completions API access to available deployments',
  defaultBaseUrl: 'https://YOUR-RESOURCE-NAME.openai.azure.com',
  requiresAuth: true,
  authType: 'api-key',
  priority: 13,
  defaultProfileName: 'azure-openai',
  // Models are fetched dynamically from the Azure deployments API during setup.
  // These are shown only as a fallback when the API call fails.
  recommendedModels: ['gpt-5.6-luna-2026-07-09'],
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
        // Azure endpoint; when proxy is active, use the local proxy URL.
        const endpoint = env.CODEMIE_PROXY_ACTIVE === '1'
          ? env.CODEMIE_BASE_URL
          : env.CODEMIE_AZURE_OPENAI_BASE_URL || env.CODEMIE_BASE_URL;
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
- **API Version**: 2025-04-01-preview (or another supported Azure API version)
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
