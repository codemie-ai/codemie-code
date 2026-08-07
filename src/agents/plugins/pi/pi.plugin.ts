import type { AgentMetadata, AgentConfig } from '../../core/types.js';
import { BaseAgentAdapter } from '../../core/BaseAgentAdapter.js';
import { logger } from '@/utils/logger.js';
import { preparePiAgentDir } from './pi.setup.js';
import { fetchAndBuildPiModels, classifyPiModel } from './pi.models.js';
import { getPiAgentDir } from './pi.paths.js';

export const PiPluginMetadata: AgentMetadata = {
  name: 'pi',
  displayName: 'Pi',
  description: 'Pi - open-source coding agent harness',
  npmPackage: '@earendil-works/pi-coding-agent',
  cliCommand: process.env.CODEMIE_PI_BIN || 'pi',

  sessionAnalyticsReport: false,

  dataPaths: {
    home: '.pi',
  },

  envMapping: {
    baseUrl: [],
    apiKey: [],
    model: [],
  },

  supportedProviders: ['ai-run-sso', 'bearer-auth', 'litellm'],

  ssoConfig: {
    enabled: true,
    clientType: 'codemie-pi',
  },

  lifecycle: {
    async beforeRun(env: NodeJS.ProcessEnv, _config: AgentConfig) {
      const cwd = process.cwd();
      await preparePiAgentDir(cwd);
      await fetchAndBuildPiModels(env, cwd);
      env.PI_CODING_AGENT_DIR = getPiAgentDir(cwd);
      logger.debug('[pi] Configured PI_CODING_AGENT_DIR', { path: env.PI_CODING_AGENT_DIR });
      return env;
    },

    enrichArgs(args: string[], _config: AgentConfig): string[] {
      const model = process.env.CODEMIE_MODEL;
      if (!model) {
        throw new Error('No model configured for codemie-pi. Run codemie setup to select a model.');
      }

      const classification = classifyPiModel(model);
      const providerId = classification.provider;

      let result = args;

      const taskIndex = result.indexOf('--task');
      if (taskIndex !== -1 && taskIndex < result.length - 1) {
        const taskValue = result[taskIndex + 1];
        result = [...result.slice(0, taskIndex), ...result.slice(taskIndex + 2), taskValue];
      }

      return ['--provider', providerId, '--model', model, ...result];
    },
  },
};

export class PiPlugin extends BaseAgentAdapter {
  constructor() {
    super(PiPluginMetadata);
  }
}
