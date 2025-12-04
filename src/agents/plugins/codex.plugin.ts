import { AgentMetadata } from '../core/types.js';
import { BaseAgentAdapter } from '../core/BaseAgentAdapter.js';
import { mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { CodexAnalyticsAdapter } from '../../analytics/aggregation/adapters/codex.adapter.js';

// Define metadata object for reusability
const metadata = {
  name: 'codex',
  displayName: 'Codex',
  description: 'OpenAI Codex - AI coding assistant',

  npmPackage: '@openai/codex',
  cliCommand: 'codex',

  // Data paths used by lifecycle hooks and analytics
  dataPaths: {
    home: '~/.codex',
    sessions: 'sessions',  // Relative to home
    settings: 'auth.json'  // Relative to home
  },

  envMapping: {
    baseUrl: ['OPENAI_API_BASE', 'OPENAI_BASE_URL'],
    apiKey: ['OPENAI_API_KEY'],
    model: ['OPENAI_MODEL', 'CODEX_MODEL']
  },

  supportedProviders: ['ollama', 'litellm', 'ai-run-sso'],
  blockedModelPatterns: [/^claude/i],

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
 * Codex Plugin Metadata
 */
export const CodexPluginMetadata: AgentMetadata = {
  ...metadata,

  // Lifecycle hook uses dataPaths from metadata (DRY!)
  lifecycle: {
    beforeRun: async (env) => {
      const codexDir = join(homedir(), metadata.dataPaths.home.replace('~/', ''));
      const authFile = join(codexDir, metadata.dataPaths.settings);

      // Create ~/.codex directory if it doesn't exist
      if (!existsSync(codexDir)) {
        await mkdir(codexDir, { recursive: true });
      }

      // Create auth.json if it doesn't exist
      if (!existsSync(authFile)) {
        const authConfig = {
          OPENAI_API_KEY: env.OPENAI_API_KEY || 'proxy-handled'
        };
        await writeFile(authFile, JSON.stringify(authConfig, null, 2));
      }

      return env;
    }
  },

  // Analytics adapter uses same metadata (DRY!)
  analyticsAdapter: new CodexAnalyticsAdapter(metadata)
};

/**
 * Codex Adapter
 */
export class CodexPlugin extends BaseAgentAdapter {
  constructor() {
    super(CodexPluginMetadata);
  }
}
