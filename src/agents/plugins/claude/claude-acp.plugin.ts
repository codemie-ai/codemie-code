import type {AgentMetadata, ProviderSettingsCheckInput, ProviderSettingsCheckOutcome} from '../../core/types.js';
import {ClaudePlugin, ClaudePluginMetadata} from './claude.plugin.js';
import type {HookProcessingConfig} from '../../../cli/commands/hook.js';
import {sendPathApiUrl} from '../../core/session/send-path.js';
import {recordTranscriptCorrelation} from '../../core/session/no-transcript-correlation.js';
import {wrapperOwnerFromEnv} from '../../../utils/processes.js';
import {logger} from '../../../utils/logger.js';
import {basename} from 'path';

/**
 * Hook config for the wrapper-side lifecycle (same shape as codex/opencode). clientType comes from
 * CODEMIE_CLIENT_TYPE, which the base adapter sets from ssoConfig ('codemie-claude-acp').
 */
function buildHookConfig(env: NodeJS.ProcessEnv, sessionId: string): HookProcessingConfig {
  return {
    agentName: env.CODEMIE_AGENT || 'claude-acp',
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
    clientType: env.CODEMIE_CLIENT_TYPE || 'codemie-claude-acp',
    ...wrapperOwnerFromEnv(env),
  };
}


/**
 * Claude Code ACP Plugin Metadata
 *
 * Extends ClaudePluginMetadata with ACP-specific overrides.
 * ACP (Agent Communication Protocol) adapter for Claude Code.
 * Enables integration with editors like Zed, Emacs, Neovim via stdio JSON-RPC.
 *
 * Uses @agentclientprotocol/claude-agent-acp - the official ACP adapter for
 * the Claude Agent SDK (renamed/migrated from @zed-industries/claude-code-acp,
 * which is deprecated and no longer receives updates).
 * https://github.com/agentclientprotocol/claude-agent-acp
 */
export const ClaudeAcpPluginMetadata: AgentMetadata = {
  // Inherit all from Claude plugin
  ...ClaudePluginMetadata,

  // ACP-specific overrides
  name: 'claude-acp',
  displayName: 'Claude Code ACP',
  description: 'Claude Code ACP adapter for editor integration (Zed, Emacs, etc.)',

  // ACP adapter package for the Claude Agent SDK (separate from the Claude CLI!)
  npmPackage: '@agentclientprotocol/claude-agent-acp',
  cliCommand: 'claude-agent-acp',

  // No native installer - npm only
  installerUrls: undefined,

  // Installs via the npm prefix, so the PATH shadow check applies (parent opts out)
  pathShadowCheck: undefined,

  // SSO config - separate clientType for analytics distinction
  ssoConfig: {
    enabled: true,
    clientType: 'codemie-claude-acp'
  },

  // No flag mappings - ACP protocol handles everything via stdio
  flagMappings: {},

  // Keep the Claude beforeRun/afterRun; the ACP adapter runs no Claude hooks, so the wrapper
  // creates the session record at start and processes the transcripts at exit.
  lifecycle: {
    ...ClaudePluginMetadata.lifecycle,

    async onSessionStart(sessionId: string, env: NodeJS.ProcessEnv) {
      try {
        const { processEvent } = await import('../../../cli/commands/hook.js');
        await processEvent({
          hook_event_name: 'SessionStart',
          session_id: sessionId,
          transcript_path: '',
          permission_mode: 'default',
          cwd: process.cwd(),
          source: 'startup',
        }, buildHookConfig(env, sessionId));
        logger.info(`[claude-acp] SessionStart hook completed for session ${sessionId}`);
      } catch (error) {
        logger.error(`[claude-acp] SessionStart hook failed (non-blocking): ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    async onSessionEnd(exitCode: number, env: NodeJS.ProcessEnv) {
      const sessionId = env.CODEMIE_SESSION_ID;
      if (!sessionId) {
        logger.debug('[claude-acp] No CODEMIE_SESSION_ID in environment, skipping session end processing');
        return;
      }

      try {
        const { SessionStore } = await import('../../core/session/SessionStore.js');
        const { ClaudeSessionAdapter } = await import('./claude.session.js');
        const record = await new SessionStore().loadSession(sessionId);
        const adapter = new ClaudeSessionAdapter(ClaudePluginMetadata);
        const transcripts = record ? await adapter.locateTranscript(record) : [];

        if (transcripts.length === 0) {
          logger.warn('[claude-acp] No transcript matched the current run, skipping metrics');
        } else {
          await recordTranscriptCorrelation(sessionId, transcripts[0]);
          for (const transcript of transcripts) {
            try {
              const result = await adapter.processSession(transcript, sessionId, {
                sessionId,
                agentSessionId: basename(transcript, '.jsonl'),
                apiBaseUrl: sendPathApiUrl(env) || '',
                cookies: '',
                clientType: env.CODEMIE_CLIENT_TYPE || 'codemie-claude-acp',
                version: env.CODEMIE_CLI_VERSION || '1.0.0',
                dryRun: false,
                finalPass: true,
              });
              if (!result.success) {
                logger.warn(`[claude-acp] Metrics processing had failures: ${result.failedProcessors.join(', ')}`);
              }
            } catch (error) {
              logger.error(`[claude-acp] Transcript processing failed (non-blocking): ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
      } catch (error) {
        logger.error(`[claude-acp] Transcript lookup failed (non-blocking): ${error instanceof Error ? error.message : String(error)}`);
      }

      try {
        const { processEvent } = await import('../../../cli/commands/hook.js');
        await processEvent({
          hook_event_name: 'SessionEnd',
          session_id: sessionId,
          transcript_path: '',
          permission_mode: 'default',
          cwd: process.cwd(),
          reason: exitCode === 0 ? 'exit' : `exit(${exitCode})`,
        }, buildHookConfig(env, sessionId));
        logger.info(`[claude-acp] SessionEnd hook completed for session ${sessionId}`);
      } catch (error) {
        logger.error(`[claude-acp] SessionEnd hook failed (non-blocking): ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  },

  // Silent mode for ACP - stdout is JSON-RPC protocol
  silentMode: true,

  // Post-install hints for IDE configuration
  postInstallHints: [
    'Configure in your IDE:',
    '',
    'Zed (~/.config/zed/settings.json):',
    '  "agent_servers": { "claude": { "command": "codemie-claude-acp" } }',
    '',
    'JetBrains (~/.jetbrains/acp.json):',
    '  "agent_servers": { "Claude Code via CodeMie": { "command": "codemie-claude-acp" } }',
    '',
    'JetBrains AIR (~/Library/Application Support/JetBrains/Air/acp.json):',
    '  "agent_servers": { "Claude Code via CodeMie": { "command": "codemie-claude-acp" } }',
  ],
};

/**
 * Claude Code ACP Plugin
 *
 * Extends ClaudePlugin with ACP-specific metadata.
 * Inherits all functionality (proxy, lifecycle, analytics, session adapter).
 */
export class ClaudeAcpPlugin extends ClaudePlugin {
  constructor() {
    super();
    // Override metadata with ACP-specific values
    (this as any).metadata = ClaudeAcpPluginMetadata;
  }

  /**
   * Install via npm (no native installers for ACP)
   * Overrides ClaudePlugin's installVersion() to use npm-only installation
   */
  async install(): Promise<void> {
    // Call BaseAgentAdapter's npm-based install method
    // This uses npm.installGlobal(this.metadata.npmPackage)
    const { BaseAgentAdapter } = await import('../../core/BaseAgentAdapter.js');
    await BaseAgentAdapter.prototype.install.call(this);
  }

  /**
   * Check if claude-code-acp binary is installed.
   * Overrides ClaudePlugin.isInstalled() which hardcodes a check for
   * ~/.local/bin/claude (Claude Code native binary) - wrong for ACP.
   * Uses BaseAgentAdapter's implementation that checks claude-code-acp in PATH.
   */
  async isInstalled(): Promise<boolean> {
    const { BaseAgentAdapter } = await import('../../core/BaseAgentAdapter.js');
    return BaseAgentAdapter.prototype.isInstalled.call(this);
  }

  /**
   * Skip version check - ACP adapter version not critical
   */
  async getVersion(): Promise<string | null> {
    return null;
  }

  /**
   * Same check as Claude Code, but never asks: stdio carries the editor's JSON-RPC, so a conflict stops
   * the launch with guidance instead.
   */
  async checkProviderSettings(input: ProviderSettingsCheckInput): Promise<ProviderSettingsCheckOutcome> {
    return super.checkProviderSettings({ ...input, canPrompt: false });
  }
}
