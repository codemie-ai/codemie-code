import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { getCodemiePath } from '@/utils/paths.js';
import { writeJsonFileAtomic } from '@/utils/atomic-write.js';
import { logger } from '@/utils/logger.js';

/**
 * Session-to-directory mapping, written by the hook (which has a cwd) and read by the proxy daemon (which has none),
 * so the daemon can resolve the project-scoped analytics settings for a session's OTLP export. Lives beside the
 * session project pin; separate file, so pins written by older versions are untouched.
 */
const PIN_DIR = getCodemiePath('otlp-session-project');
const TTL_MS = 24 * 60 * 60 * 1000;
/** A session rarely changes folders; the bound keeps the file small. Protective resolution treats any of them as in scope. */
const MAX_CWDS = 8;

interface CwdEntry {
  cwds: string[];
  pinnedAt: number;
}

/** `session_id` is hook-supplied; hashed so it can never escape `PIN_DIR` as a path. */
function cwdFile(sessionId: string): string {
  return join(PIN_DIR, `${createHash('sha256').update(sessionId).digest('hex')}.cwd.json`);
}

function parseEntry(raw: string): CwdEntry | undefined {
  const parsed = JSON.parse(raw) as Partial<CwdEntry> | null;
  if (!parsed || !Array.isArray(parsed.cwds) || typeof parsed.pinnedAt !== 'number') return undefined;
  const cwds = parsed.cwds.filter((cwd): cwd is string => typeof cwd === 'string' && isAbsolute(cwd));
  return { cwds, pinnedAt: parsed.pinnedAt };
}

async function readEntry(sessionId: string): Promise<CwdEntry | undefined> {
  try {
    const entry = parseEntry(await readFile(cwdFile(sessionId), 'utf-8'));
    return entry && Date.now() - entry.pinnedAt < TTL_MS ? entry : undefined;
  } catch {
    return undefined;
  }
}

/** Directories recorded for the session by its hooks; empty when none (no hook yet, expired, or unreadable). */
export async function readSessionCwds(sessionId: string): Promise<string[]> {
  if (!sessionId) return [];
  return (await readEntry(sessionId))?.cwds ?? [];
}

/** Best-effort: a failure is logged and never blocks the hook. */
export async function recordSessionCwd(sessionId: string, cwd: string): Promise<void> {
  if (!sessionId || !cwd || !isAbsolute(cwd)) return;
  try {
    const existing = await readEntry(sessionId);
    if (existing?.cwds.includes(cwd) || (existing && existing.cwds.length >= MAX_CWDS)) return;
    await writeJsonFileAtomic(
      cwdFile(sessionId),
      { cwds: [...(existing?.cwds ?? []), cwd], pinnedAt: existing?.pinnedAt ?? Date.now() } satisfies CwdEntry,
      { directoryMode: 0o700 }
    );
  } catch (err) {
    logger.debug(`[session-cwd-pin] write failed: ${err instanceof Error ? err.name : 'error'}`);
  }
}
