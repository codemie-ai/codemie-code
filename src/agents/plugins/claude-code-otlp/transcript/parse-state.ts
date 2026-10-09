/**
 * Transcript parse-state persistence.
 *
 * Transcript parsing is incremental: each parse pass picks up where the previous one
 * left off (byte offsets into the main transcript and per-subagent transcripts),
 * tracks usage requests opened but not yet closed by their matching response, the
 * currently active skill, and per-branch request counts. This module persists that
 * state to disk between parse passes, keyed by session id.
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getCodemiePath } from '@/utils/paths.js';

export interface OpenUsageRequest {
  requestId: string;
  model: string;
  modelRaw: string;
  timestamp: string;
  speed: string;
  inferenceGeo: string;
  serviceTier: string;
  inputTokens: number;
  cacheCreation5mTokens: number;
  cacheCreation1hTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  webSearchRequests: number;
  webFetchRequests: number;
  scopeKind: 'main' | 'skill' | 'agent';
  scopeName: string;
  agentId: string;
  stopReason: string;
  isApiError: boolean;
  gitBranch: string;
}

export interface TranscriptParseState {
  mainOffset: number;
  subagentOffsets: Record<string, number>;
  openRequests: Record<string, OpenUsageRequest>; // key: `${requestId}::${model}`
  activeSkill: string;
  branchCounts: Record<string, number>;
  compactionCount: number;
}

/**
 * Build a fresh, empty parse state.
 */
export function createParseState(): TranscriptParseState {
  return {
    mainOffset: 0,
    subagentOffsets: {},
    openRequests: {},
    activeSkill: '',
    branchCounts: {},
    compactionCount: 0,
  };
}

function getParseStatePath(sessionId: string): string {
  return getCodemiePath('analytics', 'state', `${sessionId}.json`);
}

/**
 * Load the persisted parse state for a session.
 *
 * Never throws: a missing file, malformed JSON, or any other I/O failure all fall
 * back to a fresh state via {@link createParseState}, since transcript parsing must
 * keep going (as if starting fresh) rather than fail the whole run over stale/corrupt
 * state on disk.
 */
export async function loadParseState(sessionId: string): Promise<TranscriptParseState> {
  try {
    const raw = await readFile(getParseStatePath(sessionId), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<TranscriptParseState>;

    return { ...createParseState(), ...parsed };
  } catch {
    return createParseState();
  }
}

/**
 * Persist parse state for a session, creating the parent directory if needed.
 *
 * Writes to a sibling temp file and renames it into place, so a concurrent
 * {@link loadParseState} never observes a partially written file (`rename` replaces the
 * target atomically on both POSIX and Windows).
 *
 * Unlike {@link loadParseState}, this does not swallow errors — a genuine write
 * failure (disk full, permissions) propagates to the caller rather than silently
 * discarding progress.
 */
export async function saveParseState(sessionId: string, state: TranscriptParseState): Promise<void> {
  const filePath = getParseStatePath(sessionId);
  const tmpPath = `${filePath}.tmp`;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
  await rename(tmpPath, filePath);
}

const LOCK_RETRY_MS = 25;
const LOCK_WAIT_BUDGET_MS = 10_000;
const EMPTY_LOCK_STALE_MS = 5_000;
// Windows reports EPERM/EACCES/EBUSY, not EEXIST, when creating a lock whose deletion is pending.
const LOCK_CONTENTION_CODES = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);

function getLockPath(sessionId: string): string {
  return `${getParseStatePath(sessionId)}.lock`;
}

/** A pid we cannot signal for any reason other than ESRCH (e.g. EPERM) is treated as alive. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Remove the lock only if it still holds `expected`, so a lock created meanwhile is never removed. */
async function removeLockIfUnchanged(lockPath: string, expected: string): Promise<void> {
  if ((await readFile(lockPath, 'utf-8').catch(() => null)) === expected) {
    await rm(lockPath, { force: true }).catch(() => {});
  }
}

/**
 * Serialize one session's load-mutate-save parse-state cycle across concurrent hook processes
 * (e.g. sibling `SubagentStop` fires for the same session) via an exclusive-create lock file
 * holding the owner's pid. Each hook fire is a fresh CLI process, so an in-memory mutex won't do.
 *
 * A lock is reclaimed only when its owner pid is dead, never by age, so a slow holder keeps it.
 * If the lock is not acquired within {@link LOCK_WAIT_BUDGET_MS}, this throws instead of running
 * `fn` unlocked; the caller skips the pass and the next hook resumes from the saved offsets.
 */
export async function withParseStateLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = getLockPath(sessionId);
  await mkdir(dirname(lockPath), { recursive: true });

  const deadline = Date.now() + LOCK_WAIT_BUDGET_MS;
  for (;;) {
    try {
      await writeFile(lockPath, String(process.pid), { flag: 'wx' });
      break;
    } catch (err) {
      if (!LOCK_CONTENTION_CODES.has((err as NodeJS.ErrnoException).code ?? '')) {
        throw err;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for the parse-state lock (session ${sessionId})`);
      }

      const holder = await readFile(lockPath, 'utf-8').catch(() => null);
      const holderPid = Number.parseInt(holder ?? '', 10);
      if (holder !== null && !Number.isNaN(holderPid) && !isPidAlive(holderPid)) {
        await removeLockIfUnchanged(lockPath, holder);
        continue;
      }
      if (holder === '') {
        // Created but not yet written, or its creator died in between.
        const info = await stat(lockPath).catch(() => null);
        if (info && Date.now() - info.mtimeMs > EMPTY_LOCK_STALE_MS) {
          await removeLockIfUnchanged(lockPath, holder);
          continue;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true }).catch(() => {});
  }
}
