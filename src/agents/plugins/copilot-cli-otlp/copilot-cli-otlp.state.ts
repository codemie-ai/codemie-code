import { mkdirSync, openSync, closeSync, linkSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isSafeSessionId } from '@/agents/core/session-id.js';
import { getCodemiePath } from '@/utils/paths.js';
import { logger } from '@/utils/logger.js';
import type { OpenToolCall } from '@/agents/plugins/copilot-cli/copilot-cli.tool-activity.js';
import type { PendingMessage, SummaryCounters, SummaryDetails } from './copilot-cli-otlp.usage.js';

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

function readLockOwner(lockPath: string): string | undefined {
  try {
    return readFileSync(lockPath, 'utf-8');
  } catch {
    return undefined;
  }
}

function tryCreate(lockPath: string, token: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx');
  } catch {
    return undefined;
  }
  let stamped = false;
  try {
    writeSync(fd, token);
    stamped = true;
  } catch {
    // Handled below.
  }
  try {
    closeSync(fd);
  } catch {
    stamped = false;
  }
  if (stamped) return token;
  // The lock file exists but was not stamped (or not cleanly closed); remove it — after the handle
  // is closed, which Windows requires — so it doesn't block everyone else for the stale window.
  try {
    unlinkSync(lockPath);
  } catch {
    // Best effort.
  }
  return undefined;
}

/**
 * Tries to acquire the lock, stamping it with a unique owner token, and returns that token on
 * success. A stale lock is first renamed away (atomic, so one waiter wins), then its own mtime —
 * not a separately re-read owner token, which could read a different, freshly created file than
 * the one actually moved — is rechecked against the staleness window: a live lock created after
 * our initial stat but moved by our rename still carries its own (recent) creation mtime, so the
 * recheck fails and it is restored instead of being overwritten. The lock is then re-created with
 * `wx`, so two holders can never both succeed.
 */
function tryAcquire(lockPath: string): string | undefined {
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  if (tryCreate(lockPath, token)) return token;
  try {
    if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
      const tomb = `${lockPath}.${process.pid}.${Date.now()}.stale`;
      // Rename is atomic, so only one waiter removes a given lock file from the path.
      renameSync(lockPath, tomb);
      try {
        if (Date.now() - statSync(tomb).mtimeMs > LOCK_STALE_MS) return tryCreate(lockPath, token);
        // We moved a lock that was replaced after our stat: it is live, so put it back. If another
        // waiter has already created a new lock at the path, the moved one cannot be restored and
        // its holder loses exclusivity — an inherent limit of file-based stale takeover; the
        // holder's token-checked release leaves the newer lock alone.
        linkSync(tomb, lockPath);
      } finally {
        try {
          unlinkSync(tomb);
        } catch {
          // Best effort.
        }
      }
    }
  } catch {
    // Lock vanished mid-check, or cannot be replaced: retry.
  }
  return undefined;
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
  let token: string | undefined;
  while ((token = tryAcquire(lockPath)) === undefined) {
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
      // Only release the lock if it still carries our token: a stale-lock steal may have
      // replaced it with another process's token, and that lock is now theirs to release.
      if (readLockOwner(lockPath) === token) unlinkSync(lockPath);
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
  /** Tool calls started but not yet completed at the cursor, so a call spanning an agentStop is still counted. */
  openToolCalls?: Record<string, OpenToolCall>;
  /**
   * Trailing-segment Tier B messages held back because their matching `session.usage_record`
   * may still be in flight; retried on the next `agentStop`. See `buildUsageRows`.
   */
  pendingMessages?: PendingMessage[];
  /** True once this session has shown a `session.usage_record`, so a future hold-back is worth it. */
  sawUsageRecords?: boolean;
  /** True once any slice of this session was partial; carried into every later incremental summary. */
  usagePartial?: boolean;
}

export interface SessionState {
  usageCursor?: UsageCursor;
  clientVersion?: string;
  /** `session.start` branch/repository; applied per hook, only while that hook's cwd has no live git branch. */
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
