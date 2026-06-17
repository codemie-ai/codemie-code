// src/agents/plugins/codex/codex.plugin.ts
/**
 * Codex Agent Plugin
 *
 * Registers OpenAI Codex CLI (@openai/codex) as a selectable agent in CodeMie.
 *
 * Config injection strategy:
 * - CODEMIE_BASE_URL  → OPENAI_BASE_URL  (env var, picked up natively by Codex)
 * - CODEMIE_API_KEY   → OPENAI_API_KEY + CODEMIE_API_KEY (env vars via transformEnvVars)
 * - Model injected via: --model <model>
 * - Provider: model_providers.codemie with env_key=CODEMIE_API_KEY (bypasses ~/.codex/auth.json)
 *   auth.json has highest priority for the default openai provider; a custom provider with
 *   env_key pointing to CODEMIE_API_KEY bypasses it since auth.json only covers openai.
 *
 * Session lifecycle (CLI-level via processEvent):
 * 1. onSessionStart  → processEvent(SessionStart) — creates session record + sends start metrics
 *                    → startCodexIncrementalSync — kicks off the in-process timer
 * 2. enrichArgs      → transform --task, inject --model + model_providers.codemie + tuning flags
 * 3. [Codex runs]
 * 4. onSessionEnd    → stopCodexIncrementalSync → process rollout → processEvent(SessionEnd)
 *
 * Why no Codex hooks?
 * Codex 0.129.0 advertises a `hooks` feature (stable per `codex features list`),
 * but smoke tests on 2026-05-09 showed that neither -c overrides
 * (`-c 'hooks.SessionStart=[...]'`) nor a direct `[[hooks.SessionStart]]` block
 * in `~/.codex/config.toml` fired the configured command in `codex exec`.
 * See docs/superpowers/plans/2026-05-09-codex-hooks-incremental-sync.md
 * and https://github.com/openai/codex/issues/17532.
 *
 * Until the actual hook delivery mechanism is documented (likely tied to the
 * `~/.codex/plugins/<name>/.codex-plugin/plugin.json` plugin manifest format),
 * we run an in-process timer (codex.incremental-sync.ts) inside `codemie-cli`
 * to keep `_metrics.jsonl` and `_conversation.jsonl` warm. The SSO proxy timer
 * (sso.session-sync.plugin.ts) handles the API push as usual.
 *
 * References:
 * - OpenAI Codex CLI: https://github.com/openai/codex
 * - Configuration: https://github.com/openai/codex/blob/main/codex-rs/docs/configuration.md
 * - Advanced config: https://developers.openai.com/codex/config-advanced
 * - CLI Reference: https://github.com/openai/codex/blob/main/codex-rs/docs/cli-reference.md
 * - Hooks (deferred): https://developers.openai.com/codex/hooks
 */

import type { AgentMetadata, AgentConfig } from '../../core/types.js';
import { BaseAgentAdapter } from '../../core/BaseAgentAdapter.js';
import type { SessionAdapter } from '../../core/session/BaseSessionAdapter.js';
import type { SessionDescriptor } from '../../core/session/discovery-types.js';
import type { BaseExtensionInstaller } from '../../core/extension/BaseExtensionInstaller.js';
import type { HookProcessingConfig } from '../../../cli/commands/hook.js';
import { commandExists, exec } from '../../../utils/processes.js';
import { logger } from '../../../utils/logger.js';
import { ConfigurationError } from '../../../utils/errors.js';
import { CodexSessionAdapter } from './codex.session.js';
import {
  assertExplicitCodexModelAllowed,
  isCodexCompatibleModelName,
  resolveCodexModel,
} from './codex-models.js';
import { resolveHomeDir } from '../../../utils/paths.js';
import {
  startCodexIncrementalSync,
  stopCodexIncrementalSync,
} from './codex.incremental-sync.js';
import { reconcileStaleCodexSessions } from './codex.reconciliation.js';
import { mkdir, realpath as fsRealpath } from 'fs/promises';

/**
 * Supported Codex CLI version
 * Latest version tested and verified with CodeMie backend
 *
 * **UPDATE THIS WHEN BUMPING CODEX VERSION**
 */
const CODEX_SUPPORTED_VERSION = '0.129.0';

/**
 * Minimum supported Codex CLI version
 * Versions below this are known to be incompatible and will be blocked from starting
 * Rule: always 10 minor versions below CODEX_SUPPORTED_VERSION for 0.x Codex releases
 * e.g. supported = 0.129.0 → minimum = 0.119.0
 *
 * **UPDATE THIS WHEN BUMPING CODEX VERSION**
 */
const CODEX_MINIMUM_SUPPORTED_VERSION = '0.119.0';

/**
 * Build a hook config object from environment variables.
 * Used by both onSessionStart and onSessionEnd lifecycle hooks.
 */
function buildHookConfig(env: NodeJS.ProcessEnv, sessionId: string): HookProcessingConfig {
  return {
    agentName: env.CODEMIE_AGENT || 'codex',
    sessionId,
    provider: env.CODEMIE_PROVIDER,
    apiBaseUrl: env.CODEMIE_BASE_URL,
    ssoUrl: env.CODEMIE_URL,
    syncApiUrl: env.CODEMIE_SYNC_API_URL,
    version: env.CODEMIE_CLI_VERSION,
    profileName: env.CODEMIE_PROFILE_NAME,
    project: env.CODEMIE_PROJECT,
    model: env.CODEMIE_MODEL,
    clientType: 'codemie-codex',
  };
}

export const CodexPluginMetadata: AgentMetadata = {
  name: 'codex',
  displayName: 'OpenAI Codex CLI',
  description: 'OpenAI Codex CLI - AI coding agent by OpenAI',
  npmPackage: '@openai/codex',
  cliCommand: process.env.CODEMIE_CODEX_BIN || 'codex',

  // Version management configuration
  supportedVersion: CODEX_SUPPORTED_VERSION,       // Latest version tested with CodeMie backend
  minimumSupportedVersion: CODEX_MINIMUM_SUPPORTED_VERSION, // Minimum version required to run

  dataPaths: {
    home: '.codex', // ~/.codex is fixed for Codex (no XDG convention)
  },
  extensionsConfig: {
    project: '.codex',
    global: '~/.codex',
    skillsEntryFile: 'SKILL.md',
  },
  envMapping: {
    // CODEMIE_BASE_URL → OPENAI_BASE_URL (read natively by Codex)
    baseUrl: ['OPENAI_BASE_URL'],
    // CODEMIE_API_KEY → OPENAI_API_KEY only.
    // CODEMIE_API_KEY is intentionally NOT listed here: transformEnvVars deletes all
    // vars in this array before re-setting them, which would wipe CODEMIE_API_KEY
    // before enrichArgs can use it as env_key for the custom model provider.
    // CODEMIE_API_KEY is passed through to the codex process env unchanged.
    apiKey: ['OPENAI_API_KEY'],
    model: [],
  },
  supportedProviders: ['ai-run-sso', 'bearer-auth', 'litellm'],
  blockedModelPatterns: [],
  recommendedModels: ['gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex', 'gpt-5.2-codex'],

  ssoConfig: {
    enabled: true,
    clientType: 'codemie-codex',
  },

  reasoningEffort: {
    strategy: 'cli-config',
    configFlag: '--config',
    configKey: 'model_reasoning_effort',
    placement: 'prepend',
    supportedLevels: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    userOverrideFlags: ['model_reasoning_effort'],
  },

  lifecycle: {
    /**
     * Keep CodeMie-managed Codex state separate from native Codex state.
     *
     * Plain `codex` and Codex Desktop continue to use Codex's default home
     * unless the user configured CODEX_HOME themselves. codemie-codex runs
     * with a CodeMie-owned CODEX_HOME so generated catalogs, selected models,
     * history, and rollout files do not pollute native Codex state.
     */
    async beforeRun(env: NodeJS.ProcessEnv) {
      if (!env.CODEX_HOME) {
        env.CODEX_HOME = resolveHomeDir('.codex/codemie/home');
      }

      await mkdir(env.CODEX_HOME, { recursive: true });

      return env;
    },

    /**
     * Send session start metrics via the CLI-level hook pipeline.
     *
     * Routes through processEvent(SessionStart) which:
     * - Creates the session record in ~/.codemie/sessions/{id}.json (status=active)
     * - Sends session start metrics to v1/metrics API (SSO provider only)
     */
    async onSessionStart(sessionId: string, env: NodeJS.ProcessEnv) {
      const startedAt = Date.now();
      env.CODEMIE_CODEX_STARTED_AT = String(startedAt);

      try {
        const { processEvent } = await import('../../../cli/commands/hook.js');
        const event = {
          hook_event_name: 'SessionStart',
          session_id: sessionId,
          transcript_path: '',
          permission_mode: 'default',
          cwd: process.cwd(),
          source: 'startup',
        };
        await processEvent(event, buildHookConfig(env, sessionId));
        logger.info(`[codex] SessionStart hook completed for session ${sessionId}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[codex] SessionStart hook failed (non-blocking): ${msg}`);
      }

      // Reconcile previously stranded codex sessions. Codex 0.129.0 has no
      // graceful-shutdown guarantee, so kill -9 / OS shutdown leaves sessions
      // marked `active` with no terminal lifecycle metric. Fire-and-forget so
      // a slow reconcile never blocks the new session from starting.
      void reconcileStaleCodexSessions(env, buildHookConfig).catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        logger.debug(`[codex] Stale-session reconciliation failed (non-blocking): ${msg}`);
      });

      // Start the in-process incremental sync timer. Because Codex 0.129.0
      // hooks were verified non-firing on `codex exec`, we re-parse the rollout
      // file every ~30 s and write deltas/conversations to JSONL. The SSO proxy
      // timer (sso.session-sync.plugin.ts) pushes them to the API.
      try {
        startCodexIncrementalSync({
          sessionId,
          startedAt,
          cwd: process.cwd(),
          metadata: CodexPluginMetadata,
          ssoUrl: env.CODEMIE_URL,
          syncApiUrl: env.CODEMIE_SYNC_API_URL || env.CODEMIE_BASE_URL,
          cliVersion: env.CODEMIE_CLI_VERSION,
          buildContext: () => ({
            sessionId,
            apiBaseUrl: env.CODEMIE_BASE_URL || '',
            cookies: '',
            clientType: 'codemie-codex',
            version: env.CODEMIE_CLI_VERSION || '0.0.0',
            dryRun: false,
          }),
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[codex] Failed to start incremental sync timer: ${msg}`);
      }
    },

    /**
     * Transform CodeMie flags into Codex CLI arguments.
     *
     * Transformations applied (in order):
     * 1. --task <prompt>  → exec <prompt>  (non-interactive subcommand)
     * 2. config.model     → --model <model>
     * 3. Custom provider  → model_providers.codemie (env_key bypasses ~/.codex/auth.json)
     * 4. Session tuning   → --config flags (unconditional)
     *
     * OPENAI_BASE_URL and OPENAI_API_KEY are injected into the process env
     * by BaseAgentAdapter.transformEnvVars via envMapping.
     */
    enrichArgs(args: string[], config: AgentConfig) {
      let enriched = args;

      // 1. Handle --resume and --task to build the correct subcommand.
      const resumeIdx = enriched.indexOf('--resume');
      const resumeId = resumeIdx !== -1 && resumeIdx < enriched.length - 1
        ? enriched[resumeIdx + 1]
        : undefined;

      // Strip --resume <id> pair before subcommand construction
      if (resumeId) {
        enriched = [...enriched.slice(0, resumeIdx), ...enriched.slice(resumeIdx + 2)];
      }

      const taskIndex = enriched.indexOf('--task');
      if (taskIndex !== -1 && taskIndex < enriched.length - 1) {
        const taskValue = enriched[taskIndex + 1];
        const rest = [...enriched.slice(0, taskIndex), ...enriched.slice(taskIndex + 2)];
        const head = resumeId ? ['exec', 'resume', resumeId] : ['exec'];
        enriched = [...head, ...rest, taskValue];
      } else if (resumeId) {
        // Interactive resume: no --task present → top-level codex resume <id>
        enriched = ['resume', resumeId, ...enriched];
      }
      // else: no --task, no --resume → existing interactive behavior (unchanged)

      // 2. Inject model via --model when not already overridden.
      const explicitModel = getExplicitModelArg(enriched);
      const availableModels = (process.env.CODEMIE_CODEX_AVAILABLE_MODELS || '')
        .split(',')
        .map(model => model.trim())
        .filter(Boolean);

      if (explicitModel) {
        assertExplicitCodexModelAllowed(explicitModel, availableModels);
      } else if (config?.model) {
        enriched = ['--model', config.model, ...enriched];
      }

      // 3. Configure a custom model provider to bypass ~/.codex/auth.json.
      // auth.json has highest priority for the default "openai" provider and overrides
      // even OPENAI_API_KEY env var. Using a custom provider with env_key pointing to
      // CODEMIE_API_KEY (set by transformEnvVars) bypasses auth.json entirely, since
      // auth.json only stores credentials for the default openai provider.
      // --config uses TOML values: strings must be double-quoted.
      if (config?.apiKey && config.apiKey !== 'not-required' && config?.baseUrl) {
        enriched = [
          '--config', 'model_provider="codemie"',
          '--config', 'model_providers.codemie.name="codemie"',
          '--config', `model_providers.codemie.base_url="${config.baseUrl}"`,
          '--config', 'model_providers.codemie.env_key="CODEMIE_API_KEY"',
          '--config', 'model_providers.codemie.wire_api="responses"',
          ...(process.env.CODEMIE_CODEX_MODEL_CATALOG_JSON
            ? ['--config', `model_catalog_json="${process.env.CODEMIE_CODEX_MODEL_CATALOG_JSON}"`]
            : []),
          ...enriched,
        ];
      }

      // 4. Inject session tuning flags (unconditional).
      // --config uses TOML values: integers unquoted, strings double-quoted.
      enriched = [
        '--config', 'stream_max_retries=40',
        '--config', 'request_max_retries=40',
        '--config', 'max_output_tokens=16384',
        '--config', 'model_verbosity="medium"',
        ...enriched,
      ];

      return enriched;
    },

    /**
     * Process Codex session metrics and send session end metrics via CLI-level hook pipeline.
     *
     * Called by BaseAgentAdapter when Codex exits, BEFORE SessionSyncer.
     *
     * Steps:
     * 1. Discover the most recent rollout file (~/.codex/sessions/YYYY/MM/DD/)
     * 2. Parse rollout, extract tool usage, write MetricDelta to JSONL
     *    (so SessionEnd pipeline can sync it to v1/metrics)
     * 3. processEvent(SessionEnd) — full CLI-level pipeline:
     *    accumulateActiveDuration → incrementalSync → syncToAPI →
     *    sendSessionEndMetrics → updateStatus → renameFiles
     */
    async onSessionEnd(exitCode: number, env: NodeJS.ProcessEnv) {
      const sessionId = env.CODEMIE_SESSION_ID;

      if (!sessionId) {
        logger.debug('[codex] No CODEMIE_SESSION_ID in environment, skipping session end processing');
        return;
      }

      // Stop the in-process incremental sync timer first so it doesn't race
      // the final flush below.
      stopCodexIncrementalSync(sessionId);

      // 1. Process rollout file → MetricDelta JSONL (must run before SessionEnd sync)
      try {
        logger.info(`[codex] Processing session metrics (code=${exitCode})`);

        const adapter = new CodexSessionAdapter(CodexPluginMetadata);
        const sessions = await adapter.discoverSessions({ maxAgeDays: 1, limit: 20 });

        const startedAt = env.CODEMIE_CODEX_STARTED_AT
          ? Number(env.CODEMIE_CODEX_STARTED_AT)
          : Date.now() - 5 * 60 * 1000;
        const currentCwd = process.cwd();
        const cwdReal = await safeRealpath(currentCwd);
        const recentSessions: SessionDescriptor[] = [];

        for (const session of sessions) {
          if (session.createdAt < startedAt - 10_000) {
            continue;
          }

          try {
            const parsed = await adapter.parseSessionFile(session.filePath, sessionId);
            const projectPath = parsed.metadata?.projectPath;
            if (!projectPath) continue;
            const projectReal = await safeRealpath(projectPath);
            if (projectReal === cwdReal) {
              recentSessions.push(session);
            }
          } catch (error) {
            logger.debug('[codex] Skipping unparsable rollout candidate:', error);
          }
        }

        if (recentSessions.length === 0) {
          logger.warn('[codex] No rollout file matched the current run, skipping metrics');
        } else {
          const latestSession = recentSessions[0];
          logger.debug(`[codex] Processing latest rollout: ${latestSession.sessionId}`);

          const context = {
            sessionId,
            apiBaseUrl: env.CODEMIE_BASE_URL || '',
            cookies: '',
            clientType: 'codemie-codex',
            version: env.CODEMIE_CLI_VERSION || '1.0.0',
            dryRun: false,
          };

          const result = await adapter.processSession(latestSession.filePath, sessionId, context);

          if (result.success) {
            logger.info(`[codex] Metrics written to JSONL: ${result.totalRecords} records`);
          } else {
            logger.warn(`[codex] Metrics processing had failures: ${result.failedProcessors.join(', ')}`);
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[codex] Rollout processing failed (non-blocking): ${msg}`);
      }

      // 2. Route through CLI-level SessionEnd pipeline
      try {
        const { processEvent } = await import('../../../cli/commands/hook.js');
        const event = {
          hook_event_name: 'SessionEnd',
          session_id: sessionId,
          transcript_path: '',
          permission_mode: 'default',
          cwd: process.cwd(),
          reason: exitCode === 0 ? 'exit' : `exit(${exitCode})`,
        };
        await processEvent(event, buildHookConfig(env, sessionId));
        logger.info(`[codex] SessionEnd hook completed for session ${sessionId}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[codex] SessionEnd hook failed (non-blocking): ${msg}`);
      }
    },
  },
};

function getExplicitModelArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-m' || arg === '--model') {
      return args[i + 1];
    }
    if (arg.startsWith('--model=')) {
      return arg.slice('--model='.length);
    }
  }

  return undefined;
}

/**
 * Resolve a path through symlinks, falling back to the original path on error.
 * Used so a `cwd` of `/Users/foo` and a rollout's `projectPath` of
 * `/private/Users/foo` (or vice versa) compare equal.
 */
async function safeRealpath(p: string): Promise<string> {
  try {
    return await fsRealpath(p);
  } catch {
    return p;
  }
}

/**
 * Codex agent plugin
 *
 * Phase 1: Core plugin with CLI wrapping and session tracking.
 * Phase 2: Rollout file analytics — discovery, parsing, MetricDelta writing.
 */
export class CodexPlugin extends BaseAgentAdapter {
  private readonly sessionAdapter: SessionAdapter;

  constructor() {
    super(CodexPluginMetadata);
    this.sessionAdapter = new CodexSessionAdapter(CodexPluginMetadata);
  }

  /**
   * Check whether the `codex` binary is available on PATH.
   * Respects CODEMIE_CODEX_BIN environment variable override.
   */
  async isInstalled(): Promise<boolean> {
    const cliCommand = this.metadata.cliCommand;
    if (!cliCommand) return false;

    const installed = await commandExists(cliCommand);

    if (!installed) {
      logger.debug('[codex-plugin] Codex not installed. Install with:');
      logger.debug('[codex-plugin]   codemie install codex');
      logger.debug('[codex-plugin]   Or directly: npm i -g @openai/codex');
    }

    return installed;
  }

  /**
   * Get Codex version (override from BaseAgentAdapter).
   * Codex versions can be emitted as plain semver or with a command prefix,
   * for example: '0.129.0', 'codex 0.129.0', or 'codex-cli 0.129.0'.
   * Base compatibility checks require just the semantic version.
   *
   * @returns Version string or null if not installed
   */
  async getVersion(): Promise<string | null> {
    if (!this.metadata.cliCommand) {
      return null;
    }

    try {
      const result = await exec(this.metadata.cliCommand, ['--version']);
      const output = result.stdout.trim();
      const versionMatch = output.match(/(\d+\.\d+\.\d+)/);
      return versionMatch ? versionMatch[1] : output;
    } catch {
      return null;
    }
  }

  protected override async setupProxy(env: NodeJS.ProcessEnv): Promise<void> {
    if (env.CODEMIE_PROVIDER === 'litellm') {
      if (!isCodexCompatibleModelName(env.CODEMIE_MODEL)) {
        throw new ConfigurationError(
          `Model "${env.CODEMIE_MODEL ?? 'unknown'}" is not compatible with codemie-codex. ` +
          'Use a GPT/Codex model for LiteLLM.'
        );
      }

      env.CODEMIE_CODEX_AVAILABLE_MODELS = env.CODEMIE_MODEL;
      await super.setupProxy(env);
      return;
    }

    const resolution = await resolveCodexModel(env);

    env.CODEMIE_MODEL = resolution.selectedModel;
    env.CODEMIE_CODEX_AVAILABLE_MODELS = resolution.availableModels.join(',');
    if (resolution.catalogPath) {
      env.CODEMIE_CODEX_MODEL_CATALOG_JSON = resolution.catalogPath;
    }

    await super.setupProxy(env);
  }

  /**
   * Return session adapter for rollout analytics.
   */
  getSessionAdapter(): SessionAdapter {
    return this.sessionAdapter;
  }

  /**
   * No extension installer — Codex is installed directly via npm.
   */
  getExtensionInstaller(): BaseExtensionInstaller | undefined {
    return undefined;
  }
}
