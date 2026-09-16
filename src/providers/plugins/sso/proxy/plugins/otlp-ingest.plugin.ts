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
import { isSSOCredentials, isJWTCredentials } from '../../../../core/types.js';
import { buildAuthHeaders } from '../../../../core/codemie-auth-helpers.js';
import { CODEMIE_ENDPOINTS } from '../../sso.http-client.js';

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

      // This endpoint is gated only by the shared local gateway key, not by
      // agent identity, so reject an agentName that isn't a known agent id
      // rather than letting an arbitrary/spoofed value be attributed in the
      // ingested analytics.
      const { AgentRegistry } = await import('../../../../../agents/registry.js');
      if (!AgentRegistry.getAgentNames().includes(payload.agentName)) {
        logger.warn(
          '[otlp-ingest] Rejected request: unrecognized agentName',
          ...sanitizeLogArgs({ agentName: payload.agentName })
        );
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'Unrecognized agentName' },
        }));
        return true;
      }

      // Append event to hook-events.jsonl. The directory and file carry the
      // 0o700/0o600 modes security-practices.md requires for ~/.codemie/logs/,
      // since this file now stores raw hook payloads that may contain
      // sensitive content.
      const logPath = getCodemiePath('logs', 'hook-events.jsonl');
      await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
      await appendFile(logPath, `${JSON.stringify(payload)}\n`, {
        encoding: 'utf-8',
        mode: 0o600,
      });

      logger.info(
        '[otlp-ingest] Appended event',
        ...sanitizeLogArgs({
          agentName: payload.agentName,
          path: logPath,
        })
      );

      void this.pushToBackend(this.transformToEventHookRecord(payload));

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

  // Deliberate no-op passthrough pending real Cursor-event -> backend-field mapping.
  private transformToEventHookRecord(payload: OtlpEventPayload): Record<string, unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.raw);
    } catch {
      parsed = undefined;
    }
    // Only spread a genuine plain object - an array or primitive would
    // either produce numeric-keyed properties or silently drop the parsed
    // value, corrupting the record with no error signal. Fall back to the
    // same shape used for a JSON.parse failure in that case.
    const isPlainObject = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
    const base = isPlainObject ? (parsed as Record<string, unknown>) : { raw: payload.raw };
    return { ...base, agent_type: payload.agentName };
  }

  private async pushToBackend(record: Record<string, unknown>): Promise<void> {
    const url = `${this.baseUrl}${CODEMIE_ENDPOINTS.CLI_ANALYTICS_EVENT_HOOKS}`;
    try {
      if (!this.credentials || !this.baseUrl) {
        logger.info(
          '[otlp-ingest] pushToBackend: no credentials/baseUrl, skipping',
          ...sanitizeLogArgs({ hasCredentials: Boolean(this.credentials), baseUrl: this.baseUrl })
        );
        return;
      }

      let headers: Record<string, string>;
      if (isSSOCredentials(this.credentials)) {
        headers = buildAuthHeaders(this.credentials.cookies);
      } else if (isJWTCredentials(this.credentials)) {
        headers = buildAuthHeaders(this.credentials.token);
      } else {
        logger.info('[otlp-ingest] pushToBackend: unrecognized credentials shape, skipping');
        return;
      }
      headers['Content-Type'] = 'application/x-ndjson';

      logger.info('[otlp-ingest] pushToBackend: sending', ...sanitizeLogArgs({ url }));

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: `${JSON.stringify(record)}\n`,
          signal: controller.signal,
        });
        if (!response.ok) {
          const bodyText = await response.text().catch(() => '');
          logger.info(
            `[otlp-ingest] pushToBackend: received status ${response.status}`,
            ...sanitizeLogArgs({ url, body: bodyText.slice(0, 500) })
          );
        } else {
          logger.info(`[otlp-ingest] pushToBackend: success (status ${response.status})`, ...sanitizeLogArgs({ url }));
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.info(`[otlp-ingest] pushToBackend: ${msg}`, ...sanitizeLogArgs({ url }));
    }
  }

  // TODO(colleague): implement OTLP metrics forwarding to CODEMIE_ENDPOINTS.CLI_ANALYTICS_METRICS
  private async pushMetrics(_data: unknown): Promise<void> {
    return;
  }

  // TODO(colleague): implement OTLP logs forwarding to CODEMIE_ENDPOINTS.CLI_ANALYTICS_LOGS
  private async pushLogs(_data: unknown): Promise<void> {
    return;
  }

  // TODO(colleague): implement OTLP traces forwarding to CODEMIE_ENDPOINTS.CLI_ANALYTICS_TRACES
  private async pushTraces(_data: unknown): Promise<void> {
    return;
  }
}
