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
 * 2. enrichArgs      → transform --task, inject --model + model_providers.codemie + tuning flags
 * 3. [Codex runs]
 * 4. onSessionEnd    → process rollout metrics → processEvent(SessionEnd) — syncs + sends end metrics
 *
 * References:
 * - OpenAI Codex CLI: https://github.com/openai/codex
 * - Configuration: https://github.com/openai/codex/blob/main/codex-rs/docs/configuration.md
 * - Advanced config: https://developers.openai.com/codex/config-advanced
 * - CLI Reference: https://github.com/openai/codex/blob/main/codex-rs/docs/cli-reference.md
 */

import type { AgentMetadata, AgentConfig } from '../../core/types.js';
import { BaseAgentAdapter } from '../../core/BaseAgentAdapter.js';
import type { SessionAdapter } from '../../core/session/BaseSessionAdapter.js';
import type { BaseExtensionInstaller } from '../../core/extension/BaseExtensionInstaller.js';
import type { HookProcessingConfig } from '../../../cli/commands/hook.js';
import { commandExists } from '../../../utils/processes.js';
import { logger } from '../../../utils/logger.js';
import { CodexSessionAdapter } from './codex.session.js';

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
  dataPaths: {
    home: '.codex', // ~/.codex is fixed for Codex (no XDG convention)
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
  supportedProviders: [],

  lifecycle: {
    /**
     * Send session start metrics via the CLI-level hook pipeline.
     *
     * Routes through processEvent(SessionStart) which:
     * - Creates the session record in ~/.codemie/sessions/{id}.json (status=active)
     * - Sends session start metrics to v1/metrics API (SSO provider only)
     */
    async onSessionStart(sessionId: string, env: NodeJS.ProcessEnv) {
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

      // 1. Transform --task <value> → exec <value> (non-interactive subcommand)
      const taskIndex = enriched.indexOf('--task');
      if (taskIndex !== -1 && taskIndex < enriched.length - 1) {
        const taskValue = enriched[taskIndex + 1];
        enriched = [
          'exec',
          ...enriched.slice(0, taskIndex),
          ...enriched.slice(taskIndex + 2),
          taskValue,
        ];
      }

      // 2. Inject model via --model when not already overridden
      if (config?.model && !enriched.includes('-m') && !enriched.includes('--model')) {
        enriched = ['--model', config.model, ...enriched];
      }

      // 3. Configure a custom model provider to bypass ~/.codex/auth.json.
      // auth.json has highest priority for the default "openai" provider and overrides
      // even OPENAI_API_KEY env var. Using a custom provider with env_key pointing to
      // CODEMIE_API_KEY (set by transformEnvVars) bypasses auth.json entirely, since
      // auth.json only stores credentials for the default openai provider.
      // --config uses TOML values: strings must be double-quoted.
      const sentinel = ['not-required', 'sso-provided', 'proxy-handled'];
      if (config?.apiKey && !sentinel.includes(config.apiKey) && config?.baseUrl) {
        enriched = [
          '--config', 'model_provider="codemie"',
          '--config', 'model_providers.codemie.name="codemie"',
          '--config', `model_providers.codemie.base_url="${config.baseUrl}"`,
          '--config', 'model_providers.codemie.env_key="CODEMIE_API_KEY"',
          '--config', 'model_providers.codemie.wire_api="responses"',
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

      // 1. Process rollout file → MetricDelta JSONL (must run before SessionEnd sync)
      try {
        logger.info(`[codex] Processing session metrics (code=${exitCode})`);

        const adapter = new CodexSessionAdapter(CodexPluginMetadata);
        const sessions = await adapter.discoverSessions({ maxAgeDays: 1 });

        const RECENT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
        const now = Date.now();
        const recentSessions = sessions.filter(s => now - s.createdAt <= RECENT_WINDOW_MS);

        if (recentSessions.length === 0) {
          logger.warn('[codex] No rollout file modified in the last 5 minutes, skipping metrics');
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
