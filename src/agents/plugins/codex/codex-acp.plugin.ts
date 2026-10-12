import type { AgentMetadata } from '../../core/types.js';
import type { BaseAgentAdapter } from '../../core/BaseAgentAdapter.js';
import { CodexPlugin, CodexPluginMetadata } from './codex.plugin.js';

/**
 * Codex ACP Plugin Metadata
 *
 * Extends CodexPluginMetadata with ACP-specific overrides.
 * ACP (Agent Communication Protocol) adapter for OpenAI Codex.
 * Enables integration with editors like Zed, JetBrains, Emacs via stdio JSON-RPC.
 *
 * Uses @agentclientprotocol/codex-acp — the official ACP adapter that bundles
 * @openai/codex. Unlike plain `codex`, which takes `--config key=value` flags,
 * codex-acp is configured entirely through environment variables: it parses
 * only `login`, `cli <args>`, and `--version` from argv — anything else starts
 * the ACP server and ignores stray args. See CODEX_CONFIG injection below.
 * https://github.com/agentclientprotocol/codex-acp
 */
export const CodexAcpPluginMetadata: AgentMetadata = {
  // Inherit all from Codex plugin
  ...CodexPluginMetadata,

  // ACP-specific overrides
  name: 'codex-acp',
  displayName: 'Codex ACP',
  description: 'OpenAI Codex ACP adapter for editor integration (Zed, JetBrains, etc.)',

  // ACP adapter package (separate from the Codex CLI, though it bundles it)
  npmPackage: '@agentclientprotocol/codex-acp',
  cliCommand: 'codex-acp',

  // No native installer - npm only
  installerUrls: undefined,

  // The ACP wrapper's own version (currently 2.x) is unrelated to Codex CLI
  // versioning (0.1xx) that CodexPluginMetadata carries — disable the hard
  // version gate rather than comparing against the wrong numbering scheme.
  supportedVersion: undefined,
  minimumSupportedVersion: undefined,

  // SSO config - separate clientType for analytics distinction
  ssoConfig: {
    enabled: true,
    clientType: 'codemie-codex-acp',
  },

  // No flag mappings - ACP protocol handles everything via stdio
  flagMappings: {},

  // Silent mode for ACP - stdout is JSON-RPC protocol
  silentMode: true,

  // Post-install hints for IDE configuration
  postInstallHints: [
    'Configure in your IDE:',
    '',
    'Zed (~/.config/zed/settings.json):',
    '  "agent_servers": { "codex": { "command": "codemie-codex-acp" } }',
    '',
    'JetBrains (~/.jetbrains/acp.json):',
    '  "agent_servers": { "Codex via CodeMie": { "command": "codemie-codex-acp" } }',
    '',
    'JetBrains AIR (~/Library/Application Support/JetBrains/Air/acp.json):',
    '  "agent_servers": { "Codex via CodeMie": { "command": "codemie-codex-acp" } }',
  ],

  lifecycle: {
    // Inherit onSessionStart/onSessionEnd verbatim from CodexPluginMetadata —
    // both now read env.CODEMIE_CLIENT_TYPE for the telemetry clientType
    // (see the codex.plugin.ts buildHookConfig fix), so they tag sessions as
    // 'codemie-codex-acp' automatically via BaseAgentAdapter's env injection.
    onSessionStart: CodexPluginMetadata.lifecycle!.onSessionStart,
    onSessionEnd: CodexPluginMetadata.lifecycle!.onSessionEnd,

    // codex-acp parses only `login`, `cli <args>`, `--version` from argv;
    // anything else starts the ACP server and ignores stray args. No flag
    // translation needed — pass args through unchanged.
    enrichArgs: (args) => args,

    // Reuse Codex's own beforeRun (sets the isolated CODEX_HOME) then inject
    // CODEX_CONFIG — codex-acp's only configuration surface — mirroring the
    // same provider/tuning values codex.plugin.ts injects via --config flags.
    async beforeRun(this: BaseAgentAdapter, env: NodeJS.ProcessEnv) {
      env = await (CodexPluginMetadata.lifecycle!.beforeRun as (this: BaseAgentAdapter, env: NodeJS.ProcessEnv) => Promise<NodeJS.ProcessEnv>).call(this, env);

      const isOllama = env.CODEMIE_PROVIDER === 'ollama';
      const hasUsableApiKey = env.CODEMIE_API_KEY && env.CODEMIE_API_KEY !== 'not-required';

      if ((hasUsableApiKey || isOllama) && env.CODEMIE_BASE_URL) {
        const codexConfig: Record<string, unknown> = {
          model_provider: 'codemie',
          model_providers: {
            codemie: {
              name: 'codemie',
              base_url: env.CODEMIE_BASE_URL,
              env_key: 'CODEMIE_API_KEY',
              wire_api: 'responses',
            },
          },
          stream_max_retries: 40,
          request_max_retries: 40,
          model_verbosity: 'medium',
        };
        if (env.CODEMIE_MODEL) {
          codexConfig.model = env.CODEMIE_MODEL;
        }
        if (env.CODEMIE_CODEX_MODEL_CATALOG_JSON) {
          codexConfig.model_catalog_json = env.CODEMIE_CODEX_MODEL_CATALOG_JSON;
        }
        // Mirror codex.plugin.ts's model-dependent max_output_tokens (same
        // regex, sourced from env.CODEMIE_MODEL since beforeRun has no
        // AgentConfig to read config.model from).
        codexConfig.max_output_tokens = /gpt[-.]?6(?:[-.]|\b)|gpt[-.]?5[.-]6(?:[-.]|\b)/i.test(env.CODEMIE_MODEL ?? '')
          ? 128000
          : 16384;

        let merged = codexConfig;
        if (env.CODEX_CONFIG) {
          try {
            merged = { ...JSON.parse(env.CODEX_CONFIG), ...codexConfig };
          } catch {
            // Malformed pre-existing override — fall back to ours only.
          }
        }
        env.CODEX_CONFIG = JSON.stringify(merged);
      }

      return env;
    },
  },
};

/**
 * Codex ACP Plugin
 *
 * Extends CodexPlugin with ACP-specific metadata.
 * Inherits all functionality (proxy, model resolution, session adapter).
 */
export class CodexAcpPlugin extends CodexPlugin {
  constructor() {
    super();
    // Override metadata with ACP-specific values
    (this as any).metadata = CodexAcpPluginMetadata;
  }

  /**
   * Install via npm (no native installers for ACP)
   * Overrides CodexPlugin's inherited install behavior to use npm-only installation
   */
  async install(): Promise<void> {
    const { BaseAgentAdapter } = await import('../../core/BaseAgentAdapter.js');
    await BaseAgentAdapter.prototype.install.call(this);
  }

  /**
   * Check if codex-acp binary is installed.
   * Overrides CodexPlugin.isInstalled() which checks CODEMIE_CODEX_BIN/'codex' —
   * wrong binary name for the ACP adapter. Uses BaseAgentAdapter's generic
   * implementation, which checks metadata.cliCommand ('codex-acp') in PATH.
   */
  async isInstalled(): Promise<boolean> {
    const { BaseAgentAdapter } = await import('../../core/BaseAgentAdapter.js');
    return BaseAgentAdapter.prototype.isInstalled.call(this);
  }

  /**
   * Skip version check - the ACP wrapper's own version isn't the thing we gate on
   * (CodexPlugin.getVersion() parses `codex --version`, which doesn't apply here).
   */
  async getVersion(): Promise<string | null> {
    return null;
  }
}
