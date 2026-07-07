/**
 * Default agent lifecycle hooks shared by all CodeMie providers.
 *
 * Installs the agent extension before each run and injects --plugin-dir
 * for Claude Code. Any provider template can spread these hooks rather
 * than duplicating the logic.
 */

import type { AgentConfig } from '@/agents/core/types.js';
import type { ProviderTemplate } from '@/providers/core/types.js';

interface WithExtensionInstaller {
  getExtensionInstaller?(): {
    install(): Promise<{ success: boolean; action?: string; targetPath: string; error?: string }>;
  };
}

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

      try {
        const installer = (agent as WithExtensionInstaller).getExtensionInstaller?.();
        if (!installer) return env;

        const result = await installer.install();
        if (result.success) {
          env[`CODEMIE_${agentName.toUpperCase()}_EXTENSION_DIR`] = result.targetPath;
        } else {
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
