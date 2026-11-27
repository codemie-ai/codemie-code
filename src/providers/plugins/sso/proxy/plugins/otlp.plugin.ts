import type { IncomingMessage, ServerResponse } from 'http';
import type { ProxyPlugin, PluginContext, ProxyInterceptor, AnalyticsHealthReply } from './types.js';
import type { ProxyContext, ProxyConfig } from '../proxy-types.js';
import type { ProxyHTTPClient } from '../proxy-http-client.js';
import type { SSOCredentials, JWTCredentials } from '../../../../core/types.js';
import { withVerifiedOwner } from '../../../../core/credential-owner.js';
import { logger } from '../../../../../utils/logger.js';
import { sanitizeLogArgs } from '../../../../../utils/security.js';
import { listSessionIds, proxySpoolRoot, useSpoolRoot } from './otlp-spool/spool-paths.js';
import { sweepSpool } from './otlp-spool/sweep.js';
import { processSessionTick } from './otlp-spool/tick-processor.js';
import { recordStampLoss } from './otlp-spool/spool-io.js';
import { createOtlpIntake } from './otlp-intake.js';
import { hookEventProjectNames } from './otlp-spool/session-project.js';
import { sendIntervalMs, sweepIntervalMs } from './otlp-spool/spool-config.js';
import { processPendingOwner } from './otlp-spool/owner-pending-replay.js';
import { CREDENTIAL_REFRESH_INTERVAL_MS } from './credential-refresh.js';
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

export interface OtlpHookSpoolData {
  agentName: string;
  /** The complete wire-ready event, built at hook time by the adapter. */
  hookEvent: string;
  /** Provenance marker: the hook stamped a durable evidence record before spooling. Envelope only. */
  evidence_v?: 1;
  /** This run ended before a recorded resume. Deliver it without closing the current spool lifecycle. */
  historicalEnd?: true;
}

/** One hook invocation's batch, as the hook process POSTs it. */
export interface OtlpHookBatchRequest {
  agentName: string;
  evidence_v?: 1;
  /** The hook could not stamp and dropped `events` events of the session: recorded as a visible loss, nothing spooled. */
  evidence_loss?: { session_id: string; reason: string; events: number };
  hookEvents: Record<string, unknown>[];
}

export interface OtlpHookLifecycle {
  beforeSessionTicks(sessionIds: readonly string[]): Promise<void>;
  skipAppend(agentName: string, sessionId: string, events: OtlpHookBatchRequest['hookEvents']): (() => Promise<boolean>) | undefined;
  afterBatchAccepted(agentName: string, events: OtlpHookBatchRequest['hookEvents']): void;
}

class OtlpInterceptor implements ProxyInterceptor {
  name = 'otlp-ingest';

  private tickHandle?: NodeJS.Timeout;
  private sweepHandle?: NodeJS.Timeout;
  private ticking = false;
  private lastStoredRead = 0;
  private stopped = false;
  private readonly intake = createOtlpIntake({
    projectNamesOf: (events) => events.flatMap((event) => hookEventProjectNames(event)),
    // The lifecycle's own steps around a hooks batch: what it leaves unwritten, and its follow-up once the batch is
    // accepted (Copilot writes its token rollup only after the sessionEnd hook exits: it is read from there).
    skipHooksWrite: (sessionId, agentName, batchEvents) => this.hookLifecycle?.skipAppend(agentName, sessionId, batchEvents),
    afterHooksWrite: (_sessionId, agentName, batchEvents) => this.hookLifecycle?.afterBatchAccepted(agentName, batchEvents),
    recordStampLoss: (loss) => recordStampLoss(loss.session_id, loss.reason, loss.events),
  });

  constructor(
    private credentials: SSOCredentials | JWTCredentials | undefined,
    private readonly config: ProxyConfig | undefined,
    private readonly hookLifecycle?: OtlpHookLifecycle
  ) {}

  healthStatus(): AnalyticsHealthReply {
    return { credentials: areCredentialsStale() ? 'stale' : 'ok' };
  }

  async onProxyStart(): Promise<void> {
    useSpoolRoot(proxySpoolRoot());
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
    // The cap timer is cleared once the flush settles so it never holds the exit.
    let flushTimeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.tick().catch(() => undefined),
        new Promise((resolve) => {
          flushTimeout = setTimeout(resolve, SHUTDOWN_FLUSH_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(flushTimeout);
    }
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
   * is picked up without a restart. Outside the tick it is a no-op whenever credentials aren't stale;
   * the tick (`periodic`) also re-reads the store at most once per `CREDENTIAL_REFRESH_INTERVAL_MS`.
   */
  private async refreshCredentialsIfStale(periodic = false): Promise<void> {
    const stale = areCredentialsStale();
    // The tick also re-reads on a throttle: hooks stamp with the stored login, and a re-login (account
    // switch) rejects nothing outgoing, so no stale marker would ever move this snapshot to it.
    const due = periodic && Date.now() - this.lastStoredRead >= CREDENTIAL_REFRESH_INTERVAL_MS;
    if ((!stale && !due) || !this.config) {
      return;
    }
    this.lastStoredRead = Date.now();

    try {
      const refreshed = await resolveFreshCredentials(this.config);
      if (refreshed) {
        this.credentials = refreshed;
        if (stale) clearCredentialsStale();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug('[otlp-ingest] credential refresh attempt failed', ...sanitizeLogArgs({ err: msg }));
    }
  }

  private async tick(): Promise<void> {
    await this.refreshCredentialsIfStale(true);

    // Same owner the hook stamps with: the forwarder's evidence key must match it.
    const creds = this.credentials && (await withVerifiedOwner(this.credentials));
    if (!creds) {
      await processPendingOwner(undefined); // still expires held hook events
      return;
    }

    const sessionIds = await listSessionIds();
    await this.hookLifecycle?.beforeSessionTicks(sessionIds);

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

    // Hook events held for a login whose owner was unknown: replay under this login, expire past retention (no hook
    // needed). After the walk, so a replayed session is sent by the next tick.
    await processPendingOwner(creds, undefined, this.hookLifecycle);
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
      return this.intake.handleHooks(ctx, res);
    }

    // Route: POST /v1/analytics/otlp/logs|metrics|traces
    if (method === 'POST' && url === '/v1/analytics/otlp/v1/logs') {
      return this.intake.handleOtlp(ctx, res, 'logs');
    }
    if (method === 'POST' && url === '/v1/analytics/otlp/v1/metrics') {
      return this.intake.handleOtlp(ctx, res, 'metrics');
    }
    if (method === 'POST' && url === '/v1/analytics/otlp/v1/traces') {
      return this.intake.handleOtlp(ctx, res, 'traces');
    }

    return false;
  }
}

export class OtlpPlugin implements ProxyPlugin {
  id = '@codemie/otlp';
  name = 'OTLP Ingestion';
  version = '1.0.0';
  priority = 10;

  constructor(private readonly hookLifecycle?: OtlpHookLifecycle) {}

  createInterceptor(context: PluginContext): ProxyInterceptor {
    return new OtlpInterceptor(
      context.syncCredentials || context.credentials,
      context.config,
      this.hookLifecycle
    );
  }
}
