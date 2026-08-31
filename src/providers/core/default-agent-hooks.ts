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
      let enriched = args;

      const pluginDir = process.env.CODEMIE_CLAUDE_EXTENSION_DIR;
      if (pluginDir && !enriched.some(arg => arg === '--plugin-dir')) {
        enriched = ['--plugin-dir', pluginDir, ...enriched];
      }

      // Claude Code ignores ANTHROPIC_MODEL. Its precedence is
      // `--model` > settings.json `model` > its own default tier, so mapping the
      // profile's model onto ANTHROPIC_MODEL alone (claude.plugin.ts envMapping)
      // never reaches the wire: a developer with `"model"` pinned in
      // ~/.claude/settings.json silently ran every session on that model, and one
      // without it silently ran on the default (opus) tier — in both cases
      // ignoring the model chosen in `codemie setup`.
      //
      // Empty is meaningful and must not be forwarded: anthropic-subscription
      // deliberately blanks CODEMIE_MODEL so the Claude CLI applies its own
      // defaults (anthropic-subscription.template.ts).
      const model = process.env.CODEMIE_MODEL?.trim();
      const hasModelFlag = enriched.some(arg => arg === '--model' || arg.startsWith('--model='));
      if (model && !hasModelFlag) {
        enriched = ['--model', model, ...enriched];
      }

      return enriched;
    }
  }
};
