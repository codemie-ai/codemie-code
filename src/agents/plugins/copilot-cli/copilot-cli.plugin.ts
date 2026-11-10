import type { AgentConfig, AgentMetadata } from '../../core/types.js';
import { BaseAgentAdapter } from '../../core/BaseAgentAdapter.js';
import { flagValue } from '../../core/flag-transform.js';
import type { SessionAdapter } from '../../core/session/BaseSessionAdapter.js';
import type { SessionStartEvent } from '../../../cli/commands/hook.js';
import { CopilotCliSessionAdapter } from './copilot-cli.session.js';
import { ConfigurationError } from '../../../utils/errors.js';
import { commandExists, exec, wrapperOwnerFromEnv } from '../../../utils/processes.js';
import { logger } from '../../../utils/logger.js';
import {
  COPILOT_CLI_AGENT_NAME,
  COPILOT_CLI_CLIENT_TYPE,
  COPILOT_CLI_DISPLAY_NAME,
  PINNED_NATIVE_SESSION_ENV,
} from './copilot-cli.constants.js';
import { getCopilotHome, getCopilotSessionStateRoot, sameDirectory } from './copilot-cli.paths.js';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { RESUME_SESSION_ENV_KEY } from '../../core/session/types.js';
import { assertSessionStateListable, recordNoTranscript, recordTranscriptCorrelation, transcriptExists } from '../../core/session/no-transcript-correlation.js';
import { FULL_SESSION_UUID } from './copilot-cli.constants.js';
import { isNativeIdSegment } from './copilot-cli.transcript-lookup.js';
import {
  assertExplicitCopilotModelAllowed,
  isCopilotCompatibleModelName,
  resolveCopilotModel,
} from './copilot-cli.models.js';
import { classifyWithPredicate } from '../../core/model-classify.js';

export {
  COPILOT_CLI_AGENT_NAME,
  COPILOT_CLI_CLIENT_TYPE,
  COPILOT_CLI_DISPLAY_NAME,
} from './copilot-cli.constants.js';

// Recommended version (one non-blocking notice on mismatch) and the hard gate
// below which the agent refuses to launch. Rule: the minimum is the previously
// recommended version — when bumping the former, move its old value to the latter.
const COPILOT_SUPPORTED_VERSION = '1.0.92';
const COPILOT_MINIMUM_SUPPORTED_VERSION = '1.0.83';
const COPILOT_COMPATIBLE_PROVIDERS = ['ai-run-sso', 'litellm'] as const;
const COPILOT_RECOMMENDED_MODELS = ['gpt-5.5', 'claude-sonnet-4.6', 'gpt-5.4'];

const CONNECTOR_HOOK_FILE = join('hooks', 'codemie-copilot-cli-hooks.json');

/**
 * With an explicit COPILOT_HOME the user's connector hook file (in the default home) is not
 * loaded, so a managed session would not reach CLI Analytics. Writes the CodeMie-owned hook
 * file into the override when it is missing or different. Never deletes anything: a stale
 * copy is neutralised by the hook-time connector scope check.
 */
export async function syncConnectorHookFile(copilotHome: string): Promise<void> {
  const defaultHome = join(homedir(), '.copilot');
  if (sameDirectory(copilotHome, defaultHome) || !existsSync(join(defaultHome, CONNECTOR_HOOK_FILE))) {
    return;
  }
  try {
    const { buildHookFileContent } = await import('../../../cli/commands/proxy/connectors/copilot-cli-otlp.js');
    const { writeAtomically } = await import('../../../cli/commands/proxy/connectors/vscode.js');
    const target = join(copilotHome, CONNECTOR_HOOK_FILE);
    const content = `${JSON.stringify(buildHookFileContent(), null, 2)}\n`;
    let current: string | undefined;
    try {
      current = await readFile(target, 'utf-8');
    } catch {
      current = undefined;
    }
    if (current !== content) {
      await writeAtomically(target, content);
    }
  } catch (error) {
    logger.warn(`[copilot-cli] could not sync CodeMie hook file into COPILOT_HOME: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Flags that make Copilot pick (or resume) a session itself; CodeMie must not add --session-id.
const COPILOT_SESSION_SELECTION_FLAGS = ['--session-id', '--resume', '-r', '--continue', '--connect'];

/**
 * The id a run goes under: the native session a launch resumes by its full UUID (`--resume`, `-r`,
 * `--session-id`), lower-cased as copilot names its `session-state/<id>/` directory, so the whole run
 * continues that session; else the CodeMie id.
 *
 * A `--continue`, an id prefix or a session name keeps its metrics under the CodeMie id (the start
 * metric goes out before the transcript is known); its conversation goes under the native session
 * once the transcript is located.
 */
function runSessionIdOf(sessionId: string, env: NodeJS.ProcessEnv): string {
  const resumed = env[RESUME_SESSION_ENV_KEY];
  return resumed && FULL_SESSION_UUID.test(resumed) ? resumed.toLowerCase() : sessionId;
}

/**
 * The run's native transcript: a pinned or resumed run's own session exactly (none when it is missing);
 * a session the wrapper could not name (`--continue`, an id prefix, a name) by the run window.
 * With no native transcript the run goes under the CodeMie id, the one its stored correlation names.
 * A stored id that cannot name a session directory is no native id: the record is rewritten to the CodeMie id,
 * since a SessionEnd under that id would read the id left on the record as another generation.
 * Throws when the lookup could not conclude.
 */
async function locateRunTranscript(sessionId: string): Promise<{ runSessionId: string; native?: string }> {
  const { SessionStore } = await import('../../core/session/SessionStore.js');
  const store = new SessionStore();
  const record = await store.loadSession(sessionId);
  const storedId = record?.correlation?.agentSessionId;
  if (record && storedId && !isNativeIdSegment(storedId)) {
    record.correlation = { ...record.correlation, agentSessionId: sessionId };
    await store.saveSession(record);
  }
  const runSessionId = isNativeIdSegment(storedId) ? storedId : sessionId;
  const pinned = process.env[PINNED_NATIVE_SESSION_ENV] === sessionId;
  if (pinned || runSessionId !== sessionId || !record) {
    if (record) assertSessionStateListable(record);
    const eventsFile = join(getCopilotSessionStateRoot(record?.agentHome), runSessionId, 'events.jsonl');
    return transcriptExists(eventsFile) ? { runSessionId, native: eventsFile } : { runSessionId: sessionId };
  }
  const [native] = await new CopilotCliSessionAdapter(CopilotCliPluginMetadata).locateTranscript(record);
  return { runSessionId, native };
}

/**
 * Stores the run's exit reason on its still active record before anything can stop the close: a thrown lookup or
 * read, or a session file lock timeout, which throws nothing and leaves the record active. The synthetic end that
 * closes such a record later ends with it; a SessionEnd that closes the record writes the same reason itself. Nothing
 * else reads it on an active record. A failure here is only logged: the SessionEnd goes on as it would without it.
 */
async function keepExitReason(sessionId: string, reason: string): Promise<void> {
  try {
    const { SessionStore } = await import('../../core/session/SessionStore.js');
    const store = new SessionStore();
    const record = await store.loadSession(sessionId);
    if (record?.status === 'active') await store.saveSession({ ...record, reason });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[copilot-cli] Could not keep the exit reason of session ${sessionId}: ${message}`);
  }
}

function buildCopilotHookConfig(env: NodeJS.ProcessEnv, sessionId: string) {
  return {
    agentName: env.CODEMIE_AGENT || COPILOT_CLI_AGENT_NAME,
    sessionId,
    provider: env.CODEMIE_PROVIDER,
    apiBaseUrl: env.CODEMIE_BASE_URL,
    ssoUrl: env.CODEMIE_URL,
    env,
    syncApiUrl: env.CODEMIE_SYNC_API_URL,
    version: env.CODEMIE_CLI_VERSION,
    profileName: env.CODEMIE_PROFILE_NAME,
    project: env.CODEMIE_PROJECT,
    model: env.CODEMIE_MODEL,
    clientType: COPILOT_CLI_CLIENT_TYPE,
    rethrowFlushFailure: true,
    ...wrapperOwnerFromEnv(env),
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
  classifyModel: (id, ctx) => classifyWithPredicate(isCopilotCompatibleModelName, id, ctx),
  activeModelOnly: true, // no in-session model switcher
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
        const start: SessionStartEvent = {
          hook_event_name: 'SessionStart',
          session_id: runSessionIdOf(sessionId, env),
          transcript_path: '',
          permission_mode: 'default',
          cwd: process.cwd(),
          source: 'startup',
          agent_home: resolve(process.cwd(), getCopilotHome(env)),
        };
        await processEvent(start, buildCopilotHookConfig(env, sessionId));
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

      const copilotHome = env.COPILOT_HOME || this.resolveDataPath();
      env.COPILOT_HOME = copilotHome;
      await this.ensureDirectory(copilotHome);
      await syncConnectorHookFile(copilotHome);

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

      // --task is CodeMie's prompt flag (rewritten to --prompt later by flagMappings);
      // detect it here too so a non-interactive `--task` run still gets tool auto-approval.
      const hasPrompt = enriched.includes('-p') || enriched.includes('--prompt') || enriched.includes('--task');
      const hasAutoApproval = enriched.includes('--allow-all') || enriched.includes('--allow-all-tools') || enriched.includes('--yolo');
      const hasModel = enriched.includes('--model');

      if (hasPrompt && !hasAutoApproval) {
        enriched.push('--allow-all-tools');
      }

      if (!hasModel && process.env.CODEMIE_MODEL) {
        enriched.push('--model', process.env.CODEMIE_MODEL);
      }

      // Pin the native Copilot session UUID to the CodeMie session ID so the native
      // transcript is known exactly instead of being guessed afterwards. Never override a
      // session the user selected (resume/continue/connect/explicit id).
      const selectsSession = enriched.some((arg) =>
        COPILOT_SESSION_SELECTION_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`))
      );
      const codemieSessionId = process.env.CODEMIE_SESSION_ID;
      if (codemieSessionId && !selectsSession) {
        enriched.push('--session-id', codemieSessionId);
        process.env[PINNED_NATIVE_SESSION_ENV] = codemieSessionId;
      } else {
        delete process.env[PINNED_NATIVE_SESSION_ENV];
      }

      return enriched;
    },
    async onSessionEnd(exitCode: number, env: NodeJS.ProcessEnv) {
      const sessionId = env.CODEMIE_SESSION_ID;
      if (!sessionId) {
        logger.debug('[copilot-cli] No CODEMIE_SESSION_ID in environment, skipping session end');
        return;
      }

      const reason = exitCode === 0 ? 'exit' : `exit(${exitCode})`;
      try {
        await keepExitReason(sessionId, reason);

        // Native Copilot session events live under COPILOT_HOME, which may be a custom path.
        if (env.COPILOT_HOME) process.env.COPILOT_HOME = env.COPILOT_HOME;

        const { runSessionId, native } = await locateRunTranscript(sessionId);
        // Must land before SessionEnd renames the record to completed_{id}.json.
        if (native) {
          await recordTranscriptCorrelation(sessionId, native);
        } else {
          logger.warn('[copilot-cli] No native Copilot transcript for this run; not correlated');
          await recordNoTranscript(sessionId);
        }

        const { processEvent } = await import('../../../cli/commands/hook.js');
        await processEvent(
          {
            hook_event_name: 'SessionEnd',
            session_id: runSessionId,
            transcript_path: native ?? '',
            permission_mode: 'default',
            cwd: process.cwd(),
            reason,
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

  /** The session the launch names in copilot's own forms: `-r <id>`, `--session-id <id>` / `--session-id=<id>`. */
  extractNativeResumeId(args: string[]): string | undefined {
    return flagValue(args, ['-r', '--session-id']);
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
