/**
 * Default agent lifecycle hooks shared by all CodeMie providers.
 *
 * Installs the agent extension before each run and injects --plugin-dir
 * for Claude Code. Any provider template can spread these hooks rather
 * than duplicating the logic.
 */

import type { AgentConfig } from '@/agents/core/types.js';
import type { ProviderTemplate } from '@/providers/core/types.js';

export const defaultAgentHooks: ProviderTemplate['agentHooks'] = {
  '*': {
    async beforeRun(env: NodeJS.ProcessEnv, config: AgentConfig): Promise<NodeJS.ProcessEnv> {
      const agentName = config.agent;
      if (!agentName) return env;

      // Dynamic import avoids circular dependency — AgentRegistry loads all plugins
      // including provider templates, so top-level import would cause a cycle.
      const { AgentRegistry } = await import('@/agents/registry.js');
      const agent = AgentRegistry.getAgent(agentName);
      if (!agent) return env;

      const installer = (agent as any).getExtensionInstaller?.();
      if (!installer) return env;

      try {
        const result = await installer.install();
        env[`CODEMIE_${agentName.toUpperCase()}_EXTENSION_DIR`] = result.targetPath;

        if (!result.success) {
          const { logger } = await import('@/utils/logger.js');
          logger.warn(`[${agentName}] Extension installation returned failure: ${result.error || 'unknown error'}`);
          logger.warn(`[${agentName}] Continuing without extension - hooks may not be available`);
        }
      } catch (error) {
        const { logger } = await import('@/utils/logger.js');
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error(`[${agentName}] Extension installation threw exception: ${errorMsg}`);
        logger.warn(`[${agentName}] Continuing without extension - hooks may not be available`);
      }

      return env;
    }
  },

  'claude': {
    enrichArgs(args: string[], _config: AgentConfig): string[] {
      const pluginDir = process.env.CODEMIE_CLAUDE_EXTENSION_DIR;
      if (!pluginDir) return args;
      if (args.some(arg => arg === '--plugin-dir')) return args;
      return ['--plugin-dir', pluginDir, ...args];
    }
  }
};
