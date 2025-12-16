import { AgentMetadata } from '../core/types.js';
import { BaseAgentAdapter } from '../core/BaseAgentAdapter.js';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * Helper functions
 */

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tempFile = filePath + '.tmp';
  await writeFile(tempFile, content);
  const { rename } = await import('fs/promises');
  await rename(tempFile, filePath);
}

async function countActiveSessions(configFile: string, excludeSessionId?: string): Promise<number> {
  if (!existsSync(configFile)) return 0;

  const configContent = await readFile(configFile, 'utf-8');
  const sessionMarkerRegex = /# --- CODEMIE SESSION START: (.+?) ---/g;
  const matches = [...configContent.matchAll(sessionMarkerRegex)];

  // Count sessions, excluding the one being cleaned up
  let count = 0;
  for (const match of matches) {
    const sessionId = match[1];
    if (sessionId !== excludeSessionId) {
      count++;
    }
  }

  return count;
}

export async function cleanupAuthJson(authFile: string, sessionEnv?: NodeJS.ProcessEnv, configFile?: string): Promise<void> {
  if (!existsSync(authFile)) return;

  const authContent = await readFile(authFile, 'utf-8');
  const authConfig = JSON.parse(authContent);
  const provider = sessionEnv?.CODEMIE_PROFILE_NAME || sessionEnv?.CODEMIE_PROVIDER;

  // Count remaining active sessions (excluding current one being cleaned)
  const sessionId = sessionEnv?.CODEMIE_SESSION_ID;
  const remainingSessions = configFile ? await countActiveSessions(configFile, sessionId) : 0;

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
      // Remove OPENAI_API_KEY if it was set by gemini and no other sessions remain
      if (key === 'OPENAI_API_KEY' && value === sessionEnv?.OPENAI_API_KEY && value === 'not-required' && remainingSessions === 0) {
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
      // Remove OPENAI_API_KEY only if no other sessions remain
      if (key === 'OPENAI_API_KEY' && value === sessionEnv?.OPENAI_API_KEY && value === 'not-required' && remainingSessions === 0) {
        continue;
      }

      // Keep everything else
      cleanedAuth[key] = value;
    }
  }

  await atomicWrite(authFile, JSON.stringify(cleanedAuth, null, 2));
}

export async function cleanupConfigToml(configFile: string, sessionEnv?: NodeJS.ProcessEnv): Promise<void> {
  if (!existsSync(configFile)) return;

  const sessionId = sessionEnv?.CODEMIE_SESSION_ID;
  if (!sessionId) {
    // Fallback: try to find any session for this provider (backward compat)
    const profileName = sessionEnv?.CODEMIE_PROFILE_NAME || sessionEnv?.CODEMIE_PROVIDER;
    if (!profileName) return;

    let configContent = await readFile(configFile, 'utf-8');

    // Remove any session block for this provider
    const sessionBlockRegex = new RegExp(
      `# --- CODEMIE SESSION START: ${profileName}-\\d+ ---[\\s\\S]*?# --- CODEMIE SESSION END: ${profileName}-\\d+ ---\\n?`,
      'g'
    );

    configContent = configContent.replace(sessionBlockRegex, '');
    configContent = configContent.replace(/^\s*\n+/gm, '\n').replace(/^\n/, ''); // Clean up empty lines

    await atomicWrite(configFile, configContent);
    return;
  }

  // Use session ID for precise removal
  let configContent = await readFile(configFile, 'utf-8');

  const sessionStartMarker = `# --- CODEMIE SESSION START: ${sessionId} ---`;
  const sessionEndMarker = `# --- CODEMIE SESSION END: ${sessionId} ---`;

  const sessionBlockRegex = new RegExp(
    `${sessionStartMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${sessionEndMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`,
    'g'
  );

  configContent = configContent.replace(sessionBlockRegex, '');
  configContent = configContent.replace(/^\s*\n+/gm, '\n').replace(/^\n/, ''); // Clean up empty lines

  await atomicWrite(configFile, configContent);
}

/**
 * Setup helper functions
 */

async function ensureCodexDirectory(codexDir: string): Promise<void> {
  if (!existsSync(codexDir)) {
    await mkdir(codexDir, { recursive: true });
  }
}

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

function buildSessionBlock(providerName: string, baseUrl: string, model: string): string {
  // Generate unique session ID (timestamp + provider)
  const sessionId = `${providerName}-${Date.now()}`;

  let content = '';
  content += `# --- CODEMIE SESSION START: ${sessionId} ---\n`;
  content += `profile = "${providerName}"\n\n`;
  content += `[model_providers.${providerName}]\n`;
  content += `name = "${providerName}"\n`;
  content += `base_url = "${baseUrl}"\n\n`;
  content += `[profiles.${providerName}]\n`;
  content += `model_provider = "${providerName}"\n`;
  content += `model = "${model}"\n`;
  content += `# --- CODEMIE SESSION END: ${sessionId} ---\n`;

  return content;
}

export async function setupConfigToml(configFile: string, env: NodeJS.ProcessEnv): Promise<void> {
  const model = env.OPENAI_MODEL || env.CODEX_MODEL;
  const baseUrl = env.OPENAI_BASE_URL || env.OPENAI_API_BASE;

  if (!model || !baseUrl) {
    return;
  }

  const providerName = env.CODEMIE_PROFILE_NAME || env.CODEMIE_PROVIDER || 'default';

  // Read existing content (or empty if file doesn't exist)
  let existingContent = '';
  if (existsSync(configFile)) {
    existingContent = await readFile(configFile, 'utf-8');
  }

  // Build session block
  const sessionBlock = buildSessionBlock(providerName, baseUrl, model);

  // Append session block to existing content
  const newContent = existingContent ? `${existingContent}\n${sessionBlock}` : sessionBlock;

  // Store session ID for cleanup
  env.CODEMIE_SESSION_ID = sessionBlock.match(/# --- CODEMIE SESSION START: (.*?) ---/)?.[1] || '';

  await atomicWrite(configFile, newContent);
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
      // Pass profile to Codex (uses config.toml profiles)
      const hasProfileArg = args.some((arg, idx) =>
        (arg === '--profile') && idx < args.length - 1
      );

      // Use CodeMie profile name (matches beforeRun setup)
      const profileName = config.profileName || config.provider || 'default';
      if (!hasProfileArg) {
        return ['--profile', profileName, ...args];
      }

      return args;
    },

    beforeRun: async (env) => {
      const codexDir = join(homedir(), metadata.dataPaths.home.replace('~/', ''));
      const authFile = join(codexDir, metadata.dataPaths.settings);
      const configFile = join(codexDir, 'config.toml');

      await ensureCodexDirectory(codexDir);
      await setupAuthJson(authFile, env);
      await setupConfigToml(configFile, env);

      return env;
    },

    afterRun: async (exitCode, sessionEnv) => {
      // Cleanup session-specific configuration after session ends
      const codexDir = join(homedir(), metadata.dataPaths.home.replace('~/', ''));
      const authFile = join(codexDir, metadata.dataPaths.settings);
      const configFile = join(codexDir, 'config.toml');

      try {
        await cleanupAuthJson(authFile, sessionEnv, configFile);
        await cleanupConfigToml(configFile, sessionEnv);
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
  constructor() {
    super(CodexPluginMetadata);
  }
}
