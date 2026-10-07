/**
 * Transcript parse-state persistence.
 *
 * Transcript parsing is incremental: each parse pass picks up where the previous one
 * left off (byte offsets into the main transcript and per-subagent transcripts),
 * tracks usage requests opened but not yet closed by their matching response, the
 * currently active skill, and per-branch request counts. This module persists that
 * state to disk between parse passes, keyed by session id.
 */

import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
 * Unlike {@link loadParseState}, this does not swallow errors — a genuine write
 * failure (disk full, permissions) propagates to the caller rather than silently
 * discarding progress.
 */
export async function saveParseState(sessionId: string, state: TranscriptParseState): Promise<void> {
  const filePath = getParseStatePath(sessionId);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8');
}

const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 5_000;

function getLockPath(sessionId: string): string {
  return `${getParseStatePath(sessionId)}.lock`;
}

async function isLockStale(lockPath: string): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    return Date.now() - info.mtimeMs > LOCK_STALE_MS;
  } catch {
    return true; // disappeared between our EEXIST and this check — treat as gone
  }
}

/**
 * Serialize one session's load-mutate-save parse-state cycle across concurrent hook processes
 * (e.g. sibling `SubagentStop` fires for the same session) via an exclusive-create lock file.
 * Each hook fire is a fresh CLI process, so this cannot use an in-memory mutex.
 *
 * A lock older than {@link LOCK_STALE_MS} is treated as abandoned (its holder crashed before
 * releasing it) and stolen rather than awaited forever. Likewise, if the lock cannot be acquired
 * within a bounded wait, `fn` still runs unlocked rather than hanging the hook indefinitely —
 * occasional lost contention here is strictly better than analytics never shipping at all.
 */
export async function withParseStateLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = getLockPath(sessionId);
  await mkdir(dirname(lockPath), { recursive: true });

  const deadline = Date.now() + LOCK_STALE_MS * 2;
  let acquired = false;
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.close();
      acquired = true;
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        break; // can't lock (e.g. permissions) — proceed unlocked rather than block forever
      }
      if (await isLockStale(lockPath)) {
        await rm(lockPath, { force: true }).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) {
        break; // gave the lock a fair wait; proceed unlocked rather than hang the hook
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }

  try {
    return await fn();
  } finally {
    // Only release a lock we hold — when we proceeded unlocked, the file belongs to another process.
    if (acquired) {
      await rm(lockPath, { force: true }).catch(() => {});
    }
  }
}
