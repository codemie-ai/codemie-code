import type { AgentMetadata } from '../../core/types.js';
import type { BaseAgentAdapter } from '../../core/BaseAgentAdapter.js';
import { CodexPlugin, CodexPluginMetadata } from './codex.plugin.js';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { logger } from '../../../utils/logger.js';

/**
 * Point CODEX_HOME's config.toml at the generated model catalog (or drop a stale pointer).
 *
 * codex-acp builds its model list from Codex's app-server, which only honors
 * `model_catalog_json` from the config.toml layer — the same key passed through
 * CODEX_CONFIG is ignored, so the picker would show Codex's full bundled catalog
 * instead of the profile's narrowed one. The key must sit above any `[table]`
 * header to be top-level; the rest of the file (e.g. trusted-project tables Codex
 * writes itself) is left untouched.
 */
export async function syncModelCatalogToConfigToml(codexHome: string, catalogPath: string | undefined): Promise<void> {
  const configPath = join(codexHome, 'config.toml');
  let current = '';
  try {
    current = await readFile(configPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const firstTable = current.search(/^\s*\[/m);
  const preamble = firstTable === -1 ? current : current.slice(0, firstTable);
  const rest = firstTable === -1 ? '' : current.slice(firstTable);
  const cleaned = preamble.replace(/^model_catalog_json\s*=.*\r?\n?/m, '');
  const line = catalogPath ? `model_catalog_json = ${JSON.stringify(catalogPath)}\n` : '';
  const next = line + cleaned + rest;

  if (next !== current) {
    await writeFile(configPath, next, 'utf-8');
  }
}

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
      // Codex's beforeRun only assigns CODEX_HOME when the user has none; a user-set home is the
      // user's own Codex config and must not be rewritten.
      const ownsCodexHome = !env.CODEX_HOME;
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

      if (env.CODEX_HOME && ownsCodexHome) {
        try {
          await syncModelCatalogToConfigToml(env.CODEX_HOME, env.CODEMIE_CODEX_MODEL_CATALOG_JSON);
        } catch (error) {
          logger.warn('[codex-acp] Could not sync model catalog into CODEX_HOME/config.toml', { error });
        }
      } else if (env.CODEMIE_PROFILE_MODELS) {
        // AC22: the picker cannot be limited without writing config.toml, so say so.
        logger.notice(
          '[codex-acp] CODEX_HOME is your own Codex home, so the model menu is not limited to this agent\'s profile models'
        );
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
