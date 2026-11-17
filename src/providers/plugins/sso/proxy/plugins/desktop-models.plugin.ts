/**
 * Desktop Models Plugin
 * Priority: 8 (after GatewayKeyPlugin, so only a caller holding the gateway key is answered)
 *
 * Answers Claude Desktop's `GET /v1/models` (Anthropic Models API shape) from the CodeMie
 * catalog of the daemon's project: every project Claude model, ordered by
 * {@link selectDesktopClaudeModels}, plus the non-Claude models the daemon's profile opted
 * into (`claudeExtraModels`). Desktop asks on every start when its config carries no
 * `inferenceModels`, so a change on the project's Models tab reaches its picker on the next
 * Desktop start, without `codemie proxy connect`.
 *
 * The request never goes upstream: the backend has no Anthropic-shaped model list, and the
 * catalog is read with the daemon's own credentials.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import type { ProxyContext } from '../proxy-types.js';
import type { CredentialRefresher } from './credential-refresh.js';
import { fetchCodeMieLlmModels } from '../../sso.http-client.js';
import {
  desktopModelDisplayName,
  resolveDesktopExtraModelId,
  selectDesktopClaudeModels,
  toDesktopModels,
  withDesktopExtraModels,
  type DesktopModel,
} from '../../sso.desktop-models.js';
import { readClaudeExtraModels } from '../../sso.claude-extra-models.js';
import { ConfigLoader } from '../../../../../utils/config.js';
import { logger } from '../../../../../utils/logger.js';
import { sanitizeLogArgs } from '../../../../../utils/security.js';

const ALLOWED_AGENTS = ['claude-desktop'];

/** Desktop has no use for a creation date, but the Models API marks it required. */
const CREATED_AT = '1970-01-01T00:00:00Z';

export function isModelsListRequest(method: string, url: string): boolean {
  return method === 'GET' && /^\/v1\/models\/?(?:\?|$)/.test(url);
}

/** One page holding the whole list: Desktop pages by `after_id` only while `has_more` is true. */
export function toAnthropicModelsPage(models: readonly DesktopModel[]): Record<string, unknown> {
  const data = models.map((model) => {
    const displayName = desktopModelDisplayName(model);
    return {
      type: 'model',
      id: model.id,
      ...(displayName ? { display_name: displayName } : {}),
      created_at: CREATED_AT,
    };
  });
  return {
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data.at(-1)?.id ?? null,
  };
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export class DesktopModelsPlugin implements ProxyPlugin {
  id = '@codemie/proxy-desktop-models';
  name = 'Desktop Models';
  version = '1.0.0';
  priority = 8;

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    const clientType = context.config.clientType;
    if (!clientType || !ALLOWED_AGENTS.includes(clientType)) {
      throw new Error(`Plugin disabled for agent: ${clientType}`);
    }
    return new DesktopModelsInterceptor(context);
  }
}

class DesktopModelsInterceptor implements ProxyInterceptor {
  name = 'desktop-models';
  private readonly credentials?: CredentialRefresher<NonNullable<PluginContext['credentials']>>;

  constructor(private readonly context: PluginContext) {
    this.credentials = context.credentialRefresher;
  }

  /**
   * Maps an extra model's opaque alias (see {@link withDesktopExtraModels}) back to the real
   * model ID before later plugins and the upstream see the request. The profile is read only
   * for a request that names an alias.
   */
  async onRequest(ctx: ProxyContext): Promise<void> {
    if (!ctx.requestBody || !ctx.headers['content-type']?.includes('application/json')) return;
    let body: unknown;
    try {
      body = JSON.parse(ctx.requestBody.toString('utf-8'));
    } catch {
      return;
    }
    if (typeof body !== 'object' || body === null) return;
    const record = body as Record<string, unknown>;
    if (typeof record.model !== 'string' || !record.model.startsWith('claude-x-')) return;
    const realId = resolveDesktopExtraModelId(record.model, await this.loadExtraModelIds());
    if (!realId) {
      logger.warn(`[${this.name}] Desktop asked for unknown model alias "${record.model}"; the profile no longer lists it`);
      return;
    }

    logger.debug(`[${this.name}] Mapped Desktop model alias "${record.model}" to "${realId}"`);
    record.model = realId;
    ctx.requestBody = Buffer.from(JSON.stringify(record), 'utf-8');
    ctx.headers['content-length'] = String(ctx.requestBody.length);
  }

  async handleRequest(ctx: ProxyContext, _req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (!isModelsListRequest(ctx.method, ctx.url)) return false;

    const project = this.context.config.project;
    try {
      if (!this.credentials) throw new Error('no CodeMie credentials');
      const credentials = await this.credentials.refresh();
      const apiUrl = credentials.apiUrl || this.context.config.targetApiUrl;
      const catalog = 'cookies' in credentials
        ? await fetchCodeMieLlmModels(apiUrl, credentials.cookies, project)
        : await fetchCodeMieLlmModels(apiUrl, credentials.token, project);
      const extraIds = await this.loadExtraModelIds();
      const models = withDesktopExtraModels(selectDesktopClaudeModels(toDesktopModels(catalog)), catalog, extraIds);
      logger.info(
        `[${this.name}] Answered Claude Desktop model discovery`,
        ...sanitizeLogArgs({ project, models: models.map((model) => model.id) })
      );
      sendJson(res, 200, toAnthropicModelsPage(models));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn(`[${this.name}] Could not list models for Claude Desktop`, ...sanitizeLogArgs({ project, reason }));
      // Not 401/403: Desktop would take that as its gateway key being rejected. A 502 makes it
      // retry discovery instead.
      sendJson(res, 502, {
        type: 'error',
        error: { type: 'api_error', message: `CodeMie model catalog unavailable: ${reason}` },
      });
    }
    return true;
  }

  /**
   * The daemon profile's `claudeExtraModels`, read on every discovery rather than once at
   * start, so `codemie-claude models select` reaches Desktop on its next start without
   * restarting the daemon. A missing or unreadable profile just means no extras.
   */
  private async loadExtraModelIds(): Promise<string[]> {
    const profileName = this.context.config.profile;
    if (!profileName) return [];
    try {
      return readClaudeExtraModels(await ConfigLoader.getProfile(profileName));
    } catch (error) {
      logger.debug(
        `[${this.name}] Could not read extra models of profile "${profileName}"`,
        ...sanitizeLogArgs({ reason: error instanceof Error ? error.message : String(error) })
      );
      return [];
    }
  }
}
