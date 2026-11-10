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
  private announcedModel: string | undefined;
  private switched = false;

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
    // Once the profile has moved off the launch model, keep following it (also back to the launch model).
    if (this.activeModel !== this.launchModel) this.switched = true;
    if (!this.switched) return;

    // The wire protocol follows the model family at launch (see the Copilot CLI plugin); a switch
    // across families would send one family's requests in the other's format.
    if (this.clientType === 'codemie-copilot' && CLAUDE_FAMILY.test(this.launchModel) !== CLAUDE_FAMILY.test(this.activeModel)) {
      logger.warn(
        `[${this.name}] Not switching ${this.launchModel} to ${this.activeModel}: ` +
        'GitHub Copilot CLI cannot change between Claude and GPT models within a session. Restart it to use the new model.'
      );
      return;
    }

    const rewritten = this.rewriteUrl(context) || this.rewriteBody(context);
    if (rewritten) this.announceSwitch();
  }

  /** Once per switch, at info level: the agent's own display keeps showing the launch model. */
  private announceSwitch(): void {
    if (this.announcedModel === this.activeModel) return;
    this.announcedModel = this.activeModel;
    logger.info(`[${this.name}] Sending ${this.launchModel} requests to ${this.activeModel} (profile switch)`);
  }

  private rewriteUrl(context: ProxyContext): boolean {
    // Gemini carries the model in the path: /v1beta/models/<model>:streamGenerateContent. Gemini CLI
    // turns the launch name into another concrete id before sending, so the main chat request is
    // matched by its method, not by the launch model. Utility calls (generateContent) stay as they are.
    const match = /\/models\/([^/:?]+):streamGenerateContent/.exec(context.url);
    if (!match || match[1] === this.activeModel) return false;
    context.url = context.url.replace(match[0], `/models/${this.activeModel}:streamGenerateContent`);
    logger.debug(`[${this.name}] Rewrote request path to ${this.activeModel}`);
    return true;
  }

  private rewriteBody(context: ProxyContext): boolean {
    if (!context.requestBody || !context.headers['content-type']?.includes('application/json')) return false;

    try {
      const body = JSON.parse(context.requestBody.toString('utf-8'));
      if (body?.model !== this.launchModel || body.model === this.activeModel) return false;

      body.model = this.activeModel;
      context.requestBody = Buffer.from(JSON.stringify(body), 'utf-8');
      context.headers['content-length'] = String(context.requestBody.length);
      logger.debug(`[${this.name}] Rewrote request model ${this.launchModel} -> ${this.activeModel}`);
      return true;
    } catch {
      // Not valid JSON or unexpected structure — pass through unchanged.
      return false;
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
