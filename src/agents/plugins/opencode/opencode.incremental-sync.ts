// src/agents/plugins/opencode/opencode.incremental-sync.ts
/**
 * OpenCode Incremental Sync Timer
 *
 * In-process timer that periodically re-parses the active OpenCode session and
 * writes new metric deltas + conversation payloads to JSONL, then uploads
 * anything still PENDING via SessionSyncer.
 *
 * Why this exists: turn boundaries are reported by the injected shell-hooks
 * plugin, which can fail to load, be filtered out by OpenCode's per-directory
 * event routing, or be disabled entirely. Everything the timer needs is already
 * durable in opencode.db, so this path keeps metrics and conversations flowing
 * even when no hook ever fires — only active_duration_ms depends on the hooks.
 *
 * Mirrors codex.incremental-sync.ts.
 */

import type { AgentMetadata } from '../../core/types.js';
import type { ProcessingContext } from '../../core/session/BaseProcessor.js';
import { OpenCodeSessionAdapter } from './opencode.session.js';
import { logger } from '../../../utils/logger.js';

export interface StartOpenCodeIncrementalSyncOptions {
  /** CodeMie session id (file naming key); its record's run selects the OpenCode session. */
  sessionId: string;
  /** OpenCode agent metadata (passed straight to OpenCodeSessionAdapter). */
  metadata: AgentMetadata;
  /** Builds a fresh ProcessingContext on each tick (cookies/version may rotate). */
  buildContext: () => ProcessingContext;
  /** CodeMie SSO URL used to load stored credentials (e.g. env.CODEMIE_URL). */
  ssoUrl?: string;
  /** Agent env (CODEMIE_PROFILE_CONFIG) for the profile-first credential lookup. */
  env?: NodeJS.ProcessEnv;
  /** Sync API base URL for the upload context: the launch's send path; none skips the upload. */
  syncApiUrl?: string;
  /** CLI version string forwarded to the upload context. */
  cliVersion?: string;
}

/**
 * 60s rather than Codex's 30s: the Stop hook and this timer both write
 * {id}_metrics.jsonl. MetricsWriter appends and MetricsSyncProcessor rewrites
 * that file under its lock, the rewrite re-reading it first, so no delta is lost
 * to an interleaved write; a slower tick only means fewer passes over a transcript
 * and fewer uploads.
 */
const DEFAULT_INTERVAL_MS = 60_000;

/** Lower bound for the override, so a bad value cannot spin on the live DB. */
const MIN_INTERVAL_MS = 5_000;

const activeTimers = new Map<string, NodeJS.Timeout>();
const tickInFlight = new Map<string, boolean>();

export function startOpenCodeIncrementalSync(options: StartOpenCodeIncrementalSyncOptions): void {
  if (process.env.CODEMIE_OPENCODE_SYNC_ENABLED === 'false') {
    logger.debug('[opencode-incremental-sync] Disabled by CODEMIE_OPENCODE_SYNC_ENABLED=false');
    return;
  }
  if (activeTimers.has(options.sessionId)) {
    logger.debug(`[opencode-incremental-sync] Already running for session ${options.sessionId}`);
    return;
  }

  // Floor the interval: every tick re-parses the user's live SQLite DB, so a
  // small or negative override (setInterval clamps <1 to 1ms) would spin on it.
  const intervalMs = Math.max(
    MIN_INTERVAL_MS,
    Number(process.env.CODEMIE_OPENCODE_SYNC_INTERVAL_MS) || DEFAULT_INTERVAL_MS
  );

  const tick = async (): Promise<void> => {
    if (tickInFlight.get(options.sessionId)) return;
    tickInFlight.set(options.sessionId, true);

    try {
      await syncOnce(options);
    } catch (error) {
      logger.error('[opencode-incremental-sync] tick failed:', error);
    } finally {
      tickInFlight.set(options.sessionId, false);
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  // Don't pin the Node event loop alive solely on this timer; if the parent
  // process is otherwise idle we want it to exit cleanly when OpenCode finishes.
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  activeTimers.set(options.sessionId, timer);

  logger.debug(
    `[opencode-incremental-sync] Started (session=${options.sessionId}, intervalMs=${intervalMs})`
  );
}

/**
 * One tick: re-parse each of the record's run's own sessions (the SessionEnd's selection), bounded by
 * the run's upper bound like the SessionEnd, then upload.
 */
async function syncOnce(options: StartOpenCodeIncrementalSyncOptions): Promise<void> {
  const adapter = new OpenCodeSessionAdapter(options.metadata);
  const located = await adapter.locateSessionTranscript(options.sessionId);
  if (!located) return;
  const tickContext = { ...options.buildContext(), recordsBeforeMs: located.recordsBeforeMs };

  // Each located session id: processing takes it as one of the run's sessions without selecting again
  for (const agentSessionId of located.sessionIds) {
    try {
      const result = await adapter.processSession(located.transcript, options.sessionId, { ...tickContext, agentSessionId });
      logger.debug(`[opencode-incremental-sync] tick ok session=${options.sessionId} (${agentSessionId}) records=${result.totalRecords}`);
    } catch (error) {
      logger.error('[opencode-incremental-sync] processSession failed:', error);
    }
  }

  if (!options.ssoUrl || !options.syncApiUrl) return;
  try {
    const uploadContext = await buildUploadContext(
      options.sessionId,
      options.ssoUrl,
      options.env,
      options.syncApiUrl,
      options.cliVersion,
      tickContext.clientType
    );
    if (uploadContext) {
      const { SessionSyncer } = await import('../../../providers/plugins/sso/session/SessionSyncer.js');
      const syncResult = await new SessionSyncer().sync(options.sessionId, uploadContext);
      logger.debug(`[opencode-incremental-sync] upload ${syncResult.success ? 'ok' : 'partial'}: ${syncResult.message}`);
    }
  } catch (error) {
    logger.error('[opencode-incremental-sync] upload failed:', error);
  }
}

export function stopOpenCodeIncrementalSync(sessionId: string): void {
  const timer = activeTimers.get(sessionId);
  if (!timer) return;

  clearInterval(timer);
  activeTimers.delete(sessionId);
  tickInFlight.delete(sessionId);
  logger.debug(`[opencode-incremental-sync] Stopped (session=${sessionId})`);
}

async function buildUploadContext(
  sessionId: string,
  ssoUrl: string,
  env: NodeJS.ProcessEnv | undefined,
  syncApiUrl: string,
  version = '0.0.0',
  clientType = 'codemie-opencode'
): Promise<ProcessingContext | null> {
  try {
    const { getStoredAnalyticsCredentials } = await import('../../../providers/core/codemie-auth-helpers.js');
    const credentials = (await getStoredAnalyticsCredentials(ssoUrl, env))?.credentials;
    if (!credentials?.cookies) {
      logger.debug('[opencode-incremental-sync] No SSO credentials available, skipping upload');
      return null;
    }
    const cookies = Object.entries(credentials.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    return {
      apiBaseUrl: syncApiUrl,
      cookies,
      clientType,
      version,
      dryRun: false,
      sessionId,
    };
  } catch (error) {
    logger.debug('[opencode-incremental-sync] Failed to build upload context:', error);
    return null;
  }
}
