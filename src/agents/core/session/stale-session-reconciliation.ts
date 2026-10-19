/**
 * Stale-Session Reconciliation
 *
 * Agent runs that are killed hard (kill -9, OS shutdown, a closed terminal, the
 * parent process dying) never reach `onSessionEnd`. Their session JSON in
 * `~/.codemie/sessions/{id}.json` stays `status: "active"` forever and no terminal
 * `codemie_cli_session_total` lifecycle metric is emitted, so server-side analytics
 * see them as never-finishing.
 *
 * On `onSessionStart`, an agent sweeps stranded generic hook-managed sessions across
 * agents and synthesises a SessionEnd with `reason: "interrupted"` to finalise them.
 * Scoping the trigger to "this agent launches again" would leave a dead `gemini`
 * session stranded forever once the user stops launching gemini. Runtime-managed
 * sessions (for example Desktop telemetry) are excluded here and must finalize
 * through their own runtime-specific path.
 *
 * Staleness (time since the last trustworthy sign of life, with no cap on how long a
 * session may have been inactive) is the shared rule in `./stale-session-policy.ts`,
 * also used by the Claude Desktop restart reconciliation in `DesktopTelemetryRuntime`,
 * so the two runtimes cannot silently diverge on the same backlog.
 */
import { readdir, readFile, stat, unlink, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { basename, join } from 'path';
import type { HookProcessingConfig } from '@/cli/commands/hook.js';
import type { Session } from './types.js';
import { getCodemiePath } from '@/utils/paths.js';
import { logger } from '@/utils/logger.js';
import { isSessionStale, DEFAULT_INACTIVITY_THRESHOLD_MS } from './stale-session-policy.js';

export interface ReconciliationOptions {
  /** Sessions inactive for longer than this are considered stale. */
  inactivityThresholdMs?: number;
  /** Override clock for tests. */
  now?: number;
}

export interface ReconcileOptions extends ReconciliationOptions {
  /** Injected for tests. Defaults to the real `processEvent` from the hook module. */
  processEvent?: ProcessEventFn;
}

export interface StaleSession {
  sessionId: string;
  agentName: string;
  clientType?: string;
  startTime: number;
  lastActivityMs: number;
  workingDirectory: string;
  provider: string;
  project?: string;
  model?: string;
  apiBaseUrl?: string;
  ssoUrl?: string;
  syncApiUrl?: string;
  profileName?: string;
  // Persisted transcript path for the stranded session. Synthetic SessionEnd must reuse
  // it so handleSessionEnd can run the same final transcript/incremental sync path a live
  // hook would, rather than marking the session completed with its final transcript delta
  // still unsynced.
  agentSessionFile?: string;
  // Full transcript set for multi-transcript agents (e.g. Pi /new, /fork). Replaying only
  // the primary file during reconciliation would miss final deltas written to sibling files.
  agentSessionFiles?: string[];
  // The agent's own hook-reported session id (session.correlation.agentSessionId), distinct
  // from `sessionId` (CodeMie's internal UUID). A live SessionStart for claude/gemini/kimi
  // sends the start metric under this id (hook.ts's `event.session_id`); omitting it from the
  // synthetic SessionEnd would pair the end metric under the wrong id and strand the session
  // as open on the analytics backend.
  agentSessionId?: string;
}

export interface SessionEndEventLike {
  hook_event_name: 'SessionEnd';
  session_id: string;
  transcript_path: string;
  transcript_paths?: string[];
  permission_mode: string;
  cwd: string;
  reason: string;
  // Last real activity timestamp for the stranded session, not when reconciliation happens
  // to run — without it, `handleSessionEnd` would stamp endTime/activeDurationMs at "now"
  // and bill the entire dead-process gap as session duration.
  endTime?: number;
}

export type ProcessEventFn = (
  event: SessionEndEventLike,
  config: HookProcessingConfig,
) => Promise<void>;

const RECONCILIATION_LOCK_STALE_MS = 10 * 60 * 1000;

/**
 * Canonical env -> HookProcessingConfig mapping for stale-session reconciliation.
 * Mirrors the env-var keys hook.ts's getConfigValue maps to HookProcessingConfig
 * fields. BaseAgentAdapter.run() sets CODEMIE_AGENT and CODEMIE_CLIENT_TYPE from
 * this.metadata before onSessionStart runs, so both are always present here.
 *
 * When the reconciler sweeps across agents, the stale session's persisted
 * agentName/clientType must win over the launching process env or the synthetic
 * SessionEnd is mislabeled under the wrong agent/client type.
 */
export function buildReconciliationHookConfig(
  env: NodeJS.ProcessEnv,
  sessionId: string,
  staleSession?: Pick<
    StaleSession,
    'agentName' | 'clientType' | 'provider' | 'project' | 'model' | 'apiBaseUrl' | 'ssoUrl' | 'syncApiUrl' | 'profileName'
  >,
): HookProcessingConfig {
  return {
    agentName: staleSession?.agentName ?? env.CODEMIE_AGENT!,
    sessionId,
    provider: staleSession?.provider ?? env.CODEMIE_PROVIDER,
    apiBaseUrl: staleSession?.apiBaseUrl ?? env.CODEMIE_BASE_URL,
    ssoUrl: staleSession?.ssoUrl ?? env.CODEMIE_URL,
    syncApiUrl: staleSession?.syncApiUrl ?? env.CODEMIE_SYNC_API_URL,
    version: env.CODEMIE_CLI_VERSION,
    profileName: staleSession?.profileName ?? env.CODEMIE_PROFILE_NAME,
    project: staleSession?.project ?? env.CODEMIE_PROJECT,
    model: staleSession?.model ?? env.CODEMIE_MODEL,
    clientType: staleSession?.clientType ?? env.CODEMIE_CLIENT_TYPE,
  };
}

/**
 * Find generic hook-managed sessions in `~/.codemie/sessions/` that look stranded.
 * Pass `null` to scan across agents; pass an agent name to scope the scan.
 * Runtime-managed sessions are intentionally skipped here. For hook-managed CLI
 * sessions, the owning process refreshes a heartbeat while it is alive, so a
 * long-idle but still-open terminal is not treated as abandoned.
 */
export async function findStaleSessions(
  agentName: string | null,
  opts: ReconciliationOptions = {},
): Promise<StaleSession[]> {
  const now = opts.now ?? Date.now();
  const inactivityThresholdMs = opts.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS;

  const sessionsDir = getCodemiePath('sessions');
  if (!existsSync(sessionsDir)) {
    return [];
  }

  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch (error) {
    logger.debug(`[${agentName ?? 'all-agents'}-reconciliation] Failed to read sessions dir`, error);
    return [];
  }

  const stale: StaleSession[] = [];

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
        `[${agentName ?? 'all-agents'}-reconciliation] Skipping unreadable file ${basename(filePath)}`,
        error,
      );
      continue;
    }

    if (session.runtimeCheckpoint) continue;
    if (agentName !== null && session.agentName !== agentName) continue;
    if (session.status !== 'active') continue;
    if (typeof session.startTime !== 'number') continue;

    const lastActivity = computeLastActivity(session);
    const lastKnownAlive = computeLastKnownAlive(session, lastActivity);
    if (!isSessionStale({ now, lastActivityMs: lastKnownAlive, inactivityThresholdMs })) continue;

    stale.push({
      sessionId: session.sessionId,
      agentName: session.agentName,
      clientType: session.clientType,
      startTime: session.startTime,
      lastActivityMs: lastActivity,
      workingDirectory: session.workingDirectory,
      provider: session.provider,
      project: session.project,
      model: session.model,
      apiBaseUrl: session.analyticsContext?.apiBaseUrl,
      ssoUrl: session.analyticsContext?.ssoUrl,
      syncApiUrl: session.analyticsContext?.syncApiUrl,
      profileName: session.analyticsContext?.profileName,
      agentSessionFile: session.correlation?.agentSessionFile,
      agentSessionFiles: session.correlation?.agentSessionFiles,
      agentSessionId: session.correlation?.agentSessionId,
    });
  }

  return stale;
}

/**
 * Synthesise a SessionEnd for each stale session found. Pass `null` for
 * `agentName` to sweep across generic hook-managed sessions of every agent.
 *
 * `processEvent` is injected so tests can drive this without touching the hook
 * module's network and SSO-credential code paths.
 */
export async function reconcileStaleSessions(
  agentName: string | null,
  env: NodeJS.ProcessEnv,
  buildHookConfig: (
    env: NodeJS.ProcessEnv,
    sessionId: string,
    staleSession?: Pick<
      StaleSession,
      'agentName' | 'clientType' | 'provider' | 'project' | 'model' | 'apiBaseUrl' | 'ssoUrl' | 'syncApiUrl' | 'profileName'
    >
  ) => HookProcessingConfig,
  opts: ReconcileOptions = {},
): Promise<{ reconciled: number; failed: number }> {
  const stale = await findStaleSessions(agentName, opts);
  if (stale.length === 0) {
    return { reconciled: 0, failed: 0 };
  }

  const scope = agentName ?? 'all-agents';
  logger.info(
    `[${scope}-reconciliation] Found ${stale.length} stranded session(s); reconciling`,
  );

  const processEvent = opts.processEvent ?? (await loadDefaultProcessEvent());

  let reconciled = 0;
  let failed = 0;

  for (const entry of stale) {
    const lock = await acquireReconciliationLock(entry.sessionId);
    if (!lock) {
      logger.debug(`[${entry.agentName}-reconciliation] Skipping ${entry.sessionId}: another reconciliation is already in progress`);
      continue;
    }

    try {
      const current = await loadCurrentSession(entry.sessionId);
      if (!current || current.status !== 'active' || current.endTime !== undefined) {
        logger.debug(`[${entry.agentName}-reconciliation] Skipping ${entry.sessionId}: session is no longer active`);
        continue;
      }

      const event: SessionEndEventLike = {
        hook_event_name: 'SessionEnd',
        // Prefer the agent's own native id — the SessionStart metric was sent under it, so
        // the SessionEnd metric must be too, or the two never pair up on the analytics
        // backend. Fall back to the CodeMie id only when no native id was ever recorded.
        session_id: entry.agentSessionId ?? entry.sessionId,
        transcript_path: entry.agentSessionFile ?? entry.agentSessionFiles?.[0] ?? '',
        ...(entry.agentSessionFiles?.length ? { transcript_paths: entry.agentSessionFiles } : {}),
        permission_mode: 'default',
        cwd: entry.workingDirectory,
        reason: 'interrupted',
        endTime: entry.lastActivityMs,
      };
      await processEvent(event, buildHookConfig(env, entry.sessionId, entry));
      reconciled++;
      logger.info(`[${entry.agentName}-reconciliation] Reconciled stranded session ${entry.sessionId}`);
    } catch (error) {
      failed++;
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`[${entry.agentName}-reconciliation] Failed to reconcile ${entry.sessionId}: ${msg}`);
    } finally {
      await releaseReconciliationLock(lock);
    }
  }

  return { reconciled, failed };
}

function computeLastActivity(session: Session): number {
  const candidates: number[] = [];
  if (typeof session.startTime === 'number') candidates.push(session.startTime);
  // A process killed mid-turn can strand the freshest signal only in the session file itself:
  // activityStartedAt is written on UserPromptSubmit before any subsequent metrics/conversation
  // syncs happen. Reconciliation must treat that as real activity or the synthetic SessionEnd
  // can stamp endTime before the turn even started and lose activeDurationMs entirely.
  if (typeof session.activityStartedAt === 'number') candidates.push(session.activityStartedAt);
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

function computeLastKnownAlive(session: Session, lastActivity: number): number {
  const lastHeartbeatAt = session.liveness?.lastHeartbeatAt;
  return typeof lastHeartbeatAt === 'number' ? Math.max(lastActivity, lastHeartbeatAt) : lastActivity;
}

async function loadDefaultProcessEvent(): Promise<ProcessEventFn> {
  const mod = await import('@/cli/commands/hook.js');
  return mod.processEvent as unknown as ProcessEventFn;
}

function getCompletedSessionPath(sessionId: string): string {
  return getCodemiePath('sessions', `completed_${sessionId}.json`);
}

async function loadCurrentSession(sessionId: string): Promise<Session | null> {
  for (const path of [getCodemiePath('sessions', `${sessionId}.json`), getCompletedSessionPath(sessionId)]) {
    if (!existsSync(path)) {
      continue;
    }
    try {
      return JSON.parse(await readFile(path, 'utf-8')) as Session;
    } catch (error) {
      logger.debug('[stale-session-reconciliation] Failed to read current session while re-checking state', {
        sessionId,
        path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return null;
}

async function acquireReconciliationLock(sessionId: string): Promise<string | null> {
  const lockPath = getCodemiePath('sessions', `${sessionId}.reconcile.lock`);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(lockPath, String(process.pid), { flag: 'wx' });
      return lockPath;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        throw error;
      }

      if (!(await isStaleReconciliationLock(lockPath))) {
        return null;
      }

      try {
        await unlink(lockPath);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.debug('[stale-session-reconciliation] Failed to remove stale reconciliation lock', {
            sessionId,
            lockPath,
            error: unlinkError instanceof Error ? unlinkError.message : String(unlinkError),
          });
        }
      }
    }
  }

  return null;
}

async function isStaleReconciliationLock(lockPath: string): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    return Date.now() - info.mtimeMs > RECONCILIATION_LOCK_STALE_MS;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return true;
    }
    throw error;
  }
}

async function releaseReconciliationLock(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.debug('[stale-session-reconciliation] Failed to release reconciliation lock', {
        lockPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
