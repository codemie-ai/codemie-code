import { mkdirSync, openSync, closeSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isSafeSessionId } from '@/agents/core/session-id.js';
import { getCodemiePath } from '@/utils/paths.js';
import { logger } from '@/utils/logger.js';
import type { SummaryCounters, SummaryDetails } from './copilot-cli-otlp.usage.js';

/** Per-session hook-side state lives in two small files so the hot tool path never touches usage state. */
const LOCK_STALE_MS = 2_000;
const LOCK_RETRY_MS = 10;
const SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const STATE_BUDGET_MS = 150;
/** Tool start/end pairing decides whether a call counts as successful, so it waits longer for the lock. */
export const TOOL_STATE_BUDGET_MS = 750;

export function getStateDir(): string {
  return getCodemiePath('otlp', 'copilot-cli');
}

export function toolsStatePath(sessionId: string): string {
  return join(getStateDir(), `${sessionId}.tools.json`);
}

export function sessionStatePath(sessionId: string): string {
  return join(getStateDir(), `${sessionId}.session.json`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryAcquire(lockPath: string): boolean {
  try {
    closeSync(openSync(lockPath, 'wx'));
    return true;
  } catch {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
        unlinkSync(lockPath);
      }
    } catch {
      // Lock vanished or cannot be inspected: retry.
    }
    return false;
  }
}

/** Runs `fn` under an `O_EXCL` lock with stale recovery; returns undefined when the budget is exhausted. */
export async function withStateLock<T>(
  statePath: string,
  fn: () => T,
  budgetMs: number = STATE_BUDGET_MS
): Promise<T | undefined> {
  const lockPath = `${statePath}.lock`;
  const deadline = Date.now() + budgetMs;
  try {
    mkdirSync(getStateDir(), { recursive: true });
  } catch {
    return undefined;
  }
  while (!tryAcquire(lockPath)) {
    if (Date.now() >= deadline) {
      logger.debug('[copilot-cli-otlp] state lock budget exhausted');
      return undefined;
    }
    await sleep(LOCK_RETRY_MS);
  }
  try {
    return fn();
  } catch (error) {
    logger.debug('[copilot-cli-otlp] state operation failed', error);
    return undefined;
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // Already removed as stale.
    }
  }
}

export function readState<T extends object>(statePath: string, fallback: T): T {
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath, 'utf-8'));
    return typeof parsed === 'object' && parsed !== null ? { ...fallback, ...(parsed as T) } : fallback;
  } catch {
    return fallback;
  }
}

export function writeStateAtomic(statePath: string, value: object): void {
  const tmp = `${statePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), 'utf-8');
  renameSync(tmp, statePath);
}

export interface UsageCursor {
  /** Byte offset of the first unread complete line of events.jsonl. */
  offset: number;
  lastEventTs: string;
  startedAt: string;
  counters: SummaryCounters;
  details: SummaryDetails;
  /** Last model seen, so an incremental slice without `session.model_change` can still label messages. */
  model?: string;
}

export interface SessionState {
  usageCursor?: UsageCursor;
  clientVersion?: string;
  /** Used only when the hook's cwd is not a git repo. */
  gitFallback?: { git_branch?: string; repo_remote?: string };
  /** Session-state root when COPILOT_HOME overrides the default. */
  sessionStateRoot?: string;
  /** Set on a sub-agent's own state: the root session its hooks and tool calls belong to. */
  parentSessionId?: string;
}

const MAX_PARENT_DEPTH = 5;

/** Follows sub-agent -> parent links to the root session; returns the id itself when it is not a sub-agent. */
export function resolveRootSessionId(sessionId: string): string {
  let current = sessionId;
  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth++) {
    const parent = readSessionState(current).parentSessionId;
    if (!parent || !isSafeSessionId(parent) || parent === current) break;
    current = parent;
  }
  return current;
}

export function readSessionState(sessionId: string): SessionState {
  if (!isSafeSessionId(sessionId)) return {};
  return readState<SessionState>(sessionStatePath(sessionId), {});
}

export async function updateSessionState(
  sessionId: string,
  patch: Partial<SessionState>,
  budgetMs: number = STATE_BUDGET_MS
): Promise<boolean> {
  if (!isSafeSessionId(sessionId)) return false;
  const path = sessionStatePath(sessionId);
  const done = await withStateLock(path, () => {
    writeStateAtomic(path, { ...readState<SessionState>(path, {}), ...patch });
    return true;
  }, budgetMs);
  return done === true;
}

/** Removes both state files of a finished session (daemon, after the final pass). */
export function deleteSessionStateFiles(sessionId: string): void {
  if (!isSafeSessionId(sessionId)) return;
  for (const path of [toolsStatePath(sessionId), sessionStatePath(sessionId)]) {
    try {
      unlinkSync(path);
    } catch {
      // Nothing to remove.
    }
  }
}

/** Best-effort removal of state files untouched for 24 h. */
export function sweepStaleStateFiles(now: number = Date.now()): void {
  try {
    const dir = getStateDir();
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      try {
        if (now - statSync(path).mtimeMs > SWEEP_MAX_AGE_MS) unlinkSync(path);
      } catch {
        // Concurrent removal.
      }
    }
  } catch {
    // Directory does not exist yet.
  }
}
