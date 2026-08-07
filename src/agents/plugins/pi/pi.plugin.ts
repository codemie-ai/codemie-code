import type { AgentMetadata, AgentConfig } from '../../core/types.js';
import { BaseAgentAdapter } from '../../core/BaseAgentAdapter.js';
import type { SessionAdapter } from '../../core/session/BaseSessionAdapter.js';
import { logger } from '@/utils/logger.js';
import { preparePiAgentDir } from './pi.setup.js';
import { fetchAndBuildPiModels, classifyPiModel } from './pi.models.js';
import { getPiAgentDir } from './pi.paths.js';
import { installRequiredPiPackages } from './pi.packages.js';
import { PiSessionAdapter } from './pi.session.js';
import type { HookProcessingConfig } from '../../../cli/commands/hook.js';
import type { PiDiscoveryOptions } from './pi.session.js';

function buildPiHookConfig(env: NodeJS.ProcessEnv, sessionId: string): HookProcessingConfig {
  return {
    agentName: env.CODEMIE_AGENT || 'pi',
    sessionId,
    provider: env.CODEMIE_PROVIDER,
    apiBaseUrl: env.CODEMIE_BASE_URL,
    ssoUrl: env.CODEMIE_URL,
    syncApiUrl: env.CODEMIE_SYNC_API_URL,
    version: env.CODEMIE_CLI_VERSION,
    profileName: env.CODEMIE_PROFILE_NAME,
    project: env.CODEMIE_PROJECT,
    model: env.CODEMIE_MODEL,
    clientType: 'codemie-pi',
  };
}

export const PiPluginMetadata: AgentMetadata = {
  name: 'pi',
  displayName: 'Pi',
  description: 'Pi - open-source coding agent harness',
  npmPackage: '@earendil-works/pi-coding-agent',
  cliCommand: process.env.CODEMIE_PI_BIN || 'pi',

  sessionAnalyticsReport: true,

  metricsConfig: {
    excludeErrorsFromTools: ['bash'],
  },

  dataPaths: {
    home: '.pi',
  },

  envMapping: {
    baseUrl: [],
    apiKey: [],
    model: [],
  },

  supportedProviders: ['ai-run-sso', 'bearer-auth', 'litellm'],

  ssoConfig: {
    enabled: true,
    clientType: 'codemie-pi',
  },

  lifecycle: {
    async beforeRun(env: NodeJS.ProcessEnv, _config: AgentConfig) {
      const cwd = process.cwd();
      await preparePiAgentDir(cwd);
      await fetchAndBuildPiModels(env, cwd);
      env.PI_CODING_AGENT_DIR = getPiAgentDir(cwd);
      logger.debug('[pi] Configured PI_CODING_AGENT_DIR', { path: env.PI_CODING_AGENT_DIR });
      return env;
    },

    enrichArgs(args: string[], _config: AgentConfig): string[] {
      const model = process.env.CODEMIE_MODEL;
      if (!model) {
        throw new Error('No model configured for codemie-pi. Run codemie setup to select a model.');
      }

      const classification = classifyPiModel(model);
      const providerId = classification.provider;

      let result = args;

      const taskIndex = result.indexOf('--task');
      if (taskIndex !== -1 && taskIndex < result.length - 1) {
        const taskValue = result[taskIndex + 1];
        result = [...result.slice(0, taskIndex), ...result.slice(taskIndex + 2), taskValue];
      }

      return ['--provider', providerId, '--model', model, ...result];
    },

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
          buildPiHookConfig(env, sessionId)
        );
        logger.info(`[pi] SessionStart hook completed for session ${sessionId}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[pi] SessionStart hook failed (non-blocking): ${msg}`);
      }
    },

    async onSessionEnd(exitCode: number, env: NodeJS.ProcessEnv) {
      const sessionId = env.CODEMIE_SESSION_ID;
      if (!sessionId) {
        logger.debug('[pi] No CODEMIE_SESSION_ID in environment, skipping session end');
        return;
      }

      // Load the CodeMie session so we can correlate the Pi transcript to this run
      // and bound entry processing to the current run's time window.
      let runStartedAt: number | undefined;
      try {
        const { SessionStore } = await import('../../core/session/SessionStore.js');
        const sessionStore = new SessionStore();
        const session = await sessionStore.loadSession(sessionId);
        runStartedAt = session?.startTime;
      } catch (sessionLoadError) {
        const msg = sessionLoadError instanceof Error ? sessionLoadError.message : String(sessionLoadError);
        logger.debug(`[pi] Session load failed (non-blocking): ${msg}`);
      }

      let transcriptPath = '';
      try {
        const adapter = new PiSessionAdapter(PiPluginMetadata);
        const discoverOptions: PiDiscoveryOptions = {
          maxAgeDays: 1,
          limit: 1,
          cwd: process.cwd(),
          runStartedAt,
          agentSessionId: env.PI_SESSION_ID,
        };

        const sessions = await adapter.discoverSessions(discoverOptions);
        if (sessions.length > 0) {
          transcriptPath = sessions[0].filePath;
          logger.debug(`[pi] Discovered Pi session: ${sessions[0].sessionId}`);
        } else {
          logger.debug('[pi] No recent Pi sessions found for this directory');
        }
      } catch (discoverError) {
        const msg = discoverError instanceof Error ? discoverError.message : String(discoverError);
        logger.debug(`[pi] Session discovery failed (non-blocking): ${msg}`);
      }

      try {
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
          buildPiHookConfig(env, sessionId)
        );
        logger.info(`[pi] SessionEnd hook completed for session ${sessionId}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[pi] SessionEnd hook failed (non-blocking): ${msg}`);
      }
    },
  },
};

export class PiPlugin extends BaseAgentAdapter {
  private sessionAdapter: SessionAdapter;

  constructor() {
    super(PiPluginMetadata);
    this.sessionAdapter = new PiSessionAdapter(PiPluginMetadata);
  }

  getSessionAdapter(): SessionAdapter {
    return this.sessionAdapter;
  }

  async additionalInstallation(
    _options?: import('../../core/types.js').AgentInstallationOptions,
  ): Promise<void> {
    await installRequiredPiPackages({ cliCommand: this.metadata.cliCommand });
  }
}
