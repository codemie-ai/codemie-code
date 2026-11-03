/**
 * Transcript parse-state persistence.
 *
 * Transcript parsing is incremental: each parse pass picks up where the previous one
 * left off (byte offsets into the main transcript and per-subagent transcripts),
 * tracks usage requests opened but not yet closed by their matching response, the
 * currently active skill, and per-branch request counts. This module persists that
 * state to disk between parse passes, keyed by session id.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getCodemiePath } from '@/utils/paths.js';
import { acquirePidLock } from '@/utils/pid-lock.js';
import type { SessionEnvFields } from '../event-fields/session-env-fields.js';

export interface OpenUsageRequest {
  /** API request id (`req_...`); `''` when the transcript has none (e.g. behind the proxy). */
  requestId: string;
  /** `message.id` (`msg_...`). */
  messageId: string;
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
  thinkingTokens: number | null;
  webSearchRequests: number;
  webFetchRequests: number;
  scopeKind: 'main' | 'skill' | 'agent';
  scopeName: string;
  agentId: string;
  /** The subagent's type (e.g. `'Explore'`); `''` for `scopeKind: 'main' | 'skill'`. */
  agentType: string;
  stopReason: string;
  isApiError: boolean;
  gitBranch: string;
  /** The line's `requestedModel` (Claude Code 2.1.295+), in the form SessionStart `model` and the
   *  model-switch hooks use; `''` when the line has none; absent in a record saved before it existed. */
  requestedModel?: string;
  /** The line's `attributionSkill` — the skill or command Claude Code attributes the request to;
   *  `''` when the line has none; absent in a record saved before it existed. */
  attributionSkill?: string;
}

export interface TranscriptParseState {
  mainOffset: number;
  subagentOffsets: Record<string, number>;
  openRequests: Record<string, OpenUsageRequest>; // key: usageRequestKey()
  activeSkill: string;
  branchCounts: Record<string, number>;
  gitHeadStart: string;
  sessionStartedAt: string;
  lastSessionEnvFields: SessionEnvFields | null;
  /** The `end` timestamp of the last `compact_boundary` line reported as `agent.session.compact.done`
   *  — `''` when none yet. Not an offset: `openPostCompactPass` scans the whole transcript for
   *  `compact_boundary` lines independently of `mainOffset`, since a sibling hook can advance
   *  `mainOffset` past one without ever looking for it. */
  lastCompactionEnd: string;
  /** `uuid`s of the main transcript's `user` / `assistant` lines already counted, so a re-written
   *  copy in later bytes is skipped. An array, not a `Set`, so it survives the JSON save; absent in
   *  a state saved before it existed. */
  seenMessageUuids?: string[];
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
    gitHeadStart: '',
    sessionStartedAt: '',
    lastSessionEnvFields: null,
    lastCompactionEnd: '',
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

function getLockPath(sessionId: string): string {
  return `${getParseStatePath(sessionId)}.lock`;
}

/**
 * Acquire the per-session parse-state lock across concurrent hook processes (e.g. sibling
 * `SubagentStop` fires for the same session), via {@link acquirePidLock} in `wait` mode.
 * Each hook fire is a fresh CLI process, so an in-memory mutex won't do.
 *
 * If the lock is not acquired within the helper's wait budget, this throws rather than
 * returning a release function; the caller skips its pass and the next hook resumes from the
 * saved offsets.
 *
 * Returns a release function. It is idempotent (safe to call more than once) so a caller's
 * cleanup path can call it without tracking whether it already ran.
 */
export async function acquireParseStateLock(sessionId: string): Promise<() => Promise<void>> {
  const lockPath = getLockPath(sessionId);
  await mkdir(dirname(lockPath), { recursive: true });

  const lock = await acquirePidLock(lockPath, { mode: 'wait', pidOnlyLiveness: true });
  if (!lock) {
    throw new Error(`Timed out waiting for the parse-state lock (session ${sessionId})`);
  }
  return () => lock.release();
}

/**
 * Serialize one session's load-mutate-save parse-state cycle under {@link acquireParseStateLock}.
 */
export async function withParseStateLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireParseStateLock(sessionId);
  try {
    return await fn();
  } finally {
    await release();
  }
}
