import type { IncomingMessage, ServerResponse } from 'http';
import type { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import type { ProxyContext, ProxyConfig } from '../proxy-types.js';
import type { ProxyHTTPClient } from '../proxy-http-client.js';
import type { SSOCredentials, JWTCredentials } from '../../../../core/types.js';
import { isSafeSessionId } from '../../../../../agents/core/session-id.js';
import { logger } from '../../../../../utils/logger.js';
import { sanitizeLogArgs } from '../../../../../utils/security.js';
import { listSessionIds } from './otlp-spool/spool-paths.js';
import { sweepSpool } from './otlp-spool/sweep.js';
import { processSessionTick } from './otlp-spool/tick-processor.js';
import { appendSpool } from './otlp-spool/spool-io.js';
import { hookEventProjectNames } from './otlp-spool/session-project.js';
import { scheduleCopilotUsageEnrichment } from './otlp-spool/copilot-usage-enrichment.js';
import { sendIntervalMs, sweepIntervalMs } from './otlp-spool/spool-config.js';
import { areCredentialsStale, clearCredentialsStale, resolveFreshCredentials } from './otlp-spool/auth-state.js';

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
  /** The complete wire-ready event, built at hook time by the adapter. */
  hookEvent: string;
}

/** One hook invocation's batch, as the hook process POSTs it. */
export interface OtlpHookBatchRequest {
  agentName: string;
  hookEvents: Record<string, unknown>[];
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

  constructor(
    private credentials: SSOCredentials | JWTCredentials | undefined,
    private readonly config: ProxyConfig | undefined
  ) {}

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


  /**
   * Re-reads the credential store when `markCredentialsStale()` is set, so a
   * successful SSO re-login the user completes while this daemon keeps running
   * is picked up without a restart. A no-op whenever credentials aren't stale.
   */
  private async refreshCredentialsIfStale(): Promise<void> {
    if (!areCredentialsStale() || !this.config) {
      return;
    }

    try {
      const refreshed = await resolveFreshCredentials(this.config);
      if (refreshed) {
        this.credentials = refreshed;
        clearCredentialsStale();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug('[otlp-ingest] credential refresh attempt failed', ...sanitizeLogArgs({ err: msg }));
    }
  }

  private async tick(): Promise<void> {
    await this.refreshCredentialsIfStale();

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

    void this.refreshCredentialsIfStale();

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

  /**
   * One hook invocation's batch, appended to the spool as one write so the client's
   * commit decision (advance its transcript cursor or not) can be a single boolean.
   */
  private async handleHooks(ctx: ProxyContext, res: ServerResponse): Promise<true> {
    if (!ctx.metadata.gatewayKeyValidated) {
      logger.warn('[otlp-ingest] Rejected hooks request: gateway key not validated');
      return sendError(res, 401, 'authentication_error', 'Unauthorized');
    }

    if (!ctx.requestBody) {
      return sendError(res, 400, 'invalid_request_error', 'Empty body');
    }

    let batch: OtlpHookBatchRequest;
    try {
      batch = JSON.parse(ctx.requestBody.toString('utf-8')) as OtlpHookBatchRequest;
    } catch {
      return sendError(res, 400, 'invalid_request_error', 'Invalid JSON');
    }

    if (!Array.isArray(batch.hookEvents)) {
      return sendError(res, 400, 'invalid_request_error', 'Missing hookEvents array');
    }

    // Validate agentName - dynamic import avoids circular dependency
    try {
      const { AgentRegistry } = await import('../../../../../agents/registry.js');
      if (!AgentRegistry.getAnalyticsAgent(batch.agentName)) {
        return sendError(res, 400, 'invalid_request_error', 'Unrecognized agentName');
      }
    } catch {
      return sendError(res, 400, 'invalid_request_error', 'Agent validation failed');
    }

    // A batch is one hook invocation, so it is single-session. Events without a
    // session_id are discarded individually; a batch mixing more than one non-empty
    // session_id is rejected whole, so the client's commit stays all-or-nothing.
    let sessionId = '';
    const lines: string[] = [];
    const projectNames: string[] = [];
    for (const event of batch.hookEvents) {
      const eventSessionId = String((event as Record<string, unknown> | null)?.['session_id'] ?? '');
      if (!eventSessionId) {
        logger.debug('[otlp-ingest] hooks: no session_id in hookEvent, discarding');
        continue;
      }
      if (!isSafeSessionId(eventSessionId)) {
        return sendError(res, 400, 'invalid_request_error', 'Invalid session_id');
      }
      if (!sessionId) {
        sessionId = eventSessionId;
      } else if (sessionId !== eventSessionId) {
        return sendError(res, 400, 'invalid_request_error', 'Mixed session_id in one batch');
      }
      const spoolRecord: OtlpHookSpoolData = { agentName: batch.agentName, hookEvent: JSON.stringify(event) };
      lines.push(JSON.stringify(spoolRecord));
      projectNames.push(...hookEventProjectNames(event));
    }

    if (lines.length === 0) {
      // Every event lacked a session_id — nothing to retry, so accept without spooling.
      res.statusCode = 202;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ accepted: true }));
      return true;
    }

    try {
      await appendSpool(sessionId, 'hooks', lines.join('\n') + '\n', projectNames);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('[otlp-ingest] hooks disk write error', ...sanitizeLogArgs({ sessionId, err: msg }));
      return sendError(res, 500, 'api_error', 'Failed to persist hooks batch');
    }

    // Copilot writes its token rollup only after the sessionEnd hook exits: read it from here.
    try {
      scheduleCopilotUsageEnrichment(batch.agentName, batch.hookEvents as Record<string, unknown>[]);
    } catch (err) {
      logger.warn('[otlp-ingest] copilot usage scheduling failed', ...sanitizeLogArgs({ sessionId, err: err instanceof Error ? err.message : String(err) }));
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
      context.syncCredentials || context.credentials,
      context.config
    );
  }
}
