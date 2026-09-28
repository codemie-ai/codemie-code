/**
 * Codex rollout ↔ CodeMie session correlation.
 *
 * Codex has no hook that reports a transcript path, so on exit the plugin has to
 * find the rollout this run produced among ~/.codex/sessions and record it in
 * the CodeMie session record (`correlation.agentSessionFile`). Analytics resolves
 * token usage and cost through that field.
 */

import { readdir, readFile, realpath as fsRealpath, stat } from 'fs/promises';
import { join } from 'path';
import type { SessionDescriptor } from '../../core/session/discovery-types.js';
import type { Session } from '../../core/session/types.js';
import type { CodexSessionAdapter } from './codex.session.js';
import { logger } from '../../../utils/logger.js';
import { getCodemiePath } from '../../../utils/paths.js';

/** Rollouts whose mtime predates the run start by more than this are ignored. */
const RUN_START_GRACE_MS = 10_000;
/** A rollout may record a start slightly before the launcher's clock reading. */
const CLOCK_SKEW_MS = 2_000;

export interface CodexRunInfo {
  /** CodeMie session id of this run. */
  sessionId: string;
  /** Unix ms when this run was launched. */
  startedAt: number;
  /** Working directory the run was launched in. */
  cwd: string;
}

type RolloutSource = Pick<CodexSessionAdapter, 'discoverSessions' | 'parseSessionFile'>;

/**
 * Find the rollout file produced by this run, or undefined when nothing matches.
 *
 * Candidates are rollouts in the same cwd touched since the run started, minus
 * rollouts another CodeMie session already claimed (a concurrent run in the same
 * cwd). Among those, the rollout whose own start (session_meta.timestamp) is
 * closest after this run's start wins; a resumed rollout with an older start is
 * only picked when no fresh one exists.
 */
export async function findRolloutForRun(
  adapter: RolloutSource,
  run: CodexRunInfo
): Promise<SessionDescriptor | undefined> {
  const sessions = await adapter.discoverSessions({ maxAgeDays: 1, limit: 20 });
  const cwdReal = await safeRealpath(run.cwd);
  const claimed = await listClaimedRolloutFiles(run.sessionId, run.startedAt - RUN_START_GRACE_MS);
  const candidates: RolloutCandidate[] = [];

  for (const session of sessions) {
    if (session.createdAt < run.startedAt - RUN_START_GRACE_MS || claimed.has(session.filePath)) {
      continue;
    }

    try {
      const parsed = await adapter.parseSessionFile(session.filePath, run.sessionId);
      const projectPath = parsed.metadata?.projectPath;
      if (!projectPath) continue;
      const projectReal = await safeRealpath(projectPath);
      if (projectReal === cwdReal) {
        const rolloutStart = Date.parse(parsed.metadata?.createdAt ?? '');
        candidates.push({ descriptor: session, rolloutStart: Number.isNaN(rolloutStart) ? undefined : rolloutStart });
      }
    } catch (error) {
      logger.debug('[codex] Skipping unparsable rollout candidate:', error);
    }
  }

  if (candidates.length > 1) {
    logger.debug(
      `[codex] ${candidates.length} rollout candidates for session ${run.sessionId}; ` +
        'picking the one that started closest after the run'
    );
  }
  return pickRollout(candidates, run.startedAt)?.descriptor;
}

interface RolloutCandidate {
  descriptor: SessionDescriptor;
  /** session_meta.timestamp in Unix ms, when the rollout carries one. */
  rolloutStart?: number;
}

/**
 * Prefer the rollout that started closest after the run; fall back to the most
 * recently written one (e.g. a resumed rollout). Ties break on file path so the
 * pick is deterministic.
 */
function pickRollout(candidates: RolloutCandidate[], runStartedAt: number): RolloutCandidate | undefined {
  const byPath = (a: RolloutCandidate, b: RolloutCandidate): number =>
    a.descriptor.filePath.localeCompare(b.descriptor.filePath);
  const fresh = candidates
    .filter((c) => c.rolloutStart !== undefined && c.rolloutStart >= runStartedAt - CLOCK_SKEW_MS)
    .sort((a, b) => (a.rolloutStart as number) - (b.rolloutStart as number) || byPath(a, b));
  if (fresh.length > 0) return fresh[0];
  return [...candidates].sort((a, b) => b.descriptor.createdAt - a.descriptor.createdAt || byPath(a, b))[0];
}

/**
 * Rollout paths already recorded by other CodeMie session records. Only records
 * written since `sinceMs` are read — an older record cannot have claimed a
 * rollout of this run — which keeps the scan to a stat per file.
 */
async function listClaimedRolloutFiles(ownSessionId: string, sinceMs: number): Promise<Set<string>> {
  const claimed = new Set<string>();
  const sessionsDir = getCodemiePath('sessions');
  let files: string[];
  try {
    files = await readdir(sessionsDir);
  } catch {
    return claimed;
  }

  await Promise.all(
    files.map(async (file) => {
      if (!file.endsWith('.json') || file.endsWith('-codemie-marker.json')) return;
      const filePath = join(sessionsDir, file);
      try {
        if ((await stat(filePath)).mtimeMs < sinceMs) return;
        const session = JSON.parse(await readFile(filePath, 'utf-8')) as Partial<Session>;
        const agentSessionFile = session.correlation?.agentSessionFile;
        if (agentSessionFile && session.sessionId !== ownSessionId) {
          claimed.add(agentSessionFile);
        }
      } catch {
        logger.debug(`[codex] Skipping unreadable session record during rollout claim scan: ${file}`);
      }
    })
  );
  return claimed;
}

/**
 * Point the CodeMie session record at the rollout this run produced.
 *
 * Without this every codex session reported hadLog=false and costUSD=0. It also
 * lets the native loader recognise the rollout as CodeMie-owned instead of an
 * untracked session.
 */
export async function recordRolloutCorrelation(sessionId: string, rolloutPath: string): Promise<void> {
  try {
    const { SessionStore } = await import('../../core/session/SessionStore.js');
    const store = new SessionStore();
    const session = await store.loadSession(sessionId);
    if (!session) {
      logger.debug(`[codex] No session record for ${sessionId}; skipping rollout correlation`);
      return;
    }
    const existing = session.correlation?.agentSessionFile;
    if (existing && existing !== rolloutPath) {
      logger.warn(`[codex] Session ${sessionId} is already correlated to another rollout; keeping it`);
      return;
    }
    session.correlation = {
      ...session.correlation,
      status: 'matched',
      agentSessionFile: rolloutPath,
    };
    await store.saveSession(session);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.debug(`[codex] Failed to record rollout correlation (non-blocking): ${msg}`);
  }
}

/**
 * Resolve a path through symlinks, falling back to the original path on error.
 * Used so a `cwd` of `/Users/foo` and a rollout's `projectPath` of
 * `/private/Users/foo` (or vice versa) compare equal.
 */
async function safeRealpath(p: string): Promise<string> {
  try {
    return await fsRealpath(p);
  } catch {
    return p;
  }
}
