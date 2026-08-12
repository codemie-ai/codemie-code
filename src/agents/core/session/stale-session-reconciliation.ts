/**
 * Stale-Session Reconciliation
 *
 * Agent runs that are killed hard (kill -9, OS shutdown, a closed terminal, the
 * parent process dying) never reach `onSessionEnd`. Their session JSON in
 * `~/.codemie/sessions/{id}.json` stays `status: "active"` forever and no terminal
 * `codemie_cli_session_total` lifecycle metric is emitted, so server-side analytics
 * see them as never-finishing.
 *
 * On `onSessionStart`, an agent scans for such stranded sessions of its own kind and
 * synthesises a SessionEnd with `reason: "interrupted"` to finalise them.
 *
 * Inactivity threshold defaults to 30 minutes; the lookback window is capped to
 * 24 hours so a first deploy does not emit a burst of synthetic events for ancient
 * stranded sessions.
 */
import { readdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { basename, join } from 'path';
import type { HookProcessingConfig } from '@/cli/commands/hook.js';
import type { Session } from './types.js';
import { getCodemiePath } from '@/utils/paths.js';
import { logger } from '@/utils/logger.js';

const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;
const DEFAULT_MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export interface ReconciliationOptions {
  /** Sessions inactive for longer than this are considered stale. */
  inactivityThresholdMs?: number;
  /** Sessions started before (now - this) are skipped. */
  maxLookbackMs?: number;
  /** Override clock for tests. */
  now?: number;
}

export interface ReconcileOptions extends ReconciliationOptions {
  /** Injected for tests. Defaults to the real `processEvent` from the hook module. */
  processEvent?: ProcessEventFn;
}

export interface StaleSession {
  sessionId: string;
  startTime: number;
  lastActivityMs: number;
}

export interface SessionEndEventLike {
  hook_event_name: 'SessionEnd';
  session_id: string;
  transcript_path: string;
  permission_mode: string;
  cwd: string;
  reason: string;
}

export type ProcessEventFn = (
  event: SessionEndEventLike,
  config: HookProcessingConfig,
) => Promise<void>;

/**
 * Find sessions of `agentName` in `~/.codemie/sessions/` that look stranded.
 */
export async function findStaleSessions(
  agentName: string,
  opts: ReconciliationOptions = {},
): Promise<StaleSession[]> {
  const now = opts.now ?? Date.now();
  const inactivityThresholdMs = opts.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS;
  const maxLookbackMs = opts.maxLookbackMs ?? DEFAULT_MAX_LOOKBACK_MS;

  const sessionsDir = getCodemiePath('sessions');
  if (!existsSync(sessionsDir)) {
    return [];
  }

  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch (error) {
    logger.debug(`[${agentName}-reconciliation] Failed to read sessions dir`, error);
    return [];
  }

  const stale: StaleSession[] = [];
  const cutoffActivity = now - inactivityThresholdMs;
  const cutoffStart = now - maxLookbackMs;

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    if (entry.startsWith('completed_')) continue;
    if (entry.includes('_metrics') || entry.includes('_conversation')) continue;

    const filePath = join(sessionsDir, entry);
    let session: Session;
    try {
      const content = await readFile(filePath, 'utf-8');
      session = JSON.parse(content) as Session;
    } catch (error) {
      logger.debug(
        `[${agentName}-reconciliation] Skipping unreadable file ${basename(filePath)}`,
        error,
      );
      continue;
    }

    if (session.agentName !== agentName) continue;
    if (session.status !== 'active') continue;
    if (typeof session.startTime !== 'number') continue;
    if (session.startTime < cutoffStart) continue;

    const lastActivity = computeLastActivity(session);
    if (lastActivity > cutoffActivity) continue;

    stale.push({
      sessionId: session.sessionId,
      startTime: session.startTime,
      lastActivityMs: lastActivity,
    });
  }

  return stale;
}

/**
 * Synthesise a SessionEnd for each stale session of `agentName`.
 *
 * `processEvent` is injected so tests can drive this without touching the hook
 * module's network and SSO-credential code paths.
 */
export async function reconcileStaleSessions(
  agentName: string,
  env: NodeJS.ProcessEnv,
  buildHookConfig: (env: NodeJS.ProcessEnv, sessionId: string) => HookProcessingConfig,
  opts: ReconcileOptions = {},
): Promise<{ reconciled: number; failed: number }> {
  const stale = await findStaleSessions(agentName, opts);
  if (stale.length === 0) {
    return { reconciled: 0, failed: 0 };
  }

  logger.info(
    `[${agentName}-reconciliation] Found ${stale.length} stranded ${agentName} session(s); reconciling`,
  );

  const processEvent = opts.processEvent ?? (await loadDefaultProcessEvent());

  let reconciled = 0;
  let failed = 0;

  for (const entry of stale) {
    try {
      const event: SessionEndEventLike = {
        hook_event_name: 'SessionEnd',
        session_id: entry.sessionId,
        transcript_path: '',
        permission_mode: 'default',
        cwd: process.cwd(),
        reason: 'interrupted',
      };
      await processEvent(event, buildHookConfig(env, entry.sessionId));
      reconciled++;
      logger.info(`[${agentName}-reconciliation] Reconciled stranded session ${entry.sessionId}`);
    } catch (error) {
      failed++;
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`[${agentName}-reconciliation] Failed to reconcile ${entry.sessionId}: ${msg}`);
    }
  }

  return { reconciled, failed };
}

function computeLastActivity(session: Session): number {
  const candidates: number[] = [];
  if (typeof session.startTime === 'number') candidates.push(session.startTime);
  const metrics = session.sync?.metrics;
  if (metrics) {
    if (typeof metrics.lastSyncAt === 'number') candidates.push(metrics.lastSyncAt);
    if (typeof metrics.lastProcessedTimestamp === 'number') {
      candidates.push(metrics.lastProcessedTimestamp);
    }
  }
  const conversations = session.sync?.conversations;
  if (conversations && typeof conversations.lastSyncAt === 'number') {
    candidates.push(conversations.lastSyncAt);
  }
  return candidates.length === 0 ? 0 : Math.max(...candidates);
}

async function loadDefaultProcessEvent(): Promise<ProcessEventFn> {
  const mod = await import('@/cli/commands/hook.js');
  return mod.processEvent as unknown as ProcessEventFn;
}
