import { appendFile, mkdir } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'http';
import type { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import type { ProxyContext } from '../proxy-types.js';
import type { ProxyHTTPClient } from '../proxy-http-client.js';
import type { SSOCredentials, JWTCredentials } from '../../../../core/types.js';
import { logger } from '../../../../../utils/logger.js';
import { sanitizeLogArgs } from '../../../../../utils/security.js';
import { spoolRoot, sessionFile } from './otlp-spool/spool-paths.js';
import { withSessionLock } from './otlp-spool/session-lock.js';
import { processSessionTick } from './otlp-spool/tick-processor.js';
import { sweepExpired } from './otlp-spool/ttl-sweep.js';
import type { SessionStatus } from './otlp-spool/completeness-gate.js';
import { readdir, readFile, writeFile } from 'node:fs/promises';

const UUID_V4_RE = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

async function readStatusFile(sessionId: string): Promise<SessionStatus | null> {
  try {
    const raw = await readFile(sessionFile(sessionId, 'status'), 'utf-8');
    return JSON.parse(raw) as SessionStatus;
  } catch {
    return null;
  }
}

async function writeStatusFile(sessionId: string, status: SessionStatus): Promise<void> {
  await mkdir(spoolRoot(), { recursive: true });
  await writeFile(sessionFile(sessionId, 'status'), JSON.stringify(status), 'utf-8');
}

function defaultStatus(): SessionStatus {
  return {
    hooksWritten: false,
    otelLogsWritten: false,
    otelMetricsWritten: false,
    otelTracesWritten: false,
    waitTicks: 0,
    cursor: 0,
    otelLogsCursor: 0,
    otelMetricsCursor: 0,
    otelTracesCursor: 0,
  };
}

function sendError(res: ServerResponse, status: number, type: string, message: string): true {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
  return true;
}

class OtlpInterceptor implements ProxyInterceptor {
  name = 'otlp-ingest';
  private tickHandle?: ReturnType<typeof setInterval>;
  private sweepHandle?: ReturnType<typeof setInterval>;

  constructor(private readonly credentials?: SSOCredentials | JWTCredentials) {}

  async onProxyStart(): Promise<void> {
    // Eager tick on startup for crash recovery
    await this.tick().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug('[otlp-ingest] startup tick error', ...sanitizeLogArgs({ err: msg }));
    });

    const sendInterval = Number(process.env['OTLP_SEND_INTERVAL_MS'] ?? '5000');
    this.tickHandle = setInterval(() => {
      void this.tick().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.debug('[otlp-ingest] tick error', ...sanitizeLogArgs({ err: msg }));
      });
    }, sendInterval);

    this.sweepHandle = setInterval(() => {
      void this.sweep().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.debug('[otlp-ingest] sweep error', ...sanitizeLogArgs({ err: msg }));
      });
    }, 5 * 60 * 1_000);
  }

  async onProxyStop(): Promise<void> {
    if (this.tickHandle) clearInterval(this.tickHandle);
    if (this.sweepHandle) clearInterval(this.sweepHandle);
    await this.tick().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug('[otlp-ingest] final tick error', ...sanitizeLogArgs({ err: msg }));
    });
  }

  private async tick(): Promise<void> {
    const root = spoolRoot();
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      return;
    }
    const statusFiles = entries.filter((f) => f.endsWith('.status'));
    if (!this.credentials) {
      return;
    }
    const creds = this.credentials;
    for (const fileName of statusFiles) {
      const sessionId = fileName.slice(0, -'.status'.length);
      await processSessionTick(sessionId, creds).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.debug('[otlp-ingest] session tick error', ...sanitizeLogArgs({ sessionId, err: msg }));
      });
    }
  }

  private async sweep(): Promise<void> {
    if (!this.credentials) {
      return;
    }

    await sweepExpired(this.credentials);
  }

  async handleRequest(
    ctx: ProxyContext,
    _req: IncomingMessage,
    res: ServerResponse,
    _httpClient: ProxyHTTPClient
  ): Promise<boolean> {
    const { method, url } = ctx;

    // Route: POST /v1/analytics/hooks
    if (method === 'POST' && url === '/v1/analytics/hooks') {
      return this.handleHooks(ctx, res);
    }

    // Route: POST /v1/analytics/otlp/logs|metrics|traces
    if (method === 'POST' && url === '/v1/analytics/otlp/v1/logs') {
      return this.handleOtlp(ctx, res, 'otel_logs');
    }
    if (method === 'POST' && url === '/v1/analytics/otlp/v1/metrics') {
      return this.handleOtlp(ctx, res, 'otel_metrics');
    }
    if (method === 'POST' && url === '/v1/analytics/otlp/v1/traces') {
      return this.handleOtlp(ctx, res, 'otel_traces');
    }

    return false;
  }

  private async handleHooks(ctx: ProxyContext, res: ServerResponse): Promise<true> {
    if (!ctx.metadata.gatewayKeyValidated) {
      logger.warn('[otlp-ingest] Rejected hooks request: gateway key not validated');
      return sendError(res, 401, 'authentication_error', 'Unauthorized');
    }

    if (!ctx.requestBody) {
      return sendError(res, 400, 'invalid_request_error', 'Empty body');
    }

    let parsed: { agentName?: unknown; raw?: unknown; timestamp?: unknown };
    try {
      parsed = JSON.parse(ctx.requestBody.toString('utf-8')) as typeof parsed;
    } catch {
      return sendError(res, 400, 'invalid_request_error', 'Invalid JSON');
    }

    const agentName = typeof parsed.agentName === 'string' ? parsed.agentName : '';
    if (!agentName) {
      return sendError(res, 400, 'invalid_request_error', 'Missing agentName');
    }

    // Validate agentName - dynamic import avoids circular dependency
    try {
      const { AgentRegistry } = await import('../../../../../agents/registry.js');
      if (!AgentRegistry.getAnalyticsAgent(agentName)) {
        return sendError(res, 400, 'invalid_request_error', 'Unrecognized agentName');
      }
    } catch {
      return sendError(res, 400, 'invalid_request_error', 'Agent validation failed');
    }

    const rawStr = typeof parsed.raw === 'string' ? parsed.raw : JSON.stringify(parsed.raw ?? {});

    // Extract session_id from raw hook JSON
    let sessionId = '';
    try {
      const rawObj = JSON.parse(rawStr) as Record<string, unknown>;
      sessionId = String(rawObj['session_id'] ?? '');
    } catch { /* ignore */ }

    if (!sessionId) {
      // No session id — log and accept without spooling
      logger.debug('[otlp-ingest] hooks: no session_id in raw, discarding');
      res.statusCode = 202;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ accepted: true }));
      return true;
    }

    const line = JSON.stringify(parsed) + '\n';
    try {
      await withSessionLock(sessionId, async () => {
        await mkdir(spoolRoot(), { recursive: true });
        await appendFile(sessionFile(sessionId, 'hooks'), line);
        const existing = await readStatusFile(sessionId) ?? defaultStatus();
        existing.hooksWritten = true;
        await writeStatusFile(sessionId, existing);
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('[otlp-ingest] hooks disk write error', ...sanitizeLogArgs({ sessionId, err: msg }));
      // Still respond 202 — data loss is logged but we don't block the hook
    }

    res.statusCode = 202;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ accepted: true }));
    return true;
  }

  private async handleOtlp(
    ctx: ProxyContext,
    res: ServerResponse,
    signal: 'otel_logs' | 'otel_metrics' | 'otel_traces'
  ): Promise<true> {
    if (!ctx.metadata.gatewayKeyValidated) {
      logger.warn(`[otlp-ingest] Rejected ${signal} request: gateway key not validated`);
      return sendError(res, 401, 'authentication_error', 'Unauthorized');
    }

    if (!ctx.requestBody) {
      res.statusCode = 200;
      res.end();
      return true;
    }

    const bytes = ctx.requestBody;

    // Extract session ID via UUID v4 regex on latin1-decoded bytes
    const latin1Str = Buffer.from(bytes).toString('latin1');
    const match = UUID_V4_RE.exec(latin1Str);
    const sessionId = match ? match[0] : '';

    if (!sessionId) {
      // Append to _unresolved.alert for debugging
      try {
        await mkdir(spoolRoot(), { recursive: true });
        await appendFile(`${spoolRoot()}/_unresolved.alert`, bytes);
      } catch { /* best-effort */ }
      res.statusCode = 200;
      res.end();
      return true;
    }

    try {
      await withSessionLock(sessionId, async () => {
        await mkdir(spoolRoot(), { recursive: true });
        await appendFile(sessionFile(sessionId, signal), bytes);
        const existing = await readStatusFile(sessionId) ?? defaultStatus();
        if (signal === 'otel_logs') existing.otelLogsWritten = true;
        else if (signal === 'otel_metrics') existing.otelMetricsWritten = true;
        else existing.otelTracesWritten = true;
        await writeStatusFile(sessionId, existing);
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[otlp-ingest] ${signal} disk write error`, ...sanitizeLogArgs({ sessionId, err: msg }));
    }

    res.statusCode = 200;
    res.end();
    return true;
  }
}

export class OtlpPlugin implements ProxyPlugin {
  id = '@codemie/otlp';
  name = 'OTLP Ingestion';
  version = '1.0.0';
  priority = 10;

  createInterceptor(context: PluginContext): ProxyInterceptor {
    return new OtlpInterceptor(
      context.syncCredentials || context.credentials
    );
  }
}
