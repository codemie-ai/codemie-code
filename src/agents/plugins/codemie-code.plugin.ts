import type { AgentMetadata } from '../core/types.js';
import { existsSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { BaseAgentAdapter } from '../core/BaseAgentAdapter.js';
import type { SessionAdapter } from '../core/session/BaseSessionAdapter.js';
import type { BaseExtensionInstaller } from '../core/extension/BaseExtensionInstaller.js';
import { installGlobal } from '../../utils/processes.js';
import { OpenCodeSessionAdapter } from './opencode/opencode.session.js';
import { resolveCodemieOpenCodeBinary } from './codemie-opencode/codemie-opencode-binary.js';
import { CodemieOpenCodePluginMetadata } from './codemie-opencode/codemie-opencode.plugin.js';

/**
 * Built-in agent name constant - single source of truth
 */
export const BUILTIN_AGENT_NAME = 'codemie-code';

// Resolve binary at load time, fallback to 'codemie'
const resolvedBinary = resolveCodemieOpenCodeBinary();

/**
 * CodeMie Code Plugin Metadata
 *
 * Reuses lifecycle hooks from CodemieOpenCodePluginMetadata (beforeRun, enrichArgs)
 * since both agents wrap the same OpenCode binary.
 * Only onSessionEnd is customized to use clientType: 'codemie-code' for metrics.
 */
export const CodeMieCodePluginMetadata: AgentMetadata = {
  name: BUILTIN_AGENT_NAME,
  displayName: 'CodeMie Code',
  description: 'CodeMie Code - AI coding assistant',

  npmPackage: '@codemieai/codemie-opencode',
  cliCommand: resolvedBinary || 'codemie',

  dataPaths: {
    home: '.opencode'
  },

  envMapping: {
    baseUrl: [],
    apiKey: [],
    model: []
  },

  supportedProviders: ['litellm', 'ai-run-sso'],

  ssoConfig: { enabled: true, clientType: 'codemie-code' },

  lifecycle: {
    beforeRun: CodemieOpenCodePluginMetadata.lifecycle!.beforeRun,
    enrichArgs: CodemieOpenCodePluginMetadata.lifecycle!.enrichArgs,

    async onSessionEnd(exitCode: number, env: NodeJS.ProcessEnv) {
      const sessionId = env.CODEMIE_SESSION_ID;

      if (!sessionId) {
        logger.debug('[codemie-code] No CODEMIE_SESSION_ID in environment, skipping metrics processing');
        return;
      }

      try {
        logger.info(`[codemie-code] Processing session metrics before SessionSyncer (code=${exitCode})`);

        const adapter = new OpenCodeSessionAdapter(CodeMieCodePluginMetadata);

        const sessions = await adapter.discoverSessions({ maxAgeDays: 1 });

        if (sessions.length === 0) {
          logger.warn('[codemie-code] No recent OpenCode sessions found for processing');
          return;
        }

        const latestSession = sessions[0];
        logger.debug(`[codemie-code] Processing latest session: ${latestSession.sessionId}`);
        logger.debug(`[codemie-code] OpenCode session ID: ${latestSession.sessionId}`);
        logger.debug(`[codemie-code] CodeMie session ID: ${sessionId}`);

        const context = {
          sessionId,
          apiBaseUrl: env.CODEMIE_BASE_URL || '',
          cookies: '',
          clientType: 'codemie-code',
          version: env.CODEMIE_CLI_VERSION || '1.0.0',
          dryRun: false
        };

        const result = await adapter.processSession(
          latestSession.filePath,
          sessionId,
          context
        );

        if (result.success) {
          logger.info(`[codemie-code] Metrics processing complete: ${result.totalRecords} records processed`);
          logger.info('[codemie-code] Metrics written to JSONL - SessionSyncer will sync to v1/metrics next');
        } else {
          logger.warn(`[codemie-code] Metrics processing had failures: ${result.failedProcessors.join(', ')}`);
        }

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`[codemie-code] Failed to process session metrics automatically: ${errorMessage}`);
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
   * Check if the whitelabel binary is available.
   * Uses existsSync on the resolved binary path instead of PATH lookup.
   */
  async isInstalled(): Promise<boolean> {
    const binaryPath = resolveCodemieOpenCodeBinary();

    if (!binaryPath) {
      logger.debug('[codemie-code] Whitelabel binary not found in node_modules');
      logger.debug('[codemie-code] Install with: npm i -g @codemieai/codemie-opencode');
      return false;
    }

    const installed = existsSync(binaryPath);

    if (!installed) {
      logger.debug('[codemie-code] Binary path resolved but file not found');
      logger.debug('[codemie-code] Install with: codemie install codemie-code');
    }

    return installed;
  }

  /**
   * Install the whitelabel package globally.
   */
  async install(): Promise<void> {
    await installGlobal('@codemieai/codemie-opencode');
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
