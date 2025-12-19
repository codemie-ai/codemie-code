/**
 * Provider-Agent Compatibility System
 *
 * Centralized compatibility checking based on provider declarations.
 * Implements unidirectional dependency: Provider → Agent
 *
 * Key Principle: Providers declare which agents they support.
 * Agents don't need to know about providers at all.
 */

import { ProviderTemplate } from '../../providers/core/types.js';
import { ProviderRegistry } from '../../providers/core/registry.js';

/**
 * Check if a provider supports a specific agent (simple name matching)
 *
 * @param agentName - Agent name to check (e.g., 'claude', 'codex')
 * @param provider - Provider template
 * @returns true if provider supports the agent
 *
 * @example
 * ```typescript
 * const ssoProvider = ProviderRegistry.getProvider('ai-run-sso');
 * const isCompatible = isProviderCompatible('claude', ssoProvider);
 * ```
 */
export function isProviderCompatible(
  agentName: string,
  provider: ProviderTemplate
): boolean {
  // No supportedAgents = supports all agents by default
  if (!provider.supportedAgents || provider.supportedAgents.length === 0) {
    // Check explicit exclusions
    return !provider.unsupportedAgents?.includes(agentName);
  }

  // Wildcard '*' = supports all agents
  if (provider.supportedAgents.includes('*')) {
    // But still respect explicit exclusions
    return !provider.unsupportedAgents?.includes(agentName);
  }

  // Explicit list - check if agent is included
  const isSupported = provider.supportedAgents.includes(agentName);

  // Explicit exclusions take precedence
  if (provider.unsupportedAgents?.includes(agentName)) {
    return false;
  }

  return isSupported;
}

/**
 * Get all providers that support a specific agent
 *
 * @param agentName - Agent name to check
 * @returns Array of compatible provider templates
 *
 * @example
 * ```typescript
 * const compatibleProviders = getCompatibleProviders('claude');
 * // Returns: [SSOTemplate, LiteLLMTemplate, BedrockTemplate]
 * ```
 */
export function getCompatibleProviders(
  agentName: string
): ProviderTemplate[] {
  const allProviders = ProviderRegistry.getAllProviders();
  return allProviders.filter(provider =>
    isProviderCompatible(agentName, provider)
  );
}

/**
 * Get human-readable incompatibility reason
 *
 * @param agentName - Agent name to check
 * @param provider - Provider template
 * @returns Error message if incompatible, null if compatible
 *
 * @example
 * ```typescript
 * const reason = getIncompatibilityReason('claude', ollamaProvider);
 * // Returns: "Provider 'Ollama' only supports: ['*'] (claude is explicitly excluded)"
 * ```
 */
export function getIncompatibilityReason(
  agentName: string,
  provider: ProviderTemplate
): string | null {
  if (isProviderCompatible(agentName, provider)) {
    return null; // Compatible
  }

  // Check explicit exclusions first
  if (provider.unsupportedAgents?.includes(agentName)) {
    return `Provider '${provider.displayName}' explicitly does not support agent '${agentName}'`;
  }

  // No supportedAgents = should be compatible (this shouldn't happen)
  if (!provider.supportedAgents || provider.supportedAgents.length === 0) {
    return `Provider '${provider.displayName}' has no agent restrictions but somehow rejected '${agentName}'`;
  }

  // Explicit list - agent not included
  return `Provider '${provider.displayName}' only supports: ${provider.supportedAgents.join(', ')}`;
}

/**
 * Validate provider-agent compatibility and throw descriptive error if incompatible
 *
 * @param agentName - Agent name to check
 * @param providerName - Provider name to check
 * @throws Error with actionable message if incompatible
 *
 * @example
 * ```typescript
 * validateCompatibility('claude', 'ollama');
 * // Throws: Error with provider compatibility details
 * ```
 */
export function validateCompatibility(
  agentName: string,
  providerName: string
): void {
  const provider = ProviderRegistry.getProvider(providerName);

  if (!provider) {
    throw new Error(
      `Provider '${providerName}' not found. Available providers: ${
        ProviderRegistry.getAllProviders().map(p => p.name).join(', ')
      }`
    );
  }

  const reason = getIncompatibilityReason(agentName, provider);
  if (reason) {
    const compatibleProviders = getCompatibleProviders(agentName);
    const suggestions = compatibleProviders.length > 0
      ? `\n\nCompatible providers for '${agentName}':\n${compatibleProviders.map(p => `  - ${p.displayName} (${p.name})`).join('\n')}`
      : '';

    throw new Error(`${reason}${suggestions}`);
  }
}
