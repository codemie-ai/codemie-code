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
 * The SSO proxy already runs a 2-minute timer that pushes the JSONL we write
 * to the CodeMie API (sso.session-sync.plugin.ts), so this module's job is
 * only to keep the JSONL warm.
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

async function safeRealpath(p: string): Promise<string> {
  try {
    return await fsRealpath(p);
  } catch {
    return p;
  }
}
