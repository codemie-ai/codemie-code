/**
 * Desktop Models Plugin
 * Priority: 8 (after GatewayKeyPlugin, so only a caller holding the gateway key is answered)
 *
 * Answers Claude Desktop's `GET /v1/models` (Anthropic Models API shape) from the CodeMie
 * catalog of the daemon's project, curated by {@link selectDesktopClaudeModels}. Desktop asks
 * on every start when its config carries no `inferenceModels`, so a change on the project's
 * Models tab reaches its picker on the next Desktop start, without `codemie proxy connect`.
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
  selectDesktopClaudeModels,
  toDesktopModels,
  type DesktopModel,
} from '../../sso.desktop-models.js';
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
      const models = selectDesktopClaudeModels(toDesktopModels(catalog));
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
}
