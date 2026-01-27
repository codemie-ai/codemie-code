import type { AgentMetadata, AgentConfig } from '../../core/types.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFileSync, unlinkSync } from 'fs';
import { logger } from '../../../utils/logger.js';
import { getModelConfig } from './opencode-model-configs.js';
import { BaseAgentAdapter } from '../../core/BaseAgentAdapter.js';
import type { SessionAdapter } from '../../core/session/BaseSessionAdapter.js';
import type { BaseExtensionInstaller } from '../../core/extension/BaseExtensionInstaller.js';
import { commandExists } from '../../../utils/processes.js';
import { OpenCodeSessionAdapter } from './opencode.session.js';

const OPENCODE_SUBCOMMANDS = ['run', 'chat', 'config', 'init', 'help', 'version'];

// Environment variable size limit (conservative - varies by platform)
// Linux: ~128KB per var, Windows: ~32KB total env block
const MAX_ENV_SIZE = 32 * 1024;

// Track temp config files for cleanup on process exit
const tempConfigFiles: string[] = [];
let cleanupRegistered = false;

/**
 * Register process exit handler for temp file cleanup (best effort)
 * Only registers once, even if beforeRun is called multiple times
 */
function registerCleanupHandler(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  process.on('exit', () => {
    for (const file of tempConfigFiles) {
      try {
        unlinkSync(file);
        logger.debug(`[opencode] Cleaned up temp config: ${file}`);
      } catch {
        // Ignore cleanup errors - file may already be deleted
      }
    }
  });
}

/**
 * Write config to temp file as fallback when env var size exceeded
 * Returns the temp file path
 */
function writeConfigToTempFile(configJson: string): string {
  const configPath = join(
    tmpdir(),
    `codemie-opencode-config-${process.pid}-${Date.now()}.json`
  );
  writeFileSync(configPath, configJson, 'utf-8');
  tempConfigFiles.push(configPath);
  registerCleanupHandler();
  return configPath;
}

// NOTE: dataPaths in AgentMetadata only supports `home` and optional `settings`.
// OpenCode session storage paths are resolved separately in opencode.paths.ts
// since they follow XDG conventions and differ from the home directory.

/**
 * Ensure session metadata file exists for SessionSyncer
 * Creates or updates the session file in ~/.codemie/sessions/
 */
async function ensureSessionFile(sessionId: string, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    const { SessionStore } = await import('../../core/session/SessionStore.js');
    const sessionStore = new SessionStore();

    // Check if session already exists
    const existing = await sessionStore.loadSession(sessionId);
    if (existing) {
      logger.debug('[opencode] Session file already exists');
      return;
    }

    // Create new session file
    const agentName = env.CODEMIE_AGENT || 'opencode';
    const provider = env.CODEMIE_PROVIDER || 'unknown';
    const project = env.CODEMIE_PROJECT;
    const workingDirectory = process.cwd();

    // Detect git branch
    let gitBranch: string | undefined;
    try {
      const { detectGitBranch } = await import('../../../utils/processes.js');
      gitBranch = await detectGitBranch(workingDirectory);
    } catch {
      // Git detection optional
    }

    // Estimate startTime from grace period (session ended ~2 seconds ago during grace period)
    // This prevents negative session durations in metrics aggregation
    const estimatedStartTime = Date.now() - 2000;

    const session = {
      sessionId,
      agentName,
      provider,
      ...(project && { project }),
      startTime: estimatedStartTime,
      workingDirectory,
      ...(gitBranch && { gitBranch }),
      status: 'completed' as const,  // Session already ended
      activeDurationMs: 0,
      correlation: {
        status: 'matched' as const,
        agentSessionId: 'unknown',  // Will be updated after discovery
        retryCount: 0
      }
    };

    await sessionStore.saveSession(session);
    logger.debug('[opencode] Created session metadata file');

  } catch (error) {
    logger.warn('[opencode] Failed to create session file:', error);
    // Don't throw - processing can continue without session file (sync will fail though)
  }
}

export const OpenCodePluginMetadata: AgentMetadata = {
  name: 'opencode',
  displayName: 'OpenCode CLI',
  description: 'OpenCode - open-source AI coding assistant',
  npmPackage: 'opencode-ai',  // Official npm package (npm i -g opencode-ai)
  cliCommand: process.env.CODEMIE_OPENCODE_BIN || 'opencode',
  dataPaths: {
    home: '.opencode'
    // NOTE: Session storage is NOT in home - it's in XDG_DATA_HOME/opencode/storage/
    // This is handled by getSessionStoragePath() in opencode.paths.ts
  },
  envMapping: {
    baseUrl: [],
    apiKey: [],
    model: []
  },
  supportedProviders: ['litellm', 'ai-run-sso'],
  ssoConfig: { enabled: true, clientType: 'codemie-opencode' },

  lifecycle: {
    // NOTE: beforeRun signature is (env, config) per AgentLifecycle interface
    // Claude plugin only uses (env), but interface supports both
    async beforeRun(env: NodeJS.ProcessEnv, config: AgentConfig) {
      // Create session metadata file at startup (before config setup)
      // This ensures SessionSyncer can sync metrics to v1/metrics API (matching Claude/Gemini)
      const sessionId = env.CODEMIE_SESSION_ID;
      if (sessionId) {
        try {
          logger.debug(`[opencode] Creating session metadata file before startup`);
          await ensureSessionFile(sessionId, env);
          logger.debug(`[opencode] Session metadata file ready for SessionSyncer`);
        } catch (error) {
          logger.error('[opencode] Failed to create session file in beforeRun', { error });
          // Don't throw - let OpenCode run even if session file creation fails
        }
      }

      const proxyUrl = env.CODEMIE_BASE_URL;

      if (!proxyUrl) {
        return env;
      }

      if (!proxyUrl.startsWith('http://') && !proxyUrl.startsWith('https://')) {
        logger.warn(`Invalid CODEMIE_BASE_URL format: ${proxyUrl}`, { agent: 'opencode' });
        return env;
      }

      // Model selection priority: env var > config > default
      const selectedModel = env.CODEMIE_MODEL || config?.model || 'gpt-5-2-2025-12-11';
      const modelConfig = getModelConfig(selectedModel);

      // Extract OpenCode-compatible model config (remove CodeMie-specific fields)
      const { displayName: _displayName, providerOptions, ...opencodeModelConfig } = modelConfig;

      const openCodeConfig = {
        enabled_providers: ['codemie-proxy'],
        provider: {
          'codemie-proxy': {
            npm: '@ai-sdk/openai-compatible',
            name: 'CodeMie SSO',
            options: {
              baseURL: `${proxyUrl}/`,
              apiKey: 'proxy-handled',
              timeout: providerOptions?.timeout ||
                       parseInt(env.CODEMIE_TIMEOUT || '600') * 1000,
              ...(providerOptions?.headers && {
                headers: providerOptions.headers
              })
            },
            models: {
              [modelConfig.id]: opencodeModelConfig
            }
          }
        },
        defaults: {
          model: `codemie-proxy/${modelConfig.id}`
        }
      };

      const configJson = JSON.stringify(openCodeConfig);

      // Config injection strategy:
      // 1. Primary: OPENCODE_CONFIG_CONTENT env var (inline JSON)
      // 2. Fallback: OPENCODE_CONFIG env var pointing to temp file
      // See tech spec ADR-002 and "Fallback Strategy" section
      if (configJson.length > MAX_ENV_SIZE) {
        logger.warn(`Config size (${configJson.length} bytes) exceeds env var limit (${MAX_ENV_SIZE}), using temp file fallback`, {
          agent: 'opencode'
        });

        const configPath = writeConfigToTempFile(configJson);
        logger.debug(`[opencode] Wrote config to temp file: ${configPath}`);

        // OPENCODE_CONFIG is verified in OpenCode source: src/flag/flag.ts
        env.OPENCODE_CONFIG = configPath;
        return env;
      }

      // Primary path: inject config inline via OPENCODE_CONFIG_CONTENT
      // Verified in OpenCode source: src/config/config.ts:93-96
      env.OPENCODE_CONFIG_CONTENT = configJson;
      return env;
    },

    enrichArgs: (args: string[], _config: AgentConfig) => {
      if (args.length > 0 && OPENCODE_SUBCOMMANDS.includes(args[0])) {
        return args;
      }

      const taskIndex = args.indexOf('--task');
      if (taskIndex !== -1 && taskIndex < args.length - 1) {
        const taskValue = args[taskIndex + 1];
        const otherArgs = args.filter((arg, i, arr) => {
          if (i === taskIndex || i === taskIndex + 1) return false;
          if (arg === '-m' || arg === '--message') return false;
          if (i > 0 && (arr[i - 1] === '-m' || arr[i - 1] === '--message')) return false;
          return true;
        });
        return ['run', '-m', taskValue, ...otherArgs];
      }
      return args;
    },

    /**
     * Process OpenCode session metrics before SessionSyncer runs
     *
     * Called by BaseAgentAdapter when OpenCode session ends, BEFORE SessionSyncer.
     * This hook ensures metrics are written to JSONL in time for SessionSyncer's
     * metrics-sync processor to send them to v1/metrics API.
     *
     * Lifecycle order:
     * 1. OpenCode exits
     * 2. Grace period (wait for file writes)
     * 3. onSessionEnd ← WE ARE HERE (process metrics to JSONL)
     * 4. SessionSyncer runs (reads JSONL, sends to v1/metrics)
     * 5. Proxy stops
     * 6. afterRun (cleanup)
     *
     * This matches Claude/Gemini real-time sync behavior where SessionSyncer
     * automatically sends metrics during the session lifecycle.
     */
    async onSessionEnd(exitCode: number, env: NodeJS.ProcessEnv) {
      const sessionId = env.CODEMIE_SESSION_ID;

      if (!sessionId) {
        logger.debug('[opencode] No CODEMIE_SESSION_ID in environment, skipping metrics processing');
        return;
      }

      try {
        logger.info(`[opencode] Processing session metrics before SessionSyncer (code=${exitCode})`);

        // 1. Initialize session adapter
        const adapter = new OpenCodeSessionAdapter(OpenCodePluginMetadata);

        // 2. Discover recent sessions (last 24 hours)
        const sessions = await adapter.discoverSessions({ maxAgeDays: 1 });

        if (sessions.length === 0) {
          logger.warn('[opencode] No recent OpenCode sessions found for processing');
          return;
        }

        // 3. Process the most recent session
        const latestSession = sessions[0];
        logger.debug(`[opencode] Processing latest session: ${latestSession.sessionId}`);
        logger.debug(`[opencode] OpenCode session ID: ${latestSession.sessionId}`);
        logger.debug(`[opencode] CodeMie session ID: ${sessionId}`);

        // 4. Build processing context (same as CLI command)
        const context = {
          sessionId,
          apiBaseUrl: env.CODEMIE_BASE_URL || '',
          cookies: '', // Will be loaded by processors if needed
          clientType: 'codemie-opencode',
          version: env.CODEMIE_CLI_VERSION || '1.0.0',
          dryRun: false
        };

        // 5. Process session (extracts metrics + conversations to JSONL)
        const result = await adapter.processSession(
          latestSession.filePath,
          sessionId,
          context
        );

        if (result.success) {
          logger.info(`[opencode] Metrics processing complete: ${result.totalRecords} records processed`);
          logger.info(`[opencode] Metrics written to JSONL - SessionSyncer will sync to v1/metrics next`);
        } else {
          logger.warn(`[opencode] Metrics processing had failures: ${result.failedProcessors.join(', ')}`);
        }

        // Note: SessionSyncer runs IMMEDIATELY after this hook completes.
        // It will read the JSONL deltas we just wrote and send them to v1/metrics API.
        // This matches Claude/Gemini real-time sync behavior during session lifecycle.

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`[opencode] Failed to process session metrics automatically: ${errorMessage}`);
        // Don't throw - metrics failure shouldn't block exit
      }
    }
  }
};

/**
 * OpenCode agent plugin
 * Phase 1: Core plugin with CLI wrapping and SSO proxy support
 * Phase 2: Session analytics integration
 */
export class OpenCodePlugin extends BaseAgentAdapter {
  private sessionAdapter: SessionAdapter;

  constructor() {
    super(OpenCodePluginMetadata);
    // Initialize session adapter with metadata for unified session sync
    this.sessionAdapter = new OpenCodeSessionAdapter(OpenCodePluginMetadata);
  }

  /**
   * Check if OpenCode is installed
   * Overridden to provide custom install instructions (AC-1.2)
   *
   * NOTE (GPT-5.5 review): This method should be SIDE-EFFECT FREE.
   * Install instructions are displayed via logger (file-only in non-debug mode)
   * so they appear in logs but don't pollute stdout during programmatic checks
   * like `codemie doctor`. The CLI layer (AgentCLI) handles user-facing output.
   */
  async isInstalled(): Promise<boolean> {
    // Use metadata.cliCommand which respects CODEMIE_OPENCODE_BIN
    const cliCommand = this.metadata.cliCommand;
    if (!cliCommand) return false;

    const installed = await commandExists(cliCommand);

    if (!installed) {
      // Log install guidance to debug log (file-only unless CODEMIE_DEBUG=true)
      // Actual user-facing message is handled by AgentCLI layer
      logger.debug('[opencode-plugin] OpenCode not installed. Install with:');
      logger.debug('[opencode-plugin]   codemie install opencode');
      logger.debug('[opencode-plugin]   Or directly: npm i -g opencode-ai');
    }

    return installed;
  }

  /**
   * Return session adapter for analytics
   * Phase 2: Returns OpenCodeSessionAdapter instance
   */
  getSessionAdapter(): SessionAdapter {
    return this.sessionAdapter;
  }

  /**
   * No extension installer - OpenCode installed manually
   * Returns undefined (interface allows optional return)
   */
  getExtensionInstaller(): BaseExtensionInstaller | undefined {
    return undefined;
  }
}
