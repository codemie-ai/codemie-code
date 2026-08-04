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

import { realpath as fsRealpath } from 'fs/promises';
import type { AgentMetadata } from '../../core/types.js';
import type { ProcessingContext } from '../../core/session/BaseProcessor.js';
import { OpenCodeSessionAdapter } from './opencode.session.js';
import { logger } from '../../../utils/logger.js';

export interface StartOpenCodeIncrementalSyncOptions {
  /** CodeMie session id (file naming key). */
  sessionId: string;
  /** ms-since-epoch lower bound used to ignore stale sessions. */
  startedAt: number;
  /** Working directory to match the OpenCode session's directory against. */
  cwd: string;
  /** OpenCode agent metadata (passed straight to OpenCodeSessionAdapter). */
  metadata: AgentMetadata;
  /** Builds a fresh ProcessingContext on each tick (cookies/version may rotate). */
  buildContext: () => ProcessingContext;
  /** CodeMie SSO URL used to load stored credentials (e.g. env.CODEMIE_URL). */
  ssoUrl?: string;
  /** Sync API base URL for the upload context (env.CODEMIE_SYNC_API_URL ?? env.CODEMIE_BASE_URL). */
  syncApiUrl?: string;
  /** CLI version string forwarded to the upload context. */
  cliVersion?: string;
}

/**
 * 60s rather than Codex's 30s: the Stop hook and this timer both write
 * {id}_metrics.jsonl, and MetricsSyncProcessor rewrites that file atomically
 * while MetricsWriter appends to it. A slower tick narrows the window in which
 * an appended delta can be lost to an interleaved rewrite.
 */
const DEFAULT_INTERVAL_MS = 60_000;

/** Lower bound for the override, so a bad value cannot spin on the live DB. */
const MIN_INTERVAL_MS = 5_000;
const STARTED_AT_GRACE_MS = 10_000;

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
      const adapter = new OpenCodeSessionAdapter(options.metadata);
      // cwd is pushed into the SQL predicate, so this never scans other repos'
      // sessions out of the user's shared opencode.db.
      const sessions = await adapter.discoverSessions({
        maxAgeDays: 1,
        limit: 10,
        cwd: options.cwd,
      });
      if (sessions.length === 0) return;

      const cwdReal = await safeRealpath(options.cwd);

      for (const descriptor of sessions) {
        if (descriptor.createdAt < options.startedAt - STARTED_AT_GRACE_MS) continue;

        const projectPath = descriptor.projectPath;
        if (!projectPath) continue;
        if ((await safeRealpath(projectPath)) !== cwdReal) continue;

        try {
          const result = await adapter.processSession(
            descriptor.filePath,
            options.sessionId,
            { ...options.buildContext(), agentSessionId: descriptor.sessionId }
          );
          logger.debug(
            `[opencode-incremental-sync] tick ok session=${options.sessionId} records=${result.totalRecords}`
          );
        } catch (error) {
          logger.error('[opencode-incremental-sync] processSession failed:', error);
        }

        if (options.ssoUrl && options.syncApiUrl) {
          try {
            const uploadContext = await buildUploadContext(
              options.sessionId,
              options.ssoUrl,
              options.syncApiUrl,
              options.cliVersion
            );
            if (uploadContext) {
              const { SessionSyncer } = await import('../../../providers/plugins/sso/session/SessionSyncer.js');
              const syncer = new SessionSyncer();
              const syncResult = await syncer.sync(options.sessionId, uploadContext);
              logger.debug(
                `[opencode-incremental-sync] upload ${syncResult.success ? 'ok' : 'partial'}: ${syncResult.message}`
              );
            }
          } catch (error) {
            logger.error('[opencode-incremental-sync] upload failed:', error);
          }
        }

        return; // Only the most recent matching session per tick.
      }
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
  syncApiUrl: string,
  version = '0.0.0'
): Promise<ProcessingContext | null> {
  try {
    const { CodeMieSSO } = await import('../../../providers/plugins/sso/sso.auth.js');
    const sso = new CodeMieSSO();
    const credentials = await sso.getStoredCredentials(ssoUrl);
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
      clientType: 'codemie-opencode',
      version,
      dryRun: false,
      sessionId,
    };
  } catch (error) {
    logger.debug('[opencode-incremental-sync] Failed to build upload context:', error);
    return null;
  }
}

async function safeRealpath(p: string): Promise<string> {
  try {
    return await fsRealpath(p);
  } catch {
    return p;
  }
}
