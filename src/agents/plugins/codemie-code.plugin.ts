import type { AgentMetadata, AgentConfig } from '../core/types.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { getModelConfig, getAllOpenCodeModelConfigs } from './opencode/opencode-model-configs.js';
import { BaseAgentAdapter } from '../core/BaseAgentAdapter.js';
import type { SessionAdapter } from '../core/session/BaseSessionAdapter.js';
import type { BaseExtensionInstaller } from '../core/extension/BaseExtensionInstaller.js';
import { installGlobal, uninstallGlobal } from '../../utils/processes.js';
import { OpenCodeSessionAdapter } from './opencode/opencode.session.js';
import { resolveCodemieOpenCodeBinary, getPlatformPackage } from './codemie-code-binary.js';
import { getHooksPluginFileUrl, cleanupHooksPlugin } from './codemie-code-hooks/index.js';
import { getReasoningSanitizerPluginUrl, cleanupReasoningSanitizerPlugin } from './reasoning-sanitizer/index.js';
import { getCodemieHome } from '../../utils/paths.js';
import type { HookProcessingConfig } from '../../cli/commands/hook.js';
import { CodeMieCode } from '../codemie-code/index.js';
import { loadCodeMieConfig } from '../codemie-code/config.js';

/**
 * Built-in agent name constant - single source of truth
 */
export const BUILTIN_AGENT_NAME = 'codemie-code';

const OPENCODE_SUBCOMMANDS = ['run', 'chat', 'config', 'init', 'help', 'version'];

/**
 * Convert a short model ID to Bedrock inference profile format.
 * Bedrock requires region-prefixed ARN-style model IDs.
 *
 * Examples:
 *   claude-sonnet-4-5-20250929 → us.anthropic.claude-sonnet-4-5-20250929-v1:0
 *   claude-opus-4-6            → us.anthropic.claude-opus-4-6-v1:0
 *
 * If the model ID already contains 'anthropic.', it's returned as-is.
 */
function toBedrockModelId(modelId: string, region?: string): string {
  if (modelId.includes('anthropic.')) return modelId;

  const regionPrefix = region?.startsWith('eu') ? 'eu'
    : region?.startsWith('ap') ? 'ap'
    : 'us';

  return `${regionPrefix}.anthropic.${modelId}-v1:0`;
}

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
        logger.debug(`[codemie-code] Cleaned up temp config: ${file}`);
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
    `codemie-code-config-${process.pid}-${Date.now()}.json`
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
    const { SessionStore } = await import('../core/session/SessionStore.js');
    const sessionStore = new SessionStore();

    const existing = await sessionStore.loadSession(sessionId);
    if (existing) {
      logger.debug('[codemie-code] Session file already exists');
      return;
    }

    const agentName = env.CODEMIE_AGENT || 'codemie-code';
    const provider = env.CODEMIE_PROVIDER || 'unknown';
    const project = env.CODEMIE_PROJECT;
    const workingDirectory = process.cwd();

    let gitBranch: string | undefined;
    try {
      const { detectGitBranch } = await import('../../utils/processes.js');
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
    logger.debug('[codemie-code] Created session metadata file');

  } catch (error) {
    logger.warn('[codemie-code] Failed to create session file:', error);
  }
}

/**
 * Map user-facing provider name to OpenCode's internal provider identifier.
 */
function determineActiveProvider(provider: string | undefined): string {
  if (provider === 'ollama') return 'ollama';
  if (provider === 'bedrock') return 'amazon-bedrock';
  if (provider === 'litellm') return 'litellm';
  return 'codemie-proxy';
}

/**
 * Get the base storage path for OpenCode sessions.
 * Used by both beforeRun (XDG_DATA_HOME) and onSessionEnd (OPENCODE_STORAGE_PATH).
 */
function getOpenCodeStorageBase(): string {
  return join(getCodemieHome(), 'opencode-storage');
}

/**
 * Build a hook config object from environment variables.
 * Used by both onSessionStart and onSessionEnd lifecycle hooks.
 */
function buildHookConfig(env: NodeJS.ProcessEnv, sessionId: string): HookProcessingConfig {
  return {
    agentName: env.CODEMIE_AGENT || BUILTIN_AGENT_NAME,
    sessionId,
    provider: env.CODEMIE_PROVIDER,
    apiBaseUrl: env.CODEMIE_BASE_URL,
    ssoUrl: env.CODEMIE_URL,
    version: env.CODEMIE_CLI_VERSION,
    profileName: env.CODEMIE_PROFILE_NAME,
    project: env.CODEMIE_PROJECT,
    model: env.CODEMIE_MODEL,
    clientType: 'codemie-code',
  };
}

/**
 * Normalize the Ollama base URL to include /v1 suffix.
 * Non-ollama providers get the default localhost URL.
 */
function resolveOllamaBaseUrl(baseUrl: string, provider: string | undefined): string {
  if (provider !== 'ollama') return 'http://localhost:11434/v1';
  if (baseUrl.endsWith('/v1') || baseUrl.includes('/v1/')) return baseUrl;
  return `${baseUrl.replace(/\/$/, '')}/v1`;
}

/**
 * Build the OpenCode config object that gets passed to the whitelabel binary.
 */
function buildOpenCodeConfig(params: {
  proxyBaseUrl: string | undefined;
  litellmBaseUrl: string | undefined;
  litellmApiKey: string | undefined;
  ollamaBaseUrl: string;
  activeProvider: string;
  modelId: string;
  timeout: number;
  providerOptions?: any;
  allModels: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    enabled_providers: ['codemie-proxy', 'ollama', 'amazon-bedrock', 'litellm'],
    share: 'disabled',
    provider: {
      ...(params.proxyBaseUrl && {
        'codemie-proxy': {
          npm: '@ai-sdk/openai-compatible',
          name: 'CodeMie SSO',
          options: {
            baseURL: `${params.proxyBaseUrl}/`,
            apiKey: 'proxy-handled',
            timeout: params.timeout,
            ...(params.providerOptions?.headers && { headers: params.providerOptions.headers })
          },
          models: params.allModels
        }
      }),
      ...(params.litellmBaseUrl && {
        litellm: {
          npm: '@ai-sdk/openai-compatible',
          name: 'LiteLLM',
          options: {
            baseURL: `${params.litellmBaseUrl.replace(/\/$/, '')}/`,
            apiKey: params.litellmApiKey || 'not-required',
            timeout: params.timeout,
          },
          models: params.allModels
        }
      }),
      ollama: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Ollama',
        options: {
          baseURL: `${params.ollamaBaseUrl}/`,
          apiKey: 'ollama',
          timeout: params.timeout,
        }
      }
    },
    model: `${params.activeProvider}/${params.modelId}`
  };
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
 * | OPENCODE_DISABLE_SHARE   | beforeRun hook       | Whitelabel           | Disables share functionality                   |
 * | CODEMIE_SESSION_ID       | BaseAgentAdapter     | onSessionEnd hook    | Session ID for metrics correlation             |
 * | CODEMIE_AGENT            | BaseAgentAdapter     | Lifecycle helpers    | Agent name ('codemie-code')                    |
 * | CODEMIE_PROVIDER         | Config loader        | setupProxy()         | Provider name (e.g., 'ai-run-sso')             |
 * | CODEMIE_BASE_URL         | setupProxy()         | beforeRun hook       | Proxy URL (http://localhost:{port})             |
 * | CODEMIE_MODEL            | Config/CLI           | beforeRun hook       | Selected model ID                              |
 * | CODEMIE_PROJECT          | SSO exportEnvVars    | Session metadata     | CodeMie project name                           |
 */
export const CodeMieCodePluginMetadata: AgentMetadata = {
  name: BUILTIN_AGENT_NAME,
  displayName: 'CodeMie Code',
  description: 'CodeMie Code - AI coding assistant',

  npmPackage: '@codemieai/codemie-opencode',
  cliCommand: resolvedBinary || null,

  dataPaths: {
    home: '.opencode'
  },

  ownedSubcommands: OPENCODE_SUBCOMMANDS,

  customOptions: [
    { flags: '--task <task>', description: 'Execute a single task and exit' },
    { flags: '--debug', description: 'Enable debug logging' },
    { flags: '--plan', description: 'Enable planning mode' },
    { flags: '--plan-only', description: 'Plan without execution' }
  ],

  isBuiltIn: true,

  // Custom handler for built-in agent.
  // Receives the original (pre-enrichArgs) args from BaseAgentAdapter so that
  // --task, --debug, --plan, --plan-only can be parsed reliably.
  // The `options` parameter is always {} (reserved); args parsing is authoritative.
  customRunHandler: async (args, _options, agentConfig) => {
    try {
      // Check if we have a valid configuration first
      const workingDir = process.cwd();

      // Use profile from AgentConfig (set by BaseAgentAdapter from CODEMIE_PROFILE_NAME)
      // or fall back to environment variable set by AgentCLI
      const profileName = agentConfig?.profileName || process.env.CODEMIE_PROFILE_NAME;

      try {
        await loadCodeMieConfig(workingDir, profileName ? { name: profileName } : undefined);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('Configuration loading failed:', errorMessage);
        throw new Error(`CodeMie configuration required: ${errorMessage}. Please run: codemie setup`);
      }

      // Welcome/goodbye messages are shown by BaseAgentAdapter (which invokes this handler).
      // Parse agent-specific flags from original args (--debug, --task, --plan, --plan-only).
      const debug = args.includes('--debug');
      const taskIdx = args.indexOf('--task');
      const task = taskIdx !== -1 && taskIdx < args.length - 1 ? args[taskIdx + 1] : undefined;
      const plan = args.includes('--plan');
      const planOnly = args.includes('--plan-only');
      // Remaining args (excluding known flags and --task value) are treated as a prompt
      const knownFlags = new Set(['--debug', '--task', '--plan', '--plan-only']);
      const promptArgs = args.filter((a, i) => {
        if (knownFlags.has(a)) return false;
        if (i > 0 && args[i - 1] === '--task') return false;
        return true;
      });

      const codeMie = new CodeMieCode(workingDir);
      await codeMie.initialize({ debug: debug as boolean | undefined });

      if (task) {
        await codeMie.executeTaskWithUI(task, {
          planMode: (plan || planOnly) as boolean | undefined,
          planOnly: planOnly as boolean | undefined
        });
      } else if (promptArgs.length > 0) {
        await codeMie.executeTaskWithUI(promptArgs.join(' '));
        if (!planOnly) {
          await codeMie.startInteractive();
        }
      } else {
        await codeMie.startInteractive();
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to run CodeMie Native: ${errorMessage}`);
    }
  },

  envMapping: {
    baseUrl: [],
    apiKey: [],
    model: []
  },

  supportedProviders: ['litellm', 'ai-run-sso', 'ollama', 'bedrock', 'bearer-auth'],

  ssoConfig: { enabled: true, clientType: 'codemie-code' },

  lifecycle: {
    async onSessionStart(sessionId: string, env: NodeJS.ProcessEnv) {
      try {
        const { processEvent } = await import('../../cli/commands/hook.js');
        const event = {
          hook_event_name: 'SessionStart',
          session_id: sessionId,
          transcript_path: '',
          permission_mode: 'default',
          cwd: process.cwd(),
          source: 'startup',
        };
        await processEvent(event, buildHookConfig(env, sessionId));
        logger.info(`[codemie-code] SessionStart hook completed for session ${sessionId}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[codemie-code] SessionStart hook failed (non-blocking): ${msg}`);
      }
    },

    async beforeRun(env: NodeJS.ProcessEnv, config: AgentConfig) {
      const sessionId = env.CODEMIE_SESSION_ID;
      if (sessionId) {
        // ensureSessionFile handles its own errors internally
        await ensureSessionFile(sessionId, env);
      }

      const provider = env.CODEMIE_PROVIDER;
      const baseUrl = env.CODEMIE_BASE_URL;

      if (!baseUrl) {
        return env;
      }

      if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
        logger.warn(`Invalid CODEMIE_BASE_URL format: ${baseUrl}`, { agent: 'codemie-code' });
        return env;
      }

      const selectedModel = env.CODEMIE_MODEL || config?.model || 'gpt-5-2-2025-12-11';
      const modelConfig = getModelConfig(selectedModel);
      const { providerOptions } = modelConfig;
      const allModels = getAllOpenCodeModelConfigs();

      const isBedrock = provider === 'bedrock';
      const isLiteLLM = provider === 'litellm';
      const proxyBaseUrl = provider !== 'ollama' && !isBedrock && !isLiteLLM ? baseUrl : undefined;
      const ollamaBaseUrl = resolveOllamaBaseUrl(baseUrl, provider);
      const activeProvider = determineActiveProvider(provider);
      const timeout = providerOptions?.timeout ?? parseInt(env.CODEMIE_TIMEOUT || '600') * 1000;
      const modelId = isBedrock
        ? toBedrockModelId(modelConfig.id, env.AWS_REGION || env.CODEMIE_AWS_REGION)
        : modelConfig.id;

      const openCodeConfig = buildOpenCodeConfig({
        proxyBaseUrl,
        litellmBaseUrl: isLiteLLM ? baseUrl : undefined,
        litellmApiKey: isLiteLLM ? env.CODEMIE_API_KEY : undefined,
        ollamaBaseUrl, activeProvider, modelId, timeout, providerOptions, allModels
      });

      // --- Hooks injection ---
      // 1. Build default hooks (always present for session tracking + metrics)
      const defaultHooks: Record<string, unknown[]> = {
        SessionStart: [{ hooks: [{ type: 'command', command: 'codemie hook', timeout: 5 }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command: 'codemie hook', timeout: 10 }] }],
      };

      // 2. Merge profile hooks on top of defaults
      let mergedHooks = { ...defaultHooks };
      if (env.CODEMIE_PROFILE_CONFIG) {
        try {
          const profileConfig = JSON.parse(env.CODEMIE_PROFILE_CONFIG);
          if (profileConfig.hooks && typeof profileConfig.hooks === 'object') {
            mergedHooks = { ...defaultHooks, ...profileConfig.hooks };
            logger.debug('[codemie-code] Merged profile hooks with defaults');
          }
        } catch {
          // Non-critical — profile config parse failure doesn't block startup
        }
      }

      env.OPENCODE_HOOKS = JSON.stringify({ hooks: mergedHooks });

      // 3. Always inject plugins (hooks + reasoning sanitizer)
      (openCodeConfig as Record<string, any>).plugin = (openCodeConfig as Record<string, any>).plugin || [];
      const plugins = (openCodeConfig as Record<string, any>).plugin as string[];

      const hooksPluginUrl = getHooksPluginFileUrl();
      plugins.push(hooksPluginUrl);
      logger.debug(`[codemie-code] Injected hooks plugin: ${hooksPluginUrl}`);

      const sanitizerPluginUrl = getReasoningSanitizerPluginUrl();
      plugins.push(sanitizerPluginUrl);
      logger.debug(`[codemie-code] Injected reasoning-sanitizer plugin: ${sanitizerPluginUrl}`);

      // --- Storage path configuration ---
      // Configure storage path for OpenCode sessions
      // This ensures codemie-opencode writes sessions to a location we can discover
      // OpenCode will use: ${XDG_DATA_HOME}/opencode/storage/
      // Which becomes: ~/.codemie/opencode-storage/opencode/storage/
      env.XDG_DATA_HOME = getOpenCodeStorageBase();

      logger.debug(`[codemie-code] Setting XDG_DATA_HOME=${env.XDG_DATA_HOME} for OpenCode sessions`);

      env.OPENCODE_DISABLE_SHARE = 'true';
      const configJson = JSON.stringify(openCodeConfig);

      if (configJson.length > MAX_ENV_SIZE) {
        logger.warn(`Config size (${configJson.length} bytes) exceeds env var limit (${MAX_ENV_SIZE}), using temp file fallback`, {
          agent: 'codemie-code'
        });

        const configPath = writeConfigToTempFile(configJson);
        logger.debug(`[codemie-code] Wrote config to temp file: ${configPath}`);

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
        logger.debug('[codemie-code] No CODEMIE_SESSION_ID in environment, skipping session end');
        return;
      }

      try {
        // 1. Discover OpenCode session for transcript_path (best effort)
        //    Set OPENCODE_STORAGE_PATH so getOpenCodeStoragePath() resolves to the
        //    same location that beforeRun configured via XDG_DATA_HOME on the child process.
        const expectedStoragePath = join(getOpenCodeStorageBase(), 'opencode', 'storage');
        process.env.OPENCODE_STORAGE_PATH = expectedStoragePath;

        let transcriptPath = '';
        try {
          const adapter = new OpenCodeSessionAdapter(CodeMieCodePluginMetadata);
          const sessions = await adapter.discoverSessions({ maxAgeDays: 1 });
          if (sessions.length > 0) {
            transcriptPath = sessions[0].filePath;
            logger.debug(`[codemie-code] Discovered OpenCode session: ${sessions[0].sessionId}`);
          } else {
            logger.debug('[codemie-code] No recent OpenCode sessions found');
          }
        } catch (discoverError) {
          const msg = discoverError instanceof Error ? discoverError.message : String(discoverError);
          logger.debug(`[codemie-code] Session discovery failed (non-blocking): ${msg}`);
        }

        // 2. Route through processEvent for full SessionEnd pipeline:
        //    accumulateActiveDuration → incrementalSync → syncToAPI →
        //    sendSessionEndMetrics → updateStatus → renameFiles
        const { processEvent } = await import('../../cli/commands/hook.js');
        const event = {
          hook_event_name: 'SessionEnd',
          session_id: sessionId,
          transcript_path: transcriptPath,
          permission_mode: 'default',
          cwd: process.cwd(),
          reason: exitCode === 0 ? 'exit' : `exit(${exitCode})`,
        };
        await processEvent(event, buildHookConfig(env, sessionId));
        logger.info(`[codemie-code] SessionEnd hook completed for session ${sessionId}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`[codemie-code] SessionEnd hook failed (non-blocking): ${errorMessage}`);
      } finally {
        delete process.env.OPENCODE_STORAGE_PATH;
        cleanupHooksPlugin();
        cleanupReasoningSanitizerPlugin();
      }
    }
  }
};

/**
 * CodeMie Code Plugin
 * Wraps the @codemieai/codemie-opencode binary as the built-in agent
 */
export class CodeMieCodePlugin extends BaseAgentAdapter {
  private sessionAdapter: SessionAdapter;

  constructor() {
    super(CodeMieCodePluginMetadata);
    this.sessionAdapter = new OpenCodeSessionAdapter(CodeMieCodePluginMetadata);
  }

  /**
   * Check if the agent is available.
   * Returns true if the whitelabel binary is present, OR if only the built-in
   * CodeMieCode handler is available (always the case when isBuiltIn: true).
   * Warns at log level when the binary is absent so the condition is surfaced
   * by doctor checks and debug sessions rather than silently swallowed.
   */
  async isInstalled(): Promise<boolean> {
    const binaryPath = resolveCodemieOpenCodeBinary();

    if (!binaryPath) {
      // Binary not found in node_modules — falling back to built-in CodeMieCode handler
      logger.warn('[codemie-code] Whitelabel binary not found — running built-in CodeMieCode handler as fallback');
      logger.warn('[codemie-code] Install the binary with: npm i -g @codemieai/codemie-opencode');
      return true; // Built-in handler is always available
    }

    const installed = existsSync(binaryPath);

    if (!installed) {
      // Binary path resolved at load time but the file is now missing
      logger.warn('[codemie-code] Binary path resolved but file not found — running built-in CodeMieCode handler as fallback');
      logger.warn('[codemie-code] Reinstall with: codemie install codemie-code');
    }

    // Binary present (use it) or absent (fall back to built-in handler)
    return true;
  }

  /**
   * Install the whitelabel package globally.
   */
  async install(): Promise<void> {
    await installGlobal('@codemieai/codemie-opencode');
  }

  /**
   * Uninstall the whitelabel package and its platform-specific binary.
   *
   * npm hoists the platform-specific binary package (e.g.
   * @codemieai/codemie-opencode-darwin-arm64) to the top-level global
   * node_modules. `npm uninstall -g @codemieai/codemie-opencode` only removes
   * the wrapper, leaving the binary as an orphan. We explicitly remove both.
   */
  async uninstall(): Promise<void> {
    await uninstallGlobal('@codemieai/codemie-opencode');

    const platformPkg = getPlatformPackage();
    if (platformPkg) {
      try {
        await uninstallGlobal(platformPkg);
      } catch {
        // Platform package may not be hoisted separately — ignore
        logger.debug(`[codemie-code] Platform package ${platformPkg} was not installed separately`);
      }
    }

    // Verify the binary is actually gone
    const remaining = resolveCodemieOpenCodeBinary();
    if (remaining) {
      logger.warn(`[codemie-code] Binary still found after uninstall: ${remaining}`);
      logger.warn('[codemie-code] You may need to manually remove it');
    }
  }

  /**
   * Return session adapter for analytics.
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
