/**
 * The analytics intake of the local daemon: hook batches and OTLP exports land in the local spool, with no project
 * rule, no stamp and nothing sent; at the start and every sweep interval a Copilot CLI session whose end hook never
 * came gets the end its transcript holds, then the sessions past their grace move into the analytics folder.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import type { ProxyPlugin, ProxyInterceptor } from './types.js';
import type { ProxyContext } from '../proxy-types.js';
import type { ProxyHTTPClient } from '../proxy-http-client.js';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { createOtlpIntake } from './otlp-intake.js';
import { listSessionIds, useSpoolRoot } from './otlp-spool/spool-paths.js';
import { localSpoolRoot } from './otlp-spool/analytics-folder-paths.js';
import { sweepToFolder } from './otlp-spool/analytics-folder.js';
import { markSessionEnded } from './otlp-spool/session-status.js';
import {
  SESSION_END_TYPE,
  lateSessionEndSkip,
  recoverMissingSessionEnds,
  scheduleCopilotUsageEnrichment,
} from './otlp-spool/copilot-usage-enrichment.js';
import { sweepIntervalMs } from './otlp-spool/spool-config.js';

class LocalAnalyticsInterceptor implements ProxyInterceptor {
  name = 'local-analytics';

  private sweepHandle?: NodeJS.Timeout;
  private sweeping?: Promise<void>;
  private readonly intake = createOtlpIntake({
    projectNamesOf: () => undefined,
    // A late end hook of a Copilot CLI session whose end the sweep already recovered is accepted and not written.
    skipHooksWrite: (sessionId, agentName, batchEvents) => lateSessionEndSkip(agentName, sessionId, batchEvents),
    afterHooksWrite: async (sessionId, agentName, batchEvents) => {
      // Copilot writes its token rollup only after the sessionEnd hook exits: read it from here.
      scheduleCopilotUsageEnrichment(agentName, batchEvents);
      // Nothing is forwarded here, so the end of a session is marked when its hook is written.
      if (batchEvents.some((event) => event?.['type'] === SESSION_END_TYPE)) await markSessionEnded(sessionId);
    },
    // The local mode stamps nothing, so a stamp loss an earlier CLI's hook reports is answered and written nowhere.
    recordStampLoss: async () => undefined,
    // One export of a process that changed its session id holds records of both sessions; each goes to its own file.
    splitJsonBySession: true,
  });

  async onProxyStart(): Promise<void> {
    useSpoolRoot(localSpoolRoot());
    // A session that ended, or a move left half-done, while no proxy ran is taken now, not an interval later.
    this.sweep();
    this.sweepHandle = setInterval(() => this.sweep(), sweepIntervalMs());
  }

  async onProxyStop(): Promise<void> {
    if (this.sweepHandle) clearInterval(this.sweepHandle);
    this.sweepHandle = undefined;
    // A stop waits for the sweep under way, so no file of a move is still being written once the proxy has stopped.
    await this.sweeping;
  }

  /** One sweep at a time: a tick that comes while one runs is dropped. */
  private sweep(): void {
    this.sweeping ??= this.runSweep().finally(() => {
      this.sweeping = undefined;
    });
  }

  private async runSweep(): Promise<void> {
    try {
      await recoverMissingSessionEnds(await listSessionIds());
      await sweepToFolder();
    } catch (err) {
      logger.debug('[local-analytics] sweep error', ...sanitizeLogArgs({ err: err instanceof Error ? err.message : String(err) }));
    }
  }

  async handleRequest(
    ctx: ProxyContext,
    _req: IncomingMessage,
    res: ServerResponse,
    _httpClient: ProxyHTTPClient
  ): Promise<boolean> {
    const { method, url } = ctx;
    if (method !== 'POST') return false;
    if (url === '/v1/analytics/hooks') return this.intake.handleHooks(ctx, res);
    if (url === '/v1/analytics/otlp/v1/logs') return this.intake.handleOtlp(ctx, res, 'logs');
    if (url === '/v1/analytics/otlp/v1/metrics') return this.intake.handleOtlp(ctx, res, 'metrics');
    if (url === '/v1/analytics/otlp/v1/traces') return this.intake.handleOtlp(ctx, res, 'traces');
    return false;
  }
}

export class LocalAnalyticsPlugin implements ProxyPlugin {
  id = '@codemie/local-analytics';
  name = 'Local Analytics';
  version = '1.0.0';
  priority = 10;

  createInterceptor(): ProxyInterceptor {
    return new LocalAnalyticsInterceptor();
  }
}
