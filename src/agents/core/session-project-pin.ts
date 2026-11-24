import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getCodemiePath } from '@/utils/paths.js';
import { logger } from '@/utils/logger.js';

const PIN_DIR = getCodemiePath('otlp-session-project');
const TTL_MS = 24 * 60 * 60 * 1000; // 24h - long enough for a `--resume`d session the next day.

interface PinEntry {
  project: string;
  pinnedAt: number;
}

/** `session_id` is hook-supplied input; hashed so it can never escape `PIN_DIR` as a path. */
function pinFile(sessionId: string): string {
  const hash = createHash('sha256').update(sessionId).digest('hex');
  return join(PIN_DIR, `${hash}.json`);
}

async function readPin(sessionId: string): Promise<PinEntry | undefined> {
  const file = pinFile(sessionId);
  try {
    const raw = await readFile(file, 'utf-8');
    const entry = JSON.parse(raw) as PinEntry;
    if (typeof entry.project === 'string' && entry.project && Date.now() - entry.pinnedAt < TTL_MS) {
      return entry;
    }
  } catch {
    return undefined;
  }
  // Expired: best-effort cleanup so a long-dead session's pin doesn't accumulate forever.
  try {
    await unlink(file);
  } catch {
    /* already gone, or a concurrent writer just replaced it: either is fine */
  }
  return undefined;
}

/**
 * The project name pinned for this session's first hook, if any and not past its TTL.
 * `undefined` when unpinned (first hook of the session, or an expired/corrupt pin).
 */
export async function readPinnedProjectName(sessionId: string): Promise<string | undefined> {
  if (!sessionId) {
    return undefined;
  }
  return (await readPin(sessionId))?.project;
}

/**
 * Pins `project` (already resolved, non-blank) as this session's project, for every later
 * hook to read back unchanged — the fix for a session whose cwd-resolved project would
 * otherwise be re-derived (and could drift) on every single hook.
 *
 * Hooks of one session can run concurrently, so the write is exclusive (`wx`): the first
 * hook to get here wins and every later/concurrent one, including this call's own loser,
 * reads back and returns the winner's value instead of its own — one project per session,
 * regardless of write order.
 */
export async function pinProjectName(sessionId: string, project: string): Promise<string> {
  if (!sessionId || !project) {
    return project;
  }
  const file = pinFile(sessionId);
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ project, pinnedAt: Date.now() } satisfies PinEntry), { flag: 'wx' });
    return project;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      const existing = await readPin(sessionId);
      if (existing) {
        return existing.project;
      }
      // Lost the race against a write that then expired or vanished before we could read it
      // back (astronomically unlikely at a 24h TTL): fall through and use our own value.
    } else {
      logger.debug(`[session-project-pin] pin write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return project;
  }
}
