import { AgentMetadata } from '../core/types.js';
import { BaseAgentAdapter } from '../core/BaseAgentAdapter.js';
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

/**
 * Remove orphaned model_providers that are no longer referenced by any session
 */
function removeOrphanedProviders(configContent: string): string {
  // Find all model_provider references in session blocks (inside CODEMIE SESSION markers)
  const sessionBlocksRegex = /# --- CODEMIE SESSION START:[\s\S]*?# --- CODEMIE SESSION END: [^\n]+/g;
  const sessionBlocks = configContent.match(sessionBlocksRegex) || [];

  // Extract referenced providers from session blocks
  const referencedProviders = new Set<string>();
  for (const block of sessionBlocks) {
    const providerMatch = block.match(/model_provider\s*=\s*"([^"]+)"/);
    if (providerMatch) {
      referencedProviders.add(providerMatch[1]);
    }
  }

  // Also check for references outside session blocks (pre-existing config)
  const contentOutsideBlocks = configContent.replace(sessionBlocksRegex, '');
  const externalProviderMatches = contentOutsideBlocks.matchAll(/model_provider\s*=\s*"([^"]+)"/g);
  for (const match of externalProviderMatches) {
    referencedProviders.add(match[1]);
  }

  // Find all model_providers sections
  const lines = configContent.split('\n');
  const providerLinesToRemove = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const providerMatch = line.match(/^\[model_providers\.([^\]]+)\]/);

    if (providerMatch) {
      const providerName = providerMatch[1];

      // Check if this provider is referenced
      if (!referencedProviders.has(providerName)) {
        // Mark provider section for removal (header + all subsequent non-empty, non-section lines)
        providerLinesToRemove.add(i);

        // Mark subsequent lines until next section or empty line
        for (let j = i + 1; j < lines.length; j++) {
          const nextLine = lines[j];

          // Stop at next section or session marker
          if (nextLine.match(/^\s*\[/) || nextLine.match(/^# --- CODEMIE SESSION/)) {
            break;
          }

          // Stop at empty line (end of section)
          if (nextLine.trim() === '') {
            providerLinesToRemove.add(j);
            break;
          }

          // Mark this line for removal (part of provider section)
          providerLinesToRemove.add(j);
        }
      }
    }
  }

  // Remove marked lines
  const cleanedLines = lines.filter((_, index) => !providerLinesToRemove.has(index));

  return cleanedLines.join('\n');
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

    // Remove orphaned providers
    configContent = removeOrphanedProviders(configContent);

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

  // Remove orphaned providers (providers with no profile references)
  configContent = removeOrphanedProviders(configContent);

  await atomicWrite(configFile, configContent);
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

/**
 * Ensure model provider exists in global config (outside session blocks)
 * Returns updated content with provider section if it was missing
 */
function ensureModelProvider(
  existingContent: string,
  providerName: string,
  baseUrl: string
): string {
  // Check if provider already exists anywhere in the file
  const providerSectionExists = existingContent.includes(`[model_providers.${providerName}]`);

  if (providerSectionExists) {
    return existingContent; // No changes needed
  }

  // Add provider section at the top (before any session blocks)
  const providerSection =
    `[model_providers.${providerName}]\n` +
    `name = "${providerName}"\n` +
    `base_url = "${baseUrl}"\n\n`;

  // If file is empty, just add the provider
  if (!existingContent) {
    return providerSection;
  }

  // Find first session block marker
  const firstSessionMatch = existingContent.match(/# --- CODEMIE SESSION START:/);

  if (firstSessionMatch) {
    // Insert provider before first session block
    const insertPos = firstSessionMatch.index || 0;
    return (
      existingContent.substring(0, insertPos) +
      providerSection +
      existingContent.substring(insertPos)
    );
  }

  // No session blocks yet, prepend provider section
  return providerSection + existingContent;
}

/**
 * Build session-specific block (without model_providers - that's global now)
 * Uses unique profile name per session to avoid TOML duplicate key errors
 */
function buildSessionBlock(
  providerName: string,
  model: string
): string {
  // Generate unique session ID (timestamp + provider)
  const sessionId = `${providerName}-${Date.now()}`;
  // Use session ID as unique profile name to avoid duplicates
  const uniqueProfileName = sessionId;

  let content = '';
  content += `# --- CODEMIE SESSION START: ${sessionId} ---\n`;
  content += `profile = "${uniqueProfileName}"\n\n`;
  content += `[profiles.${uniqueProfileName}]\n`;
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

  // Step 1: Ensure model provider exists globally (outside session blocks)
  existingContent = ensureModelProvider(existingContent, providerName, baseUrl);

  // Step 2: Build session-specific block
  const sessionBlock = buildSessionBlock(providerName, model);

  // Step 3: Append session block to content
  const newContent = existingContent ? `${existingContent}\n${sessionBlock}` : sessionBlock;

  // Store session ID and profile name for cleanup and CLI args
  const sessionId = sessionBlock.match(/# --- CODEMIE SESSION START: (.*?) ---/)?.[1] || '';
  env.CODEMIE_SESSION_ID = sessionId;
  env.CODEMIE_CODEX_PROFILE = sessionId; // Unique profile name for --profile arg

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
    home: '.codex',
    sessions: 'sessions',  // Relative to home
    settings: 'auth.json',  // Relative to home
    config: 'config.toml',  // Configuration storage
    user_prompts: 'history.jsonl'  // User prompt history (for future metrics adapter)
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

      if (!hasProfileArg) {
        // Use unique profile name from env (set by beforeRun), fallback to config
        const profileName = process.env.CODEMIE_CODEX_PROFILE || config.profileName || config.provider || 'default';
        return ['--profile', profileName, ...args];
      }

      return args;
    },

    beforeRun: async function(this: BaseAgentAdapter, env: NodeJS.ProcessEnv) {
      // Use base methods for directory and path resolution
      await this.ensureDirectory(this.resolveDataPath());

      const authFile = this.resolveDataPath(metadata.dataPaths.settings);
      const configFile = this.resolveDataPath(metadata.dataPaths.config);

      // Complex setup logic (TOML manipulation, session tracking)
      await setupAuthJson(authFile, env);
      await setupConfigToml(configFile, env);

      // Copy unique profile name to parent process env so enrichArgs can access it
      if (env.CODEMIE_CODEX_PROFILE) {
        process.env.CODEMIE_CODEX_PROFILE = env.CODEMIE_CODEX_PROFILE;
      }

      return env;
    },

    afterRun: async function(this: BaseAgentAdapter, exitCode: number, sessionEnv?: NodeJS.ProcessEnv) {
      // Use base methods for path resolution
      const authFile = this.resolveDataPath(metadata.dataPaths.settings);
      const configFile = this.resolveDataPath(metadata.dataPaths.config);

      try {
        // Complex cleanup logic (session counting, TOML manipulation)
        await cleanupAuthJson(authFile, sessionEnv, configFile);
        await cleanupConfigToml(configFile, sessionEnv);
      } catch (error) {
        // Ignore cleanup errors (session already ended, non-critical)
        const { logger } = await import('../../utils/logger.js');
        logger.debug(`Cleanup failed (non-critical): ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        // Clean up parent process env
        delete process.env.CODEMIE_CODEX_PROFILE;
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
