import type { AgentMetadata, AgentConfig } from '../../core/types.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { logger } from '../../../utils/logger.js';
import { getModelConfig } from '../opencode/opencode-model-configs.js';
import { BaseAgentAdapter } from '../../core/BaseAgentAdapter.js';
import type { SessionAdapter } from '../../core/session/BaseSessionAdapter.js';
import type { BaseExtensionInstaller } from '../../core/extension/BaseExtensionInstaller.js';
import { installGlobal } from '../../../utils/processes.js';
import { OpenCodeSessionAdapter } from '../opencode/opencode.session.js';
import { resolveCodemieOpenCodeBinary } from './codemie-opencode-binary.js';

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
        logger.debug(`[codemie-opencode] Cleaned up temp config: ${file}`);
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
    `codemie-opencode-wl-config-${process.pid}-${Date.now()}.json`
  );
  writeFileSync(configPath, configJson, 'utf-8');
  tempConfigFiles.push(configPath);
  registerCleanupHandler();
  return configPath;
}

/**
 * Ensure session metadata file exists for SessionSyncer
 * Creates or updates the session file in ~/.codemie/sessions/
 */
async function ensureSessionFile(sessionId: string, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    const { SessionStore } = await import('../../core/session/SessionStore.js');
    const sessionStore = new SessionStore();

    const existing = await sessionStore.loadSession(sessionId);
    if (existing) {
      logger.debug('[codemie-opencode] Session file already exists');
      return;
    }

    const agentName = env.CODEMIE_AGENT || 'codemie-opencode';
    const provider = env.CODEMIE_PROVIDER || 'unknown';
    const project = env.CODEMIE_PROJECT;
    const workingDirectory = process.cwd();

    let gitBranch: string | undefined;
    try {
      const { detectGitBranch } = await import('../../../utils/processes.js');
      gitBranch = await detectGitBranch(workingDirectory);
    } catch {
      // Git detection optional
    }

    const estimatedStartTime = Date.now() - 2000;

    const session = {
      sessionId,
      agentName,
      provider,
      ...(project && { project }),
      startTime: estimatedStartTime,
      workingDirectory,
      ...(gitBranch && { gitBranch }),
      status: 'completed' as const,
      activeDurationMs: 0,
      correlation: {
        status: 'matched' as const,
        agentSessionId: 'unknown',
        retryCount: 0
      }
    };

    await sessionStore.saveSession(session);
    logger.debug('[codemie-opencode] Created session metadata file');

  } catch (error) {
    logger.warn('[codemie-opencode] Failed to create session file:', error);
  }
}

// Resolve binary at load time, fallback to 'codemie'
const resolvedBinary = resolveCodemieOpenCodeBinary();

/**
 * Environment variable contract between the umbrella CLI and whitelabel binary.
 *
 * The umbrella CLI orchestrates everything (proxy, auth, metrics, session sync)
 * and spawns the whitelabel binary as a child process. The whitelabel knows
 * nothing about SSO, cookies, or metrics — it just sees an OpenAI-compatible
 * endpoint at localhost.
 *
 * Flow: BaseAgentAdapter.run() → setupProxy() → beforeRun hook → spawn(binary)
 *
 * | Env Var                  | Set By               | Consumed By          | Purpose                                        |
 * |--------------------------|----------------------|----------------------|------------------------------------------------|
 * | OPENCODE_CONFIG_CONTENT  | beforeRun hook       | Whitelabel config.ts | Full provider config JSON (proxy URL, models)  |
 * | OPENCODE_CONFIG          | beforeRun (fallback) | Whitelabel config.ts | Temp file path when JSON exceeds env var limit |
 * | CODEMIE_SESSION_ID       | BaseAgentAdapter     | onSessionEnd hook    | Session ID for metrics correlation             |
 * | CODEMIE_AGENT            | BaseAgentAdapter     | Lifecycle helpers    | Agent name ('codemie-opencode')                |
 * | CODEMIE_PROVIDER         | Config loader        | setupProxy()         | Provider name (e.g., 'ai-run-sso')             |
 * | CODEMIE_BASE_URL         | setupProxy()         | beforeRun hook       | Proxy URL (http://localhost:{port})             |
 * | CODEMIE_MODEL            | Config/CLI           | beforeRun hook       | Selected model ID                              |
 * | CODEMIE_PROJECT          | SSO exportEnvVars    | Session metadata     | CodeMie project name                           |
 */
export const CodemieOpenCodePluginMetadata: AgentMetadata = {
  name: 'codemie-opencode',
  displayName: 'CodeMie OpenCode',
  description: 'CodeMie OpenCode - whitelabel AI coding assistant',
  npmPackage: '@codemieai/codemie-opencode',
  cliCommand: resolvedBinary || 'codemie',
  dataPaths: {
    home: '.opencode'
    // Session storage follows XDG conventions, handled by opencode.paths.ts
  },
  envMapping: {
    baseUrl: [],
    apiKey: [],
    model: []
  },
  supportedProviders: ['litellm', 'ai-run-sso'],
  ssoConfig: { enabled: true, clientType: 'codemie-opencode' },

  lifecycle: {
    async beforeRun(env: NodeJS.ProcessEnv, config: AgentConfig) {
      const sessionId = env.CODEMIE_SESSION_ID;
      if (sessionId) {
        try {
          logger.debug('[codemie-opencode] Creating session metadata file before startup');
          await ensureSessionFile(sessionId, env);
          logger.debug('[codemie-opencode] Session metadata file ready for SessionSyncer');
        } catch (error) {
          logger.error('[codemie-opencode] Failed to create session file in beforeRun', { error });
        }
      }

      const proxyUrl = env.CODEMIE_BASE_URL;

      if (!proxyUrl) {
        return env;
      }

      if (!proxyUrl.startsWith('http://') && !proxyUrl.startsWith('https://')) {
        logger.warn(`Invalid CODEMIE_BASE_URL format: ${proxyUrl}`, { agent: 'codemie-opencode' });
        return env;
      }

      const selectedModel = env.CODEMIE_MODEL || config?.model || 'gpt-5-2-2025-12-11';
      const modelConfig = getModelConfig(selectedModel);

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

      if (configJson.length > MAX_ENV_SIZE) {
        logger.warn(`Config size (${configJson.length} bytes) exceeds env var limit (${MAX_ENV_SIZE}), using temp file fallback`, {
          agent: 'codemie-opencode'
        });

        const configPath = writeConfigToTempFile(configJson);
        logger.debug(`[codemie-opencode] Wrote config to temp file: ${configPath}`);

        env.OPENCODE_CONFIG = configPath;
        return env;
      }

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
        return ['run', ...otherArgs, taskValue];
      }
      return args;
    },

    async onSessionEnd(exitCode: number, env: NodeJS.ProcessEnv) {
      const sessionId = env.CODEMIE_SESSION_ID;

      if (!sessionId) {
        logger.debug('[codemie-opencode] No CODEMIE_SESSION_ID in environment, skipping metrics processing');
        return;
      }

      try {
        logger.info(`[codemie-opencode] Processing session metrics before SessionSyncer (code=${exitCode})`);

        const adapter = new OpenCodeSessionAdapter(CodemieOpenCodePluginMetadata);

        const sessions = await adapter.discoverSessions({ maxAgeDays: 1 });

        if (sessions.length === 0) {
          logger.warn('[codemie-opencode] No recent OpenCode sessions found for processing');
          return;
        }

        const latestSession = sessions[0];
        logger.debug(`[codemie-opencode] Processing latest session: ${latestSession.sessionId}`);
        logger.debug(`[codemie-opencode] OpenCode session ID: ${latestSession.sessionId}`);
        logger.debug(`[codemie-opencode] CodeMie session ID: ${sessionId}`);

        const context = {
          sessionId,
          apiBaseUrl: env.CODEMIE_BASE_URL || '',
          cookies: '',
          clientType: 'codemie-opencode',
          version: env.CODEMIE_CLI_VERSION || '1.0.0',
          dryRun: false
        };

        const result = await adapter.processSession(
          latestSession.filePath,
          sessionId,
          context
        );

        if (result.success) {
          logger.info(`[codemie-opencode] Metrics processing complete: ${result.totalRecords} records processed`);
          logger.info('[codemie-opencode] Metrics written to JSONL - SessionSyncer will sync to v1/metrics next');
        } else {
          logger.warn(`[codemie-opencode] Metrics processing had failures: ${result.failedProcessors.join(', ')}`);
        }

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`[codemie-opencode] Failed to process session metrics automatically: ${errorMessage}`);
      }
    }
  }
};

/**
 * CodeMie OpenCode whitelabel agent plugin
 * Wraps the @codemieai/codemie-opencode binary distributed via npm
 */
export class CodemieOpenCodePlugin extends BaseAgentAdapter {
  private sessionAdapter: SessionAdapter;

  constructor() {
    super(CodemieOpenCodePluginMetadata);
    this.sessionAdapter = new OpenCodeSessionAdapter(CodemieOpenCodePluginMetadata);
  }

  /**
   * Check if the whitelabel binary is available.
   * Uses existsSync on the resolved binary path instead of PATH lookup.
   */
  async isInstalled(): Promise<boolean> {
    const binaryPath = resolveCodemieOpenCodeBinary();

    if (!binaryPath) {
      logger.debug('[codemie-opencode] Whitelabel binary not found in node_modules');
      logger.debug('[codemie-opencode] Install with: npm i -g @codemieai/codemie-opencode');
      return false;
    }

    const installed = existsSync(binaryPath);

    if (!installed) {
      logger.debug('[codemie-opencode] Binary path resolved but file not found');
      logger.debug('[codemie-opencode] Install with: codemie install codemie-opencode');
    }

    return installed;
  }

  /**
   * Install the whitelabel package globally.
   * The package's postinstall.mjs handles platform binary resolution.
   */
  async install(): Promise<void> {
    await installGlobal('@codemieai/codemie-opencode');
  }

  /**
   * Return session adapter for analytics.
   * Reuses OpenCodeSessionAdapter since storage paths are identical.
   */
  getSessionAdapter(): SessionAdapter {
    return this.sessionAdapter;
  }

  /**
   * No extension installer needed.
   */
  getExtensionInstaller(): BaseExtensionInstaller | undefined {
    return undefined;
  }
}
