/**
 * Lifecycle Hook Execution Helpers
 *
 * Provides utilities for executing agent lifecycle hooks with provider-specific resolution.
 * This replaces the template method pattern with a more flexible hook-based approach.
 *
 * Hook Resolution Priority (Loose Coupling):
 * 1. Provider plugin's agent hooks (providerPlugin.agentHooks[agentName].hookName)
 * 2. Agent's default hooks (agentMetadata.lifecycle.hookName)
 *
 * Key Architecture Principle:
 * - Agents remain FULLY provider-agnostic
 * - Providers register hooks for agents they need to customize
 * - Runtime resolution provides dynamic behavior
 * - Zero hardcoded provider names in agent code
 *
 * @example Provider registers hooks for agent (loose coupling)
 * ```typescript
 * // Provider plugin (src/providers/plugins/bedrock/)
 * export const BedrockTemplate: ProviderTemplate = {
 *   name: 'bedrock',
 *   agentHooks: {
 *     'claude': {
 *       beforeRun: async (env, config) => {
 *         env.CLAUDE_CODE_USE_BEDROCK = '1';
 *         return env;
 *       }
 *     }
 *   }
 * };
 *
 * // Agent plugin (src/agents/plugins/claude.plugin.ts)
 * export const ClaudeMetadata: AgentMetadata = {
 *   lifecycle: {
 *     // ONLY default hooks - no provider knowledge!
 *     beforeRun: async (env) => {
 *       env.CLAUDE_CODE_DISABLE_BETAS = '1';
 *       return env;
 *     }
 *   }
 * };
 * ```
 */

import type { AgentLifecycle, AgentConfig, ProviderLifecycleHooks } from './types.js';
import { ProviderRegistry } from '../../providers/core/registry.js';

/**
 * Resolve the appropriate hook based on provider
 *
 * Priority (loose coupling):
 * 1. Provider plugin's agent-specific hook (provider owns the logic)
 * 2. Provider plugin's wildcard hook ('*' for all agents)
 * 3. Agent's default hook (fallback)
 *
 * @param lifecycle - Agent lifecycle configuration
 * @param hookName - Name of the hook to resolve
 * @param provider - Current provider name
 * @param agentName - Current agent name
 * @returns Resolved hook function or undefined
 */
function resolveHook<K extends keyof ProviderLifecycleHooks>(
  lifecycle: AgentLifecycle | undefined,
  hookName: K,
  provider: string | undefined,
  agentName: string | undefined
): ProviderLifecycleHooks[K] | undefined {
  // 1. Try provider plugin's agent hook (provider owns the customization)
  if (provider && agentName) {
    const providerPlugin = ProviderRegistry.getProvider(provider);

    // 1a. Check agent-specific hook first
    const specificHook = providerPlugin?.agentHooks?.[agentName]?.[hookName];
    if (specificHook) {
      return specificHook as ProviderLifecycleHooks[K];
    }

    // 1b. Check wildcard hook ('*' for all agents)
    const wildcardHook = providerPlugin?.agentHooks?.['*']?.[hookName];
    if (wildcardHook) {
      return wildcardHook as ProviderLifecycleHooks[K];
    }
  }

  // 2. Fall back to agent's default hook
  if (!lifecycle) return undefined;
  return lifecycle[hookName];
}

/**
 * Execute onSessionStart hook with provider resolution
 *
 * Called early in the session lifecycle, before environment transformation.
 * Use for early initialization, session registration, or pre-setup tasks.
 *
 * @param context - The agent adapter instance (for binding `this`)
 * @param lifecycle - Agent lifecycle configuration
 * @param agentName - Agent name (for provider hook resolution)
 * @param sessionId - Unique session identifier
 * @param env - Environment variables
 */
export async function executeOnSessionStart(
  context: any,
  lifecycle: AgentLifecycle | undefined,
  agentName: string,
  sessionId: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const provider = env.CODEMIE_PROVIDER;
  const { logger } = await import('../../utils/logger.js');

  logger.info(`[lifecycle-helpers] Resolving onSessionStart hook for agent="${agentName}", provider="${provider}"`);

  const hook = resolveHook(lifecycle, 'onSessionStart', provider, agentName);

  if (hook) {
    logger.info(`[lifecycle-helpers] onSessionStart hook found, executing...`);
    await hook.call(context, sessionId, env);
  } else {
    logger.info(`[lifecycle-helpers] No onSessionStart hook found`);
  }
}

/**
 * Execute beforeRun hook with provider resolution
 *
 * Called after environment transformation, before agent execution.
 * Use for config file setup, directory creation, or environment modification.
 *
 * @param context - The agent adapter instance (for binding `this`)
 * @param lifecycle - Agent lifecycle configuration
 * @param agentName - Agent name (for provider hook resolution)
 * @param env - Environment variables
 * @param config - Agent configuration
 * @returns Modified environment variables
 */
export async function executeBeforeRun(
  context: any,
  lifecycle: AgentLifecycle | undefined,
  agentName: string,
  env: NodeJS.ProcessEnv,
  config: AgentConfig
): Promise<NodeJS.ProcessEnv> {
  const provider = env.CODEMIE_PROVIDER;
  const hook = resolveHook(lifecycle, 'beforeRun', provider, agentName);

  if (hook) {
    return await hook.call(context, env, config);
  }

  return env;
}

/**
 * Execute enrichArgs hook with provider resolution
 *
 * Called after beforeRun, before flag transformations.
 * Use for injecting CLI arguments like --profile, --model, etc.
 *
 * @param lifecycle - Agent lifecycle configuration
 * @param agentName - Agent name (for provider hook resolution)
 * @param args - CLI arguments
 * @param config - Agent configuration
 * @returns Enriched arguments
 */
export function executeEnrichArgs(
  lifecycle: AgentLifecycle | undefined,
  agentName: string,
  args: string[],
  config: AgentConfig
): string[] {
  const provider = config.provider;
  const hook = resolveHook(lifecycle, 'enrichArgs', provider, agentName);

  if (hook) {
    return hook(args, config);
  }

  return args;
}

/**
 * Execute onSessionEnd hook with provider resolution
 *
 * Called after agent exits, before afterRun hook.
 * Use for session cleanup, telemetry, or metrics finalization.
 *
 * @param context - The agent adapter instance (for binding `this`)
 * @param lifecycle - Agent lifecycle configuration
 * @param agentName - Agent name (for provider hook resolution)
 * @param exitCode - Process exit code
 * @param env - Environment variables
 */
export async function executeOnSessionEnd(
  context: any,
  lifecycle: AgentLifecycle | undefined,
  agentName: string,
  exitCode: number,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const provider = env.CODEMIE_PROVIDER;
  const { logger } = await import('../../utils/logger.js');

  logger.info(`[lifecycle-helpers] Resolving onSessionEnd hook for agent="${agentName}", provider="${provider}", exitCode=${exitCode}`);

  const hook = resolveHook(lifecycle, 'onSessionEnd', provider, agentName);

  if (hook) {
    logger.info(`[lifecycle-helpers] onSessionEnd hook found, executing...`);
    await hook.call(context, exitCode, env);
  } else {
    logger.info(`[lifecycle-helpers] No onSessionEnd hook found`);
  }
}

/**
 * Execute afterRun hook with provider resolution
 *
 * Called after onSessionEnd, at the very end of the session lifecycle.
 * Use for final cleanup, config file removal, or post-processing.
 *
 * @param context - The agent adapter instance (for binding `this`)
 * @param lifecycle - Agent lifecycle configuration
 * @param agentName - Agent name (for provider hook resolution)
 * @param exitCode - Process exit code
 * @param env - Environment variables
 */
export async function executeAfterRun(
  context: any,
  lifecycle: AgentLifecycle | undefined,
  agentName: string,
  exitCode: number,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const provider = env.CODEMIE_PROVIDER;
  const hook = resolveHook(lifecycle, 'afterRun', provider, agentName);

  if (hook) {
    await hook.call(context, exitCode, env);
  }
}
