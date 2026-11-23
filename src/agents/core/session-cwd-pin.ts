import { createHash } from 'node:crypto';
import { readFile, readdir, unlink, rmdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { writeJsonFileAtomic } from '@/utils/atomic-write.js';
import { logger } from '@/utils/logger.js';
import { PIN_DIR, PIN_TTL_MS, pinKey } from './session-project-pin.js';

/**
 * Session-to-directory mapping, written by the hook (which has a cwd) and read by the proxy daemon (which has none),
 * so the daemon can resolve the project-scoped analytics settings for a session's OTLP export.
 *
 * Layout: `<PIN_DIR>/<sha256(session)>.cwd/<sha256(cwd)>.json`, one file per directory, so concurrent first hooks
 * never read-modify-write a shared file (no lock needed). Directory, hashing and TTL are the session project pin's;
 * its own `<hash>.json` files are never touched.
 *
 * Cap: at most `MAX_CWDS` directories per session. A further one is not recorded, but an `overflow` marker is: the
 * daemon treats any recorded directory as in scope, so silently ignoring a dropped one could leave a project that
 * is on resolved as off. The marker makes the session resolve `on` (protective).
 */
const MAX_CWDS = 8;
const OVERFLOW_FILE = 'overflow.json';
/** A recorded entry is rewritten once older than this, so a long-lived session keeps its mapping past the TTL. */
const REFRESH_AFTER_MS = 60 * 60 * 1000;

interface CwdEntry {
  /** Absent in the overflow marker. */
  cwd?: string;
  pinnedAt: number;
}

function sessionDir(sessionId: string): string {
  return join(PIN_DIR, `${pinKey(sessionId)}.cwd`);
}

function cwdFile(sessionId: string, cwd: string): string {
  return join(sessionDir(sessionId), `${createHash('sha256').update(cwd).digest('hex')}.json`);
}

function parseEntry(raw: string): CwdEntry | undefined {
  const parsed = JSON.parse(raw) as Partial<CwdEntry> | null;
  if (!parsed || typeof parsed.pinnedAt !== 'number') return undefined;
  if (parsed.cwd !== undefined && (typeof parsed.cwd !== 'string' || !isAbsolute(parsed.cwd))) return undefined;
  return { cwd: parsed.cwd, pinnedAt: parsed.pinnedAt };
}

const isFresh = (entry: CwdEntry): boolean => Date.now() - entry.pinnedAt < PIN_TTL_MS;

/** Fresh entry of one file; an expired one is deleted (best-effort), an unreadable or corrupt one is just absent. */
async function readEntry(file: string): Promise<CwdEntry | undefined> {
  let entry: CwdEntry | undefined;
  try {
    entry = parseEntry(await readFile(file, 'utf-8'));
  } catch {
    return undefined;
  }
  if (entry && isFresh(entry)) return entry;
  if (entry) await unlink(file).catch(() => undefined);
  return undefined;
}

async function readAll(sessionId: string): Promise<{ cwds: string[]; overflow: boolean }> {
  const dir = sessionDir(sessionId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { cwds: [], overflow: false };
  }
  const cwds: string[] = [];
  let overflow = false;
  for (const name of names) {
    const entry = await readEntry(join(dir, name));
    if (!entry) continue;
    if (name === OVERFLOW_FILE) overflow = true;
    else if (entry.cwd) cwds.push(entry.cwd);
  }
  if (names.length > 0 && cwds.length === 0 && !overflow) await rmdir(dir).catch(() => undefined);
  return { cwds, overflow };
}

/** Directories recorded for the session by its hooks; empty when none (no hook yet, expired, or unreadable). */
export async function readSessionCwds(sessionId: string): Promise<string[]> {
  if (!sessionId) return [];
  return (await readAll(sessionId)).cwds;
}

/** True when the session ran in more directories than were recorded; callers must then resolve protectively. */
export async function hasSessionCwdOverflow(sessionId: string): Promise<boolean> {
  if (!sessionId) return false;
  return (await readAll(sessionId)).overflow;
}

async function write(file: string, entry: CwdEntry): Promise<void> {
  await writeJsonFileAtomic(file, entry satisfies CwdEntry, { directoryMode: 0o700 });
}

/** Records that a directory was dropped; rewritten only when stale, so a session stuck at the cap does not write per hook. */
async function markOverflow(sessionId: string): Promise<void> {
  const file = join(sessionDir(sessionId), OVERFLOW_FILE);
  const current = await readFile(file, 'utf-8').then(parseEntry, () => undefined);
  if (current && Date.now() - current.pinnedAt < REFRESH_AFTER_MS) return;
  logger.warn(`[session-cwd-pin] directory cap (${MAX_CWDS}) reached for session ${pinKey(sessionId).slice(0, 12)}; it resolves protectively`);
  await write(file, { pinnedAt: Date.now() });
}

/** Best-effort: a failure is logged and never blocks the hook. One file read on the common (already recorded) path. */
export async function recordSessionCwd(sessionId: string, cwd: string): Promise<void> {
  if (!sessionId || !cwd || !isAbsolute(cwd)) return;
  try {
    const file = cwdFile(sessionId, cwd);
    let existing: CwdEntry | undefined;
    try {
      existing = parseEntry(await readFile(file, 'utf-8'));
    } catch {
      existing = undefined;
    }
    if (existing && Date.now() - existing.pinnedAt < REFRESH_AFTER_MS) return;
    if (!existing) {
      if ((await readAll(sessionId)).cwds.length >= MAX_CWDS) {
        await markOverflow(sessionId);
        return;
      }
    }
    await write(file, { cwd, pinnedAt: Date.now() });
  } catch (err) {
    logger.debug(`[session-cwd-pin] write failed: ${err instanceof Error ? err.name : 'error'}`);
  }
}
