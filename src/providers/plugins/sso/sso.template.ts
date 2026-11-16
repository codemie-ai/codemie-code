/**
 * SSO Provider Template
 *
 * Template definition for AI-Run SSO (CodeMie SSO) provider.
 * Enterprise SSO authentication with centralized model management.
 *
 * Auto-registers on import via registerProvider().
 */

import type { ProviderTemplate } from '../../core/types.js';
import { AuthMethod } from '../../core/types.js';
import { registerProvider } from '../../core/index.js';
import { defaultAgentHooks } from '../../core/default-agent-hooks.js';
import { DEFAULT_CODEMIE_BASE_URL } from '../../core/codemie-auth-helpers.js';
import { resolveJwtToken } from '../jwt/jwt.utils.js';

/**
 * Claude Code values for the CodeMie SSO gateway (applied only where the user's shell leaves them
 * unset; Claude's own defaults are the gateway-safe ones).
 *
 * - Tool search on, betas allowed: the local CodeMie proxy forwards every request header except
 *   `host`/`connection` (sso.proxy.ts), so the `tool-search-tool-2025-10-19` beta header,
 *   `defer_loading` and `tool_reference` round-trip; verified end to end (44,396 -> 24,353
 *   turn-one tokens). Claude Code would otherwise turn tool search off by itself, because
 *   ANTHROPIC_BASE_URL is not a first-party host.
 * - Auto-mode server review off: the gateway reaches LiteLLM's unified `/v1/messages`, which drops
 *   `safeguards` before v1.99.3 and never returns `safeguard_results` from `bedrock_converse`
 *   deployments, so Claude Code would fall back to its own (billed) classifier requests behind an
 *   "isn't eligible" notice. https://code.claude.com/docs/en/auto-mode-classifier-billing
 */
const SSO_CLAUDE_ENV = {
  ENABLE_TOOL_SEARCH: 'true',
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '0',
  CLAUDE_CODE_AUTO_MODE_SERVER: '0',
} as const;

export const SSOTemplate = registerProvider<ProviderTemplate>({
  name: 'ai-run-sso',
  displayName: 'CodeMie SSO',
  description: 'Enterprise SSO Authentication with centralized model management',
  defaultBaseUrl: DEFAULT_CODEMIE_BASE_URL,
  requiresAuth: true,
  authType: 'sso',
  priority: 0, // Highest priority (shown first)
  defaultProfileName: 'codemie-sso',
  recommendedModels: [
    'claude-sonnet-4-6',
  ],
  capabilities: ['streaming', 'tools', 'sso-auth', 'function-calling', 'embeddings'],
  supportsModelInstallation: false,
  supportsStreaming: true,
  customProperties: {
    requiresIntegration: true,
    // Each global profile owns a CodeMie project (EPMCDME-15411)
    carriesCodeMieProject: true,
    sessionDuration: 86400000 // 24 hours
  },

  // Environment Variable Export
  exportEnvVars: (config) => {
    const env: Record<string, string> = {};

    // SSO-specific environment variables
    if (config.codeMieUrl) env.CODEMIE_URL = config.codeMieUrl;
    if (config.codeMieProject) env.CODEMIE_PROJECT = config.codeMieProject;
    if (config.authMethod) env.CODEMIE_AUTH_METHOD = config.authMethod;

    // Export JWT token when auth method is JWT
    if (config.authMethod === AuthMethod.JWT) {
      const token = resolveJwtToken(config);
      if (token) env.CODEMIE_JWT_TOKEN = token;
    }

    // Only export integration ID if integration is configured
    if (config.codeMieIntegration?.id) {
      env.CODEMIE_INTEGRATION_ID = config.codeMieIntegration.id;
    }

    return env;
  },

  agentHooks: {
    ...defaultAgentHooks,
    claude: { ...defaultAgentHooks?.claude, env: SSO_CLAUDE_ENV },
    'claude-acp': { ...defaultAgentHooks?.['claude-acp'], env: SSO_CLAUDE_ENV },
  }
});
