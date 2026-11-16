import type { AgentConfig, AgentMetadata } from '../../core/types.js';
import { BaseAgentAdapter } from '../../core/BaseAgentAdapter.js';

/**
 * OpenWiki agent plugin
 *
 * Thin wrapper around the OpenWiki CLI (https://github.com/langchain-ai/openwiki),
 * an agent that writes and maintains a Markdown wiki for the current repository.
 *
 * OpenWiki reads its model access from OPENWIKI_PROVIDER / OPENAI_COMPATIBLE_*
 * / OPENWIKI_MODEL_ID env vars, so the declarative envMapping below wires the
 * active CodeMie profile straight into it: for SSO/JWT profiles the base class
 * starts the local proxy (auth + attribution headers injected there) and
 * CODEMIE_BASE_URL/CODEMIE_API_KEY become the proxy URL / 'proxy-handled';
 * for api-key providers the real values are forwarded instead.
 *
 * Usage notes:
 * - Unmapped flags pass through to the OpenWiki CLI unchanged, so the
 *   non-interactive print mode works as-is: `codemie-openwiki --update -p`
 *   (or `--task <message>`, mapped to `-p`) streams output to stdout and
 *   exits, instead of the interactive TUI.
 * - The interactive TUI shows only a spinner during long planning/generation
 *   phases. Setting CODEMIE_DEBUG=true/1 is forwarded as OPENWIKI_DEBUG=1,
 *   which makes the run view render an activity feed (stream open, model
 *   build, tool calls).
 */
export const OpenWikiPluginMetadata: AgentMetadata = {
  name: 'openwiki',
  displayName: 'OpenWiki',
  description: 'OpenWiki - agent-written, self-updating wiki for your codebase',
  npmPackage: 'openwiki',
  cliCommand: 'openwiki',
  envMapping: {
    baseUrl: ['OPENAI_COMPATIBLE_BASE_URL'],
    apiKey: ['OPENAI_COMPATIBLE_API_KEY'],
    model: ['OPENWIKI_MODEL_ID'],
  },
  supportedProviders: ['ai-run-sso', 'bearer-auth', 'litellm', 'ollama', 'moonshot-subscription'],
  blockedModelPatterns: [],
  ssoConfig: { enabled: true, clientType: 'codemie-openwiki' },
  ownedSubcommands: ['init'],
  flagMappings: {
    '--task': { type: 'flag', target: '-p' },
  },
  lifecycle: {
    async beforeRun(env: NodeJS.ProcessEnv, config: AgentConfig): Promise<NodeJS.ProcessEnv> {
      env.OPENWIKI_PROVIDER = 'openai-compatible';

      // Follow CodeMie's own debug flag: OpenWiki's run view renders a live
      // activity feed instead of a bare spinner when OPENWIKI_DEBUG=1.
      if (env.OPENWIKI_DEBUG === undefined && (env.CODEMIE_DEBUG === 'true' || env.CODEMIE_DEBUG === '1')) {
        env.OPENWIKI_DEBUG = '1';
      }

      // Idle-stream watchdog for long generations through the local proxy.
      // OpenWiki 0.4.x only enforces this for Bedrock; forward it anyway so
      // the protection activates automatically once OpenWiki honors it for
      // openai-compatible streams.
      env.OPENWIKI_STREAM_IDLE_TIMEOUT ??= '300000';

      // OpenWiki (LangChain) appends /chat/completions to the base URL. The SSO
      // proxy and LiteLLM accept the bare base URL (same contract the opencode
      // plugin relies on); Ollama only serves the OpenAI-compatible API
      // under /v1.
      const baseUrl = env.OPENAI_COMPATIBLE_BASE_URL;
      if (config.provider === 'ollama' && baseUrl && !baseUrl.endsWith('/v1')) {
        env.OPENAI_COMPATIBLE_BASE_URL = `${baseUrl.replace(/\/$/, '')}/v1`;
      }

      return env;
    },
  },
};

export class OpenWikiPlugin extends BaseAgentAdapter {
  constructor(metadata: AgentMetadata = OpenWikiPluginMetadata) {
    super(metadata);
  }
}
