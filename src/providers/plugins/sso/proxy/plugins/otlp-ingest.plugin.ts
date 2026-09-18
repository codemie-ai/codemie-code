import type { IncomingMessage, ServerResponse } from 'http';
import type { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import type { ProxyContext } from '../proxy-types.js';
import type { ProxyHTTPClient } from '../proxy-http-client.js';
import { logger } from '../../../../../utils/logger.js';
import { sanitizeLogArgs } from '../../../../../utils/security.js';
import type { SSOCredentials, JWTCredentials } from '../../../../core/types.js';
import { OtlpDispatcher } from './otlp-dispatcher.js';
import type { OtlpEventPayload } from './otlp-dispatcher.js';

export class OtlpIngestPlugin implements ProxyPlugin {
  id = '@codemie/proxy-otlp-ingest';
  name = 'OTLP Ingestion';
  version = '1.0.0';
  priority = 10; // After gateway-key (priority 7)

  createInterceptor(context: PluginContext): ProxyInterceptor {
    return new OtlpIngestInterceptor(
      context.syncCredentials || context.credentials,
      context.config.syncApiUrl ?? context.config.targetApiUrl
    );
  }
}

class OtlpIngestInterceptor implements ProxyInterceptor {
  name = 'otlp-ingest';
  private readonly dispatcher: OtlpDispatcher;

  constructor(credentials?: SSOCredentials | JWTCredentials, baseUrl?: string) {
    this.dispatcher = new OtlpDispatcher(credentials, baseUrl);
  }

  async handleRequest(
    ctx: ProxyContext,
    _req: IncomingMessage,
    res: ServerResponse,
    _httpClient: ProxyHTTPClient
  ): Promise<boolean> {
    if (ctx.method !== 'POST' || ctx.url !== '/v1/otlp/hook-events') return false;
    if (!ctx.metadata.gatewayKeyValidated) {
      logger.warn('[otlp-ingest] Rejected request: gateway key not validated', ...sanitizeLogArgs({ url: ctx.url }));
      return this.sendError(res, 401, 'authentication_error', 'Unauthorized');
    }
    try {
      const payload = await this.parseBody(ctx, res);
      if (!payload) return true;
      void this.dispatcher.dispatch(payload).catch(err => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.info('[otlp-ingest] dispatch error', ...sanitizeLogArgs({ err: msg }));
      });
      res.statusCode = 202;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ accepted: true }));
      return true;
    } catch (error) {
      logger.error('[otlp-ingest] Unexpected error', ...sanitizeLogArgs({
        error: error instanceof Error ? error.message : String(error),
      }));
      return this.sendError(res, 500, 'internal_server_error', 'Internal server error');
    }
  }

  private sendError(res: ServerResponse, status: number, type: string, message: string): true {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ type: 'error', error: { type, message } }));
    return true;
  }

  private async parseBody(ctx: ProxyContext, res: ServerResponse): Promise<OtlpEventPayload | null> {
    if (!ctx.requestBody) {
      logger.warn('[otlp-ingest] Received request with empty body');
      this.sendError(res, 400, 'invalid_request_error', 'Empty body');
      return null;
    }
    let payload: OtlpEventPayload;
    try {
      payload = JSON.parse(ctx.requestBody.toString('utf-8')) as OtlpEventPayload;
    } catch (parseError) {
      logger.warn('[otlp-ingest] Failed to parse JSON body', ...sanitizeLogArgs({
        parseError: parseError instanceof Error ? parseError.message : String(parseError),
      }));
      this.sendError(res, 400, 'invalid_request_error', 'Invalid JSON');
      return null;
    }
    if (!payload.agentName || !payload.timestamp || !payload.raw) {
      logger.warn('[otlp-ingest] Missing required fields', ...sanitizeLogArgs({
        hasAgentName: Boolean(payload.agentName),
        hasTimestamp: Boolean(payload.timestamp),
        hasRaw: Boolean(payload.raw),
      }));
      this.sendError(res, 400, 'invalid_request_error', 'Missing required fields');
      return null;
    }
    // Dynamic import avoids a circular dependency:
    // AgentRegistry -> BaseAgentAdapter -> sso/index -> sso.proxy -> plugins/index -> this file
    const { AgentRegistry } = await import('../../../../../agents/registry.js');
    if (!AgentRegistry.getAgentNames().includes(payload.agentName)) {
      logger.warn('[otlp-ingest] Rejected request: unrecognized agentName', ...sanitizeLogArgs({ agentName: payload.agentName }));
      this.sendError(res, 400, 'invalid_request_error', 'Unrecognized agentName');
      return null;
    }
    return payload;
  }

}
