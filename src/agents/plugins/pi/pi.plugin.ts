import type { AgentMetadata, AgentConfig } from '../../core/types.js';
import { BaseAgentAdapter } from '../../core/BaseAgentAdapter.js';
import type { SessionAdapter } from '../../core/session/BaseSessionAdapter.js';
import { logger } from '@/utils/logger.js';
import { preparePiAgentDir } from './pi.setup.js';
import { fetchAndBuildPiModels, classifyPiModel } from './pi.models.js';
import { getPiAgentDir, resolvePiSessionDir } from './pi.paths.js';
import { installRequiredPiPackages } from './pi.packages.js';
import { PiSessionAdapter } from './pi.session.js';
import type { HookProcessingConfig } from '../../../cli/commands/hook.js';
import type { PiDiscoveryOptions } from './pi.session.js';

/**
 * Pi flags that select an existing session. Pi rejects `--session-id` when any of
 * them is present (`validateSessionIdFlags` in Pi's `main.ts` calls `process.exit(1)`),
 * so the injected id must be suppressed for these runs. `--fork` is deliberately
 * absent: Pi allows `--fork` together with `--session-id` and uses the id to name
 * the forked session.
 */
const PI_SESSION_SELECTION_FLAGS = ['--session', '--continue', '-c', '--resume', '-r'];

/** Marks a run whose argv already determines the session identity, so none is minted. */
const PI_SESSION_SELECTED_ENV = 'CODEMIE_PI_SESSION_SELECTED';

/**
 * Read the value of a `<flag> <value>` pair. Pi's parser only accepts the
 * space-separated form, so `--flag=value` is deliberately not matched, and it
 * assigns on every occurrence, so the last one wins.
 */
function readFlagValue(args: string[], flag: string): string | undefined {
  const index = args.lastIndexOf(flag);
  return index !== -1 && index + 1 < args.length ? args[index + 1] : undefined;
}

function hasSessionSelectionFlag(args: string[]): boolean {
  return PI_SESSION_SELECTION_FLAGS.some((flag) => args.includes(flag));
}

/**
 * Reconcile CodeMie's CLI surface with Pi's session flags before the run starts.
 *
 * Two argv-derived facts are needed later by hooks that cannot see argv:
 * `beforeRun` receives only `env`, and `enrichArgs` receives no env at all. Both
 * are published through `envOverrides`, which `BaseAgentAdapter` spreads into the
 * run-scoped `env` object that also reaches `onSessionEnd` and session discovery.
 */
export function preparePiInvocation(
  args: string[],
  envOverrides?: Record<string, string>
): { args: string[]; envOverrides: Record<string, string> } {
  // CodeMie declares `--resume <session-id>`, but Pi's `--resume`/`-r` is a boolean
  // that opens an interactive picker, which would leave the id as a bare positional
  // and send it to the model as a chat message. `--session <id>` is Pi's
  // value-taking "open this session and keep appending" flag. If the user also
  // passed `--session`, theirs wins in Pi and this pair is dropped rather than
  // rewritten, so a second `--session` cannot shadow it and the orphaned id cannot
  // leak into the conversation.
  const resumeIndex = args.indexOf('--resume');
  const hasResumeValue = resumeIndex !== -1 && resumeIndex + 1 < args.length;
  let piArgs = args;
  if (hasResumeValue) {
    piArgs = args.includes('--session')
      ? [...args.slice(0, resumeIndex), ...args.slice(resumeIndex + 2)]
      : args.map((arg, index) => (index === resumeIndex ? '--session' : arg));
  }

  const overrides: Record<string, string> = { ...envOverrides };

  // `--session-dir` is an unknown option to CodeMie's parser and reaches Pi verbatim,
  // so discovery would otherwise scan a directory Pi never writes to. Seed the raw
  // value; resolvePiSessionDir performs the tilde expansion Pi also applies.
  const sessionDir = readFlagValue(piArgs, '--session-dir');
  if (sessionDir) {
    overrides.PI_CODING_AGENT_SESSION_DIR = sessionDir;
  }

  // Pi opens a named session in place, so its transcript header carries that id and
  // discovery can still match on identity. `--session-id` is handled here too — it is
  // not a conflicting flag (Pi allows `--fork --session-id`), but it does mean the
  // caller has already chosen the id, so CodeMie must not mint and publish its own.
  // `--continue` and bare `--resume` name no session up front, leaving identity
  // genuinely unknown for that run.
  const userSessionId = readFlagValue(piArgs, '--session-id');
  if (hasSessionSelectionFlag(piArgs) || userSessionId) {
    overrides[PI_SESSION_SELECTED_ENV] = '1';
    const targetSessionId = readFlagValue(piArgs, '--session') ?? userSessionId;
    if (targetSessionId) {
      overrides.PI_SESSION_ID = targetSessionId;
    }
  }

  return { args: piArgs, envOverrides: overrides };
}

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

      // Establish a stable identity shared between CodeMie and Pi so session
      // discovery can exact-match the transcript instead of guessing by mtime.
      // Runs that select an existing session cannot carry an injected id; their
      // identity, when known at all, was already published by preparePiInvocation.
      if (env.CODEMIE_SESSION_ID && !env[PI_SESSION_SELECTED_ENV]) {
        env.PI_SESSION_ID = env.CODEMIE_SESSION_ID;
        process.env.PI_SESSION_ID = env.CODEMIE_SESSION_ID;
      }

      // Honor session-directory overrides early so both Pi and discovery agree.
      const { sessionDir, isCustom } = resolvePiSessionDir(cwd, env);
      if (isCustom) {
        env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
        process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
      }

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

      result = ['--provider', providerId, '--model', model, ...result];

      // Share CodeMie's session id with Pi so discovery can exact-match the
      // transcript. Pi exits with code 1 if this is combined with a flag that
      // already selects a session, so those runs correlate by run window instead.
      const sessionId = process.env.CODEMIE_SESSION_ID;
      if (sessionId && !result.includes('--session-id') && !hasSessionSelectionFlag(result)) {
        result.push('--session-id', sessionId);
      } else if (sessionId) {
        logger.debug('[pi] Skipping --session-id injection: argv already selects a session');
      }

      // Forward the effective session directory. beforeRun resolved it onto the run
      // env, which BaseAgentAdapter has already merged into process.env. A
      // user-supplied --session-dir is in argv already and takes precedence.
      if (!result.includes('--session-dir') && process.env.PI_CODING_AGENT_SESSION_DIR) {
        result.push('--session-dir', process.env.PI_CODING_AGENT_SESSION_DIR);
      }

      return result;
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

      let transcriptPaths: string[] = [];
      try {
        const adapter = new PiSessionAdapter(PiPluginMetadata);
        const discoverOptions: PiDiscoveryOptions = {
          maxAgeDays: 1,
          cwd: process.cwd(),
          runStartedAt,
          agentSessionId: env.PI_SESSION_ID,
          env,
        };

        const sessions = await adapter.discoverSessions(discoverOptions);
        transcriptPaths = sessions.map((s) => s.filePath);
        if (transcriptPaths.length > 0) {
          logger.debug(`[pi] Discovered Pi session(s): ${transcriptPaths.join(', ')}`);
        } else {
          logger.debug('[pi] No recent Pi sessions found for this directory');
        }
      } catch (discoverError) {
        const msg = discoverError instanceof Error ? discoverError.message : String(discoverError);
        logger.debug(`[pi] Session discovery failed (non-blocking): ${msg}`);
      }

      const reason = env.CODEMIE_EXIT_SIGNAL
        ? `signal(${env.CODEMIE_EXIT_SIGNAL})`
        : exitCode === 0
          ? 'exit'
          : `exit(${exitCode})`;

      try {
        const { processEvent } = await import('../../../cli/commands/hook.js');
        await processEvent(
          {
            hook_event_name: 'SessionEnd',
            session_id: sessionId,
            transcript_path: transcriptPaths[0] ?? '',
            transcript_paths: transcriptPaths.length > 0 ? transcriptPaths : undefined,
            permission_mode: 'default',
            cwd: process.cwd(),
            reason,
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

  /**
   * Translate CodeMie's session flags to Pi's and publish the argv-derived facts
   * that `beforeRun` and `enrichArgs` need but cannot read from argv themselves.
   */
  async run(
    args: string[],
    envOverrides?: Record<string, string>,
    runOptions?: { dryRun?: boolean },
  ): Promise<void> {
    const prepared = preparePiInvocation(args, envOverrides);
    return super.run(prepared.args, prepared.envOverrides, runOptions);
  }

  async additionalInstallation(
    _options?: import('../../core/types.js').AgentInstallationOptions,
  ): Promise<void> {
    await installRequiredPiPackages({ cliCommand: this.metadata.cliCommand });
  }
}
