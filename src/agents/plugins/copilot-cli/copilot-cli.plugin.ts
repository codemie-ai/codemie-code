import type { AgentConfig, AgentMetadata } from '../../core/types.js';
import { BaseAgentAdapter } from '../../core/BaseAgentAdapter.js';
import type { SessionAdapter } from '../../core/session/BaseSessionAdapter.js';
import { CopilotCliSessionAdapter } from './copilot-cli.session.js';
import { ConfigurationError } from '../../../utils/errors.js';
import { commandExists, exec } from '../../../utils/processes.js';
import { logger } from '../../../utils/logger.js';
import {
  COPILOT_CLI_AGENT_NAME,
  COPILOT_CLI_CLIENT_TYPE,
  COPILOT_CLI_DISPLAY_NAME,
} from './copilot-cli.constants.js';
import {
  assertExplicitCopilotModelAllowed,
  resolveCopilotModel,
} from './copilot-cli.models.js';

export {
  COPILOT_CLI_AGENT_NAME,
  COPILOT_CLI_CLIENT_TYPE,
  COPILOT_CLI_DISPLAY_NAME,
} from './copilot-cli.constants.js';

const COPILOT_SUPPORTED_VERSION = '1.0.79';
const COPILOT_MINIMUM_SUPPORTED_VERSION = '1.0.70';
const COPILOT_COMPATIBLE_PROVIDERS = ['ai-run-sso', 'litellm'] as const;
const COPILOT_RECOMMENDED_MODELS = ['gpt-5.5', 'claude-sonnet-4.6', 'gpt-5.4'];

function buildCopilotHookConfig(env: NodeJS.ProcessEnv, sessionId: string) {
  return {
    agentName: env.CODEMIE_AGENT || COPILOT_CLI_AGENT_NAME,
    sessionId,
    provider: env.CODEMIE_PROVIDER,
    apiBaseUrl: env.CODEMIE_BASE_URL,
    ssoUrl: env.CODEMIE_URL,
    syncApiUrl: env.CODEMIE_SYNC_API_URL,
    version: env.CODEMIE_CLI_VERSION,
    profileName: env.CODEMIE_PROFILE_NAME,
    project: env.CODEMIE_PROJECT,
    model: env.CODEMIE_MODEL,
    clientType: COPILOT_CLI_CLIENT_TYPE,
  };
}

function buildCopilotProviderEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  if (!env.CODEMIE_BASE_URL) {
    throw new ConfigurationError(
      'CodeMie base URL is not configured for Copilot CLI. Run codemie setup and try again.'
    );
  }

  if (!env.CODEMIE_MODEL) {
    throw new ConfigurationError(
      'No CodeMie model is configured for Copilot CLI. Run codemie setup or pass --model.'
    );
  }

  const providerType = /^claude/i.test(env.CODEMIE_MODEL) ? 'anthropic' : 'openai';
  const providerEnv: Record<string, string> = {
    COPILOT_PROVIDER_BASE_URL: env.CODEMIE_BASE_URL,
    COPILOT_PROVIDER_TYPE: providerType,
    COPILOT_MODEL: env.CODEMIE_MODEL,
    COPILOT_PROVIDER_MODEL_ID: env.CODEMIE_MODEL,
    COPILOT_PROVIDER_WIRE_MODEL: env.CODEMIE_MODEL,
    COPILOT_OFFLINE: 'true',
  };

  if (/^gpt[-_.]?5/i.test(env.CODEMIE_MODEL)) {
    providerEnv.COPILOT_PROVIDER_WIRE_API = 'responses';
  }

  if (env.CODEMIE_API_KEY) {
    providerEnv.COPILOT_PROVIDER_API_KEY = env.CODEMIE_API_KEY;
    providerEnv.COPILOT_PROVIDER_BEARER_TOKEN = env.CODEMIE_API_KEY;
  }

  return providerEnv;
}

function assertCopilotProviderSupported(config: AgentConfig): void {
  const provider = config.provider;
  if (!provider || !COPILOT_COMPATIBLE_PROVIDERS.includes(provider as (typeof COPILOT_COMPATIBLE_PROVIDERS)[number])) {
    throw new ConfigurationError(
      'GitHub Copilot CLI via CodeMie currently supports only AI/Run SSO and LiteLLM profiles. ' +
      'Run codemie setup to choose a supported provider.'
    );
  }
}

export const CopilotCliPluginMetadata: AgentMetadata = {
  name: COPILOT_CLI_AGENT_NAME,
  displayName: COPILOT_CLI_DISPLAY_NAME,
  description: 'GitHub Copilot CLI - AI coding agent managed by CodeMie',
  npmPackage: '@github/copilot',
  cliCommand: process.env.CODEMIE_COPILOT_BIN || 'copilot',
  supportedVersion: COPILOT_SUPPORTED_VERSION,
  minimumSupportedVersion: COPILOT_MINIMUM_SUPPORTED_VERSION,
  dataPaths: {
    home: '.copilot',
  },
  extensionsConfig: {
    project: '.github',
    global: '~/.copilot',
    skillsEntryFile: 'SKILL.md',
    dirNames: {
      agents: ['agents'],
      commands: [],
      skills: ['skills'],
      hooks: ['hooks'],
      rules: [],
    },
    extraProjectDirs: ['.github/copilot'],
  },
  mcpConfig: {
    project: {
      path: ['.mcp.json', '.github/mcp.json'],
      jsonPath: 'mcpServers',
    },
    user: {
      path: '~/.copilot/mcp-config.json',
      jsonPath: 'mcpServers',
    },
  },
  hookConfig: {
    eventNameMapping: {
      SessionStart: 'SessionStart',
      SessionEnd: 'SessionEnd',
      UserPromptSubmit: 'UserPromptSubmit',
      PreToolUse: 'UserPromptSubmit',
      PostToolUse: 'Stop',
      Notification: 'PermissionRequest',
    },
  },
  envMapping: {
    baseUrl: [],
    apiKey: [],
    model: [],
  },
  supportedProviders: [...COPILOT_COMPATIBLE_PROVIDERS],
  blockedModelPatterns: [/embedding/i, /rerank/i, /whisper/i, /tts/i, /image/i],
  recommendedModels: [...COPILOT_RECOMMENDED_MODELS],
  ssoConfig: {
    enabled: true,
    clientType: COPILOT_CLI_CLIENT_TYPE,
  },
  sessionAnalyticsReport: true,
  flagMappings: {
    '--task': { type: 'flag', target: '--prompt' },
  },
  lifecycle: {
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
          buildCopilotHookConfig(env, sessionId)
        );
        logger.info(`[copilot-cli] SessionStart hook completed for session ${sessionId}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[copilot-cli] SessionStart hook failed (non-blocking): ${message}`);
      }
    },
    async beforeRun(env: NodeJS.ProcessEnv, config: AgentConfig) {
      assertCopilotProviderSupported(config);

      // Prevent fallback to GitHub-native auth even when GitHub credentials exist.
      delete env.GH_TOKEN;
      delete env.GITHUB_TOKEN;
      delete env.COPILOT_TOKEN;

      if (!env.COPILOT_HOME) {
        env.COPILOT_HOME = this.resolveDataPath();
      }

      await this.ensureDirectory(env.COPILOT_HOME);

      const availableModels = (env.CODEMIE_COPILOT_AVAILABLE_MODELS || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (env.CODEMIE_MODEL) {
        assertExplicitCopilotModelAllowed(env.CODEMIE_MODEL, availableModels);
      }

      const providerEnv = buildCopilotProviderEnv(env);
      Object.assign(env, providerEnv);

      logger.debug('[copilot-cli] Prepared provider env for managed Copilot session', {
        provider: config.provider,
        model: env.CODEMIE_MODEL,
        providerType: providerEnv.COPILOT_PROVIDER_TYPE,
        clientType: COPILOT_CLI_CLIENT_TYPE,
      });

      return env;
    },
    enrichArgs(args: string[], _config: AgentConfig): string[] {
      const enriched = [...args];

      const hasPrompt = enriched.includes('-p') || enriched.includes('--prompt');
      const hasAutoApproval = enriched.includes('--allow-all') || enriched.includes('--allow-all-tools') || enriched.includes('--yolo');
      const hasModel = enriched.includes('--model');

      if (hasPrompt && !hasAutoApproval) {
        enriched.push('--allow-all-tools');
      }

      if (!hasModel && process.env.CODEMIE_MODEL) {
        enriched.push('--model', process.env.CODEMIE_MODEL);
      }

      return enriched;
    },
    async onSessionEnd(exitCode: number, env: NodeJS.ProcessEnv) {
      const sessionId = env.CODEMIE_SESSION_ID;
      if (!sessionId) {
        logger.debug('[copilot-cli] No CODEMIE_SESSION_ID in environment, skipping session end');
        return;
      }

      try {
        const adapter = new CopilotCliSessionAdapter(CopilotCliPluginMetadata);
        const sessions = await adapter.discoverSessions({
          maxAgeDays: 1,
          limit: 1,
          cwd: process.cwd(),
        });

        const transcriptPath = sessions[0]?.filePath ?? '';
        const agentSessionId = sessions[0]?.sessionId ?? sessionId;

        const { processEvent } = await import('../../../cli/commands/hook.js');
        await processEvent(
          {
            hook_event_name: 'SessionEnd',
            session_id: agentSessionId,
            transcript_path: transcriptPath,
            permission_mode: 'default',
            cwd: process.cwd(),
            reason: exitCode === 0 ? 'exit' : `exit(${exitCode})`,
          },
          buildCopilotHookConfig(env, sessionId)
        );
        logger.info(`[copilot-cli] SessionEnd hook completed for session ${sessionId}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[copilot-cli] SessionEnd hook failed (non-blocking): ${message}`);
      }
    },
  },
};

export class CopilotCliPlugin extends BaseAgentAdapter {
  private sessionAdapter: SessionAdapter | null = null;

  constructor() {
    super(CopilotCliPluginMetadata);
  }

  getSessionAdapter(): SessionAdapter {
    if (!this.sessionAdapter) {
      this.sessionAdapter = new CopilotCliSessionAdapter(this.metadata);
    }
    return this.sessionAdapter;
  }

  protected override async setupProxy(env: NodeJS.ProcessEnv): Promise<void> {
    if (env.CODEMIE_PROVIDER !== 'ai-run-sso' && env.CODEMIE_AUTH_METHOD !== 'jwt') {
      await super.setupProxy(env);
      return;
    }

    const modelSource = env.CODEMIE_MODEL_SOURCE;
    const explicitModel = env.CODEMIE_MODEL && (modelSource === 'cli' || modelSource === 'env')
      ? env.CODEMIE_MODEL
      : undefined;
    const { selectedModel, availableModels } = await resolveCopilotModel(env);

    if (explicitModel) {
      assertExplicitCopilotModelAllowed(explicitModel, availableModels);
      env.CODEMIE_MODEL = explicitModel;
    } else {
      env.CODEMIE_MODEL = selectedModel;
    }

    env.CODEMIE_COPILOT_AVAILABLE_MODELS = availableModels.join(',');

    await super.setupProxy(env);
  }

  override async isInstalled(): Promise<boolean> {
    if (!this.metadata.cliCommand) {
      return true;
    }
    return commandExists(this.metadata.cliCommand);
  }

  override async getVersion(): Promise<string | null> {
    if (!this.metadata.cliCommand) {
      return null;
    }

    try {
      const result = await exec(this.metadata.cliCommand, ['--version']);
      const match = result.stdout.trim().match(/(\d+\.\d+\.\d+)/);
      return match ? match[1] : result.stdout.trim() || null;
    } catch {
      return null;
    }
  }
}
