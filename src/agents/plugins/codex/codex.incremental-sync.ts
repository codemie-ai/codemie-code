// src/agents/plugins/codex/codex.incremental-sync.ts
/**
 * Codex Incremental Sync Timer
 *
 * In-process timer that periodically re-parses the active Codex rollout file
 * and writes per-call_id metric deltas + new conversation slices to JSONL.
 *
 * Why this exists: Codex 0.129.0 advertises a `hooks` feature, but on
 * 2026-05-09 smoke tests on `codex exec` neither -c overrides
 * (`-c 'hooks.SessionStart=[...]'`) nor a direct `[[hooks.SessionStart]]`
 * block in `~/.codex/config.toml` fired the configured command. See
 * docs/superpowers/plans/2026-05-09-codex-hooks-incremental-sync.md.
 *
 * The incremental sync timer writes per-call_id metric deltas + new
 * conversation slices to JSONL on every tick, then uploads PENDING payloads
 * to the CodeMie API via SessionSyncer when SSO credentials are available.
 */

import { realpath as fsRealpath } from 'fs/promises';
import type { AgentMetadata } from '../../core/types.js';
import type { ProcessingContext } from '../../core/session/BaseProcessor.js';
import { CodexSessionAdapter } from './codex.session.js';
import { logger } from '../../../utils/logger.js';

export interface StartCodexIncrementalSyncOptions {
  /** CodeMie session id (file naming key). */
  sessionId: string;
  /** ms-since-epoch lower bound used to ignore stale rollouts. */
  startedAt: number;
  /** Working directory to match the rollout's projectPath against. */
  cwd: string;
  /** Codex agent metadata (passed straight to CodexSessionAdapter). */
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

const DEFAULT_INTERVAL_MS = 30_000;
const STARTED_AT_GRACE_MS = 10_000;

const activeTimers = new Map<string, NodeJS.Timeout>();
const tickInFlight = new Map<string, boolean>();

export function startCodexIncrementalSync(options: StartCodexIncrementalSyncOptions): void {
  if (process.env.CODEMIE_CODEX_SYNC_ENABLED === 'false') {
    logger.debug('[codex-incremental-sync] Disabled by CODEMIE_CODEX_SYNC_ENABLED=false');
    return;
  }
  if (activeTimers.has(options.sessionId)) {
    logger.debug(`[codex-incremental-sync] Already running for session ${options.sessionId}`);
    return;
  }

  const intervalMs = Number(process.env.CODEMIE_CODEX_SYNC_INTERVAL_MS) || DEFAULT_INTERVAL_MS;

  const tick = async (): Promise<void> => {
    if (tickInFlight.get(options.sessionId)) return;
    tickInFlight.set(options.sessionId, true);

    try {
      const adapter = new CodexSessionAdapter(options.metadata);
      const sessions = await adapter.discoverSessions({ maxAgeDays: 1, limit: 10 });
      if (sessions.length === 0) return;

      const cwdReal = await safeRealpath(options.cwd);

      for (const descriptor of sessions) {
        if (descriptor.createdAt < options.startedAt - STARTED_AT_GRACE_MS) continue;

        let parsed;
        try {
          parsed = await adapter.parseSessionFile(descriptor.filePath, options.sessionId);
        } catch (error) {
          logger.debug('[codex-incremental-sync] parse failed, skipping', error);
          continue;
        }

        const projectPath = (parsed.metadata as { projectPath?: string } | undefined)?.projectPath;
        if (!projectPath) continue;
        const projectReal = await safeRealpath(projectPath);
        if (projectReal !== cwdReal) continue;

        try {
          const result = await adapter.processSession(
            descriptor.filePath,
            options.sessionId,
            options.buildContext()
          );
          logger.debug(
            `[codex-incremental-sync] tick ok session=${options.sessionId} records=${result.totalRecords}`
          );
        } catch (error) {
          logger.error('[codex-incremental-sync] processSession failed:', error);
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
                `[codex-incremental-sync] upload ${syncResult.success ? 'ok' : 'partial'}: ${syncResult.message}`
              );
            }
          } catch (error) {
            logger.error('[codex-incremental-sync] upload failed:', error);
          }
        }

        return; // Only the most recent matching rollout per tick.
      }
    } catch (error) {
      logger.error('[codex-incremental-sync] tick failed:', error);
    } finally {
      tickInFlight.set(options.sessionId, false);
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  // Don't pin the Node event loop alive solely on this timer; if the parent
  // process is otherwise idle we want it to exit cleanly when Codex finishes.
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  activeTimers.set(options.sessionId, timer);

  logger.debug(
    `[codex-incremental-sync] Started (session=${options.sessionId}, intervalMs=${intervalMs})`
  );
}

export function stopCodexIncrementalSync(sessionId: string): void {
  const timer = activeTimers.get(sessionId);
  if (!timer) return;

  clearInterval(timer);
  activeTimers.delete(sessionId);
  tickInFlight.delete(sessionId);
  logger.debug(`[codex-incremental-sync] Stopped (session=${sessionId})`);
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
      logger.debug('[codex-incremental-sync] No SSO credentials available, skipping upload');
      return null;
    }
    const cookies = Object.entries(credentials.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    return {
      apiBaseUrl: syncApiUrl,
      cookies,
      clientType: 'codemie-codex',
      version,
      dryRun: false,
      sessionId,
    };
  } catch (error) {
    logger.debug('[codex-incremental-sync] Failed to build upload context:', error);
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
