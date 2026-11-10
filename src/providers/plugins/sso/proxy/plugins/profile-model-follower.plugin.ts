/**
 * Profile Model Follower Plugin
 * Priority: 13 (before the per-agent request normalizers)
 *
 * Gemini CLI, GitHub Copilot CLI, Kimi Code and OpenWiki have no model menu CodeMie can fill with
 * the profile's models. So that `codemie models switch --agent <name>` still takes effect in a
 * running session, this plugin re-reads the profile's active model for the agent and rewrites the
 * model the agent was launched with to it. The conversation stays in the same chat and the next
 * message goes to the newly selected model.
 *
 * Only requests that name the launch model are rewritten: a model the agent picks itself (a
 * native `/model`, a sub-agent) is left alone.
 */

import { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import { logger } from '../../../../../utils/logger.js';

/** Proxy client type -> the profile's agent key. */
const FOLLOWED_AGENTS: Record<string, string> = {
  'codemie-gemini': 'gemini',
  'codemie-gemini-acp': 'gemini',
  'codemie-kimi': 'kimi',
  'codemie-kimi-acp': 'kimi',
  'codemie-copilot': 'copilot-cli',
  'codemie-openwiki': 'openwiki',
};

/** How long a profile read is reused; keeps a busy session from re-reading the config per request. */
const ACTIVE_MODEL_TTL_MS = 1000;

const CLAUDE_FAMILY = /claude|anthropic|sonnet|opus|haiku/i;

export class ProfileModelFollowerPlugin implements ProxyPlugin {
  id = '@codemie/proxy-profile-model-follower';
  name = 'Profile Model Follower';
  version = '1.0.0';
  priority = 13;

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    const { clientType, profile, model } = context.config;
    const agent = clientType ? FOLLOWED_AGENTS[clientType] : undefined;
    if (!agent || !profile || !model || !context.profileConfig?.agentModels) {
      throw new Error(`Plugin disabled for agent: ${clientType}`);
    }

    return new ProfileModelFollowerInterceptor(clientType!, agent, profile, model);
  }
}

class ProfileModelFollowerInterceptor implements ProxyInterceptor {
  name = 'profile-model-follower';

  private activeModel: string;
  private readAt = 0;
  private reading: Promise<void> | null = null;

  constructor(
    private readonly clientType: string,
    private readonly agent: string,
    private readonly profile: string,
    private readonly launchModel: string
  ) {
    this.activeModel = launchModel;
  }

  async onRequest(context: ProxyContext): Promise<void> {
    await this.refresh();
    if (this.activeModel === this.launchModel) return;

    // The wire protocol follows the model family at launch (see the Copilot CLI plugin); a switch
    // across families would send one family's requests in the other's format.
    if (this.clientType === 'codemie-copilot' && CLAUDE_FAMILY.test(this.launchModel) !== CLAUDE_FAMILY.test(this.activeModel)) {
      logger.warn(
        `[${this.name}] Not switching ${this.launchModel} to ${this.activeModel}: ` +
        'GitHub Copilot CLI cannot change between Claude and GPT models within a session. Restart it to use the new model.'
      );
      return;
    }

    this.rewriteUrl(context);
    this.rewriteBody(context);
  }

  private rewriteUrl(context: ProxyContext): void {
    // Gemini carries the model in the path: /v1beta/models/<model>:streamGenerateContent
    const needle = `/models/${this.launchModel}`;
    const index = context.url.indexOf(needle);
    if (index < 0) return;
    const end = index + needle.length;
    if (context.url[end] !== undefined && !/[:/?]/.test(context.url[end])) return;
    context.url = `${context.url.slice(0, index)}/models/${this.activeModel}${context.url.slice(end)}`;
    logger.debug(`[${this.name}] Rewrote request path to ${this.activeModel}`);
  }

  private rewriteBody(context: ProxyContext): void {
    if (!context.requestBody || !context.headers['content-type']?.includes('application/json')) return;

    try {
      const body = JSON.parse(context.requestBody.toString('utf-8'));
      if (body?.model !== this.launchModel) return;

      body.model = this.activeModel;
      context.requestBody = Buffer.from(JSON.stringify(body), 'utf-8');
      context.headers['content-length'] = String(context.requestBody.length);
      logger.debug(`[${this.name}] Rewrote request model ${this.launchModel} -> ${this.activeModel}`);
    } catch {
      // Not valid JSON or unexpected structure — pass through unchanged.
    }
  }

  private refresh(): Promise<void> {
    if (Date.now() - this.readAt < ACTIVE_MODEL_TTL_MS) return Promise.resolve();
    this.reading ??= this.readActiveModel().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  private async readActiveModel(): Promise<void> {
    try {
      // Lazy: utils/config reaches back into this plugin index through the provider registry, and
      // the index instantiates every plugin when it loads.
      const { ConfigLoader, resolveAgentModelSet } = await import('../../../../../utils/config.js');
      const profile = await ConfigLoader.getProfileForModelSwitch(this.profile, process.cwd());
      const set = profile ? resolveAgentModelSet(profile, this.agent) : undefined;
      if (set?.activeModel && set.models.includes(set.activeModel)) {
        this.activeModel = set.activeModel;
      }
    } catch (error) {
      logger.debug(`[${this.name}] Could not re-read profile '${this.profile}'; keeping ${this.activeModel}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.readAt = Date.now();
  }
}
