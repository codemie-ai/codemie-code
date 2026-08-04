import { join } from 'path';
import type { AgentMetadata, AgentConfig } from '../../core/types.js';
import { logger } from '../../../utils/logger.js';
import { getModelConfig, getChatCompletionsModelConfigs, getResponsesApiModelConfigs } from './opencode-model-configs.js';
import { fetchDynamicModelConfigs } from './opencode-dynamic-models.js';
import { BaseAgentAdapter } from '../../core/BaseAgentAdapter.js';
import type { SessionAdapter } from '../../core/session/BaseSessionAdapter.js';
import type { BaseExtensionInstaller } from '../../core/extension/BaseExtensionInstaller.js';
import { commandExists } from '../../../utils/processes.js';
import { OpenCodeSessionAdapter } from './opencode.session.js';
import { getOpenCodeConfigDir, getOpenCodeDbPath, getOpenCodeDataDir } from './opencode.paths.js';
import {
  startOpenCodeIncrementalSync,
  stopOpenCodeIncrementalSync,
} from './opencode.incremental-sync.js';
import { getHooksPluginFileUrl, cleanupHooksPlugin } from '../codemie-code-hooks/index.js';
import type { HookProcessingConfig } from '../../../cli/commands/hook.js';
import { toBedrockModelId } from '../../../providers/plugins/bedrock/bedrock.utils.js';
import { MAX_ENV_SIZE, writeConfigToTempFile } from '../../core/temp-config.js';
import { ensureSessionFile } from '../../core/session/ensure-session.js';

const OPENCODE_SUBCOMMANDS = ['run', 'chat', 'config', 'init', 'help', 'version'];

const OPENCODE_CLIENT_TYPE = 'codemie-opencode';

/**
 * Hooks the CodeMie CLI always registers with OpenCode, on top of anything the
 * user's profile defines. They measure active session time:
 *   UserPromptSubmit → SessionStore.startActivityTracking
 *   Stop             → SessionStore.accumulateActiveDuration + incremental sync
 *
 * Stop is async (detached spawn) because the plugin executes synchronous hooks
 * with execSync, which would otherwise block OpenCode's event loop while the
 * child re-parses SQLite and rewrites JSONL.
 */
const DEFAULT_HOOKS: Record<string, unknown[]> = {
  UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'codemie hook', timeout: 5 }] }],
  Stop: [{ hooks: [{ type: 'command', command: 'codemie hook', timeout: 10, async: true }] }],
};

/**
 * Merge the CodeMie telemetry hooks with any hooks the active profile defines.
 *
 * Entries are appended per event name rather than spread over the object: a
 * shallow spread lets a profile that defines its own Stop or UserPromptSubmit
 * REPLACE the telemetry hook, which silently zeroes active_duration_ms for
 * exactly the users who customise hooks.
 */
function buildMergedHooks(env: NodeJS.ProcessEnv): Record<string, unknown[]> {
  const mergedHooks: Record<string, unknown[]> = { ...DEFAULT_HOOKS };

  if (!env.CODEMIE_PROFILE_CONFIG) {
    return mergedHooks;
  }

  try {
    const profileConfig = JSON.parse(env.CODEMIE_PROFILE_CONFIG);
    if (profileConfig.hooks && typeof profileConfig.hooks === 'object') {
      for (const [eventName, entries] of Object.entries(profileConfig.hooks)) {
        if (!Array.isArray(entries)) {
          logger.warn(`[opencode] Ignoring non-array profile hook entry: ${eventName}`);
          continue;
        }
        mergedHooks[eventName] = [...(mergedHooks[eventName] ?? []), ...entries];
      }
      logger.debug('[opencode] Merged profile hooks with defaults');
    }
  } catch {
    // Non-critical — profile config parse failure doesn't block startup
  }

  return mergedHooks;
}

/**
 * Build a hook config object from environment variables.
 * Used by both onSessionStart and onSessionEnd lifecycle hooks.
 */
function buildHookConfig(env: NodeJS.ProcessEnv, sessionId: string): HookProcessingConfig {
  return {
    agentName: env.CODEMIE_AGENT || 'opencode',
    sessionId,
    provider: env.CODEMIE_PROVIDER,
    apiBaseUrl: env.CODEMIE_BASE_URL,
    ssoUrl: env.CODEMIE_URL,
    version: env.CODEMIE_CLI_VERSION,
    profileName: env.CODEMIE_PROFILE_NAME,
    project: env.CODEMIE_PROJECT,
    model: env.CODEMIE_MODEL,
    clientType: OPENCODE_CLIENT_TYPE,
  };
}

export const OpenCodePluginMetadata: AgentMetadata = {
  name: 'opencode',
  displayName: 'OpenCode CLI',
  description: 'OpenCode - open-source AI coding assistant',
  npmPackage: 'opencode-ai',  // Official npm package (npm i -g opencode-ai)
  cliCommand: process.env.CODEMIE_OPENCODE_BIN || 'opencode',

  sessionAnalyticsReport: true,
  dataPaths: {
    home: '.opencode'
    // NOTE: Session storage is NOT in home - it's in XDG_DATA_HOME/opencode/storage/
    // This is handled by getSessionStoragePath() in opencode.paths.ts
  },
  ownedSubcommands: OPENCODE_SUBCOMMANDS,
  envMapping: {
    baseUrl: [],
    apiKey: [],
    model: []
  },
  supportedProviders: ['litellm', 'ai-run-sso', 'ollama', 'bedrock', 'bearer-auth'],
  ssoConfig: { enabled: true, clientType: OPENCODE_CLIENT_TYPE },

  // Tool names are lower-cased before they reach the aggregator, and
  // filterErrorTools does an exact match — the global default
  // ['Bash','Execute','Shell'] would silently never match here.
  metricsConfig: {
    excludeErrorsFromTools: ['bash'],
  },

  // MCP servers live under a top-level `mcp` key. OpenCode accepts both the
  // .json and .jsonc filenames, so each scope lists candidates in priority order.
  mcpConfig: {
    project: {
      path: ['opencode.json', 'opencode.jsonc'],
      jsonPath: 'mcp',
    },
    local: {
      path: ['.opencode/opencode.json', '.opencode/opencode.jsonc'],
      jsonPath: 'mcp',
    },
    user: {
      path: [
        join(getOpenCodeConfigDir(), 'opencode.json'),
        join(getOpenCodeConfigDir(), 'opencode.jsonc'),
        '~/.opencode/opencode.json',
      ],
      jsonPath: 'mcp',
    },
  },

  // OpenCode accepts singular and plural directory names for every category.
  // Two deliberate mappings:
  //   hooks → plugin/ + plugins/  (OpenCode has no hooks/ directory; plugins are
  //                                the closest equivalent extension point)
  //   rules → []                  (OpenCode has no rules/ concept, so the
  //                                rules_* metric fields stay at zero)
  extensionsConfig: {
    project: '.opencode',
    global: getOpenCodeConfigDir(),
    extraGlobalDirs: ['~/.opencode'],
    skillsEntryFile: 'SKILL.md',
    dirNames: {
      agents: ['agent', 'agents'],
      commands: ['command', 'commands'],
      skills: ['skill', 'skills'],
      hooks: ['plugin', 'plugins'],
      rules: [],
    },
  },

  flagMappings: {
    '--resume': {
      type: 'flag',
      target: '-s',
    },
  },

  reasoningEffort: {
    strategy: 'cli-flag',
    flag: '--variant',
    placement: 'append',
    supportedLevels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    userOverrideFlags: ['--variant'],
  },

  lifecycle: {
    /**
     * Emit the `started` codemie_cli_session_total row and scan MCP/extensions.
     *
     * Runs in-process rather than via a hook: OpenCode's session.created event
     * does not correspond to CLI startup, and this must happen before
     * ensureSessionFile in beforeRun — otherwise the placeholder record with
     * agentSessionId 'unknown' and a fabricated startTime wins, and every
     * downstream metric inherits it.
     *
     * session_id is the CodeMie session UUID: OpenCode's own ses_* id does not
     * exist yet, and using it only at SessionEnd would leave the started and
     * completed rows uncorrelatable.
     *
     * SIDE EFFECT (user-visible, accepted): routing SessionStart through
     * processEvent means handleSessionStart's syncSkillsToClaude step now runs
     * for codemie-opencode too, so running this agent creates
     * `{cwd}/.claude/skills/` in the user's project and copies CodeMie-managed
     * skills into it — the same behaviour codemie-claude has always had.
     * OpenCode does read those skills, so this is intentional rather than
     * incidental, but it means a project where the user only ever ran opencode
     * will now gain a .claude/ directory. Call this out in the release notes
     * for any version that ships this change.
     */
    async onSessionStart(sessionId: string, env: NodeJS.ProcessEnv) {
      try {
        const { processEvent } = await import('../../../cli/commands/hook.js');
        await processEvent(
          {
            hook_event_name: 'SessionStart',
            session_id: sessionId,
            transcript_path: '',
            permission_mode: 'default',
            cwd: process.cwd(),
            source: 'startup',
          },
          buildHookConfig(env, sessionId)
        );
        logger.info(`[opencode] SessionStart hook completed for session ${sessionId}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[opencode] SessionStart hook failed (non-blocking): ${msg}`);
      }

      // Failsafe path for metrics and conversations: everything it reads is
      // already durable in opencode.db, so deltas keep flowing even if the
      // injected plugin never loads.
      startOpenCodeIncrementalSync({
        sessionId,
        startedAt: Date.now(),
        cwd: process.cwd(),
        metadata: OpenCodePluginMetadata,
        buildContext: () => ({
          sessionId,
          apiBaseUrl: env.CODEMIE_SYNC_API_URL || env.CODEMIE_BASE_URL || '',
          cookies: '',
          clientType: OPENCODE_CLIENT_TYPE,
          version: env.CODEMIE_CLI_VERSION || '0.0.0',
          dryRun: false,
          gitBranch: env.CODEMIE_GIT_BRANCH,
        }),
        ssoUrl: env.CODEMIE_URL,
        syncApiUrl: env.CODEMIE_SYNC_API_URL || env.CODEMIE_BASE_URL,
        cliVersion: env.CODEMIE_CLI_VERSION,
      });
    },

    // NOTE: beforeRun signature is (env, config) per AgentLifecycle interface
    // Claude plugin only uses (env), but interface supports both
    async beforeRun(env: NodeJS.ProcessEnv, config: AgentConfig) {
      // Safety net only — onSessionStart normally created the record already,
      // and ensureSessionFile early-returns when it exists.
      const sessionId = env.CODEMIE_SESSION_ID;
      if (sessionId) {
        try {
          await ensureSessionFile(sessionId, env, 'opencode');
        } catch (error) {
          logger.error('[opencode] Failed to create session file in beforeRun', { error });
          // Don't throw - let OpenCode run even if session file creation fails
        }
      }

      // Point the injected plugin at the transcript codemie hook must re-parse.
      // performIncrementalSync skips any event without a transcript_path.
      // getOpenCodeDbPath() gates on existsSync, and the DB is only created once
      // opencode itself first writes it — i.e. after beforeRun. Falling back to
      // the expected location keeps transcript_path non-empty on a first-ever
      // run; without it validateHookEvent rejects every UserPromptSubmit and
      // Stop with exit 2 for that entire first session.
      env.CODEMIE_OPENCODE_TRANSCRIPT = getOpenCodeDbPath() ?? join(getOpenCodeDataDir(), 'opencode.db');

      // Register the telemetry hooks BEFORE the base-URL early returns below.
      // Hook registration does not depend on the proxy config, and leaving it
      // downstream meant any run without CODEMIE_BASE_URL got no turn
      // boundaries at all, so active_duration_ms stayed 0.
      env.OPENCODE_HOOKS = JSON.stringify({ hooks: buildMergedHooks(env) });

      const provider = env.CODEMIE_PROVIDER;
      const baseUrl = env.CODEMIE_BASE_URL;

      if (!baseUrl) {
        return env;
      }

      if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
        logger.warn(`Invalid CODEMIE_BASE_URL format: ${baseUrl}`, { agent: 'opencode' });
        return env;
      }

      // Fetch live model catalogue from the CodeMie API.
      // Falls back to the static OPENCODE_MODEL_CONFIGS on any error.
      const allModels = await fetchDynamicModelConfigs(
        baseUrl,
        env.CODEMIE_URL,
        env.CODEMIE_JWT_TOKEN,
      );

      // Model selection priority: env var > config > default
      // Use dynamic catalogue first, then fall back to static getModelConfig for unknown IDs.
      const selectedModel = env.CODEMIE_MODEL || config?.model || 'gpt-5-2-2025-12-11';
      const modelConfig = allModels[selectedModel] ?? getModelConfig(selectedModel);

      const { providerOptions } = modelConfig;

      // Split models by API routing type
      const chatModels = getChatCompletionsModelConfigs(allModels);
      const responsesApiModels = getResponsesApiModelConfigs(allModels);

      // Determine URLs based on provider type
      const isBedrock = provider === 'bedrock';
      const proxyBaseUrl = provider !== 'ollama' && !isBedrock ? baseUrl : undefined;
      const ollamaBaseUrl = provider === 'ollama'
        ? (baseUrl.endsWith('/v1') || baseUrl.includes('/v1/') ? baseUrl : `${baseUrl.replace(/\/$/, '')}/v1`)
        : 'http://localhost:11434/v1';

      // Determine default model provider
      // - ollama: uses ollama provider directly
      // - bedrock: uses OpenCode's built-in amazon-bedrock provider (AWS env vars set by provider hook)
      // - all others: route through codemie-proxy (SSO/proxy)
      const activeProvider = provider === 'ollama' ? 'ollama' : (isBedrock ? 'amazon-bedrock' : 'codemie-proxy');
      const timeout = providerOptions?.timeout ?? parseInt(env.CODEMIE_TIMEOUT || '600') * 1000;

      // Always enable openai CUSTOM_LOADER when Responses API models exist.
      // This fixes model-switching: if user starts with Claude and switches to GPT,
      // the CUSTOM_LOADER must already be registered.
      if (proxyBaseUrl && Object.keys(responsesApiModels).length > 0) {
        env.OPENAI_API_KEY = 'proxy-handled';
        logger.debug('[opencode] Enabling openai CUSTOM_LOADER for Responses API models');
      }

      const hasResponsesApiModels = Object.keys(responsesApiModels).length > 0;
      const openCodeConfig: Record<string, unknown> = {
        enabled_providers: ['codemie-proxy', 'openai', 'ollama', 'amazon-bedrock'],
        share: 'disabled',
        provider: {
          ...(proxyBaseUrl && {
            'codemie-proxy': {
              npm: '@ai-sdk/openai-compatible',
              name: 'CodeMie SSO',
              options: {
                baseURL: `${proxyBaseUrl}/`,
                apiKey: 'proxy-handled',
                timeout,
                ...(providerOptions?.headers && { headers: providerOptions.headers })
              },
              models: chatModels
            }
          }),
          // Built-in openai CUSTOM_LOADER: routes Responses API models via sdk.responses()
          ...(proxyBaseUrl && hasResponsesApiModels && {
            openai: {
              name: 'CodeMie SSO',
              // whitelist: suppress the built-in openai model list (GPT-4, GPT-4o, etc.)
              // OpenCode merges user models with models.dev — whitelist restricts to ours only
              whitelist: Object.keys(responsesApiModels),
              options: {
                baseURL: `${proxyBaseUrl}/`,
                apiKey: 'proxy-handled',
                timeout,
                ...(providerOptions?.headers && { headers: providerOptions.headers })
              },
              models: responsesApiModels
            }
          }),
          ollama: {
            npm: '@ai-sdk/openai-compatible',
            name: 'Ollama',
            options: {
              baseURL: `${ollamaBaseUrl}/`,
              apiKey: 'ollama',
              timeout,
            }
          }
        },
        model: `${activeProvider}/${isBedrock ? toBedrockModelId(modelConfig.id, env.AWS_REGION || env.CODEMIE_AWS_REGION) : modelConfig.id}`
      };

      // Inject the shell-hooks plugin — it is what delivers OPENCODE_HOOKS
      // (already registered above, before the base-URL early return) to
      // `codemie hook`. Only this half genuinely depends on the proxy config.
      const pluginUrl = getHooksPluginFileUrl();
      openCodeConfig.plugin = (openCodeConfig.plugin as string[] | undefined) || [];
      (openCodeConfig.plugin as string[]).push(pluginUrl);
      logger.debug(`[opencode] Injected hooks plugin: ${pluginUrl}`);

      env.OPENCODE_DISABLE_SHARE = 'true';
      const configJson = JSON.stringify(openCodeConfig);

      // Config injection strategy:
      // 1. Primary: OPENCODE_CONFIG_CONTENT env var (inline JSON)
      // 2. Fallback: OPENCODE_CONFIG env var pointing to temp file
      // See tech spec ADR-002 and "Fallback Strategy" section
      if (configJson.length > MAX_ENV_SIZE) {
        logger.warn(`Config size (${configJson.length} bytes) exceeds env var limit (${MAX_ENV_SIZE}), using temp file fallback`, {
          agent: 'opencode'
        });

        const configPath = writeConfigToTempFile(configJson, 'opencode');
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
        // Message is a positional arg: `opencode run <message>`
        // Note: -m in upstream opencode-ai means --model, NOT --message.
        return ['run', taskValue, ...otherArgs];
      }
      return args;
    },

    /**
     * Close out the session: flush remaining deltas and conversations, upload
     * them, emit the `completed` codemie_cli_session_total row, and archive the
     * spool files.
     *
     * Routed through processEvent rather than calling the adapter directly, so
     * the full SessionEnd pipeline runs in the right order:
     *   accumulateActiveDuration → incremental sync → SessionSyncer upload →
     *   session-end metrics → status update → rename to completed_*
     *
     * The previous implementation only wrote JSONL, with an empty cookie jar
     * and no SessionSyncer call, and relied on the proxy's shutdown timer to
     * upload whatever happened to be on disk.
     */
    async onSessionEnd(exitCode: number, env: NodeJS.ProcessEnv) {
      const sessionId = env.CODEMIE_SESSION_ID;

      if (!sessionId) {
        logger.debug('[opencode] No CODEMIE_SESSION_ID in environment, skipping session end');
        return;
      }

      stopOpenCodeIncrementalSync(sessionId);

      try {
        // Discover the transcript to re-parse. Constrained to this working
        // directory: the CLI reads the user's shared opencode.db, which holds
        // sessions from every project they have open.
        let transcriptPath = '';
        try {
          const adapter = new OpenCodeSessionAdapter(OpenCodePluginMetadata);
          const sessions = await adapter.discoverSessions({
            maxAgeDays: 1,
            limit: 1,
            cwd: process.cwd(),
          });
          if (sessions.length > 0) {
            transcriptPath = sessions[0].filePath;
            logger.debug(`[opencode] Discovered OpenCode session: ${sessions[0].sessionId}`);
          } else {
            logger.debug('[opencode] No recent OpenCode sessions found for this directory');
          }
        } catch (discoverError) {
          const msg = discoverError instanceof Error ? discoverError.message : String(discoverError);
          logger.debug(`[opencode] Session discovery failed (non-blocking): ${msg}`);
        }

        const { processEvent } = await import('../../../cli/commands/hook.js');
        await processEvent(
          {
            hook_event_name: 'SessionEnd',
            session_id: sessionId,
            transcript_path: transcriptPath,
            permission_mode: 'default',
            cwd: process.cwd(),
            reason: exitCode === 0 ? 'exit' : `exit(${exitCode})`,
          },
          buildHookConfig(env, sessionId)
        );
        logger.info(`[opencode] SessionEnd hook completed for session ${sessionId}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`[opencode] SessionEnd hook failed (non-blocking): ${errorMessage}`);
        // Don't throw - metrics failure shouldn't block exit
      } finally {
        cleanupHooksPlugin();
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
