import { AgentMetadata } from '../core/types.js';
import { BaseAgentAdapter } from '../core/BaseAgentAdapter.js';
import { CodexMetricsAdapter } from './codex.metrics.js';
import type { AgentMetricsSupport } from '../core/metrics/types.js';
import { writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';

/**
 * Helper functions
 */

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tempFile = filePath + '.tmp';
  await writeFile(tempFile, content);
  const { rename } = await import('fs/promises');
  await rename(tempFile, filePath);
}

export async function cleanupAuthJson(authFile: string, sessionEnv?: NodeJS.ProcessEnv): Promise<void> {
  if (!existsSync(authFile)) return;

  const authContent = await readFile(authFile, 'utf-8');
  const authConfig = JSON.parse(authContent);
  const provider = sessionEnv?.CODEMIE_PROFILE_NAME || sessionEnv?.CODEMIE_PROVIDER;

  const cleanedAuth: Record<string, string> = {};

  // Provider-specific cleanup
  if (provider === 'gemini') {
    // Remove only Gemini-specific vars that match this session
    for (const [key, value] of Object.entries(authConfig)) {
      if (typeof value !== 'string') continue;

      // Remove only this session's gemini keys
      if (key === 'GEMINI_API_KEY' && value === sessionEnv?.GEMINI_API_KEY) {
        continue;
      }
      if (key === 'GOOGLE_GEMINI_BASE_URL' && value === sessionEnv?.GOOGLE_GEMINI_BASE_URL) {
        continue;
      }
      if (key === 'OPENAI_API_KEY' && value === sessionEnv?.OPENAI_API_KEY && value === 'not-required') {
        continue;
      }

      cleanedAuth[key] = value;
    }
  } else {
    // Ollama or other OpenAI-compatible providers
    const sessionBaseUrl = sessionEnv?.OPENAI_BASE_URL || sessionEnv?.OPENAI_API_BASE;

    for (const [key, value] of Object.entries(authConfig)) {
      if (typeof value !== 'string') continue;

      // Only remove OPENAI_API_BASE if it matches this session's URL
      if (key === 'OPENAI_API_BASE' && value === sessionBaseUrl) {
        continue;
      }
      // Remove OPENAI_API_KEY if it's the placeholder
      if (key === 'OPENAI_API_KEY' && value === 'not-required') {
        continue;
      }

      // Keep everything else
      cleanedAuth[key] = value;
    }
  }

  await atomicWrite(authFile, JSON.stringify(cleanedAuth, null, 2));
}

/**
 * Setup helper functions
 */

async function loadExistingAuth(authFile: string): Promise<Record<string, string>> {
  if (!existsSync(authFile)) {
    return {};
  }

  try {
    const authContent = await readFile(authFile, 'utf-8');
    return JSON.parse(authContent);
  } catch {
    // Ignore parse errors, will overwrite with valid JSON
    return {};
  }
}

function buildAuthConfig(
  env: NodeJS.ProcessEnv,
  existingAuth: Record<string, string>
): Record<string, string> {
  const authConfig: Record<string, string> = {
    ...existingAuth
  };

  const provider = env.CODEMIE_PROFILE_NAME || env.CODEMIE_PROVIDER;

  // Provider-specific auth configuration
  if (provider === 'gemini') {
    // Gemini session: add Gemini-specific vars
    if (env.GEMINI_API_KEY) {
      authConfig.GEMINI_API_KEY = env.GEMINI_API_KEY;
    }
    if (env.GOOGLE_GEMINI_BASE_URL) {
      authConfig.GOOGLE_GEMINI_BASE_URL = env.GOOGLE_GEMINI_BASE_URL;
    }
    // Also set OPENAI_* for compatibility (gemini can use OpenAI SDK)
    if (env.OPENAI_API_KEY) {
      authConfig.OPENAI_API_KEY = env.OPENAI_API_KEY;
    }
    // Don't overwrite OPENAI_API_BASE if it exists from another session
  } else {
    // Ollama or other OpenAI-compatible providers
    authConfig.OPENAI_API_KEY = env.OPENAI_API_KEY || existingAuth.OPENAI_API_KEY || 'not-required';

    // Codex prioritizes OPENAI_API_BASE over OPENAI_BASE_URL
    if (env.OPENAI_BASE_URL) {
      authConfig.OPENAI_API_BASE = env.OPENAI_BASE_URL;
    } else if (env.OPENAI_API_BASE) {
      authConfig.OPENAI_API_BASE = env.OPENAI_API_BASE;
    }
  }

  return authConfig;
}

export async function setupAuthJson(authFile: string, env: NodeJS.ProcessEnv): Promise<void> {
  const existingAuth = await loadExistingAuth(authFile);
  const authConfig = buildAuthConfig(env, existingAuth);
  await atomicWrite(authFile, JSON.stringify(authConfig, null, 2));
}

// Define metadata object for reusability
const metadata = {
  name: 'codex',
  displayName: 'Codex',
  description: 'OpenAI Codex - AI coding assistant',

  npmPackage: '@openai/codex',
  cliCommand: 'codex',

  // Data paths used by lifecycle hooks and analytics
  dataPaths: {
    home: '.codex',
    sessions: 'sessions/{year}/{month}/{day}',  // Date-based structure
    settings: 'auth.json',  // Relative to home
    config: 'config.toml',  // Configuration storage
    user_prompts: 'history.jsonl'  // User prompt history
  },

  envMapping: {
    baseUrl: ['OPENAI_API_BASE', 'OPENAI_BASE_URL'],
    apiKey: ['OPENAI_API_KEY'],
    model: ['OPENAI_MODEL', 'CODEX_MODEL']
  },

  supportedProviders: ['ollama', 'litellm', 'ai-run-sso'],
  blockedModelPatterns: [/^claude/i],
  recommendedModels: ['gpt-4.1', 'gpt-4o', 'qwen2.5-coder'],

  ssoConfig: {
    enabled: true,
    clientType: 'codex-cli'
  },

  flagMappings: {
    '--task': {
      type: 'subcommand' as const,
      target: 'exec',
      position: 'before' as const
    }
  }
};

/**
 * Codex Plugin Metadata
 */
export const CodexPluginMetadata: AgentMetadata = {
  ...metadata,

  // Lifecycle hook uses dataPaths from metadata (DRY!)
  lifecycle: {
    enrichArgs: (args, config) => {
      const cliArgs: string[] = [];

      // 1. Configure model provider via CLI (instead of config.toml)
      const providerName = config.profileName || config.provider || 'codemie';
      const baseUrl = config.baseUrl;
      const model = config.model;

      if (baseUrl) {
        // Define the model provider inline via CLI arguments
        cliArgs.push('--config', `model_providers.${providerName}.name="${providerName}"`);
        cliArgs.push('--config', `model_providers.${providerName}.base_url="${baseUrl}"`);

        // Add wire_api: defaults to "responses", provider can override via env var
        // Most modern providers use "responses" API (SSO, LiteLLM, Bedrock, Azure)
        // Only Ollama needs "chat" (set by ollama provider hook)
        const wireApi = process.env.CODEMIE_CODEX_WIRE_API || 'responses';
        cliArgs.push('--config', `model_providers.${providerName}.wire_api="${wireApi}"`);

        // Select this provider
        cliArgs.push('--config', `model_provider="${providerName}"`);
      }

      // 2. Set model via --config (not --model flag to avoid conflicts)
      if (model) {
        cliArgs.push('--config', `model="${model}"`);
      }

      // 3. Add user's original arguments
      return [...cliArgs, ...args];
    },

    beforeRun: async function(this: BaseAgentAdapter, env: NodeJS.ProcessEnv) {
      // Use base methods for directory and path resolution
      await this.ensureDirectory(this.resolveDataPath());

      const authFile = this.resolveDataPath(metadata.dataPaths.settings);

      // Setup auth.json only (no config.toml modification)
      await setupAuthJson(authFile, env);

      return env;
    },

    afterRun: async function(this: BaseAgentAdapter, exitCode: number, sessionEnv?: NodeJS.ProcessEnv) {
      // Use base methods for path resolution
      const authFile = this.resolveDataPath(metadata.dataPaths.settings);

      try {
        // Cleanup auth.json only (no config.toml cleanup needed)
        await cleanupAuthJson(authFile, sessionEnv);
      } catch (error) {
        // Ignore cleanup errors (session already ended, non-critical)
        const { logger } = await import('../../utils/logger.js');
        logger.debug(`Cleanup failed (non-critical): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  },

  // Analytics adapter uses same metadata (DRY!)
};

/**
 * Codex Adapter
 */
export class CodexPlugin extends BaseAgentAdapter {
  private metricsAdapter: AgentMetricsSupport;

  constructor() {
    super(CodexPluginMetadata);
    // Pass metadata to metrics adapter to avoid duplication
    this.metricsAdapter = new CodexMetricsAdapter(CodexPluginMetadata);
  }

  /**
   * Get metrics adapter for this agent
   */
  getMetricsAdapter(): AgentMetricsSupport {
    return this.metricsAdapter;
  }
}
