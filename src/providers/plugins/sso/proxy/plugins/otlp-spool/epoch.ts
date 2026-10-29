import { randomBytes } from 'node:crypto';
import { link, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SPOOL_STREAMS, spoolRoot, statusFile, streamFile } from './spool-paths.js';

/*
 * One-time upgrade epoch (spec item 7). `epoch.json` is written atomically the first time this
 * version touches the spool: temp file + `link`, so an existing epoch always wins and no reader
 * sees a partial file. An OTLP-only session born before it is pre-upgrade (legacy); one born after
 * it waits for its evidence stamp. The name matches no session suffix, so listing/sweep ignore it.
 */

/** Births within this margin of the epoch are not treated as pre-epoch (coarse filesystem clocks). */
const EPOCH_MARGIN_MS = 1_000;

const cache = new Map<string, number>();

function parseEpoch(text: string): number {
  try {
    const value = JSON.parse(text) as { v?: unknown; created?: unknown };
    return value.v === 1 && typeof value.created === 'number' && Number.isFinite(value.created) && value.created > 0
      ? value.created
      : 0;
  } catch {
    return 0;
  }
}

async function readEpoch(path: string): Promise<number | undefined> {
  try {
    return parseEpoch(await readFile(path, 'utf-8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return 0;
  }
}

/** The epoch timestamp, creating it on first call. 0 = unreadable epoch: nothing counts as pre-epoch. */
export async function readOrCreateEpoch(now: number = Date.now()): Promise<number> {
  const path = join(spoolRoot(), 'epoch.json');
  const cached = cache.get(path);
  if (cached) return cached;

  let created = await readEpoch(path);
  if (created === undefined) {
    try {
      await mkdir(spoolRoot(), { recursive: true, mode: 0o700 });
      const content = JSON.stringify({ v: 1, created: now });
      const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(tmp, content, { mode: 0o600 });
      try {
        await link(tmp, path);
      } catch (err) {
        // EEXIST: another writer won. Anything else: no hard links here, fall back to an exclusive create.
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          await writeFile(path, content, { flag: 'wx', mode: 0o600 }).catch(() => undefined);
        }
      } finally {
        await unlink(tmp).catch(() => undefined);
      }
    } catch {
      // unwritable spool root: read below yields 0 (conservative)
    }
    created = (await readEpoch(path)) ?? 0;
  }
  if (created > 0) cache.set(path, created);
  return created;
}

const knownMs = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);

/**
 * Local session birth: the `.status` file birthtime (written in place, so it stays the birth until
 * the session is swept); else the earliest spool-file birthtime, else mtime (later than the real
 * birth, so the fallback only errs towards "not legacy"). 0 = unknown.
 */
export async function sessionBirthMs(sessionId: string): Promise<number> {
  try {
    const birth = knownMs((await stat(statusFile(sessionId))).birthtimeMs);
    if (birth > 0) return birth;
  } catch {
    // no status file: fall back to the data files
  }
  let earliest = 0;
  for (const stream of SPOOL_STREAMS) {
    try {
      const info = await stat(streamFile(sessionId, stream));
      const at = knownMs(info.birthtimeMs) || knownMs(info.mtimeMs);
      if (at > 0 && (earliest === 0 || at < earliest)) earliest = at;
    } catch {
      // missing stream
    }
  }
  return earliest;
}

/** Pre-upgrade only when both times are known and the birth is clearly before the epoch. */
export function isPreEpoch(birthMs: number, epochMs: number): boolean {
  return birthMs > 0 && epochMs > 0 && birthMs + EPOCH_MARGIN_MS <= epochMs;
}
