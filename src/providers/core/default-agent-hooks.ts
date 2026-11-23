/**
 * Default agent lifecycle hooks shared by all CodeMie providers.
 *
 * Installs the agent extension before each run and injects --plugin-dir
 * for Claude Code. Any provider template can spread these hooks rather
 * than duplicating the logic.
 */

import { resolve } from 'node:path';
import type { AgentConfig } from '@/agents/core/types.js';
import type { ProviderTemplate } from '@/providers/core/types.js';

interface WithExtensionInstaller {
  getExtensionInstaller?(): {
    install(): Promise<{ success: boolean; action?: string; targetPath: string; error?: string }>;
  };
}

/**
 * Prepend the CodeMie extension as a `--plugin-dir` unless the user already passed that
 * exact directory. Claude's `--plugin-dir` is repeatable, so user plugins must not suppress it.
 * Scanning stops at `--` (everything after is positional prompt text).
 */
export function withExtensionPluginDir(args: string[], pluginDir: string | undefined): string[] {
  if (!pluginDir) return args;

  const target = resolve(pluginDir);
  const end = args.indexOf('--');
  const scoped = end === -1 ? args : args.slice(0, end);
  const alreadyPassed = scoped.some((arg, i) => {
    const value = arg === '--plugin-dir' ? scoped[i + 1]
      : arg.startsWith('--plugin-dir=') ? arg.slice('--plugin-dir='.length)
      : undefined;
    return value !== undefined && resolve(value) === target;
  });

  return alreadyPassed ? args : ['--plugin-dir', pluginDir, ...args];
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
      let enriched = withExtensionPluginDir(args, process.env.CODEMIE_CLAUDE_EXTENSION_DIR);

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

      // Points the /model picker at the CodeMie catalog for this process only (see
      // claude.plugin.ts's beforeRun, which writes the temp file). Deliberately NOT written into
      // ~/.claude/settings.json: that file is shared by every concurrent Claude Code process on
      // the machine, and --settings layers on top of it without affecting any other session.
      const modelPickerSettings = process.env.CODEMIE_CLAUDE_MODEL_PICKER_SETTINGS;
      const hasSettingsFlag = enriched.some(arg => arg === '--settings' || arg.startsWith('--settings='));
      if (modelPickerSettings && !hasSettingsFlag) {
        enriched = ['--settings', modelPickerSettings, ...enriched];
      }

      return enriched;
    }
  }
};
