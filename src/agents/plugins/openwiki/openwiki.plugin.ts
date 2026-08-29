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
