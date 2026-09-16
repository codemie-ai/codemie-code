import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'http';
import type { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import type { ProxyContext } from '../proxy-types.js';
import type { ProxyHTTPClient } from '../proxy-http-client.js';
import { getCodemiePath } from '../../../../../utils/paths.js';
import { logger } from '../../../../../utils/logger.js';
import { sanitizeLogArgs } from '../../../../../utils/security.js';
import type { SSOCredentials, JWTCredentials } from '../../../../core/types.js';

interface OtlpEventPayload {
  agentName: string;
  timestamp: string;
  raw: string;
}

export class OtlpIngestPlugin implements ProxyPlugin {
  id = '@codemie/proxy-otlp-ingest';
  name = 'OTLP Ingestion';
  version = '1.0.0';
  priority = 10; // After gateway-key (priority 7)

  createInterceptor(context: PluginContext): ProxyInterceptor {
    return new OtlpIngestInterceptor(
      context.syncCredentials || context.credentials,
      context.config.syncApiUrl
    );
  }
}

class OtlpIngestInterceptor implements ProxyInterceptor {
  name = 'otlp-ingest';

  constructor(
    private readonly credentials?: SSOCredentials | JWTCredentials,
    private readonly baseUrl?: string
  ) {}

  async handleRequest(
    ctx: ProxyContext,
    _req: IncomingMessage,
    res: ServerResponse,
    _httpClient: ProxyHTTPClient
  ): Promise<boolean> {
    // Only handle POST /v1/otlp/hook-events
    if (ctx.method !== 'POST' || ctx.url !== '/v1/otlp/hook-events') {
      return false;
    }

    // Require gateway key validation (done by gateway-key plugin before this runs)
    if (!ctx.metadata.gatewayKeyValidated) {
      logger.warn(
        '[otlp-ingest] Rejected request: gateway key not validated',
        ...sanitizeLogArgs({ url: ctx.url })
      );
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'authentication_error', message: 'Unauthorized' },
      }));
      return true;
    }

    try {
      // Parse request body as JSON
      if (!ctx.requestBody) {
        logger.warn('[otlp-ingest] Received request with empty body');
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'Empty body' },
        }));
        return true;
      }

      let payload: OtlpEventPayload;
      try {
        const bodyStr = ctx.requestBody.toString('utf-8');
        payload = JSON.parse(bodyStr) as OtlpEventPayload;
      } catch (parseError) {
        logger.warn(
          '[otlp-ingest] Failed to parse JSON body',
          ...sanitizeLogArgs({
            parseError: parseError instanceof Error ? parseError.message : String(parseError),
          })
        );
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'Invalid JSON' },
        }));
        return true;
      }

      // Validate required fields
      if (!payload.agentName || !payload.timestamp || !payload.raw) {
        logger.warn(
          '[otlp-ingest] Missing required fields',
          ...sanitizeLogArgs({
            hasAgentName: Boolean(payload.agentName),
            hasTimestamp: Boolean(payload.timestamp),
            hasRaw: Boolean(payload.raw),
          })
        );
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'Missing required fields' },
        }));
        return true;
      }

      // Append event to hook-events.jsonl
      const logPath = getCodemiePath('logs', 'hook-events.jsonl');
      await mkdir(dirname(logPath), { recursive: true });
      await appendFile(logPath, `${JSON.stringify(payload)}\n`, 'utf-8');

      logger.debug(
        '[otlp-ingest] Appended event',
        ...sanitizeLogArgs({
          agentName: payload.agentName,
          path: logPath,
        })
      );

      // Return 202 Accepted
      res.statusCode = 202;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ accepted: true }));
      return true;
    } catch (error) {
      logger.error(
        '[otlp-ingest] Unexpected error',
        ...sanitizeLogArgs({
          error: error instanceof Error ? error.message : String(error),
        })
      );
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'internal_server_error', message: 'Internal server error' },
      }));
      return true;
    }
  }
}
