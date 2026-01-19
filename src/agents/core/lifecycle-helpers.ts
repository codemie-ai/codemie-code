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
// CRITICAL: Import providers/index to trigger plugin auto-registration
// Provider plugins register themselves on import via registerProvider() decorator
import '../../providers/index.js';
import { ProviderRegistry } from '../../providers/core/registry.js';

/**
 * Resolve the appropriate hook based on provider with automatic chaining
 *
 * Execution order (chain of responsibility):
 * 1. Provider plugin's wildcard hook ('*' for all agents) - runs first
 * 2. Provider plugin's agent-specific hook - runs second (on top of wildcard result)
 * 3. Agent's default hook (fallback if no provider hooks exist)
 *
 * When both wildcard and agent-specific hooks exist, they are automatically chained:
 * - Wildcard hook executes first, transforms env
 * - Agent-specific hook executes second, receives wildcard's result
 * - Final env is returned
 *
 * @param lifecycle - Agent lifecycle configuration
 * @param hookName - Name of the hook to resolve
 * @param provider - Current provider name
 * @param agentName - Current agent name
 * @returns Resolved/composed hook function or undefined
 */
async function resolveHook<K extends keyof ProviderLifecycleHooks>(
  lifecycle: AgentLifecycle | undefined,
  hookName: K,
  provider: string | undefined,
  agentName: string | undefined
): Promise<ProviderLifecycleHooks[K] | undefined> {
  // 1. Try provider plugin's hooks (wildcard + agent-specific)
  if (provider && agentName) {
    const providerPlugin = ProviderRegistry.getProvider(provider);

    const wildcardHook = providerPlugin?.agentHooks?.['*']?.[hookName];
    const specificHook = providerPlugin?.agentHooks?.[agentName]?.[hookName];

    // Chain hooks: wildcard first, then agent-specific
    if (wildcardHook && specificHook) {
      // Both hooks exist - chain them
      return (async (...args: any[]) => {
        // Execute wildcard hook first
        const intermediateResult = await (wildcardHook as any)(...args);
        // Execute agent-specific hook with wildcard's result
        // For beforeRun: args[0] is env, so replace it with intermediate result
        const finalArgs = [...args];
        finalArgs[0] = intermediateResult;
        return await (specificHook as any)(...finalArgs);
      }) as ProviderLifecycleHooks[K];
    }

    // Only agent-specific hook exists
    if (specificHook) {
      return specificHook as ProviderLifecycleHooks[K];
    }

    // Only wildcard hook exists - chain with agent's default hook if available
    if (wildcardHook) {
      const agentDefaultHook = lifecycle?.[hookName];

      // If agent has a default hook, chain wildcard → agent default
      if (agentDefaultHook) {
        return (async function(this: any, ...args: any[]) {
          // Execute wildcard hook first (provider customization)
          const intermediateResult = await (wildcardHook as any).call(this, ...args);
          // Execute agent's default hook with wildcard's result
          // Replace first arg (env) with intermediate result
          const finalArgs = [...args];
          finalArgs[0] = intermediateResult;
          return await (agentDefaultHook as any).call(this, ...finalArgs);
        }) as ProviderLifecycleHooks[K];
      }

      // No agent default hook, just return wildcard
      return wildcardHook as ProviderLifecycleHooks[K];
    }
  }

  // 2. Fall back to agent's default hook (no provider hooks)
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

  const hook = await resolveHook(lifecycle, 'onSessionStart', provider, agentName);

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
  const hook = await resolveHook(lifecycle, 'beforeRun', provider, agentName);

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
export async function executeEnrichArgs(
  lifecycle: AgentLifecycle | undefined,
  agentName: string,
  args: string[],
  config: AgentConfig
): Promise<string[]> {
  const provider = config.provider;
  const hook = await resolveHook(lifecycle, 'enrichArgs', provider, agentName);

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

  const hook = await resolveHook(lifecycle, 'onSessionEnd', provider, agentName);

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
  const hook = await resolveHook(lifecycle, 'afterRun', provider, agentName);

  if (hook) {
    await hook.call(context, exitCode, env);
  }
}
