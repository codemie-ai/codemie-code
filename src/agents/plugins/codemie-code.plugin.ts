import type { AgentMetadata, AgentConfig } from '../core/types.js';
import { join } from 'path';
import { existsSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { getModelConfig, getChatCompletionsModelConfigs, getResponsesApiModelConfigs } from './opencode/opencode-model-configs.js';
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
import { toBedrockModelId } from '../../providers/plugins/bedrock/bedrock.utils.js';
import { MAX_ENV_SIZE, writeConfigToTempFile } from '../core/temp-config.js';
import { ensureSessionFile } from '../core/session/ensure-session.js';

/**
 * Built-in agent name constant - single source of truth
 */
export const BUILTIN_AGENT_NAME = 'codemie-code';

const OPENCODE_SUBCOMMANDS = ['run', 'chat', 'config', 'init', 'help', 'version'];

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
 *
 * Models are split into two groups:
 * - chatModels: routed via codemie-proxy/litellm (Chat Completions API)
 * - responsesApiModels: routed via OpenCode's built-in openai CUSTOM_LOADER (Responses API)
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
  chatModels: Record<string, unknown>;
  responsesApiModels: Record<string, unknown>;
  responsesApiBaseUrl: string | undefined;
}): Record<string, unknown> {
  const hasResponsesApiModels = Object.keys(params.responsesApiModels).length > 0;
  return {
    enabled_providers: ['codemie-proxy', 'openai', 'ollama', 'amazon-bedrock', 'litellm'],
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
          models: params.chatModels
        }
      }),
      // OpenCode's built-in openai CUSTOM_LOADER — uses @ai-sdk/openai sdk.responses()
      // which calls POST /v1/responses instead of /v1/chat/completions
      ...(params.responsesApiBaseUrl && hasResponsesApiModels && {
        openai: {
          name: 'CodeMie SSO',
          // whitelist: suppress the built-in openai model list (GPT-4, GPT-4o, etc.)
          // OpenCode merges user models with models.dev — whitelist restricts to ours only
          whitelist: Object.keys(params.responsesApiModels),
          options: {
            baseURL: `${params.responsesApiBaseUrl}/`,
            apiKey: 'proxy-handled',
            timeout: params.timeout,
            ...(params.providerOptions?.headers && { headers: params.providerOptions.headers })
          },
          models: params.responsesApiModels
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
          models: params.chatModels
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
    { flags: '--plan-only', description: 'Plan without execution' },
    { flags: '--plugin-dir <path>', description: 'Load plugins from specified directory' }
  ],

  isBuiltIn: true,

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
        await ensureSessionFile(sessionId, env, BUILTIN_AGENT_NAME);
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
      const chatModels = getChatCompletionsModelConfigs();
      const responsesApiModels = getResponsesApiModelConfigs();

      const isBedrock = provider === 'bedrock';
      const isLiteLLM = provider === 'litellm';
      const proxyBaseUrl = provider !== 'ollama' && !isBedrock && !isLiteLLM ? baseUrl : undefined;
      const ollamaBaseUrl = resolveOllamaBaseUrl(baseUrl, provider);
      const activeProvider = determineActiveProvider(provider);
      const timeout = providerOptions?.timeout ?? parseInt(env.CODEMIE_TIMEOUT || '600') * 1000;
      const modelId = isBedrock
        ? toBedrockModelId(modelConfig.id, env.AWS_REGION || env.CODEMIE_AWS_REGION)
        : modelConfig.id;

      // Responses API base URL: use proxyBaseUrl for SSO/bearer-auth, or baseUrl for LiteLLM.
      // Always set regardless of selected model — fixes model-switching bug where switching
      // from a Claude model to a GPT model mid-session would miss the CUSTOM_LOADER.
      const responsesApiBaseUrl = proxyBaseUrl || (isLiteLLM ? baseUrl : undefined);
      if (responsesApiBaseUrl && Object.keys(responsesApiModels).length > 0) {
        env.OPENAI_API_KEY = 'proxy-handled';
        logger.debug('[codemie-code] Enabling openai CUSTOM_LOADER for Responses API models');
      }

      const openCodeConfig = buildOpenCodeConfig({
        proxyBaseUrl,
        litellmBaseUrl: isLiteLLM ? baseUrl : undefined,
        litellmApiKey: isLiteLLM ? env.CODEMIE_API_KEY : undefined,
        ollamaBaseUrl, activeProvider, modelId, timeout, providerOptions,
        chatModels, responsesApiModels, responsesApiBaseUrl
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
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          logger.debug(`[codemie-code] Profile config parse failed (non-blocking): ${msg}`);
        }
      }

      // 2b. Merge plugin hooks (lower priority than profile hooks)
      try {
        const { resolvePlugins, readPluginSettings } = await import('../../plugins/core/index.js');
        const { mergeHooks } = await import('../../plugins/loaders/hooks-loader.js');
        const pluginSettings = await readPluginSettings();
        const resolvedPlugins = await resolvePlugins({ cwd: process.cwd(), settings: pluginSettings });

        for (const plugin of resolvedPlugins) {
          if (plugin.enabled && plugin.hooks) {
            mergedHooks = mergeHooks(mergedHooks as any, plugin.hooks) as any;
            logger.debug(`[codemie-code] Merged hooks from plugin "${plugin.manifest.name}"`);
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.debug(`[codemie-code] Plugin hooks merge failed (non-blocking): ${msg}`);
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

        const configPath = writeConfigToTempFile(configJson, 'codemie-code');
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
   * Returns true only if the whitelabel binary is present on disk.
   */
  async isInstalled(): Promise<boolean> {
    const binaryPath = resolveCodemieOpenCodeBinary();
    if (!binaryPath) return false;
    return existsSync(binaryPath);
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
