import { AgentMetadata } from '../core/types.js';
import { BaseAgentAdapter } from '../core/BaseAgentAdapter.js';

/**
 * Codex Plugin Metadata
 */
export const CodexPluginMetadata: AgentMetadata = {
  name: 'codex',
  displayName: 'Codex',
  description: 'OpenAI Codex - AI coding assistant',

  npmPackage: '@openai/codex',
  cliCommand: 'codex',

  envMapping: {
    baseUrl: ['OPENAI_API_BASE', 'OPENAI_BASE_URL'],
    apiKey: ['OPENAI_API_KEY'],
    model: ['OPENAI_MODEL', 'CODEX_MODEL']
  },

  supportedProviders: ['openai', 'azure', 'litellm', 'ai-run-sso'],
  blockedModelPatterns: [/^claude/i, /bedrock.*claude/i],

  ssoConfig: {
    enabled: true,
    clientType: 'codex-cli',
    envOverrides: {
      baseUrl: 'OPENAI_API_BASE',
      apiKey: 'OPENAI_API_KEY'
    }
  },

  // Codex needs model injected as argument
  argumentTransform: (args, config) => {
    const hasModelArg = args.some((arg, idx) =>
      (arg === '-m' || arg === '--model') && idx < args.length - 1
    );

    if (!hasModelArg && config.model) {
      return ['--model', config.model, ...args];
    }

    return args;
  }
};

/**
 * Codex Adapter
 */
export class CodexPlugin extends BaseAgentAdapter {
  constructor() {
    super(CodexPluginMetadata);
  }
}
