import type { IncomingMessage, ServerResponse } from 'http';
import type { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import type { ProxyContext } from '../proxy-types.js';
import type { ProxyHTTPClient } from '../proxy-http-client.js';
import type { SSOCredentials, JWTCredentials } from '../../../../core/types.js';
import { logger } from '../../../../../utils/logger.js';
import { sanitizeLogArgs } from '../../../../../utils/security.js';
import { listSessionIds } from './otlp-spool/spool-paths.js';
import { sweepSpool } from './otlp-spool/sweep.js';
import { processSessionTick } from './otlp-spool/tick-processor.js';
import { appendSpool } from './otlp-spool/spool-io.js';
import { sendIntervalMs, sweepIntervalMs } from './otlp-spool/spool-config.js';

/**
 * Upper bound on the best-effort flush during proxy shutdown.
 *
 * Deliberately well below FORWARD_TIMEOUT_MS (10s) so a hung backend can never
 * be the reason a proxy stop is slow. Cutting the flush short loses nothing:
 * cursors are only advanced on success, so anything undelivered stays spooled
 * and is sent by the next proxy start.
 */
const SHUTDOWN_FLUSH_TIMEOUT_MS = 5_000;
const UUID_V4_RE = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

export interface OtlpHookSpoolData {
  agentName: string;
  raw: string;
  timestamp: number;
}

function sendError(res: ServerResponse, status: number, type: string, message: string): true {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
  return true;
}

class OtlpInterceptor implements ProxyInterceptor {
  name = 'otlp-ingest';

  private tickHandle?: NodeJS.Timeout;
  private sweepHandle?: NodeJS.Timeout;
  private ticking = false;
  private stopped = false;

  constructor(private readonly credentials?: SSOCredentials | JWTCredentials) {}

  async onProxyStart(): Promise<void> {
    // Recovery pass for anything a previous process left on disk (crash, or a
    // stale-credential window that this restart just ended). Intentionally not
    // awaited: the backlog may be large and proxy start must not block on network I/O.
    void this.runTick('startup');

    this.tickHandle = setInterval(() => void this.runTick('tick'), sendIntervalMs());
    this.sweepHandle = setInterval(() => void this.runSweep(), sweepIntervalMs());
  }

  async onProxyStop(): Promise<void> {
    this.stopped = true;
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
    }
    if (this.sweepHandle) {
      clearInterval(this.sweepHandle);
    }
    this.tickHandle = undefined;
    this.sweepHandle = undefined;

    // Bounded final flush: better delivery latency, but shutdown must never hang.
    await Promise.race([
      this.tick().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_FLUSH_TIMEOUT_MS)),
    ]);
  }

  /** Serialize ticks: a slow backlog drain must not stack up concurrent passes. */
  private async runTick(label: string): Promise<void> {
    if (this.stopped || this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      await this.tick();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug(`[otlp-ingest] ${label} error`, ...sanitizeLogArgs({ err: msg }));
    } finally {
      this.ticking = false;
    }
  }

  private async runSweep(): Promise<void> {
    if (this.stopped) {
      return;
    }

    try {
      await sweepSpool();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug('[otlp-ingest] sweep error', ...sanitizeLogArgs({ err: msg }));
    }
  }


  private async tick(): Promise<void> {
    const creds = this.credentials;
    if (!creds) {
      return;
    }

    const sessionIds = await listSessionIds();

    // Different sessions are independent (per-session locking happens inside
    // processSessionTick), so they are processed concurrently.
    await Promise.all(
      sessionIds.map((sessionId) =>
        processSessionTick(sessionId, creds).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger.debug(
            '[otlp-ingest] session tick error',
            ...sanitizeLogArgs({ sessionId, err: msg })
          );
        })
      )
    );
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
      return this.handleOtlp(ctx, res, 'logs');
    }
    if (method === 'POST' && url === '/v1/analytics/otlp/v1/metrics') {
      return this.handleOtlp(ctx, res, 'metrics');
    }
    if (method === 'POST' && url === '/v1/analytics/otlp/v1/traces') {
      return this.handleOtlp(ctx, res, 'traces');
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

    const rawOtlpHookSpoolData = ctx.requestBody.toString('utf-8');

    let otlpHookSpoolData: OtlpHookSpoolData;

    try {
      otlpHookSpoolData = JSON.parse(rawOtlpHookSpoolData) as OtlpHookSpoolData;
    } catch {
      return sendError(res, 400, 'invalid_request_error', 'Invalid JSON');
    }

    // Validate agentName - dynamic import avoids circular dependency
    try {
      const { AgentRegistry } = await import('../../../../../agents/registry.js');
      if (!AgentRegistry.getAnalyticsAgent(otlpHookSpoolData.agentName)) {
        return sendError(res, 400, 'invalid_request_error', 'Unrecognized agentName');
      }
    } catch {
      return sendError(res, 400, 'invalid_request_error', 'Agent validation failed');
    }

    // Extract session_id from raw hook JSON
    let sessionId = '';
    try {
      const hookEvent = JSON.parse(otlpHookSpoolData.raw) as Record<string, unknown>;
      sessionId = String(hookEvent['session_id'] ?? '');
    } catch { /* ignore */ }

    if (!sessionId) {
      // No session id — log and accept without spooling
      logger.debug('[otlp-ingest] hooks: no session_id in raw, discarding');
      res.statusCode = 202;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ accepted: true }));
      return true;
    }

    const line = rawOtlpHookSpoolData + '\n';
    try {
      await appendSpool(sessionId, 'hooks', line);
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
    signal: 'logs' | 'metrics' | 'traces'
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
      logger.debug('[otlp-ingest] no session id in payload, dropping', ...sanitizeLogArgs({ signal, bytes: bytes.length }));
      res.statusCode = 200;
      res.end();
      return true;
    }

    try {
      await appendSpool(sessionId, signal, bytes);
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
